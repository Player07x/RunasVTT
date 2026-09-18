import type { SuiteSiteId } from "./sites"
import type { AssetPath } from "./scene"
import type { AssetKind, DocumentType, NewWorldInput, WorldDocument, WorldSummary } from "./world"

/** Canais IPC entre a interface do VTT e o processo principal. */
export const IPC = {
  appInfo: "app:info",
  listWorlds: "worlds:list",
  createWorld: "worlds:create",
  openWorld: "worlds:open",
  closeWorld: "worlds:close",
  revealWorld: "worlds:reveal",
  browserState: "browser:state",
  browserStateChanged: "browser:state-changed",
  browserOpen: "browser:open",
  browserActivate: "browser:activate",
  browserClose: "browser:close",
  browserNavigate: "browser:navigate",
  browserCommand: "browser:command",
  browserSetBounds: "browser:set-bounds",
  browserSetForcedOffline: "browser:set-forced-offline",
  browserPrepareOffline: "browser:prepare-offline",
  documentsList: "documents:list",
  documentsPut: "documents:put",
  documentsDelete: "documents:delete",
  documentsChanged: "documents:changed",
  assetsImport: "assets:import",
  tableReport: "table:report",
  bridgeImportCharacters: "bridge:import-characters",
  bridgeGetTokens: "bridge:get-tokens",
  bridgeUpdateTokenCharacter: "bridge:update-token-character",
  bridgePostLog: "bridge:post-log",
  bridgeTokensChanged: "bridge:tokens-changed",
} as const

/** O que a mesa informa ao processo principal para a ponte saber onde agir. */
export interface TableReport {
  sceneId: string | null
  selection: string[]
  center: { x: number; y: number } | null
}

/** Esquema que serve os assets do mundo aberto à interface: `vtt-asset://world/<tipo>/<arquivo>`. */
export const ASSET_SCHEME = "vtt-asset"

export function assetUrl(path: AssetPath): string {
  return `${ASSET_SCHEME}://world/${path}`
}

export interface DocumentInput {
  id: string
  type: DocumentType
  parentId: string | null
  sort?: number
  data: unknown
}

export type DocumentChange =
  | { kind: "put"; document: WorldDocument }
  | { kind: "delete"; ids: string[] }

export interface AppInfo {
  version: string
  electron: string
  worldsRoot: string
}

/** De onde veio a última resposta de um site da suíte. */
export type SiteSource = "network" | "mirror" | "unavailable"

export interface BrowserTab {
  id: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Site da Runas Suite aberto na aba, se for um. */
  siteId: SuiteSiteId | null
}

export interface SiteMirrorStatus {
  siteId: SuiteSiteId
  label: string
  origin: string
  entries: number
  bytes: number
  lastStoredAt: number | null
  lastSource: SiteSource | null
}

export interface OfflinePreparation {
  running: boolean
  siteId: SuiteSiteId | null
  done: number
  total: number
  failed: number
  finishedAt: number | null
}

export interface BrowserState {
  tabs: BrowserTab[]
  activeTabId: number | null
  forcedOffline: boolean
  sites: SiteMirrorStatus[]
  preparation: OfflinePreparation
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserCommand = "back" | "forward" | "reload"

/**
 * API exposta à interface do VTT como `window.vtt`. Não confundir com a ponte
 * `window.runasVTT`, que só as páginas da Runas Suite recebem (ADR 0003).
 */
export interface VttApi {
  appInfo(): Promise<AppInfo>
  listWorlds(): Promise<WorldSummary[]>
  createWorld(input: NewWorldInput): Promise<WorldSummary>
  openWorld(id: string): Promise<WorldSummary>
  closeWorld(): Promise<void>
  revealWorld(id: string): Promise<void>
  documents: {
    list(type: DocumentType, parentId?: string | null): Promise<WorldDocument[]>
    put(input: DocumentInput): Promise<WorldDocument>
    remove(id: string): Promise<void>
    onChange(listener: (change: DocumentChange) => void): () => void
  }
  table: {
    report(state: TableReport): Promise<void>
  }
  assets: {
    /** Copia um arquivo para o mundo aberto e devolve o caminho do asset. */
    import(kind: AssetKind, fileName: string, bytes: Uint8Array): Promise<AssetPath>
  }
  browser: {
    state(): Promise<BrowserState>
    onState(listener: (state: BrowserState) => void): () => void
    open(url: string): Promise<void>
    activate(tabId: number): Promise<void>
    close(tabId: number): Promise<void>
    navigate(tabId: number, url: string): Promise<void>
    command(tabId: number, command: BrowserCommand): Promise<void>
    /** Área da janela onde a aba ativa aparece; `null` esconde o navegador. */
    setBounds(bounds: Rect | null): Promise<void>
    setForcedOffline(offline: boolean): Promise<void>
    prepareOffline(): Promise<void>
  }
}
