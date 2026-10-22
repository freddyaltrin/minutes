import { describe, expect, it } from 'vitest'
import {
  formatDateTime, proseMirrorToMarkdown, proseMirrorToText, renderNoteMarkdown, renderNoteText, renderTranscript
} from '@shared/text/export-render'

const text = (t: string, marks?: Array<{ type: string; attrs?: Record<string, unknown> }>) => ({ type: 'text', text: t, ...(marks ? { marks } : {}) })
const para = (...content: object[]) => ({ type: 'paragraph', content })

const DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Weekly sync')] },
    para(text('Plain, '), text('bold', [{ type: 'bold' }]), text(', '), text('italic', [{ type: 'italic' }]), text(', '),
      text('code', [{ type: 'code' }]), text(', '), text('struck', [{ type: 'strike' }]), text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com' } }]), text('.')),
    { type: 'heading', attrs: { level: 2 }, content: [text('Agenda')] },
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para(text('First'))] },
        {
          type: 'listItem',
          content: [
            para(text('Second')),
            {
              type: 'orderedList',
              attrs: { start: 1 },
              content: [
                { type: 'listItem', content: [para(text('Nested one'))] },
                { type: 'listItem', content: [para(text('Nested two'))] }
              ]
            }
          ]
        }
      ]
    },
    { type: 'heading', attrs: { level: 3 }, content: [text('Tasks')] },
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para(text('Done thing'))] },
        { type: 'taskItem', attrs: { checked: false }, content: [para(text('Open thing'))] }
      ]
    },
    { type: 'blockquote', content: [para(text('Quoted line one')), para(text('Quoted line two'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const x = 1\nconst y = 2')] },
    { type: 'horizontalRule' },
    para(text('Line one'), { type: 'hardBreak' }, text('Line two')),
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [para(text('Three'))] }, { type: 'listItem', content: [para(text('Four'))] }] }
  ]
}

describe('proseMirrorToMarkdown', () => {
  const md = proseMirrorToMarkdown(DOC)

  it('renders headings', () => {
    expect(md).toContain('# Weekly sync')
    expect(md).toContain('## Agenda')
    expect(md).toContain('### Tasks')
  })
  it('renders inline marks', () => {
    expect(md).toContain('Plain, **bold**, *italic*, `code`, ~~struck~~ and a [link](https://example.com).')
  })
  it('renders nested bullet and ordered lists with indentation', () => {
    expect(md).toContain('- First\n- Second\n  1. Nested one\n  2. Nested two')
  })
  it('renders task items with checkboxes', () => {
    expect(md).toContain('- [x] Done thing\n- [ ] Open thing')
  })
  it('renders blockquotes, code blocks, rules and hard breaks', () => {
    expect(md).toContain('> Quoted line one\n> \n> Quoted line two')
    expect(md).toContain('```ts\nconst x = 1\nconst y = 2\n```')
    expect(md).toContain('\n---\n')
    expect(md).toContain('Line one  \nLine two')
  })
  it('honours the ordered list start attribute', () => {
    expect(md).toContain('3. Three\n4. Four')
  })
  it('escapes markdown-significant characters in text', () => {
    expect(proseMirrorToMarkdown({ type: 'doc', content: [para(text('a * b _ c [d]'))] })).toBe('a \\* b \\_ c \\[d\\]')
  })
  it('keeps whitespace outside emphasis markers', () => {
    const doc = { type: 'doc', content: [para(text('x'), text(' bold ', [{ type: 'bold' }]), text('y'))] }
    expect(proseMirrorToMarkdown(doc)).toBe('x **bold** y')
  })
  it('accepts a JSON string, an empty string and invalid JSON', () => {
    expect(proseMirrorToMarkdown(JSON.stringify(DOC))).toBe(md)
    expect(proseMirrorToMarkdown('')).toBe('')
    expect(proseMirrorToMarkdown('not json')).toBe('not json')
  })
  it('separates blocks with a single blank line', () => {
    expect(md).not.toMatch(/\n{3,}/)
  })
})

describe('proseMirrorToText', () => {
  const txt = proseMirrorToText(DOC)
  it('drops markdown syntax but keeps structure', () => {
    expect(txt).toContain('WEEKLY SYNC')
    expect(txt).toContain('Plain, bold, italic, code, struck and a link.')
    expect(txt).toContain('- First\n- Second\n  1. Nested one\n  2. Nested two')
    expect(txt).toContain('- [x] Done thing\n- [ ] Open thing')
    expect(txt).toContain('const x = 1\nconst y = 2')
    expect(txt).not.toContain('```')
    expect(txt).not.toContain('**')
    expect(txt).toContain('Line one\nLine two')
  })
})

