import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }))
const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] as string[] }))
const openPath = vi.fn(async () => '')

vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9-test', getPath: () => '/tmp', isPackaged: false },
  dialog: { showMessageBox: (...a: unknown[]) => showMessageBox(...(a as [])), showOpenDialog: (...a: unknown[]) => showOpenDialog(...(a as [])) },
  shell: { openPath: (...a: unknown[]) => openPath(...(a as [])) },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { TranscriptsRepo } from '../../../src/main/db/transcripts-repo'
import { BackupService } from '../../../src/main/services/backup'
import type { AppContext, Paths } from '../../../src/main/context'

interface Harness {
  ctx: AppContext
  svc: BackupService
  paths: Paths
  logs: string[]
  reopen: () => void
  close: () => void
}

let root: string
let h: Harness

function makeHarness(dir: string): Harness {
  const paths: Paths = {
    userData: dir,
    database: join(dir, 'data', 'm.sqlite'),
    recordings: join(dir, 'recordings'),
    backups: join(dir, 'backups'),
    exports: join(dir, 'exports'),
    logs: join(dir, 'logs'),
    temp: join(dir, 'temp')
  }
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(`info ${m}`), warn: (m: string) => logs.push(`warn ${m}`), error: (m: string) => logs.push(`error ${m}`) }
  const open = (): { db: Database; notes: NotesRepo; transcripts: TranscriptsRepo } => {
    const db = new Database(paths.database)
    return { db, notes: new NotesRepo(db), transcripts: new TranscriptsRepo(db) }
  }
  let live = open()
  const ctx = {
    paths,
    log,
    mainWindow: null,
    get db() {
      return live.db
    },
    get notes() {
      return live.notes
    },
    get transcripts() {
      return live.transcripts
    }
  } as unknown as AppContext
  const svc = new BackupService(ctx, () => 4321)
  return {
    ctx,
    svc,
    paths,
    logs,
    reopen: () => {
      live = open()
    },
    close: () => {
      try {
        live.db.close()
      } catch {
        /* already closed */
      }
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'minutes-backup-'))
  h = makeHarness(root)
  showMessageBox.mockClear()
  showOpenDialog.mockClear()
  openPath.mockClear()
})
afterEach(() => {
  h.close()
  rmSync(root, { recursive: true, force: true })
})

const backupFiles = (): string[] => (existsSync(h.paths.backups) ? readdirSync(h.paths.backups).sort() : [])

