import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The service imports `electron` for dialog/net; stub the module before it loads.
vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp', isPackaged: false },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  net: { isOnline: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { CalendarRepo } from '../../../src/main/db/calendar-repo'
import { SettingsRepo } from '../../../src/main/db/settings-repo'
import { CalendarService } from '../../../src/main/services/calendar'
import type { AppContext } from '../../../src/main/context'

interface Harness {
  ctx: AppContext
  svc: CalendarService
  emitted: { name: string; payload: unknown }[]
  logs: string[]
  close: () => void
}

function makeHarness(): Harness {
  const db = new Database(':memory:')
  const notes = new NotesRepo(db)
  const emitted: { name: string; payload: unknown }[] = []
  const logs: string[] = []
  const log = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`)
  }
  const ctx = {
    db,
    notes,
    calendar: new CalendarRepo(db),
    settings: new SettingsRepo(db),
    log,
    mainWindow: null,
    emit: (name: string, payload?: unknown) => emitted.push({ name, payload }),
    notesChanged: (ids: string[]) => emitted.push({ name: 'notesChanged', payload: { ids } })
  } as unknown as AppContext
  return { ctx, svc: new CalendarService(ctx), emitted, logs, close: () => db.close() }
}

const fmt = (ms: number): string => new Date(ms).toISOString().replace(/[-:]|\.\d{3}/g, '')

/** Builds an .ics with one timed event `offsetHours` from now plus a weekly series starting tomorrow. */
function sampleIcs(offsetHours = 24, extra = ''): string {
  const start = Date.now() + offsetHours * 3_600_000
  const weekly = Date.now() + 26 * 3_600_000
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'BEGIN:VEVENT',
    'UID:single@example.com',
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(start + 3_600_000)}`,
    'SUMMARY:Design review',
    'LOCATION:Room 2',
    'ATTENDEE;CN=Deepak Anand:mailto:deepak@example.com',
    'ATTENDEE:mailto:vetri@example.com',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.com',
    `DTSTART:${fmt(weekly)}`,
    'DURATION:PT30M',
    'RRULE:FREQ=WEEKLY;COUNT=4',
    'SUMMARY:Standup',
    'END:VEVENT',
    extra,
    'END:VCALENDAR',
    ''
  ].join('\r\n')
}

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/calendar', ...headers } })
}

