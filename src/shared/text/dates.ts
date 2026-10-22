// Date / time / deadline mention detection with deterministic resolution.
//
// Everything is resolved relative to a caller-supplied `referenceDate` using the local
// time zone of the process (Date(y, m, d) constructors). No locale data, no heuristics
// beyond the explicit rules documented below.
//
// AMBIGUITY RULES (resolved → epoch ms, or null when we refuse to guess):
//  - "20/10/2026" style numeric dates: if the first number > 12 it is day-first (DMY);
//    if the second number > 12 it is month-first (MDY); if both are <= 12 we cannot tell
//    (e.g. 3/4/2026) and return null. Two-digit years are 20xx.
//  - "20 Oct" / "Oct 20" without a year: resolved in the reference year, except when that
//    lands more than 60 days before the reference date, in which case the next year is used
//    (people rarely set deadlines two months in the past).
//  - Bare weekday ("Friday", "by Friday", "on Friday", "this Friday"): the next occurrence
//    strictly after the reference date (1..7 days ahead). "this Friday" on a Friday therefore
//    means next week — we prefer a single stable rule over regional conventions.
//  - "next <weekday>": the occurrence in the following calendar week (weeks start Monday).
//  - "last <weekday>": the most recent occurrence strictly before the reference date.
//  - "end of (the) week": Friday of the reference date's Monday-based week. On Sat/Sun this is
//    the Friday just passed; we still return it (the phrase is literal) rather than guess.
//  - "end of (the) month/quarter/year": last calendar day of that period containing the reference.
//  - "next week" → Monday of next week; "next month" → 1st of next month; "next quarter" →
//    first day of the next quarter; "next year" → 1 Jan next year. These are *starts*; "by
//    next week" is still reported as the Monday (the caller may treat it as a lower bound).
//  - "this week"/"this month" are ambiguous as a point in time → null.
//  - "in N days/weeks/months" (N numeric or a number word up to twelve, "a"/"an" = 1,
//    "a couple of" = 2, "a few" → null).
//  - Times ("3pm", "15:30", "noon") resolve to that time on the reference date. Bare hour
//    numbers without am/pm are not matched (too ambiguous). hh:mm inside hh:mm:ss is skipped.
//  - "EOD"/"COB"/"end of day" → 23:59:59 of the reference date. "ASAP", "due", "deadline",
//    "before the <thing>" are deadline phrases without a resolvable time → null.

export type DateMentionKind = 'date' | 'relative' | 'time' | 'deadline-phrase'

export interface DateMention {
  /** Exact matched text. */
  text: string
  start: number
  end: number
  /** Epoch milliseconds, or null when the mention cannot be resolved unambiguously. */
  resolved: number | null
  kind: DateMentionKind
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11
}
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4,
  thurs: 4, friday: 5, fri: 5, saturday: 6
}
// "sat" and "sun" abbreviations are deliberately excluded (common words).
const WEEKDAY_RE = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thu(?:rs?)?|fri'

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, couple: 2
}

// ---- date helpers (local time) -------------------------------------------------------

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const endOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 0)
/** Monday of the week containing d. */
const mondayOf = (d: Date): Date => {
  const dow = d.getDay() // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1
  return addDays(startOfDay(d), -back)
}
const lastDayOfMonth = (y: number, m: number): Date => new Date(y, m + 1, 0)
const makeDate = (y: number, m: number, day: number): Date | null => {
  if (m < 0 || m > 11 || day < 1 || day > 31) return null
  const d = new Date(y, m, day)
  // Reject overflow (e.g. 31 Feb).
  if (d.getMonth() !== m || d.getDate() !== day) return null
  return d
}

/** Resolve a month/day without a year (see rules at the top). */
function resolveMonthDay(ref: Date, month: number, day: number, year: number | null): number | null {
  if (year !== null) {
    const d = makeDate(year, month, day)
    return d ? d.getTime() : null
  }
  let d = makeDate(ref.getFullYear(), month, day)
  if (!d) return null
  const sixtyDays = 60 * 86_400_000
  if (startOfDay(ref).getTime() - d.getTime() > sixtyDays) {
    const next = makeDate(ref.getFullYear() + 1, month, day)
    if (next) d = next
  }
  return d.getTime()
}

// ---- candidate collection ----------------------------------------------------------

interface Candidate extends DateMention { priority: number }

function collect(re: RegExp, text: string, fn: (m: RegExpExecArray) => Candidate | null, out: Candidate[]): void {
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const c = fn(m)
    if (c) out.push(c)
    if (m[0].length === 0) re.lastIndex++
  }
}

/**
 * Finds date, weekday, relative, time and deadline-phrase mentions in `text`.
 * Results are non-overlapping, sorted by position.
 */
