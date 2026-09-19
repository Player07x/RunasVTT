import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react"
import { keyLabel, type KeyAction } from "../../../shared/settings"
import type { PlayerRuler } from "../../../shared/player"
import { useSettings } from "../settings"
import { AudioLines, BrickWall, Circle, SquareDashed, DoorClosed, DoorOpen, Eye, EyeOff, ImagePlus, Lightbulb, Link2, Lock, MapPin, MousePointer2, Pencil, Ruler, ScanEye, Square, Trash2, Type, UserRound, Waves } from "lucide-react"
import type { DocumentInput } from "../../../shared/ipc"
import { snapTokenCenter } from "../../../shared/grid"
import { BAR_COLORS, isAlly, TOKEN_DISPOSITIONS, WALL_KINDS, type DrawingData, type DrawingShape, type LightData, type NoteData, type SceneData, type TileData, type TokenBar, type TokenData, type TokenDisposition, type WallData, type WallKind } from "../../../shared/scene"
import { computeVision, renderVision } from "../../../shared/vision"
import type { SoundData } from "../../../shared/audio"
import { REGION_SHAPES, REGION_TRIGGERS, type RegionData, type RegionShape, type RegionTrigger } from "../../../shared/region"
import type { AssetKind, WorldDocument } from "../../../shared/world"
import { resolveAssetUrl, vtt } from "../api"
import { newId, useDocumentsVersion, type DocumentStore } from "../document-store"
import { FLOAT_COLORS, SceneView, type DrawOptions, type SceneTool } from "./SceneView"
import { useSceneKeyboard } from "./keyboard"

const TOOLS: { id: SceneTool; label: string; action: KeyAction; icon: typeof Ruler }[] = [
  { id: "select", label: "Selecionar e mover", action: "toolSelect", icon: MousePointer2 },
  { id: "ruler", label: "Régua", action: "toolRuler", icon: Ruler },
  { id: "token", label: "Novo token", action: "toolToken", icon: UserRound },
  { id: "draw", label: "Desenhar", action: "toolDraw", icon: Pencil },
  { id: "note", label: "Nota no mapa", action: "toolNote", icon: MapPin },
  { id: "wall", label: "Paredes e portas", action: "toolWall", icon: BrickWall },
  { id: "light", label: "Luzes", action: "toolLight", icon: Lightbulb },
  { id: "sound", label: "Sons no mapa", action: "toolSound", icon: AudioLines },
  { id: "region", label: "Regiões", action: "toolRegion", icon: SquareDashed },
]

const REGION_SHAPE_LABELS: Record<RegionShape, string> = { rectangle: "Retângulo", ellipse: "Elipse" }
const REGION_TRIGGER_LABELS: Record<RegionTrigger, string> = { friendly: "Só Jogador e Aliado", any: "Qualquer token" }

const WALL_LABELS: Record<WallKind, string> = { wall: "Parede", door: "Porta", secret: "Porta secreta" }
const WALL_ICONS: Record<WallKind, typeof BrickWall> = { wall: BrickWall, door: DoorClosed, secret: DoorOpen }
/** Na mesa, a escuridão aparece mais fraca para o mestre enxergar o mapa. */
const MASTER_DARKNESS = 0.6

const TOOL_HINTS: Partial<Record<SceneTool, string>> = {
  wall: "Arraste para criar uma parede · as pontas encaixam em outras paredes e na grade (Alt solta) · clique numa parede para editar · ícones de porta abrem e fecham",
  region: "Arraste para criar uma região · clique numa região para editar teleporte, texto ou terreno difícil · os cantos encaixam em meias células (Alt solta)",
  sound: "Clique para pôr um som no mapa · ele toca para os jogadores quando um aliado está no alcance · Alt solta da grade",
  light: "Clique para acender uma luz · arraste para mover · os raios aparecem com a luz selecionada",
}

const SHAPES: { id: DrawingShape; label: string; icon: typeof Square }[] = [
  { id: "rectangle", label: "Retângulo", icon: Square },
  { id: "ellipse", label: "Elipse", icon: Circle },
  { id: "freehand", label: "Mão livre", icon: Waves },
  { id: "text", label: "Texto", icon: Type },
]

const DISPOSITION_LABELS: Record<TokenDisposition, string> = { player: "Jogador", friendly: "Aliado", neutral: "Neutro", hostile: "Hostil", secret: "Secreto" }

/** Lê um arquivo de imagem, importa para o mundo e devolve o caminho e o tamanho natural. */
export async function importImage(kind: AssetKind, file: File): Promise<{ path: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  const path = await vtt.assets.import(kind, file.name, new Uint8Array(await file.arrayBuffer()))
  return { path, ...size }
}

