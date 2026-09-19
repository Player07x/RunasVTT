import { useEffect, useRef, useState } from "react"
import { Hand, Ruler, Volume2, VolumeX } from "lucide-react"
import type { SceneChildren } from "./document-store"
import { configurePlayerAssets, resolveAssetUrl } from "./api"
import { AudioEngine } from "./audio-engine"
import { DEFAULT_AUDIO_MIX, type AudioState } from "../../shared/audio"
import { FLOAT_COLORS, SceneView, type SceneTool } from "./canvas/SceneView"
import { useSceneKeyboard } from "./canvas/keyboard"
import { defaultKeyBindings, keyLabel } from "../../shared/settings"
import type { PlayerProjection, PlayerRuler, PlayerWireMessage } from "../../shared/player"
import type { SceneData } from "../../shared/scene"
import type { WorldDocument } from "../../shared/world"

const BINDINGS = defaultKeyBindings()
const VOLUME_KEY = "runas-vtt.player-volume"

function readVolume(): number {
  try { const value = Number(localStorage.getItem(VOLUME_KEY)); return Number.isFinite(value) && localStorage.getItem(VOLUME_KEY) !== null ? Math.min(1, Math.max(0, value)) : 0.8 } catch { return 0.8 }
}

function documentOf(value: { id: string; type: WorldDocument["type"]; parentId: string | null; sort: number; data: unknown }): WorldDocument {
  // Timestamps are intentionally synthetic: they are not part of the wire
  // projection and the player renderer never persists these documents.
  return { ...value, createdAt: 0, updatedAt: 0 }
}

function childrenOf(projection: PlayerProjection): { scene: WorldDocument<SceneData> | null; children: SceneChildren | null } {
  if (!projection.scene) return { scene: null, children: null }
  const scene = documentOf({ id: projection.scene.id, type: "scene", parentId: null, sort: 0, data: projection.scene.data }) as WorldDocument<SceneData>
  const children: SceneChildren = { tokens: [], tiles: [], drawings: [], notes: [], walls: [], lights: [], sounds: [], regions: [] }
  for (const child of projection.children) {
    const document = documentOf(child)
    if (child.type === "token") children.tokens.push(document as unknown as SceneChildren["tokens"][number])
    else if (child.type === "tile") children.tiles.push(document as unknown as SceneChildren["tiles"][number])
    else if (child.type === "drawing") children.drawings.push(document as unknown as SceneChildren["drawings"][number])
    else children.notes.push(document as unknown as SceneChildren["notes"][number])
  }
  return { scene, children }
}

/**
 * Página dos jogadores. A câmera é de cada espectador: ela só muda quando o
 * mestre usa "Puxar a câmera". A régua do espectador fica só na tela dele.
 */
