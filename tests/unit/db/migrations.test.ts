import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Database } from '../../../src/main/db/database'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { SettingsRepo } from '../../../src/main/db/settings-repo'
import { DEFAULT_SETTINGS } from '../../../src/shared/defaults'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'minutes-mig-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrations', () => {
  it('MIGRATIONS is ordered, append-only and LATEST_SCHEMA_VERSION matches', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
    expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
    expect(new Set(MIGRATIONS.map((m) => m.name)).size).toBe(MIGRATIONS.length)
  })

  it('a fresh database applies every migration and records them', () => {
    const db = new Database(':memory:')
    const applied = db.migrations()
    expect(applied.map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version))
    for (const m of applied) expect(m.appliedAt).toBeGreaterThan(0)
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").map((r) => r.name)
    for (const t of ['folders', 'notes', 'tags', 'note_tags', 'transcripts', 'transcript_segments', 'extractions', 'recordings', 'settings', 'calendar_sources', 'calendar_events', 'notes_fts', 'segments_fts', 'extractions_fts', 'schema_migrations']) {
      expect(tables, t).toContain(t)
    }
    expect(Object.values(db.get('PRAGMA foreign_keys')!)[0]).toBe(1)
    expect(db.sqliteVersion()).toMatch(/^\d+\.\d+/)
    db.close()
  })

  it('re-opening an existing file is idempotent and keeps data', () => {
    const path = join(tmp(), 'data', 'm.sqlite')
    const db1 = new Database(path)
    const notes1 = new NotesRepo(db1)
    const n = notes1.create({ title: 'Persist me', bodyText: 'body' })
    const first = db1.migrations()
    db1.close()
    expect(existsSync(path)).toBe(true)

    const db2 = new Database(path)
    expect(db2.migrations()).toEqual(first) // same versions and applied_at timestamps: nothing re-ran
    expect(new NotesRepo(db2).get(n.id)?.title).toBe('Persist me')
    db2.close()
  })

  it('a database that stopped at migration 1 receives the later ones on open', () => {
    const path = join(tmp(), 'm.sqlite')
    // Build the v1 schema by hand (exactly what an old install would have).
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
    raw.exec(MIGRATIONS[0].sql)
    raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(1, MIGRATIONS[0].name, 1000)
    raw.prepare("INSERT INTO notes (id, title, created_at, updated_at) VALUES ('old1', 'legacy', 1, 1)").run()
    raw.close()

    const db = new Database(path)
    const applied = db.migrations()
    expect(applied).toHaveLength(MIGRATIONS.length)
    expect(applied[0]).toEqual({ version: 1, appliedAt: 1000 }) // untouched
    for (const m of applied.slice(1)) expect(m.appliedAt).toBeGreaterThan(1000)
    expect(new NotesRepo(db).get('old1')?.title).toBe('legacy')
    db.close()
  })

  it('a failed migration rolls back and leaves no record', () => {
    const path = join(tmp(), 'm.sqlite')
    const bad = { version: MIGRATIONS.length + 1, name: 'broken', sql: 'CREATE TABLE ok_table (x); CREATE TABLE notes (dup);' }
    MIGRATIONS.push(bad)
    try {
      expect(() => new Database(path)).toThrow()
    } finally {
      MIGRATIONS.pop()
    }
    const db = new Database(path)
    expect(db.migrations().map((m) => m.version)).toEqual(MIGRATIONS.map((m) => m.version))
    expect(db.all("SELECT name FROM sqlite_master WHERE name = 'ok_table'")).toEqual([])
    db.close()
  })

  it('Database.inspect reports schema version and live note count; rejects non-databases', () => {
    const dir = tmp()
    const path = join(dir, 'm.sqlite')
    const db = new Database(path)
    const notes = new NotesRepo(db)
    notes.create({ title: 'a' })
    const t = notes.create({ title: 'b' })
    notes.trash(t.id)
    db.checkpoint()
    expect(Database.inspect(path)).toEqual({ ok: true, noteCount: 1, schemaVersion: LATEST_SCHEMA_VERSION, error: null })
    db.close()
    const junk = join(dir, 'junk.sqlite')
    require('node:fs').writeFileSync(junk, 'this is not sqlite')
    const bad = Database.inspect(junk)
    expect(bad.ok).toBe(false)
    expect(bad.error).toBeTruthy()
    expect(Database.inspect(join(dir, 'missing.sqlite')).ok).toBe(false)
  })

  it('transactions nest and roll back as a unit', () => {
    const db = new Database(':memory:')
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO folders (id, name, created_at) VALUES ('f1', 'x', 1)")
        db.transaction(() => {
          db.run("INSERT INTO folders (id, name, created_at) VALUES ('f2', 'y', 1)")
          throw new Error('boom')
        })
      })
    ).toThrow('boom')
    expect(db.all('SELECT id FROM folders')).toEqual([])
    const v = db.transaction(() => {
      db.run("INSERT INTO folders (id, name, created_at) VALUES ('f3', 'z', 1)")
      return 42
    })
    expect(v).toBe(42)
    expect(db.all('SELECT id FROM folders')).toEqual([{ id: 'f3' }])
    db.close()
  })
})