describe('BackupService.create / list / prune', () => {
  it('create() writes a readable, consistent copy with the current note count and app version', () => {
    h.ctx.notes.create({ title: 'one', bodyText: 'a' })
    h.ctx.notes.create({ title: 'two', bodyText: 'b' })
    const trashed = h.ctx.notes.create({ title: 'three' })
    h.ctx.notes.trash(trashed.id)
    const info = h.svc.create()
    expect(info.path.startsWith(h.paths.backups)).toBe(true)
    expect(info.path).toMatch(/minutes-backup-\d{4}-\d{2}-\d{2}T.*\.sqlite$/)
    expect(info.appVersion).toBe('9.9.9-test')
    expect(info.noteCount).toBe(2) // live (non-trashed) notes
    expect(info.sizeBytes).toBeGreaterThan(0)
    expect(info.createdAt).toBeGreaterThan(0)
    const insp = Database.inspect(info.path)
    expect(insp.ok).toBe(true)
    expect(insp.noteCount).toBe(2)
    expect(insp.schemaVersion).toBe(h.ctx.db.migrations().length)
    // The copy is a standalone database: it opens and contains the rows.
    const copy = new Database(info.path)
    expect(new NotesRepo(copy).list({ view: 'all' }).map((n) => n.title).sort()).toEqual(['one', 'two'])
    copy.close()
    expect(h.logs.some((l) => l.includes('backup created'))).toBe(true)
  })

  it('list() is empty without a backups folder and sorts newest first', () => {
    rmSync(h.paths.backups, { recursive: true, force: true })
    expect(h.svc.list()).toEqual([])
    const a = h.svc.create()
    const b = h.svc.create()
    const c = h.svc.create()
    // Make mtimes unambiguous regardless of filesystem timestamp resolution.
    const base = Date.now() - 100_000
    utimesSync(a.path, new Date(base + 1000), new Date(base + 1000))
    utimesSync(b.path, new Date(base + 3000), new Date(base + 3000))
    utimesSync(c.path, new Date(base + 2000), new Date(base + 2000))
    // Unrelated files are ignored.
    writeFileSync(join(h.paths.backups, 'notes.txt'), 'x')
    writeFileSync(join(h.paths.backups, 'other.sqlite'), 'x')
    const list = h.svc.list()
    expect(list.map((x) => x.path)).toEqual([b.path, c.path, a.path])
    expect(list.every((x) => x.noteCount === 0 && x.appVersion === '')).toBe(true)
  })

  it('prune(keep) deletes the oldest automatic backups beyond keep and never touches manual ones', () => {
    const manual = h.svc.create('manual')
    const made = [h.svc.create('auto'), h.svc.create('auto'), h.svc.create('auto'), h.svc.create('auto')]
    const base = Date.now() - 100_000
    utimesSync(manual.path, new Date(base - 5000), new Date(base - 5000))
    made.forEach((m, i) => utimesSync(m.path, new Date(base + i * 1000), new Date(base + i * 1000)))
    h.svc.prune(2)
    const remaining = h.svc.list().map((x) => x.path)
    expect(remaining).toEqual([made[3].path, made[2].path, manual.path])
    expect(existsSync(made[0].path)).toBe(false)
    expect(existsSync(made[1].path)).toBe(false)
    h.svc.prune(0)
    expect(backupFiles()).toEqual([expect.stringContaining('minutes-backup-20')])
  })
})

describe('BackupService.restore', () => {
  it('replaces the live database after confirmation, keeping a safety copy and signalling restart', async () => {
    // Backup containing a note the live DB will not have.
    const n = h.ctx.notes.create({ title: 'from backup', bodyText: 'restore me' })
    const backup = h.svc.create()
    h.ctx.notes.destroy(n.id)
    h.ctx.notes.create({ title: 'live only' })
    h.ctx.notes.create({ title: 'live two' })
    const applied = vi.fn()
    h.svc.onRestoreApplied = applied
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })

    const res = await h.svc.restore(backup.path)
    expect(res).toEqual({ restored: true, restartRequired: true, error: null })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const opts = (showMessageBox.mock.calls[0] as unknown[])[1] as { detail: string; buttons: string[] }
    expect(opts.buttons[0]).toMatch(/Restore/)
    expect(opts.detail).toMatch(/The backup has 1 notes; you currently have 2/)
    expect(opts.detail).toMatch(/edited after this backup/)

    // Safety copy was made and holds the live data.
    const safety = backupFiles().find((f) => f.includes('before-restore-'))
    expect(safety).toBeDefined()
    const safetyInsp = Database.inspect(join(h.paths.backups, safety!))
    expect(safetyInsp.ok).toBe(true)
    expect(safetyInsp.noteCount).toBe(2)

    // The live file is now the backup. No stale WAL/SHM left behind.
    expect(existsSync(h.paths.database + '-wal')).toBe(false)
    expect(existsSync(h.paths.database + '.restore')).toBe(false)
    h.reopen()
    expect(h.ctx.notes.list({ view: 'all' }).map((x) => x.title)).toEqual(['from backup'])

    expect(applied).not.toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 400))
    expect(applied).toHaveBeenCalledTimes(1)
    expect(h.logs.some((l) => l.includes('backup restored'))).toBe(true)
  })

  it('does nothing when the user cancels', async () => {
    h.ctx.notes.create({ title: 'keep' })
    const backup = h.svc.create()
    const applied = vi.fn()
    h.svc.onRestoreApplied = applied
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false })
    const before = backupFiles()
    const res = await h.svc.restore(backup.path)
    expect(res).toEqual({ restored: false, restartRequired: false, error: null })
    expect(backupFiles()).toEqual(before) // no safety copy
    expect(h.ctx.notes.list({ view: 'all' }).map((x) => x.title)).toEqual(['keep']) // db still open & intact
    await new Promise((r) => setTimeout(r, 350))
    expect(applied).not.toHaveBeenCalled()
  })

  it('rejects a file that is not a Minutes database without prompting', async () => {
    const junk = join(root, 'junk.sqlite')
    writeFileSync(junk, 'definitely not sqlite')
    const res = await h.svc.restore(junk)
    expect(res.restored).toBe(false)
    expect(res.restartRequired).toBe(false)
    expect(res.error).toMatch(/not a readable Minutes database/)
    expect(showMessageBox).not.toHaveBeenCalled()
    // An empty valid SQLite file without our schema is also rejected.
    const empty = join(root, 'empty.sqlite')
    const raw = new (await import('node:sqlite')).DatabaseSync(empty)
    raw.close()
    const res2 = await h.svc.restore(empty)
    expect(res2.restored).toBe(false)
    expect(res2.error).toMatch(/not a readable Minutes database/)
  })

  it('without a path, uses the open dialog and returns quietly when cancelled', async () => {
    showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const res = await h.svc.restore()
    expect(res).toEqual({ restored: false, restartRequired: false, error: null })
    expect(showOpenDialog).toHaveBeenCalledTimes(1)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('without a path, restores the file chosen in the dialog', async () => {
    h.ctx.notes.create({ title: 'chosen' })
    const backup = h.svc.create()
    showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [backup.path] })
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    h.svc.onRestoreApplied = null
    const res = await h.svc.restore()
    expect(res.restored).toBe(true)
    h.reopen()
    expect(h.ctx.notes.list({ view: 'all' }).map((x) => x.title)).toEqual(['chosen'])
    await new Promise((r) => setTimeout(r, 350))
  })
})

