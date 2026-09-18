import { describe, expect, it } from "vitest"
import { normalizeLight, normalizeScene, normalizeToken, normalizeWall, type SceneData } from "../src/shared/scene"
import { computeVision, decodeBits, encodeBits, fillPolygon, fogLayout, isPointVisible, isTokenVisible, mergeExplored, pointInPolygon, sightSegments, visibleCells, visibilityPolygon } from "../src/shared/vision"

const scene = (vision: Partial<SceneData["vision"]> = {}): SceneData => normalizeScene({ name: "Masmorra", width: 1000, height: 600, vision: { enabled: true, ...vision } })
const token = (id: string, data: Record<string, unknown>) => ({ id, data: normalizeToken(data) })
// Uma parede vertical no meio da sala, de cima a baixo.
const middleWall = normalizeWall({ x1: 500, y1: 0, x2: 500, y2: 600 })

describe("polígono de visibilidade", () => {
  it("sem paredes, vê a cena inteira", () => {
    const polygon = visibilityPolygon({ x: 100, y: 100 }, [], 1000, 600)
    expect(pointInPolygon({ x: 990, y: 590 }, polygon)).toBe(true)
    expect(pointInPolygon({ x: 1200, y: 100 }, polygon)).toBe(false)
  })

  it("a parede esconde o que está atrás dela", () => {
    const polygon = visibilityPolygon({ x: 250, y: 300 }, sightSegments([middleWall]), 1000, 600)
    expect(pointInPolygon({ x: 400, y: 300 }, polygon)).toBe(true)
    expect(pointInPolygon({ x: 600, y: 300 }, polygon)).toBe(false)
  })

  it("uma porta aberta deixa ver; fechada ou secreta, não", () => {
    const door = normalizeWall({ ...middleWall, kind: "door", open: true })
    expect(sightSegments([door])).toHaveLength(0)
    expect(sightSegments([{ ...door, open: false }])).toHaveLength(1)
    expect(sightSegments([normalizeWall({ ...middleWall, kind: "secret" })])).toHaveLength(1)
    expect(normalizeWall({ ...middleWall, open: true }).open).toBe(false)
  })

  it("o raio limita a área a um círculo", () => {
    const polygon = visibilityPolygon({ x: 300, y: 300 }, [], 1000, 600, 100)
    expect(pointInPolygon({ x: 390, y: 300 }, polygon)).toBe(true)
    expect(pointInPolygon({ x: 420, y: 300 }, polygon)).toBe(false)
  })

  it("enxerga pela fresta entre duas paredes", () => {
    const walls = sightSegments([normalizeWall({ x1: 500, y1: 0, x2: 500, y2: 280 }), normalizeWall({ x1: 500, y1: 320, x2: 500, y2: 600 })])
    const polygon = visibilityPolygon({ x: 250, y: 300 }, walls, 1000, 600)
    expect(pointInPolygon({ x: 700, y: 300 }, polygon)).toBe(true)
    expect(pointInPolygon({ x: 700, y: 100 }, polygon)).toBe(false)
  })
})