describe('SettingsRepo', () => {
  it('get merges stored values over defaults, including newly added keys and shortcuts', () => {
    const db = new Database(':memory:')
    db.run("INSERT INTO settings (key, value_json) VALUES ('settings', ?)", JSON.stringify({ theme: 'dark', audio: { keepRecordings: true }, shortcuts: { 'note.new': 'Ctrl+Alt+N' }, unknownKey: 1 }))
    const s = new SettingsRepo(db).get()
    expect(s.theme).toBe('dark')
    expect(s.audio).toEqual({ ...DEFAULT_SETTINGS.audio, keepRecordings: true })
    expect(s.transcription).toEqual(DEFAULT_SETTINGS.transcription)
    expect(s.shortcuts['note.new']).toBe('Ctrl+Alt+N')
    expect(s.shortcuts['nav.search']).toBe(DEFAULT_SETTINGS.shortcuts['nav.search'])
    expect((s as unknown as Record<string, unknown>).unknownKey).toBe(1) // unknown keys are preserved, not dropped
    db.close()
  })

  it('tolerates corrupt JSON by falling back to defaults', () => {
    const db = new Database(':memory:')
    db.run("INSERT INTO settings (key, value_json) VALUES ('settings', '{not json')")
    expect(new SettingsRepo(db).get()).toEqual(DEFAULT_SETTINGS)
    db.close()
  })

  it('set deep-merges, persists, and survives a reopen', () => {
    const path = join(tmp(), 'm.sqlite')
    const db = new Database(path)
    const repo = new SettingsRepo(db)
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
    const next = repo.set({ theme: 'light', audio: { ...DEFAULT_SETTINGS.audio, autoStopSilenceMin: 5 }, recentSearches: ['a', 'b'] })
    expect(next.theme).toBe('light')
    expect(next.audio.autoStopSilenceMin).toBe(5)
    expect(next.audio.captureSystemAudio).toBe(true)
    expect(next.recentSearches).toEqual(['a', 'b'])
    // partial nested patch keeps the other nested keys
    const again = repo.set({ audio: { micDeviceId: 'mic-1' } as never })
    expect(again.audio).toEqual({ ...DEFAULT_SETTINGS.audio, autoStopSilenceMin: 5, micDeviceId: 'mic-1' })
    // arrays are replaced, not merged
    expect(repo.set({ recentSearches: ['c'] }).recentSearches).toEqual(['c'])
    db.close()

    const db2 = new Database(path)
    const s = new SettingsRepo(db2).get()
    expect(s.theme).toBe('light')
    expect(s.audio.micDeviceId).toBe('mic-1')
    expect(s.recentSearches).toEqual(['c'])
    db2.close()
  })

  it('reset restores defaults without touching notes or other setting keys', () => {
    const db = new Database(':memory:')
    const repo = new SettingsRepo(db)
    const notes = new NotesRepo(db)
    const n = notes.create({ title: 'keep', bodyText: 'x' })
    repo.set({ theme: 'dark', lastNoteId: n.id })
    repo.setValue('windowBounds', { width: 1, height: 2 })
    const after = repo.reset()
    expect(after).toEqual(DEFAULT_SETTINGS)
    expect(repo.get()).toEqual(DEFAULT_SETTINGS)
    expect(notes.get(n.id)?.title).toBe('keep')
    expect(repo.getValue('windowBounds', null)).toEqual({ width: 1, height: 2 })
    db.close()
  })

  it('getValue / setValue handle arbitrary keys with fallbacks', () => {
    const db = new Database(':memory:')
    const repo = new SettingsRepo(db)
    expect(repo.getValue('nope', 7)).toBe(7)
    repo.setValue('lastAutoBackupAt', 123)
    expect(repo.getValue('lastAutoBackupAt', 0)).toBe(123)
    repo.setValue('lastAutoBackupAt', 456)
    expect(repo.getValue('lastAutoBackupAt', 0)).toBe(456)
    db.run("UPDATE settings SET value_json = 'garbage' WHERE key = 'lastAutoBackupAt'")
    expect(repo.getValue('lastAutoBackupAt', -1)).toBe(-1)
    db.close()
  })
})