describe('renderNoteMarkdown / renderNoteText', () => {
  const meetingAt = new Date(2026, 9, 20, 14, 30).getTime()
  const input = {
    title: 'FST review',
    meetingAt,
    attendees: ['Ravi', 'Priya'],
    tags: [{ name: 'fst' }, 'client'],
    bodyJson: JSON.stringify({ type: 'doc', content: [para(text('Body text'))] }),
    transcript: { segments: [{ startMs: 0, text: 'Hello', speaker: 'Ravi' }, { startMs: 61_000, text: 'Bye', speaker: null }] },
    extractions: [
      { kind: 'action' as const, text: 'Send the PMS', startMs: 5000 },
      { kind: 'decision' as const, text: 'Go with Rev-3' },
      { kind: 'question' as const, text: 'Dismissed one', dismissed: true },
      { kind: 'reference' as const, text: 'DDSP-412' }
    ]
  }

  it('produces a complete markdown document', () => {
    const md = renderNoteMarkdown(input)
    expect(md.startsWith('# FST review\n\n')).toBe(true)
    expect(md).toContain(`Meeting: ${formatDateTime(meetingAt)} · Attendees: Ravi, Priya · Tags: fst, client`)
    expect(md).toContain('\nBody text\n')
    expect(md).toContain('## Action items\n\n- [ ] Send the PMS _(0:05)_')
    expect(md).toContain('## Decisions\n\n- Go with Rev-3')
    expect(md).toContain('## References\n\n- DDSP-412')
    expect(md).not.toContain('Dismissed one')
    expect(md).not.toContain('Open questions')
    expect(md).toContain('## Transcript\n\n**[0:00]** **Ravi:** Hello\n\n**[1:01]** Bye')
    expect(md.endsWith('\n')).toBe(true)
    expect(md).not.toMatch(/^---/m) // no YAML front matter
  })
  it('omits empty sections and handles an untitled note', () => {
    const md = renderNoteMarkdown({ title: '', meetingAt: null, attendees: [], tags: [], bodyJson: '' })
    expect(md).toBe('# Untitled\n')
  })
  it('produces plain text', () => {
    const t = renderNoteText(input)
    expect(t.startsWith('FST review\n==========\n')).toBe(true)
    expect(t).toContain('ACTION ITEMS\n\n[ ] Send the PMS (0:05)')
    expect(t).toContain('TRANSCRIPT\n\n[0:00] Ravi: Hello\n[1:01] Bye')
    expect(t).not.toContain('#')
  })
})

describe('renderTranscript', () => {
  const segs = [
    { startMs: 0, endMs: 1500, text: 'Hello there', speaker: 'Ravi' },
    { startMs: 2000, endMs: null, text: 'Reply', speaker: null },
    { startMs: 3_723_000, text: 'Late', speaker: 'Priya' }
  ]
  it('txt', () => {
    expect(renderTranscript(segs, 'txt')).toBe('[0:00] Ravi: Hello there\n[0:02] Reply\n[1:02:03] Priya: Late')
  })
  it('srt fills missing end times from the next cue or a default duration', () => {
    expect(renderTranscript(segs, 'srt')).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nRavi: Hello there\n\n' +
      '2\n00:00:02,000 --> 01:02:03,000\nReply\n\n' +
      '3\n01:02:03,000 --> 01:02:06,000\nPriya: Late\n'
    )
  })
  it('vtt uses a header and <v> speaker tags', () => {
    const vtt = renderTranscript(segs, 'vtt')
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500\n<v Ravi>Hello there')
    expect(vtt).toContain('00:00:02.000 --> 01:02:03.000\nReply')
  })
  it('md', () => {
    expect(renderTranscript(segs, 'md')).toBe('**[0:00]** **Ravi:** Hello there\n\n**[0:02]** Reply\n\n**[1:02:03]** **Priya:** Late')
  })
  it('handles segments without timing', () => {
    expect(renderTranscript([{ startMs: null, text: 'x' }], 'txt')).toBe('x')
    expect(renderTranscript([{ startMs: null, text: 'x' }], 'md')).toBe('x')
  })
})
