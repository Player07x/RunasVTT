import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WorldDatabase } from "../src/main/world-database"
import { WorldStore } from "../src/main/world-store"
import { WORLD_DATABASE_FILE } from "../src/shared/world"

let root: string
let store: WorldStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runas-vtt-test-"))
  store = new WorldStore(root)
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

describe("WorldStore", () => {
  it("cria a pasta completa do mundo", async () => {
    const world = await store.create({ title: "Mundo A", rulesetId: "cronos" })
    const manifest = JSON.parse(await readFile(join(world.path, "world.json"), "utf8"))
    expect(manifest.title).toBe("Mundo A")
    expect(manifest.rulesetId).toBe("cronos")
    await expect(readFile(join(world.path, WORLD_DATABASE_FILE))).resolves.toBeTruthy()
    for (const kind of ["maps", "tokens", "tiles", "audio"]) await expect(mkdir(join(world.path, "assets", kind))).rejects.toThrow()
  })

  it("lista só pastas com manifesto válido, do mais recente ao mais antigo", async () => {
    const first = await store.create({ title: "Primeiro" })
    await store.create({ title: "Segundo" })
    await mkdir(join(root, "pasta-qualquer"))
    await writeFile(join(root, "arquivo.txt"), "x")
    await store.open(first.id)
    const titles = (await store.list()).map((world) => world.title)
    expect(titles).toEqual(["Primeiro", "Segundo"])
  })

  it("mantém um único mundo aberto", async () => {
    const a = await store.create({ title: "A" })
    const b = await store.create({ title: "B" })
    await store.open(a.id)
    await store.open(b.id)
    expect(store.openWorld?.summary.id).toBe(b.id)
  })
})

describe("WorldDatabase", () => {
  it("guarda documentos e apaga os contidos junto com o pai", async () => {
    const world = await store.create({ title: "Mesa" })
    const { database } = await store.open(world.id)
    const now = Date.now()
    database.put({ id: "s1", type: "scene", parentId: null, sort: 0, data: { name: "Taverna" }, createdAt: now, updatedAt: now })
    database.put({ id: "t1", type: "token", parentId: "s1", sort: 1, data: { name: "Goblin" }, createdAt: now, updatedAt: now })
    database.put({ id: "t2", type: "token", parentId: "s1", sort: 0, data: { name: "Orc" }, createdAt: now, updatedAt: now })
    expect(database.list("token", "s1").map((token) => token.id)).toEqual(["t2", "t1"])
    database.put({ id: "t1", type: "token", parentId: "s1", sort: 1, data: { name: "Goblin ferido" }, createdAt: now, updatedAt: now + 1 })
    // A leitura normaliza: documentos antigos ganham os campos novos com os padrões.
    expect(database.get("t1")?.data).toMatchObject({ name: "Goblin ferido", vision: { enabled: true, range: 0 }, light: { bright: 0, dim: 0 } })
    database.delete("s1")
    expect(database.list("token")).toEqual([])
  })

  it("aplica as migrações uma única vez e reabre sem perder dados", async () => {
    const path = join(root, "direto.db")
    const first = new WorldDatabase(path)
    const version = first.schemaVersion
    first.put({ id: "s1", type: "scene", parentId: null, sort: 0, data: {}, createdAt: 1, updatedAt: 1 })
    first.close()
    const reopened = new WorldDatabase(path)
    expect(reopened.schemaVersion).toBe(version)
    expect(reopened.get("s1")).not.toBeNull()
    reopened.close()
  })
})