export function PlayerView() {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<SceneView | null>(null)
  const projection = useRef<PlayerProjection>({ scene: null, children: [], assets: [], vision: null, regions: [] })
  const ruler = useRef<PlayerRuler | null>(null)
  const pendingCamera = useRef<{ center: { x: number; y: number }; zoom: number | null } | null>(null)
  const pendingFloats = useRef<{ tokenId: string; text: string; color: number }[]>([])
  const [connected, setConnected] = useState(false)
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState(0)
  const [tool, setTool] = useState<SceneTool>("select")
  const audio = useRef<AudioState | null>(null)
  const engine = useRef<AudioEngine | null>(null)
  // Navegadores só tocam som depois de um clique; a janela local do VTT (Electron) já pode.
  const [soundOn, setSoundOn] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [volume, setVolume] = useState(readVolume)
  const [playingCount, setPlayingCount] = useState(0)
  const socket = useRef<WebSocket | null>(null)
  const [moves, setMoves] = useState(false)
  const [notice, setNotice] = useState("")
  const pendingRejects = useRef<{ tokenId: string; reason: string }[]>([])

  useEffect(() => {
    const key = new URLSearchParams(location.search).get("k")
    if (!key) return
    configurePlayerAssets(`${location.origin}/assets/`, key)
    let disposed = false
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/socket?k=${encodeURIComponent(key)}`
    const ws = new WebSocket(wsUrl)
    socket.current = ws
    ws.onopen = () => { if (!disposed) setConnected(true) }
    ws.onclose = () => { if (!disposed) setConnected(false) }
    ws.onerror = () => { if (!disposed) setConnected(false) }
    ws.onmessage = (event) => {
      let message: PlayerWireMessage
      try { message = JSON.parse(String(event.data)) as PlayerWireMessage } catch { return }
      if (message.type === "snapshot") { projection.current = message.projection; ruler.current = message.ruler; audio.current = message.audio; setMoves(message.moves) }
      else if (message.type === "moves") setMoves(message.moves)
      else if (message.type === "move-result") { if (!message.ok) pendingRejects.current.push({ tokenId: message.tokenId, reason: message.reason ?? "Movimento recusado." }) }
      else if (message.type === "audio") audio.current = message.audio
      else if (message.type === "ruler") ruler.current = message.ruler
      else if (message.type === "camera") pendingCamera.current = { center: message.center, zoom: message.zoom }
      else if (message.type === "float") pendingFloats.current.push({ tokenId: message.tokenId, text: message.text, color: FLOAT_COLORS[message.kind] ?? FLOAT_COLORS.info })
      else return
      setRevision((value) => value + 1)
    }
    return () => { disposed = true; socket.current = null; ws.close() }
  }, [])

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    void SceneView.create(element, {
      onSelectionChange: () => undefined,
      onPut: () => undefined,
      onRemove: () => undefined,
      onOpenNote: () => undefined,
      // O VTT confere o pedido (Jogador, paredes, mapa) e devolve a cena atualizada, ou a recusa.
      onMove: (tokenId, position) => { socket.current?.send(JSON.stringify({ type: "move", tokenId, x: position.x, y: position.y })) },
    }, { editable: false }).then((created) => {
      if (disposed) { created.destroy(); return }
      view.current = created
      setReady(true)
    })
    return () => { disposed = true; view.current?.destroy(); view.current = null }
  }, [])

  useEffect(() => {
    const current = view.current
    if (!ready || !current) return
    const { scene, children } = childrenOf(projection.current)
    current.setScene(scene, children)
    current.setVision(projection.current.vision)
    current.setPlayerRegions(projection.current.regions ?? [])
    current.setRemoteRuler(ruler.current)
    if (pendingCamera.current) { current.setCamera(pendingCamera.current.center, pendingCamera.current.zoom); pendingCamera.current = null }
    for (const float of pendingFloats.current.splice(0)) current.floatText(float.tokenId, float.text, float.color)
    for (const reject of pendingRejects.current.splice(0)) { current.revertToken(reject.tokenId); setNotice(reject.reason) }
    engine.current?.apply(audio.current)
    setPlayingCount(audio.current?.sounds.length ?? 0)
  }, [ready, revision])

  // Um só volume na página (o mestre já equilibra música, ambiente e efeitos).
  useEffect(() => {
    const created = new AudioEngine(resolveAssetUrl, { ...DEFAULT_AUDIO_MIX, master: readVolume(), music: 1, ambient: 1, effects: 1 }, false)
    created.onBlocked = () => setBlocked(true)
    engine.current = created
    return () => { created.destroy(); engine.current = null }
  }, [])
  useEffect(() => {
    engine.current?.setMix({ master: soundOn ? volume : 0, music: 1, ambient: 1, effects: 1 })
    try { localStorage.setItem(VOLUME_KEY, String(volume)) } catch { /* preferência opcional */ }
  }, [volume, soundOn])

  function enableSound() {
    setSoundOn(true)
    setBlocked(false)
    engine.current?.unlock()
    engine.current?.apply(audio.current)
  }

  useEffect(() => { view.current?.setTool(tool) }, [tool, ready])
  // Só tokens "Jogador", e só enquanto o mestre permitir.
  useEffect(() => { view.current?.setMovable((document) => moves && document.type === "token" && (document.data as { disposition?: string }).disposition === "player") }, [moves, ready])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(""), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  const keyboard = useSceneKeyboard(view, BINDINGS, (action) => {
    if (action === "toolRuler") setTool("ruler")
    else if (action === "toolSelect" || action === "cancel") setTool("select")
  }, false)
  useEffect(() => {
    const down = (event: KeyboardEvent) => keyboard.onKeyDown(event)
    const up = (event: KeyboardEvent) => keyboard.onKeyUp(event)
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up) }
  })

  const shortcut = (action: "toolSelect" | "toolRuler") => BINDINGS[action].map(keyLabel).join(" / ")

  return <main className="player-page" aria-label="Vista dos Jogadores">
    <div ref={host} className="player-host" />
    {connected && <nav className="player-tools" aria-label="Ferramentas do espectador">
      <button className={tool === "select" ? "active" : ""} title={`Mover o mapa (${shortcut("toolSelect")})`} aria-label="Mover o mapa" onClick={() => setTool("select")}><Hand size={17} /></button>
      <button className={tool === "ruler" ? "active" : ""} title={`Régua, só na sua tela (${shortcut("toolRuler")})`} aria-label="Régua" onClick={() => setTool("ruler")}><Ruler size={17} /></button>
    </nav>}
    {connected && <div className="player-audio">
      {soundOn
        ? <><button className="icon-button" title="Silenciar" aria-label="Silenciar" onClick={() => setSoundOn(false)}><Volume2 size={16} /></button><input type="range" min={0} max={1} step={0.05} value={volume} aria-label="Volume" onChange={(event) => setVolume(Number(event.target.value))} /></>
        : <button className={`sound-button ${playingCount > 0 || blocked ? "attention" : ""}`} onClick={enableSound}><VolumeX size={16} /> Ativar som{playingCount > 0 ? ` (${playingCount} tocando)` : ""}</button>}
    </div>}
    {notice && <div className="player-notice" role="status">{notice}</div>}
    {!connected && <div className="player-status">Aguardando a transmissão…</div>}
  </main>
}
