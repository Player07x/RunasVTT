import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { importAsset } from "../src/main/world-assets"
import { exportWorld, importWorld, MAX_SNAPSHOTS, SnapshotStore } from "../src/main/world-backup"
import { WorldDatabase } from "../src/main/world-database"
import { putDocument } from "../src/main/world-documents"
import { WorldStore } from "../src/main/world-store"
import { ZipReader, ZipWriter } from "../src/main/zip"

let root: string
let store: WorldStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runas-vtt-backup-"))
  store = new WorldStore(join(root, "worlds"))
})

afterEach(async () => {
  store.close()
  await rm(root, { recursive: true, force: true })
})

async function worldWithContent() {
  const created = await store.create({ title: "Crônicas" })
  const { database, summary } = await store.open(created.id)
  putDocument(database, { id: "cena", type: "scene", parentId: null, data: { name: "Taverna" } })
  putDocument(database, { id: "orc", type: "token", parentId: "cena", data: { name: "Orc" } })
  const asset = await importAsset(summary.path, "maps", "mapa.png", Buffer.from("imagem de teste"))
  return { summary, database, asset }
}

describe("zip", () => {
  it("escreve e lê de volta, armazenado e comprimido", async () => {
    const path = join(root, "teste.zip")
    const writer = await ZipWriter.create(path)
    await writer.add({ name: "texto.json", data: Buffer.from("{\"a\":1}".repeat(100)), compress: true })
    await writer.add({ name: "pasta/ação.png", data: Buffer.from([1, 2, 3]), compress: false })
    await writer.close()
    const reader = await ZipReader.open(path)
    expect(reader.entries.map((entry) => entry.name)).toEqual(["texto.json", "pasta/ação.png"])
    expect((await reader.read(reader.entries[0]!, 1e6)).toString()).toBe("{\"a\":1}".repeat(100))
    expect([...(await reader.read(reader.entries[1]!, 1e6))]).toEqual([1, 2, 3])
    await reader.close()
  })

  it("recusa um arquivo que não é zip", async () => {
    await writeFile(join(root, "falso.zip"), "não sou um zip")
    await expect(ZipReader.open(join(root, "falso.zip"))).rejects.toThrow(/não é um .zip/)
  })
})

describe("exportar e importar", () => {
  it("leva o mundo inteiro (com o mundo aberto) e importa como cópia se já existir", async () => {
    const { summary, database, asset } = await worldWithContent()
    const zip = join(root, "cronicas.zip")
    const result = await exportWorld(summary, database, zip)
    expect(result.files).toBe(3)

    const copy = await importWorld(zip, store.root, await store.list())
    expect(copy.id).not.toBe(summary.id)
    expect(copy.title).toBe("Crônicas (cópia)")
    const imported = new WorldDatabase(join(copy.path, "world.db"))
    expect(imported.get("orc")?.data).toMatchObject({ name: "Orc" })
    imported.close()
    expect(await readFile(join(copy.path, "assets", asset))).toEqual(Buffer.from("imagem de teste"))
    expect((await store.list()).map((world) => world.title).sort()).toEqual(["Crônicas", "Crônicas (cópia)"])

    // Em outra máquina (sem o mundo), mantém o id original.
    const elsewhere = await importWorld(zip, join(root, "outra"), [])
    expect(elsewhere.id).toBe(summary.id)
  })

  it("recusa caminhos estranhos e assets adulterados, sem deixar pasta para trás", async () => {
    const evil = join(root, "mal.zip")
    const writer = await ZipWriter.create(evil)
    await writer.add({ name: "world.json", data: Buffer.from("{}"), compress: false })
    await writer.add({ name: "../../fora.txt", data: Buffer.from("x"), compress: false })
    await writer.close()
    await expect(importWorld(evil, store.root, [])).rejects.toThrow(/arquivo inesperado/)

    const { summary, database } = await worldWithContent()
    const zip = join(root, "bom.zip")
    await exportWorld(summary, database, zip)
    const reader = await ZipReader.open(zip)
    const tampered = join(root, "adulterado.zip")
    const copy = await ZipWriter.create(tampered)
    for (const entry of reader.entries) {
      const data = await reader.read(entry, 1e9)
      await copy.add({ name: entry.name, data: entry.name.startsWith("assets/") ? Buffer.from("trocado") : data, compress: false })
    }
    await copy.close()
    await reader.close()
    const before = await readdir(store.root)
    await expect(importWorld(tampered, store.root, await store.list())).rejects.toThrow(/não confere/)
    expect(await readdir(store.root)).toEqual(before)
    // Uma pasta que já existe nunca é apagada por uma importação que falhou.
    await expect(importWorld(zip, store.root, [])).rejects.toThrow(/Já existe/)
    expect(await readdir(store.root)).toEqual(before)
    expect((await store.list()).map((world) => world.id)).toContain(summary.id)
  })
})

describe("snapshots", () => {
  it("guarda o banco, ignora sessões sem mudança e restaura", async () => {
    const { summary, database } = await worldWithContent()
    const snapshots = new SnapshotStore(join(root, "snapshots"))
    const first = await snapshots.create(summary, database, "session", 1_700_000_000_000)
    expect(first?.reason).toBe("session")
    expect(await snapshots.create(summary, database, "session", 1_700_000_001_000)).toBeNull()

    putDocument(database, { id: "orc", type: "token", parentId: "cena", data: { name: "Orc ferido" } })
    expect(await snapshots.create(summary, database, "manual", 1_700_000_002_000)).not.toBeNull()

    store.close()
    await snapshots.restore(summary, first!.id)
    const restored = new WorldDatabase(join(summary.path, "world.db"))
    expect(restored.get("orc")?.data).toMatchObject({ name: "Orc" })
    restored.close()
    // O estado de antes da restauração também virou snapshot.
    expect((await snapshots.list(summary.id)).map((snapshot) => snapshot.reason)).toContain("before-restore")
  })

  it(`mantém só os ${MAX_SNAPSHOTS} mais recentes`, async () => {
    const { summary, database } = await worldWithContent()
    const snapshots = new SnapshotStore(join(root, "snapshots"))
    for (let index = 0; index < MAX_SNAPSHOTS + 3; index += 1) {
      putDocument(database, { id: "orc", type: "token", parentId: "cena", data: { name: `Orc ${index}` } })
      await snapshots.create(summary, database, "manual", 1_700_000_000_000 + index * 1000)
    }
    const list = await snapshots.list(summary.id)
    expect(list).toHaveLength(MAX_SNAPSHOTS)
    expect(list[0]!.createdAt).toBe(1_700_000_000_000 + (MAX_SNAPSHOTS + 2) * 1000)
  })

  it("recusa ids de snapshot que tentam sair da pasta", async () => {
    const { summary } = await worldWithContent()
    const snapshots = new SnapshotStore(join(root, "snapshots"))
    await expect(snapshots.remove(summary.id, "../world.db")).rejects.toThrow(/inválido/)
    await expect(snapshots.list("../x")).rejects.toThrow(/inválido/)
  })
})

