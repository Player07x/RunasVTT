import { networkInterfaces } from "node:os"
import { randomBytes } from "node:crypto"
import type { DocumentChange, PlayerBarVisibility, PlayerState, TableReport } from "../shared/ipc"
import type { SceneData } from "../shared/scene"
import type { WorldDocument } from "../shared/world"
import { projectScene, type PlayerProjection } from "../shared/player"
import { PlayerServer, type PlayerWireMessage } from "./player-server"
import type { WorldStore } from "./world-store"

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
  private followMaster = true
  private bars: PlayerBarVisibility = "friendly"
  private lastProjection: PlayerProjection = { scene: null, children: [], assets: [] }
  private onStateChange: (state: PlayerState) => void

  constructor(private readonly store: WorldStore, staticRoot: string, onStateChange: (state: PlayerState) => void) {
    this.onStateChange = onStateChange
    this.server = new PlayerServer({
      staticRoot,
      worldPath: () => this.store.openWorld?.summary.path ?? null,
      projection: () => this.lastProjection,
      snapshot: () => this.snapshotMessage(),
      onSpectators: (spectators) => { this.emit(spectators) },
    })
  }

  state(): PlayerState {
    const localUrl = this.enabled && this.key ? `http://${localAddress()}:${this.port}/?k=${this.key}` : null
    return { enabled: this.enabled, port: this.port, key: this.key, localUrl, publicUrl: this.publicUrl, sceneId: this.sceneId, followMaster: this.followMaster, bars: this.bars, spectators: this.server.spectatorCount }
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
    this.emit(0)
  }

  async closeWorld(): Promise<void> {
    if (this.enabled) await this.stop()
    this.sceneId = null
    this.table = { sceneId: null, selection: [], center: null, zoom: null }
    this.lastProjection = { scene: null, children: [], assets: [] }
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

  setFollowMaster(follow: boolean): void {
    this.followMaster = follow
    if (this.enabled) this.server.publish(this.cameraMessage(false))
    this.emit()
  }

  pullCamera(): void {
    if (this.enabled) this.server.publish(this.cameraMessage(true))
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
    if (sceneChanged && this.sceneId === null) this.publishSnapshot()
    else if (this.followMaster) this.server.publish(this.cameraMessage(false))
  }

  onDocumentChange(change: DocumentChange): void {
    if (!this.enabled) return
    // Rebuild from the database instead of forwarding `change`: projection is
    // the security boundary, including for bridge writes and deletes.
    if (change.kind === "put" || change.kind === "delete") this.publishSnapshot()
  }

  private refreshProjection(): void {
    const database = this.store.openWorld?.database
    if (!database) { this.lastProjection = { scene: null, children: [], assets: [] }; return }
    const targetId = this.sceneId ?? this.table.sceneId
    const scene = targetId ? database.get(targetId) : null
    if (!scene || scene.type !== "scene") { this.lastProjection = { scene: null, children: [], assets: [] }; return }
    const sceneData = scene.data as SceneData
    this.lastProjection = projectScene({
      scene: scene as WorldDocument<SceneData>,
      children: {
        tokens: database.list("token", scene.id) as WorldDocument<any>[],
        tiles: database.list("tile", scene.id) as WorldDocument<any>[],
        drawings: database.list("drawing", scene.id) as WorldDocument<any>[],
        notes: database.list("note", scene.id) as WorldDocument<any>[],
      },
      bars: this.bars,
    })
    // Touching the value above documents the intentional opaque cast: the
    // database is generic, while projectScene is the only place that reads
    // and strips fields before they reach the transport.
    void sceneData
  }

  private publishSnapshot(): void {
    this.refreshProjection()
    this.server.publish(this.snapshotMessage())
  }

  private snapshotMessage(): PlayerWireMessage {
    return { type: "snapshot", projection: this.lastProjection, followMaster: this.followMaster, center: this.followMaster ? this.table.center : null, zoom: this.followMaster ? this.table.zoom : null }
  }

  private cameraMessage(force: boolean): PlayerWireMessage {
    return { type: "camera", followMaster: this.followMaster, center: this.table.center, zoom: this.table.zoom, force }
  }

  private emit(spectators = this.server.spectatorCount): void {
    this.onStateChange({ ...this.state(), spectators })
  }
}
