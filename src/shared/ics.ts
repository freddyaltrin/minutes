// Dependency-free, deterministic iCalendar (RFC 5545) parser.
//
// Scope: enough of the spec to turn a Google / Outlook / Apple calendar export into a flat list of
// event instances inside a time window. No network, no clock reads (except via `nowRef`), no I/O,
// so it runs identically in the main process and in unit tests.
//
// Deliberately NOT supported: VTIMEZONE blocks (Intl knows the zones better than most exports do),
// BYSETPOS, BYHOUR/BYMINUTE/BYSECOND, BYWEEKNO, BYYEARDAY, RANGE=THISANDFUTURE, WKST.

export interface IcsEvent {
  uid: string
  title: string
  /** Epoch ms. For all-day events this is local midnight of the first day. */
  startsAt: number
  /** Epoch ms, exclusive. All-day events end at local midnight after the last day. */
  endsAt: number
  allDay: boolean
  /** CN parameter when present, otherwise the bare mailto address. */
  attendees: string[]
  organizer: string | null
  location: string | null
  description: string | null
  /** Raw RECURRENCE-ID value when this instance is an override of a recurring master. */
  recurrenceId?: string
  status?: string
}

export interface IcsWindow {
  start: number
  end: number
}

/** Hard ceiling on generated instances per recurring event (protects against runaway RRULEs). */
export const MAX_INSTANCES = 1000

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

/** Windows display names (as emitted by Outlook / Exchange) → IANA. Small, common subset. */
const WINDOWS_ZONES: Record<string, string> = {
  'india standard time': 'Asia/Kolkata',
  'arabian standard time': 'Asia/Dubai',
  'arab standard time': 'Asia/Riyadh',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'romance standard time': 'Europe/Paris',
  'e. europe standard time': 'Europe/Chisinau',
  'russian standard time': 'Europe/Moscow',
  'singapore standard time': 'Asia/Singapore',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'korea standard time': 'Asia/Seoul',
  'aus eastern standard time': 'Australia/Sydney',
  'e. australia standard time': 'Australia/Brisbane',
  'new zealand standard time': 'Pacific/Auckland',
  'pacific standard time': 'America/Los_Angeles',
  'mountain standard time': 'America/Denver',
  'central standard time': 'America/Chicago',
  'eastern standard time': 'America/New_York',
  'atlantic standard time': 'America/Halifax',
  'sa pacific standard time': 'America/Bogota',
  'e. south america standard time': 'America/Sao_Paulo',
  'south africa standard time': 'Africa/Johannesburg',
  'egypt standard time': 'Africa/Cairo',
  'pakistan standard time': 'Asia/Karachi',
  'bangladesh standard time': 'Asia/Dhaka',
  'sri lanka standard time': 'Asia/Colombo',
  'nepal standard time': 'Asia/Kathmandu',
  'se asia standard time': 'Asia/Bangkok',
  utc: 'UTC',
  'coordinated universal time': 'UTC'
}

const formatterCache = new Map<string, Intl.DateTimeFormat | null>()

/** Returns a cached formatter for an IANA zone, or null if Intl does not know the zone. */
function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(zone)
  if (cached !== undefined) return cached
  let fmt: Intl.DateTimeFormat | null = null
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
  } catch {
    fmt = null
  }
  formatterCache.set(zone, fmt)
  return fmt
}

/**
 * Maps a TZID as found in an .ics file to something Intl accepts: IANA names pass through,
 * Windows names go through the table, Mozilla-style "/mozilla.org/.../Asia/Kolkata" is trimmed.
 * Returns null for unknown zones.
 */
export function resolveZone(tzid: string): string | null {
  const raw = tzid.trim().replace(/^"|"$/g, '')
  if (!raw) return null
  if (formatterFor(raw)) return raw
  const win = WINDOWS_ZONES[raw.toLowerCase()]
  if (win) return win
  // "/freeassociation.sourceforge.net/Asia/Kolkata" or "/mozilla.org/20050126_1/Asia/Kolkata"
  const parts = raw.split('/').filter(Boolean)
  if (parts.length >= 2) {
    const tail = parts.slice(-2).join('/')
    if (formatterFor(tail)) return tail
  }
  return null
}

