import { networkInterfaces } from "node:os"
import { randomBytes } from "node:crypto"
import type { DocumentChange, PlayerBarVisibility, PlayerSeatState, PlayerState, TableReport } from "../shared/ipc"
import { barColor, decodeTokenImage, normalizeBridgeCharacter, type CharacterSummary } from "../shared/bridge"
import type { LogData, SceneData, TokenData } from "../shared/scene"
import { DEFAULT_GRID, normalizeToken } from "../shared/scene"
import type { WorldDocument } from "../shared/world"
import { normalizeRuler, projectScene, type PlayerProjection, type PlayerRuler } from "../shared/player"
import { PlayerServer, type JoinedPlayerSeat, type PlayerSeatConnection, type PlayerWireMessage, type SeatCharacterWrite, type SeatCharacterWriteResult } from "./player-server"
import type { SiteMirror } from "./site-mirror"
import type { WorldStore } from "./world-store"
import type { VisionService } from "./vision-service"
import type { AudioState } from "../shared/audio"
import type { DocumentChange as Change } from "../shared/ipc"
import { deleteDocument, putDocument } from "./world-documents"
import { normalizeMoveRequest, validatePlayerMove } from "./player-moves"
import { PlayerSession, normalizeSeatCount } from "./player-session"
import type { SeatCharacterData } from "../shared/player-character"
import { importAsset } from "./world-assets"
import { snapTokenCenter } from "../shared/grid"
import { randomUUID } from "node:crypto"

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
  private session: PlayerSession | null = null
  private playerCount = 0
  private readonly seatWrites = new Set<string>()
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

  constructor(private readonly store: WorldStore, staticRoot: string, onStateChange: (state: PlayerState) => void, private readonly vision: VisionService | null = null, siteMirror: SiteMirror | null = null) {
    this.onStateChange = onStateChange
    this.server = new PlayerServer({
      staticRoot,
      worldPath: () => this.store.openWorld?.summary.path ?? null,
      projection: () => this.lastProjection,
      allowedAssets: () => [...this.lastProjection.assets, ...(this.audioEnabled ? this.audio.sounds.map((sound) => sound.audio) : [])],
      snapshot: () => this.snapshotMessage(),
      onSpectators: (spectators) => { this.emit(spectators) },
      onPlayers: (players) => { this.playerCount = players; this.emit() },
      joinSeat: (code) => this.joinSeat(code),
      authenticateSeat: (token) => this.authenticateSeat(token),
      getSeatCharacter: (seat) => this.getSeatCharacter(seat),
      putSeatCharacter: (seat, input) => this.putSeatCharacter(seat, input),
      deleteSeatCharacter: (seat) => { this.deleteSeatCharacter(seat) },
      toolsMirror: siteMirror ?? undefined,
      onClientMessage: (message, seat) => this.handleClientMessage(message, seat),
    })
  }

  state(): PlayerState {
    const localUrl = this.enabled && this.key ? `http://${localAddress()}:${this.port}/?k=${this.key}` : null
    return { enabled: this.enabled, port: this.port, key: this.key, localUrl, publicUrl: this.publicUrl, sceneId: this.sceneId, audio: this.audioEnabled, moves: this.movesEnabled, bars: this.bars, spectators: this.server.spectatorCount, players: this.playerCount, sessionId: this.session?.id ?? null, seats: this.seatStates() }
  }

  /** URL usada pela BrowserWindow local; a página é a mesma dos espectadores. */
  localWindowUrl(): string | null {
    return this.enabled && this.key ? `http://127.0.0.1:${this.port}/?k=${this.key}` : null
  }

  async start(port = DEFAULT_PORT, seatCount = 1): Promise<PlayerState> {
    if (!this.store.openWorld) throw new Error("Abra um mundo antes de ligar a Vista dos Jogadores.")
    this.port = validPort(port)
    const created = PlayerSession.create(normalizeSeatCount(seatCount))
    const key = randomBytes(16).toString("hex")
    await this.server.start(this.port, key)
    this.key = key
    this.session = created.session
    this.playerCount = 0
    this.enabled = true
    this.publicUrl = null
    this.refreshProjection()
    this.emit(0)
    return { ...this.state(), seats: this.seatStates(created.codes) }
  }

  async stop(): Promise<void> {
    await this.server.stop()
    this.enabled = false
    this.key = null
    this.publicUrl = null
    this.ruler = null
    this.session = null
    this.playerCount = 0
    this.emit(0)
  }

  /** Troca o código de um assento sem reiniciar a transmissão. */
  rotateSeatCode(slotId: string): PlayerState {
    if (!this.session) throw new Error("Ligue a transmissão antes de administrar os assentos.")
    const code = this.session.rotateCode(slotId)
    return { ...this.state(), seats: this.seatStates({ [slotId]: code }) }
  }

  /** Remove a ficha e a conexão do assento; o código continua válido. */
  clearSeat(slotId: string): PlayerState {
    if (!this.session) throw new Error("Ligue a transmissão antes de administrar os assentos.")
    const seat = this.session.getSeat(slotId)
    if (!seat) throw new Error("Assento de jogador não encontrado.")
    this.deleteSeatCharacter({ slotId: seat.slotId, label: seat.label })
    this.session.clearSeat(slotId)
    const state = this.state()
    this.emit()
    return state
  }

  private joinSeat(code: string): JoinedPlayerSeat | null {
    const session = this.session
    if (!session) return null
    const seat = session.authenticateCode(code)
    if (!seat) return null
    const token = session.issueAccessToken(seat.slotId)
    this.emit()
    return { seat: { slotId: seat.slotId, label: seat.label }, token }
  }

  private authenticateSeat(token: string): PlayerSeatConnection | null {
    const seat = this.session?.authenticateAccessToken(token)
    return seat ? { slotId: seat.slotId, label: seat.label } : null
  }

  private seatCharacterId(slotId: string): string { return `seat-character-${slotId}` }

  private getSeatCharacter(seat: PlayerSeatConnection): SeatCharacterData | null {
    const document = this.store.openWorld?.database.get(this.seatCharacterId(seat.slotId))
    if (!document || document.type !== "seat-character") return null
    return structuredClone(document.data as SeatCharacterData)
  }

  private async putSeatCharacter(seat: PlayerSeatConnection, input: SeatCharacterWrite): Promise<SeatCharacterWriteResult> {
    const database = this.store.openWorld?.database
    const worldPath = this.store.openWorld?.summary.path
    if (!database || !worldPath) throw new Error("Nenhum mundo aberto.")
    const id = this.seatCharacterId(seat.slotId)
    const existingDocument = database.get(id)
    const existing = existingDocument?.type === "seat-character" ? existingDocument.data as SeatCharacterData : null
    if (existing?.mutationId === input.mutationId) return { ok: true, character: structuredClone(existing) }
    if (input.baseRevision !== (existing?.revision ?? 0)) return { ok: false, character: existing ? structuredClone(existing) : null }

    const raw = input.character && typeof input.character === "object" && !Array.isArray(input.character)
      ? { ...(input.character as Record<string, unknown>), source: "tools" }
      : input.character
    const normalized = normalizeBridgeCharacter(raw)
    const tokenImage = normalized.tokenImage ?? existing?.tokenImage ?? null
    const tokenSize = normalized.tokenSize
    const now = Date.now()
    let tokenId = existing?.tokenId ?? null
    let sceneId = existing?.sceneId ?? null
    const scene = this.table.sceneId ? database.get(this.table.sceneId) : null
    const sceneData = scene?.type === "scene" ? scene.data as SceneData : null
    let tokenChange: DocumentChange | null = null
    if (sceneData || tokenId) {
      const previousToken = tokenId ? database.get(tokenId) : null
      if (previousToken && previousToken.type !== "token") tokenId = null
      if (!tokenId) {
        const candidate = this.seatCharacterId(seat.slotId).replace("seat-character-", "seat-token-")
        tokenId = database.get(candidate) ? `${candidate}-${randomUUID().replaceAll("-", "").slice(0, 12)}` : candidate
      }
      const token = tokenId ? database.get(tokenId) : null
      const base = token?.type === "token" ? token.data as TokenData : normalizeToken({ name: normalized.summary.name, x: 0, y: 0, size: tokenSize, image: null, disposition: "player" })
      const image = normalized.tokenImage ? decodeTokenImage(normalized.tokenImage) : null
      const imagePath = image ? await importAsset(worldPath, "tokens", `token.${image.extension}`, image.bytes) : base.image
      const position = token?.type === "token" ? { x: base.x, y: base.y } : snapTokenCenter(this.table.center ?? { x: sceneData?.width ? sceneData.width / 2 : 0, y: sceneData?.height ? sceneData.height / 2 : 0 }, tokenSize, sceneData?.grid ?? DEFAULT_GRID)
      const data = normalizeToken({
        ...base,
        ...position,
        name: normalized.summary.name,
        size: tokenSize,
        image: imagePath,
        hidden: false,
        locked: false,
        disposition: "player",
        bars: normalized.summary.bars.map((bar) => ({ ...bar, color: barColor(bar.label) })),
        actor: { envelope: normalized.envelope, source: "tools", updatedAt: now },
        playerSlotId: seat.slotId,
      })
      sceneId = token?.parentId ?? this.table.sceneId
      tokenChange = putDocument(database, { id: tokenId, type: "token", parentId: sceneId, data }).change
    }
    const character: SeatCharacterData = { slotId: seat.slotId, tokenId, sceneId, envelope: normalized.envelope, summary: normalized.summary, tokenImage, tokenSize, revision: (existing?.revision ?? 0) + 1, updatedAt: now, mutationId: input.mutationId }
    const documentChange = putDocument(database, { id, type: "seat-character", parentId: null, data: character }).change
    this.seatWrites.add(seat.slotId)
    try {
      if (tokenChange) this.commit?.(tokenChange)
      this.commit?.(documentChange)
    } finally { this.seatWrites.delete(seat.slotId) }
    this.session?.markAttached(seat.slotId, tokenId)
    this.emit()
    this.server.publishToSeat(seat.slotId, { type: "character-changed", revision: character.revision })
    return { ok: true, character: structuredClone(character) }
  }

  private deleteSeatCharacter(seat: PlayerSeatConnection): void {
    const database = this.store.openWorld?.database
    if (!database) return
    const character = this.getSeatCharacter(seat)
    this.seatWrites.add(seat.slotId)
    try {
      if (character?.tokenId) {
        const token = database.get(character.tokenId)
        if (token?.type === "token") {
          const change = deleteDocument(database, token.id)
          if (change) this.commit?.(change)
        }
      }
      const change = deleteDocument(database, this.seatCharacterId(seat.slotId))
      if (change) this.commit?.(change)
    } finally { this.seatWrites.delete(seat.slotId) }
    this.session?.clearSeat(seat.slotId)
    this.emit()
    this.server.publishToSeat(seat.slotId, { type: "character-changed", revision: 0 })
  }

  /** Espelha alterações feitas pelo mestre na ficha privada do assento. */
  private syncSeatCharacterFromToken(slotId: string, token: WorldDocument): void {
    const database = this.store.openWorld?.database
    if (!database || token.type !== "token") return
    const tokenData = token.data as TokenData
    if (!tokenData.actor) return
    const existingDocument = database.get(this.seatCharacterId(slotId))
    const existing = existingDocument?.type === "seat-character" ? existingDocument.data as SeatCharacterData : null
    const summary: CharacterSummary = { name: tokenData.name, bars: tokenData.bars.map(({ label, value, max }) => ({ label, value, max })) }
    const character: SeatCharacterData = {
      slotId,
      tokenId: token.id,
      sceneId: token.parentId,
      envelope: structuredClone(tokenData.actor.envelope),
      summary,
      tokenImage: existing?.tokenImage ?? null,
      tokenSize: tokenData.size,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      mutationId: null,
    }
    const change = putDocument(database, { id: this.seatCharacterId(slotId), type: "seat-character", parentId: null, data: character }).change
    this.seatWrites.add(slotId)
    try { this.commit?.(change) } finally { this.seatWrites.delete(slotId) }
    this.session?.markAttached(slotId, token.id)
    this.server.publishToSeat(slotId, { type: "character-changed", revision: character.revision })
  }

  private clearDeletedSeatTokens(ids: string[]): void {
    const database = this.store.openWorld?.database
    if (!database || ids.length === 0) return
    const removed = new Set(ids)
    for (const document of database.list("seat-character", null)) {
      const data = document.data as SeatCharacterData
      if (!data.tokenId || !removed.has(data.tokenId)) continue
      if (this.seatWrites.has(data.slotId)) continue
      const character: SeatCharacterData = { ...data, tokenId: null, sceneId: null, revision: data.revision + 1, updatedAt: Date.now(), mutationId: null }
      const change = putDocument(database, { id: document.id, type: "seat-character", parentId: null, data: character }).change
      this.seatWrites.add(data.slotId)
      try { this.commit?.(change) } finally { this.seatWrites.delete(data.slotId) }
      this.server.publishToSeat(data.slotId, { type: "character-changed", revision: character.revision })
    }
  }

  private async attachPendingSeatCharacters(): Promise<void> {
    if (!this.session || !this.table.sceneId) return
    const database = this.store.openWorld?.database
    if (!database) return
    for (const document of database.list("seat-character", null)) {
      const data = document.data as SeatCharacterData
      if (data.tokenId) continue
      const seat = this.session.getSeat(data.slotId)
      if (!seat) continue
      try {
        await this.putSeatCharacter({ slotId: seat.slotId, label: seat.label }, { character: { envelope: data.envelope, summary: data.summary, source: "tools", tokenImage: data.tokenImage, tokenSize: data.tokenSize }, tokenId: null, baseRevision: data.revision, mutationId: `attach-${Date.now()}-${seat.slotId}` })
      } catch { /* a ficha inválida fica guardada para o mestre corrigir */ }
    }
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
    if (sceneChanged) void this.attachPendingSeatCharacters()
  }

  onDocumentChange(change: DocumentChange): void {
    if (!this.enabled) return
    // Rebuild from the database instead of forwarding `change`: projection is
    // the security boundary, including for bridge writes and deletes.
    if (change.kind === "put" && change.document.type === "log-entry") { this.publishFloat(change.document.data as LogData); return }
    if (change.kind === "put" && change.document.type === "token") {
      const data = change.document.data as TokenData
      if (data.playerSlotId && !this.seatWrites.has(data.playerSlotId)) this.syncSeatCharacterFromToken(data.playerSlotId, change.document)
    } else if (change.kind === "delete") {
      this.clearDeletedSeatTokens(change.ids)
    }
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
  handleClientMessage(value: unknown, seat?: PlayerSeatConnection | null): PlayerWireMessage | null {
    const request = normalizeMoveRequest(value)
    if (!request) return null
    const reject = (reason: string): PlayerWireMessage => ({ type: "move-result", tokenId: request.tokenId, ok: false, reason })
    if (!this.enabled || !this.movesEnabled) return reject("O mestre não está permitindo mover tokens agora.")
    const database = this.store.openWorld?.database
    if (!database || !this.commit) return reject("Nenhum mundo aberto.")
    const result = validatePlayerMove(database, this.lastProjection.scene?.id ?? null, request)
    if (!result.ok) return reject(result.reason)
    // A network client can move only the token attached to its own seat. The
    // optional parameter keeps the pure unit-test entry point useful; the
    // PlayerServer always supplies null for spectators and an identity for
    // authenticated players.
    if (seat !== undefined && (!seat || result.token.data.playerSlotId !== seat.slotId)) return reject("Esse token pertence a outro jogador.")
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
    this.onStateChange({ ...this.state(), spectators, players: this.playerCount })
  }

  private seatStates(codes: Record<string, string> = {}): PlayerSeatState[] {
    return this.session?.snapshot().seats.map((seat) => ({ ...seat, ...(codes[seat.slotId] ? { code: codes[seat.slotId] } : {}) })) ?? []
  }
}
