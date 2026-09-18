// O PixiJS gera shaders com `new Function` por padrão; este módulo oficial
// troca isso por código pré-compilado, e a CSP da interface continua sem unsafe-eval.
import "pixi.js/unsafe-eval"
import { Application, Container, Graphics, Rectangle, Sprite, Text, Texture, type FederatedPointerEvent } from "pixi.js"
import type { DocumentInput } from "../../../shared/ipc"
import { cellCenter, cellDistance, hexCentersIn, hexVertices, measure, snapTokenCenter, type GridConfig, type Point } from "../../../shared/grid"
import type { DrawingData, DrawingShape, NoteData, SceneData, TileData, TokenData, TokenDisposition } from "../../../shared/scene"
import type { WorldDocument } from "../../../shared/world"
import type { SceneChildren } from "../document-store"
import { resolveAssetUrl } from "../api"

export type SceneTool = "select" | "ruler" | "token" | "note" | "draw"

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
}

export interface SceneViewOptions {
  /** `false` na Vista dos Jogadores: sem edição e sem objetos ocultos. */
  editable: boolean
}

type ItemKind = "token" | "tile" | "drawing" | "note"

interface Item {
  id: string
  kind: ItemKind
  document: WorldDocument
  display: Container
  selection: Graphics
  key: string
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

const DISPOSITION_COLORS: Record<TokenDisposition, number> = { friendly: 0x82aaa6, neutral: 0xb99b65, hostile: 0xc76561, secret: 0x927f9c }
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
    tokens: new Container(),
    tilesAbove: new Container(),
    notes: new Container(),
    overlay: new Container(),
  }
  private readonly overlay = new Graphics()
  private readonly rulerLabel = new Text({ text: "", style: { fill: 0xf3ece8, fontSize: 15, fontFamily: "Segoe UI", fontWeight: "600", stroke: { color: 0x080707, width: 4 } } })
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
  private destroyed = false

  private constructor(private readonly app: Application, private readonly container: HTMLElement, private readonly handlers: SceneViewHandlers, private readonly options: SceneViewOptions) {
    app.stage.addChild(this.world)
    for (const layer of Object.values(this.layers)) this.world.addChild(layer)
    this.layers.overlay.addChild(this.overlay, this.rulerLabel)
    this.rulerLabel.anchor.set(0.5, 1.2)
    this.rulerLabel.visible = false

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = container.getBoundingClientRect()
      this.zoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top }, Math.exp(-event.deltaY * 0.0015))
    }
    const onContextMenu = (event: MouseEvent) => event.preventDefault()
    container.addEventListener("wheel", onWheel, { passive: false })
    container.addEventListener("contextmenu", onContextMenu)
    this.removeWheel = () => {
      container.removeEventListener("wheel", onWheel)
      container.removeEventListener("contextmenu", onContextMenu)
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
  }

  setTool(tool: SceneTool): void {
    this.tool = tool
    this.clearOverlay()
    this.app.canvas.style.cursor = tool === "select" ? "default" : "crosshair"
  }

  setDrawOptions(options: DrawOptions): void {
    this.drawOptions = options
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
      if (!item || this.isLocked(item)) continue
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

  toggleHiddenSelection(): void {
    for (const id of this.selection) {
      const item = this.items.get(id)
      if (!item) continue
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
      }
    }
    this.refreshSelection()
  }

  private layerFor(kind: ItemKind, document: WorldDocument): Container {
    if (kind === "tile") return (document.data as TileData).layer === "above" ? this.layers.tilesAbove : this.layers.tilesBelow
    if (kind === "drawing") return this.layers.drawings
    if (kind === "note") return this.layers.notes
    return this.layers.tokens
  }

  private build(kind: ItemKind, document: WorldDocument, grid: GridConfig): { display: Container; selection: Graphics } {
    if (kind === "token") return this.buildToken(document.data as TokenData, grid)
    if (kind === "tile") return this.buildTile(document.data as TileData)
    if (kind === "drawing") return this.buildDrawing(document.data as DrawingData)
    return this.buildNote(document.data as NoteData, grid)
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
      body.addChild(new Graphics().roundRect(-radius, -radius, size, size, corner).fill({ color: 0x171314 }).stroke({ color, width: Math.max(2, size * 0.035) }))
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
        sprite.scale.set(scale)
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
    const selection = new Graphics().roundRect(-radius - 4, -radius - 4, size + 8, size + 8, corner + 4).stroke({ color: SELECTION_COLOR, width: 3 })
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
    const border = Math.max(2, Math.round(Math.min(width, height) * 0.04))
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
  }

  private clearOverlay(): void {
    this.overlay.clear()
    this.rulerLabel.visible = false
    this.handlers.onStatus?.("")
  }

  private updateOverlayScale(): void {
    this.rulerLabel.scale.set(1 / this.world.scale.x)
  }

  private drawRuler(from: Point, to: Point): void {
    const grid = this.scene?.data.grid
    if (!grid) return
    const start = grid.type === "none" ? from : cellCenter(from, grid)
    const end = grid.type === "none" ? to : cellCenter(to, grid)
    const width = 3 / this.world.scale.x
    this.overlay.clear()
      .moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ color: 0x080707, width: width * 2.5, alpha: 0.7 })
      .moveTo(start.x, start.y).lineTo(end.x, end.y).stroke({ color: 0x82aaa6, width })
      .circle(start.x, start.y, width * 2).fill(0x82aaa6)
      .circle(end.x, end.y, width * 2).fill(0x82aaa6)
    const distance = measure(start, end, grid)
    const cells = cellDistance(start, end, grid)
    const text = grid.type === "none" ? `${formatNumber(distance)} ${grid.units}` : `${formatNumber(distance)} ${grid.units} · ${formatNumber(cells)} ${cells === 1 ? "célula" : "células"}`
    this.rulerLabel.text = text
    this.rulerLabel.position.set(end.x, end.y)
    this.rulerLabel.visible = true
    this.updateOverlayScale()
    this.handlers.onStatus?.(text)
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

  // ── Interação ───────────────────────────────────────────────────────────

  private isLocked(item: Item): boolean {
    return Boolean((item.document.data as { locked?: boolean }).locked)
  }

  private emitSelection(): void {
    this.refreshSelection()
    this.handlers.onSelectionChange([...this.selection])
  }

  private onItemPointerDown(event: FederatedPointerEvent, id: string): void {
    if (event.button !== 0 || this.tool !== "select") return
    event.stopPropagation()
    const item = this.items.get(id)
    if (!item) return
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
    if (event.button === 1 || event.button === 2) {
      this.interaction = { type: "pan", startGlobal: { x: event.global.x, y: event.global.y }, startPosition: { x: this.world.x, y: this.world.y } }
      this.app.canvas.style.cursor = "grabbing"
      return
    }
    if (event.button !== 0 || !this.options.editable || !this.scene) return
    const point = this.world.toLocal(event.global)
    const grid = this.scene.data.grid
    const parentId = this.scene.id
    switch (this.tool) {
      case "select":
        if (!event.shiftKey && this.selection.size) { this.selection.clear(); this.emitSelection() }
        this.interaction = { type: "box", start: point }
        break
      case "ruler":
        this.interaction = { type: "ruler", start: point }
        this.drawRuler(point, point)
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
    if (interaction.type === "ruler") { this.drawRuler(interaction.start, point); return }
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
    if (interaction.type === "box") {
      this.clearOverlay()
      const left = Math.min(interaction.start.x, point.x)
      const right = Math.max(interaction.start.x, point.x)
      const top = Math.min(interaction.start.y, point.y)
      const bottom = Math.max(interaction.start.y, point.y)
      if ((right - left) * this.world.scale.x < 4 && (bottom - top) * this.world.scale.x < 4) return
      for (const item of this.items.values()) {
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
