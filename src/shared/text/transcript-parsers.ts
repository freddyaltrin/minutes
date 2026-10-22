// SRT / WebVTT / plain-text transcript parsers and timestamp formatters. No Node APIs.

export interface ParsedSegment {
  startMs: number | null
  endMs: number | null
  text: string
  speaker: string | null
}

export type TranscriptFormat = 'srt' | 'vtt' | 'txt'

// ---- timestamp parsing ---------------------------------------------------------------------

/**
 * Parses "hh:mm:ss,mmm" / "hh:mm:ss.mmm" / "mm:ss.mmm" / "mm:ss" / "h:mm:ss" into milliseconds.
 * Returns null when the string is not a timestamp.
 */
export function parseTimestamp(s: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim())
  if (!m) return null
  const h = m[1] ? +m[1] : 0
  const min = +m[2]
  const sec = +m[3]
  const frac = m[4] ? +(m[4] + '00').slice(0, 3) : 0
  if (min > 59 || sec > 59) return null
  return ((h * 60 + min) * 60 + sec) * 1000 + frac
}

const TIMING_RE = /^\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})(?:\s+(.*))?$/

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lrm;': '', '&rlm;': '' }

/** Strips cue tags (<v Name>, <c.class>, <b>, <i>, timestamps <00:01.000>) and decodes entities. */
function cleanCueText(raw: string): { text: string; speaker: string | null } {
  let speaker: string | null = null
  const v = /<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(raw)
  if (v) speaker = v[1].trim()
  let text = raw
    .replace(/<\/?v[^>]*>/gi, '')
    .replace(/<\/?c[^>]*>/gi, '')
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '')
    .replace(/<\/?(?:b|i|u|ruby|rt|lang)[^>]*>/gi, '')
    .replace(/\{\\[^}]*\}/g, '') // ASS-style override tags sometimes found in SRT
    .replace(/&[a-z]+;|&#\d+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
  text = text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  // "Name: text" inside the cue when no <v> tag was given.
  if (!speaker) {
    const sp = /^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3}):\s+(.+)$/.exec(text)
    if (sp) { speaker = sp[1]; text = sp[2] }
  }
  return { text, speaker }
}

/** Splits content into blocks separated by blank lines, normalising line endings. */
function blocks(content: string): string[][] {
  const lines = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[][] = []
  let cur: string[] = []
  for (const line of lines) {
    if (line.trim() === '') { if (cur.length) { out.push(cur); cur = [] } }
    else cur.push(line)
  }
  if (cur.length) out.push(cur)
  return out
}

/** Parses a cue block (optional id line, timing line, text lines) shared by SRT and VTT. */
function parseCueBlock(lines: string[]): ParsedSegment | null {
  let i = 0
  if (i < lines.length && !TIMING_RE.test(lines[i]) && i + 1 < lines.length && TIMING_RE.test(lines[i + 1])) i++ // cue id
  const timing = i < lines.length ? TIMING_RE.exec(lines[i]) : null
  if (!timing) return null
  const startMs = parseTimestamp(timing[1])
  const endMs = parseTimestamp(timing[2])
  const { text, speaker } = cleanCueText(lines.slice(i + 1).join('\n'))
  if (!text) return null
  return { startMs, endMs, text, speaker }
}

/** Parses SubRip (.srt) content. Malformed blocks are skipped. */
export function parseSrt(content: string): ParsedSegment[] {
  const out: ParsedSegment[] = []
  for (const b of blocks(content)) {
    const seg = parseCueBlock(b)
    if (seg) out.push(seg)
  }
  return out
}

/** Parses WebVTT (.vtt) content: header, NOTE/STYLE/REGION blocks skipped, cue ids and settings handled. */
export function parseVtt(content: string): ParsedSegment[] {
  const out: ParsedSegment[] = []
  const bs = blocks(content)
  for (let idx = 0; idx < bs.length; idx++) {
    const b = bs[idx]
    const head = b[0].trim()
    if (idx === 0 && head.startsWith('WEBVTT')) {
      // Header block may contain a timing line only if the file omits the blank line; handle that.
      const rest = b.slice(1)
      const seg = rest.length ? parseCueBlock(rest) : null
      if (seg) out.push(seg)
      continue
    }
    if (/^(NOTE|STYLE|REGION)(\s|$)/.test(head)) continue
    const seg = parseCueBlock(b)
    if (seg) out.push(seg)
  }
  return out
}