/** Wall-clock offset (ms) of `zone` at instant `utcMs`: localWall - utc. */
function zoneOffsetAt(utcMs: number, fmt: Intl.DateTimeFormat): number {
  const p: Record<string, number> = {}
  for (const part of fmt.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value)
  }
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second)
  // Drop sub-second noise so iterations converge exactly.
  return wall - Math.floor(utcMs / 1000) * 1000
}

/**
 * Converts wall-clock components in `tzid` to epoch ms using Intl, iterating until the offset is
 * stable (handles DST edges; a non-existent local time resolves to the post-transition instant).
 * Unknown zones fall back to the machine's local time, which is what most users mean anyway.
 */
export function zonedTimeToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const zone = resolveZone(tzid)
  const fmt = zone ? formatterFor(zone) : null
  if (!fmt) return new Date(y, m - 1, d, h, mi, s).getTime()
  const wall = Date.UTC(y, m - 1, d, h, mi, s)
  let guess = wall
  for (let i = 0; i < 3; i++) {
    const next = wall - zoneOffsetAt(guess, fmt)
    if (next === guess) break
    guess = next
  }
  return guess
}

// ---------------------------------------------------------------------------------------------
// Content lines
// ---------------------------------------------------------------------------------------------

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** RFC 5545 §3.1: a CRLF (or bare LF) followed by a space or tab continues the previous line. */
export function unfold(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter((l) => l.length > 0)
}

/** Splits `NAME;PARAM=val;PARAM2="quoted:val":value` respecting quotes. */
function parseLine(line: string): Prop | null {
  let i = 0
  let inQuotes = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ':' && !inQuotes) break
  }
  if (i >= line.length) return null
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const segs: string[] = []
  let cur = ''
  inQuotes = false
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes
    if (c === ';' && !inQuotes) {
      segs.push(cur)
      cur = ''
    } else cur += c
  }
  segs.push(cur)
  const name = segs[0].trim().toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq < 0) continue
    params[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name, params, value }
}

/** RFC 5545 §3.3.11 TEXT unescaping. */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** Wall-clock components plus how they should be anchored to an instant. */
interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
  s: number
  /** 'utc' = trailing Z, 'floating' = no zone (local), otherwise a TZID string. */
  zone: 'utc' | 'floating' | string
  allDay: boolean
}

function parseWall(value: string, params: Record<string, string>): Wall | null {
  const v = value.trim()
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (dateOnly || params.VALUE === 'DATE') {
    if (!dateOnly) return null
    return { y: +dateOnly[1], m: +dateOnly[2], d: +dateOnly[3], h: 0, mi: 0, s: 0, zone: 'floating', allDay: true }
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v)
  if (!dt) return null
  const zone = dt[7] ? 'utc' : params.TZID ? params.TZID : 'floating'
  return { y: +dt[1], m: +dt[2], d: +dt[3], h: +dt[4], mi: +dt[5], s: +(dt[6] ?? 0), zone, allDay: false }
}

function wallToMs(w: Wall): number {
  if (w.zone === 'utc') return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s)
  if (w.zone === 'floating') return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime()
  return zonedTimeToUtc(w.y, w.m, w.d, w.h, w.mi, w.s, w.zone)
}

/** ISO 8601 duration (`P1DT2H30M`, `-PT15M`, `P2W`) → ms. Returns null when malformed. */
export function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim())
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms = (+(w ?? 0) * 7 + +(d ?? 0)) * 86_400_000 + +(h ?? 0) * 3_600_000 + +(mi ?? 0) * 60_000 + +(s ?? 0) * 1000
  return sign === '-' ? -ms : ms
}

