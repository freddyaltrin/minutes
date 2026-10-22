import { describe, expect, it } from 'vitest'
import {
  detectFormat, formatTimestamp, parseSrt, parseTimestamp, parseTranscript, parseTxt, parseVtt, toSrtTime, toVttTime
} from '@shared/text/transcript-parsers'

const SRT = `1
00:00:01,000 --> 00:00:04,500
Ravi: Okay, let's get started
with the review.

2
00:00:05,000 --> 00:00:08,250
<i>The client sent the sheet.</i>

3
00:01:02,000 --> 00:01:05,000
Priya: I'll send the PMS by Friday.
`

const VTT = `WEBVTT - Weekly sync
Kind: captions
Language: en

NOTE this is a comment
spanning lines

STYLE
::cue { color: white }

intro
00:01.000 --> 00:04.500 align:start position:10%
<v Ravi>Okay, let's get started with the review.

00:00:05.000 --> 00:00:08.250
<v.loud Priya>The client sent <c.highlight>the sheet</c>.&nbsp;Great.

00:01:02.000 --> 00:01:05.000
Karthik: Can you share the <b>isometric</b> list?

00:01:06.000 --> 00:01:07.000
<00:01:06.100>word <00:01:06.500>by word
`

describe('parseTimestamp', () => {
  it('parses the common forms', () => {
    expect(parseTimestamp('00:00:01,000')).toBe(1000)
    expect(parseTimestamp('00:01:02.500')).toBe(62_500)
    expect(parseTimestamp('01:02.5')).toBe(62_500)
    expect(parseTimestamp('12:34')).toBe(754_000)
    expect(parseTimestamp('1:02:03')).toBe(3_723_000)
    expect(parseTimestamp('10:00:00.12')).toBe(36_000_120)
  })
  it('rejects garbage', () => {
    expect(parseTimestamp('abc')).toBeNull()
    expect(parseTimestamp('00:99:00')).toBeNull()
  })
})

describe('parseSrt', () => {
  const segs = parseSrt(SRT)
  it('parses every cue with timings', () => {
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ startMs: 1000, endMs: 4500, text: "Okay, let's get started with the review.", speaker: 'Ravi' })
    expect(segs[1]).toEqual({ startMs: 5000, endMs: 8250, text: 'The client sent the sheet.', speaker: null })
    expect(segs[2].startMs).toBe(62_000)
    expect(segs[2].speaker).toBe('Priya')
  })
  it('tolerates CRLF, BOM and missing index lines', () => {
    const crlf = '﻿' + SRT.replace(/\n/g, '\r\n').replace(/^1\r\n/, '')
    const s = parseSrt(crlf)
    expect(s).toHaveLength(3)
    expect(s[0].startMs).toBe(1000)
  })
  it('skips malformed blocks', () => {
    expect(parseSrt('garbage\n\n1\nnot a timing\ntext\n\n2\n00:00:01,000 --> 00:00:02,000\nok')).toEqual([
      { startMs: 1000, endMs: 2000, text: 'ok', speaker: null }
    ])
  })
  it('returns [] for empty content', () => {
    expect(parseSrt('')).toEqual([])
  })
})

describe('parseVtt', () => {
  const segs = parseVtt(VTT)
  it('skips header, NOTE and STYLE blocks and parses cues', () => {
    expect(segs).toHaveLength(4)
  })
  it('handles cue ids, settings and mm:ss.mmm timestamps', () => {
    expect(segs[0].startMs).toBe(1000)
    expect(segs[0].endMs).toBe(4500)
  })
  it('extracts speaker from <v> tags and strips <c>, <b>, entities', () => {
    expect(segs[0]).toMatchObject({ speaker: 'Ravi', text: "Okay, let's get started with the review." })
    expect(segs[1]).toMatchObject({ speaker: 'Priya', text: 'The client sent the sheet. Great.' })
    expect(segs[2]).toMatchObject({ speaker: 'Karthik', text: 'Can you share the isometric list?' })
  })
  it('strips inline karaoke timestamps', () => {
    expect(segs[3].text).toBe('word by word')
    expect(segs[3].speaker).toBeNull()
  })
  it('handles a file with the header immediately followed by a cue', () => {
    const s = parseVtt('WEBVTT\n00:00.000 --> 00:01.000\nhello')
    expect(s).toEqual([{ startMs: 0, endMs: 1000, text: 'hello', speaker: null }])
  })
})