export function SceneCanvas({ store, sceneId, onOpenUrl }: { store: DocumentStore; sceneId: string | null; onOpenUrl: (url: string) => void }) {
  const version = useDocumentsVersion(store)
  const settings = useSettings()
  const host = useRef<HTMLDivElement>(null)
  const rulerSender = useRef<{ timer: number | null; pending: PlayerRuler | null }>({ timer: null, pending: null })
  const viewRef = useRef<SceneView | null>(null)
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<SceneTool>("select")
  const [wallKind, setWallKind] = useState<WallKind>("wall")
  const [regionShape, setRegionShape] = useState<RegionShape>("rectangle")
  const [preview, setPreview] = useState(false)
  const [drawOptions, setDrawOptions] = useState<DrawOptions>({ shape: "rectangle", strokeColor: "#f3ece8", fillColor: "#82aaa6", fillAlpha: 0, strokeWidth: 4 })
  const [selection, setSelection] = useState<string[]>([])
  const [status, setStatus] = useState("")
  const [error, setError] = useState("")
  const tileInput = useRef<HTMLInputElement>(null)
  const reportTimer = useRef<number | null>(null)
  const latest = useRef({ sceneId, selection })
  const mountedAt = useRef(Date.now())
  const shownFloats = useRef(new Set<string>())
  latest.current = { sceneId, selection }

  /** Informa à ponte (sites da suíte) a cena, a seleção e o centro da vista. */
  const scheduleReport = () => {
    if (reportTimer.current !== null) window.clearTimeout(reportTimer.current)
    reportTimer.current = window.setTimeout(() => {
      reportTimer.current = null
      const view = viewRef.current
      void vtt.table.report({ sceneId: latest.current.sceneId, selection: latest.current.selection, center: view ? view.viewCenter() : null, zoom: view ? view.viewZoom() : null })
    }, 120)
  }
  /** Régua da mesa para os jogadores, no máximo ~20 vezes por segundo (a última sempre chega). */
  const sendRuler = (ruler: PlayerRuler | null) => {
    const sender = rulerSender.current
    sender.pending = ruler
    if (sender.timer !== null) return
    void vtt.player.ruler(ruler)
    sender.timer = window.setTimeout(() => {
      sender.timer = null
      if (sender.pending !== ruler) void vtt.player.ruler(sender.pending)
    }, 50)
  }
  const scene = sceneId ? store.get<SceneData>(sceneId) : null
  const put = (input: DocumentInput) => { void store.put(input).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))) }

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let created: SceneView | null = null
    void SceneView.create(element, {
      onSelectionChange: (ids) => { setSelection(ids); latest.current = { ...latest.current, selection: ids }; scheduleReport() },
      onViewChange: scheduleReport,
      onPut: put,
      onRemove: (ids) => { for (const id of ids) void store.remove(id) },
      onOpenNote: (note) => { if (note.url) onOpenUrl(note.url) },
      onStatus: setStatus,
      onRulerChange: sendRuler,
    }, { editable: true }).then((view) => {
      if (disposed) { view.destroy(); return }
      created = view
      viewRef.current = view
      setReady(true)
    })
    return () => {
      disposed = true
      created?.destroy()
      viewRef.current = null
    }
    // A cena é recriada só ao montar; mudanças chegam pelos efeitos abaixo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Toda mudança nos documentos redesenha o que mudou (e só então).
  useEffect(() => {
    const view = viewRef.current
    if (!view || !ready) return
    const current = sceneId ? store.get<SceneData>(sceneId) : null
    view.setScene(current, current ? store.children(current.id) : null)
    view.consumePendingSelection()
  }, [version, sceneId, ready, store])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { scheduleReport() }, [sceneId, ready])
  useEffect(() => () => { void vtt.table.report({ sceneId: null, selection: [], center: null }) }, [])

  // Danos e testes enviados pelos sites sobem sobre o token (só os novos).
  useEffect(() => {
    const view = viewRef.current
    if (!view || !ready) return
    for (const entry of store.logs().slice(0, 20)) {
      if (entry.createdAt < mountedAt.current || shownFloats.current.has(entry.id)) continue
      shownFloats.current.add(entry.id)
      if (entry.data.tokenId && entry.data.floatingText) view.floatText(entry.data.tokenId, entry.data.floatingText, FLOAT_COLORS[entry.data.kind])
    }
  }, [version, ready, store])

  useEffect(() => { viewRef.current?.setTool(tool) }, [tool, ready])
  useEffect(() => { viewRef.current?.setDrawOptions(drawOptions) }, [drawOptions, ready])
  useEffect(() => { viewRef.current?.setPanSpeed(settings.panSpeed) }, [settings.panSpeed, ready])
  useEffect(() => { viewRef.current?.setWallKind(wallKind) }, [wallKind, ready])
  useEffect(() => { viewRef.current?.setRegionShape(regionShape) }, [regionShape, ready])

  // Luz e névoa calculadas aqui mesmo, com as mesmas funções da projeção dos jogadores.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !ready) return
    const current = sceneId ? store.get<SceneData>(sceneId) : null
    if (!current) { view.setVision(null); return }
    const children = store.children(current.id)
    const vision = computeVision(current.data, children.tokens.map(({ id, data }) => ({ id, data })), children.walls.map((wall) => wall.data), children.lights.map((light) => light.data))
    view.setVision(renderVision(vision, null, preview), preview ? 1 : MASTER_DARKNESS)
  }, [version, sceneId, ready, store, preview])

  const keyboard = useSceneKeyboard(viewRef, settings.keyBindings, (action) => {
    const view = viewRef.current
    if (!view) return
    if (action === "deleteSelection") view.deleteSelection()
    else if (action === "cancel") { view.cancel(); setTool("select") }
    else if (action === "toggleHidden") view.toggleHiddenSelection()
    else if (action === "flipToken") view.flipSelection()
    else {
      const next = TOOLS.find((candidate) => candidate.action === action)
      if (next) setTool(next.id)
    }
  }, true)
  const shortcutOf = (action: KeyAction) => settings.keyBindings[action].map(keyLabel).join(" / ")

  async function addTile(file: File, at?: { x: number; y: number }) {
    const view = viewRef.current
    if (!view || !scene) return
    try {
      const image = await importImage("tiles", file)
      // Limita o tile inicial a metade da cena, mantendo a proporção.
      const scale = Math.min(1, (scene.data.width / 2) / image.width, (scene.data.height / 2) / image.height)
      const width = Math.round(image.width * scale)
      const height = Math.round(image.height * scale)
      const center = at ?? view.viewCenter()
      put({ id: newId(), type: "tile", parentId: scene.id, data: { image: image.path, x: center.x - width / 2, y: center.y - height / 2, width, height } })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível importar a imagem.")
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const view = viewRef.current
    const rect = host.current?.getBoundingClientRect()
    if (!view || !rect) return
    const at = view.toScene({ x: event.clientX - rect.left, y: event.clientY - rect.top })
    for (const file of Array.from(event.dataTransfer.files).filter((candidate) => candidate.type.startsWith("image/"))) void addTile(file, at)
  }

  const selected = selection.length === 1 ? store.get(selection[0]!) : null

  return <div className="scene-canvas" tabIndex={0} onKeyDown={keyboard.onKeyDown} onKeyUp={keyboard.onKeyUp} onBlur={keyboard.onBlur} onPointerDown={(event) => { if ((event.target as HTMLElement).tagName === "CANVAS") event.currentTarget.focus() }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
    <div ref={host} className="scene-host" />
    {!scene && <div className="canvas-placeholder floating"><strong>Nenhuma cena aberta</strong><p>Crie ou abra uma cena na aba <b>Cenas</b> do painel lateral.</p></div>}
    {scene && <>
      <nav className="scene-tools" aria-label="Ferramentas">
        {TOOLS.map(({ id, label, action, icon: Icon }) => <button key={id} className={tool === id ? "active" : ""} title={shortcutOf(action) ? `${label} (${shortcutOf(action)})` : label} aria-label={label} onClick={() => setTool(id)}><Icon size={17} /></button>)}
        <span className="divider" />
        <button className={preview ? "active" : ""} title={scene.data.vision.enabled ? "Ver como os jogadores (névoa e escuridão)" : "Ver a escuridão como os jogadores (a névoa está desligada nesta cena)"} aria-label="Ver como os jogadores" aria-pressed={preview} onClick={() => setPreview((value) => !value)}><ScanEye size={17} /></button>
        <button title="Adicionar imagem (tile)" aria-label="Adicionar imagem" onClick={() => tileInput.current?.click()}><ImagePlus size={17} /></button>
        <input ref={tileInput} type="file" accept="image/*" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void addTile(file); event.target.value = "" }} />
      </nav>
      {tool === "draw" && <div className="draw-options" aria-label="Opções de desenho">
        {SHAPES.map(({ id, label, icon: Icon }) => <button key={id} className={drawOptions.shape === id ? "active" : ""} title={label} aria-label={label} onClick={() => setDrawOptions({ ...drawOptions, shape: id })}><Icon size={15} /></button>)}
        <label title="Cor do traço"><input type="color" value={drawOptions.strokeColor} onChange={(event) => setDrawOptions({ ...drawOptions, strokeColor: event.target.value })} /></label>
        <label title="Cor do preenchimento"><input type="color" value={drawOptions.fillColor} onChange={(event) => setDrawOptions({ ...drawOptions, fillColor: event.target.value, fillAlpha: drawOptions.fillAlpha || 0.35 })} /></label>
        <label className="range" title="Espessura"><input type="range" min={0} max={24} value={drawOptions.strokeWidth} onChange={(event) => setDrawOptions({ ...drawOptions, strokeWidth: Number(event.target.value) })} /></label>
      </div>}
      {tool === "region" && <div className="draw-options" aria-label="Forma da região">
        {REGION_SHAPES.map((shape) => { const Icon = shape === "rectangle" ? Square : Circle; return <button key={shape} className={regionShape === shape ? "active" : ""} title={REGION_SHAPE_LABELS[shape]} aria-label={REGION_SHAPE_LABELS[shape]} onClick={() => setRegionShape(shape)}><Icon size={15} /></button> })}
        <span className="draw-options-label">{REGION_SHAPE_LABELS[regionShape]}</span>
      </div>}
      {tool === "wall" && <div className="draw-options" aria-label="Tipo de parede">
        {WALL_KINDS.map((kind) => { const Icon = WALL_ICONS[kind]; return <button key={kind} className={wallKind === kind ? "active" : ""} title={WALL_LABELS[kind]} aria-label={WALL_LABELS[kind]} onClick={() => setWallKind(kind)}><Icon size={15} /></button> })}
        <span className="draw-options-label">{WALL_LABELS[wallKind]}</span>
      </div>}
      {selected && <PropertiesPanel key={selected.id} document={selected} scene={scene} store={store} put={put} onRemove={() => viewRef.current?.deleteSelection()} />}
      {selection.length > 1 && <div className="properties multi"><strong>{selection.length} objetos selecionados</strong><div className="row-actions"><button className="ghost" onClick={() => viewRef.current?.toggleHiddenSelection()}><EyeOff size={14} /> Ocultar/mostrar</button><button className="ghost danger" onClick={() => viewRef.current?.deleteSelection()}><Trash2 size={14} /> Excluir</button></div></div>}
      <footer className="scene-status">
        <span>{status || TOOL_HINTS[tool] || "Botão direito ou WASD/setas movem o mapa · roda do mouse aproxima · Shift + direção move a seleção · Alt ao soltar um token ignora a grade"}</span>
        <button className="link" onClick={() => viewRef.current?.fitScene()}>Enquadrar cena</button>
      </footer>
    </>}
    {error && <button className="scene-error" onClick={() => setError("")}>{error} ✕</button>}
  </div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>
}

