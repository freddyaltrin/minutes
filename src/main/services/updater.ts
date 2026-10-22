import { app, net } from 'electron'
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater'
import type { AppContext } from '../context'
import type { UpdateState } from '@shared/types'

const FIRST_CHECK_DELAY_MS = 30_000
const BACKGROUND_INTERVAL_MS = 6 * 3_600_000
const PROGRESS_EMIT_INTERVAL_MS = 250 // at most 4 emits per second

export interface UpdaterOptions {
  /** Should be `app.isPackaged`. Dev builds have no latest.yml to compare against. */
  enabled: boolean
}

/**
 * Thin, state-machine style wrapper over electron-updater. Updates are only ever offered on packaged
 * Windows builds; everywhere else the service reports `disabled` and every call is a harmless no-op.
 * Nothing here can block startup: checks run after a delay, errors become an 'error' state and the
 * offline case is short-circuited before the network is touched.
 */
export class UpdaterService {
  private state: UpdateState
  private readonly disabledReason: string | null
  private timers: NodeJS.Timeout[] = []
  private lastProgressEmit = 0
  private wired = false

  constructor(
    private readonly ctx: AppContext,
    opts: UpdaterOptions
  ) {
    this.disabledReason = !opts.enabled
      ? 'Updates are only available in the installed (packaged) build.'
      : process.platform !== 'win32'
        ? `Automatic updates are only published for Windows (this is ${process.platform}).`
        : null
    this.state = {
      status: this.disabledReason ? 'disabled' : 'idle',
      currentVersion: safeVersion(),
      availableVersion: null,
      releaseNotes: null,
      releaseDate: null,
      progress: null,
      error: this.disabledReason,
      checkedAt: null
    }
    if (!this.disabledReason) this.configure()
  }