/** Date arithmetic on wall-clock components, done in a neutral UTC calendar so DST never leaks in. */
function shift(w: Wall, days: number, months = 0): Wall {
  const dt = new Date(Date.UTC(w.y, w.m - 1 + months, w.d + days, w.h, w.mi, w.s))
  return { ...w, y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}
const weekdayOf = (w: Wall): number => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay() // 0 = SU
const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate()

// ---------------------------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  count: number | null
  until: number | null
  byDay: { ord: number; wd: number }[]
  byMonthDay: number[]
  byMonth: number[]
}

function parseRrule(value: string, dtstartAllDay: boolean): Rule | null {
  const parts: Record<string, string> = {}
  for (const seg of value.split(';')) {
    const eq = seg.indexOf('=')
    if (eq > 0) parts[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1)
  }
  const freq = parts.FREQ as Rule['freq'] | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null
  let until: number | null = null
  if (parts.UNTIL) {
    const w = parseWall(parts.UNTIL, {})
    // A DATE-valued UNTIL is inclusive of that whole day.
    if (w) until = w.allDay || dtstartAllDay ? wallToMs({ ...w, allDay: false }) + 86_400_000 - 1 : wallToMs(w)
  }
  const byDay: Rule['byDay'] = []
  for (const tok of (parts.BYDAY ?? '').split(',').filter(Boolean)) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.toUpperCase())
    if (m) byDay.push({ ord: m[1] ? +m[1] : 0, wd: WEEKDAYS.indexOf(m[2]) })
  }
  const nums = (s?: string): number[] => (s ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n !== 0)
  return {
    freq,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1),
    count: parts.COUNT ? Math.max(0, parseInt(parts.COUNT, 10) || 0) : null,
    until,
    byDay,
    byMonthDay: nums(parts.BYMONTHDAY),
    byMonth: nums(parts.BYMONTH)
  }
}

/** Candidate dates (wall components) inside the month `y/m` that satisfy BYMONTHDAY / BYDAY. */
function monthCandidates(rule: Rule, base: Wall, y: number, m: number): Wall[] {
  const dim = daysInMonth(y, m)
  const out: Wall[] = []
  const at = (d: number): Wall => ({ ...base, y, m, d })
  if (rule.byMonthDay.length) {
    for (const md of rule.byMonthDay) {
      const d = md > 0 ? md : dim + md + 1
      if (d >= 1 && d <= dim) out.push(at(d))
    }
  } else if (rule.byDay.length) {
    for (const { ord, wd } of rule.byDay) {
      const matches: number[] = []
      for (let d = 1; d <= dim; d++) if (weekdayOf(at(d)) === wd) matches.push(d)
      if (ord === 0) matches.forEach((d) => out.push(at(d)))
      else {
        const pick = ord > 0 ? matches[ord - 1] : matches[matches.length + ord]
        if (pick) out.push(at(pick))
      }
    }
  } else if (base.d <= dim) {
    out.push(at(base.d))
  }
  return out.sort((a, b) => a.d - b.d)
}

/**
 * Expands an RRULE from `start` into instance start times (ms). Walks period by period (day / week /
 * month / year) from DTSTART, so COUNT is honoured exactly, and stops at UNTIL, COUNT, the window end
 * or MAX_INSTANCES. Candidates earlier than DTSTART are dropped as RFC 5545 requires.
 */
