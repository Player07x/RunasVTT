// O PixiJS gera shaders com `new Function` por padrão; este módulo oficial
// troca isso por código pré-compilado, e a CSP da interface continua sem unsafe-eval.
import "pixi.js/unsafe-eval"
import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from "pixi.js"
import type { DocumentInput } from "../../../shared/ipc"
import { cellCenter, cellDistance, hexCentersIn, hexVertices, measure, snapTokenCenter, type GridConfig, type Point } from "../../../shared/grid"
import type { DrawingData, DrawingShape, LightData, NoteData, SceneData, TileData, TokenData, TokenDisposition, WallData, WallKind } from "../../../shared/scene"
import type { RenderVision } from "../../../shared/vision"
import type { SoundData } from "../../../shared/audio"
import { measureWithTerrain, regionContains, type PlayerRegion, type RegionData, type RegionShape } from "../../../shared/region"
import { VisionLayer } from "./vision-layer"
import type { WorldDocument } from "../../../shared/world"
import type { SceneChildren } from "../document-store"
import type { PlayerRuler } from "../../../shared/player"
import type { LogKind } from "../../../shared/bridge"
import { resolveAssetUrl } from "../api"

export type SceneTool = "select" | "ruler" | "token" | "note" | "draw" | "wall" | "light" | "sound" | "region"

export interface DrawOptions {
  shape: DrawingShape
  strokeColor: string
  fillColor: string
  fillAlpha: number
  strokeWidth: number
}

export interface SceneViewHandlers {
  onSelectionChange(ids: string[]): void
  onPut(input: DocumentInput): void
  onRemove(ids: string[]): void
  onOpenNote(note: NoteData): void
  /** Texto curto para a barra de status (ex.: distância medida). */
  onStatus?(text: string): void
  /** A área visível mudou (pan, zoom, enquadramento). */
  onViewChange?(): void
  /** A régua da ferramenta Régua mudou (`null` quando some). Não inclui a régua de arrastar tokens. */
  onRulerChange?(ruler: PlayerRuler | null): void
  /** Vista dos Jogadores: o espectador soltou um token "Jogador" (o VTT confere e grava). */
  onMove?(tokenId: string, position: Point): void
}

export interface SceneViewOptions {
  /**
   * `false` na Vista dos Jogadores: sem edição e sem objetos ocultos. O
   * espectador ainda pode arrastar o mapa com o botão esquerdo e usar a régua,
   * que fica só na tela dele.
   */
  editable: boolean
}

type ItemKind = "token" | "tile" | "drawing" | "note" | "wall" | "light" | "sound" | "region"

interface Item {
  id: string
  kind: ItemKind
  document: WorldDocument
  display: Container
  selection: Graphics
  key: string
  /** Redesenha o que tem espessura fixa na tela (paredes, ícones de luz). */
  onZoom?: () => void
}

interface Built { display: Container; selection: Graphics; onZoom?: () => void }

/** Ferramenta que seleciona e move cada tipo de objeto. */
const TOOL_FOR_KIND: Record<ItemKind, SceneTool> = { token: "select", tile: "select", drawing: "select", note: "select", wall: "wall", light: "light", sound: "sound", region: "region" }
const WALL_COLORS: Record<WallKind, number> = { wall: 0xe8dcc4, door: 0xb99b65, secret: 0x927f9c }

function distanceToSegment(point: Point, wall: WallData): number {
  const dx = wall.x2 - wall.x1
  const dy = wall.y2 - wall.y1
  const length = dx * dx + dy * dy
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - wall.x1) * dx + (point.y - wall.y1) * dy) / length))
  return Math.hypot(point.x - (wall.x1 + t * dx), point.y - (wall.y1 + t * dy))
}

type Interaction =
  | { type: "pan"; startGlobal: Point; startPosition: Point }
  // A seleção fica pendente durante o arrasto. Assim, clicar e segurar um
  // token não abre a ficha: a ponte só recebe a seleção no pointerup de um
  // clique sem movimento.
  | { type: "drag"; origin: Point; moved: boolean; entries: { id: string; start: Point }[]; selection: Set<string> }
  | { type: "box"; start: Point }
  | { type: "ruler"; start: Point }
  | { type: "draw"; start: Point; points: number[] }
  | { type: "wall"; start: Point }
  | { type: "region"; start: Point }
  | { type: "wall-end"; id: string; end: 1 | 2; fixed: Point }

const DISPOSITION_COLORS: Record<TokenDisposition, number> = { player: 0x86a47f, friendly: 0x82aaa6, neutral: 0xb99b65, hostile: 0xc76561, secret: 0x927f9c }
/** Cor do texto flutuante de cada tipo de entrada do Registro. */
export const FLOAT_COLORS: Record<LogKind, number> = { damage: 0xc76561, test: 0x82aaa6, info: 0xb99b65 }
const SELECTION_COLOR = 0xf3ece8
const MIN_ZOOM = 0.08
const MAX_ZOOM = 5

const hex = (value: string) => Number.parseInt(value.slice(1), 16)
const formatNumber = (value: number) => value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })

/**
 * Renderiza uma cena com PixiJS e trata a interação do mestre. Não conhece
 * React nem o processo principal: recebe documentos e devolve intenções
 * (`onPut`, `onRemove`) para quem o usa.
 */
