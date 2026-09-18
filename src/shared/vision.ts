import type { Point } from "./grid"
import type { FogData, LightData, SceneData, TokenData, WallData } from "./scene"

/**
 * Visão, luz e névoa (Fase 6). Código puro, usado pelo processo principal (a
 * projeção dos jogadores é a fronteira de segurança) e pela mesa (prévia do
 * mestre). Polígonos são listas planas `[x0, y0, x1, y1, …]` em pixels da cena.
 */

export type Polygon = number[]

export interface Segment { ax: number; ay: number; bx: number; by: number }

export interface VisionViewer {
  id: string
  x: number
  y: number
  /** Linha de visão até as paredes e as bordas da cena. */
  los: Polygon
  /** Linha de visão limitada ao alcance no escuro; `null` sem alcance. */
  sight: Polygon | null
}

export interface VisionLight {
  x: number
  y: number
  /** Área total iluminada (penumbra), já recortada pelas paredes. */
  dim: Polygon
  /** Área de luz plena; `null` quando o raio claro é zero. */
  bright: Polygon | null
  dimRadius: number
  brightRadius: number
  color: string
  alpha: number
}

export interface SceneVision {
  enabled: boolean
  darkness: number
  globalLight: boolean
  width: number
  height: number
  viewers: VisionViewer[]
  lights: VisionLight[]
}

export interface VisionToken { id: string; data: TokenData }

const EPSILON = 1e-4
const CIRCLE_SIDES = 48

/** Tamanho de uma célula em pixels (cenas sem grade usam 100). */
export function cellPixels(scene: SceneData): number {
  return scene.grid.type === "none" ? 100 : scene.grid.size
}

/** Paredes que bloqueiam visão e luz: paredes e portas fechadas (secretas inclusive). */
export function sightSegments(walls: readonly WallData[]): Segment[] {
  return walls
    .filter((wall) => wall.kind === "wall" || !wall.open)
    .filter((wall) => Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) > EPSILON)
    .map((wall) => ({ ax: wall.x1, ay: wall.y1, bx: wall.x2, by: wall.y2 }))
}

function boundsSegments(width: number, height: number): Segment[] {
  return [
    { ax: 0, ay: 0, bx: width, by: 0 },
    { ax: width, ay: 0, bx: width, by: height },
    { ax: width, ay: height, bx: 0, by: height },
    { ax: 0, ay: height, bx: 0, by: 0 },
  ]
}

/** Polígono regular que contém o círculo (os lados ficam fora dele). */
function circleSegments(origin: Point, radius: number): Segment[] {
  const outer = radius / Math.cos(Math.PI / CIRCLE_SIDES)
  const segments: Segment[] = []
  for (let index = 0; index < CIRCLE_SIDES; index += 1) {
    const a = (index / CIRCLE_SIDES) * Math.PI * 2
    const b = ((index + 1) / CIRCLE_SIDES) * Math.PI * 2
    segments.push({ ax: origin.x + Math.cos(a) * outer, ay: origin.y + Math.sin(a) * outer, bx: origin.x + Math.cos(b) * outer, by: origin.y + Math.sin(b) * outer })
  }
  return segments
}

/** Distância ao longo do raio até o segmento, ou `Infinity`. */
function rayHit(ox: number, oy: number, dx: number, dy: number, segment: Segment): number {
  const v1x = ox - segment.ax
  const v1y = oy - segment.ay
  const v2x = segment.bx - segment.ax
  const v2y = segment.by - segment.ay
  const dot = v2x * -dy + v2y * dx
  if (Math.abs(dot) < 1e-12) return Infinity
  const t1 = (v2x * v1y - v2y * v1x) / dot
  const t2 = (v1x * -dy + v1y * dx) / dot
  return t1 > 1e-7 && t2 >= -1e-9 && t2 <= 1 + 1e-9 ? t1 : Infinity
}

function nearSegment(segment: Segment, origin: Point, radius: number): boolean {
  const minX = Math.min(segment.ax, segment.bx) - radius
  const maxX = Math.max(segment.ax, segment.bx) + radius
  const minY = Math.min(segment.ay, segment.by) - radius
  const maxY = Math.max(segment.ay, segment.by) + radius
  return origin.x >= minX && origin.x <= maxX && origin.y >= minY && origin.y <= maxY
}

