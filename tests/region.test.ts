import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RegionService } from "../src/main/region-service"
import { WorldDatabase } from "../src/main/world-database"
import { putDocument } from "../src/main/world-documents"
import type { DocumentChange } from "../src/shared/ipc"
import { DEFAULT_GRID, type LogData, type TokenData } from "../src/shared/scene"
import { measureWithTerrain, normalizeRegion, regionContains, type RegionData } from "../src/shared/region"

describe("geometria das regiões", () => {
  it("retângulo e elipse", () => {
    const rect = normalizeRegion({ x: 0, y: 0, width: 100, height: 50 })
    expect(regionContains(rect, { x: 99, y: 49 })).toBe(true)
    expect(regionContains(rect, { x: 101, y: 10 })).toBe(false)
    const ellipse = normalizeRegion({ shape: "ellipse", x: 0, y: 0, width: 100, height: 100 })
    expect(regionContains(ellipse, { x: 50, y: 50 })).toBe(true)
    expect(regionContains(ellipse, { x: 5, y: 5 })).toBe(false)
  })

  it("a régua cobra o trecho em terreno difícil", () => {
    // 4 células em linha reta, metade delas dentro de terreno x2 = 6 células.
    const terrain = [{ ...normalizeRegion({ x: 250, y: 0, width: 200, height: 100 }), multiplier: 2 }]
    const result = measureWithTerrain({ x: 50, y: 50 }, { x: 450, y: 50 }, DEFAULT_GRID, terrain)
    expect(result.difficult).toBe(true)
    expect(result.cells).toBeCloseTo(6, 0)
    expect(result.distance).toBeCloseTo(9, 0)
    expect(measureWithTerrain({ x: 50, y: 50 }, { x: 150, y: 50 }, DEFAULT_GRID, terrain).difficult).toBe(false)
  })
})

let dir: string
let database: WorldDatabase
let service: RegionService
let published: DocumentChange[]

function put(input: Parameters<typeof putDocument>[1]): void {
  const { change } = putDocument(database, input)
  service.onDocumentChange(change)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-region-"))
  database = new WorldDatabase(join(dir, "world.db"))
  published = []
  // Como no processo principal: o que o serviço publica volta para ele mesmo.
  service = new RegionService(() => database, (changes) => { published.push(...changes); for (const change of changes) service.onDocumentChange(change) })
  put({ id: "masmorra", type: "scene", parentId: null, data: { name: "Masmorra" } })
  put({ id: "torre", type: "scene", parentId: null, data: { name: "Torre" } })
  put({ id: "armadilha", type: "region", parentId: "masmorra", data: { name: "Armadilha", x: 400, y: 0, width: 200, height: 200, text: { enabled: true, message: "O chão range…", once: true } } })
  put({ id: "portal", type: "region", parentId: "masmorra", data: { name: "Portal", x: 800, y: 0, width: 200, height: 200, teleport: { enabled: true, regionId: "chegada" } } })
  put({ id: "chegada", type: "region", parentId: "torre", data: { name: "Chegada", x: 0, y: 0, width: 200, height: 200, teleport: { enabled: true, regionId: "portal" } } })
  put({ id: "heroi", type: "token", parentId: "masmorra", data: { name: "Heroína", x: 50, y: 50, disposition: "friendly" } })
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

const move = (x: number, y: number, extra: Partial<TokenData> = {}) => {
  const token = database.get("heroi")!
  put({ id: "heroi", type: "token", parentId: token.parentId, data: { ...(token.data as TokenData), x, y, ...extra } })
}
const logs = () => database.list("log-entry", null).map((entry) => entry.data as LogData)

describe("gatilhos das regiões", () => {
  it("mostra o texto ao entrar, só uma vez", () => {
    move(450, 50)
    expect(logs()).toHaveLength(1)
    expect(logs()[0]).toMatchObject({ title: "Armadilha", floatingText: "O chão range…", tokenId: "heroi" })
    expect((database.get("armadilha")!.data as RegionData).text.enabled).toBe(false)
    move(50, 50)
    move(450, 50)
    expect(logs()).toHaveLength(1)
  })

  it("teleporta para a região de destino em outra cena, sem voltar pelo portal da chegada", () => {
    move(850, 50)
    const token = database.get("heroi")!
    expect(token.parentId).toBe("torre")
    // Centro da região de destino, encaixado na célula (token de 1 célula).
    expect(token.data).toMatchObject({ x: 150, y: 150 })
    // A chegada também é um portal, mas chegar nela não dispara.
    expect(database.get("heroi")!.parentId).toBe("torre")
    // Sair e entrar de novo dispara a volta.
    move(500, 500)
    move(100, 100)
    expect(database.get("heroi")!.parentId).toBe("masmorra")
  })

  it("inimigos não disparam regiões só de aliados, e regiões desativadas não disparam", () => {
    move(50, 50, { disposition: "hostile" })
    move(450, 50)
    expect(logs()).toHaveLength(0)
    const region = database.get("armadilha")!
    put({ id: "armadilha", type: "region", parentId: "masmorra", data: { ...(region.data as RegionData), enabled: false, trigger: "any" } })
    move(50, 50)
    move(450, 50)
    expect(logs()).toHaveLength(0)
  })

  it("token novo e região desenhada por cima de um token não disparam", () => {
    put({ id: "novo", type: "token", parentId: "masmorra", data: { name: "Novo", x: 450, y: 50, disposition: "friendly" } })
    put({ id: "sala", type: "region", parentId: "masmorra", data: { x: 0, y: 0, width: 300, height: 300, text: { enabled: true, message: "Oi" } } })
    expect(logs()).toHaveLength(0)
    expect(published).toEqual([])
  })
})
