import { describe, it, expect } from 'vitest'
import { parseIcs, parseDuration, unfold, unescapeText, zonedTimeToUtc, resolveZone, MAX_INSTANCES } from '../../../src/shared/ics'

const wrap = (body: string): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', body.trim(), 'END:VCALENDAR'].join('\r\n') + '\r\n'

const ms = (iso: string): number => Date.parse(iso)
const WINDOW = { start: ms('2026-01-01T00:00:00Z'), end: ms('2026-12-31T23:59:59Z') }

describe('helpers', () => {
  it('unfolds CRLF + space/tab continuations and strips a BOM', () => {
    const lines = unfold('﻿BEGIN:VCALENDAR\r\nDESCRIPTION:part one\r\n  part two\r\n\tpart three\nEND:VCALENDAR\n')
    // Exactly one leading whitespace char is removed per continuation (RFC 5545 §3.1).
    expect(lines).toEqual(['BEGIN:VCALENDAR', 'DESCRIPTION:part one part twopart three', 'END:VCALENDAR'])
  })

  it('unescapes TEXT values', () => {
    expect(unescapeText('a\\, b\\; c\\\\ d\\nline2\\N')).toBe('a, b; c\\ d\nline2\n')
  })

  it('parses ISO 8601 durations', () => {
    expect(parseDuration('PT1H30M')).toBe(90 * 60_000)
    expect(parseDuration('P1DT2H')).toBe(26 * 3_600_000)
    expect(parseDuration('P2W')).toBe(14 * 86_400_000)
    expect(parseDuration('-PT15M')).toBe(-15 * 60_000)
    expect(parseDuration('1H')).toBeNull()
  })

  it('converts zoned wall time to UTC with Intl, including DST', () => {
    // Asia/Kolkata is UTC+05:30 all year.
    expect(zonedTimeToUtc(2026, 3, 10, 14, 30, 0, 'Asia/Kolkata')).toBe(ms('2026-03-10T09:00:00Z'))
    // America/New_York: EST (-5) in January, EDT (-4) in July.
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, 0, 'America/New_York')).toBe(ms('2026-01-15T14:00:00Z'))
    expect(zonedTimeToUtc(2026, 7, 15, 9, 0, 0, 'America/New_York')).toBe(ms('2026-07-15T13:00:00Z'))
    // Southern hemisphere DST.
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, 0, 'Australia/Sydney')).toBe(ms('2026-01-14T22:00:00Z'))
  })

  it('maps Windows zone names and Mozilla-style TZIDs to IANA, unknown → null', () => {
    expect(resolveZone('India Standard Time')).toBe('Asia/Kolkata')
    expect(resolveZone('Pacific Standard Time')).toBe('America/Los_Angeles')
    expect(resolveZone('GMT Standard Time')).toBe('Europe/London')
    expect(resolveZone('Arabian Standard Time')).toBe('Asia/Dubai')
    expect(resolveZone('/mozilla.org/20050126_1/Asia/Kolkata')).toBe('Asia/Kolkata')
    expect(resolveZone('Nowhere/Fake')).toBeNull()
    // Unknown zones fall back to local time rather than throwing.
    expect(zonedTimeToUtc(2026, 5, 1, 10, 0, 0, 'Nowhere/Fake')).toBe(new Date(2026, 4, 1, 10, 0, 0).getTime())
  })
})

