import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  ASSET_KINDS,
  WORLD_ASSETS_DIR,
  WORLD_DATABASE_FILE,
  WORLD_MANIFEST_FILE,
  createWorldManifest,
  parseWorldManifest,
  worldFolderName,
  type NewWorldInput,
  type WorldManifest,
  type WorldSummary,
} from "../shared/world"
import { WorldDatabase } from "./world-database"

export interface OpenWorld {
  summary: WorldSummary
  database: WorldDatabase
}

/** Grava primeiro num arquivo temporário: uma queda no meio nunca deixa um manifesto pela metade. */
async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

/**
 * Gerencia a pasta de mundos. Só um mundo fica aberto por vez: o RunasVTT é
 * usado pelo mestre em uma única máquina (ADR 0001).
 */
export class WorldStore {
  private current: OpenWorld | null = null

  constructor(readonly root: string) {}

  get openWorld(): OpenWorld | null {
    return this.current
  }

  async list(): Promise<WorldSummary[]> {
    await mkdir(this.root, { recursive: true })
    const entries = await readdir(this.root, { withFileTypes: true })
    const worlds: WorldSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(this.root, entry.name)
      try {
        const manifest = parseWorldManifest(JSON.parse(await readFile(join(path, WORLD_MANIFEST_FILE), "utf8")))
        worlds.push({ ...manifest, path })
      } catch {
        // Pastas sem manifesto válido não são mundos; ficam intocadas.
      }
    }
    return worlds.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async create(input: NewWorldInput): Promise<WorldSummary> {
    const manifest = createWorldManifest(input, randomUUID(), Date.now())
    const path = join(this.root, worldFolderName(manifest.title, manifest.id))
    if (existsSync(path)) throw new Error("Já existe uma pasta com este nome.")
    await mkdir(path, { recursive: true })
    for (const kind of ASSET_KINDS) await mkdir(join(path, WORLD_ASSETS_DIR, kind), { recursive: true })
    new WorldDatabase(join(path, WORLD_DATABASE_FILE)).close()
    await writeJsonAtomically(join(path, WORLD_MANIFEST_FILE), manifest)
    return { ...manifest, path }
  }

  async open(id: string): Promise<OpenWorld> {
    if (this.current?.summary.id === id) return this.current
    const summary = (await this.list()).find((world) => world.id === id)
    if (!summary) throw new Error("Mundo não encontrado.")
    this.close()
    const database = new WorldDatabase(join(summary.path, WORLD_DATABASE_FILE))
    const touched: WorldManifest = { ...stripPath(summary), updatedAt: Date.now() }
    await writeJsonAtomically(join(summary.path, WORLD_MANIFEST_FILE), touched)
    this.current = { summary: { ...touched, path: summary.path }, database }
    return this.current
  }

  close(): void {
    this.current?.database.close()
    this.current = null
  }
}

function stripPath(summary: WorldSummary): WorldManifest {
  const { path: _path, ...manifest } = summary
  return manifest
}
