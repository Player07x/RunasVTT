import { DatabaseSync } from "node:sqlite"

export interface MirroredResponse {
  url: string
  status: number
  contentType: string
  body: Uint8Array
  storedAt: number
}

/** Cabeçalhos preservados ao servir da cópia local. */
const KEPT_HEADERS = ["content-type", "service-worker-allowed"] as const

/**
 * Cópia local dos sites: um único SQLite em `userData/site-mirror.db`.
 * Uma linha por URL; gravar de novo substitui a versão anterior.
 */
export class SiteMirror {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS responses (
        url TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        status INTEGER NOT NULL,
        headers TEXT NOT NULL,
        body BLOB NOT NULL,
        stored_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS responses_origin ON responses(origin);`)
  }

  get(url: string): MirroredResponse | null {
    const row = this.db.prepare("SELECT url, status, headers, body, stored_at FROM responses WHERE url = ?").get(url) as
      | { url: string; status: number; headers: string; body: Uint8Array; stored_at: number }
      | undefined
    if (!row) return null
    const headers = JSON.parse(row.headers) as Record<string, string>
    return { url: row.url, status: row.status, contentType: headers["content-type"] ?? "application/octet-stream", body: row.body, storedAt: row.stored_at }
  }

  put(url: string, status: number, headers: { get(name: string): string | null }, body: Uint8Array): void {
    const kept: Record<string, string> = {}
    for (const name of KEPT_HEADERS) {
      const value = headers.get(name)
      if (value) kept[name] = value
    }
    this.db.prepare(
      `INSERT INTO responses (url, origin, status, headers, body, stored_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET status = excluded.status, headers = excluded.headers, body = excluded.body, stored_at = excluded.stored_at`,
    ).run(url, new URL(url).origin, status, JSON.stringify(kept), body, Date.now())
  }

  has(url: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM responses WHERE url = ?").get(url))
  }

  stats(origin: string): { entries: number; bytes: number; lastStoredAt: number | null } {
    const row = this.db.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(body)), 0) AS bytes, MAX(stored_at) AS last FROM responses WHERE origin = ?").get(origin) as
      { entries: number; bytes: number; last: number | null }
    return { entries: row.entries, bytes: row.bytes, lastStoredAt: row.last }
  }

  /**
   * Remove arquivos de uma origem que nenhuma atualização tocou desde
   * `olderThan`: sobras de builds antigos, cujos nomes com hash não voltam.
   */
  prune(origin: string, olderThan: number): number {
    return Number(this.db.prepare("DELETE FROM responses WHERE origin = ? AND stored_at < ?").run(origin, olderThan).changes)
  }

  close(): void {
    this.db.close()
  }
}