/** Número que só grava ao sair do campo ou apertar Enter. */
function NumberInput({ value, onCommit, step = 1, min }: { value: number; onCommit: (value: number) => void; step?: number; min?: number }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => { const parsed = Number(draft.replace(",", ".")); if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed); else setDraft(String(value)) }
  return <input inputMode="decimal" value={draft} step={step} min={min} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit() }} />
}

function TextInput({ value, onCommit, placeholder }: { value: string; onCommit: (value: string) => void; placeholder?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft !== value) onCommit(draft) }
  return <input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") commit() }} />
}

function PropertiesPanel({ document, scene, store, put, onRemove }: { document: WorldDocument; scene: WorldDocument<SceneData>; store: DocumentStore; put: (input: DocumentInput) => void; onRemove: () => void }) {
  const update = (patch: Record<string, unknown>) => put({ id: document.id, type: document.type, parentId: document.parentId, data: { ...(document.data as object), ...patch } })
  const data = document.data as { hidden?: boolean; locked?: boolean }
  const title = { token: "Token", tile: "Imagem", drawing: "Desenho", note: "Nota", wall: "Parede", light: "Luz", sound: "Som", region: "Região" }[document.type as "token"] ?? "Objeto"
  return <aside className="properties" aria-label={`Propriedades: ${title}`}>
    <header>
      <strong>{title}</strong>
      <div className="row-actions">
        {"hidden" in data && <button className={`icon-toggle ${data.hidden ? "active" : ""}`} title={document.type === "light" ? (data.hidden ? "Apagada (H)" : "Acesa (H)") : document.type === "sound" ? (data.hidden ? "Desligado (H)" : "Ligado (H)") : data.hidden ? "Oculto para os jogadores (H)" : "Visível para os jogadores (H)"} aria-label="Ocultar" onClick={() => update({ hidden: !data.hidden })}>{data.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>}
        {"locked" in data && <button className={`icon-toggle ${data.locked ? "active" : ""}`} title={data.locked ? "Travado" : "Travar posição"} aria-label="Travar" onClick={() => update({ locked: !data.locked })}><Lock size={15} /></button>}
        <button className="icon-toggle danger" title="Excluir (Delete)" aria-label="Excluir" onClick={onRemove}><Trash2 size={15} /></button>
      </div>
    </header>
    {document.type === "token" && <TokenFields data={document.data as TokenData} scene={scene} update={update} />}
    {document.type === "tile" && <TileFields data={document.data as TileData} update={update} />}
    {document.type === "drawing" && <DrawingFields data={document.data as DrawingData} update={update} />}
    {document.type === "note" && <NoteFields data={document.data as NoteData} update={update} />}
    {document.type === "wall" && <WallFields data={document.data as WallData} update={update} />}
    {document.type === "light" && <LightFields data={document.data as LightData} update={update} />}
    {document.type === "sound" && <SoundFields data={document.data as SoundData} update={update} />}
    {document.type === "region" && <RegionFields id={document.id} data={document.data as RegionData} store={store} update={update} />}
  </aside>
}

function ImagePicker({ kind, path, onChange }: { kind: AssetKind; path: string | null; onChange: (path: string | null, size?: { width: number; height: number }) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  return <div className="image-picker">
    {path ? <img src={resolveAssetUrl(path)} alt="" /> : <span className="empty">Sem imagem</span>}
    <div>
      <button className="ghost" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={14} /> {path ? "Trocar" : "Escolher"}</button>
      {path && <button className="link" onClick={() => onChange(null)}>Remover</button>}
    </div>
    <input ref={input} type="file" accept="image/*" hidden onChange={(event) => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file) return
      setBusy(true)
      void importImage(kind, file).then((image) => onChange(image.path, image)).finally(() => setBusy(false))
    }} />
  </div>
}

