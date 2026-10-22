import { describe, expect, it } from 'vitest'
import { analyzeText, cleanSentence, hasPersonName, type ExtractionDraft } from '@shared/text/extract'

// Tuesday 20 October 2026
const REF = new Date(2026, 9, 20, 10, 0, 0)

const TRANSCRIPT = [
  "Ravi: Okay, let's get started with the FST as-built review.",
  "Priya: The client sent the RLM comparison sheet yesterday, it's in the shared folder as RLM_Compare_Rev3.xlsx.",
  'Ravi: We decided to go with the Rev-3 basis for the invoice claim.',
  "Priya: I'll send the updated PMS to Karthik by Friday.",
  'Karthik: Can you also share the isometric list? I need it before the review on Oct 27.',
  'Priya: Sure, will do.',
  'Ravi: Action: Karthik to schedule the client call next Tuesday.',
  'Karthik: Who is handling the secondary supports drafting?',
  'Ravi: Deepak owns that. Deadline is end of month.',
  'Priya: The ticket for the missing isos is DDSP-412, see https://tracker.example.com/DDSP-412.',
  "Ravi: Agreed, we'll proceed with the bolted supports standard as finalized.",
  'Karthik: Budget for the extra manhours is about $12,000.',
  'Ravi: TODO: update the lead tracker.',
  'Priya: Should we invite the client PM to the next call?',
  'Ravi: Yes, please email him today.',
  'Karthik: The weather was nice yesterday.',
  'Priya: We spent most of the morning on the isometric list and the RLM comparison sheet.',
  'Ravi: Send the minutes to ops@example.com once done.',
  'Karthik: The quarterly numbers look fine, nothing to flag.',
  "Priya: Let's wrap up."
]
const segments = TRANSCRIPT.map((text, i) => ({ id: `seg-${i}`, text, startMs: i * 15_000 }))
const NOTE = '- [ ] Book the room for the Thursday workshop\nDecision: use the "Design Basis Memo" as the reference document.'

const result = analyzeText({ noteText: NOTE, segments, referenceDate: REF })
const byKind = (kind: ExtractionDraft['kind']): ExtractionDraft[] => result.filter((r) => r.kind === kind)
const texts = (kind: ExtractionDraft['kind']): string[] => byKind(kind).map((r) => r.text)

describe('analyzeText — actions', () => {
  it('finds commitments and assignments that are not better classified as deadlines', () => {
    const t = texts('action')
    expect(t).toContain('TODO: update the lead tracker.')
    expect(t).toContain('Can you also share the isometric list?')
    expect(t).toContain('Send the minutes to ops@example.com once done.')
    expect(t).not.toContain('Book the room for the Thursday workshop') // resolves "Thursday" → deadline
  })
  it('does not invent actions from narrative or meeting-flow sentences', () => {
    const t = texts('action')
    expect(t).not.toContain('The weather was nice yesterday.')
    expect(t).not.toContain('The quarterly numbers look fine, nothing to flag.')
    expect(t).not.toContain('Who is handling the secondary supports drafting?')
    expect(t).not.toContain('We decided to go with the Rev-3 basis for the invoice claim.')
    expect(t).not.toContain("Okay, let's get started with the FST as-built review.")
    expect(t).not.toContain("Let's wrap up.")
  })
  it('drops weak actions (score < 0.35) unless they carry a name or an explicit cue', () => {
    const run = (text: string) => analyzeText({ noteText: text, segments: [], referenceDate: REF }).filter((r) => r.kind === 'action')
    expect(run('Let us start with the FST as-built status.')).toHaveLength(0)
    expect(run('We could review it sometime.')).toHaveLength(0)
    expect(run('Karthik to review it sometime.')).toHaveLength(1) // name
    expect(run('[ ] review it sometime')).toHaveLength(1) // explicit checkbox cue
    expect(run('Please review it sometime.')).toHaveLength(1) // explicit cue
    expect(run('I will review it sometime.')).toHaveLength(1) // commitment cue
  })
  it('is sorted by score desc within the kind', () => {
    const a = byKind('action')
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score)
  })
})

