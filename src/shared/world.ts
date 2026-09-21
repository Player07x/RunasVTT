/**
 * Formato de um mundo do RunasVTT.
 *
 * Um mundo é uma pasta autocontida — copiar a pasta é um backup completo:
 *
 *   <mundo>/
 *     world.json   manifesto legível (este arquivo define o formato)
 *     world.db     SQLite com todos os documentos (cenas, tokens, paredes…)
 *     assets/      mapas, tokens e áudio, nomeados pelo hash do conteúdo
 *
 * O VTT nunca interpreta regras da Runas Suite: fichas chegam prontas pela
 * ponte com os sites e são guardadas como envelopes opacos (ver ADR 0003).
 */

export const WORLD_FORMAT_VERSION = 1
export const WORLD_MANIFEST_FILE = "world.json"
export const WORLD_DATABASE_FILE = "world.db"
export const WORLD_ASSETS_DIR = "assets"
export const ASSET_KINDS = ["maps", "tokens", "tiles", "audio"] as const

export type AssetKind = (typeof ASSET_KINDS)[number]

/** Rulesets conhecidos da Runas Suite (`@runas/ruleset-contracts`). */
export const RULESET_IDS = ["runas-blue", "cronos"] as const
export type RulesetId = (typeof RULESET_IDS)[number]

export interface WorldManifest {
  formatVersion: number
  id: string
  title: string
  description: string
  rulesetId: RulesetId
  createdAt: number
  updatedAt: number
}

export interface WorldSummary extends WorldManifest {
  /** Caminho absoluto da pasta do mundo. */
  path: string
}

export interface NewWorldInput {
  title: string
  description?: string
  rulesetId?: RulesetId
}

/**
 * Tipos de documento guardados em `world.db`. Cada fase do plano acrescenta o
 * formato de `data` do seu tipo; a tabela é genérica para que novos tipos não
 * exijam migração estrutural.
 */
export const DOCUMENT_TYPES = [
  "scene",
  "token",
  "tile",
  "drawing",
  "note",
  "wall",
  "light",
  /** Áreas exploradas de uma cena (Fase 6); só o processo principal grava. */
  "fog",
  "region",
  "sound",
  "playlist",
  "track",
  "log-entry",
  /** Ficha persistida de um assento da transmissão (Fase 10). */
  "seat-character",
] as const

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

export interface WorldDocument<TData = unknown> {
  id: string
  type: DocumentType
  /** Documento que contém este (por exemplo, o token pertence a uma cena). */
  parentId: string | null
  sort: number
  data: TData
  createdAt: number
  updatedAt: number
}

export const WORLD_TITLE_MAX_LENGTH = 80

export function isRulesetId(value: unknown): value is RulesetId {
  return typeof value === "string" && (RULESET_IDS as readonly string[]).includes(value)
}

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === "string" && (DOCUMENT_TYPES as readonly string[]).includes(value)
}

export function normalizeWorldTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, WORLD_TITLE_MAX_LENGTH)
}

/**
 * Nome de pasta legível e seguro no Windows, macOS e Linux. O id aleatório no
 * final evita colisões entre mundos de mesmo nome.
 */
export function worldFolderName(title: string, id: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `${slug || "mundo"}-${id.slice(0, 8)}`
}

export function createWorldManifest(input: NewWorldInput, id: string, now: number): WorldManifest {
  const title = normalizeWorldTitle(input.title)
  if (!title) throw new Error("O mundo precisa de um nome.")
  return {
    formatVersion: WORLD_FORMAT_VERSION,
    id,
    title,
    description: (input.description ?? "").trim(),
    rulesetId: input.rulesetId ?? "runas-blue",
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Lê um manifesto vindo do disco. Um manifesto de versão futura é recusado:
 * abrir um mundo criado por uma versão mais nova do VTT poderia corrompê-lo.
 */
export function parseWorldManifest(value: unknown): WorldManifest {
  if (!value || typeof value !== "object") throw new Error("Manifesto do mundo inválido.")
  const raw = value as Record<string, unknown>
  const formatVersion = typeof raw.formatVersion === "number" ? raw.formatVersion : NaN
  if (!Number.isInteger(formatVersion) || formatVersion < 1) throw new Error("Versão do formato do mundo inválida.")
  if (formatVersion > WORLD_FORMAT_VERSION) throw new Error(`Este mundo usa o formato ${formatVersion}, mais novo que o suportado (${WORLD_FORMAT_VERSION}). Atualize o RunasVTT.`)
  if (typeof raw.id !== "string" || !raw.id) throw new Error("Manifesto do mundo sem id.")
  const title = typeof raw.title === "string" ? normalizeWorldTitle(raw.title) : ""
  const createdAt = typeof raw.createdAt === "number" ? raw.createdAt : 0
  return {
    formatVersion,
    id: raw.id,
    title: title || "Mundo sem nome",
    description: typeof raw.description === "string" ? raw.description : "",
    rulesetId: isRulesetId(raw.rulesetId) ? raw.rulesetId : "runas-blue",
    createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : createdAt,
  }
}