function TokenFields({ data, scene, update }: { data: TokenData; scene: WorldDocument<SceneData>; update: (patch: Partial<TokenData>) => void }) {
  const setBar = (index: number, patch: Partial<TokenBar>) => update({ bars: data.bars.map((bar, current) => current === index ? { ...bar, ...patch } : bar) })
  const freeLabels = (["PV", "PA", "PE"] as const).filter((label) => !data.bars.some((bar) => bar.label === label))
  return <>
    {data.actor && <p className="actor-badge"><Link2 size={13} /> Ficha do {data.actor.source === "tools" ? "Runas Tools" : "Runas DM"}. Barras e dano vêm do site.</p>}
    <ImagePicker kind="tokens" path={data.image} onChange={(image) => update({ image })} />
    <Field label="Nome"><TextInput value={data.name} onCommit={(name) => update({ name })} /></Field>
    <div className="field-row">
      <Field label="Tamanho (células)"><NumberInput value={data.size} step={0.5} onCommit={(size) => update({ size, ...snapTokenCenter({ x: data.x, y: data.y }, size, scene.data.grid) })} /></Field>
      <Field label="Elevação"><NumberInput value={data.elevation} onCommit={(elevation) => update({ elevation })} /></Field>
      <Field label="Rotação"><NumberInput value={data.rotation} step={15} onCommit={(rotation) => update({ rotation })} /></Field>
    </div>
    <Field label="Disposição"><select value={data.disposition} onChange={(event) => update({ disposition: event.target.value as TokenDisposition })}>{TOKEN_DISPOSITIONS.map((disposition) => <option key={disposition} value={disposition}>{DISPOSITION_LABELS[disposition]}</option>)}</select></Field>
    <label className="check"><input type="checkbox" checked={data.showName} onChange={(event) => update({ showName: event.target.checked })} /> Mostrar nome</label>
    <label className="check"><input type="checkbox" checked={data.mirror} onChange={(event) => update({ mirror: event.target.checked })} /> Espelhar a imagem (F)</label>
    <div className="bars">
      <span className="field-label">Visão e luz</span>
      <label className="check"><input type="checkbox" checked={data.vision.enabled} onChange={(event) => update({ vision: { ...data.vision, enabled: event.target.checked } })} /> Tem visão (aliados revelam o mapa aos jogadores)</label>
      <div className="field-row">
        <Field label="Enxerga no escuro (células)"><NumberInput value={data.vision.range} step={1} min={0} onCommit={(range) => update({ vision: { ...data.vision, range: Math.max(0, range) } })} /></Field>
      </div>
      <div className="field-row">
        <Field label="Luz plena (células)"><NumberInput value={data.light.bright} step={1} min={0} onCommit={(bright) => update({ light: { ...data.light, bright: Math.max(0, bright), dim: Math.max(data.light.dim, bright) } })} /></Field>
        <Field label="Penumbra (células)"><NumberInput value={data.light.dim} step={1} min={0} onCommit={(dim) => update({ light: { ...data.light, dim: Math.max(0, dim) } })} /></Field>
        <Field label="Cor"><input type="color" value={data.light.color} onChange={(event) => update({ light: { ...data.light, color: event.target.value } })} /></Field>
      </div>
      {!isAlly(data.disposition) && <small className="hint">Só tokens Jogador e Aliado revelam o mapa. A luz vale para qualquer token visível.</small>}
      {data.disposition === "player" && <small className="hint">Jogador: os espectadores podem mover este token pela Vista dos Jogadores (se permitido no painel Jogadores).</small>}
    </div>
    <div className="bars">
      <span className="field-label">Barras</span>
      {data.bars.map((bar, index) => <div key={index} className="bar-row">
        <span className="swatch" style={{ background: bar.color }} />
        <strong>{bar.label}</strong>
        <NumberInput value={bar.value} onCommit={(value) => setBar(index, { value })} />
        <span>/</span>
        <NumberInput value={bar.max} min={0} onCommit={(max) => setBar(index, { max })} />
        <button className="link" aria-label={`Remover ${bar.label}`} onClick={() => update({ bars: data.bars.filter((_, current) => current !== index) })}>✕</button>
      </div>)}
      {data.bars.length < 3 && <div className="row-actions">{freeLabels.map((label) => <button key={label} className="ghost small" onClick={() => update({ bars: [...data.bars, { label, value: 10, max: 10, color: BAR_COLORS[label.toLowerCase() as "pv"] }] })}>+ {label}</button>)}</div>}
      {!data.actor && <small className="hint">Importe a ficha pelo Runas DM ou Runas Tools no navegador integrado para as barras acompanharem o dano.</small>}
    </div>
  </>
}

