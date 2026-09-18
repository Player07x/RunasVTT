import { BlurFilter, Container, Graphics, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js"
import { decodeBits, type Polygon, type RenderVision } from "../../../shared/vision"

/** Maior lado das texturas de escuridão e névoa; cenas maiores são reduzidas. */
const MAX_TEXTURE = 2048
/** Quanto do mapa explorado (fora da visão atual) continua aparecendo. */
const EXPLORED_REVEAL = 0.75
/** Quanto da escuridão a visão no escuro (sem luz) remove. */
const DARKVISION_REVEAL = 0.5
/** Quanto da escuridão a penumbra de uma luz remove; a luz plena remove tudo. */
const DIM_REVEAL = 0.6

const hex = (value: string) => Number.parseInt(value.slice(1), 16)

function polygonGraphics(polygons: readonly Polygon[], alpha: number, erase: boolean, color = 0xffffff): Graphics {
  const graphics = new Graphics()
  for (const polygon of polygons) if (polygon.length >= 6) graphics.poly(polygon, true).fill({ color, alpha })
  if (erase) graphics.blendMode = "erase"
  return graphics
}

/**
 * Camadas de luz da cena: brilho colorido das luzes, escuridão com as áreas
 * iluminadas recortadas e névoa de guerra (preto fora da visão, esmaecido no
 * que já foi explorado). As texturas só são refeitas quando a visão muda.
 */
export class VisionLayer {
  readonly container = new Container()
  private readonly tint = new Graphics()
  private readonly darkness = new Sprite()
  private readonly fog = new Sprite()
  private darknessTexture: RenderTexture | null = null
  private fogTexture: RenderTexture | null = null

  constructor(private readonly renderer: Renderer) {
    this.tint.blendMode = "add"
    this.container.addChild(this.tint, this.darkness, this.fog)
    this.container.eventMode = "none"
  }

  /**
   * `darknessScale` reduz a escuridão para o mestre, que precisa enxergar o
   * mapa enquanto prepara a cena; a prévia e os jogadores usam 1.
   */
  render(vision: RenderVision | null, width: number, height: number, darknessScale = 1): void {
    this.tint.clear()
    if (!vision) { this.darkness.visible = false; this.fog.visible = false; return }
    const scale = Math.min(1, MAX_TEXTURE / Math.max(width, height))

    for (const light of vision.lights) {
      const color = hex(light.color)
      if (light.dim.length >= 6) this.tint.poly(light.dim, true).fill({ color, alpha: light.alpha * 0.25 })
      if (light.bright && light.bright.length >= 6) this.tint.poly(light.bright, true).fill({ color, alpha: light.alpha * 0.25 })
    }

    const darkness = vision.darkness * darknessScale
    if (darkness > 0.001) {
      const root = new Container()
      root.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x05060a, alpha: darkness }))
      root.addChild(polygonGraphics(vision.lights.map((light) => light.dim), DIM_REVEAL, true))
      root.addChild(polygonGraphics(vision.lights.flatMap((light) => (light.bright ? [light.bright] : [])), 1, true))
      if (vision.fog) root.addChild(polygonGraphics(vision.fog.viewers.flatMap((viewer) => (viewer.sight ? [viewer.sight] : [])), DARKVISION_REVEAL, true))
      this.darknessTexture = this.draw(root, this.darknessTexture, width, height, scale, 0)
      this.darkness.texture = this.darknessTexture
      this.darkness.scale.set(1 / scale)
      this.darkness.visible = true
    } else this.darkness.visible = false

    const fog = vision.fog
    if (!fog) { this.fog.visible = false; return }
    const root = new Container()
    root.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x000000, alpha: 1 }))
    let exploredTexture: Texture | null = null
    if (fog.explored && fog.explored.bits) {
      exploredTexture = exploredMask(fog.explored.bits, fog.explored.cols, fog.explored.rows)
      const explored = new Sprite(exploredTexture)
      explored.scale.set(fog.explored.cellSize)
      explored.alpha = EXPLORED_REVEAL
      explored.blendMode = "erase"
      root.addChild(explored)
    }
    root.addChild(polygonGraphics(fog.viewers.flatMap((viewer) => (viewer.sight ? [viewer.sight] : [])), 1, true))
    const lineOfSight = fog.viewers.map((viewer) => viewer.los)
    if (fog.globalLight) root.addChild(polygonGraphics(lineOfSight, 1, true))
    else if (vision.lights.length) {
      // Área iluminada que algum aliado enxerga: as luzes recortadas pela linha de visão.
      const lit = new Container()
      const mask = polygonGraphics(lineOfSight, 1, false)
      lit.addChild(mask, polygonGraphics(vision.lights.map((light) => light.dim), 1, true))
      lit.mask = mask
      root.addChild(lit)
    }
    this.fogTexture = this.draw(root, this.fogTexture, width, height, scale, 2)
    exploredTexture?.destroy(true)
    this.fog.texture = this.fogTexture
    this.fog.scale.set(1 / scale)
    this.fog.visible = true
  }

  destroy(): void {
    this.darknessTexture?.destroy(true)
    this.fogTexture?.destroy(true)
    this.container.destroy({ children: true })
  }

  /** Desenha `root` (em coordenadas da cena) numa textura reduzida por `scale`. */
  private draw(root: Container, current: RenderTexture | null, width: number, height: number, scale: number, blur: number): RenderTexture {
    const textureWidth = Math.max(1, Math.ceil(width * scale))
    const textureHeight = Math.max(1, Math.ceil(height * scale))
    let target = current
    if (!target || target.width !== textureWidth || target.height !== textureHeight) {
      current?.destroy(true)
      target = RenderTexture.create({ width: textureWidth, height: textureHeight })
    }
    root.scale.set(scale)
    // Borda suave, como a de uma chama; fraca o bastante para não vazar pelas paredes.
    if (blur > 0) root.filters = [new BlurFilter({ strength: blur, quality: 2 })]
    this.renderer.render({ container: root, target, clear: true })
    root.destroy({ children: true })
    return target
  }
}

/** Textura branca nas células exploradas (1 pixel por célula, suavizada ao ampliar). */
function exploredMask(bits: string, cols: number, rows: number): Texture {
  const cells = decodeBits(bits, cols * rows)
  const canvas = document.createElement("canvas")
  canvas.width = cols
  canvas.height = rows
  const context = canvas.getContext("2d")!
  const image = context.createImageData(cols, rows)
  for (let index = 0; index < cells.length; index += 1) {
    if (!cells[index]) continue
    const offset = index * 4
    image.data[offset] = 255
    image.data[offset + 1] = 255
    image.data[offset + 2] = 255
    image.data[offset + 3] = 255
  }
  context.putImageData(image, 0, 0)
  return Texture.from(canvas)
}
