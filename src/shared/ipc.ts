import type { SuiteSiteId } from "./sites"
import type { AssetPath } from "./scene"
import type { PlayerRuler } from "./player"
import type { AppSettings } from "./settings"
import type { AudioState } from "./audio"
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
  documentsClearLog: "documents:clear-log",
  documentsChanged: "documents:changed",
  assetsImport: "assets:import",
  tableReport: "table:report",
  bridgeImportCharacters: "bridge:import-characters",
  bridgeGetTokens: "bridge:get-tokens",
  bridgeUpdateTokenCharacter: "bridge:update-token-character",
  bridgePostLog: "bridge:post-log",
  bridgeTokensChanged: "bridge:tokens-changed",
  playerState: "player:state",
  playerStateChanged: "player:state-changed",
  playerDisplays: "player:displays",
  playerStart: "player:start",
  playerStop: "player:stop",
  playerRotateSeatCode: "player:rotate-seat-code",
  playerClearSeat: "player:clear-seat",
  playerOpenWindow: "player:open-window",
  playerSetScene: "player:set-scene",
  playerRuler: "player:ruler",
  playerPullCamera: "player:pull-camera",
  playerSetBars: "player:set-bars",
  playerPublicLink: "player:public-link",
  playerDownloadCloudflared: "player:download-cloudflared",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsChanged: "settings:changed",
  bridgeAccessToken: "bridge:access-token",
  visionResetExploration: "vision:reset-exploration",
  audioState: "audio:state",
  audioStateChanged: "audio:state-changed",
  audioPlayPlaylist: "audio:play-playlist",
  audioStopPlaylist: "audio:stop-playlist",
  audioPlayTrack: "audio:play-track",
  audioStopTrack: "audio:stop-track",
  audioStopAll: "audio:stop-all",
  audioEnded: "audio:ended",
  playerSetAudio: "player:set-audio",
  playerSetMoves: "player:set-moves",
  worldsExport: "worlds:export",
  worldsImport: "worlds:import",
  snapshotsList: "snapshots:list",
  snapshotsCreate: "snapshots:create",
  snapshotsRestore: "snapshots:restore",
  snapshotsDelete: "snapshots:delete",
} as const

/** O que a mesa informa ao processo principal para a ponte saber onde agir. */
export interface TableReport {
  sceneId: string | null
  selection: string[]
  center: { x: number; y: number } | null
  /** Escala da câmera da mesa, usada quando o mestre puxa a câmera dos jogadores. */
  zoom?: number | null
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

export interface PlayerDisplay {
  id: string
  label: string
  bounds: Rect
  workArea: Rect
}

export type PlayerBarVisibility = "friendly" | "all" | "none"

export type PlayerSeatStatus = "available" | "connected" | "attached"

/** Assento efêmero da sessão; o código só aparece na criação/regeneração. */
export interface PlayerSeatState {
  slotId: string
  label: string
  code?: string
  status: PlayerSeatStatus
  tokenId: string | null
  revision: number
  lastSeenAt: number | null
}

export interface PlayerState {
  enabled: boolean
  port: number
  key: string | null
  localUrl: string | null
  publicUrl: string | null
  sceneId: string | null
  /** Tocar também o áudio na Vista dos Jogadores. */
  audio: boolean
  /** Os espectadores podem mover tokens "Jogador". */
  moves: boolean
  bars: PlayerBarVisibility
  spectators: number
  /** Jogadores autenticados conectados por cookie de assento. */
  players: number
  sessionId: string | null
  seats: PlayerSeatState[]
}

export type BrowserCommand = "back" | "forward" | "reload"

export type SnapshotReason = "session" | "manual" | "before-restore"

export interface SnapshotInfo {
  id: string
  createdAt: number
  reason: SnapshotReason
  bytes: number
}

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
  backup: {
    /** Pergunta onde salvar e exporta o mundo em .zip; `null` se cancelado. */
    exportWorld(id: string): Promise<{ path: string; bytes: number } | null>
    /** Pergunta qual .zip importar; `null` se cancelado. */
    importWorld(): Promise<WorldSummary | null>
    snapshots(id: string): Promise<SnapshotInfo[]>
    createSnapshot(id: string): Promise<SnapshotInfo | null>
    /** Só com o mundo fechado; o estado atual vira um snapshot antes. */
    restoreSnapshot(id: string, snapshotId: string): Promise<void>
    deleteSnapshot(id: string, snapshotId: string): Promise<void>
  }
  documents: {
    list(type: DocumentType, parentId?: string | null): Promise<WorldDocument[]>
    put(input: DocumentInput): Promise<WorldDocument>
    remove(id: string): Promise<void>
    /** Apaga o Registro inteiro; devolve quantas entradas saíram. */
    clearLog(): Promise<number>
    onChange(listener: (change: DocumentChange) => void): () => void
  }
  table: {
    report(state: TableReport): Promise<void>
  }
  player: {
    state(): Promise<PlayerState>
    onState(listener: (state: PlayerState) => void): () => void
    displays(): Promise<PlayerDisplay[]>
    start(port?: number, seatCount?: number): Promise<PlayerState>
    stop(): Promise<void>
    rotateSeatCode(slotId: string): Promise<PlayerState>
    clearSeat(slotId: string): Promise<PlayerState>
    openWindow(): Promise<void>
    setScene(sceneId: string | null): Promise<void>
    /** Régua da ferramenta Régua do mestre, repassada aos espectadores; `null` apaga. */
    ruler(ruler: PlayerRuler | null): Promise<void>
    pullCamera(): Promise<void>
    setBars(bars: PlayerBarVisibility): Promise<void>
    setAudio(enabled: boolean): Promise<void>
    setMoves(enabled: boolean): Promise<void>
    publicLink(): Promise<string>
    downloadCloudflared(): Promise<void>
  }
  audio: {
    state(): Promise<AudioState>
    onState(listener: (state: AudioState) => void): () => void
    playPlaylist(playlistId: string): Promise<void>
    stopPlaylist(playlistId: string): Promise<void>
    playTrack(trackId: string): Promise<void>
    stopTrack(trackId: string): Promise<void>
    stopAll(): Promise<void>
    /** A mesa avisa que uma faixa sem loop terminou. */
    ended(key: string): Promise<void>
  }
  vision: {
    /** Apaga as áreas exploradas da cena (a névoa volta a cobrir tudo). */
    resetExploration(sceneId: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(settings: AppSettings): Promise<AppSettings>
    onChange(listener: (settings: AppSettings) => void): () => void
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