describe('parseIcs — single events', () => {
  it('parses a Google Calendar export with TZID=Asia/Kolkata, attendees and escaped text', () => {
    const ics = wrap(`
BEGIN:VTIMEZONE
TZID:Asia/Kolkata
BEGIN:STANDARD
TZOFFSETFROM:+0530
TZOFFSETTO:+0530
TZNAME:IST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Asia/Kolkata:20260310T143000
DTEND;TZID=Asia/Kolkata:20260310T153000
DTSTAMP:20260301T000000Z
ORGANIZER;CN=Fredrick:mailto:fred@example.com
UID:abc123@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Deepak Anand
 ;X-NUM-GUESTS=0:mailto:deepak@example.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION:mailto:sam@example.com
CREATED:20260201T000000Z
DESCRIPTION:Agenda\\, in order:\\n1. Review\\n2. Decide\\; then close
LAST-MODIFIED:20260201T000000Z
LOCATION:TIDEL Park\\, Pattabiram\\, Chennai
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Weekly sync — ME-102
TRANSP:OPAQUE
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:This is an event reminder
TRIGGER:-P0DT0H10M0S
END:VALARM
END:VEVENT`)
    const events = parseIcs(ics, WINDOW)
    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.uid).toBe('abc123@google.com')
    expect(e.title).toBe('Weekly sync — ME-102')
    expect(e.startsAt).toBe(ms('2026-03-10T09:00:00Z'))
    expect(e.endsAt).toBe(ms('2026-03-10T10:00:00Z'))
    expect(e.allDay).toBe(false)
    expect(e.attendees).toEqual(['Deepak Anand', 'sam@example.com'])
    expect(e.organizer).toBe('Fredrick')
    expect(e.location).toBe('TIDEL Park, Pattabiram, Chennai')
    // VALARM's DESCRIPTION must not clobber the event's own.
    expect(e.description).toBe('Agenda, in order:\n1. Review\n2. Decide; then close')
    expect(e.status).toBe('CONFIRMED')
  })

  it('parses an Outlook export using a Windows zone name', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:040000008200E00074C5B7101A82E00800000000A0B1C2D3
DTSTART;TZID="India Standard Time":20260415T100000
DTEND;TZID="India Standard Time":20260415T110000
SUMMARY:Client review
END:VEVENT
BEGIN:VEVENT
UID:pst-1
DTSTART;TZID=Pacific Standard Time:20260715T090000
DTEND;TZID=Pacific Standard Time:20260715T093000
SUMMARY:US call
END:VEVENT`)
    const [ist, pst] = parseIcs(ics, WINDOW)
    expect(ist.startsAt).toBe(ms('2026-04-15T04:30:00Z'))
    expect(ist.endsAt).toBe(ms('2026-04-15T05:30:00Z'))
    // July in Los Angeles is PDT (UTC-7) even though the zone is called "Pacific Standard Time".
    expect(pst.startsAt).toBe(ms('2026-07-15T16:00:00Z'))
  })

  it('treats all-day events as local midnight → next local midnight', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:20260501
DTEND;VALUE=DATE:20260503
SUMMARY:Offsite
END:VEVENT
BEGIN:VEVENT
UID:allday-2
DTSTART;VALUE=DATE:20260601
SUMMARY:Holiday (no DTEND)
END:VEVENT`)
    const [a, b] = parseIcs(ics, WINDOW)
    expect(a.allDay).toBe(true)
    expect(a.startsAt).toBe(new Date(2026, 4, 1).getTime())
    expect(a.endsAt).toBe(new Date(2026, 4, 3).getTime())
    expect(b.allDay).toBe(true)
    expect(b.endsAt - b.startsAt).toBe(86_400_000)
  })

  it('uses DURATION when DTEND is absent, and UTC Z times', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:dur-1
DTSTART:20260201T120000Z
DURATION:PT45M
SUMMARY:Standup
END:VEVENT`)
    const [e] = parseIcs(ics, WINDOW)
    expect(e.startsAt).toBe(ms('2026-02-01T12:00:00Z'))
    expect(e.endsAt).toBe(ms('2026-02-01T12:45:00Z'))
  })

  it('treats floating times as local time', () => {
    const [e] = parseIcs(wrap('BEGIN:VEVENT\nUID:f1\nDTSTART:20260201T093000\nDTEND:20260201T100000\nSUMMARY:Floating\nEND:VEVENT'), WINDOW)
    expect(e.startsAt).toBe(new Date(2026, 1, 1, 9, 30, 0).getTime())
  })

  it('skips cancelled events and events outside the window, and tolerates LF line endings', () => {
    const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:c1
DTSTART:20260301T100000Z
DTEND:20260301T110000Z
STATUS:CANCELLED
SUMMARY:Cancelled
END:VEVENT
BEGIN:VEVENT
UID:old
DTSTART:20250301T100000Z
DTEND:20250301T110000Z
SUMMARY:Last year
END:VEVENT
BEGIN:VEVENT
UID:keep
DTSTART:20260301T100000Z
DTEND:20260301T110000Z
SUMMARY:Keep
END:VEVENT
END:VCALENDAR
`
    expect(parseIcs(ics, WINDOW).map((e) => e.uid)).toEqual(['keep'])
  })

  it('keeps an event that merely overlaps the window edge', () => {
    const ics = wrap('BEGIN:VEVENT\nUID:edge\nDTSTART:20251231T230000Z\nDTEND:20260101T010000Z\nSUMMARY:NYE\nEND:VEVENT')
    expect(parseIcs(ics, WINDOW)).toHaveLength(1)
  })

  it('returns [] for garbage input and is deterministic', () => {
    expect(parseIcs('not an ics file', WINDOW)).toEqual([])
    expect(parseIcs('', WINDOW)).toEqual([])
    const ics = wrap('BEGIN:VEVENT\nUID:z\nDTSTART:20260301T100000Z\nSUMMARY:Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:a\nDTSTART:20260301T100000Z\nSUMMARY:A\nEND:VEVENT')
    expect(parseIcs(ics, WINDOW).map((e) => e.uid)).toEqual(['a', 'z'])
    expect(JSON.stringify(parseIcs(ics, WINDOW))).toBe(JSON.stringify(parseIcs(ics, WINDOW)))
  })
})

