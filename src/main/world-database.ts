import { DatabaseSync } from "node:sqlite"
import { isDocumentType, type DocumentType, type WorldDocument } from "../shared/world"

/**
 * Migrações do `world.db`, aplicadas em ordem. Nunca edite uma migração já
 * publicada: acrescente a próxima. `PRAGMA user_version` guarda a última
 * aplicada.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE documents (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     parent_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
     sort REAL NOT NULL DEFAULT 0,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX documents_type ON documents(type);
   CREATE INDEX documents_parent ON documents(parent_id);`,
]

export const WORLD_SCHEMA_VERSION = MIGRATIONS.length

interface DocumentRow {
  id: string
  type: string
  parent_id: string | null
  sort: number
  data: string
  created_at: number
  updated_at: number
}

function toDocument(row: DocumentRow): WorldDocument {
  if (!isDocumentType(row.type)) throw new Error(`Tipo de documento desconhecido: ${row.type}`)
  return {
    id: row.id,
    type: row.type,
    parentId: row.parent_id,
    sort: row.sort,
    data: JSON.parse(row.data) as unknown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WorldDatabase {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
    this.migrate()
  }

  get schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    return row.user_version
  }

  private migrate(): void {
    const current = this.schemaVersion
    if (current > WORLD_SCHEMA_VERSION) throw new Error(`O banco do mundo usa o esquema ${current}, mais novo que o suportado (${WORLD_SCHEMA_VERSION}). Atualize o RunasVTT.`)
    for (let version = current; version < WORLD_SCHEMA_VERSION; version += 1) {
      this.db.exec("BEGIN")
      try {
        this.db.exec(MIGRATIONS[version] as string)
        this.db.exec(`PRAGMA user_version = ${version + 1}`)
        this.db.exec("COMMIT")
      } catch (error) {
        this.db.exec("ROLLBACK")
        throw error
      }
    }
  }

  put(document: WorldDocument): void {
    this.db.prepare(
      `INSERT INTO documents (id, type, parent_id, sort, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, parent_id = excluded.parent_id,
         sort = excluded.sort, data = excluded.data, updated_at = excluded.updated_at`,
    ).run(document.id, document.type, document.parentId, document.sort, JSON.stringify(document.data), document.createdAt, document.updatedAt)
  }

  get(id: string): WorldDocument | null {
    const row = this.db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined
    return row ? toDocument(row) : null
  }

  list(type: DocumentType, parentId?: string | null): WorldDocument[] {
    const rows = parentId === undefined
      ? this.db.prepare("SELECT * FROM documents WHERE type = ? ORDER BY sort, created_at").all(type)
      : parentId === null
        ? this.db.prepare("SELECT * FROM documents WHERE type = ? AND parent_id IS NULL ORDER BY sort, created_at").all(type)
        : this.db.prepare("SELECT * FROM documents WHERE type = ? AND parent_id = ? ORDER BY sort, created_at").all(type, parentId)
    return (rows as unknown as DocumentRow[]).map(toDocument)
  }

  /** Remove o documento e, pela chave estrangeira, tudo o que ele contém. */
  delete(id: string): void {
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id)
  }

  close(): void {
    this.db.close()
  }
}