export class SceneView {
  private readonly world = new Container()
  private readonly layers = {
    background: new Container(),
    tilesBelow: new Container(),
    grid: new Container(),
    drawings: new Container(),
    regions: new Container(),
    tokens: new Container(),
    tilesAbove: new Container(),
    notes: new Container(),
    vision: new Container(),
    lights: new Container(),
    sounds: new Container(),
    walls: new Container(),
    overlay: new Container(),
  }
  private readonly visionLayer: VisionLayer
  private vision: RenderVision | null = null
  private darknessScale = 1
  private wallKind: WallKind = "wall"
  private regionShape: RegionShape = "rectangle"
  /** Áreas de terreno difícil que a régua conta. */
  private terrain: (Pick<RegionData, "shape" | "x" | "y" | "width" | "height"> & { multiplier: number })[] = []
  /** Regiões visíveis recebidas na Vista dos Jogadores. */
  private readonly playerRegions = new Graphics()
  /** Alças nas pontas da parede selecionada. */
  private readonly wallHandles = new Container()
  private readonly overlay = new Graphics()
  private readonly rulerLabel = new Text({ text: "", style: { fill: 0xf3ece8, fontSize: 15, fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 4 } } })
  /** Régua do mestre na Vista dos Jogadores, separada da régua local do espectador. */
  private readonly remoteOverlay = new Graphics()
  private readonly remoteRulerLabel = new Text({ text: "", style: { fill: 0xf3ece8, fontSize: 15, fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 4 } } })
  private remoteRuler: PlayerRuler | null = null
  /** Há uma régua da ferramenta Régua publicada; apagá-la avisa `onRulerChange(null)`. */
  private rulerPublished = false
  private panVelocity: Point = { x: 0, y: 0 }
  private panSpeed = 1000
  private readonly items = new Map<string, Item>()
  private readonly images = new Map<string, Promise<HTMLImageElement>>()
  private readonly textures = new Map<string, Promise<Texture>>()
  private readonly tokenTextures = new Map<string, Promise<Texture>>()
  private scene: WorldDocument<SceneData> | null = null
  private sceneKey = ""
  private gridKey = ""
  private selection = new Set<string>()
  private tool: SceneTool = "select"
  private drawOptions: DrawOptions = { shape: "rectangle", strokeColor: "#f3ece8", fillColor: "#82aaa6", fillAlpha: 0, strokeWidth: 4 }
  private interaction: Interaction | null = null
  private lastClick = { id: "", at: 0 }
  private readonly removeWheel: () => void
  /** Pinça com dois dedos em andamento: zoom inicial, distância inicial e o ponto do mapa sob o centro dos dedos. */
  private pinch: { zoom: number; distance: number; anchor: Point } | null = null
  private destroyed = false
  /** Vista dos Jogadores: quais tokens o espectador pode arrastar. */
  private movable: (document: WorldDocument) => boolean = () => false

  private constructor(private readonly app: Application, private readonly container: HTMLElement, private readonly handlers: SceneViewHandlers, private readonly options: SceneViewOptions) {
    app.stage.addChild(this.world)
    for (const layer of Object.values(this.layers)) this.world.addChild(layer)
    this.visionLayer = new VisionLayer(app.renderer)
    this.layers.vision.addChild(this.visionLayer.container)
    this.layers.lights.visible = false
    this.layers.sounds.visible = false
    this.layers.regions.addChild(this.playerRegions)
    this.layers.overlay.addChild(this.remoteOverlay, this.remoteRulerLabel, this.overlay, this.rulerLabel, this.wallHandles)
    this.rulerLabel.anchor.set(0.5, 1.2)
    this.rulerLabel.visible = false
    this.remoteRulerLabel.anchor.set(0.5, 1.2)
    this.remoteRulerLabel.visible = false
    app.ticker.add((ticker) => this.panTick(ticker.deltaMS))

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      this.zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.0015))
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()
    // Pinça com dois dedos (celular e tablet). O PixiJS desliga os gestos do
    // navegador no canvas (`touch-action: none`), então o zoom é feito aqui.
    // Os ouvintes ficam em captura no container para rodar antes do PixiJS.
    const touches = new Map<number, Point>()
    const touchPoint = (event: PointerEvent): Point => {
      const rect = container.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const onTouchDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return
      touches.set(event.pointerId, touchPoint(event))
      if (touches.size === 2) this.startPinch(...([...touches.values()] as [Point, Point]))
    }
    const onTouchMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !touches.has(event.pointerId)) return
      touches.set(event.pointerId, touchPoint(event))
      if (this.pinch && touches.size >= 2) this.movePinch(...([...touches.values()].slice(0, 2) as [Point, Point]))
    }
    const onTouchUp = (event: PointerEvent) => {
      if (!touches.delete(event.pointerId) || touches.size >= 2 || !this.pinch) return
      this.pinch = null
      this.handlers.onViewChange?.()
    }
    container.addEventListener("wheel", onWheel, { passive: false })
    container.addEventListener("contextmenu", onContextMenu)
    container.addEventListener("pointerdown", onTouchDown, true)
    container.addEventListener("pointermove", onTouchMove, true)
    container.addEventListener("pointerup", onTouchUp, true)
    container.addEventListener("pointercancel", onTouchUp, true)
    this.removeWheel = () => {
      container.removeEventListener("wheel", onWheel)
      container.removeEventListener("contextmenu", onContextMenu)
      container.removeEventListener("pointerdown", onTouchDown, true)
      container.removeEventListener("pointermove", onTouchMove, true)
      container.removeEventListener("pointerup", onTouchUp, true)
      container.removeEventListener("pointercancel", onTouchUp, true)
    }

    app.stage.eventMode = "static"
    app.stage.hitArea = new Rectangle(-1e7, -1e7, 2e7, 2e7)
    app.stage.on("pointerdown", (event) => this.onStagePointerDown(event))
    app.stage.on("globalpointermove", (event) => this.onPointerMove(event))
    app.stage.on("pointerup", (event) => this.onPointerUp(event))
    app.stage.on("pointerupoutside", (event) => this.onPointerUp(event))
  }

  static async create(container: HTMLElement, handlers: SceneViewHandlers, options: SceneViewOptions): Promise<SceneView> {
    const app = new Application()
    await app.init({ resizeTo: container, background: "#080707", antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 })
    container.appendChild(app.canvas)
    return new SceneView(app, container, handlers, options)
  }

  destroy(): void {
    this.destroyed = true
    this.removeWheel()
    this.visionLayer.destroy()
    this.app.destroy(true, { children: true })
  }

  // ── Estado vindo de fora ────────────────────────────────────────────────

  setScene(scene: WorldDocument<SceneData> | null, children: SceneChildren | null): void {
    const changedScene = scene?.id !== this.scene?.id
    this.scene = scene
    if (changedScene) {
      for (const item of this.items.values()) item.display.destroy({ children: true })
      this.items.clear()
      this.selection.clear()
      this.clearOverlay()
      this.sceneKey = ""
      this.gridKey = ""
    }
    if (!scene || !children) {
      this.layers.background.removeChildren().forEach((child) => child.destroy())
      this.layers.grid.removeChildren().forEach((child) => child.destroy())
      return
    }
    const key = JSON.stringify(scene.data)
    const previous = this.scene && this.sceneKey ? (JSON.parse(this.sceneKey) as SceneData) : null
    if (key !== this.sceneKey) {
      const gridKey = JSON.stringify(scene.data.grid)
      const gridChanged = gridKey !== this.gridKey
      this.sceneKey = key
      this.gridKey = gridKey
      this.drawBackground(scene.data)
      this.drawGrid(scene.data)
      // Mudar a grade muda o tamanho dos tokens: todos são redesenhados.
      if (gridChanged) for (const item of this.items.values()) item.key = ""
    }
    this.syncItems(children)
    // Trocar o mapa costuma mudar o tamanho da cena: reenquadra para não deixar a cena fora de vista.
    const resized = previous !== null && (previous.width !== scene.data.width || previous.height !== scene.data.height)
    if (changedScene || resized) this.fitScene()
    if (changedScene) this.drawRemoteRuler()
    if (changedScene || resized) this.renderVision()
  }

  /**
   * Escuridão, luzes e névoa. `darknessScale` < 1 deixa a escuridão mais
   * fraca na mesa do mestre, que precisa ver o mapa.
   */
  setVision(vision: RenderVision | null, darknessScale = 1): void {
    this.vision = vision
    this.darknessScale = darknessScale
    this.renderVision()
  }

  setWallKind(kind: WallKind): void {
    this.wallKind = kind
  }

  /** Vista dos Jogadores: define quais tokens o espectador pode arrastar. */
  setMovable(movable: (document: WorldDocument) => boolean): void {
    this.movable = movable
    if (!this.options.editable) for (const item of this.items.values()) this.applyMovable(item)
  }

  /** Devolve o token à posição gravada (movimento recusado pelo VTT). */
  revertToken(tokenId: string): void {
    const item = this.items.get(tokenId)
    if (!item) return
    const data = item.document.data as { x: number; y: number }
    item.display.position.set(data.x, data.y)
  }

  private applyMovable(item: Item): void {
    const movable = item.kind === "token" && this.movable(item.document)
    item.display.eventMode = movable ? "static" : "auto"
    item.display.cursor = movable ? "grab" : "default"
  }

  setRegionShape(shape: RegionShape): void {
    this.regionShape = shape
  }

  /** Vista dos Jogadores: regiões marcadas como visíveis, sem interação. */
  setPlayerRegions(regions: readonly PlayerRegion[]): void {
    this.terrain = regions.filter((region) => region.terrain > 1).map((region) => ({ ...region, multiplier: region.terrain }))
    this.playerRegions.clear()
    for (const region of regions) {
      const color = hex(region.color)
      if (region.shape === "ellipse") this.playerRegions.ellipse(region.x + region.width / 2, region.y + region.height / 2, region.width / 2, region.height / 2)
      else this.playerRegions.rect(region.x, region.y, region.width, region.height)
      this.playerRegions.fill({ color, alpha: 0.14 }).stroke({ color, width: 2, alpha: 0.6 })
    }
  }

  private renderVision(): void {
    const scene = this.scene
    this.visionLayer.render(scene ? this.vision : null, scene?.data.width ?? 0, scene?.data.height ?? 0, this.darknessScale)
  }

  setTool(tool: SceneTool): void {
    const changed = tool !== this.tool
    this.tool = tool
    this.clearOverlay()
    this.app.canvas.style.cursor = tool === "select" ? "default" : "crosshair"
    this.layers.lights.visible = tool === "light"
    this.layers.sounds.visible = tool === "sound"
    for (const item of this.items.values()) if (item.kind === "wall" || item.kind === "region") item.onZoom?.()
    // Trocar de ferramenta solta o que só a outra ferramenta seleciona (paredes, luzes).
    if (changed && [...this.selection].some((id) => { const item = this.items.get(id); return item && TOOL_FOR_KIND[item.kind] !== tool })) {
      this.selection.clear()
      this.emitSelection()
    }
    this.updateWallHandles()
  }

  setDrawOptions(options: DrawOptions): void {
    this.drawOptions = options
  }

  /** Direção da câmera pelo teclado (-1, 0 ou 1 em cada eixo); zero para. */
  setPanDirection(direction: Point): void {
    this.panVelocity = direction
  }

  setPanSpeed(pixelsPerSecond: number): void {
    this.panSpeed = pixelsPerSecond
  }

  /** Aproxima ou afasta pelo centro da tela (teclado). */
  zoomBy(factor: number): void {
    this.zoomAt({ x: this.app.screen.width / 2, y: this.app.screen.height / 2 }, factor)
  }

  /** Régua recebida do mestre (Vista dos Jogadores). */
  setRemoteRuler(ruler: PlayerRuler | null): void {
    this.remoteRuler = ruler
    this.drawRemoteRuler()
  }

  setSelection(ids: string[]): void {
    this.selection = new Set(ids.filter((id) => this.items.has(id)))
    this.refreshSelection()
  }

  getSelection(): string[] {
    return [...this.selection]
  }

  /** Centro da área visível, em coordenadas da cena. */
  viewCenter(): Point {
    return this.world.toLocal({ x: this.app.screen.width / 2, y: this.app.screen.height / 2 })
  }

  /** Escala atual da câmera, usada para a Vista dos Jogadores seguir a mesa. */
  viewZoom(): number {
    return this.world.scale.x
  }

  /** Move a câmera para um ponto sem criar uma intenção de edição. */
  setCamera(center: Point, zoom?: number | null): void {
    if (!this.scene) return
    const nextZoom = zoom === null || zoom === undefined ? this.world.scale.x : Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
    this.world.scale.set(nextZoom)
    this.world.position.set(this.app.screen.width / 2 - center.x * nextZoom, this.app.screen.height / 2 - center.y * nextZoom)
    this.updateOverlayScale()
  }

  /** Converte um ponto da tela (relativo ao elemento) para a cena. */
  toScene(screen: Point): Point {
    return this.world.toLocal(screen)
  }

  /** Texto que sobe e some sobre um token (dano, cura, resultado de teste). */
  floatText(tokenId: string, text: string, color: number): void {
    const item = this.items.get(tokenId)
    if (!item || !text) return
    const size = Math.max(18, (this.scene?.data.grid.size ?? 100) * 0.28)
    const label = new Text({ text, style: { fill: color, fontSize: size, fontFamily: "Segoe UI", fontWeight: "800", stroke: { color: 0x080707, width: Math.max(3, size * 0.18) } } })
    label.anchor.set(0.5, 1)
    label.position.set(item.display.x, item.display.y - item.display.height / 2)
    this.layers.overlay.addChild(label)
    const started = performance.now()
    const tick = () => {
      const progress = (performance.now() - started) / 1600
      if (progress >= 1 || label.destroyed) { this.app.ticker.remove(tick); if (!label.destroyed) label.destroy(); return }
      label.y -= 0.6
      label.alpha = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3
    }
    this.app.ticker.add(tick)
  }

  fitScene(): void {
    if (!this.scene) return
    const { width, height } = this.scene.data
    const scale = Math.min(this.app.screen.width / width, this.app.screen.height / height) * 0.92
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale))
    this.world.scale.set(zoom)
    this.world.position.set((this.app.screen.width - width * zoom) / 2, (this.app.screen.height - height * zoom) / 2)
    this.updateOverlayScale()
    this.handlers.onViewChange?.()
  }

  /** Move os tokens selecionados uma célula (setas do teclado). */
  nudgeSelection(columns: number, rows: number): void {
    const grid = this.scene?.data.grid
    if (!grid) return
    for (const id of this.selection) {
      const item = this.items.get(id)
      if (!item || this.isLocked(item) || item.kind === "wall") continue
      const data = item.document.data as { x: number; y: number }
      const step = grid.type === "none" ? 50 : grid.size
      let next = { x: data.x + columns * step, y: data.y + rows * step }
      if (item.kind === "token") next = snapTokenCenter(next, (data as TokenData).size, grid)
      this.handlers.onPut({ id, type: item.kind, parentId: item.document.parentId, data: { ...data, ...next } })
    }
  }

  deleteSelection(): void {
    if (this.selection.size === 0) return
    this.handlers.onRemove([...this.selection])
    this.selection.clear()
    this.handlers.onSelectionChange([])
  }

  /** Espelha na horizontal os tokens selecionados (tecla F). */
  flipSelection(): void {
    for (const id of this.selection) {
      const item = this.items.get(id)
      if (!item || item.kind !== "token") continue
      const data = item.document.data as TokenData
      this.handlers.onPut({ id, type: "token", parentId: item.document.parentId, data: { ...data, mirror: !data.mirror } })
    }
  }

  toggleHiddenSelection(): void {
    for (const id of this.selection) {
      const item = this.items.get(id)
      if (!item || item.kind === "wall") continue
      const data = item.document.data as { hidden: boolean }
      this.handlers.onPut({ id, type: item.kind, parentId: item.document.parentId, data: { ...data, hidden: !data.hidden } })
    }
  }

  cancel(): void {
    this.interaction = null
    this.clearOverlay()
    if (this.selection.size) {
      this.selection.clear()
      this.refreshSelection()
      this.handlers.onSelectionChange([])
    }
  }

  // ── Desenho ─────────────────────────────────────────────────────────────

  private drawBackground(scene: SceneData): void {
    const layer = this.layers.background
    layer.removeChildren().forEach((child) => child.destroy())
    layer.addChild(new Graphics().rect(0, 0, scene.width, scene.height).fill(hex(scene.backgroundColor)))
    if (scene.background) {
      const path = scene.background
      void this.texture(path).then((texture) => {
        if (this.destroyed || this.scene?.data.background !== path) return
        const sprite = new Sprite(texture)
        sprite.width = scene.width
        sprite.height = scene.height
        layer.addChild(sprite)
      }).catch(() => undefined)
    }
  }

  private drawGrid(scene: SceneData): void {
    const layer = this.layers.grid
    layer.mask = null
    layer.removeChildren().forEach((child) => child.destroy())
    const { grid, width, height } = scene
    if (grid.type === "none") return
    const lines = new Graphics()
    if (grid.type === "square") {
      const startX = grid.offsetX - Math.ceil(grid.offsetX / grid.size) * grid.size
      const startY = grid.offsetY - Math.ceil(grid.offsetY / grid.size) * grid.size
      for (let x = startX; x <= width; x += grid.size) if (x >= 0) lines.moveTo(x, 0).lineTo(x, height)
      for (let y = startY; y <= height; y += grid.size) if (y >= 0) lines.moveTo(0, y).lineTo(width, y)
    } else {
      for (const center of hexCentersIn(width, height, grid)) lines.poly(hexVertices(center, grid), true)
    }
    lines.stroke({ color: hex(grid.color), alpha: grid.alpha, width: 1, pixelLine: true })
    const mask = new Graphics().rect(0, 0, width, height).fill(0xffffff)
    layer.addChild(lines, mask)
    layer.mask = mask
  }

  private syncItems(children: SceneChildren): void {
    const grid = this.scene?.data.grid
    if (!grid) return
    const visible = (document: WorldDocument) => this.options.editable || !(document.data as { hidden?: boolean }).hidden
    const wanted = new Map<string, { kind: ItemKind; document: WorldDocument }>()
    for (const document of children.tiles.filter(visible)) wanted.set(document.id, { kind: "tile", document })
    for (const document of children.drawings.filter(visible)) wanted.set(document.id, { kind: "drawing", document })
    for (const document of children.tokens.filter(visible)) wanted.set(document.id, { kind: "token", document })
    for (const document of children.notes.filter(visible)) wanted.set(document.id, { kind: "note", document })
    // Paredes e luzes só existem na mesa: a Vista dos Jogadores recebe a visão pronta.
    if (this.options.editable) {
      for (const document of children.walls) wanted.set(document.id, { kind: "wall", document })
      for (const document of children.lights) wanted.set(document.id, { kind: "light", document })
      for (const document of children.sounds) wanted.set(document.id, { kind: "sound", document })
      for (const document of children.regions) wanted.set(document.id, { kind: "region", document })
      // O mestre mede com todo terreno difícil, visível aos jogadores ou não.
      this.terrain = children.regions.filter((region) => region.data.terrain.enabled).map((region) => ({ ...region.data, multiplier: region.data.terrain.multiplier }))
    }

    for (const [id, item] of this.items) {
      if (!wanted.has(id)) {
        item.display.destroy({ children: true })
        this.items.delete(id)
        this.selection.delete(id)
      }
    }
    for (const [id, { kind, document }] of wanted) {
      const key = JSON.stringify(document.data)
      const current = this.items.get(id)
      if (current && current.key === key) { current.document = document; continue }
      current?.display.destroy({ children: true })
      const built = this.build(kind, document, grid)
      const item: Item = { id, kind, document, key, ...built }
      this.items.set(id, item)
      this.layerFor(kind, document).addChild(built.display)
      if (this.options.editable) {
        built.display.eventMode = "static"
        built.display.cursor = "pointer"
        built.display.on("pointerdown", (event) => this.onItemPointerDown(event, id))
      } else if (kind === "token") {
        built.display.on("pointerdown", (event) => this.onItemPointerDown(event, id))
        this.applyMovable(item)
      }
    }
    this.refreshSelection()
  }

  private layerFor(kind: ItemKind, document: WorldDocument): Container {
    if (kind === "tile") return (document.data as TileData).layer === "above" ? this.layers.tilesAbove : this.layers.tilesBelow
    if (kind === "drawing") return this.layers.drawings
    if (kind === "note") return this.layers.notes
    if (kind === "wall") return this.layers.walls
    if (kind === "light") return this.layers.lights
    if (kind === "sound") return this.layers.sounds
    if (kind === "region") return this.layers.regions
    return this.layers.tokens
  }

  private build(kind: ItemKind, document: WorldDocument, grid: GridConfig): Built {
    if (kind === "wall") return this.buildWall(document.id, document.data as WallData)
    if (kind === "light") return this.buildLight(document.data as LightData, grid)
    if (kind === "sound") return this.buildSound(document.data as SoundData, grid)
    if (kind === "region") return this.buildRegion(document.data as RegionData)
    if (kind === "token") return this.buildToken(document.data as TokenData, grid)
    if (kind === "tile") return this.buildTile(document.data as TileData)
    if (kind === "drawing") return this.buildDrawing(document.data as DrawingData)
    return this.buildNote(document.data as NoteData, grid)
  }

  /**
   * Parede: a linha só aparece com a ferramenta Paredes; portas ganham um
   * ícone clicável sempre visível ao mestre, que abre e fecha a porta.
   */
  private buildWall(id: string, data: WallData): Built {
    const display = new Container()
    const line = new Graphics()
    const selection = new Graphics()
    display.addChild(selection, line)
    const midpoint = { x: (data.x1 + data.x2) / 2, y: (data.y1 + data.y2) / 2 }
    const icon = data.kind === "wall" ? null : this.doorIcon(id, data)
    if (icon) { icon.position.set(midpoint.x, midpoint.y); display.addChild(icon) }
    const color = WALL_COLORS[data.kind]
    const draw = () => {
      const zoom = this.world.scale.x
      const width = 3 / zoom
      line.visible = this.tool === "wall"
      line.clear()
        .moveTo(data.x1, data.y1).lineTo(data.x2, data.y2).stroke({ color: 0x080707, width: width * 2.4, alpha: 0.8 })
        .moveTo(data.x1, data.y1).lineTo(data.x2, data.y2).stroke({ color, width, alpha: data.open ? 0.4 : 1 })
        .circle(data.x1, data.y1, width * 1.3).fill(color)
        .circle(data.x2, data.y2, width * 1.3).fill(color)
      selection.clear().moveTo(data.x1, data.y1).lineTo(data.x2, data.y2).stroke({ color: SELECTION_COLOR, width: width * 4, alpha: 0.35 })
      icon?.scale.set(1 / zoom)
    }
    draw()
    // Área de clique: perto da linha (só na ferramenta Paredes) ou o ícone da porta.
    display.hitArea = {
      contains: (x: number, y: number) => {
        const zoom = this.world.scale.x
        if (icon && Math.hypot(x - midpoint.x, y - midpoint.y) <= 14 / zoom) return true
        return this.tool === "wall" && distanceToSegment({ x, y }, data) <= 8 / zoom
      },
    }
    return { display, selection, onZoom: draw }
  }

  private doorIcon(id: string, data: WallData): Container {
    const icon = new Container()
    const color = WALL_COLORS[data.kind]
    const graphics = new Graphics()
      .roundRect(-11, -11, 22, 22, 5).fill({ color: 0x171314, alpha: 0.92 }).stroke({ color, width: 1.5 })
    if (data.open) graphics.rect(-5, -7, 3, 14).fill(color).rect(-2, -7, 7, 14).stroke({ color, width: 1, alpha: 0.6 })
    else graphics.rect(-5, -7, 10, 14).fill({ color, alpha: 0.85 }).circle(2.5, 0, 1.3).fill(0x171314)
    icon.addChild(graphics)
    icon.eventMode = "static"
    icon.cursor = "pointer"
    icon.on("pointerdown", (event) => {
      if (event.button !== 0 || (this.tool !== "select" && this.tool !== "wall")) return
      event.stopPropagation()
      const item = this.items.get(id)
      if (!item) return
      const current = item.document.data as WallData
      this.handlers.onPut({ id, type: "wall", parentId: item.document.parentId, data: { ...current, open: !current.open } })
    })
    return icon
  }

  /** Luz: ícone e raios, só com a ferramenta Luzes (o efeito aparece sempre). */
  private buildLight(data: LightData, grid: GridConfig): Built {
    const cell = grid.type === "none" ? 100 : grid.size
    const display = new Container()
    display.position.set(data.x, data.y)
    const selection = new Graphics()
    const icon = new Graphics()
    display.addChild(selection, icon)
    const color = hex(data.color)
    const draw = () => {
      const zoom = this.world.scale.x
      icon.clear().circle(0, 0, 11).fill({ color: 0x171314, alpha: 0.92 }).stroke({ color, width: 2 }).circle(0, 0, 4.5).fill(color)
      for (let ray = 0; ray < 8; ray += 1) {
        const angle = (ray / 8) * Math.PI * 2
        icon.moveTo(Math.cos(angle) * 6.5, Math.sin(angle) * 6.5).lineTo(Math.cos(angle) * 9, Math.sin(angle) * 9)
      }
      icon.stroke({ color, width: 1.4 })
      icon.scale.set(1 / zoom)
      selection.clear()
        .circle(0, 0, data.dim * cell).stroke({ color, width: 2 / zoom, alpha: 0.6 })
        .circle(0, 0, data.bright * cell).stroke({ color, width: 2 / zoom, alpha: 0.9 })
    }
    draw()
    display.alpha = data.hidden ? 0.45 : 1
    display.hitArea = { contains: (x: number, y: number) => Math.hypot(x, y) <= 14 / this.world.scale.x }
    return { display, selection, onZoom: draw }
  }

  /**
   * Região: com a ferramenta Regiões, aparece inteira, com nome, e pode ser
   * arrastada; fora dela, só as visíveis aos jogadores aparecem, bem de leve.
   */
  private buildRegion(data: RegionData): Built {
    const display = new Container()
    display.position.set(data.x, data.y)
    const shape = new Graphics()
    const selection = new Graphics()
    const label = new Text({ text: data.name, style: { fill: 0xf3ece8, fontSize: 13, fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 3 } } })
    label.position.set(6, 4)
    display.addChild(shape, selection, label)
    const color = hex(data.color)
    const outline = (graphics: Graphics) => data.shape === "ellipse" ? graphics.ellipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2) : graphics.rect(0, 0, data.width, data.height)
    const draw = () => {
      const zoom = this.world.scale.x
      const editing = this.tool === "region"
      display.visible = editing || data.visible
      label.visible = editing
      label.scale.set(1 / zoom)
      shape.clear()
      outline(shape).fill({ color, alpha: editing ? (data.enabled ? 0.22 : 0.08) : 0.12 }).stroke({ color, width: (editing ? 2 : 1.5) / zoom, alpha: editing ? 0.95 : 0.5 })
      selection.clear()
      outline(selection).stroke({ color: SELECTION_COLOR, width: 3 / zoom, alpha: 0.9 })
    }
    draw()
    display.hitArea = { contains: (x: number, y: number) => this.tool === "region" && regionContains({ ...data, x: 0, y: 0 }, { x, y }) }
    return { display, selection, onZoom: draw }
  }

  private drawRegionPreview(from: Point, to: Point): void {
    const x = Math.min(from.x, to.x)
    const y = Math.min(from.y, to.y)
    const width = Math.abs(to.x - from.x)
    const height = Math.abs(to.y - from.y)
    const stroke = { color: 0x927f9c, width: 2 / this.world.scale.x }
    this.overlay.clear()
    if (this.regionShape === "ellipse") this.overlay.ellipse(x + width / 2, y + height / 2, width / 2, height / 2).fill({ color: 0x927f9c, alpha: 0.18 }).stroke(stroke)
    else this.overlay.rect(x, y, width, height).fill({ color: 0x927f9c, alpha: 0.18 }).stroke(stroke)
  }

  /** Encaixe dos cantos da região em meias células (Alt solta). */
  private snapHalfCell(point: Point, free: boolean): Point {
    const grid = this.scene?.data.grid
    if (free || !grid || grid.type !== "square") return point
    const step = grid.size / 2
    return { x: Math.round((point.x - grid.offsetX) / step) * step + grid.offsetX, y: Math.round((point.y - grid.offsetY) / step) * step + grid.offsetY }
  }

  /** Som do mapa: ícone e alcance, só com a ferramenta Sons (jogadores nunca recebem). */
  private buildSound(data: SoundData, grid: GridConfig): Built {
    const cell = grid.type === "none" ? 100 : grid.size
    const display = new Container()
    display.position.set(data.x, data.y)
    const range = new Graphics()
    const selection = new Graphics()
    const icon = new Graphics()
    display.addChild(range, selection, icon)
    const color = data.audio ? 0x82aaa6 : 0xb8aaa5
    const draw = () => {
      const zoom = this.world.scale.x
      icon.clear().circle(0, 0, 11).fill({ color: 0x171314, alpha: 0.92 }).stroke({ color, width: 2 })
        .poly([-6, -2.5, -3, -2.5, 1, -6, 1, 6, -3, 2.5, -6, 2.5], true).fill(color)
        .arc(1.5, 0, 4, -0.9, 0.9).stroke({ color, width: 1.4 })
        .arc(1.5, 0, 7, -0.9, 0.9).stroke({ color, width: 1.4 })
      icon.scale.set(1 / zoom)
      range.clear().circle(0, 0, data.radius * cell).fill({ color, alpha: 0.06 }).stroke({ color, width: 1.5 / zoom, alpha: 0.5 })
      selection.clear().circle(0, 0, data.radius * cell).stroke({ color: SELECTION_COLOR, width: 2.5 / zoom, alpha: 0.8 })
    }
    draw()
    display.alpha = data.hidden ? 0.45 : 1
    display.hitArea = { contains: (x: number, y: number) => Math.hypot(x, y) <= 14 / this.world.scale.x }
    return { display, selection, onZoom: draw }
  }

  private buildToken(data: TokenData, grid: GridConfig): { display: Container; selection: Graphics } {
    const size = data.size * (grid.type === "none" ? 100 : grid.size)
    const radius = size / 2
    const display = new Container()
    display.position.set(data.x, data.y)
    const color = DISPOSITION_COLORS[data.disposition]
    const body = new Container()
    body.angle = data.rotation
    const corner = Math.max(4, size * 0.1)
    const addFallback = () => {
      if (body.children.length) return
      body.addChild(new Graphics().roundRect(-radius, -radius, size, size, corner).fill({ color: 0x171314 }).stroke({ color, width: Math.max(1.2, size * 0.021) }))
      const initial = new Text({ text: (data.name.trim()[0] ?? "?").toUpperCase(), style: { fill: color, fontSize: size * 0.42, fontFamily: "Segoe UI", fontWeight: "700" } })
      initial.anchor.set(0.5)
      body.addChild(initial)
    }
    if (data.image) {
      const path = data.image
      // A textura já contém apenas a silhueta opaca da imagem e a moldura
      // colorida dilatada a partir do canal alpha. Não há fundo quadrado por
      // trás: PNG/WebP transparente continua transparente no canvas.
      void this.tokenTexture(path, color).then((texture) => {
        if (this.destroyed || display.destroyed) return
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5)
        const scale = Math.min(size / texture.width, size / texture.height)
        sprite.scale.set(data.mirror ? -scale : scale, scale)
        body.addChild(sprite)
      }).catch(() => addFallback())
    } else addFallback()
    display.addChild(body)

    const barWidth = size * 0.9
    const barHeight = Math.max(4, size * 0.06)
    data.bars.forEach((bar, index) => {
      const ratio = bar.max > 0 ? Math.max(0, Math.min(1, bar.value / bar.max)) : 0
      const y = -radius - (index + 1) * (barHeight + 2)
      display.addChild(new Graphics()
        .rect(-barWidth / 2, y, barWidth, barHeight).fill({ color: 0x080707, alpha: 0.85 })
        .rect(-barWidth / 2, y, barWidth * ratio, barHeight).fill(hex(bar.color)))
    })

    if (data.showName && data.name) {
      const name = new Text({ text: data.name, style: { fill: 0xf3ece8, fontSize: Math.max(12, size * 0.16), fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 4 } } })
      name.anchor.set(0.5, 0)
      name.position.set(0, radius + 3)
      display.addChild(name)
    }
    // Tokens não ganham moldura de seleção: a borda da disposição já contorna
    // a silhueta, e o painel de propriedades mostra qual está selecionado.
    const selection = new Graphics()
    display.addChild(selection)
    display.alpha = data.hidden ? 0.45 : 1
    display.hitArea = new Rectangle(-radius, -radius, size, size)
    return { display, selection }
  }

  private buildTile(data: TileData): { display: Container; selection: Graphics } {
    const display = new Container()
    display.position.set(data.x + data.width / 2, data.y + data.height / 2)
    display.angle = data.rotation
    display.addChild(new Graphics().rect(-data.width / 2, -data.height / 2, data.width, data.height).fill({ color: 0x21191a, alpha: data.image ? 0.001 : 0.6 }))
    if (data.image) {
      const path = data.image
      void this.texture(path).then((texture) => {
        if (this.destroyed || display.destroyed) return
        const sprite = new Sprite(texture)
        sprite.anchor.set(0.5)
        sprite.width = data.width
        sprite.height = data.height
        display.addChildAt(sprite, 1)
      }).catch(() => undefined)
    }
    const selection = new Graphics().rect(-data.width / 2 - 3, -data.height / 2 - 3, data.width + 6, data.height + 6).stroke({ color: SELECTION_COLOR, width: 3 })
    display.addChild(selection)
    display.alpha = data.hidden ? Math.min(0.45, data.alpha) : data.alpha
    display.hitArea = new Rectangle(-data.width / 2, -data.height / 2, data.width, data.height)
    return { display, selection }
  }

  private buildDrawing(data: DrawingData): { display: Container; selection: Graphics } {
    const display = new Container()
    display.position.set(data.x, data.y)
    const stroke = { color: hex(data.strokeColor), width: data.strokeWidth, alpha: data.strokeWidth > 0 ? 1 : 0 }
    const fill = { color: hex(data.fillColor), alpha: data.fillAlpha }
    let width = data.width
    let height = data.height
    if (data.shape === "text") {
      const text = new Text({ text: data.text || "Texto", style: { fill: hex(data.strokeColor), fontSize: data.fontSize, fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: Math.max(2, data.fontSize * 0.12) } } })
      display.addChild(text)
      width = text.width
      height = text.height
    } else {
      const shape = new Graphics()
      if (data.shape === "rectangle") shape.rect(0, 0, data.width, data.height).fill(fill).stroke(stroke)
      else if (data.shape === "ellipse") shape.ellipse(data.width / 2, data.height / 2, data.width / 2, data.height / 2).fill(fill).stroke(stroke)
      else if (data.points.length >= 4) {
        shape.moveTo(data.points[0]!, data.points[1]!)
        for (let index = 2; index < data.points.length; index += 2) shape.lineTo(data.points[index]!, data.points[index + 1]!)
        shape.stroke({ ...stroke, cap: "round", join: "round" })
      }
      display.addChild(shape)
    }
    const selection = new Graphics().rect(-4, -4, width + 8, height + 8).stroke({ color: SELECTION_COLOR, width: 2 })
    display.addChild(selection)
    display.alpha = data.hidden ? 0.45 : 1
    display.hitArea = new Rectangle(-4, -4, width + 8, height + 8)
    return { display, selection }
  }

  private buildNote(data: NoteData, grid: GridConfig): { display: Container; selection: Graphics } {
    const radius = Math.max(14, (grid.type === "none" ? 100 : grid.size) * 0.22)
    const display = new Container()
    display.position.set(data.x, data.y)
    display.addChild(new Graphics().circle(0, 0, radius).fill({ color: 0x080707, alpha: 0.85 }).stroke({ color: hex(data.color), width: 3 }).circle(0, 0, radius * 0.35).fill(hex(data.color)))
    if (data.label) {
      const label = new Text({ text: data.label, style: { fill: 0xf3ece8, fontSize: Math.max(12, radius * 0.75), fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 4 } } })
      label.anchor.set(0.5, 0)
      label.position.set(0, radius + 4)
      display.addChild(label)
    }
    const selection = new Graphics().circle(0, 0, radius + 5).stroke({ color: SELECTION_COLOR, width: 3 })
    display.addChild(selection)
    display.alpha = data.hidden ? 0.45 : 1
    display.hitArea = new Rectangle(-radius, -radius, radius * 2, radius * 2)
    return { display, selection }
  }

  private texture(path: string): Promise<Texture> {
    let pending = this.textures.get(path)
    if (!pending) {
      pending = this.image(path).then((image) => Texture.from(image))
      this.textures.set(path, pending)
      pending.catch(() => this.textures.delete(path))
    }
    return pending
  }

  private image(path: string): Promise<HTMLImageElement> {
    let pending = this.images.get(path)
    if (!pending) {
      pending = (async () => {
        const image = new Image()
        // Sem isto o WebGL recusa a imagem de `vtt-asset://` (outra origem).
        image.crossOrigin = "anonymous"
        image.src = resolveAssetUrl(path)
        await image.decode()
        return image
      })()
      this.images.set(path, pending)
      pending.catch(() => this.images.delete(path))
    }
    return pending
  }

  private tokenTexture(path: string, color: number): Promise<Texture> {
    const key = `${path}|${color}`
    let pending = this.tokenTextures.get(key)
    if (!pending) {
      pending = this.image(path).then((image) => this.makeSilhouetteTexture(image, color))
      this.tokenTextures.set(key, pending)
      pending.catch(() => this.tokenTextures.delete(key))
    }
    return pending
  }

  /** Cria uma textura transparente com uma borda obtida do canal alpha. */
  private makeSilhouetteTexture(image: HTMLImageElement, color: number): Texture {
    const naturalWidth = image.naturalWidth || image.width
    const naturalHeight = image.naturalHeight || image.height
    if (!naturalWidth || !naturalHeight) throw new Error("A imagem do token não tem dimensões.")

    // Limita o trabalho de imagens enormes sem mudar a proporção exibida.
    const sourceScale = Math.min(1, 1024 / Math.max(naturalWidth, naturalHeight))
    const width = Math.max(1, Math.round(naturalWidth * sourceScale))
    const height = Math.max(1, Math.round(naturalHeight * sourceScale))
    const border = Math.max(1, Math.round(Math.min(width, height) * 0.024))
    const padding = border + 1

    const source = document.createElement("canvas")
    source.width = width
    source.height = height
    const sourceContext = source.getContext("2d")
    if (!sourceContext) throw new Error("Não foi possível preparar a imagem do token.")
    sourceContext.drawImage(image, 0, 0, width, height)

    // A união de cópias deslocadas é uma dilatação do alpha. Ao colorir essa
    // máscara e desenhar a imagem original por cima, a moldura acompanha a
    // silhueta, inclusive nos recortes transparentes do retrato.
    const mask = document.createElement("canvas")
    mask.width = width + padding * 2
    mask.height = height + padding * 2
    const maskContext = mask.getContext("2d")
    if (!maskContext) throw new Error("Não foi possível preparar a moldura do token.")
    for (let y = -border; y <= border; y += 1) {
      for (let x = -border; x <= border; x += 1) {
        if (x * x + y * y > border * border) continue
        maskContext.drawImage(source, padding + x, padding + y)
      }
    }

    const output = document.createElement("canvas")
    output.width = mask.width
    output.height = mask.height
    const outputContext = output.getContext("2d")
    if (!outputContext) throw new Error("Não foi possível renderizar a moldura do token.")
    outputContext.drawImage(mask, 0, 0)
    outputContext.globalCompositeOperation = "source-in"
    outputContext.fillStyle = `#${color.toString(16).padStart(6, "0")}`
    outputContext.fillRect(0, 0, output.width, output.height)
    outputContext.globalCompositeOperation = "source-over"
    outputContext.drawImage(source, padding, padding)
    return Texture.from(output)
  }

  private refreshSelection(): void {
    for (const item of this.items.values()) item.selection.visible = this.options.editable && this.selection.has(item.id)
    this.updateWallHandles()
  }

  /** Alças para arrastar as pontas da parede selecionada (ferramenta Paredes). */
  private updateWallHandles(): void {
    this.wallHandles.removeChildren().forEach((child) => child.destroy())
    if (this.tool !== "wall" || this.selection.size !== 1) return
    const item = this.items.get([...this.selection][0]!)
    if (!item || item.kind !== "wall") return
    const data = item.document.data as WallData
    const zoom = this.world.scale.x
    for (const end of [1, 2] as const) {
      const point = end === 1 ? { x: data.x1, y: data.y1 } : { x: data.x2, y: data.y2 }
      const fixed = end === 1 ? { x: data.x2, y: data.y2 } : { x: data.x1, y: data.y1 }
      const handle = new Graphics().circle(0, 0, 7).fill({ color: 0x171314 }).stroke({ color: SELECTION_COLOR, width: 2 })
      handle.position.set(point.x, point.y)
      handle.scale.set(1 / zoom)
      handle.eventMode = "static"
      handle.cursor = "move"
      handle.on("pointerdown", (event) => {
        if (event.button !== 0) return
        event.stopPropagation()
        this.interaction = { type: "wall-end", id: item.id, end, fixed }
      })
      this.wallHandles.addChild(handle)
    }
  }

  /**
   * Encaixe das pontas de parede: primeiro nas pontas existentes (para
   * emendar paredes), depois em cantos e meios de célula. Alt desliga.
   */
  private snapWallPoint(point: Point, free: boolean, ignoreId?: string): Point {
    if (free) return point
    let best: Point | null = null
    let bestDistance = 12 / this.world.scale.x
    for (const item of this.items.values()) {
      if (item.kind !== "wall" || item.id === ignoreId) continue
      const wall = item.document.data as WallData
      for (const end of [{ x: wall.x1, y: wall.y1 }, { x: wall.x2, y: wall.y2 }]) {
        const distance = Math.hypot(end.x - point.x, end.y - point.y)
        if (distance < bestDistance) { best = end; bestDistance = distance }
      }
    }
    if (best) return { ...best }
    const grid = this.scene?.data.grid
    if (!grid || grid.type !== "square") return point
    const step = grid.size / 2
    return { x: Math.round((point.x - grid.offsetX) / step) * step + grid.offsetX, y: Math.round((point.y - grid.offsetY) / step) * step + grid.offsetY }
  }

  private drawWallPreview(from: Point, to: Point): void {
    const width = 3 / this.world.scale.x
    this.overlay.clear()
      .moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: 0x080707, width: width * 2.4, alpha: 0.8 })
      .moveTo(from.x, from.y).lineTo(to.x, to.y).stroke({ color: WALL_COLORS[this.wallKind], width })
      .circle(from.x, from.y, width * 1.6).fill(WALL_COLORS[this.wallKind])
      .circle(to.x, to.y, width * 1.6).fill(WALL_COLORS[this.wallKind])
  }

  private clearOverlay(): void {
    this.overlay.clear()
    this.rulerLabel.visible = false
    this.handlers.onStatus?.("")
    if (this.rulerPublished) {
      this.rulerPublished = false
      this.handlers.onRulerChange?.(null)
    }
  }

  private updateOverlayScale(): void {
    this.rulerLabel.scale.set(1 / this.world.scale.x)
    if (this.remoteRuler) this.drawRemoteRuler()
    for (const item of this.items.values()) item.onZoom?.()
    for (const handle of this.wallHandles.children) handle.scale.set(1 / this.world.scale.x)
  }

  /** Desenha uma régua e devolve o texto da medida. */
  private paintRuler(graphics: Graphics, label: Text, from: Point, to: Point, color: number): string | null {
    const grid = this.scene?.data.grid
    if (!grid) return null
    const start = grid.type === "none" ? from : cellCenter(from, grid)
    const end = grid.type === "none" ? to : cellCenter(to, grid)
    const width = 3 / this.world.scale.x
    graphics.clear()
      .moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ color: 0x080707, width: width * 2.5, alpha: 0.7 })
      .moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ color, width })
      .circle(start.x, start.y, width * 2).fill(color)
      .circle(end.x, end.y, width * 2).fill(color)
    const { distance, cells, difficult } = measureWithTerrain(start, end, grid, this.terrain)
    const base = grid.type === "none" ? `${formatNumber(distance)} ${grid.units}` : `${formatNumber(distance)} ${grid.units} · ${formatNumber(cells)} ${cells === 1 ? "célula" : "células"}`
    const text = difficult ? `${base} · terreno difícil` : base
    label.text = text
    label.position.set(end.x, end.y)
    label.scale.set(1 / this.world.scale.x)
    label.visible = true
    return text
  }

  /** `publish`: régua da ferramenta Régua do mestre, repassada aos jogadores. */
  private drawRuler(from: Point, to: Point, publish = false): void {
    const text = this.paintRuler(this.overlay, this.rulerLabel, from, to, 0x82aaa6)
    if (text === null) return
    this.handlers.onStatus?.(text)
    if (publish && this.scene) {
      this.rulerPublished = true
      this.handlers.onRulerChange?.({ sceneId: this.scene.id, from, to })
    }
  }

  private drawRemoteRuler(): void {
    const ruler = this.remoteRuler
    if (!ruler || ruler.sceneId !== this.scene?.id) {
      this.remoteOverlay.clear()
      this.remoteRulerLabel.visible = false
      return
    }
    this.paintRuler(this.remoteOverlay, this.remoteRulerLabel, ruler.from, ruler.to, 0xb99b65)
  }

  private panTick(deltaMS: number): void {
    const { x, y } = this.panVelocity
    if ((x === 0 && y === 0) || !this.scene) return
    const length = Math.hypot(x, y)
    const step = (this.panSpeed * Math.min(deltaMS, 100)) / 1000
    this.world.position.set(this.world.x - (x / length) * step, this.world.y - (y / length) * step)
    this.handlers.onViewChange?.()
  }

  private zoomAt(screen: Point, factor: number): void {
    const before = this.world.toLocal(screen)
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.world.scale.x * factor))
    this.world.scale.set(zoom)
    const after = this.world.toGlobal(before)
    this.world.position.set(this.world.position.x + screen.x - after.x, this.world.position.y + screen.y - after.y)
    this.updateOverlayScale()
    this.handlers.onViewChange?.()
  }

  /** O segundo dedo tocou: cancela o gesto de um dedo (sem mover nada) e começa a pinça. */
  private startPinch(first: Point, second: Point): void {
    const interaction = this.interaction
    this.interaction = null
    if (interaction?.type === "drag") for (const entry of interaction.entries) this.items.get(entry.id)?.display.position.set(entry.start.x, entry.start.y)
    if (interaction && interaction.type !== "pan") this.clearOverlay()
    const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    this.pinch = { zoom: this.world.scale.x, distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)), anchor: this.world.toLocal(middle) }
  }

  /** Aproxima pela distância entre os dedos e mantém sob eles o mesmo ponto do mapa (zoom e movimento juntos). */
  private movePinch(first: Point, second: Point): void {
    const pinch = this.pinch
    if (!pinch) return
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinch.zoom * Math.hypot(second.x - first.x, second.y - first.y) / pinch.distance))
    const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    this.world.scale.set(zoom)
    this.world.position.set(middle.x - pinch.anchor.x * zoom, middle.y - pinch.anchor.y * zoom)
    this.updateOverlayScale()
  }

  // ── Interação ───────────────────────────────────────────────────────────

  private isLocked(item: Item): boolean {
    return Boolean((item.document.data as { locked?: boolean }).locked)
  }

  private emitSelection(): void {
    this.refreshSelection()
    this.handlers.onSelectionChange([...this.selection])
  }

  private onItemPointerDown(event: FederatedPointerEvent, id: string): void {
    const item = this.items.get(id)
    if (this.pinch || event.button !== 0 || !item || TOOL_FOR_KIND[item.kind] !== this.tool) return
    // Espectador: só arrasta tokens "Jogador", e um de cada vez.
    if (!this.options.editable) {
      if (!this.movable(item.document)) return
      event.stopPropagation()
      this.interaction = { type: "drag", origin: this.world.toLocal(event.global), moved: false, entries: [{ id, start: { x: item.display.x, y: item.display.y } }], selection: new Set() }
      return
    }
    if (item.kind === "wall") {
      // Clicar na ponta de uma parede começa outra parede emendada ali, em vez de arrastar esta.
      const wall = item.document.data as WallData
      const point = this.world.toLocal(event.global)
      const tolerance = 12 / this.world.scale.x
      if (Math.hypot(point.x - wall.x1, point.y - wall.y1) <= tolerance || Math.hypot(point.x - wall.x2, point.y - wall.y2) <= tolerance) return
    }
    event.stopPropagation()
    const now = performance.now()
    const isDoubleClick = this.lastClick.id === id && now - this.lastClick.at < 350
    this.lastClick = { id, at: now }
    if (isDoubleClick && item.kind === "note") { this.handlers.onOpenNote(item.document.data as NoteData); return }

    const nextSelection = new Set(this.selection)
    if (event.shiftKey) {
      if (nextSelection.has(id)) nextSelection.delete(id)
      else nextSelection.add(id)
    } else if (!nextSelection.has(id)) {
      nextSelection.clear()
      nextSelection.add(id)
    }
    const entries = [...nextSelection]
      .map((selectedId) => this.items.get(selectedId))
      .filter((selected): selected is Item => Boolean(selected) && !this.isLocked(selected!))
      .map((selected) => ({ id: selected.id, start: { x: selected.display.x, y: selected.display.y } }))
    // Mesmo sem itens móveis (por exemplo, ao clicar num token bloqueado),
    // mantemos a interação para publicar a seleção somente ao soltar.
    this.interaction = { type: "drag", origin: this.world.toLocal(event.global), moved: false, entries, selection: nextSelection }
  }

  private onStagePointerDown(event: FederatedPointerEvent): void {
    if (this.pinch) return
    if (event.button === 1 || event.button === 2) {
      this.interaction = { type: "pan", startGlobal: { x: event.global.x, y: event.global.y }, startPosition: { x: this.world.x, y: this.world.y } }
      this.app.canvas.style.cursor = "grabbing"
      return
    }
    if (event.button !== 0 || !this.scene) return
    const point = this.world.toLocal(event.global)
    if (!this.options.editable) {
      // Espectador: régua local ou arrastar o mapa com o botão esquerdo.
      if (this.tool === "ruler") { this.interaction = { type: "ruler", start: point }; this.drawRuler(point, point); return }
      this.interaction = { type: "pan", startGlobal: { x: event.global.x, y: event.global.y }, startPosition: { x: this.world.x, y: this.world.y } }
      this.app.canvas.style.cursor = "grabbing"
      return
    }
    const grid = this.scene.data.grid
    const parentId = this.scene.id
    switch (this.tool) {
      case "select":
        if (!event.shiftKey && this.selection.size) { this.selection.clear(); this.emitSelection() }
        this.interaction = { type: "box", start: point }
        break
      case "ruler":
        this.interaction = { type: "ruler", start: point }
        this.drawRuler(point, point, true)
        break
      case "token": {
        const id = crypto.randomUUID().replaceAll("-", "")
        const center = snapTokenCenter(point, 1, grid)
        this.handlers.onPut({ id, type: "token", parentId, data: { name: "Token", x: center.x, y: center.y, size: 1, disposition: "hostile" } })
        this.pendingSelection = id
        break
      }
      case "note": {
        const id = crypto.randomUUID().replaceAll("-", "")
        const center = grid.type === "none" ? point : cellCenter(point, grid)
        this.handlers.onPut({ id, type: "note", parentId, data: { x: center.x, y: center.y, label: "Nota" } })
        this.pendingSelection = id
        break
      }
      case "wall":
        this.interaction = { type: "wall", start: this.snapWallPoint(point, event.altKey) }
        break
      case "region":
        this.interaction = { type: "region", start: this.snapHalfCell(point, event.altKey) }
        break
      case "sound": {
        const id = crypto.randomUUID().replaceAll("-", "")
        const center = event.altKey || grid.type === "none" ? point : cellCenter(point, grid)
        this.handlers.onPut({ id, type: "sound", parentId, data: { x: center.x, y: center.y } })
        this.pendingSelection = id
        break
      }
      case "light": {
        const id = crypto.randomUUID().replaceAll("-", "")
        const center = event.altKey || grid.type === "none" ? point : cellCenter(point, grid)
        this.handlers.onPut({ id, type: "light", parentId, data: { x: center.x, y: center.y } })
        this.pendingSelection = id
        break
      }
      case "draw":
        if (this.drawOptions.shape === "text") {
          const id = crypto.randomUUID().replaceAll("-", "")
          this.handlers.onPut({ id, type: "drawing", parentId, data: { ...this.drawOptions, shape: "text", x: point.x, y: point.y, text: "Texto" } })
          this.pendingSelection = id
          break
        }
        this.interaction = { type: "draw", start: point, points: [0, 0] }
        break
    }
  }

  /** Objeto recém-criado a selecionar assim que chegar do processo principal. */
  private pendingSelection: string | null = null

  /** Chamado depois de cada `setScene`: seleciona o objeto criado pela ferramenta. */
  consumePendingSelection(): string | null {
    const id = this.pendingSelection
    if (!id || !this.items.has(id)) return null
    this.pendingSelection = null
    this.selection = new Set([id])
    this.emitSelection()
    return id
  }

  private onPointerMove(event: FederatedPointerEvent): void {
    const interaction = this.interaction
    if (!interaction) return
    if (interaction.type === "pan") {
      this.world.position.set(interaction.startPosition.x + event.global.x - interaction.startGlobal.x, interaction.startPosition.y + event.global.y - interaction.startGlobal.y)
      return
    }
    const point = this.world.toLocal(event.global)
    if (interaction.type === "drag") {
      const dx = point.x - interaction.origin.x
      const dy = point.y - interaction.origin.y
      if (!interaction.moved && Math.hypot(dx, dy) * this.world.scale.x < 4) return
      interaction.moved = true
      for (const entry of interaction.entries) this.items.get(entry.id)?.display.position.set(entry.start.x + dx, entry.start.y + dy)
      const first = interaction.entries[0]
      const firstItem = first ? this.items.get(first.id) : null
      if (first && firstItem?.kind === "token" && interaction.entries.length === 1) this.drawRuler(first.start, { x: first.start.x + dx, y: first.start.y + dy })
      return
    }
    if (interaction.type === "ruler") { this.drawRuler(interaction.start, point, this.options.editable); return }
    if (interaction.type === "wall") { this.drawWallPreview(interaction.start, this.snapWallPoint(point, event.altKey)); return }
    if (interaction.type === "region") { this.drawRegionPreview(interaction.start, this.snapHalfCell(point, event.altKey)); return }
    if (interaction.type === "wall-end") { this.drawWallPreview(interaction.fixed, this.snapWallPoint(point, event.altKey, interaction.id)); return }
    if (interaction.type === "box") {
      const width = 1.5 / this.world.scale.x
      this.overlay.clear().rect(Math.min(interaction.start.x, point.x), Math.min(interaction.start.y, point.y), Math.abs(point.x - interaction.start.x), Math.abs(point.y - interaction.start.y)).fill({ color: 0x82aaa6, alpha: 0.08 }).stroke({ color: 0x82aaa6, width })
      return
    }
    if (interaction.type === "draw") {
      const { start } = interaction
      const options = this.drawOptions
      const stroke = { color: hex(options.strokeColor), width: Math.max(options.strokeWidth, 1 / this.world.scale.x) }
      const fill = { color: hex(options.fillColor), alpha: options.fillAlpha }
      this.overlay.clear()
      if (options.shape === "freehand") {
        const last = interaction.points.slice(-2)
        const relative = { x: point.x - start.x, y: point.y - start.y }
        if (Math.hypot(relative.x - (last[0] ?? 0), relative.y - (last[1] ?? 0)) * this.world.scale.x > 3) interaction.points.push(relative.x, relative.y)
        this.overlay.moveTo(start.x, start.y)
        for (let index = 2; index < interaction.points.length; index += 2) this.overlay.lineTo(start.x + interaction.points[index]!, start.y + interaction.points[index + 1]!)
        this.overlay.stroke({ ...stroke, cap: "round", join: "round" })
      } else {
        const x = Math.min(start.x, point.x)
        const y = Math.min(start.y, point.y)
        const width = Math.abs(point.x - start.x)
        const height = Math.abs(point.y - start.y)
        if (options.shape === "ellipse") this.overlay.ellipse(x + width / 2, y + height / 2, width / 2, height / 2).fill(fill).stroke(stroke)
        else this.overlay.rect(x, y, width, height).fill(fill).stroke(stroke)
      }
    }
  }

  private onPointerUp(event: FederatedPointerEvent): void {
    const interaction = this.interaction
    this.interaction = null
    if (!interaction) return
    if (interaction.type === "pan") { this.setTool(this.tool); this.handlers.onViewChange?.(); return }
    const scene = this.scene
    if (!scene) return
    const point = this.world.toLocal(event.global)
    if (interaction.type === "drag" && !this.options.editable) {
      this.clearOverlay()
      const entry = interaction.entries[0]
      const item = entry ? this.items.get(entry.id) : null
      if (!interaction.moved || !item) return
      const data = item.document.data as TokenData
      const position = event.altKey ? { x: item.display.x, y: item.display.y } : snapTokenCenter({ x: item.display.x, y: item.display.y }, data.size, scene.data.grid)
      item.display.position.set(position.x, position.y)
      this.handlers.onMove?.(item.id, position)
      return
    }
    if (interaction.type === "drag") {
      this.clearOverlay()
      if (!interaction.moved) {
        this.selection = new Set([...interaction.selection].filter((id) => this.items.has(id)))
        this.emitSelection()
        return
      }
      for (const entry of interaction.entries) {
        const item = this.items.get(entry.id)
        if (!item) continue
        const moved = { x: item.display.x, y: item.display.y }
        const data = item.document.data as Record<string, unknown>
        let position: Point
        if (item.kind === "wall") {
          // A parede inteira anda; o deslocamento encaixa em meias células.
          const grid = scene.data.grid
          const step = grid.type === "square" && !event.altKey ? grid.size / 2 : 0
          const dx = step ? Math.round(moved.x / step) * step : moved.x
          const dy = step ? Math.round(moved.y / step) * step : moved.y
          const wall = data as unknown as WallData
          this.handlers.onPut({ id: item.id, type: "wall", parentId: item.document.parentId, data: { ...wall, x1: wall.x1 + dx, y1: wall.y1 + dy, x2: wall.x2 + dx, y2: wall.y2 + dy } })
          continue
        }
        if (item.kind === "token") position = event.altKey ? moved : snapTokenCenter(moved, (data as unknown as TokenData).size, scene.data.grid)
        else if (item.kind === "tile") position = { x: moved.x - (data.width as number) / 2, y: moved.y - (data.height as number) / 2 }
        else position = moved
        this.handlers.onPut({ id: item.id, type: item.kind, parentId: item.document.parentId, data: { ...data, ...position } })
      }
      this.selection = new Set([...interaction.selection].filter((id) => this.items.has(id)))
      // Arrastar reposiciona e destaca o token localmente, mas não publica a
      // seleção. A ficha só deve abrir no clique sem movimento, ao soltar.
      this.refreshSelection()
      return
    }
    if (interaction.type === "wall") {
      this.overlay.clear()
      const end = this.snapWallPoint(point, event.altKey)
      if (Math.hypot(end.x - interaction.start.x, end.y - interaction.start.y) * this.world.scale.x < 4) return
      const id = crypto.randomUUID().replaceAll("-", "")
      this.handlers.onPut({ id, type: "wall", parentId: scene.id, data: { x1: interaction.start.x, y1: interaction.start.y, x2: end.x, y2: end.y, kind: this.wallKind } })
      return
    }
    if (interaction.type === "region") {
      this.overlay.clear()
      const end = this.snapHalfCell(point, event.altKey)
      const width = Math.abs(end.x - interaction.start.x)
      const height = Math.abs(end.y - interaction.start.y)
      if (width * this.world.scale.x < 6 || height * this.world.scale.x < 6) return
      const id = crypto.randomUUID().replaceAll("-", "")
      this.handlers.onPut({ id, type: "region", parentId: scene.id, data: { name: "Região", shape: this.regionShape, x: Math.min(interaction.start.x, end.x), y: Math.min(interaction.start.y, end.y), width, height } })
      this.pendingSelection = id
      return
    }
    if (interaction.type === "wall-end") {
      this.overlay.clear()
      const item = this.items.get(interaction.id)
      if (!item) return
      const end = this.snapWallPoint(point, event.altKey, interaction.id)
      const wall = item.document.data as WallData
      const next = interaction.end === 1 ? { ...wall, x1: end.x, y1: end.y } : { ...wall, x2: end.x, y2: end.y }
      this.handlers.onPut({ id: item.id, type: "wall", parentId: item.document.parentId, data: next })
      return
    }
    if (interaction.type === "box") {
      this.clearOverlay()
      const left = Math.min(interaction.start.x, point.x)
      const right = Math.max(interaction.start.x, point.x)
      const top = Math.min(interaction.start.y, point.y)
      const bottom = Math.max(interaction.start.y, point.y)
      if ((right - left) * this.world.scale.x < 4 && (bottom - top) * this.world.scale.x < 4) return
      for (const item of this.items.values()) {
        if (TOOL_FOR_KIND[item.kind] !== "select") continue
        const bounds = item.display.getBounds()
        const center = this.world.toLocal({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
        if (center.x >= left && center.x <= right && center.y >= top && center.y <= bottom) this.selection.add(item.id)
      }
      this.emitSelection()
      return
    }
    if (interaction.type === "draw") {
      this.overlay.clear()
      const options = this.drawOptions
      const id = crypto.randomUUID().replaceAll("-", "")
      if (options.shape === "freehand") {
        const xs = interaction.points.filter((_, index) => index % 2 === 0)
        const ys = interaction.points.filter((_, index) => index % 2 === 1)
        const minX = Math.min(...xs)
        const minY = Math.min(...ys)
        if (interaction.points.length < 6) return
        const points = interaction.points.map((value, index) => value - (index % 2 === 0 ? minX : minY))
        this.handlers.onPut({ id, type: "drawing", parentId: scene.id, data: { ...options, x: interaction.start.x + minX, y: interaction.start.y + minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY, points } })
      } else {
        const width = Math.abs(point.x - interaction.start.x)
        const height = Math.abs(point.y - interaction.start.y)
        if (width * this.world.scale.x < 4 && height * this.world.scale.x < 4) return
        this.handlers.onPut({ id, type: "drawing", parentId: scene.id, data: { ...options, x: Math.min(interaction.start.x, point.x), y: Math.min(interaction.start.y, point.y), width, height } })
      }
      this.pendingSelection = id
    }
  }
}
