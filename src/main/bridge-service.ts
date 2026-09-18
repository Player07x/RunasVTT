import { randomUUID } from "node:crypto"
import { barColor, decodeTokenImage, normalizeBridgeCharacter, normalizeEnvelope, normalizeLogEntry, normalizeSummary, type BridgeToken, type CharacterSummary } from "../shared/bridge"
import type { DocumentChange } from "../shared/ipc"
import { snapTokenCenter, type Point } from "../shared/grid"
import type { LogData, SceneData, TokenBar, TokenData } from "../shared/scene"
import { MAX_IMPORT_BATCH } from "../shared/bridge"
import { importAsset } from "./world-assets"
import type { WorldDatabase } from "./world-database"
import { deleteDocument, putDocument } from "./world-documents"

/** O que a interface da mesa informa ao processo principal: cena aberta, seleção e centro da vista. */
export interface TableState {
  sceneId: string | null
  selection: string[]
  center: Point | null
}

/** O Registro guarda as entradas mais recentes; as antigas saem sozinhas. */
export const MAX_LOG_ENTRIES = 500

const newId = () => randomUUID().replaceAll("-", "")

/** Ordem estável para entradas criadas no mesmo milissegundo. */
let logSequence = 0
const logSort = () => Date.now() + (logSequence++ % 1000) / 1000

function barsFrom(summary: CharacterSummary): TokenBar[] {
  return summary.bars.map((bar) => ({ label: bar.label, value: bar.value, max: bar.max, color: barColor(bar.label) }))
}

function openScene(database: WorldDatabase, table: TableState): { id: string; data: SceneData } {
  const scene = table.sceneId ? database.get(table.sceneId) : null
  if (!scene || scene.type !== "scene") throw new Error("Abra uma cena no RunasVTT antes de importar.")
  return { id: scene.id, data: scene.data as SceneData }
}

/**
 * Cria um token por ficha na cena aberta, em grade ao redor do centro da
 * vista. Aliados vindos do Runas Tools, hostis vindos do Runas DM.
 */
export async function importCharacters(database: WorldDatabase, worldPath: string, table: TableState, items: unknown): Promise<{ tokenIds: string[]; changes: DocumentChange[] }> {
  if (!Array.isArray(items) || items.length === 0) throw new Error("Nenhuma ficha para importar.")
  if (items.length > MAX_IMPORT_BATCH) throw new Error(`Importe no máximo ${MAX_IMPORT_BATCH} fichas por vez.`)
  const characters = items.map(normalizeBridgeCharacter)
  const scene = openScene(database, table)
  const grid = scene.data.grid
  // Uma célula livre entre tokens (os maiores ditam o passo): nomes e barras não se sobrepõem.
  const cell = grid.type === "none" ? 100 : grid.size
  const step = cell * (Math.max(...characters.map((character) => character.tokenSize)) + 1)
  const center = table.center ?? { x: scene.data.width / 2, y: scene.data.height / 2 }
  const columns = Math.ceil(Math.sqrt(characters.length))
  const tokenIds: string[] = []
  const changes: DocumentChange[] = []
  for (const [index, character] of characters.entries()) {
    const image = decodeTokenImage(character.tokenImage)
    const imagePath = image ? await importAsset(worldPath, "tokens", `token.${image.extension}`, image.bytes) : null
    const column = index % columns
    const row = Math.floor(index / columns)
    const position = snapTokenCenter({ x: center.x + (column - (columns - 1) / 2) * step, y: center.y + (row - (Math.ceil(characters.length / columns) - 1) / 2) * step }, character.tokenSize, grid)
    const id = newId()
    const data: Partial<TokenData> = {
      name: character.summary.name,
      ...position,
      size: character.tokenSize,
      image: imagePath,
      disposition: character.source === "tools" ? "friendly" : "hostile",
      bars: barsFrom(character.summary),
      actor: { envelope: character.envelope, source: character.source, updatedAt: Date.now() },
    }
    changes.push(putDocument(database, { id, type: "token", parentId: scene.id, data }).change)
    tokenIds.push(id)
  }
  return { tokenIds, changes }
}

/** Tokens com ficha da cena aberta. */
export function listBridgeTokens(database: WorldDatabase, table: TableState): BridgeToken[] {
  if (!table.sceneId) return []
  const selected = new Set(table.selection)
  return database.list("token", table.sceneId).flatMap((document) => {
    const data = document.data as TokenData
    if (!data.actor) return []
    return [{
      id: document.id,
      sceneId: table.sceneId!,
      name: data.name,
      selected: selected.has(document.id),
      source: data.actor.source,
      envelope: data.actor.envelope,
      summary: { name: data.name, bars: data.bars.map(({ label, value, max }) => ({ label, value, max })) },
    }]
  })
}

/**
 * Grava a ficha que o site recalculou (ex.: depois de um dano confirmado).
 * O token é uma cópia independente: a ficha de origem no site não muda.
 */
export function updateTokenCharacter(database: WorldDatabase, tokenId: unknown, envelope: unknown, summary: unknown): DocumentChange {
  const document = typeof tokenId === "string" ? database.get(tokenId) : null
  if (!document || document.type !== "token") throw new Error("Token não encontrado.")
  const data = document.data as TokenData
  if (!data.actor) throw new Error("Este token não tem ficha vinculada.")
  const normalized = normalizeSummary(summary)
  return putDocument(database, {
    id: document.id,
    type: "token",
    parentId: document.parentId,
    data: { ...data, bars: barsFrom(normalized), actor: { ...data.actor, envelope: normalizeEnvelope(envelope), updatedAt: Date.now() } },
  }).change
}

export function postLog(database: WorldDatabase, table: TableState, entry: unknown): DocumentChange[] {
  const normalized = normalizeLogEntry(entry)
  const token = normalized.tokenId ? database.get(normalized.tokenId) : null
  const data: LogData = {
    ...normalized,
    tokenId: token?.type === "token" ? token.id : null,
    tokenName: token?.type === "token" ? (token.data as TokenData).name : "",
    sceneId: token?.parentId ?? table.sceneId,
  }
  const changes = [putDocument(database, { id: newId(), type: "log-entry", parentId: null, sort: logSort(), data }).change]
  const entries = database.list("log-entry", null)
  for (const old of entries.slice(0, Math.max(0, entries.length - MAX_LOG_ENTRIES))) {
    const change = deleteDocument(database, old.id)
    if (change) changes.push(change)
  }
  return changes
}