describe('parseIcs — recurrence', () => {
  it('expands weekly BYDAY with EXDATE and a RECURRENCE-ID override', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:weekly@google.com
DTSTART;TZID=Asia/Kolkata:20260302T100000
DTEND;TZID=Asia/Kolkata:20260302T103000
RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260331T235959Z;BYDAY=MO,WE
EXDATE;TZID=Asia/Kolkata:20260311T100000
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:weekly@google.com
RECURRENCE-ID;TZID=Asia/Kolkata:20260318T100000
DTSTART;TZID=Asia/Kolkata:20260318T140000
DTEND;TZID=Asia/Kolkata:20260318T150000
SUMMARY:Standup (moved)
END:VEVENT`)
    const events = parseIcs(ics, WINDOW)
    const starts = events.map((e) => new Date(e.startsAt).toISOString())
    // Mon/Wed from 2 Mar to 31 Mar 2026 = 9 dates; 11 Mar excluded; 18 Mar replaced (moved to 14:00 IST).
    expect(starts).toEqual([
      '2026-03-02T04:30:00.000Z',
      '2026-03-04T04:30:00.000Z',
      '2026-03-09T04:30:00.000Z',
      '2026-03-16T04:30:00.000Z',
      '2026-03-18T08:30:00.000Z',
      '2026-03-23T04:30:00.000Z',
      '2026-03-25T04:30:00.000Z',
      '2026-03-30T04:30:00.000Z'
    ])
    const moved = events.find((e) => e.recurrenceId)!
    expect(moved.title).toBe('Standup (moved)')
    expect(moved.endsAt - moved.startsAt).toBe(60 * 60_000)
    // Every regular instance keeps the master's 30-minute duration.
    for (const e of events.filter((e) => !e.recurrenceId)) expect(e.endsAt - e.startsAt).toBe(30 * 60_000)
  })

  it('honours COUNT across instances before the window, and INTERVAL', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:daily
DTSTART:20251228T080000Z
DTEND:20251228T083000Z
RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5
SUMMARY:Every other day
END:VEVENT`)
    // Instances: 28 Dec, 30 Dec, 1 Jan, 3 Jan, 5 Jan → three fall in 2026.
    const dates = parseIcs(ics, WINDOW).map((e) => new Date(e.startsAt).toISOString().slice(0, 10))
    expect(dates).toEqual(['2026-01-01', '2026-01-03', '2026-01-05'])
  })

  it('stops at a DATE-valued UNTIL inclusively', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:until
DTSTART;VALUE=DATE:20260101
RRULE:FREQ=WEEKLY;UNTIL=20260122
SUMMARY:Thursday thing
END:VEVENT`)
    const dates = parseIcs(ics, WINDOW).map((e) => e.startsAt)
    expect(dates).toEqual([1, 8, 15, 22].map((d) => new Date(2026, 0, d).getTime()))
  })

  it('expands MONTHLY with ordinal BYDAY (2TU, -1FR) and BYMONTHDAY', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:secondtue
DTSTART:20260113T090000Z
DTEND:20260113T100000Z
RRULE:FREQ=MONTHLY;BYDAY=2TU;COUNT=3
SUMMARY:Second Tuesday
END:VEVENT
BEGIN:VEVENT
UID:lastfri
DTSTART:20260130T090000Z
RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3
SUMMARY:Last Friday
END:VEVENT
BEGIN:VEVENT
UID:bymd
DTSTART:20260131T090000Z
RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3
SUMMARY:Month end
END:VEVENT`)
    const events = parseIcs(ics, WINDOW)
    const day = (uid: string): string[] =>
      events.filter((e) => e.uid === uid).map((e) => new Date(e.startsAt).toISOString().slice(0, 10))
    expect(day('secondtue')).toEqual(['2026-01-13', '2026-02-10', '2026-03-10'])
    expect(day('lastfri')).toEqual(['2026-01-30', '2026-02-27', '2026-03-27'])
    expect(day('bymd')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('skips months that lack the DTSTART day-of-month and handles YEARLY', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:m31
DTSTART:20260131T090000Z
RRULE:FREQ=MONTHLY;COUNT=4
SUMMARY:31st only
END:VEVENT
BEGIN:VEVENT
UID:yearly
DTSTART:20200615T000000Z
RRULE:FREQ=YEARLY
SUMMARY:Anniversary
END:VEVENT`)
    const events = parseIcs(ics, WINDOW)
    const d = (uid: string): string[] => events.filter((e) => e.uid === uid).map((e) => new Date(e.startsAt).toISOString().slice(0, 10))
    expect(d('m31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'])
    expect(d('yearly')).toEqual(['2026-06-15'])
  })

  it('keeps wall-clock time across a DST change for TZID recurrences', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:dst
DTSTART;TZID=America/New_York:20260302T090000
DTEND;TZID=America/New_York:20260302T100000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:9am NY
END:VEVENT`)
    // DST starts 8 Mar 2026 in the US: 9:00 EST = 14:00Z, 9:00 EDT = 13:00Z.
    expect(parseIcs(ics, WINDOW).map((e) => new Date(e.startsAt).toISOString())).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
      '2026-03-16T13:00:00.000Z'
    ])
  })

  it('drops a cancelled override instance and caps expansion at MAX_INSTANCES', () => {
    const ics = wrap(`
BEGIN:VEVENT
UID:cx
DTSTART:20260105T090000Z
RRULE:FREQ=DAILY;COUNT=3
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:cx
RECURRENCE-ID:20260106T090000Z
DTSTART:20260106T090000Z
STATUS:CANCELLED
SUMMARY:Daily
END:VEVENT
BEGIN:VEVENT
UID:forever
DTSTART:20200101T000000Z
RRULE:FREQ=DAILY
SUMMARY:Forever
END:VEVENT`)
    const events = parseIcs(ics, { start: 0, end: ms('2030-01-01T00:00:00Z') })
    expect(events.filter((e) => e.uid === 'cx').map((e) => new Date(e.startsAt).toISOString().slice(0, 10))).toEqual(['2026-01-05', '2026-01-07'])
    expect(events.filter((e) => e.uid === 'forever')).toHaveLength(MAX_INSTANCES)
  })
})
