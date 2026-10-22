// ProseMirror/TipTap JSON → Markdown / plain text, and full note / transcript export rendering.

import type { ExtractionKind } from '../types'
import { formatTimestamp, toSrtTime, toVttTime } from './transcript-parsers'

export interface PMMark { type: string; attrs?: Record<string, unknown> }
export interface PMNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  marks?: PMMark[]
  text?: string
}

function parseDoc(docJson: string | object): PMNode {
  if (typeof docJson === 'string') {
    const s = docJson.trim()
    if (!s) return { type: 'doc', content: [] }
    try { return JSON.parse(s) as PMNode } catch { return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: docJson }] }] } }
  }
  return (docJson ?? { type: 'doc', content: [] }) as PMNode
}

// ---- inline rendering ----------------------------------------------------------------------

function escapeMdText(s: string): string {
  // Escape characters that would otherwise be read as markdown syntax at the start of a line or inline.
  return s.replace(/([\\`*_~[\]<>])/g, '\\$1')
}

function renderInline(nodes: PMNode[] | undefined, md: boolean): string {
  if (!nodes) return ''
  let out = ''
  for (const n of nodes) {
    if (n.type === 'hardBreak') { out += md ? '  \n' : '\n'; continue }
    if (n.type === 'text') {
      let t = n.text ?? ''
      if (!md) { out += t; continue }
      const marks = n.marks ?? []
      const has = (name: string): boolean => marks.some((m) => m.type === name)
      if (has('code')) t = '`' + t.replace(/`/g, '\\`') + '`'
      else t = escapeMdText(t)
      // Preserve surrounding whitespace outside the emphasis markers so "**foo **" never happens.
      const lead = /^\s*/.exec(t)?.[0] ?? ''
      const trail = /\s*$/.exec(t)?.[0] ?? ''
      let core = t.slice(lead.length, t.length - trail.length)
      if (core) {
        if (has('bold')) core = `**${core}**`
        if (has('italic')) core = `*${core}*`
        if (has('strike')) core = `~~${core}~~`
        if (has('underline')) core = `<u>${core}</u>`
        const link = marks.find((m) => m.type === 'link')
        if (link) {
          const href = String(link.attrs?.['href'] ?? '')
          core = `[${core}](${href})`
        }
      }
      out += lead + core + trail
      continue
    }
    // Unknown inline node: render its children.
    out += renderInline(n.content, md)
  }
  return out
}

// ---- block rendering -----------------------------------------------------------------------

function indentLines(s: string, indent: string): string {
  return s.split('\n').map((l) => (l.length ? indent + l : l)).join('\n')
}

function renderBlocks(nodes: PMNode[] | undefined, md: boolean): string[] {
  const out: string[] = []
  if (!nodes) return out
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(renderInline(n.content, md))
        break
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 1)))
        const text = renderInline(n.content, md)
        out.push(md ? `${'#'.repeat(level)} ${text}` : text.toUpperCase())
        break
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const ordered = n.type === 'orderedList'
        const start = Number(n.attrs?.['start'] ?? 1)
        const items: string[] = []
        ;(n.content ?? []).forEach((item, i) => {
          let marker: string
          if (ordered) marker = `${start + i}. `
          else if (n.type === 'taskList' || item.type === 'taskItem') marker = item.attrs?.['checked'] ? '- [x] ' : '- [ ] '
          else marker = '- '
          const inner = renderBlocks(item.content, md)
          const first = inner.shift() ?? ''
          const indent = ' '.repeat(marker.length)
          let line = marker + first.replace(/\n/g, '\n' + indent)
          if (inner.length) line += '\n' + inner.map((b) => indentLines(b, indent)).join('\n' + (md ? '\n' : ''))
          items.push(line)
        })
        out.push(items.join('\n'))
        break
      }
      case 'listItem':
      case 'taskItem':
        out.push(...renderBlocks(n.content, md))
        break
      case 'blockquote': {
        const inner = renderBlocks(n.content, md).join('\n\n')
        out.push(md ? inner.split('\n').map((l) => '> ' + l).join('\n') : indentLines(inner, '    '))
        break
      }
      case 'codeBlock': {
        const code = (n.content ?? []).map((c) => c.text ?? '').join('')
        const lang = String(n.attrs?.['language'] ?? '')
        out.push(md ? '```' + lang + '\n' + code + '\n```' : code)
        break
      }
      case 'horizontalRule':
        out.push(md ? '---' : '―――')
        break
      case 'image': {
        const src = String(n.attrs?.['src'] ?? '')
        const alt = String(n.attrs?.['alt'] ?? '')
        out.push(md ? `![${alt}](${src})` : alt || src)
        break
      }
      case 'hardBreak':
      case 'text':
        out.push(renderInline([n], md))
        break
      default:
        // Unknown block: flatten children.
        if (n.content) out.push(...renderBlocks(n.content, md))
    }
  }
  return out
}