  getState(): UpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null }
  }

  /** Checks GitHub Releases for a newer version. Resolves (never rejects) with the resulting state. */
  async check(): Promise<UpdateState> {
    if (this.disabledReason) return this.getState()
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.getState()
    if (!isOnline()) {
      this.set({ status: 'error', error: 'You are offline. Update check skipped.', checkedAt: Date.now() })
      return this.getState()
    }
    this.set({ status: 'checking', error: null })
    try {
      const result = await autoUpdater.checkForUpdates()
      const info = result?.updateInfo
      const checkedAt = Date.now()
      if (result && info && result.isUpdateAvailable) {
        this.set({
          status: 'available',
          availableVersion: info.version,
          releaseNotes: notesToString(info.releaseNotes),
          releaseDate: info.releaseDate ?? null,
          checkedAt
        })
      } else {
        this.set({ status: 'not-available', availableVersion: null, releaseNotes: null, releaseDate: null, checkedAt })
      }
      this.rememberCheck(checkedAt)
    } catch (err) {
      this.fail('check', err)
    }
    return this.getState()
  }

  /** Downloads the update found by check(). Progress is emitted at most four times a second. */
  async download(): Promise<UpdateState> {
    if (this.disabledReason) return this.getState()
    if (this.state.status === 'downloading' || this.state.status === 'downloaded') return this.getState()
    if (this.state.status !== 'available') {
      this.set({ status: 'error', error: 'No update is available to download. Check for updates first.' })
      return this.getState()
    }
    if (!isOnline()) {
      this.set({ status: 'error', error: 'You are offline. The download will be available when the connection returns.' })
      return this.getState()
    }
    this.set({ status: 'downloading', progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: null })
    try {
      await autoUpdater.downloadUpdate()
      // 'update-downloaded' normally fires first; this guards against a missed event.
      if (this.getState().status === 'downloading') this.set({ status: 'downloaded', progress: null })
    } catch (err) {
      this.fail('download', err)
    }
    return this.getState()
  }

  /** Quits and runs the installer (non-silent, relaunch afterwards). No-op unless downloaded. */
  install(): void {
    if (this.disabledReason) return
    if (this.state.status !== 'downloaded') {
      this.ctx.log.warn('updater: install requested but no update has been downloaded')
      return
    }
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      this.fail('install', err)
    }
  }

  /** Periodic checks (30 s after launch, then every 6 h) when the user has opted in. */
  startBackgroundChecks(): void {
    this.stop()
    if (this.disabledReason) return
    const tick = (): void => {
      if (!this.ctx.settings.get().updates.checkAutomatically) return
      if (!isOnline()) {
        this.ctx.log.info('updater: background check skipped (offline)')
        return
      }
      // check() never rejects, but guard anyway so a timer can never produce an unhandled rejection.
      this.check().catch((err) => this.ctx.log.warn('updater: background check failed', err))
    }
    const first = setTimeout(tick, FIRST_CHECK_DELAY_MS)
    const every = setInterval(tick, BACKGROUND_INTERVAL_MS)
    first.unref?.()
    every.unref?.()
    this.timers = [first, every]
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  // ------------------------------------------------------------------------------------------

  private configure(): void {
    if (this.wired) return
    this.wired = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.channel = 'latest'
    // electron-updater's HttpError carries the whole response header block (several KB, cookies
    // included) in its message; keep one line of it in the log.
    const brief = (m: unknown): string => firstLine(m instanceof Error ? m.message : String(m))
    autoUpdater.logger = {
      info: (m: unknown) => this.ctx.log.info(`updater: ${brief(m)}`),
      warn: (m: unknown) => this.ctx.log.warn(`updater: ${brief(m)}`),
      error: (m: unknown) => this.ctx.log.error(`updater: ${brief(m)}`),
      debug: (m: unknown) => this.ctx.log.info(`updater(debug): ${brief(m)}`)
    }
    autoUpdater.on('download-progress', (p: ProgressInfo) => {
      this.state.progress = { percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }
      const now = Date.now()
      if (now - this.lastProgressEmit >= PROGRESS_EMIT_INTERVAL_MS) {
        this.lastProgressEmit = now
        this.ctx.emit('updateState', this.getState())
      }
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.set({
        status: 'downloaded',
        availableVersion: info.version,
        releaseNotes: notesToString(info.releaseNotes) ?? this.state.releaseNotes,
        releaseDate: info.releaseDate ?? this.state.releaseDate,
        progress: null,
        error: null
      })
    })
    autoUpdater.on('error', (err: Error) => {
      // Errors raised during check()/download() are also delivered via the rejected promise;
      // this handler catches the asynchronous ones (e.g. a failed background download).
      if (this.state.status === 'checking' || this.state.status === 'downloading') this.fail('updater', err)
      else this.ctx.log.warn(`updater: ${firstLine(err?.message ?? String(err))}`)
    })
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.ctx.emit('updateState', this.getState())
  }

  private fail(step: string, err: unknown): void {
    const message = friendlyError(err)
    this.ctx.log.warn(`updater: ${step} failed: ${message}`, { detail: firstLine(err instanceof Error ? err.message : String(err)) })
    this.set({ status: 'error', error: message, progress: null, checkedAt: Date.now() })
  }

  private rememberCheck(at: number): void {
    try {
      const s = this.ctx.settings.get()
      this.ctx.settings.set({ updates: { ...s.updates, lastCheckedAt: at } })
    } catch (err) {
      this.ctx.log.warn('updater: could not persist lastCheckedAt', err)
    }
  }
}

function safeVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

function isOnline(): boolean {
  try {
    return typeof net?.isOnline === 'function' ? net.isOnline() : true
  } catch {
    return true
  }
}

/** electron-updater gives a string, an array of {version, note} or nothing. Always return a string or null. */
export function notesToString(notes: UpdateInfo['releaseNotes'] | undefined): string | null {
  if (!notes) return null
  if (typeof notes === 'string') return notes.trim() || null
  const joined = notes
    .map((n) => (n.version ? `## ${n.version}\n\n` : '') + (n.note ?? '').trim())
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
  return joined || null
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|net::ERR_INTERNET_DISCONNECTED|getaddrinfo/i.test(raw)) {
    return 'Could not reach the update server. Check your internet connection and try again.'
  }
  if (/404|latest\.yml/i.test(raw)) return 'No published release was found for this app yet.'
  if (/sha512|checksum|signature/i.test(raw)) return 'The downloaded update failed verification and was discarded.'
  return raw.length > 300 ? raw.slice(0, 300) + '…' : raw
}

/** First non-empty line of a possibly multi-line message, capped at 300 characters. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  return line.length > 300 ? line.slice(0, 300) + '…' : line
}
