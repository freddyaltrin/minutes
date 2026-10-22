import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations'

export type Row = Record<string, SQLInputValue>

export interface MigrationRecord {
  version: number
  appliedAt: number
}

/**
 * Thin wrapper over node:sqlite providing migrations, transactions and typed helpers.
 * All access happens on the main process; the renderer never touches SQLite.
 */
export class Database {
  readonly db: DatabaseSync
  readonly path: string
  private txDepth = 0

  constructor(path: string) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`)
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version)
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue
      this.transaction(() => {
        this.db.exec(m.sql)
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, Date.now())
      })
    }
  }

  migrations(): MigrationRecord[] {
    return this.db.prepare('SELECT version, applied_at AS appliedAt FROM schema_migrations ORDER BY version').all() as unknown as MigrationRecord[]
  }

  sqliteVersion(): string {
    return (this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
  }

  /** Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++
      try {
        return fn()
      } finally {
        this.txDepth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth = 1
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    } finally {
      this.txDepth = 0
    }
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.db.prepare(sql).run(...params)
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  /** Safe, consistent copy of the live database (WAL-aware) using SQLite's VACUUM INTO. */
  backupTo(destination: string): void {
    mkdirSync(dirname(destination), { recursive: true })
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.prepare('VACUUM INTO ?').run(destination)
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* ignore */
    }
    this.db.close()
  }

  sizeBytes(): number {
    if (this.path === ':memory:' || !existsSync(this.path)) return 0
    let size = statSync(this.path).size
    const wal = this.path + '-wal'
    if (existsSync(wal)) size += statSync(wal).size
    return size
  }

  /** Verifies a file is a readable SQLite database with our schema. */
  static inspect(path: string): { ok: boolean; noteCount: number; schemaVersion: number; error: string | null } {
    try {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
        const n = db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL').get() as { n: number }
        return { ok: true, noteCount: Number(n.n), schemaVersion: Number(v.v ?? 0), error: null }
      } finally {
        db.close()
      }
    } catch (err) {
      return { ok: false, noteCount: 0, schemaVersion: 0, error: (err as Error).message }
    }
  }

  static copyFile(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

export const bool = (v: boolean | undefined | null): number => (v ? 1 : 0)
export const nowMs = (): number => Date.now()