let h: Harness
beforeEach(() => {
  h = makeHarness()
})
afterEach(() => {
  h.svc.stop()
  h.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CalendarService', () => {
  it('adds a URL source and populates events from a successful fetch', async () => {
    const fetchMock = vi.fn(async () => okResponse(sampleIcs()))
    vi.stubGlobal('fetch', fetchMock)

    const source = await h.svc.addIcsUrl('Work', 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics')
    expect(source.kind).toBe('ics-url')
    expect(source.label).toBe('Work')
    expect(source.lastError).toBeNull()
    expect(source.lastFetchedAt).not.toBeNull()
    expect(source.eventCount).toBe(5) // 1 single + 4 weekly instances (all within 60 days)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('Minutes')
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const upcoming = h.svc.upcoming(7)
    expect(upcoming.map((e) => e.title)).toEqual(['Design review', 'Standup'])
    expect(upcoming[0].attendees).toEqual(['Deepak Anand', 'vetri@example.com'])
    expect(upcoming[0].location).toBe('Room 2')
    expect(upcoming[0].noteId).toBeNull()
    expect(h.emitted.some((e) => e.name === 'calendarChanged')).toBe(true)
  })

  it('still creates the source when the fetch fails, recording lastError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
      })
    )
    const source = await h.svc.addIcsUrl('Broken', 'https://nowhere.invalid/cal.ics')
    expect(source.lastError).toContain('fetch failed')
    expect(source.lastError).toContain('ENOTFOUND')
    expect(source.eventCount).toBe(0)
    expect(h.svc.listSources()).toHaveLength(1)
    expect(h.logs.some((l) => l.startsWith('warn calendar: refresh failed'))).toBe(true)

    // HTTP errors and non-ICS bodies are reported too, and never throw.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })))
    const [after404] = await h.svc.refresh(source.id)
    expect(after404.lastError).toMatch(/404/)
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('<html>login</html>')))
    const [afterHtml] = await h.svc.refresh(source.id)
    expect(afterHtml.lastError).toMatch(/not an iCalendar/)
  })

  it('rewrites webcal:// to https:// and rejects unsupported URLs', async () => {
    const fetchMock = vi.fn(async () => okResponse(sampleIcs()))
    vi.stubGlobal('fetch', fetchMock)
    const source = await h.svc.addIcsUrl('Outlook', 'webcal://outlook.office365.com/owa/calendar/abc/reachcalendar.ics')
    expect(source.url).toBe('https://outlook.office365.com/owa/calendar/abc/reachcalendar.ics')
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(source.url)

    await expect(h.svc.addIcsUrl('x', 'ftp://example.com/a.ics')).rejects.toThrow(/http/)
    await expect(h.svc.addIcsUrl('x', 'not a url')).rejects.toThrow(/valid calendar address/)
    await expect(h.svc.addIcsUrl('x', 'file:///etc/passwd')).rejects.toThrow()
    expect(h.svc.listSources()).toHaveLength(1)
  })

  it('refresh replaces events within the window and keeps the note link on a surviving event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sampleIcs())))
    const source = await h.svc.addIcsUrl('Work', 'https://example.com/cal.ics')
    const before = h.svc.upcoming(7)
    const review = before.find((e) => e.title === 'Design review')!

    const note = h.svc.createNoteForEvent(review.id)
    expect(note.title).toBe('Design review')
    expect(note.meetingAt).toBe(review.startsAt)
    expect(note.meetingEndAt).toBe(review.endsAt)
    expect(note.attendees).toEqual(review.attendees)
    expect(note.calendarEventId).toBe(review.id)
    expect(h.emitted.some((e) => e.name === 'notesChanged')).toBe(true)

    // Second fetch: same review event (same uid + start), standup series gone, a new event added.
    const extra = [
      'BEGIN:VEVENT',
      'UID:new@example.com',
      `DTSTART:${fmt(Date.now() + 48 * 3_600_000)}`,
      `DTEND:${fmt(Date.now() + 49 * 3_600_000)}`,
      'SUMMARY:Vendor call',
      'END:VEVENT'
    ].join('\r\n')
    const second = sampleIcs(24, extra).replace(/BEGIN:VEVENT\r\nUID:weekly[\s\S]*?END:VEVENT\r\n/, '')
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(second)))
    const [refreshed] = await h.svc.refresh()
    expect(refreshed.id).toBe(source.id)
    expect(refreshed.lastError).toBeNull()
    expect(refreshed.eventCount).toBe(2)

    const after = h.svc.upcoming(7)
    expect(after.map((e) => e.title)).toEqual(['Design review', 'Vendor call'])
    const reviewAfter = after.find((e) => e.title === 'Design review')!
    expect(reviewAfter.id).toBe(review.id) // id preserved by (uid, startsAt)
    expect(reviewAfter.noteId).toBe(note.id)
  })

  it('createNoteForEvent is idempotent and fails clearly for unknown events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(sampleIcs())))
    await h.svc.addIcsUrl('Work', 'https://example.com/cal.ics')
    const ev = h.svc.upcoming(7)[0]
    const a = h.svc.createNoteForEvent(ev.id)
    const b = h.svc.createNoteForEvent(ev.id)
    expect(b.id).toBe(a.id)
    expect(h.ctx.notes.counts().all).toBe(1)
    expect(h.svc.upcoming(7)[0].noteId).toBe(a.id)

    // A trashed note no longer counts as "the" note for the event; a fresh one is created.
    h.ctx.notes.trash(a.id)
    const c = h.svc.createNoteForEvent(ev.id)
    expect(c.id).not.toBe(a.id)
    expect(() => h.svc.createNoteForEvent('does-not-exist')).toThrow(/no longer exists/)
  })

  it('reads .ics-file sources and removes sources cleanly', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'minutes-ics-'))
    const file = join(dir, 'team.ics')
    writeFileSync(file, sampleIcs())
    const { dialog } = await import('electron')
    ;(dialog.showOpenDialog as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ canceled: false, filePaths: [file] })

    const source = await h.svc.addIcsFile()
    expect(source).not.toBeNull()
    expect(source!.kind).toBe('ics-file')
    expect(source!.label).toBe('team')
    expect(source!.url).toBe(file)
    expect(source!.eventCount).toBe(5)

    h.svc.removeSource(source!.id)
    expect(h.svc.listSources()).toHaveLength(0)
    expect(h.svc.upcoming(60)).toHaveLength(0)

    // Cancelled dialog → null, nothing created.
    expect(await h.svc.addIcsFile()).toBeNull()
    expect(h.svc.listSources()).toHaveLength(0)
  })

  it('rejects oversized responses without throwing out of refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('BEGIN:VCALENDAR', { 'content-length': String(11 * 1024 * 1024) })))
    const source = await h.svc.addIcsUrl('Big', 'https://example.com/huge.ics')
    expect(source.lastError).toMatch(/10 MB/)
  })
})