function expand(rule: Rule, start: Wall, windowEnd: number): Wall[] {
  const startMs = wallToMs(start)
  const out: Wall[] = []
  const limit = Math.min(MAX_INSTANCES, rule.count ?? MAX_INSTANCES)
  const byDaySet = new Set(rule.byDay.map((b) => b.wd))
  const byMonthDaySet = new Set(rule.byMonthDay)
  const dayPasses = (w: Wall): boolean => {
    if (byDaySet.size && !byDaySet.has(weekdayOf(w))) return false
    if (byMonthDaySet.size) {
      const dim = daysInMonth(w.y, w.m)
      if (!byMonthDaySet.has(w.d) && !byMonthDaySet.has(w.d - dim - 1)) return false
    }
    return true
  }

  for (let n = 0; n < 100_000 && out.length < limit; n++) {
    let candidates: Wall[] = []
    let periodStartMs: number
    if (rule.freq === 'DAILY') {
      const w = shift(start, n * rule.interval)
      periodStartMs = wallToMs(w)
      if (dayPasses(w)) candidates = [w]
    } else if (rule.freq === 'WEEKLY') {
      // Week containing the anchor, Monday-based (WKST ignored).
      const anchor = shift(start, n * rule.interval * 7)
      const monday = shift(anchor, -((weekdayOf(anchor) + 6) % 7))
      periodStartMs = wallToMs(monday)
      if (byDaySet.size) {
        for (let i = 0; i < 7; i++) {
          const w = shift(monday, i)
          if (byDaySet.has(weekdayOf(w))) candidates.push(w)
        }
      } else candidates = [anchor]
    } else if (rule.freq === 'MONTHLY') {
      const first = shift({ ...start, d: 1 }, 0, n * rule.interval)
      periodStartMs = wallToMs(first)
      candidates = monthCandidates(rule, start, first.y, first.m)
    } else {
      const y = start.y + n * rule.interval
      periodStartMs = wallToMs({ ...start, y, m: 1, d: 1 })
      const months = rule.byMonth.length ? rule.byMonth : [start.m]
      for (const m of months) {
        if (rule.byMonthDay.length || rule.byDay.length) candidates.push(...monthCandidates(rule, start, y, m))
        else if (start.d <= daysInMonth(y, m)) candidates.push({ ...start, y, m })
      }
    }
    if (periodStartMs > windowEnd) break
    for (const c of candidates) {
      const ms = wallToMs(c)
      if (ms < startMs) continue
      if (rule.until !== null && ms > rule.until) return out
      if (out.length >= limit) break
      out.push(c)
      if (ms > windowEnd) return out
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// VEVENT assembly
// ---------------------------------------------------------------------------------------------

interface RawEvent {
  props: Prop[]
}

/** Collects top-level VEVENT components, skipping anything nested inside them (VALARM). */
function collectEvents(lines: string[]): RawEvent[] {
  const events: RawEvent[] = []
  let current: RawEvent | null = null
  let depth = 0 // nesting depth inside the current VEVENT
  for (const line of lines) {
    const p = parseLine(line)
    if (!p) continue
    if (p.name === 'BEGIN') {
      if (current) depth++
      else if (p.value.toUpperCase() === 'VEVENT') current = { props: [] }
      continue
    }
    if (p.name === 'END') {
      if (current && depth > 0) depth--
      else if (current && p.value.toUpperCase() === 'VEVENT') {
        events.push(current)
        current = null
      }
      continue
    }
    if (current && depth === 0) current.props.push(p)
  }
  return events
}

function first(ev: RawEvent, name: string): Prop | undefined {
  return ev.props.find((p) => p.name === name)
}

function personName(p: Prop): string {
  const cn = p.params.CN?.trim()
  if (cn) return cn
  return p.value.replace(/^mailto:/i, '').trim()
}

interface Parsed {
  uid: string
  title: string
  start: Wall
  durationMs: number
  attendees: string[]
  organizer: string | null
  location: string | null
  description: string | null
  status: string | undefined
  recurrenceId: Prop | undefined
  rrule: Rule | null
  exdates: Set<number>
}

function interpret(ev: RawEvent): Parsed | null {
  const dtstartProp = first(ev, 'DTSTART')
  const start = dtstartProp ? parseWall(dtstartProp.value, dtstartProp.params) : null
  if (!start) return null

  // End: DTEND wins, then DURATION, then the RFC default (1 day for all-day, zero-length otherwise).
  let durationMs: number | null = null
  const dtend = first(ev, 'DTEND')
  if (dtend) {
    const end = parseWall(dtend.value, { ...dtend.params, TZID: dtend.params.TZID ?? dtstartProp!.params.TZID ?? '' })
    if (end) durationMs = wallToMs(end) - wallToMs(start)
  }
  if (durationMs === null) {
    const dur = first(ev, 'DURATION')
    if (dur) durationMs = parseDuration(dur.value)
  }
  if (durationMs === null || durationMs < 0) durationMs = start.allDay ? 86_400_000 : 0

  const exdates = new Set<number>()
  for (const p of ev.props.filter((p) => p.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const w = parseWall(v, p.params)
      if (w) exdates.add(wallToMs(w))
    }
  }
  const rruleProp = first(ev, 'RRULE')
  const text = (name: string): string | null => {
    const p = first(ev, name)
    const v = p ? unescapeText(p.value).trim() : ''
    return v ? v : null
  }
  const organizer = first(ev, 'ORGANIZER')
  return {
    uid: first(ev, 'UID')?.value.trim() || `${start.y}${start.m}${start.d}-${text('SUMMARY') ?? 'event'}`,
    title: text('SUMMARY') ?? '(No title)',
    start,
    durationMs,
    attendees: ev.props.filter((p) => p.name === 'ATTENDEE').map(personName).filter(Boolean),
    organizer: organizer ? personName(organizer) || null : null,
    location: text('LOCATION'),
    description: text('DESCRIPTION'),
    status: first(ev, 'STATUS')?.value.trim().toUpperCase() || undefined,
    recurrenceId: first(ev, 'RECURRENCE-ID'),
    rrule: rruleProp ? parseRrule(rruleProp.value, start.allDay) : null,
    exdates
  }
}

function toEvent(p: Parsed, startMs: number, recurrenceId?: string): IcsEvent {
  const e: IcsEvent = {
    uid: p.uid,
    title: p.title,
    startsAt: startMs,
    endsAt: startMs + p.durationMs,
    allDay: p.start.allDay,
    attendees: p.attendees,
    organizer: p.organizer,
    location: p.location,
    description: p.description
  }
  if (recurrenceId) e.recurrenceId = recurrenceId
  if (p.status) e.status = p.status
  return e
}

/**
 * Parses an iCalendar document and returns every event instance overlapping `window`
 * (start inclusive, end inclusive), recurring rules expanded, overrides applied, cancellations
 * removed. Output is sorted by start time then UID so repeated runs are byte-identical.
 *
 * `nowRef` is only consulted when a window bound is not finite (defaults to ±1 year around it).
 */
export function parseIcs(text: string, window: IcsWindow, nowRef: Date = new Date(0)): IcsEvent[] {
  const YEAR = 365 * 86_400_000
  const wStart = Number.isFinite(window.start) ? window.start : nowRef.getTime() - YEAR
  const wEnd = Number.isFinite(window.end) ? window.end : nowRef.getTime() + YEAR
  const overlaps = (e: IcsEvent): boolean => e.startsAt <= wEnd && e.endsAt >= wStart

  const parsed = collectEvents(unfold(text))
    .map(interpret)
    .filter((p): p is Parsed => p !== null)

  // Overrides (RECURRENCE-ID) replace the master's instance with the same original start.
  const overridden = new Map<string, Set<number>>()
  for (const p of parsed) {
    if (!p.recurrenceId) continue
    const w = parseWall(p.recurrenceId.value, p.recurrenceId.params)
    if (!w) continue
    const set = overridden.get(p.uid) ?? new Set<number>()
    set.add(wallToMs(w))
    overridden.set(p.uid, set)
  }

  const out: IcsEvent[] = []
  for (const p of parsed) {
    if (p.status === 'CANCELLED') continue
    if (p.recurrenceId) {
      const e = toEvent(p, wallToMs(p.start), p.recurrenceId.value)
      if (overlaps(e)) out.push(e)
      continue
    }
    if (!p.rrule) {
      const e = toEvent(p, wallToMs(p.start))
      if (overlaps(e)) out.push(e)
      continue
    }
    const skip = overridden.get(p.uid)
    for (const w of expand(p.rrule, p.start, wEnd)) {
      const ms = wallToMs(w)
      if (p.exdates.has(ms) || skip?.has(ms)) continue
      const e = toEvent(p, ms)
      if (overlaps(e)) out.push(e)
    }
  }
  return out.sort((a, b) => a.startsAt - b.startsAt || a.uid.localeCompare(b.uid))
}
