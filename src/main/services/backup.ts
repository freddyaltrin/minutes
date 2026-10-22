import { app, dialog, shell } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, renameSync } from 'node:fs'
import type { AppContext } from '../context'
import type { BackupInfo, StorageInfo } from '@shared/types'
import { Database } from '../db/database'

const BACKUP_PREFIX = 'minutes-backup-'

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else {
      try {
        total += statSync(p).size
      } catch {
        /* ignore */
      }
    }
  }
  return total
}

export class BackupService {
  /** Set by main.ts: performs a graceful restart after a restore. */
  onRestoreApplied: (() => void) | null = null

  constructor(private readonly ctx: AppContext, private readonly recordingsBytes: () => number) {}

  private backupInfo(path: string): BackupInfo {
    const st = statSync(path)
    const insp = Database.inspect(path)
    return { path, createdAt: st.mtimeMs, sizeBytes: st.size, noteCount: insp.noteCount, appVersion: '' }
  }

  create(kind: 'manual' | 'auto' = 'manual'): BackupInfo {
    mkdirSync(this.ctx.paths.backups, { recursive: true })
    const name = `${BACKUP_PREFIX}${kind === 'auto' ? 'auto-' : ''}${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`
    const dest = join(this.ctx.paths.backups, name)
    this.ctx.db.backupTo(dest)
    this.ctx.log.info('backup created', { dest })
    return { ...this.backupInfo(dest), appVersion: app.getVersion() }
  }

  list(): BackupInfo[] {
    if (!existsSync(this.ctx.paths.backups)) return []
    return readdirSync(this.ctx.paths.backups)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.sqlite'))
      .map((f) => this.backupInfo(join(this.ctx.paths.backups, f)))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Keeps the newest `keep` automatic backups. Manual backups and pre-restore safety copies are never pruned. */
  prune(keep = 10): void {
    const auto = this.list().filter((b) => b.path.includes(`${BACKUP_PREFIX}auto-`))
    for (const b of auto.slice(keep)) {
      try {
        rmSync(b.path, { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Restores a backup. The live database is first copied aside (never deleted), the user is warned
   * when the backup is older or has fewer notes than the current data, and the app restarts afterwards.
   */
  async restore(path?: string): Promise<{ restored: boolean; restartRequired: boolean; error: string | null }> {
    const win = this.ctx.mainWindow ?? undefined
    let source = path
    if (!source) {
      const res = await dialog.showOpenDialog(win!, {
        title: 'Choose a Minutes backup to restore',
        defaultPath: this.ctx.paths.backups,
        filters: [{ name: 'Minutes database', extensions: ['sqlite', 'db'] }],
        properties: ['openFile']
      })
      if (res.canceled || res.filePaths.length === 0) return { restored: false, restartRequired: false, error: null }
      source = res.filePaths[0]
    }
    const insp = Database.inspect(source)
    if (!insp.ok) return { restored: false, restartRequired: false, error: `That file is not a readable Minutes database: ${insp.error}` }
    const currentNotes = this.ctx.notes.counts()
    const currentTotal = currentNotes.all + currentNotes.archived + currentNotes.favorites
    const backupTime = statSync(source).mtimeMs
    const newer = this.ctx.db.get<{ m: number | null }>('SELECT MAX(updated_at) AS m FROM notes')?.m ?? 0
    const warnings: string[] = []
    if (insp.noteCount < currentTotal) warnings.push(`The backup has ${insp.noteCount} notes; you currently have ${currentTotal}.`)
    if (newer > backupTime) warnings.push('Your current notes were edited after this backup was made.')
    if (insp.schemaVersion > this.ctx.db.migrations().length) warnings.push('The backup was created by a newer version of Minutes.')
    const { response } = await dialog.showMessageBox(win!, {
      type: 'warning',
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Replace your current notes with this backup?',
      detail:
        (warnings.length ? warnings.join('\n') + '\n\n' : '') +
        'A copy of your current database will be kept in the backups folder before anything is replaced. Minutes will restart.'
    })
    if (response !== 0) return { restored: false, restartRequired: false, error: null }

    try {
      // 1. Safety copy of the live database.
      const safety = join(this.ctx.paths.backups, `${BACKUP_PREFIX}before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
      this.ctx.db.backupTo(safety)
      // 2. Close, swap files, done. The new DB is opened on restart (migrations run if needed).
      this.ctx.db.close()
      const live = this.ctx.paths.database
      for (const suffix of ['-wal', '-shm']) {
        const p = live + suffix
        if (existsSync(p)) rmSync(p, { force: true })
      }
      const staged = live + '.restore'
      copyFileSync(source, staged)
      renameSync(staged, live)
      this.ctx.log.info('backup restored', { source, safety })
      setTimeout(() => this.onRestoreApplied?.(), 300)
      return { restored: true, restartRequired: true, error: null }
    } catch (err) {
      this.ctx.log.error('restore failed', err)
      return { restored: false, restartRequired: true, error: (err as Error).message }
    }
  }

  async openBackupsFolder(): Promise<void> {
    mkdirSync(this.ctx.paths.backups, { recursive: true })
    await shell.openPath(this.ctx.paths.backups)
  }

  storageInfo(): StorageInfo {
    const counts = this.ctx.notes.counts()
    return {
      databasePath: this.ctx.paths.database,
      databaseBytes: this.ctx.db.sizeBytes(),
      recordingsPath: this.ctx.paths.recordings,
      recordingsBytes: this.recordingsBytes(),
      backupsPath: this.ctx.paths.backups,
      exportsPath: this.ctx.paths.exports,
      logsPath: this.ctx.paths.logs,
      noteCount: counts.all + counts.archived + counts.trash,
      transcriptCount: this.ctx.transcripts.count(),
      recordingCount: this.ctx.transcripts.allRecordings().length
    }
  }

  recordingsDirSize(): number {
    return dirSize(this.ctx.paths.recordings)
  }
}
