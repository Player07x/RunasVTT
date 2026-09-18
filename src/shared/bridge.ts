/**
 * Contrato da ponte `window.runasVTT` entre os sites da Runas Suite e o
 * RunasVTT (ADR 0003). Tudo o que chega dos sites passa por estas funções
 * antes de tocar o mundo: a página é código de outra origem.
 *
 * Mudança incompatível no contrato exige aumentar `BRIDGE_PROTOCOL`; os
 * sites verificam o número antes de usar a ponte.
 */

export const BRIDGE_PROTOCOL = 1

/** Maior envelope de ficha aceito (o retrato em data URL costuma ser a maior parte). */
export const MAX_ENVELOPE_BYTES = 3_000_000
/** Maior imagem de token aceita, em bytes decodificados. */
export const MAX_TOKEN_IMAGE_BYTES = 5_000_000
export const MAX_IMPORT_BATCH = 50

export const CHARACTER_SOURCES = ["tools", "dm"] as const
export type CharacterSource = (typeof CHARACTER_SOURCES)[number]

export interface SummaryBar {
  label: string
  value: number
  max: number
}

/** Resumo calculado pelo site: o VTT só exibe, nunca calcula. */
export interface CharacterSummary {
  name: string
  bars: SummaryBar[]
}

export interface BridgeCharacter {
  /** Envelope exportado pelo site (`{ version, character }`), guardado sem interpretação. */
  envelope: unknown
  summary: CharacterSummary
  source: CharacterSource
  /** Imagem do token em `data:image/...;base64,`. */
  tokenImage: string | null
}

export interface BridgeToken {
  id: string
  sceneId: string
  name: string
  selected: boolean
  source: CharacterSource
  envelope: unknown
  summary: CharacterSummary
}

export const LOG_KINDS = ["test", "damage", "info"] as const
export type LogKind = (typeof LOG_KINDS)[number]

export interface BridgeLogEntry {
  kind: LogKind
  title: string
  detail: string
  tokenId: string | null
  /** Texto curto que sobe sobre o token (ex.: "-7 PV"). */
  floatingText: string
}

export interface RunasVttBridge {
  protocol: number
  importCharacters(items: BridgeCharacter[]): Promise<{ tokenIds: string[] }>
  /** Tokens com ficha da cena aberta, marcando os selecionados. */
  getTokens(): Promise<BridgeToken[]>
  /** Avisa quando a seleção, a cena ou os tokens com ficha mudam. */
  onTokensChanged(listener: () => void): () => void
  updateTokenCharacter(tokenId: string, envelope: unknown, summary: CharacterSummary): Promise<void>
  postLog(entry: Partial<BridgeLogEntry> & { title: string }): Promise<void>
}

type Raw = Record<string, unknown>

function record(value: unknown, what: string): Raw {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} inválido.`)
  return value as Raw
}
function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback
}
function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export function normalizeSummary(value: unknown): CharacterSummary {
  const raw = record(value, "Resumo da ficha")
  const bars = Array.isArray(raw.bars) ? raw.bars.slice(0, 3).map((bar) => {
    const item = record(bar, "Barra")
    return { label: text(item.label, "PV", 12) || "PV", value: finite(item.value), max: Math.max(0, finite(item.max)) }
  }) : []
  return { name: text(raw.name, "", 80) || "Sem nome", bars }
}

/** Garante que o envelope é JSON puro e cabe no limite. */
export function normalizeEnvelope(value: unknown): unknown {
  record(value, "Ficha")
  const json = JSON.stringify(value)
  if (new TextEncoder().encode(json).byteLength > MAX_ENVELOPE_BYTES) throw new Error("Ficha grande demais para importar.")
  return JSON.parse(json) as unknown
}

const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/

/** Decodifica a imagem do token; devolve extensão e bytes, ou `null` se não houver imagem. */
export function decodeTokenImage(value: unknown): { extension: string; bytes: Uint8Array } | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string") throw new Error("Imagem do token inválida.")
  const match = DATA_URL.exec(value)
  if (!match) throw new Error("A imagem do token precisa ser PNG, JPEG, WebP ou GIF.")
  const base64 = match[2]!
  if ((base64.length * 3) / 4 > MAX_TOKEN_IMAGE_BYTES) throw new Error("Imagem do token grande demais.")
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return { extension: match[1] === "jpeg" ? "jpg" : match[1]!, bytes }
}

export function normalizeBridgeCharacter(value: unknown): BridgeCharacter {
  const raw = record(value, "Ficha")
  const source = (CHARACTER_SOURCES as readonly unknown[]).includes(raw.source) ? raw.source as CharacterSource : "dm"
  // A imagem é validada aqui e decodificada de novo ao gravar.
  decodeTokenImage(raw.tokenImage)
  return {
    envelope: normalizeEnvelope(raw.envelope),
    summary: normalizeSummary(raw.summary),
    source,
    tokenImage: typeof raw.tokenImage === "string" && raw.tokenImage ? raw.tokenImage : null,
  }
}

export function normalizeLogEntry(value: unknown): BridgeLogEntry {
  const raw = record(value, "Registro")
  const title = text(raw.title, "", 160)
  if (!title) throw new Error("Registro sem título.")
  return {
    kind: (LOG_KINDS as readonly unknown[]).includes(raw.kind) ? raw.kind as LogKind : "info",
    title,
    detail: text(raw.detail, "", 2000),
    tokenId: typeof raw.tokenId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.tokenId) ? raw.tokenId : null,
    floatingText: text(raw.floatingText, "", 40),
  }
}

/** Cor da barra pelo rótulo, nas cores da suíte (docs/design-system.md). */
export function barColor(label: string): string {
  const key = label.trim().toUpperCase()
  if (key.startsWith("PV")) return "#c76561"
  if (key.startsWith("PA")) return "#82aaa6"
  if (key.startsWith("PE")) return "#927f9c"
  return "#b99b65"
}
