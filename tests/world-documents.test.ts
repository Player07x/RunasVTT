import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assetResponse, importAsset, resolveAssetFile } from "../src/main/world-assets"
import { WorldDatabase } from "../src/main/world-database"
import { deleteDocument, putDocument } from "../src/main/world-documents"
import { normalizeScene, normalizeToken, type SceneData, type TokenData } from "../src/shared/scene"

let dir: string
let database: WorldDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-docs-"))
  database = new WorldDatabase(join(dir, "world.db"))
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

describe("putDocument", () => {
  it("normaliza os dados antes de gravar", () => {
    const { document } = putDocument(database, { id: "s1", type: "scene", parentId: null, data: { name: "  ", width: 5, grid: { type: "hex-rows", size: 5000, color: "vermelho" } } })
    const scene = document.data as SceneData
    expect(scene.name).toBe("Cena sem nome")
    expect(scene.width).toBe(100)
    expect(scene.grid.type).toBe("hex-rows")
    expect(scene.grid.size).toBe(1000)
    expect(scene.grid.color).toBe("#000000")
  })

  it("exige que objetos da cena pertençam a uma cena existente", () => {
    expect(() => putDocument(database, { id: "t1", type: "token", parentId: null, data: {} })).toThrow(/pertencer a uma cena/)
    expect(() => putDocument(database, { id: "t1", type: "token", parentId: "inexistente", data: {} })).toThrow(/pertencer a uma cena/)
    putDocument(database, { id: "s1", type: "scene", parentId: null, data: {} })
    expect(putDocument(database, { id: "t1", type: "token", parentId: "s1", data: { name: "Goblin" } }).document.parentId).toBe("s1")
  })

  it("recusa id inválido e troca de tipo", () => {
    expect(() => putDocument(database, { id: "../x", type: "scene", parentId: null, data: {} })).toThrow(/Id/)
    putDocument(database, { id: "s1", type: "scene", parentId: null, data: {} })
    expect(() => putDocument(database, { id: "s1", type: "playlist", parentId: null, data: {} })).toThrow(/outro tipo/)
  })

  it("preserva a data de criação e a ordem ao atualizar", () => {
    putDocument(database, { id: "s1", type: "scene", parentId: null, sort: 3, data: {} }, 100)
    const { document } = putDocument(database, { id: "s1", type: "scene", parentId: null, data: { name: "Taverna" } }, 200)
    expect(document.createdAt).toBe(100)
    expect(document.updatedAt).toBe(200)
    expect(document.sort).toBe(3)
  })

  it("excluir a cena informa todos os ids removidos, inclusive os tokens", () => {
    putDocument(database, { id: "s1", type: "scene", parentId: null, data: {} })
    putDocument(database, { id: "t1", type: "token", parentId: "s1", data: {} })
    putDocument(database, { id: "n1", type: "note", parentId: "s1", data: {} })
    const change = deleteDocument(database, "s1")
    expect(change?.kind === "delete" && change.ids.sort()).toEqual(["n1", "s1", "t1"])
    expect(database.get("t1")).toBeNull()
    expect(deleteDocument(database, "s1")).toBeNull()
  })
})

describe("normalização", () => {
  it("token: limita barras a 3, recusa imagem fora dos assets e disposição desconhecida", () => {
    const token: TokenData = normalizeToken({ image: "../../segredo.png", disposition: "aliado", bars: [{}, {}, {}, {}], size: 0 })
    expect(token.image).toBeNull()
    expect(token.disposition).toBe("neutral")
    expect(token.bars).toHaveLength(3)
    expect(token.size).toBe(0.25)
  })

  it("cena: aceita só caminhos de asset válidos", () => {
    const valid = `maps/${"a".repeat(64)}.webp`
    expect(normalizeScene({ background: valid }).background).toBe(valid)
    expect(normalizeScene({ background: "C:/mapas/x.png" }).background).toBeNull()
  })
})

describe("importAsset", () => {
  it("grava pelo hash do conteúdo, sem duplicar, e recusa formato inválido", async () => {
    const bytes = new TextEncoder().encode("imagem")
    const first = await importAsset(dir, "maps", "Mapa da Taverna.PNG", bytes)
    const second = await importAsset(dir, "maps", "copia.png", bytes)
    expect(first).toBe(second)
    expect(first).toMatch(/^maps\/[a-f0-9]{64}\.png$/)
    expect(await readFile(resolveAssetFile(dir, first)!, "utf8")).toBe("imagem")
    await expect(importAsset(dir, "maps", "virus.exe", bytes)).rejects.toThrow(/não suportado/)
    expect(resolveAssetFile(dir, "../world.db")).toBeNull()
  })
})

describe("assetResponse", () => {
  it("serve o arquivo com tipo, cache permanente e CORS; recusa caminhos fora dos assets", async () => {
    const path = await importAsset(dir, "tokens", "goblin.webp", new Uint8Array([1, 2, 3]))
    const response = await assetResponse(dir, path)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(response.headers.get("cache-control")).toContain("immutable")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect((await assetResponse(dir, "../world.db")).status).toBe(404)
    expect((await assetResponse(dir, `tokens/${"b".repeat(64)}.png`)).status).toBe(404)
  })
})
