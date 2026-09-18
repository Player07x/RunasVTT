import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { isAssetPath } from "../shared/scene"
import { ASSET_KINDS, WORLD_ASSETS_DIR, WORLD_DATABASE_FILE, WORLD_MANIFEST_FILE, parseWorldManifest, worldFolderName, type WorldSummary } from "../shared/world"
import { MAX_ASSET_BYTES } from "./world-assets"
import { WorldDatabase } from "./world-database"
import { ZipReader, ZipWriter } from "./zip"

/** Snapshots guardados por mundo; os mais antigos saem primeiro. */
export const MAX_SNAPSHOTS = 15
const MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1")
/** Mídia já comprimida: deflate só gastaria tempo. */
const STORED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif", "mp3", "ogg", "m4a", "flac", "webm", "opus"])

import type { SnapshotInfo, SnapshotReason } from "../shared/ipc"

export type { SnapshotInfo, SnapshotReason }

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")

/** Copia o banco: pela conexão aberta (se o mundo estiver em uso) ou abrindo-o só para isso. */
function copyDatabase(world: WorldSummary, open: WorldDatabase | null, target: string): void {
  if (open) { open.copyTo(target); return }
  const database = new WorldDatabase(join(world.path, WORLD_DATABASE_FILE))
  try { database.copyTo(target) } finally { database.close() }
}

async function listAssetFiles(worldPath: string): Promise<string[]> {
  const files: string[] = []
  for (const kind of ASSET_KINDS) {
    const directory = join(worldPath, WORLD_ASSETS_DIR, kind)
    if (!existsSync(directory)) continue
    for (const name of await readdir(directory)) if (isAssetPath(`${kind}/${name}`)) files.push(`${kind}/${name}`)
  }
  return files
}

// ── Exportar e importar ─────────────────────────────────────────────────

