import { DIAGONAL_RULES, GRID_TYPES, type GridConfig } from "./grid"
import type { DocumentType } from "./world"

/**
 * Formatos de `data` dos documentos da cena (Fase 2). O processo principal
 * normaliza tudo antes de gravar: a interface nunca grava um documento
 * malformado, e mundos antigos ganham os campos novos com padrões.
 *
 * Coordenadas em pixels da cena. Tokens e notas são posicionados pelo
 * centro; tiles e desenhos, pelo canto superior esquerdo.
 */

/** Caminho de um asset do mundo: `<tipo>/<sha256>.<ext>` (ver ADR 0004). */
export type AssetPath = string

export interface SceneData {
  name: string
  width: number
  height: number
  backgroundColor: string
  background: AssetPath | null
  grid: GridConfig
}

export const TOKEN_DISPOSITIONS = ["friendly", "neutral", "hostile", "secret"] as const
export type TokenDisposition = (typeof TOKEN_DISPOSITIONS)[number]

export interface TokenBar {
  label: string
  value: number
  max: number
  color: string
}

export interface TokenData {
  name: string
  x: number
  y: number
  /** Tamanho em células. */
  size: number
  image: AssetPath | null
  rotation: number
  hidden: boolean
  locked: boolean
  disposition: TokenDisposition
  elevation: number
  bars: TokenBar[]
  showName: boolean
}

export interface TileData {
  image: AssetPath | null
  x: number
  y: number
  width: number
  height: number
  rotation: number
  alpha: number
  /** Abaixo ou acima dos tokens (telhados, copas de árvore). */
  layer: "below" | "above"
  hidden: boolean
  locked: boolean
}

export const DRAWING_SHAPES = ["rectangle", "ellipse", "freehand", "text"] as const
export type DrawingShape = (typeof DRAWING_SHAPES)[number]

export interface DrawingData {
  shape: DrawingShape
  x: number
  y: number
  width: number
  height: number
  /** Pontos relativos a (x, y), só para `freehand`: [x0, y0, x1, y1, …]. */
  points: number[]
  strokeColor: string
  strokeWidth: number
  fillColor: string
  fillAlpha: number
  text: string
  fontSize: number
  hidden: boolean
  locked: boolean
}

export interface NoteData {
  x: number
  y: number
  label: string
  /** Página aberta no navegador integrado ao ativar a nota (ex.: Wiki do Runas DM). */
  url: string
  color: string
  hidden: boolean
}

export const BAR_COLORS = { pv: "#c76561", pa: "#82aaa6", pe: "#927f9c" } as const

export const DEFAULT_GRID: GridConfig = {
  type: "square",
  size: 100,
  offsetX: 0,
  offsetY: 0,
  distance: 1.5,
  units: "m",
  diagonals: "equidistant",
  color: "#000000",
  alpha: 0.25,
}

type Raw = Record<string, unknown>

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const ASSET_PATH = /^(maps|tokens|tiles|audio)\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/

function record(value: unknown): Raw {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {}
}
function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
function str(value: unknown, fallback: string, maxLength = 200): string {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}
function color(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback
}
function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? value as T : fallback
}
export function isAssetPath(value: unknown): value is AssetPath {
  return typeof value === "string" && ASSET_PATH.test(value)
}
function asset(value: unknown): AssetPath | null {
  return isAssetPath(value) ? value : null
}

export function normalizeGrid(value: unknown): GridConfig {
  const raw = record(value)
  return {
    type: oneOf(raw.type, GRID_TYPES, DEFAULT_GRID.type),
    size: num(raw.size, DEFAULT_GRID.size, 20, 1000),
    offsetX: num(raw.offsetX, 0, -1000, 1000),
    offsetY: num(raw.offsetY, 0, -1000, 1000),
    distance: num(raw.distance, DEFAULT_GRID.distance, 0.01, 10000),
    units: str(raw.units, DEFAULT_GRID.units, 12),
    diagonals: oneOf(raw.diagonals, DIAGONAL_RULES, DEFAULT_GRID.diagonals),
    color: color(raw.color, DEFAULT_GRID.color),
    alpha: num(raw.alpha, DEFAULT_GRID.alpha, 0, 1),
  }
}