/**
 * Área visível a partir de `origin`: lança raios para cada extremidade de
 * parede (e um pouco antes e depois dela) e para no obstáculo mais próximo.
 * Com `radius`, a área também é limitada a um círculo.
 */
export function visibilityPolygon(origin: Point, walls: readonly Segment[], width: number, height: number, radius = 0): Polygon {
  const reach = radius > 0 ? radius * 1.05 : Infinity
  const segments = [
    ...walls.filter((segment) => reach === Infinity || nearSegment(segment, origin, reach)),
    ...boundsSegments(width, height),
    ...(radius > 0 ? circleSegments(origin, radius) : []),
  ]
  const angles: number[] = []
  for (const segment of segments) {
    for (const [x, y] of [[segment.ax, segment.ay], [segment.bx, segment.by]] as const) {
      const angle = Math.atan2(y - origin.y, x - origin.x)
      angles.push(angle - EPSILON, angle, angle + EPSILON)
    }
  }
  angles.sort((a, b) => a - b)
  const polygon: Polygon = []
  let lastAngle = Number.NaN
  for (const angle of angles) {
    if (angle === lastAngle) continue
    lastAngle = angle
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    let nearest = Infinity
    for (const segment of segments) {
      const hit = rayHit(origin.x, origin.y, dx, dy, segment)
      if (hit < nearest) nearest = hit
    }
    if (nearest === Infinity) continue
    polygon.push(origin.x + dx * nearest, origin.y + dy * nearest)
  }
  return polygon
}

/** Alguma parede corta o segmento de `a` até `b`? (Usado pelos sons posicionais.) */
export function lineBlocked(a: Point, b: Point, walls: readonly Segment[]): boolean {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox)
  for (const wall of walls) {
    const d1 = cross(wall.ax, wall.ay, wall.bx, wall.by, a.x, a.y)
    const d2 = cross(wall.ax, wall.ay, wall.bx, wall.by, b.x, b.y)
    const d3 = cross(a.x, a.y, b.x, b.y, wall.ax, wall.ay)
    const d4 = cross(a.x, a.y, b.x, b.y, wall.bx, wall.by)
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  }
  return false
}

