import { useEffect, useRef, useState } from "react"
import type { SceneChildren } from "./document-store"
import { configurePlayerAssets } from "./api"
import { SceneView } from "./canvas/SceneView"
import type { PlayerProjection } from "../../shared/player"
import type { SceneData } from "../../shared/scene"
import type { WorldDocument } from "../../shared/world"

interface PlayerMessage {
  type: "snapshot" | "camera" | "pong"
  projection?: PlayerProjection
  followMaster?: boolean
  center?: { x: number; y: number } | null
  zoom?: number | null
  force?: boolean
}

function documentOf(value: { id: string; type: WorldDocument["type"]; parentId: string | null; sort: number; data: unknown }): WorldDocument {
  // Timestamps are intentionally synthetic: they are not part of the wire
  // projection and the player renderer never persists these documents.
  return { ...value, createdAt: 0, updatedAt: 0 }
}

function childrenOf(projection: PlayerProjection): { scene: WorldDocument<SceneData> | null; children: SceneChildren | null } {
  if (!projection.scene) return { scene: null, children: null }
  const scene = documentOf({ id: projection.scene.id, type: "scene", parentId: null, sort: 0, data: projection.scene.data }) as WorldDocument<SceneData>
  const children: SceneChildren = { tokens: [], tiles: [], drawings: [], notes: [] }
  for (const child of projection.children) {
    const document = documentOf(child)
    if (child.type === "token") children.tokens.push(document as unknown as SceneChildren["tokens"][number])
    else if (child.type === "tile") children.tiles.push(document as unknown as SceneChildren["tiles"][number])
    else if (child.type === "drawing") children.drawings.push(document as unknown as SceneChildren["drawings"][number])
    else children.notes.push(document as unknown as SceneChildren["notes"][number])
  }
  return { scene, children }
}

export function PlayerView() {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<SceneView | null>(null)
  const projection = useRef<PlayerProjection>({ scene: null, children: [], assets: [] })
  const camera = useRef<{ follow: boolean; center: { x: number; y: number } | null; zoom: number | null; force: boolean }>({ follow: true, center: null, zoom: null, force: false })
  const socket = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState(0)

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
      try {
        const message = JSON.parse(String(event.data)) as PlayerMessage
        if (message.type === "snapshot" && message.projection) projection.current = message.projection
        if (message.followMaster !== undefined) camera.current.follow = message.followMaster
        camera.current.force = message.type === "camera" && message.force === true
        if (message.type === "snapshot" || message.type === "camera") {
          if (message.center !== undefined) camera.current.center = message.center ?? null
          if (message.zoom !== undefined) camera.current.zoom = message.zoom ?? null
        }
        setRevision((value) => value + 1)
      } catch { /* mensagens inválidas não alteram a cena */ }
    }
    return () => { disposed = true; ws.close(); socket.current = null }
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
    }, { editable: false }).then((created) => {
      if (disposed) { created.destroy(); return }
      view.current = created
      setReady(true)
    })
    return () => { disposed = true; view.current?.destroy(); view.current = null }
  }, [])

  useEffect(() => {
    if (!ready || !view.current) return
    const current = childrenOf(projection.current)
    view.current.setScene(current.scene, current.children)
    const point = camera.current.center
    if (point && (camera.current.follow || camera.current.force)) {
      view.current.setCamera(point, camera.current.zoom)
      camera.current.force = false
    }
  }, [ready, revision])

  return <main className="player-page" aria-label="Vista dos Jogadores">
    <div ref={host} className="player-host" />
    {!connected && <div className="player-status">Aguardando a transmissão…</div>}
  </main>
}