/** Grava o mundo inteiro num .zip: manifesto, cópia consistente do banco e assets. */
export async function exportWorld(world: WorldSummary, open: WorldDatabase | null, target: string): Promise<{ files: number; bytes: number }> {
  const temporary = await mkdtemp(join(tmpdir(), "runas-vtt-export-"))
  const writer = await ZipWriter.create(target)
  try {
    const databaseCopy = join(temporary, WORLD_DATABASE_FILE)
    copyDatabase(world, open, databaseCopy)
    await writer.add({ name: WORLD_MANIFEST_FILE, data: await readFile(join(world.path, WORLD_MANIFEST_FILE)), compress: true })
    await writer.add({ name: WORLD_DATABASE_FILE, data: await readFile(databaseCopy), compress: true })
    const assets = await listAssetFiles(world.path)
    for (const path of assets) {
      const extension = path.split(".").pop() ?? ""
      await writer.add({ name: `${WORLD_ASSETS_DIR}/${path}`, data: await readFile(join(world.path, WORLD_ASSETS_DIR, path)), compress: !STORED_EXTENSIONS.has(extension) })
    }
    await writer.close()
    return { files: assets.length + 2, bytes: (await stat(target)).size }
  } catch (error) {
    await writer.abort()
    await unlink(target).catch(() => undefined)
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/**
 * Importa um .zip exportado pelo RunasVTT como um mundo novo. Só aceita
 * `world.json`, `world.db` e assets nomeados pelo hash (conferido). Se o
 * mundo já existe, a importação vira uma cópia com outro id.
 */
export async function importWorld(zipPath: string, worldsRoot: string, existing: WorldSummary[]): Promise<WorldSummary> {
  const reader = await ZipReader.open(zipPath)
  /** Só a pasta criada por esta importação pode ser apagada numa falha. */
  let created: string | null = null
  try {
    const entries = new Map(reader.entries.filter((entry) => !entry.name.endsWith("/")).map((entry) => [entry.name, entry]))
    for (const name of entries.keys()) {
      const allowed = name === WORLD_MANIFEST_FILE || name === WORLD_DATABASE_FILE || (name.startsWith(`${WORLD_ASSETS_DIR}/`) && isAssetPath(name.slice(WORLD_ASSETS_DIR.length + 1)))
      if (!allowed) throw new Error(`O .zip tem um arquivo inesperado: "${name}". Use um .zip exportado pelo RunasVTT.`)
    }
    const manifestEntry = entries.get(WORLD_MANIFEST_FILE)
    const databaseEntry = entries.get(WORLD_DATABASE_FILE)
    if (!manifestEntry || !databaseEntry) throw new Error("O .zip não tem world.json e world.db: não é um mundo do RunasVTT.")
    const manifest = parseWorldManifest(JSON.parse((await reader.read(manifestEntry, 1024 * 1024)).toString("utf8")))
    const database = await reader.read(databaseEntry, MAX_DATABASE_BYTES)
    if (!database.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) throw new Error("O world.db do .zip não é um banco SQLite.")

    const copy = existing.some((world) => world.id === manifest.id)
    const imported = copy ? { ...manifest, id: randomUUID(), title: `${manifest.title} (cópia)`.slice(0, 80) } : manifest
    const folder = join(worldsRoot, worldFolderName(imported.title, imported.id))
    if (existsSync(folder)) throw new Error("Já existe uma pasta para este mundo.")
    await mkdir(folder, { recursive: true })
    created = folder
    for (const kind of ASSET_KINDS) await mkdir(join(folder, WORLD_ASSETS_DIR, kind), { recursive: true })
    await writeFile(join(folder, WORLD_DATABASE_FILE), database)
    for (const [name, entry] of entries) {
      if (!name.startsWith(`${WORLD_ASSETS_DIR}/`)) continue
      const data = await reader.read(entry, MAX_ASSET_BYTES)
      if (!basename(name).startsWith(sha256(data))) throw new Error(`O arquivo "${name}" não confere com o próprio nome (hash): o .zip está alterado ou corrompido.`)
      await writeFile(join(folder, name), data)
    }
    // Abrir valida o esquema (versões futuras são recusadas) e aplica migrações.
    new WorldDatabase(join(folder, WORLD_DATABASE_FILE)).close()
    const now = Date.now()
    const final = { ...imported, updatedAt: now }
    await writeFile(join(folder, WORLD_MANIFEST_FILE), `${JSON.stringify(final, null, 2)}\n`, "utf8")
    return { ...final, path: folder }
  } catch (error) {
    if (created) await rm(created, { recursive: true, force: true })
    throw error
  } finally {
    await reader.close()
  }
}

// ── Snapshots ───────────────────────────────────────────────────────────

/**
 * Snapshots ficam fora da pasta do mundo (apagar o mundo não os leva junto)
 * e guardam só o banco: os assets têm nome pelo hash e nunca são apagados.
 */
export class SnapshotStore {
  constructor(private readonly root: string) {}

  private directory(worldId: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(worldId)) throw new Error("Mundo inválido.")
    return join(this.root, worldId)
  }

  async list(worldId: string): Promise<SnapshotInfo[]> {
    const directory = this.directory(worldId)
    if (!existsSync(directory)) return []
    const snapshots: SnapshotInfo[] = []
    for (const name of await readdir(directory)) {
      const match = /^(\d{13})-(session|manual|before-restore)\.db$/.exec(name)
      if (!match) continue
      snapshots.push({ id: name, createdAt: Number(match[1]), reason: match[2] as SnapshotReason, bytes: (await stat(join(directory, name))).size })
    }
    return snapshots.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Cria um snapshot; devolve `null` se nada mudou desde o último. */
  async create(world: WorldSummary, open: WorldDatabase | null, reason: SnapshotReason, now = Date.now()): Promise<SnapshotInfo | null> {
    const directory = this.directory(world.id)
    await mkdir(directory, { recursive: true })
    const id = `${now}-${reason}.db`
    const path = join(directory, id)
    copyDatabase(world, open, path)
    const latest = (await this.list(world.id)).find((snapshot) => snapshot.id !== id)
    if (latest && reason !== "before-restore") {
      const [current, previous] = await Promise.all([readFile(path), readFile(join(directory, latest.id))])
      if (sha256(current) === sha256(previous)) { await unlink(path); return null }
    }
    await this.prune(world.id)
    return { id, createdAt: now, reason, bytes: (await stat(path)).size }
  }

  /** Volta o banco do mundo (fechado) ao snapshot, guardando antes o estado atual. */
  async restore(world: WorldSummary, snapshotId: string): Promise<void> {
    const source = this.snapshotPath(world.id, snapshotId)
    await this.create(world, null, "before-restore")
    const target = join(world.path, WORLD_DATABASE_FILE)
    // O WAL e o índice compartilhado pertencem ao banco antigo.
    for (const suffix of ["-wal", "-shm"]) await unlink(`${target}${suffix}`).catch(() => undefined)
    await copyFile(source, target)
  }

  async remove(worldId: string, snapshotId: string): Promise<void> {
    await unlink(this.snapshotPath(worldId, snapshotId))
  }

  private snapshotPath(worldId: string, snapshotId: string): string {
    if (!/^\d{13}-(session|manual|before-restore)\.db$/.test(snapshotId)) throw new Error("Snapshot inválido.")
    const path = join(this.directory(worldId), snapshotId)
    if (!existsSync(path)) throw new Error("Snapshot não encontrado.")
    return path
  }

  private async prune(worldId: string): Promise<void> {
    const snapshots = await this.list(worldId)
    for (const old of snapshots.slice(MAX_SNAPSHOTS)) await unlink(join(this.directory(worldId), old.id)).catch(() => undefined)
  }
}
