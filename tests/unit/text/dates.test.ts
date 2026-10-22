import { describe, expect, it } from 'vitest'
import { findDateMentions, isDeadlineLike } from '@shared/text/dates'

// Tuesday 20 October 2026, 10:00 local time.
const REF = new Date(2026, 9, 20, 10, 0, 0)

const ymd = (ms: number | null): string | null => {
  if (ms === null) return null
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const hm = (ms: number | null): string | null => {
  if (ms === null) return null
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
const one = (text: string) => {
  const m = findDateMentions(text, REF)
  expect(m, `expected exactly one mention in "${text}", got ${JSON.stringify(m)}`).toHaveLength(1)
  return m[0]
}

describe('explicit dates', () => {
  it('parses ISO dates', () => {
    const m = one('Release date 2026-11-02 please')
    expect(m.kind).toBe('date')
    expect(m.text).toBe('2026-11-02')
    expect(ymd(m.resolved)).toBe('2026-11-02')
    expect(m.start).toBe(13)
    expect(m.end).toBe(23)
    expect(one('Release on 2026-11-02').text).toBe('on 2026-11-02')
  })
  it('parses day-first numeric dates when unambiguous', () => {
    expect(ymd(one('by 20/10/2026').resolved)).toBe('2026-10-20')
    expect(ymd(one('by 25-12-26').resolved)).toBe('2026-12-25')
    expect(ymd(one('by 10/25/2026').resolved)).toBe('2026-10-25') // month-first when second > 12
  })
  it('returns null for ambiguous numeric dates (both parts <= 12)', () => {
    const m = one('on 03/04/2026')
    expect(m.kind).toBe('date')
    expect(m.resolved).toBeNull()
  })
  it('parses "20 Oct" and "Oct 20" with and without year', () => {
    expect(ymd(one('due 20 Oct').resolved)).toBe('2026-10-20')
    expect(ymd(one('due Oct 20').resolved)).toBe('2026-10-20')
    expect(ymd(one('due October 20th, 2027').resolved)).toBe('2027-10-20')
    expect(ymd(one('the 3rd of November').resolved)).toBe('2026-11-03')
    expect(one('on Oct 20, 2026').text).toBe('on Oct 20, 2026')
    expect(one('starting Oct 20, 2026').text).toBe('Oct 20, 2026')
  })
  it('rolls a month/day without year into next year when > 60 days in the past', () => {
    expect(ymd(one('target Jan 5').resolved)).toBe('2027-01-05')
    expect(ymd(one('back on Sep 30').resolved)).toBe('2026-09-30') // within 60 days: same year
  })
  it('rejects impossible dates', () => {
    expect(one('on 2026-02-30').resolved).toBeNull()
  })
  it('does not treat "may" alone as a date', () => {
    expect(findDateMentions('we may do it', REF)).toEqual([])
  })
})

describe('weekdays', () => {
  it('bare / by / on weekday → next occurrence strictly after reference', () => {
    expect(ymd(one('by Friday').resolved)).toBe('2026-10-23')
    expect(ymd(one('on Monday').resolved)).toBe('2026-10-26')
    expect(ymd(one('Tuesday').resolved)).toBe('2026-10-27') // ref is Tuesday → next week
    expect(one('by Friday').text).toBe('by Friday')
    expect(one('by Friday').kind).toBe('relative')
  })
  it('"next <weekday>" → following calendar week', () => {
    expect(ymd(one('next Tuesday').resolved)).toBe('2026-10-27')
    expect(ymd(one('next Monday').resolved)).toBe('2026-10-26')
    expect(ymd(one('next Sunday').resolved)).toBe('2026-11-01')
  })
  it('"last <weekday>" → most recent past occurrence', () => {
    expect(ymd(one('last Monday').resolved)).toBe('2026-10-19')
    expect(ymd(one('last Tuesday').resolved)).toBe('2026-10-13')
  })
  it('handles abbreviations but not sat/sun', () => {
    expect(ymd(one('by Fri').resolved)).toBe('2026-10-23')
    expect(findDateMentions('we sat in the sun', REF)).toEqual([])
  })
})

describe('relative phrases', () => {
  it('today / tomorrow / yesterday', () => {
    expect(ymd(one('do it today').resolved)).toBe('2026-10-20')
    expect(ymd(one('tomorrow').resolved)).toBe('2026-10-21')
    expect(ymd(one('yesterday').resolved)).toBe('2026-10-19')
    expect(ymd(one('the day after tomorrow').resolved)).toBe('2026-10-22')
  })
  it('end of week / month / quarter / year', () => {
    expect(ymd(one('by end of the week').resolved)).toBe('2026-10-23')
    expect(ymd(one('end of month').resolved)).toBe('2026-10-31')
    expect(ymd(one('end of the quarter').resolved)).toBe('2026-12-31')
    expect(ymd(one('by the end of year').resolved)).toBe('2026-12-31')
    expect(one('by the end of the week').text).toBe('by the end of the week')
  })
  it('next / last week, month, quarter, year', () => {
    expect(ymd(one('next week').resolved)).toBe('2026-10-26')
    expect(ymd(one('next month').resolved)).toBe('2026-11-01')
    expect(ymd(one('next quarter').resolved)).toBe('2027-01-01')
    expect(ymd(one('next year').resolved)).toBe('2027-01-01')
    expect(ymd(one('last week').resolved)).toBe('2026-10-12')
  })
  it('"this week" is ambiguous → null', () => {
    const m = one('sometime this week')
    expect(m.kind).toBe('relative')
    expect(m.resolved).toBeNull()
  })
  it('in N days / weeks / months', () => {
    expect(ymd(one('in two weeks').resolved)).toBe('2026-11-03')
    expect(ymd(one('in 3 days').resolved)).toBe('2026-10-23')
    expect(ymd(one('in a month').resolved)).toBe('2026-11-20')
    expect(ymd(one('in a couple of weeks').resolved)).toBe('2026-11-03')
    expect(one('in a few days').resolved).toBeNull()
  })
})

describe('times', () => {
  it('12-hour times', () => {
    expect(hm(one('at 3pm').resolved)).toBe('15:00')
    expect(hm(one('at 3:30 pm').resolved)).toBe('15:30')
    expect(hm(one('10 a.m.').resolved)).toBe('10:00')
    expect(hm(one('12am').resolved)).toBe('00:00')
    expect(hm(one('12pm').resolved)).toBe('12:00')
    expect(one('at 3pm').kind).toBe('time')
  })
  it('24-hour times, but not hh:mm:ss timestamps', () => {
    expect(hm(one('call at 15:30').resolved)).toBe('15:30')
    expect(findDateMentions('timestamp 00:15:30 here', REF)).toEqual([])
  })
  it('noon / midnight', () => {
    expect(hm(one('by noon').resolved)).toBe('12:00')
    expect(hm(one('at midnight').resolved)).toBe('00:00')
  })
  it('a time next to a date yields two mentions', () => {
    const m = findDateMentions('tomorrow at 3pm', REF)
    expect(m.map((x) => x.kind)).toEqual(['relative', 'time'])
  })
})

describe('deadline phrases', () => {
  it('EOD / COB resolve to end of the reference day', () => {
    const m = one('send it by EOD')
    expect(m.kind).toBe('deadline-phrase')
    expect(m.text).toBe('by EOD')
    expect(ymd(m.resolved)).toBe('2026-10-20')
    expect(hm(m.resolved)).toBe('23:59')
    expect(one('before COB').kind).toBe('deadline-phrase')
  })
  it('due / deadline / ASAP / before the X are unresolved deadline phrases', () => {
    expect(one('the report is due').resolved).toBeNull()
    expect(one('deadline').kind).toBe('deadline-phrase')
    expect(one('ASAP').resolved).toBeNull()
    const m = one('finish before the review')
    expect(m.text).toBe('before the review')
    expect(m.resolved).toBeNull()
  })
  it('"due to" is not a deadline', () => {
    expect(findDateMentions('delayed due to rain', REF)).toEqual([])
  })
  it('"due Friday" is one mention resolved to Friday', () => {
    const m = one('due Friday')
    expect(m.text).toBe('due Friday')
    expect(ymd(m.resolved)).toBe('2026-10-23')
  })
})

describe('ordering, overlap and helpers', () => {
  it('returns non-overlapping mentions sorted by position', () => {
    const m = findDateMentions('Meet Oct 27 at 3pm, then deliver by Friday or before the end of month.', REF)
    expect(m.map((x) => x.text)).toEqual(['Oct 27', '3pm', 'by Friday', 'before the end of month'])
    for (let i = 1; i < m.length; i++) expect(m[i].start).toBeGreaterThanOrEqual(m[i - 1].end)
  })
  it('isDeadlineLike excludes bare times', () => {
    const [date, time] = findDateMentions('Oct 27, 3pm', REF)
    expect(isDeadlineLike(date)).toBe(true)
    expect(isDeadlineLike(time)).toBe(false)
  })
  it('is deterministic for the same reference date', () => {
    const a = findDateMentions('by Friday, in two weeks, 20 Oct', REF)
    const b = findDateMentions('by Friday, in two weeks, 20 Oct', new Date(REF.getTime()))
    expect(a).toEqual(b)
  })
  it('returns [] for text without dates', () => {
    expect(findDateMentions('nothing to see here', REF)).toEqual([])
    expect(findDateMentions('', REF)).toEqual([])
  })
})
