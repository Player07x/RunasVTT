import { describe, expect, it } from "vitest"
import { projectScene } from "../src/shared/player"
import type { SceneData, NoteData, TileData, DrawingData, TokenData } from "../src/shared/scene"
import type { WorldDocument } from "../src/shared/world"

const sceneData: SceneData = { name: "Mapa", width: 1000, height: 800, backgroundColor: "#1a1516", background: `maps/${"a".repeat(64)}.png`, grid: { type: "square", size: 100, offsetX: 0, offsetY: 0, distance: 1.5, units: "m", diagonals: "equidistant", color: "#000000", alpha: 0.25 } }
const document = <T,>(id: string, type: WorldDocument["type"], data: T): WorldDocument<T> => ({ id, type, parentId: type === "scene" ? null : "scene-1", sort: 0, data, createdAt: 1, updatedAt: 1 })

describe("projeção da Vista dos Jogadores", () => {
  it("envia apenas a cena, objetos visíveis e assets referenciados", () => {
    const token = { name: "Aliado", x: 10, y: 20, size: 1, image: `tokens/${"b".repeat(64)}.webp`, rotation: 0, hidden: false, locked: false, disposition: "friendly", elevation: 0, bars: [{ label: "PV", value: 5, max: 10, color: "#c76561" }], showName: true, actor: { envelope: { secret: true }, source: "tools", updatedAt: 1 } } as TokenData
    const hidden = { ...token, name: "Segredo", hidden: true }
    const note = { x: 1, y: 2, label: "Pista", url: "https://privado.example", color: "#b99b65", hidden: false } as NoteData
    const tile = { image: `tiles/${"c".repeat(64)}.png`, x: 0, y: 0, width: 100, height: 100, rotation: 0, alpha: 1, layer: "below", hidden: false, locked: false } as TileData
    const drawing = { shape: "rectangle", x: 0, y: 0, width: 100, height: 100, points: [], strokeColor: "#f3ece8", strokeWidth: 4, fillColor: "#82aaa6", fillAlpha: 0, text: "", fontSize: 32, hidden: false, locked: false } as DrawingData
    const result = projectScene({ scene: document("scene-1", "scene", sceneData), children: { tokens: [document("token-1", "token", token), document("token-hidden", "token", hidden)], tiles: [document("tile-1", "tile", tile)], drawings: [document("drawing-1", "drawing", drawing)], notes: [document("note-1", "note", note)] }, bars: "friendly" })
    expect(result.children.map((child) => child.id)).toEqual(["tile-1", "drawing-1", "token-1", "note-1"])
    const projectedToken = result.children.find((child) => child.type === "token")!
    expect(projectedToken.type).toBe("token")
    if (projectedToken.type === "token") {
      expect(projectedToken.data).not.toHaveProperty("actor")
      expect(projectedToken.data.bars).toHaveLength(1)
    }
    expect(result.children.find((child) => child.type === "note")?.data).not.toHaveProperty("url")
    expect(result.assets).toEqual(expect.arrayContaining([sceneData.background!, token.image!, tile.image!]))
  })

  it("oculta barras dos não aliados e não envia Registro", () => {
    const token = { name: "Inimigo", x: 10, y: 20, size: 1, image: null, rotation: 0, hidden: false, locked: false, disposition: "hostile", elevation: 0, bars: [{ label: "PV", value: 5, max: 10, color: "#c76561" }], showName: true, actor: null } as TokenData
    const result = projectScene({ scene: document("scene-1", "scene", sceneData), children: { tokens: [document("token-1", "token", token)], tiles: [], drawings: [], notes: [] }, bars: "friendly" })
    expect(result.children).toHaveLength(1)
    expect(result.children[0]!.type).toBe("token")
    if (result.children[0]!.type === "token") expect(result.children[0]!.data.bars).toEqual([])
    expect(result).not.toHaveProperty("logs")
  })
})