describe('BackupService.storageInfo / recordingsDirSize / openBackupsFolder', () => {
  it('reports paths, sizes and counts', () => {
    const a = h.ctx.notes.create({ title: 'a' })
    const b = h.ctx.notes.create({ title: 'b' })
    const c = h.ctx.notes.create({ title: 'c' })
    h.ctx.notes.update(b.id, { archived: true })
    h.ctx.notes.trash(c.id)
    h.ctx.transcripts.ensure(a.id, 'manual', null, null)
    h.ctx.transcripts.addRecording({ noteId: a.id, path: '/x.wav', startedAt: 1, durationMs: 1, sizeBytes: 1, sampleRate: 16000, channels: 1 })
    const info = h.svc.storageInfo()
    expect(info).toEqual({
      databasePath: h.paths.database,
      databaseBytes: expect.any(Number),
      recordingsPath: h.paths.recordings,
      recordingsBytes: 4321,
      backupsPath: h.paths.backups,
      exportsPath: h.paths.exports,
      logsPath: h.paths.logs,
      noteCount: 3,
      transcriptCount: 1,
      recordingCount: 1
    })
    expect(info.databaseBytes).toBeGreaterThan(0)
    expect(info.databaseBytes).toBeGreaterThanOrEqual(statSync(h.paths.database).size)
  })

  it('recordingsDirSize sums files recursively and tolerates a missing folder', () => {
    expect(h.svc.recordingsDirSize()).toBe(0)
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(h.paths.recordings, 'sub'), { recursive: true })
    writeFileSync(join(h.paths.recordings, 'a.wav'), Buffer.alloc(100))
    writeFileSync(join(h.paths.recordings, 'sub', 'b.wav'), Buffer.alloc(50))
    expect(h.svc.recordingsDirSize()).toBe(150)
  })

  it('openBackupsFolder creates the folder and opens it', async () => {
    rmSync(h.paths.backups, { recursive: true, force: true })
    await h.svc.openBackupsFolder()
    expect(existsSync(h.paths.backups)).toBe(true)
    expect(openPath).toHaveBeenCalledWith(h.paths.backups)
  })
})