export function normalizeScene(value: unknown): SceneData {
  const raw = record(value)
  return {
    name: str(raw.name, "Cena sem nome", 80).trim() || "Cena sem nome",
    width: num(raw.width, 3000, 100, 20000),
    height: num(raw.height, 2000, 100, 20000),
    backgroundColor: color(raw.backgroundColor, "#1a1516"),
    background: asset(raw.background),
    grid: normalizeGrid(raw.grid),
  }
}

function normalizeBar(value: unknown): TokenBar {
  const raw = record(value)
  const max = num(raw.max, 10, 0, 1_000_000)
  return { label: str(raw.label, "PV", 12), value: num(raw.value, max, -1_000_000, 1_000_000), max, color: color(raw.color, BAR_COLORS.pv) }
}

export function normalizeToken(value: unknown): TokenData {
  const raw = record(value)
  return {
    name: str(raw.name, "Token", 80),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    size: num(raw.size, 1, 0.25, 20),
    image: asset(raw.image),
    rotation: num(raw.rotation, 0, -360, 360),
    hidden: bool(raw.hidden, false),
    locked: bool(raw.locked, false),
    disposition: oneOf(raw.disposition, TOKEN_DISPOSITIONS, "neutral"),
    elevation: num(raw.elevation, 0, -100000, 100000),
    bars: Array.isArray(raw.bars) ? raw.bars.slice(0, 3).map(normalizeBar) : [],
    showName: bool(raw.showName, true),
  }
}

export function normalizeTile(value: unknown): TileData {
  const raw = record(value)
  return {
    image: asset(raw.image),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    width: num(raw.width, 200, 1, 20000),
    height: num(raw.height, 200, 1, 20000),
    rotation: num(raw.rotation, 0, -360, 360),
    alpha: num(raw.alpha, 1, 0, 1),
    layer: raw.layer === "above" ? "above" : "below",
    hidden: bool(raw.hidden, false),
    locked: bool(raw.locked, false),
  }
}

export function normalizeDrawing(value: unknown): DrawingData {
  const raw = record(value)
  const points = Array.isArray(raw.points) ? raw.points.filter((point): point is number => typeof point === "number" && Number.isFinite(point)).slice(0, 20000) : []
  return {
    shape: oneOf(raw.shape, DRAWING_SHAPES, "rectangle"),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    width: num(raw.width, 100, 0, 20000),
    height: num(raw.height, 100, 0, 20000),
    points: points.length % 2 === 0 ? points : points.slice(0, -1),
    strokeColor: color(raw.strokeColor, "#f3ece8"),
    strokeWidth: num(raw.strokeWidth, 4, 0, 100),
    fillColor: color(raw.fillColor, "#82aaa6"),
    fillAlpha: num(raw.fillAlpha, 0, 0, 1),
    text: str(raw.text, "", 2000),
    fontSize: num(raw.fontSize, 32, 8, 400),
    hidden: bool(raw.hidden, false),
    locked: bool(raw.locked, false),
  }
}

export function normalizeNote(value: unknown): NoteData {
  const raw = record(value)
  const url = str(raw.url, "", 2000).trim()
  return {
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    label: str(raw.label, "Nota", 120),
    url: /^https?:\/\//i.test(url) ? url : "",
    color: color(raw.color, "#b99b65"),
    hidden: bool(raw.hidden, false),
  }
}

/** Tipos que pertencem a uma cena e exigem `parentId` de cena. */
export const SCENE_CHILD_TYPES = ["token", "tile", "drawing", "note"] as const satisfies readonly DocumentType[]
export type SceneChildType = (typeof SCENE_CHILD_TYPES)[number]

export function isSceneChildType(type: DocumentType): type is SceneChildType {
  return (SCENE_CHILD_TYPES as readonly string[]).includes(type)
}

const NORMALIZERS: Partial<Record<DocumentType, (value: unknown) => unknown>> = {
  scene: normalizeScene,
  token: normalizeToken,
  tile: normalizeTile,
  drawing: normalizeDrawing,
  note: normalizeNote,
}

/** Normaliza o `data` de qualquer tipo conhecido; tipos das próximas fases passam intactos. */
export function normalizeDocumentData(type: DocumentType, value: unknown): unknown {
  return NORMALIZERS[type]?.(value) ?? value
}