const TXT_LEAD_TS = /^\s*(?:\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]|\((\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\)|(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?))\s*[-–:]?\s*/
const TXT_SPEAKER = /^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,3}|[A-Z][A-Z0-9 _-]{0,20}):\s+/

/**
 * Parses plain text: one segment per blank-line separated paragraph. If every non-empty line
 * carries its own timestamp or speaker prefix, each line becomes a segment instead.
 * Leading "[00:12:34]", "(12:34)" or "12:34" timestamps and "Name:" speaker prefixes are detected.
 */
export function parseTxt(content: string): ParsedSegment[] {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const allLines = normalized.split('\n').map((l) => l.trim()).filter(Boolean)
  if (allLines.length === 0) return []
  const lineHasPrefix = (l: string): boolean => TXT_LEAD_TS.test(l) || TXT_SPEAKER.test(l)
  const perLine = allLines.every(lineHasPrefix)

  const units: string[] = perLine
    ? allLines
    : blocks(normalized).map((b) => b.map((l) => l.trim()).join(' '))

  const out: ParsedSegment[] = []
  for (const unit of units) {
    let text = unit.replace(/\s+/g, ' ').trim()
    let startMs: number | null = null
    let speaker: string | null = null
    const ts = TXT_LEAD_TS.exec(text)
    if (ts) { startMs = parseTimestamp(ts[1] ?? ts[2] ?? ts[3]); text = text.slice(ts[0].length) }
    const sp = TXT_SPEAKER.exec(text)
    if (sp) { speaker = sp[1].trim(); text = text.slice(sp[0].length) }
    // Timestamp may also follow the speaker ("Alice [00:01]: ...") — handle "Name 00:12: text" loosely.
    if (startMs === null) {
      const ts2 = TXT_LEAD_TS.exec(text)
      if (ts2) { startMs = parseTimestamp(ts2[1] ?? ts2[2] ?? ts2[3]); text = text.slice(ts2[0].length) }
    }
    text = text.trim()
    if (!text) continue
    out.push({ startMs, endMs: null, text, speaker })
  }
  // Fill endMs from the next segment's start when available.
  for (let i = 0; i + 1 < out.length; i++) {
    if (out[i].startMs !== null && out[i + 1].startMs !== null) out[i].endMs = out[i + 1].startMs
  }
  return out
}

/** Detects the transcript format from file name extension, then content. */
export function detectFormat(content: string, fileName?: string): TranscriptFormat {
  const ext = fileName ? /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() : undefined
  if (ext === 'srt') return 'srt'
  if (ext === 'vtt') return 'vtt'
  if (ext === 'txt' || ext === 'md' || ext === 'text') return 'txt'
  const head = content.replace(/^﻿/, '').slice(0, 2000)
  if (/^WEBVTT/m.test(head)) return 'vtt'
  if (/^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2},\d{3}\s*-->/m.test(head)) return 'srt'
  if (/\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(head)) return /,\d{3}\s*-->/.test(head) ? 'srt' : 'vtt'
  if (/\d{1,2}:\d{2}[.,]\d{3}\s*-->/.test(head)) return 'vtt'
  return 'txt'
}

/** Parses using the detected (or given) format. */
export function parseTranscript(content: string, format?: TranscriptFormat, fileName?: string): ParsedSegment[] {
  const f = format ?? detectFormat(content, fileName)
  if (f === 'srt') return parseSrt(content)
  if (f === 'vtt') return parseVtt(content)
  return parseTxt(content)
}

// ---- formatting ---------------------------------------------------------------------------

const pad2 = (n: number): string => (n < 10 ? '0' : '') + n
const pad3 = (n: number): string => (n < 10 ? '00' : n < 100 ? '0' : '') + n

/** "12:34" or "1:02:03". With `hours: true` the hour part is always present ("0:12:34"). */
export function formatTimestamp(ms: number, opts: { hours?: boolean } = {}): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0 || opts.hours) return `${h}:${pad2(m)}:${pad2(s)}`
  return `${m}:${pad2(s)}`
}

/** "hh:mm:ss,mmm" */
export function toSrtTime(ms: number): string {
  const t = Math.max(0, Math.floor(ms))
  const h = Math.floor(t / 3_600_000)
  const m = Math.floor((t % 3_600_000) / 60_000)
  const s = Math.floor((t % 60_000) / 1000)
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(t % 1000)}`
}

/** "hh:mm:ss.mmm" */
export function toVttTime(ms: number): string {
  return toSrtTime(ms).replace(',', '.')
}
