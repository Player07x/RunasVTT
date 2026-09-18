import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { VisionService } from "../src/main/vision-service"
import { WorldDatabase } from "../src/main/world-database"
import { putDocument } from "../src/main/world-documents"
import { projectScene } from "../src/shared/player"
import type { SceneData, TokenData } from "../src/shared/scene"
import { decodeBits } from "../src/shared/vision"
import type { WorldDocument } from "../src/shared/world"

let dir: string
let database: WorldDatabase
let service: VisionService

const put = (input: Parameters<typeof putDocument>[1]) => service.onDocumentChange(putDocument(database, input).change)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runas-vtt-vision-"))
  database = new WorldDatabase(join(dir, "world.db"))
  service = new VisionService(() => database)
  put({ id: "cena", type: "scene", parentId: null, data: { name: "Masmorra", width: 1000, height: 600, vision: { enabled: true, globalLight: false, darkness: 1 } } })
  put({ id: "parede", type: "wall", parentId: "cena", data: { x1: 500, y1: 0, x2: 500, y2: 600 } })
  put({ id: "heroi", type: "token", parentId: "cena", data: { name: "Heroína", x: 250, y: 300, disposition: "friendly", light: { bright: 1, dim: 2 } } })
  put({ id: "orc", type: "token", parentId: "cena", data: { name: "Orc", x: 750, y: 300, disposition: "hostile" } })
  put({ id: "tocha", type: "light", parentId: "cena", data: { x: 800, y: 300, bright: 1, dim: 2 } })
})

afterEach(async () => {
  database.close()
  await rm(dir, { recursive: true, force: true })
})

function project() {
  const scene = database.get("cena") as WorldDocument<SceneData>
  return projectScene({
    scene,
    children: { tokens: database.list("token", "cena") as WorldDocument<TokenData>[], tiles: [], drawings: [], notes: [] },
    bars: "friendly",
    vision: service.get("cena"),
  })
}

describe("névoa na projeção dos jogadores", () => {
  it("não envia o token escondido atrás da parede, nem a luz da sala não vista, nem paredes", () => {
    const projection = project()
    expect(projection.children.map((child) => child.id)).toEqual(["heroi"])
    expect(projection.vision?.fog?.viewers).toHaveLength(1)
    // Só a luz da heroína toca a linha de visão; a tocha da outra sala fica de fora.
    expect(projection.vision?.lights).toHaveLength(1)
    const wire = JSON.stringify(projection)
    expect(wire).not.toContain("parede")
    expect(wire).not.toContain("Orc")
    const token = projection.children[0]!
    expect(token.data).not.toHaveProperty("vision")
    expect(token.data).not.toHaveProperty("light")
  })

  it("abrir uma porta revela o que está atrás dela", () => {
    put({ id: "parede", type: "wall", parentId: "cena", data: { x1: 500, y1: 0, x2: 500, y2: 600, kind: "door", open: true } })
    // Sem luz do dia, o orc só aparece se estiver iluminado: a tocha está ao lado dele.
    expect(project().children.map((child) => child.id).sort()).toEqual(["heroi", "orc"])
  })
})

describe("áreas exploradas", () => {
  it("ficam gravadas no mundo, acumulam e podem ser redefinidas", () => {
    const first = service.get("cena")!.fog!
    const cells = first.cols * first.rows
    const explored = (fog: typeof first) => decodeBits(fog.bits, cells).reduce((sum, value) => sum + value, 0)
    const before = explored(first)
    expect(before).toBeGreaterThan(0)
    expect(database.get("fog-cena")?.type).toBe("fog")

    put({ id: "heroi", type: "token", parentId: "cena", data: { name: "Heroína", x: 100, y: 100, disposition: "friendly", light: { bright: 1, dim: 2 } } })
    const after = explored(service.get("cena")!.fog!)
    expect(after).toBeGreaterThan(before)

    // Outra instância lê o que foi gravado.
    expect(explored(new VisionService(() => database).get("cena")!.fog!)).toBe(after)

    service.resetExploration("cena")
    expect(explored(service.get("cena")!.fog!)).toBeLessThan(after)
  })

  it("somem junto com a cena", () => {
    service.get("cena")
    database.delete("cena")
    expect(database.get("fog-cena")).toBeNull()
  })
})
