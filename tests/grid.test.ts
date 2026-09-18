import { describe, expect, it } from "vitest"
import { cellCenter, cellDistance, hexCentersIn, hexVertices, measure, snapTokenCenter, type GridConfig } from "../src/shared/grid"

const square: GridConfig = { type: "square", size: 100, offsetX: 0, offsetY: 0, distance: 1.5, units: "m", diagonals: "equidistant", color: "#000", alpha: 0.2 }
const hexRows: GridConfig = { ...square, type: "hex-rows" }
const hexCols: GridConfig = { ...square, type: "hex-cols" }

describe("grade quadrada", () => {
  it("encontra o centro da célula, respeitando o deslocamento", () => {
    expect(cellCenter({ x: 130, y: 260 }, square)).toEqual({ x: 150, y: 250 })
    expect(cellCenter({ x: 130, y: 260 }, { ...square, offsetX: 20, offsetY: 20 })).toEqual({ x: 170, y: 270 })
  })

  it("encaixa token ímpar no centro e par no vértice", () => {
    expect(snapTokenCenter({ x: 140, y: 160 }, 1, square)).toEqual({ x: 150, y: 150 })
    expect(snapTokenCenter({ x: 140, y: 160 }, 2, square)).toEqual({ x: 100, y: 200 })
    expect(snapTokenCenter({ x: 140, y: 160 }, 3, square)).toEqual({ x: 150, y: 150 })
  })

  it("mede diagonais pelas três regras", () => {
    const from = { x: 50, y: 50 }
    const to = { x: 350, y: 250 } // 3 colunas e 2 linhas
    expect(cellDistance(from, to, square)).toBe(3)
    expect(cellDistance(from, to, { ...square, diagonals: "alternating" })).toBe(4)
    expect(cellDistance(from, to, { ...square, diagonals: "euclidean" })).toBeCloseTo(Math.hypot(3, 2))
    expect(measure(from, to, square)).toBe(4.5)
  })

  it("sem grade, mede em linha reta sem encaixar", () => {
    const none: GridConfig = { ...square, type: "none" }
    expect(snapTokenCenter({ x: 13, y: 17 }, 1, none)).toEqual({ x: 13, y: 17 })
    expect(cellDistance({ x: 0, y: 0 }, { x: 300, y: 400 }, none)).toBe(5)
  })
})

describe("grade hexagonal", () => {
  for (const grid of [hexRows, hexCols]) {
    it(`${grid.type}: vizinhos ficam a exatamente \`size\` de distância e a 1 célula`, () => {
      const origin = cellCenter({ x: 300, y: 300 }, grid)
      const centers = hexCentersIn(600, 600, grid)
      const neighbours = centers.filter((center) => Math.abs(Math.hypot(center.x - origin.x, center.y - origin.y) - grid.size) < 0.001)
      expect(neighbours).toHaveLength(6)
      for (const neighbour of neighbours) expect(cellDistance(origin, neighbour, grid)).toBe(1)
    })

    it(`${grid.type}: o centro de uma célula é estável e a distância cresce em anéis`, () => {
      const center = cellCenter({ x: 250, y: 250 }, grid)
      expect(cellCenter(center, grid)).toEqual(center)
      const far = cellCenter({ x: center.x + grid.size * 3, y: center.y }, grid)
      expect(cellDistance(center, far, grid)).toBeGreaterThanOrEqual(2)
      expect(hexVertices(center, grid)).toHaveLength(12)
    })
  }
})
