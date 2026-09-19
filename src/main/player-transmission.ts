import { networkInterfaces } from "node:os"
import { randomBytes } from "node:crypto"
import type { DocumentChange, PlayerBarVisibility, PlayerState, TableReport } from "../shared/ipc"
import type { LogData, SceneData } from "../shared/scene"
import type { WorldDocument } from "../shared/world"
import { normalizeRuler, projectScene, type PlayerProjection, type PlayerRuler } from "../shared/player"
import { PlayerServer, type PlayerWireMessage } from "./player-server"
import type { WorldStore } from "./world-store"
import type { VisionService } from "./vision-service"
import type { AudioState } from "../shared/audio"
import type { DocumentChange as Change } from "../shared/ipc"
import { putDocument } from "./world-documents"
import { normalizeMoveRequest, validatePlayerMove } from "./player-moves"

const DEFAULT_PORT = 30000

function localAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address
    }
  }
  return "127.0.0.1"
}

function validPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("A porta precisa estar entre 1 e 65535.")
  return value
}

export interface MasterCamera {
  center: { x: number; y: number } | null
  zoom: number | null
}

/** Coordena o servidor de transmissão e mantém a projeção longe da rede. */
export class PlayerTransmission {
  private readonly server: PlayerServer
  private enabled = false
  private port = DEFAULT_PORT
  private key: string | null = null
  private publicUrl: string | null = null
  private sceneId: string | null = null
  private table: TableReport = { sceneId: null, selection: [], center: null, zoom: null }
  private ruler: PlayerRuler | null = null
  private audioEnabled = true
  /** Espectadores podem mover tokens "Jogador" (ADR 0017). */
  private movesEnabled = true
  /** Grava e transmite uma mudança feita por um espectador, como qualquer outra. */
  private commit: ((change: Change) => void) | null = null
  private audio: AudioState = { now: 0, sounds: [] }
  private bars: PlayerBarVisibility = "friendly"
  private lastProjection: PlayerProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }
  private onStateChange: (state: PlayerState) => void

  constructor(private readonly store: WorldStore, staticRoot: string, onStateChange: (state: PlayerState) => void, private readonly vision: VisionService | null = null) {
    this.onStateChange = onStateChange
    this.server = new PlayerServer({
      staticRoot,
      worldPath: () => this.store.openWorld?.summary.path ?? null,
      projection: () => this.lastProjection,
      allowedAssets: () => [...this.lastProjection.assets, ...(this.audioEnabled ? this.audio.sounds.map((sound) => sound.audio) : [])],
      snapshot: () => this.snapshotMessage(),
      onSpectators: (spectators) => { this.emit(spectators) },
      onClientMessage: (message) => this.handleClientMessage(message),
    })
  }

  state(): PlayerState {
    const localUrl = this.enabled && this.key ? `http://${localAddress()}:${this.port}/?k=${this.key}` : null
    return { enabled: this.enabled, port: this.port, key: this.key, localUrl, publicUrl: this.publicUrl, sceneId: this.sceneId, audio: this.audioEnabled, moves: this.movesEnabled, bars: this.bars, spectators: this.server.spectatorCount }
  }

  /** URL usada pela BrowserWindow local; a página é a mesma dos espectadores. */
  localWindowUrl(): string | null {
    return this.enabled && this.key ? `http://127.0.0.1:${this.port}/?k=${this.key}` : null
  }

  async start(port = DEFAULT_PORT): Promise<PlayerState> {
    if (!this.store.openWorld) throw new Error("Abra um mundo antes de ligar a Vista dos Jogadores.")
    this.port = validPort(port)
    const key = randomBytes(16).toString("hex")
    await this.server.start(this.port, key)
    this.key = key
    this.enabled = true
    this.publicUrl = null
    this.refreshProjection()
    this.emit(0)
    return this.state()
  }

  async stop(): Promise<void> {
    await this.server.stop()
    this.enabled = false
    this.key = null
    this.publicUrl = null
    this.ruler = null
    this.emit(0)
  }

  async closeWorld(): Promise<void> {
    if (this.enabled) await this.stop()
    this.sceneId = null
    this.table = { sceneId: null, selection: [], center: null, zoom: null }
    this.lastProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }
  }

  setPublicUrl(url: string | null): void {
    this.publicUrl = url
    this.emit()
  }

  get currentPort(): number { return this.port }
  get currentKey(): string | null { return this.key }
  get isEnabled(): boolean { return this.enabled }

  setScene(sceneId: string | null): void {
    this.sceneId = typeof sceneId === "string" && sceneId ? sceneId : null
    if (this.enabled) this.publishSnapshot()
    this.emit()
  }

  setBars(bars: PlayerBarVisibility): void {
    this.bars = bars
    if (this.enabled) this.publishSnapshot()
    this.emit()
  }

  /** Única forma de mover a câmera dos jogadores: um pedido explícito do mestre. */
  pullCamera(): void {
    const center = this.table.center
    if (this.enabled && center) this.server.publish({ type: "camera", center, zoom: this.table.zoom ?? null })
  }

  /**
   * Régua da ferramenta Régua do mestre. Só chega aos jogadores se for medida
   * na cena transmitida; a régua automática de arrastar tokens não passa por
   * aqui, para não revelar movimentos.
   */
  setRuler(value: unknown): void {
    const ruler = normalizeRuler(value)
    const visible = ruler && ruler.sceneId === this.lastProjection.scene?.id ? ruler : null
    if (!visible && !this.ruler) return
    this.ruler = visible
    if (this.enabled) this.server.publish({ type: "ruler", ruler: visible })
  }

  setMasterView(report: TableReport): void {
    const sceneChanged = this.table.sceneId !== report.sceneId
    this.table = {
      sceneId: typeof report.sceneId === "string" ? report.sceneId : null,
      selection: [],
      center: report.center && Number.isFinite(report.center.x) && Number.isFinite(report.center.y) ? report.center : null,
      zoom: typeof report.zoom === "number" && Number.isFinite(report.zoom) ? Math.max(0.08, Math.min(5, report.zoom)) : null,
    }
    if (!this.enabled) return
    // Mover a câmera do mestre não mexe na dos jogadores; só trocar de cena
    // muda o que é transmitido (quando nenhuma cena foi fixada).
    if (sceneChanged && this.sceneId === null) this.publishSnapshot()
  }

  onDocumentChange(change: DocumentChange): void {
    if (!this.enabled) return
    // Rebuild from the database instead of forwarding `change`: projection is
    // the security boundary, including for bridge writes and deletes.
    if (change.kind === "put" && change.document.type === "log-entry") { this.publishFloat(change.document.data as LogData); return }
    if (change.kind === "put" || change.kind === "delete") this.publishSnapshot()
  }

  /** Repete o texto flutuante do Registro só para tokens que os jogadores veem. */
  private publishFloat(entry: LogData): void {
    if (!entry.tokenId || !entry.floatingText) return
    const visible = this.lastProjection.children.some((child) => child.type === "token" && child.id === entry.tokenId)
    if (visible) this.server.publish({ type: "float", tokenId: entry.tokenId, text: entry.floatingText, kind: entry.kind })
  }

  private refreshProjection(): void {
    const database = this.store.openWorld?.database
    if (!database) { this.lastProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }; return }
    const targetId = this.sceneId ?? this.table.sceneId
    const scene = targetId ? database.get(targetId) : null
    if (!scene || scene.type !== "scene") { this.lastProjection = { scene: null, children: [], assets: [], vision: null, regions: [] }; return }
    const sceneData = scene.data as SceneData
    this.lastProjection = projectScene({
      scene: scene as WorldDocument<SceneData>,
      children: {
        tokens: database.list("token", scene.id) as WorldDocument<any>[],
        tiles: database.list("tile", scene.id) as WorldDocument<any>[],
        drawings: database.list("drawing", scene.id) as WorldDocument<any>[],
        notes: database.list("note", scene.id) as WorldDocument<any>[],
        regions: database.list("region", scene.id) as WorldDocument<any>[],
      },
      bars: this.bars,
      vision: this.vision?.get(scene.id) ?? null,
    })
    // Touching the value above documents the intentional opaque cast: the
    // database is generic, while projectScene is the only place that reads
    // and strips fields before they reach the transport.
    void sceneData
  }

  /** Cena cujos sons do mapa são ouvidos: a fixada na transmissão ou a aberta pelo mestre. */
  get audibleSceneId(): string | null { return this.sceneId ?? this.table.sceneId }

  setAudio(state: AudioState): void {
    this.audio = state
    if (this.enabled && this.audioEnabled) this.server.publish({ type: "audio", audio: state })
  }

  setCommit(commit: (change: Change) => void): void {
    this.commit = commit
  }

  setMovesEnabled(enabled: boolean): void {
    this.movesEnabled = enabled
    if (this.enabled) this.server.publish({ type: "moves", moves: enabled })
    this.emit()
  }

  /** Único pedido que um espectador pode fazer: mover um token "Jogador". */
  handleClientMessage(value: unknown): PlayerWireMessage | null {
    const request = normalizeMoveRequest(value)
    if (!request) return null
    const reject = (reason: string): PlayerWireMessage => ({ type: "move-result", tokenId: request.tokenId, ok: false, reason })
    if (!this.enabled || !this.movesEnabled) return reject("O mestre não está permitindo mover tokens agora.")
    const database = this.store.openWorld?.database
    if (!database || !this.commit) return reject("Nenhum mundo aberto.")
    const result = validatePlayerMove(database, this.lastProjection.scene?.id ?? null, request)
    if (!result.ok) return reject(result.reason)
    this.commit(putDocument(database, { id: result.token.id, type: "token", parentId: result.token.parentId, data: result.token.data }).change)
    return { type: "move-result", tokenId: request.tokenId, ok: true }
  }

  setAudioEnabled(enabled: boolean): void {
    this.audioEnabled = enabled
    if (this.enabled) this.server.publish({ type: "audio", audio: enabled ? this.audio : null })
    this.emit()
  }

  /** Reenvia a cena (ex.: depois de redefinir a névoa explorada). */
  refresh(): void {
    if (this.enabled) this.publishSnapshot()
  }

  private publishSnapshot(): void {
    this.refreshProjection()
    if (this.ruler && this.ruler.sceneId !== this.lastProjection.scene?.id) this.ruler = null
    this.server.publish(this.snapshotMessage())
  }

  private snapshotMessage(): PlayerWireMessage {
    return { type: "snapshot", projection: this.lastProjection, ruler: this.ruler, audio: this.audioEnabled ? { ...this.audio, now: Date.now() } : null, moves: this.movesEnabled }
  }

  private emit(spectators = this.server.spectatorCount): void {
    this.onStateChange({ ...this.state(), spectators })
  }
}
