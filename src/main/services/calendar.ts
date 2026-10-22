import { readFile } from 'node:fs/promises'
import { dialog, net } from 'electron'
import type { AppContext } from '../context'
import type { EventInput } from '../db/calendar-repo'
import type { CalendarEvent, CalendarSource, Note } from '@shared/types'
import { parseIcs } from '@shared/ics'

const FETCH_TIMEOUT_MS = 20_000
const MAX_BYTES = 10 * 1024 * 1024
const AUTO_REFRESH_MS = 30 * 60_000
const DAY = 86_400_000
const WINDOW_PAST_DAYS = 7
const WINDOW_FUTURE_DAYS = 60

/**
 * Calendar subscriptions: .ics URLs (Google "secret address", Outlook "publish calendar", any CalDAV
 * export) and local .ics files. Everything is best-effort and offline-safe — a failed fetch only
 * updates `lastError` on the source; existing events are kept until a successful refresh replaces them.
 */
export class CalendarService {
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<CalendarSource[]> | null = null

  constructor(private readonly ctx: AppContext) {}

  listSources(): CalendarSource[] {
    return this.ctx.calendar.listSources()
  }

  /** Accepts http(s) and webcal(s) URLs; the latter are rewritten to https. Throws on invalid input. */
  static normalizeUrl(input: string): string {
    const trimmed = input.trim().replace(/^webcals?:\/\//i, 'https://')
    let u: URL
    try {
      u = new URL(trimmed)
    } catch {
      throw new Error('Enter a valid calendar address (https://… or webcal://…).')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) and webcal addresses are supported.')
    if (!u.hostname) throw new Error('The calendar address has no host name.')
    return u.toString()
  }

  async addIcsUrl(label: string, url: string): Promise<CalendarSource> {
    const normalized = CalendarService.normalizeUrl(url)
    const source = this.ctx.calendar.addSource('ics-url', label || hostLabel(normalized), normalized)
    await this.refreshSource(source)
    this.ctx.emit('calendarChanged')
    return this.ctx.calendar.getSource(source.id) ?? source
  }

  async addIcsFile(): Promise<CalendarSource | null> {
    const win = this.ctx.mainWindow
    const opts: Electron.OpenDialogOptions = {
      title: 'Add calendar file',
      properties: ['openFile'],
      filters: [{ name: 'iCalendar', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || result.filePaths.length === 0) return null
    const path = result.filePaths[0]
    const label = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'Calendar file'
    const source = this.ctx.calendar.addSource('ics-file', label, path)
    await this.refreshSource(source)
    this.ctx.emit('calendarChanged')
    return this.ctx.calendar.getSource(source.id) ?? source
  }

  removeSource(id: string): void {
    this.ctx.calendar.removeSource(id)
    this.ctx.emit('calendarChanged')
    this.ensureTimer()
  }

  /** Re-fetches one source or all of them. Never throws; failures land in `lastError`. */
  refresh(sourceId?: string): Promise<CalendarSource[]> {
    if (!sourceId && this.refreshing) return this.refreshing
    const run = (async (): Promise<CalendarSource[]> => {
      const sources = sourceId
        ? [this.ctx.calendar.getSource(sourceId)].filter((s): s is CalendarSource => s !== null)
        : this.ctx.calendar.listSources()
      for (const s of sources) await this.refreshSource(s)
      if (sources.length) this.ctx.emit('calendarChanged')
      return this.ctx.calendar.listSources()
    })()
    if (!sourceId) {
      this.refreshing = run
      run.finally(() => (this.refreshing = null)).catch(() => undefined)
    }
    return run
  }

  /** Events from two hours ago until `days` from now, with their linked note ids. */
  upcoming(days: number): CalendarEvent[] {
    const now = Date.now()
    const span = Math.max(0, Math.min(Number.isFinite(days) ? days : WINDOW_FUTURE_DAYS, 366))
    return this.ctx.calendar.upcoming(now - 2 * 3_600_000, now + span * DAY)
  }

  /** Idempotent: returns the existing linked note if there is one. */
  createNoteForEvent(eventId: string): Note {
    const event = this.ctx.calendar.getEvent(eventId)
    if (!event) throw new Error('That calendar event no longer exists. Refresh the calendar and try again.')
    if (event.noteId) {
      const existing = this.ctx.notes.get(event.noteId)
      if (existing && !existing.deletedAt) return existing
    }
    const note = this.ctx.notes.create({
      title: event.title,
      meetingAt: event.startsAt,
      meetingEndAt: event.endsAt,
      attendees: event.attendees,
      calendarEventId: event.id
    })
    this.ctx.notesChanged([note.id])
    this.ctx.emit('calendarChanged')
    return note
  }

  /** Refreshes URL sources every 30 minutes while any exist. Skipped silently when offline. */
  startAutoRefresh(): void {
    this.ensureTimer()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // ------------------------------------------------------------------------------------------

  private ensureTimer(): void {
    const hasUrlSources = this.ctx.calendar.listSources().some((s) => s.kind === 'ics-url')
    if (!hasUrlSources) {
      this.stop()
      return
    }
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!isOnline()) {
        this.ctx.log.info('calendar: auto-refresh skipped (offline)')
        return
      }
      this.refresh().catch((err) => this.ctx.log.error('calendar: auto-refresh failed', err))
    }, AUTO_REFRESH_MS)
    this.timer.unref?.()
  }

  private async refreshSource(source: CalendarSource): Promise<void> {
    const now = Date.now()
    const window = { start: now - WINDOW_PAST_DAYS * DAY, end: now + WINDOW_FUTURE_DAYS * DAY }
    try {
      const text = source.kind === 'ics-url' ? await this.fetchIcs(source.url ?? '') : await this.readIcsFile(source.url ?? '')
      if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('The response is not an iCalendar (.ics) document.')
      const events: EventInput[] = parseIcs(text, window, new Date(now)).map((e) => ({
        uid: e.recurrenceId ? `${e.uid}#${e.recurrenceId}` : e.uid,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        attendees: e.attendees,
        location: e.location,
        description: e.description
      }))
      this.ctx.calendar.replaceEvents(source.id, events, window.start, window.end)
      this.ctx.calendar.markFetched(source.id, null)
      this.ctx.log.info(`calendar: refreshed "${source.label}" (${events.length} events)`)
    } catch (err) {
      const message = describeError(err)
      this.ctx.calendar.markFetched(source.id, message)
      this.ctx.log.warn(`calendar: refresh failed for "${source.label}": ${message}`)
    }
  }

  private async fetchIcs(url: string): Promise<string> {
    if (!isOnline()) throw new Error('You are offline. The calendar will refresh when the connection returns.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Minutes', Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' }
      })
      if (!res.ok) throw new Error(`Server replied ${res.status} ${res.statusText}`.trim())
      const declared = Number(res.headers.get('content-length') ?? 0)
      if (declared > MAX_BYTES) throw new Error('Calendar is larger than 10 MB.')
      return await readBodyCapped(res, MAX_BYTES)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error('Timed out after 20 seconds.')
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  private async readIcsFile(path: string): Promise<string> {
    if (!path) throw new Error('No file path stored for this calendar.')
    const buf = await readFile(path)
    if (buf.byteLength > MAX_BYTES) throw new Error('Calendar file is larger than 10 MB.')
    return buf.toString('utf8')
  }
}

function isOnline(): boolean {
  try {
    return typeof net?.isOnline === 'function' ? net.isOnline() : true
  } catch {
    return true
  }
}

/** Reads a response body as UTF-8 text, aborting once it exceeds `max` bytes. */
async function readBodyCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return await res.text()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('Calendar is larger than 10 MB.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'Calendar'
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause
    if (cause?.code) return `${err.message} (${cause.code})`
    return err.message
  }
  return String(err)
}