function TileFields({ data, update }: { data: TileData; update: (patch: Partial<TileData>) => void }) {
  const aspect = data.height / data.width
  return <>
    <ImagePicker kind="tiles" path={data.image} onChange={(image, size) => update(size ? { image, height: Math.round(data.width * (size.height / size.width)) } : { image })} />
    <div className="field-row">
      <Field label="Largura"><NumberInput value={data.width} onCommit={(width) => update({ width, height: Math.round(width * aspect) })} /></Field>
      <Field label="Altura"><NumberInput value={data.height} onCommit={(height) => update({ height })} /></Field>
      <Field label="Rotação"><NumberInput value={data.rotation} step={15} onCommit={(rotation) => update({ rotation })} /></Field>
    </div>
    <Field label="Camada"><select value={data.layer} onChange={(event) => update({ layer: event.target.value as TileData["layer"] })}><option value="below">Abaixo dos tokens</option><option value="above">Acima dos tokens (telhados, copas)</option></select></Field>
    <Field label={`Opacidade: ${Math.round(data.alpha * 100)}%`}><input type="range" min={0.1} max={1} step={0.05} value={data.alpha} onChange={(event) => update({ alpha: Number(event.target.value) })} /></Field>
  </>
}

function DrawingFields({ data, update }: { data: DrawingData; update: (patch: Partial<DrawingData>) => void }) {
  return <>
    {data.shape === "text" && <>
      <Field label="Texto"><TextInput value={data.text} onCommit={(text) => update({ text })} /></Field>
      <Field label="Tamanho da fonte"><NumberInput value={data.fontSize} onCommit={(fontSize) => update({ fontSize })} /></Field>
    </>}
    <div className="field-row">
      <Field label={data.shape === "text" ? "Cor" : "Traço"}><input type="color" value={data.strokeColor} onChange={(event) => update({ strokeColor: event.target.value })} /></Field>
      {data.shape !== "text" && <Field label="Espessura"><NumberInput value={data.strokeWidth} onCommit={(strokeWidth) => update({ strokeWidth })} /></Field>}
      {(data.shape === "rectangle" || data.shape === "ellipse") && <Field label="Preenchimento"><input type="color" value={data.fillColor} onChange={(event) => update({ fillColor: event.target.value, fillAlpha: data.fillAlpha || 0.35 })} /></Field>}
    </div>
    {(data.shape === "rectangle" || data.shape === "ellipse") && <Field label={`Opacidade do preenchimento: ${Math.round(data.fillAlpha * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={data.fillAlpha} onChange={(event) => update({ fillAlpha: Number(event.target.value) })} /></Field>}
  </>
}

function WallFields({ data, update }: { data: WallData; update: (patch: Partial<WallData>) => void }) {
  return <>
    <Field label="Tipo"><select value={data.kind} onChange={(event) => update({ kind: event.target.value as WallKind })}>{WALL_KINDS.map((kind) => <option key={kind} value={kind}>{WALL_LABELS[kind]}</option>)}</select></Field>
    {data.kind !== "wall" && <label className="check"><input type="checkbox" checked={data.open} onChange={(event) => update({ open: event.target.checked })} /> Aberta (deixa ver através)</label>}
    <small className="hint">Paredes e portas fechadas bloqueiam visão e luz. Porta secreta aparece para os jogadores como parede comum. Arraste as pontas para ajustar.</small>
  </>
}

function LightFields({ data, update }: { data: LightData; update: (patch: Partial<LightData>) => void }) {
  return <>
    <div className="field-row">
      <Field label="Luz plena (células)"><NumberInput value={data.bright} step={1} min={0} onCommit={(bright) => update({ bright: Math.max(0, bright), dim: Math.max(data.dim, bright) })} /></Field>
      <Field label="Penumbra (células)"><NumberInput value={data.dim} step={1} min={0} onCommit={(dim) => update({ dim: Math.max(0, dim) })} /></Field>
    </div>
    <div className="field-row">
      <Field label="Cor"><input type="color" value={data.color} onChange={(event) => update({ color: event.target.value })} /></Field>
      <Field label={`Intensidade da cor: ${Math.round(data.alpha * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={data.alpha} onChange={(event) => update({ alpha: Number(event.target.value) })} /></Field>
    </div>
    <label className="check"><input type="checkbox" checked={data.hidden} onChange={(event) => update({ hidden: event.target.checked })} /> Apagada</label>
  </>
}

function SoundFields({ data, update }: { data: SoundData; update: (patch: Partial<SoundData>) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState("")
  return <>
    <div className="row-actions">
      <button className="ghost" disabled={busy} onClick={() => input.current?.click()}><AudioLines size={14} /> {data.audio ? "Trocar áudio" : "Escolher áudio"}</button>
      {data.audio && <button className="link" onClick={() => update({ audio: null })}>Remover</button>}
    </div>
    <small className="hint">{busy ? "Importando…" : name || (data.audio ? "Áudio escolhido." : "Sem áudio: o som não toca.")}</small>
    <input ref={input} type="file" accept="audio/*,.mp3,.ogg,.wav,.m4a,.flac,.webm,.opus" hidden onChange={(event) => {
      const file = event.target.files?.[0]
      event.target.value = ""
      if (!file) return
      setBusy(true)
      void file.arrayBuffer().then((bytes) => vtt.assets.import("audio", file.name, new Uint8Array(bytes))).then((audio) => { setName(file.name); update({ audio }) }).finally(() => setBusy(false))
    }} />
    <div className="field-row">
      <Field label="Alcance (células)"><NumberInput value={data.radius} step={1} min={0.5} onCommit={(radius) => update({ radius })} /></Field>
      <Field label={`Volume: ${Math.round(data.volume * 100)}%`}><input type="range" min={0} max={1} step={0.05} value={data.volume} onChange={(event) => update({ volume: Number(event.target.value) })} /></Field>
    </div>
    <label className="check"><input type="checkbox" checked={data.walls} onChange={(event) => update({ walls: event.target.checked })} /> Paredes abafam o som</label>
    <label className="check"><input type="checkbox" checked={data.hidden} onChange={(event) => update({ hidden: event.target.checked })} /> Desligado</label>
    <small className="hint">Toca em loop, no canal Ambiente, mais alto quanto mais perto o aliado mais próximo estiver.</small>
  </>
}

function RegionFields({ id, data, store, update }: { id: string; data: RegionData; store: DocumentStore; update: (patch: Partial<RegionData>) => void }) {
  const targetScene = data.teleport.sceneId ?? (data.teleport.regionId ? store.get(data.teleport.regionId)?.parentId ?? null : null)
  const targets = targetScene ? store.children(targetScene).regions.filter((region) => region.id !== id) : []
  return <>
    <Field label="Nome"><TextInput value={data.name} onCommit={(name) => update({ name })} /></Field>
    <div className="field-row">
      <Field label="Forma"><select value={data.shape} onChange={(event) => update({ shape: event.target.value as RegionShape })}>{REGION_SHAPES.map((shape) => <option key={shape} value={shape}>{REGION_SHAPE_LABELS[shape]}</option>)}</select></Field>
      <Field label="Largura"><NumberInput value={data.width} onCommit={(width) => update({ width })} /></Field>
      <Field label="Altura"><NumberInput value={data.height} onCommit={(height) => update({ height })} /></Field>
      <Field label="Cor"><input type="color" value={data.color} onChange={(event) => update({ color: event.target.value })} /></Field>
    </div>
    <label className="check"><input type="checkbox" checked={data.enabled} onChange={(event) => update({ enabled: event.target.checked })} /> Ativa (os comportamentos disparam)</label>
    <label className="check"><input type="checkbox" checked={data.visible} onChange={(event) => update({ visible: event.target.checked })} /> Visível aos jogadores</label>
    <Field label="Dispara com"><select value={data.trigger} onChange={(event) => update({ trigger: event.target.value as RegionTrigger })}>{REGION_TRIGGERS.map((trigger) => <option key={trigger} value={trigger}>{REGION_TRIGGER_LABELS[trigger]}</option>)}</select></Field>

    <div className="bars">
      <label className="check"><input type="checkbox" checked={data.teleport.enabled} onChange={(event) => update({ teleport: { ...data.teleport, enabled: event.target.checked } })} /> <strong>Teleporte</strong></label>
      {data.teleport.enabled && <>
        <Field label="Cena de destino"><select value={targetScene ?? ""} onChange={(event) => update({ teleport: { ...data.teleport, sceneId: event.target.value || null, regionId: null } })}><option value="">Escolha…</option>{store.scenes().map((scene) => <option key={scene.id} value={scene.id}>{scene.data.name}</option>)}</select></Field>
        {targetScene && <Field label="Região de destino"><select value={data.teleport.regionId ?? ""} onChange={(event) => update({ teleport: { ...data.teleport, sceneId: targetScene, regionId: event.target.value || null } })}><option value="">Escolha…</option>{targets.map((region) => <option key={region.id} value={region.id}>{region.data.name}</option>)}</select></Field>}
        {targetScene && targets.length === 0 && <small className="hint">Crie uma região na cena de destino para o token chegar nela.</small>}
      </>}
    </div>

    <div className="bars">
      <label className="check"><input type="checkbox" checked={data.text.enabled} onChange={(event) => update({ text: { ...data.text, enabled: event.target.checked } })} /> <strong>Texto ao entrar</strong></label>
      {data.text.enabled && <>
        <Field label="Mensagem (vai ao Registro e sobe sobre o token)"><TextInput value={data.text.message} placeholder="O chão range sob seus pés…" onCommit={(message) => update({ text: { ...data.text, message } })} /></Field>
        <label className="check"><input type="checkbox" checked={data.text.once} onChange={(event) => update({ text: { ...data.text, once: event.target.checked } })} /> Só uma vez (desliga depois de mostrar)</label>
      </>}
    </div>

    <div className="bars">
      <label className="check"><input type="checkbox" checked={data.terrain.enabled} onChange={(event) => update({ terrain: { ...data.terrain, enabled: event.target.checked } })} /> <strong>Terreno difícil</strong></label>
      {data.terrain.enabled && <Field label="Cada célula conta como"><NumberInput value={data.terrain.multiplier} step={0.5} min={1} onCommit={(multiplier) => update({ terrain: { ...data.terrain, multiplier: Math.max(1, multiplier) } })} /></Field>}
      {data.terrain.enabled && <small className="hint">A régua conta o trecho dentro da região multiplicado. Os jogadores só contam se a região estiver visível para eles.</small>}
    </div>
  </>
}

function NoteFields({ data, update }: { data: NoteData; update: (patch: Partial<NoteData>) => void }) {
  return <>
    <Field label="Rótulo"><TextInput value={data.label} onCommit={(label) => update({ label })} /></Field>
    <Field label="Página ligada (duplo clique abre no navegador)"><TextInput value={data.url} placeholder="https://runas-dm.pages.dev/wiki" onCommit={(url) => update({ url })} /></Field>
    <Field label="Cor"><input type="color" value={data.color} onChange={(event) => update({ color: event.target.value })} /></Field>
  </>
}