describe('analyzeText — one kind per sentence', () => {
  const kindsOf = (text: string): string[] =>
    analyzeText({ noteText: '', segments: [{ id: 'x', text, startMs: 0 }], referenceDate: REF })
      .filter((r) => ['action', 'decision', 'deadline', 'question'].includes(r.kind))
      .map((r) => r.kind)

  it('a sentence appears in at most one of action/decision/deadline/question', () => {
    const seen = new Map<string, string[]>()
    for (const r of result) {
      if (!['action', 'decision', 'deadline', 'question'].includes(r.kind)) continue
      const list = seen.get(r.sourceText) ?? []
      list.push(r.kind)
      seen.set(r.sourceText, list)
    }
    for (const [src, kinds] of seen) expect(kinds, src).toHaveLength(1)
  })
  it('request with a resolvable date → deadline only', () => {
    expect(kindsOf('Can you share the tracker with Petroka tomorrow?')).toEqual(['deadline'])
  })
  it('commitment with an explicit date → deadline only', () => {
    expect(kindsOf('We need to send the invoice by the 25th of October.')).toEqual(['deadline'])
  })
  it('wh-question without a date → question only', () => {
    expect(kindsOf('Who owns the FST as-built review?')).toEqual(['question'])
  })
  it('decision beats deadline and action', () => {
    expect(kindsOf('We agreed to ship the PMS by Friday.')).toEqual(['decision'])
  })
  it('unresolved deadline phrase does not pre-empt action', () => {
    expect(kindsOf('I will send the report before the review.')).toEqual(['action'])
    expect(kindsOf('Please finish it sometime this week.')).toEqual(['action'])
  })
  it('references and topics may overlap with the other kinds', () => {
    const r = analyzeText({ noteText: '', segments: [{ id: 'x', text: 'Please send the invoice claim summary to ops@example.com by Friday.', startMs: 0 }], referenceDate: REF })
    expect(r.map((x) => x.kind)).toContain('deadline')
    expect(r.map((x) => x.kind)).toContain('reference')
  })
})

describe('analyzeText — decisions', () => {
  it('finds explicit decisions', () => {
    const t = texts('decision')
    expect(t).toContain('We decided to go with the Rev-3 basis for the invoice claim.')
    expect(t).toContain("Agreed, we'll proceed with the bolted supports standard as finalized.")
    expect(t).toContain('Decision: use the "Design Basis Memo" as the reference document.')
  })
  it('does not treat questions as decisions', () => {
    expect(texts('decision')).not.toContain('Should we invite the client PM to the next call?')
  })
})

describe('analyzeText — questions', () => {
  it('finds questions and scores "?" + wh-start highest', () => {
    const q = byKind('question')
    expect(q.map((x) => x.text)).toEqual(expect.arrayContaining([
      'Who is handling the secondary supports drafting?',
      'Should we invite the client PM to the next call?'
    ]))
    expect(q.find((x) => x.text.startsWith('Who'))!.score).toBe(1)
    // A request with no date is an action, not a question.
    expect(q.map((x) => x.text)).not.toContain('Can you also share the isometric list?')
  })
})

describe('analyzeText — deadlines', () => {
  it('finds sentences with a resolved date plus a deadline or action cue, with segment timing', () => {
    const d = byKind('deadline')
    const friday = d.find((x) => x.text.includes('by Friday'))!
    expect(friday).toBeDefined()
    expect(friday.sourceSegmentId).toBe('seg-3')
    expect(friday.startMs).toBe(3 * 15_000)
    expect(friday.sourceOrigin).toBe('transcript')
    expect(friday.score).toBe(1)
    expect(d.map((x) => x.text)).toContain('I need it before the review on Oct 27.')
    expect(d.map((x) => x.text)).toContain('Deadline is end of month.')
    expect(d.map((x) => x.text)).toContain('Book the room for the Thursday workshop')
    expect(d.map((x) => x.text)).toContain('Action: Karthik to schedule the client call next Tuesday.')
  })
  it('does not report a date mention without any cue as a deadline', () => {
    expect(texts('deadline')).not.toContain('The weather was nice yesterday.')
  })
})

describe('analyzeText — references', () => {
  it('finds URLs, emails, ticket ids, files, money and quoted document names', () => {
    const t = texts('reference')
    expect(t).toContain('https://tracker.example.com/DDSP-412')
    expect(t).toContain('DDSP-412')
    expect(t).toContain('RLM_Compare_Rev3.xlsx')
    expect(t).toContain('$12,000')
    expect(t).toContain('Design Basis Memo')
    expect(t).toContain('ops@example.com')
  })
  it('does not swallow words before a file name', () => {
    expect(texts('reference').some((x) => x.includes('folder as'))).toBe(false)
  })
  it('scores unambiguous references above quoted strings', () => {
    const r = byKind('reference')
    expect(r.find((x) => x.text === 'DDSP-412')!.score).toBe(1)
    expect(r.find((x) => x.text === 'Design Basis Memo')!.score).toBe(0.5)
  })
})