describe('parseTxt', () => {
  it('splits paragraphs on blank lines', () => {
    const s = parseTxt('First paragraph\nstill first.\n\nSecond paragraph.\n\n\nThird.')
    expect(s.map((x) => x.text)).toEqual(['First paragraph still first.', 'Second paragraph.', 'Third.'])
    expect(s[0]).toMatchObject({ startMs: null, endMs: null, speaker: null })
  })
  it('detects leading timestamps and speaker prefixes per line', () => {
    const s = parseTxt('[00:12:34] Ravi: Hello there\n12:40 Priya: Reply here\n(13:00) Third line\nKarthik: no timestamp')
    expect(s).toEqual([
      { startMs: 754_000, endMs: 760_000, text: 'Hello there', speaker: 'Ravi' },
      { startMs: 760_000, endMs: 780_000, text: 'Reply here', speaker: 'Priya' },
      { startMs: 780_000, endMs: null, text: 'Third line', speaker: null },
      { startMs: null, endMs: null, text: 'no timestamp', speaker: 'Karthik' }
    ])
  })
  it('detects multi-word and upper-case speaker names', () => {
    const s = parseTxt('Ravi Kumar: one\nPM: two')
    expect(s.map((x) => x.speaker)).toEqual(['Ravi Kumar', 'PM'])
  })
  it('returns [] for whitespace-only input', () => {
    expect(parseTxt('  \n\n ')).toEqual([])
  })
})

describe('detectFormat', () => {
  it('prefers the file extension', () => {
    expect(detectFormat('anything', 'a.srt')).toBe('srt')
    expect(detectFormat('anything', 'a.VTT')).toBe('vtt')
    expect(detectFormat('anything', 'a.txt')).toBe('txt')
  })
  it('sniffs content otherwise', () => {
    expect(detectFormat(VTT)).toBe('vtt')
    expect(detectFormat(SRT)).toBe('srt')
    expect(detectFormat('Just some notes\n\nmore')).toBe('txt')
    expect(detectFormat('﻿WEBVTT\n\n00:00.000 --> 00:01.000\nx')).toBe('vtt')
  })
  it('parseTranscript dispatches on the detected format', () => {
    expect(parseTranscript(SRT)).toHaveLength(3)
    expect(parseTranscript(VTT, undefined, 'x.vtt')).toHaveLength(4)
    expect(parseTranscript('hello\n\nworld', 'txt')).toHaveLength(2)
  })
})

describe('formatters', () => {
  it('formatTimestamp', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(754_000)).toBe('12:34')
    expect(formatTimestamp(3_723_000)).toBe('1:02:03')
    expect(formatTimestamp(754_000, { hours: true })).toBe('0:12:34')
    expect(formatTimestamp(-5)).toBe('0:00')
    expect(formatTimestamp(59_999)).toBe('0:59')
  })
  it('toSrtTime / toVttTime', () => {
    expect(toSrtTime(3_723_456)).toBe('01:02:03,456')
    expect(toVttTime(3_723_456)).toBe('01:02:03.456')
    expect(toSrtTime(7)).toBe('00:00:00,007')
  })
  it('round-trips through the parsers', () => {
    expect(parseTimestamp(toSrtTime(123_456))).toBe(123_456)
    expect(parseTimestamp(toVttTime(123_456))).toBe(123_456)
  })
})