export function findDateMentions(text: string, referenceDate: Date): DateMention[] {
  const ref = referenceDate
  const cands: Candidate[] = []
  const mk = (m: RegExpExecArray, kind: DateMentionKind, resolved: number | null, priority: number): Candidate => ({
    text: m[0], start: m.index, end: m.index + m[0].length, resolved, kind, priority
  })

  // Optional leading preposition so "by Friday" / "due 20 Oct" are reported as one mention.
  const PREFIX = '(?:(?:by|before|until|till|on|at|around|for|due)\\s+)?'

  // -- Explicit dates -------------------------------------------------------------------
  // ISO: 2026-10-20
  collect(new RegExp(`\\b${PREFIX}(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi'), text, (m) => {
    const d = makeDate(+m[1], +m[2] - 1, +m[3])
    return mk(m, 'date', d ? d.getTime() : null, 0)
  }, cands)

  // Numeric: 20/10/2026, 20-10-26, 20.10.2026
  collect(new RegExp(`\\b${PREFIX}(\\d{1,2})([/.-])(\\d{1,2})\\2(\\d{2}|\\d{4})\\b`, 'gi'), text, (m) => {
    const a = +m[1]
    const b = +m[3]
    let y = +m[4]
    if (m[4].length === 2) y += 2000
    let resolved: number | null = null
    if (a > 12 && b <= 12) resolved = makeDate(y, b - 1, a)?.getTime() ?? null
    else if (b > 12 && a <= 12) resolved = makeDate(y, a - 1, b)?.getTime() ?? null
    // both <= 12 → ambiguous (DMY vs MDY) → null; both > 12 → invalid → null
    return mk(m, 'date', resolved, 0)
  }, cands)

  // "20 Oct", "20th of October 2026"
  collect(new RegExp(`\\b${PREFIX}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi'), text, (m) => {
    const month = MONTHS[m[2].toLowerCase()]
    return mk(m, 'date', resolveMonthDay(ref, month, +m[1], m[3] ? +m[3] : null), 0)
  }, cands)

  // "Oct 20", "October 20th, 2026"
  collect(new RegExp(`\\b${PREFIX}(${MONTH_RE})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi'), text, (m) => {
    const month = MONTHS[m[1].toLowerCase()]
    const day = +m[2]
    if (day < 1 || day > 31) return null
    return mk(m, 'date', resolveMonthDay(ref, month, day, m[3] ? +m[3] : null), 0)
  }, cands)

  // -- Relative phrases -----------------------------------------------------------------

  collect(new RegExp(`\\b${PREFIX}(today|tomorrow|yesterday|tonight|day after tomorrow|the day after tomorrow)\\b`, 'gi'), text, (m) => {
    const w = m[1].toLowerCase()
    let d: Date
    if (w === 'today' || w === 'tonight') d = startOfDay(ref)
    else if (w === 'tomorrow') d = addDays(ref, 1)
    else if (w === 'yesterday') d = addDays(ref, -1)
    else d = addDays(ref, 2)
    return mk(m, 'relative', d.getTime(), 1)
  }, cands)

  // end of (the) week / month / quarter / year / day
  collect(new RegExp(`\\b${PREFIX}(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?(week|month|quarter|year|day)\\b`, 'gi'), text, (m) => {
    const unit = m[1].toLowerCase()
    let d: Date
    if (unit === 'day') return mk(m, 'deadline-phrase', endOfDay(ref).getTime(), 1)
    if (unit === 'week') d = addDays(mondayOf(ref), 4)
    else if (unit === 'month') d = lastDayOfMonth(ref.getFullYear(), ref.getMonth())
    else if (unit === 'quarter') d = lastDayOfMonth(ref.getFullYear(), Math.floor(ref.getMonth() / 3) * 3 + 2)
    else d = new Date(ref.getFullYear(), 11, 31)
    return mk(m, 'relative', d.getTime(), 1)
  }, cands)

  // next/this/last week|month|quarter|year
  collect(new RegExp(`\\b${PREFIX}(next|this|last)\\s+(week|month|quarter|year)\\b`, 'gi'), text, (m) => {
    const rel = m[1].toLowerCase()
    const unit = m[2].toLowerCase()
    if (rel === 'this') return mk(m, 'relative', null, 1) // ambiguous as a point in time
    const dir = rel === 'next' ? 1 : -1
    let d: Date
    if (unit === 'week') d = addDays(mondayOf(ref), 7 * dir)
    else if (unit === 'month') d = new Date(ref.getFullYear(), ref.getMonth() + dir, 1)
    else if (unit === 'quarter') d = new Date(ref.getFullYear(), Math.floor(ref.getMonth() / 3) * 3 + 3 * dir, 1)
    else d = new Date(ref.getFullYear() + dir, 0, 1)
    return mk(m, 'relative', d.getTime(), 1)
  }, cands)

  // in N days/weeks/months, "in a couple of weeks", "in a few days"
  collect(/\bin\s+(\d{1,3}|a couple of|a few|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\b/gi, text, (m) => {
    const raw = m[1].toLowerCase()
    const unit = m[2].toLowerCase()
    let n: number | null = null
    if (/^\d+$/.test(raw)) n = +raw
    else if (raw === 'a couple of') n = 2
    else if (raw === 'a few') n = null
    else n = NUMBER_WORDS[raw] ?? null
    if (n === null) return mk(m, 'relative', null, 1)
    let d: Date
    if (unit === 'day') d = addDays(ref, n)
    else if (unit === 'week') d = addDays(ref, 7 * n)
    else if (unit === 'month') d = new Date(ref.getFullYear(), ref.getMonth() + n, ref.getDate())
    else d = new Date(ref.getFullYear() + n, ref.getMonth(), ref.getDate())
    return mk(m, 'relative', startOfDay(d).getTime(), 1)
  }, cands)

  // Weekdays with optional modifier.
  collect(new RegExp(`\\b${PREFIX}(?:(next|this|last|coming)\\s+)?(${WEEKDAY_RE})\\b`, 'gi'), text, (m) => {
    const mod = (m[1] ?? '').toLowerCase()
    const target = WEEKDAYS[m[2].toLowerCase()]
    if (target === undefined) return null
    const today = startOfDay(ref)
    const dow = today.getDay()
    let d: Date
    if (mod === 'next') {
      const nextMonday = addDays(mondayOf(ref), 7)
      const offset = target === 0 ? 6 : target - 1
      d = addDays(nextMonday, offset)
    } else if (mod === 'last') {
      let back = (dow - target + 7) % 7
      if (back === 0) back = 7
      d = addDays(today, -back)
    } else {
      let ahead = (target - dow + 7) % 7
      if (ahead === 0) ahead = 7
      d = addDays(today, ahead)
    }
    return mk(m, 'relative', d.getTime(), 1)
  }, cands)

  // -- Times --------------------------------------------------------------------------------
  // 3pm, 3:30 pm, 10 a.m.
  collect(/(?<![\d:])\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm|a\.m\.|p\.m\.)(?![\w.])/gi, text, (m) => {
    let h = +m[1]
    const min = m[2] ? +m[2] : 0
    if (h < 1 || h > 12) return null
    const pm = m[3].toLowerCase().startsWith('p')
    if (pm && h !== 12) h += 12
    if (!pm && h === 12) h = 0
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, min)
    return mk(m, 'time', d.getTime(), 2)
  }, cands)
  // 15:30 (24h) — not part of hh:mm:ss, not followed by am/pm (handled above)
  collect(/(?<![\d:])\b([01]?\d|2[0-3]):([0-5]\d)\b(?![:\d]|\s*(?:am|pm))/gi, text, (m) => {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), +m[1], +m[2])
    return mk(m, 'time', d.getTime(), 2)
  }, cands)
  collect(/\b(?:at\s+)?(noon|midnight|midday)\b/gi, text, (m) => {
    const w = m[1].toLowerCase()
    const h = w === 'midnight' ? 0 : 12
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, 0)
    return mk(m, 'time', d.getTime(), 2)
  }, cands)

  // -- Deadline phrases ----------------------------------------------------------------------
  collect(/\b(?:(?:by|before|until|till)\s+)?(?:eod|cob|close of business|end of business|end of play|eop)\b/gi, text, (m) =>
    mk(m, 'deadline-phrase', endOfDay(ref).getTime(), 3), cands)
  collect(/\b(asap|as soon as possible|no later than|deadline|cutoff|cut-off)\b/gi, text, (m) =>
    mk(m, 'deadline-phrase', null, 3), cands)
  // "due" but not "due to"
  collect(/\bdue\b(?!\s+to\b)/gi, text, (m) => mk(m, 'deadline-phrase', null, 3), cands)
  // "before the review", "before the next release", "ahead of the demo" — one or two words
  collect(/\b(?:before|ahead of|prior to)\s+(?:the|our|next|this)\s+(?!end\b)([a-z][\w-]*(?:\s+[a-z][\w-]*)?)/gi, text, (m) =>
    mk(m, 'deadline-phrase', null, 3), cands)

  // -- Resolve overlaps: lower priority number wins, then longer match, then earlier. ---------
  cands.sort((a, b) => a.priority - b.priority || (b.end - b.start) - (a.end - a.start) || a.start - b.start)
  const accepted: Candidate[] = []
  for (const c of cands) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue
    accepted.push(c)
  }
  accepted.sort((a, b) => a.start - b.start)
  return accepted.map(({ priority: _p, ...rest }) => rest)
}

/** True when the mention is the kind of thing that can anchor a deadline (date/relative/EOD). */
export function isDeadlineLike(m: DateMention): boolean {
  return m.kind === 'date' || m.kind === 'relative' || m.kind === 'deadline-phrase'
}