/** Renders a TipTap StarterKit document (JSON string or object) as Markdown. */
export function proseMirrorToMarkdown(docJson: string | object): string {
  const doc = parseDoc(docJson)
  return renderBlocks(doc.content, true).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Renders a TipTap document as plain text (one blank line between blocks). */
export function proseMirrorToText(docJson: string | object): string {
  const doc = parseDoc(docJson)
  return renderBlocks(doc.content, false).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ---- note / transcript export --------------------------------------------------------------

export interface RenderSegment { startMs: number | null; endMs?: number | null; text: string; speaker?: string | null }
export interface RenderExtraction { kind: ExtractionKind; text: string; startMs?: number | null; dismissed?: boolean }

export interface RenderNoteInput {
  title: string
  meetingAt: number | null
  attendees: string[]
  tags: Array<string | { name: string }>
  bodyJson: string | object
  transcript?: { segments: RenderSegment[] } | null
  extractions?: RenderExtraction[] | null
}

const KIND_HEADINGS: Record<ExtractionKind, string> = {
  action: 'Action items', decision: 'Decisions', deadline: 'Deadlines', question: 'Open questions', reference: 'References', topic: 'Topics'
}
const KIND_ORDER: ExtractionKind[] = ['action', 'decision', 'deadline', 'question', 'reference', 'topic']

/** Formats an epoch timestamp as "YYYY-MM-DD HH:MM" in local time. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => (n < 10 ? '0' : '') + n
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const tagName = (t: string | { name: string }): string => (typeof t === 'string' ? t : t.name)

function metadataLine(input: RenderNoteInput): string {
  const parts: string[] = []
  if (input.meetingAt !== null && input.meetingAt !== undefined) parts.push(`Meeting: ${formatDateTime(input.meetingAt)}`)
  if (input.attendees.length) parts.push(`Attendees: ${input.attendees.join(', ')}`)
  if (input.tags.length) parts.push(`Tags: ${input.tags.map(tagName).join(', ')}`)
  return parts.join(' · ')
}

function groupExtractions(extractions: RenderExtraction[] | null | undefined): Array<[ExtractionKind, RenderExtraction[]]> {
  const groups: Array<[ExtractionKind, RenderExtraction[]]> = []
  if (!extractions) return groups
  for (const kind of KIND_ORDER) {
    const items = extractions.filter((e) => e.kind === kind && !e.dismissed)
    if (items.length) groups.push([kind, items])
  }
  return groups
}

/** Complete Markdown document for a note: H1 title, metadata line, body, extractions, transcript. */
export function renderNoteMarkdown(input: RenderNoteInput): string {
  const lines: string[] = [`# ${input.title || 'Untitled'}`]
  const meta = metadataLine(input)
  if (meta) lines.push('', meta)
  const body = proseMirrorToMarkdown(input.bodyJson)
  if (body) lines.push('', body)
  for (const [kind, items] of groupExtractions(input.extractions)) {
    lines.push('', `## ${KIND_HEADINGS[kind]}`, '')
    for (const e of items) {
      const prefix = kind === 'action' ? '- [ ] ' : '- '
      const ts = e.startMs !== null && e.startMs !== undefined ? ` _(${formatTimestamp(e.startMs)})_` : ''
      lines.push(prefix + e.text + ts)
    }
  }
  if (input.transcript && input.transcript.segments.length) {
    lines.push('', '## Transcript', '', renderTranscript(input.transcript.segments, 'md'))
  }
  return lines.join('\n').trim() + '\n'
}

/** Plain-text export of a note. */
export function renderNoteText(input: RenderNoteInput): string {
  const lines: string[] = [input.title || 'Untitled', '='.repeat(Math.max(3, (input.title || 'Untitled').length))]
  const meta = metadataLine(input)
  if (meta) lines.push(meta)
  const body = proseMirrorToText(input.bodyJson)
  if (body) lines.push('', body)
  for (const [kind, items] of groupExtractions(input.extractions)) {
    lines.push('', KIND_HEADINGS[kind].toUpperCase(), '')
    for (const e of items) {
      const prefix = kind === 'action' ? '[ ] ' : '- '
      const ts = e.startMs !== null && e.startMs !== undefined ? ` (${formatTimestamp(e.startMs)})` : ''
      lines.push(prefix + e.text + ts)
    }
  }
  if (input.transcript && input.transcript.segments.length) {
    lines.push('', 'TRANSCRIPT', '', renderTranscript(input.transcript.segments, 'txt'))
  }
  return lines.join('\n').trim() + '\n'
}

/** Renders transcript segments as txt / srt / vtt / markdown. */
export function renderTranscript(segments: RenderSegment[], format: 'txt' | 'srt' | 'vtt' | 'md'): string {
  const DEFAULT_DURATION = 3000
  const endOf = (s: RenderSegment, i: number): number => {
    if (s.endMs !== null && s.endMs !== undefined) return s.endMs
    const next = segments[i + 1]
    if (next && next.startMs !== null) return next.startMs
    return (s.startMs ?? 0) + DEFAULT_DURATION
  }
  const speakerPrefix = (s: RenderSegment): string => (s.speaker ? `${s.speaker}: ` : '')

  if (format === 'srt') {
    return segments.map((s, i) => `${i + 1}\n${toSrtTime(s.startMs ?? 0)} --> ${toSrtTime(endOf(s, i))}\n${speakerPrefix(s)}${s.text}`).join('\n\n') + '\n'
  }
  if (format === 'vtt') {
    const cues = segments.map((s, i) => `${toVttTime(s.startMs ?? 0)} --> ${toVttTime(endOf(s, i))}\n${s.speaker ? `<v ${s.speaker}>` : ''}${s.text}`)
    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n'
  }
  if (format === 'md') {
    return segments.map((s) => {
      const ts = s.startMs !== null ? `**[${formatTimestamp(s.startMs)}]** ` : ''
      const sp = s.speaker ? `**${s.speaker}:** ` : ''
      return `${ts}${sp}${s.text}`
    }).join('\n\n')
  }
  return segments.map((s) => {
    const ts = s.startMs !== null ? `[${formatTimestamp(s.startMs)}] ` : ''
    return `${ts}${speakerPrefix(s)}${s.text}`
  }).join('\n')
}