describe("visão da cena", () => {
  it("de dia, o aliado vê tudo o que está na linha de visão", () => {
    const vision = computeVision(scene(), [token("heroi", { x: 250, y: 300, disposition: "friendly" })], [middleWall], [])
    expect(isPointVisible(vision, { x: 450, y: 50 })).toBe(true)
    expect(isPointVisible(vision, { x: 750, y: 300 })).toBe(false)
  })

  it("só aliados visíveis e com visão revelam o mapa", () => {
    const vision = computeVision(scene(), [token("inimigo", { x: 250, y: 300, disposition: "hostile" }), token("oculto", { x: 750, y: 300, disposition: "friendly", hidden: true }), token("cego", { x: 750, y: 300, disposition: "friendly", vision: { enabled: false } })], [], [])
    expect(vision.viewers).toEqual([])
    expect(isPointVisible(vision, { x: 250, y: 300 })).toBe(false)
  })

  it("no escuro, vê só a área iluminada e o alcance no escuro", () => {
    const dark = scene({ globalLight: false, darkness: 1 })
    const hero = token("heroi", { x: 100, y: 300, disposition: "friendly", size: 1, vision: { enabled: true, range: 1 } })
    const torch = normalizeLight({ x: 400, y: 300, bright: 0.5, dim: 1 })
    const vision = computeVision(dark, [hero], [middleWall], [torch])
    // alcance no escuro: 1 célula (100 px) a partir da borda (50 px) = 150 px
    expect(isPointVisible(vision, { x: 240, y: 300 })).toBe(true)
    expect(isPointVisible(vision, { x: 280, y: 300 })).toBe(false)
    expect(isPointVisible(vision, { x: 420, y: 300 })).toBe(true)
    // a luz está do mesmo lado; atrás da parede continua escuro
    expect(isPointVisible(vision, { x: 520, y: 300 })).toBe(false)
  })

  it("a luz de um token ilumina ao redor dele", () => {
    const dark = scene({ globalLight: false })
    const vision = computeVision(dark, [token("heroi", { x: 100, y: 300, disposition: "friendly", light: { bright: 1, dim: 2 } })], [], [])
    expect(vision.lights).toHaveLength(1)
    expect(isPointVisible(vision, { x: 280, y: 300 })).toBe(true)
    expect(isPointVisible(vision, { x: 320, y: 300 })).toBe(false)
  })

  it("um inimigo atrás da parede não é visível; o próprio observador sempre é", () => {
    const hero = token("heroi", { x: 250, y: 300, disposition: "friendly" })
    const enemy = token("inimigo", { x: 750, y: 300, disposition: "hostile" })
    const vision = computeVision(scene(), [hero, enemy], [middleWall], [])
    expect(isTokenVisible(vision, enemy.id, enemy.data, 100)).toBe(false)
    expect(isTokenVisible(vision, hero.id, hero.data, 100)).toBe(true)
    const open = computeVision(scene(), [hero, enemy], [normalizeWall({ ...middleWall, kind: "door", open: true })], [])
    expect(isTokenVisible(open, enemy.id, enemy.data, 100)).toBe(true)
  })

  it("sem névoa, tudo é visível", () => {
    const vision = computeVision(scene({ enabled: false }), [], [middleWall], [])
    expect(isPointVisible(vision, { x: 900, y: 500 })).toBe(true)
  })
})

describe("áreas exploradas", () => {
  it("preenche as células do polígono", () => {
    const layout = { cellSize: 10, cols: 10, rows: 10 }
    const mask = new Uint8Array(100)
    fillPolygon(mask, layout, [0, 0, 50, 0, 50, 50, 0, 50])
    expect(mask.reduce((sum, value) => sum + value, 0)).toBe(25)
    expect(mask[0]).toBe(1)
    expect(mask[5]).toBe(0)
  })

  it("codifica e decodifica os bits", () => {
    const cells = new Uint8Array(21).map((_, index) => (index % 3 === 0 ? 1 : 0))
    expect([...decodeBits(encodeBits(cells), 21)]).toEqual([...cells])
  })

  it("acumula o que foi visto e recomeça se a grade mudar", () => {
    const layout = fogLayout(scene())
    expect(layout).toEqual({ cellSize: 50, cols: 20, rows: 12 })
    const left = computeVision(scene(), [token("heroi", { x: 250, y: 300, disposition: "friendly" })], [middleWall], [])
    const first = mergeExplored(null, layout, visibleCells(left, layout))
    expect(first.changed).toBe(true)
    const again = mergeExplored(first.fog, layout, visibleCells(left, layout))
    expect(again.changed).toBe(false)
    const explored = decodeBits(again.fog.bits, layout.cols * layout.rows)
    expect(explored[6 * layout.cols + 2]).toBe(1)
    expect(explored[6 * layout.cols + 15]).toBe(0)
    const resized = mergeExplored(again.fog, { cellSize: 25, cols: 40, rows: 24 }, new Uint8Array(40 * 24))
    expect(resized.changed).toBe(true)
    expect(decodeBits(resized.fog.bits, 40 * 24).every((value) => value === 0)).toBe(true)
  })
})