describe('analyzeText — topics', () => {
  it('returns at most 6 topics each anchored to a real sentence', () => {
    const t = byKind('topic')
    expect(t.length).toBeGreaterThan(0)
    expect(t.length).toBeLessThanOrEqual(6)
    for (const topic of t) {
      // sourceText must be a verbatim line from the input.
      const inInput = TRANSCRIPT.some((line) => line.includes(topic.sourceText)) || NOTE.includes(topic.sourceText)
      expect(inInput, `topic "${topic.text}" sourceText "${topic.sourceText}" not found`).toBe(true)
    }
  })
  it('does not use URLs, speaker names, short tokens, verbs or hyphen fragments as topics', () => {
    const t = texts('topic').map((x) => x.toLowerCase())
    expect(t.some((x) => x.includes('http'))).toBe(false)
    expect(t).not.toContain('ravi')
    expect(t).not.toContain('priya')
    expect(t).not.toContain('built')
    expect(t).not.toContain('start')
    expect(t).not.toContain('share')
    for (const x of t) if (!x.includes(' ')) expect(x.length).toBeGreaterThanOrEqual(4)
  })
  it('keeps hyphenated compounds whole and prefers multi-word phrases', () => {
    const t = texts('topic').map((x) => x.toLowerCase())
    expect(t.some((x) => x.includes('as-built'))).toBe(true)
    expect(t[0]).toContain(' ')
    expect(t.some((x) => x.includes('rlm comparison') || x.includes('isometric list') || x.includes('client call'))).toBe(true)
  })
})

describe('analyzeText — provenance and hygiene', () => {
  it('never fabricates: every sourceText is verbatim from the input', () => {
    for (const r of result) {
      const ok = TRANSCRIPT.some((line) => line.includes(r.sourceText)) || NOTE.includes(r.sourceText)
      expect(ok, `${r.kind}: "${r.sourceText}"`).toBe(true)
    }
  })
  it('text is the cleaned sentence (speaker prefix stripped), never a rewrite', () => {
    for (const r of result) {
      if (r.kind === 'reference' || r.kind === 'topic') continue
      expect(r.sourceText.replace(/^(?!Decision|Action|TODO)\w+:\s+/, '').replace(/^-?\s*\[ \]\s*/, '')).toBe(r.text)
    }
  })
  it('note-origin items carry no segment id or timing', () => {
    const note = result.filter((r) => r.sourceOrigin === 'note')
    expect(note.length).toBeGreaterThan(0)
    for (const r of note) { expect(r.sourceSegmentId).toBeNull(); expect(r.startMs).toBeNull() }
  })
  it('scores are within 0..1', () => {
    for (const r of result) { expect(r.score).toBeGreaterThanOrEqual(0); expect(r.score).toBeLessThanOrEqual(1) }
  })
  it('is sorted by kind then score desc', () => {
    const order = ['action', 'decision', 'deadline', 'question', 'reference', 'topic']
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1], b = result[i]
      const ka = order.indexOf(a.kind), kb = order.indexOf(b.kind)
      expect(ka <= kb).toBe(true)
      if (ka === kb) expect(a.score >= b.score).toBe(true)
    }
  })
  it('dedupes near-duplicate text within a kind', () => {
    const dup = analyzeText({
      noteText: 'Please send the report.\nplease send the report',
      segments: [{ id: 'x', text: 'Please send the report!', startMs: 0 }],
      referenceDate: REF
    })
    expect(dup.filter((r) => r.kind === 'action')).toHaveLength(1)
  })
  it('is deterministic', () => {
    expect(analyzeText({ noteText: NOTE, segments, referenceDate: REF })).toEqual(result)
  })
  it('returns [] for empty input', () => {
    expect(analyzeText({ noteText: '', segments: [], referenceDate: REF })).toEqual([])
  })
})

describe('helpers', () => {
  it('cleanSentence strips speakers, timestamps and checklist markers but keeps labels', () => {
    expect(cleanSentence('Ravi: hello there')).toBe('hello there')
    expect(cleanSentence('[00:12:34] Ravi Kumar: hello')).toBe('hello')
    expect(cleanSentence('- [ ] do the thing')).toBe('do the thing')
    expect(cleanSentence('Action: do the thing')).toBe('Action: do the thing')
    expect(cleanSentence('  multiple   spaces  ')).toBe('multiple spaces')
  })
  it('hasPersonName ignores sentence-initial capitals, weekdays and months', () => {
    expect(hasPersonName('Send it to Karthik tomorrow')).toBe(true)
    expect(hasPersonName('Monday is fine. Tuesday too')).toBe(false)
    expect(hasPersonName('Ping @ravi about it')).toBe(true)
    expect(hasPersonName('We meet in October')).toBe(false)
    expect(hasPersonName('Karthik will own the tracker')).toBe(true) // sentence-initial + commitment verb
    expect(hasPersonName('Karthik likes the tracker')).toBe(false)
    expect(hasPersonName('Monday will be busy')).toBe(false)
  })
})
