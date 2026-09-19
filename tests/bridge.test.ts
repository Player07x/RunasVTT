import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { importCharacters, listBridgeTokens, MAX_LOG_ENTRIES, postLog, updateTokenCharacter, type TableState } from "../src/main/bridge-service"
import { resolveAssetFile } from "../src/main/world-assets"
import { WorldDatabase } from "../src/main/world-database"
import { putDocument } from "../src/main/world-documents"
import { decodeTokenImage, normalizeBridgeCharacter, normalizeLogEntry } from "../src/shared/bridge"
import type { LogData, TokenData } from "../src/shared/scene"

// PNG 1×1 transparente.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const envelope = { version: 21, character: { name: "Goblin", pv: 7 } }
const summary = { name: "Goblin", bars: [{ label: "PV", value: 7, max: 12 }, { label: "PA", value: 2, max: 4 }] }

let dir: string
let database: WorldDatabase
let table: TableState

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-bridge-"))
  database = new WorldDatabase(join(dir, "world.db"))
  putDocument(database, { id: "s1", type: "scene", parentId: null, data: { width: 2000, height: 2000, grid: { type: "square", size: 100 } } })
  table = { sceneId: "s1", selection: [], center: { x: 1000, y: 1000 } }
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe("validação do que vem dos sites", () => {
  it("recusa imagem que não seja data URL de imagem", () => {
    expect(() => decodeTokenImage("https://exemplo.com/x.png")).toThrow()
    expect(() => decodeTokenImage("data:text/html;base64,PGI+")).toThrow()
    expect(decodeTokenImage(PNG)?.extension).toBe("png")
    expect(decodeTokenImage(null)).toBeNull()
  })

  it("normaliza a ficha: envelope JSON puro, resumo com até 3 barras, origem conhecida", () => {
    const character = normalizeBridgeCharacter({ envelope, summary: { name: "", bars: [{}, {}, {}, {}] }, source: "outro", tokenImage: null })
    expect(character.source).toBe("dm")
    expect(character.summary.name).toBe("Sem nome")
    expect(character.summary.bars).toHaveLength(3)
    expect(() => normalizeBridgeCharacter({ envelope: "texto", summary })).toThrow()
  })

  it("registro exige título e limpa id de token inválido", () => {
    expect(() => normalizeLogEntry({ title: "" })).toThrow()
    expect(normalizeLogEntry({ title: "Teste", tokenId: "../x", kind: "hack" })).toMatchObject({ kind: "info", tokenId: null })
  })
})

describe("importCharacters", () => {
  it("cria tokens na cena aberta, encaixados, com barras, imagem e ficha", async () => {
    const { tokenIds, changes } = await importCharacters(database, dir, table, [
      { envelope, summary, source: "dm", tokenImage: PNG },
      { envelope: { version: 21, character: { name: "Aria" } }, summary: { name: "Aria", bars: [] }, source: "tools", tokenImage: null },
    ])
    expect(tokenIds).toHaveLength(2)
    expect(changes).toHaveLength(2)
    const goblin = database.get(tokenIds[0]!)!.data as TokenData
    expect(goblin.name).toBe("Goblin")
    expect(goblin.disposition).toBe("hostile")
    expect(goblin.bars.map((bar) => [bar.label, bar.value, bar.max, bar.color])).toEqual([["PV", 7, 12, "#c76561"], ["PA", 2, 4, "#82aaa6"]])
    expect(goblin.actor?.envelope).toEqual(envelope)
    expect((goblin.x - 50) % 100).toBe(0)
    expect(await readFile(resolveAssetFile(dir, goblin.image!)!)).toBeTruthy()
    expect((database.get(tokenIds[1]!)!.data as TokenData).disposition).toBe("player") // ficha do Runas Tools = personagem de jogador
  })

  it("usa o tamanho do token enviado pelo site e encaixa pelo tamanho", async () => {
    const { tokenIds } = await importCharacters(database, dir, table, [{ envelope, summary, source: "dm", tokenSize: 2 }, { envelope, summary, source: "dm", tokenSize: 99 }])
    const ogro = database.get(tokenIds[0]!)!.data as TokenData
    expect(ogro.size).toBe(2)
    expect(ogro.x % 100).toBe(0)
    expect((database.get(tokenIds[1]!)!.data as TokenData).size).toBe(20)
    const [semTamanho] = (await importCharacters(database, dir, table, [{ envelope, summary, source: "dm" }])).tokenIds
    expect((database.get(semTamanho!)!.data as TokenData).size).toBe(1)
  })

  it("exige uma cena aberta e limita o lote", async () => {
    await expect(importCharacters(database, dir, { ...table, sceneId: null }, [{ envelope, summary }])).rejects.toThrow(/Abra uma cena/)
    await expect(importCharacters(database, dir, table, Array.from({ length: 51 }, () => ({ envelope, summary })))).rejects.toThrow(/no máximo/)
  })
})

describe("tokens com ficha", () => {
  it("lista só tokens com ficha, marca a seleção e atualiza pela ficha recalculada", async () => {
    const { tokenIds } = await importCharacters(database, dir, table, [{ envelope, summary, source: "dm" }])
    putDocument(database, { id: "semficha", type: "token", parentId: "s1", data: { name: "Marcador" } })
    const [token] = listBridgeTokens(database, { ...table, selection: tokenIds })
    expect(listBridgeTokens(database, table)).toHaveLength(1)
    expect(token).toMatchObject({ id: tokenIds[0], selected: true, source: "dm", envelope })

    updateTokenCharacter(database, tokenIds[0], { version: 21, character: { name: "Goblin", pv: 2 } }, { name: "Goblin", bars: [{ label: "PV", value: 2, max: 12 }] })
    const updated = database.get(tokenIds[0]!)!.data as TokenData
    expect(updated.bars[0]).toMatchObject({ value: 2, max: 12 })
    expect((updated.actor?.envelope as { character: { pv: number } }).character.pv).toBe(2)
    expect(() => updateTokenCharacter(database, "semficha", envelope, summary)).toThrow(/sem ficha|não tem ficha/)
  })
})

describe("postLog", () => {
  it("guarda o nome do token e mantém só as entradas mais recentes", async () => {
    const { tokenIds } = await importCharacters(database, dir, table, [{ envelope, summary, source: "dm" }])
    postLog(database, table, { kind: "damage", title: "Dano causado", detail: "7 cortante", tokenId: tokenIds[0], floatingText: "-7 PV" })
    const [entry] = database.list("log-entry", null)
    expect(entry!.data as LogData).toMatchObject({ kind: "damage", tokenName: "Goblin", sceneId: "s1", floatingText: "-7 PV" })
    for (let index = 0; index < MAX_LOG_ENTRIES + 5; index += 1) postLog(database, table, { title: `Teste ${index}` })
    const entries = database.list("log-entry", null)
    expect(entries).toHaveLength(MAX_LOG_ENTRIES)
    expect((entries.at(-1)!.data as LogData).title).toBe(`Teste ${MAX_LOG_ENTRIES + 4}`)
  })
})
