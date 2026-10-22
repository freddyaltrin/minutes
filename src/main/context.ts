import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { Database } from './db/database'
import { NotesRepo } from './db/notes-repo'
import { TranscriptsRepo } from './db/transcripts-repo'
import { SearchRepo } from './db/search-repo'
import { SettingsRepo } from './db/settings-repo'
import { CalendarRepo } from './db/calendar-repo'
import { EVENT_CHANNELS, type EventName } from '@shared/api'

export interface Paths {
  userData: string
  database: string
  recordings: string
  backups: string
  exports: string
  logs: string
  temp: string
}

export function resolvePaths(userData = process.env.MINUTES_USER_DATA ?? app.getPath('userData')): Paths {
  const p: Paths = {
    userData,
    database: join(userData, 'data', 'minutes.sqlite'),
    recordings: join(userData, 'recordings'),
    backups: join(userData, 'backups'),
    exports: join(app.getPath('documents'), 'Minutes'),
    logs: join(userData, 'logs'),
    temp: join(app.getPath('temp'), 'minutes')
  }
  for (const dir of [join(userData, 'data'), p.recordings, p.backups, p.logs, p.temp]) mkdirSync(dir, { recursive: true })
  return p
}

export class Logger {
  private file: string
  constructor(dir: string) {
    this.file = join(dir, 'minutes.log')
    this.rotate()
  }
  private rotate(): void {
    try {
      if (existsSync(this.file) && statSync(this.file).size > 2_000_000) renameSync(this.file, this.file + '.1')
    } catch {
      /* ignore */
    }
  }
  write(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
    const line = `${new Date().toISOString()} [${level}] ${message}${detail !== undefined ? ' ' + safeJson(detail) : ''}\n`
    try {
      appendFileSync(this.file, line)
    } catch {
      /* ignore */
    }
    if (level === 'error') console.error(line.trim())
    else if (process.env.NODE_ENV !== 'production') console.log(line.trim())
  }
  info = (m: string, d?: unknown): void => this.write('info', m, d)
  warn = (m: string, d?: unknown): void => this.write('warn', m, d)
  error = (m: string, d?: unknown): void => this.write('error', m, d)
}

function safeJson(v: unknown): string {
  try {
    if (v instanceof Error) return JSON.stringify({ message: v.message, stack: v.stack })
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** Everything the IPC handlers and services need. Created once at startup. */
export class AppContext {
  readonly db: Database
  readonly notes: NotesRepo
  readonly transcripts: TranscriptsRepo
  readonly search: SearchRepo
  readonly settings: SettingsRepo
  readonly calendar: CalendarRepo
  readonly log: Logger
  readonly startedAt = Date.now()
  mainWindow: BrowserWindow | null = null

  constructor(readonly paths: Paths) {
    this.log = new Logger(paths.logs)
    this.db = new Database(paths.database)
    this.notes = new NotesRepo(this.db)
    this.transcripts = new TranscriptsRepo(this.db)
    this.search = new SearchRepo(this.db)
    this.settings = new SettingsRepo(this.db)
    this.calendar = new CalendarRepo(this.db)
  }

  /** Sends an event to every renderer window. */
  emit(name: EventName, payload?: unknown): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNELS[name], payload)
    }
  }

  notesChanged(ids: string[]): void {
    this.emit('notesChanged', { ids })
  }

  close(): void {
    this.db.close()
  }
}