/** Ponto dentro do polígono (regra par-ímpar). */
export function pointInPolygon(point: Point, polygon: Polygon): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
    const xi = polygon[i]!
    const yi = polygon[i + 1]!
    const xj = polygon[j]!
    const yj = polygon[j + 1]!
    if ((yi > point.y) !== (yj > point.y) && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Tokens que revelam o mapa aos jogadores: aliados visíveis com visão. */
export function isViewer(token: TokenData): boolean {
  return token.disposition === "friendly" && token.vision.enabled && !token.hidden
}

/** Calcula linhas de visão e áreas iluminadas da cena. */
export function computeVision(scene: SceneData, tokens: readonly VisionToken[], walls: readonly WallData[], lights: readonly LightData[]): SceneVision {
  const { width, height } = scene
  const base: SceneVision = { enabled: scene.vision.enabled, darkness: scene.vision.darkness, globalLight: scene.vision.globalLight, width, height, viewers: [], lights: [] }
  const cell = cellPixels(scene)
  const segments = sightSegments(walls)
  const polygon = (origin: Point, radius = 0) => visibilityPolygon(origin, segments, width, height, radius)

  // Luzes valem também para a prévia do mestre com a névoa desligada.
  const sources: { x: number; y: number; bright: number; dim: number; color: string; alpha: number }[] = []
  for (const light of lights) if (!light.hidden && light.dim > 0) sources.push({ x: light.x, y: light.y, bright: light.bright, dim: light.dim, color: light.color, alpha: light.alpha })
  for (const { data } of tokens) if (!data.hidden && data.light.dim > 0) sources.push({ x: data.x, y: data.y, bright: data.light.bright, dim: data.light.dim, color: data.light.color, alpha: 0.3 })
  for (const source of sources) {
    const dimRadius = source.dim * cell
    const brightRadius = source.bright * cell
    base.lights.push({
      x: source.x,
      y: source.y,
      dim: polygon(source, dimRadius),
      bright: brightRadius > 0 ? polygon(source, brightRadius) : null,
      dimRadius,
      brightRadius,
      color: source.color,
      alpha: source.alpha,
    })
  }

  if (!scene.vision.enabled) return base
  for (const { id, data } of tokens) {
    if (!isViewer(data)) continue
    const origin = { x: data.x, y: data.y }
    // O alcance no escuro conta a partir da borda do token.
    const range = data.vision.range > 0 ? data.vision.range * cell + (data.size * cell) / 2 : 0
    base.viewers.push({ id, x: data.x, y: data.y, los: polygon(origin), sight: range > 0 ? polygon(origin, range) : null })
  }
  return base
}

function lit(vision: SceneVision, point: Point): boolean {
  return vision.globalLight || vision.lights.some((light) => pointInPolygon(point, light.dim))
}

/** O ponto está visível para os jogadores? Sem névoa, tudo está. */
export function isPointVisible(vision: SceneVision, point: Point): boolean {
  if (!vision.enabled) return true
  for (const viewer of vision.viewers) {
    if (viewer.sight && pointInPolygon(point, viewer.sight)) return true
    if (pointInPolygon(point, viewer.los) && lit(vision, point)) return true
  }
  return false
}

/** Token visível se o centro ou um ponto perto da borda estiver visível. */
export function isTokenVisible(vision: SceneVision, id: string, token: TokenData, cell: number): boolean {
  if (!vision.enabled || vision.viewers.some((viewer) => viewer.id === id)) return true
  const offset = token.size * cell * 0.35
  const points = [{ x: token.x, y: token.y }, { x: token.x - offset, y: token.y }, { x: token.x + offset, y: token.y }, { x: token.x, y: token.y - offset }, { x: token.x, y: token.y + offset }]
  return points.some((point) => isPointVisible(vision, point))
}

/** Se o polígono toca a linha de visão de algum observador (pela caixa envolvente). */
export function touchesAnyView(vision: SceneVision, polygon: Polygon): boolean {
  const box = boundingBox(polygon)
  return vision.viewers.some((viewer) => {
    const other = boundingBox(viewer.los)
    return box.minX <= other.maxX && box.maxX >= other.minX && box.minY <= other.maxY && box.maxY >= other.minY
  })
}

function boundingBox(polygon: Polygon) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (let index = 0; index < polygon.length; index += 2) {
    minX = Math.min(minX, polygon[index]!); maxX = Math.max(maxX, polygon[index]!)
    minY = Math.min(minY, polygon[index + 1]!); maxY = Math.max(maxY, polygon[index + 1]!)
  }
  return { minX, minY, maxX, maxY }
}

// ── O que a tela desenha ────────────────────────────────────────────────

export interface RenderFog {
  globalLight: boolean
  viewers: { los: Polygon; sight: Polygon | null }[]
  explored: FogData | null
}

/** Dados de desenho da escuridão, das luzes e da névoa (sem paredes nem tokens). */
export interface RenderVision {
  darkness: number
  lights: VisionLight[]
  /** `null`: sem névoa (mestre fora da prévia, ou cena sem névoa). */
  fog: RenderFog | null
}

/**
 * Recorte que vai para a tela. Para os jogadores, as luzes que não tocam
 * nenhuma linha de visão ficam de fora, porque o formato delas revelaria as
 * paredes de salas não vistas.
 */
export function renderVision(vision: SceneVision, explored: FogData | null, withFog: boolean): RenderVision {
  if (!withFog || !vision.enabled) return { darkness: vision.darkness, lights: vision.lights, fog: null }
  return {
    darkness: vision.darkness,
    lights: vision.lights.filter((light) => touchesAnyView(vision, light.dim)),
    fog: { globalLight: vision.globalLight, viewers: vision.viewers.map(({ los, sight }) => ({ los, sight })), explored },
  }
}

// ── Áreas exploradas ────────────────────────────────────────────────────

