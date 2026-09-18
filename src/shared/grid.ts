/**
 * Geometria da grade. Coordenadas em pixels da cena.
 *
 * - `square`: células quadradas de lado `size`.
 * - `hex-rows`: hexágonos de topo pontudo em fileiras; `size` é a distância
 *   entre centros vizinhos na mesma fileira (a largura do hexágono).
 * - `hex-cols`: hexágonos de topo plano em colunas; `size` é a distância
 *   entre centros vizinhos na mesma coluna (a altura do hexágono).
 * - `none`: sem grade; o encaixe não acontece e a distância é euclidiana.
 */

export const GRID_TYPES = ["square", "hex-rows", "hex-cols", "none"] as const
export type GridType = (typeof GRID_TYPES)[number]

export const DIAGONAL_RULES = ["equidistant", "alternating", "euclidean"] as const
/** Regra das diagonais na grade quadrada: 1-1-1, 1-2-1 ou geométrica. */
export type DiagonalRule = (typeof DIAGONAL_RULES)[number]

export interface GridConfig {
  type: GridType
  size: number
  offsetX: number
  offsetY: number
  /** Quantas unidades cada célula representa (ex.: 1,5). */
  distance: number
  units: string
  diagonals: DiagonalRule
  color: string
  alpha: number
}

export interface Point {
  x: number
  y: number
}

const SQRT3 = Math.sqrt(3)

interface Axial { q: number; r: number }

function hexRadius(grid: GridConfig): number {
  return grid.size / SQRT3
}

function roundAxial(q: number, r: number): Axial {
  const s = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const rs = Math.round(s)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) rq = -rr - rs
  else if (dr > ds) rr = -rq - rs
  return { q: rq + 0, r: rr + 0 }
}

function pixelToAxial(point: Point, grid: GridConfig): Axial {
  const radius = hexRadius(grid)
  const x = point.x - grid.offsetX
  const y = point.y - grid.offsetY
  if (grid.type === "hex-rows") return roundAxial(((SQRT3 / 3) * x - (1 / 3) * y) / radius, ((2 / 3) * y) / radius)
  return roundAxial(((2 / 3) * x) / radius, ((-1 / 3) * x + (SQRT3 / 3) * y) / radius)
}

function axialToPixel({ q, r }: Axial, grid: GridConfig): Point {
  const radius = hexRadius(grid)
  if (grid.type === "hex-rows") return { x: grid.offsetX + radius * (SQRT3 * q + (SQRT3 / 2) * r), y: grid.offsetY + radius * 1.5 * r }
  return { x: grid.offsetX + radius * 1.5 * q, y: grid.offsetY + radius * ((SQRT3 / 2) * q + SQRT3 * r) }
}

/** Vértices de um hexágono centrado em `center`, prontos para `Graphics.poly`. */
export function hexVertices(center: Point, grid: GridConfig): number[] {
  const radius = hexRadius(grid)
  const start = grid.type === "hex-rows" ? -90 : 0
  const points: number[] = []
  for (let corner = 0; corner < 6; corner += 1) {
    const angle = ((start + corner * 60) * Math.PI) / 180
    points.push(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle))
  }
  return points
}

/** Centro da célula que contém o ponto. */
export function cellCenter(point: Point, grid: GridConfig): Point {
  if (grid.type === "none") return { ...point }
  if (grid.type === "square") {
    const col = Math.floor((point.x - grid.offsetX) / grid.size)
    const row = Math.floor((point.y - grid.offsetY) / grid.size)
    return { x: grid.offsetX + (col + 0.5) * grid.size, y: grid.offsetY + (row + 0.5) * grid.size }
  }
  return axialToPixel(pixelToAxial(point, grid), grid)
}

/**
 * Encaixa o centro de um token de `cells` × `cells` células. Na grade
 * quadrada, tamanho ímpar fica no centro de uma célula e tamanho par em um
 * vértice, para o token cobrir células inteiras.
 */
export function snapTokenCenter(point: Point, cells: number, grid: GridConfig): Point {
  if (grid.type === "none") return { ...point }
  if (grid.type !== "square") return cellCenter(point, grid)
  const half = (cells * grid.size) / 2
  const snap = (value: number, offset: number) => offset + Math.round((value - offset - half) / grid.size) * grid.size + half
  return { x: snap(point.x, grid.offsetX), y: snap(point.y, grid.offsetY) }
}

/** Distância em células entre dois pontos, segundo o tipo de grade e a regra das diagonais. */
export function cellDistance(from: Point, to: Point, grid: GridConfig): number {
  if (grid.type === "none") return Math.hypot(to.x - from.x, to.y - from.y) / grid.size
  if (grid.type === "square") {
    const a = cellCenter(from, grid)
    const b = cellCenter(to, grid)
    const dx = Math.round(Math.abs(b.x - a.x) / grid.size)
    const dy = Math.round(Math.abs(b.y - a.y) / grid.size)
    const diagonal = Math.min(dx, dy)
    const straight = Math.max(dx, dy) - diagonal
    if (grid.diagonals === "alternating") return straight + diagonal + Math.floor(diagonal / 2)
    if (grid.diagonals === "euclidean") return Math.hypot(dx, dy)
    return straight + diagonal
  }
  const a = pixelToAxial(from, grid)
  const b = pixelToAxial(to, grid)
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2
}

/** Distância em unidades da cena (células × `distance`), arredondada a duas casas. */
export function measure(from: Point, to: Point, grid: GridConfig): number {
  return Math.round(cellDistance(from, to, grid) * grid.distance * 100) / 100
}

/** Centros de todas as células que cobrem um retângulo — usado para desenhar grades hexagonais. */
export function hexCentersIn(width: number, height: number, grid: GridConfig): Point[] {
  const radius = hexRadius(grid)
  const centers: Point[] = []
  const seen = new Set<string>()
  const stepX = grid.type === "hex-rows" ? grid.size / 2 : radius * 1.5
  const stepY = grid.type === "hex-rows" ? radius * 1.5 : grid.size / 2
  for (let y = -stepY; y <= height + stepY; y += stepY) {
    for (let x = -stepX; x <= width + stepX; x += stepX) {
      const axial = pixelToAxial({ x, y }, grid)
      const key = `${axial.q},${axial.r}`
      if (seen.has(key)) continue
      seen.add(key)
      centers.push(axialToPixel(axial, grid))
    }
  }
  return centers
}