export interface FogLayout { cellSize: number; cols: number; rows: number }

/** Grade das áreas exploradas: meia célula, com no máximo cerca de 1 milhão de pontos. */
export function fogLayout(scene: SceneData): FogLayout {
  let cellSize = Math.max(10, Math.min(100, Math.round(cellPixels(scene) / 2)))
  while (Math.ceil(scene.width / cellSize) * Math.ceil(scene.height / cellSize) > 1_000_000) cellSize *= 2
  return { cellSize, cols: Math.ceil(scene.width / cellSize), rows: Math.ceil(scene.height / cellSize) }
}

/** Preenche (OR) as células cujo centro está dentro do polígono. */
export function fillPolygon(mask: Uint8Array, layout: FogLayout, polygon: Polygon): void {
  const { cellSize, cols, rows } = layout
  if (polygon.length < 6) return
  const box = boundingBox(polygon)
  const firstRow = Math.max(0, Math.floor(box.minY / cellSize))
  const lastRow = Math.min(rows - 1, Math.floor(box.maxY / cellSize))
  const crossings: number[] = []
  for (let row = firstRow; row <= lastRow; row += 1) {
    const y = (row + 0.5) * cellSize
    crossings.length = 0
    for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
      const yi = polygon[i + 1]!
      const yj = polygon[j + 1]!
      if ((yi > y) !== (yj > y)) crossings.push(polygon[i]! + ((y - yi) / (yj - yi)) * (polygon[j]! - polygon[i]!))
    }
    crossings.sort((a, b) => a - b)
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const start = Math.max(0, Math.ceil(crossings[k]! / cellSize - 0.5))
      const end = Math.min(cols - 1, Math.floor(crossings[k + 1]! / cellSize - 0.5))
      for (let col = start; col <= end; col += 1) mask[row * cols + col] = 1
    }
  }
}

/** Células visíveis agora: alcance no escuro, ou linha de visão iluminada. */
export function visibleCells(vision: SceneVision, layout: FogLayout): Uint8Array {
  const size = layout.cols * layout.rows
  const visible = new Uint8Array(size)
  if (!vision.enabled || vision.viewers.length === 0) return visible
  const los = new Uint8Array(size)
  for (const viewer of vision.viewers) {
    fillPolygon(los, layout, viewer.los)
    if (viewer.sight) fillPolygon(visible, layout, viewer.sight)
  }
  if (vision.globalLight) {
    for (let index = 0; index < size; index += 1) if (los[index]) visible[index] = 1
    return visible
  }
  const litCells = new Uint8Array(size)
  for (const light of vision.lights) fillPolygon(litCells, layout, light.dim)
  for (let index = 0; index < size; index += 1) if (los[index] && litCells[index]) visible[index] = 1
  return visible
}

export function encodeBits(cells: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil(cells.length / 8))
  for (let index = 0; index < cells.length; index += 1) if (cells[index]) bytes[index >> 3]! |= 1 << (index & 7)
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export function decodeBits(bits: string, count: number): Uint8Array {
  const cells = new Uint8Array(count)
  let binary = ""
  try { binary = atob(bits) } catch { return cells }
  for (let index = 0; index < count; index += 1) {
    const byte = binary.charCodeAt(index >> 3)
    if (byte & (1 << (index & 7))) cells[index] = 1
  }
  return cells
}

/**
 * Soma as células visíveis agora às já exploradas. Se a grade mudou (cena
 * redimensionada, outra grade), a exploração recomeça.
 */
export function mergeExplored(current: FogData | null, layout: FogLayout, visible: Uint8Array): { fog: FogData; changed: boolean } {
  const count = layout.cols * layout.rows
  const sameLayout = current && current.cellSize === layout.cellSize && current.cols === layout.cols && current.rows === layout.rows
  const explored = sameLayout && current.bits ? decodeBits(current.bits, count) : new Uint8Array(count)
  let changed = !sameLayout
  for (let index = 0; index < count; index += 1) {
    if (visible[index] && !explored[index]) { explored[index] = 1; changed = true }
  }
  return { fog: { ...layout, bits: encodeBits(explored) }, changed }
}
