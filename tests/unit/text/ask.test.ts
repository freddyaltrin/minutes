import { describe, expect, it } from 'vitest'
import { buildFtsQuery, classifyQuestion, intentScanHints, scorePassage } from '@shared/text/ask'
import { findDateMentions } from '@shared/text/dates'
import { hasPersonName } from '@shared/text/extract'

const REF = new Date(2026, 9, 20, 10, 0, 0)

describe('classifyQuestion — intents', () => {
  it('deadline', () => {
    expect(classifyQuestion('When is the PMS due?').intent).toBe('deadline')
    expect(classifyQuestion('What is the deadline for the invoice claim').intent).toBe('deadline')
    expect(classifyQuestion('by when do we need the isometric list').intent).toBe('deadline')
  })
  it('assignment', () => {
    expect(classifyQuestion('Who is responsible for secondary supports?').intent).toBe('assignment')
    expect(classifyQuestion('who was assigned the lead tracker').intent).toBe('assignment')
    expect(classifyQuestion('what tasks does Karthik have').intent).toBe('assignment')
    expect(classifyQuestion('who is the owner of the RLM sheet').intent).toBe('assignment')
  })
  it('decision', () => {
    expect(classifyQuestion('What did we decide about the invoice claim?').intent).toBe('decision')
    expect(classifyQuestion('what was agreed on the bolted supports').intent).toBe('decision')
    expect(classifyQuestion('what was the outcome of the review').intent).toBe('decision')
  })
  it('topic', () => {
    expect(classifyQuestion('what did we discuss about the RLM comparison').intent).toBe('topic')
    expect(classifyQuestion('what about the lease?').intent).toBe('topic')
  })
  it('mention', () => {
    expect(classifyQuestion('where was Karthik mentioned').intent).toBe('mention')
    expect(classifyQuestion('which meetings mentioned TIDEL Park').intent).toBe('mention')
  })
  it('specific intents beat the generic mention cue', () => {
    const c = classifyQuestion('what deadlines were mentioned?')
    expect(c.intent).toBe('deadline')
    expect(c.terms).toEqual([])
    expect(classifyQuestion('which decisions were mentioned').intent).toBe('decision')
    expect(classifyQuestion('what owners were mentioned').intent).toBe('assignment')
  })
  it('mention only wins with a concrete subject term', () => {
    expect(classifyQuestion('where was Petroka mentioned').intent).toBe('mention')
    expect(classifyQuestion('what was mentioned?').intent).not.toBe('mention')
    expect(classifyQuestion('what was mentioned?').terms).toEqual([])
  })
  it('generic', () => {
    expect(classifyQuestion('invoice claim rev 3').intent).toBe('generic')
    expect(classifyQuestion('').intent).toBe('generic')
  })
})

describe('classifyQuestion — terms and expansion', () => {
  it('removes question scaffolding and intent cue words', () => {
    const c = classifyQuestion('What did we discuss about the RLM comparison?')
    expect(c.terms).toEqual(['rlm', 'comparison'])
    const d = classifyQuestion('What did we decide about the invoice claim?')
    expect(d.terms).toEqual(['invoice', 'claim'])
    const w = classifyQuestion('When is the PMS due?')
    expect(w.terms).toEqual(['pms'])
  })
  it('expands with stems (only real prefixes) and intent synonyms', () => {
    const c = classifyQuestion('When are the deliverables due?')
    expect(c.expandedTerms[0]).toBe('deliverables')
    expect(c.expandedTerms).toContain('deliver') // stem is a prefix
    expect(c.expandedTerms).toContain('deadline')
    expect(c.expandedTerms).toContain('submit')
    expect(c.expandedTerms).not.toContain('fridai') // y→i stems are not useful prefixes
    expect(new Set(c.expandedTerms).size).toBe(c.expandedTerms.length) // unique
    const a = classifyQuestion('who owns the lead tracker')
    expect(a.expandedTerms).toEqual(expect.arrayContaining(['lead', 'tracker', 'owner', 'responsible']))
    const g = classifyQuestion('lead tracker')
    expect(g.expandedTerms).toEqual(['lead', 'tracker'])
  })
  it('explains the classification', () => {
    const c = classifyQuestion('Who is responsible for the PMS?')
    expect(c.explanation).toMatch(/assignment/)
    expect(c.explanation).toMatch(/pms/)
    expect(classifyQuestion('pms').explanation).toMatch(/No intent cue/)
  })
})

describe('buildFtsQuery', () => {
  it('quotes each term and OR-joins', () => {
    expect(buildFtsQuery(['invoice', 'claim'])).toBe('"invoice" OR "claim"')
  })
  it('adds prefix wildcards outside the quotes', () => {
    expect(buildFtsQuery(['invoice'], { prefix: true })).toBe('"invoice"*')
  })
  it('neutralises FTS operators and special characters', () => {
    expect(buildFtsQuery(['AND', 'OR', 'NOT', 'NEAR'])).toBe('"AND" OR "OR" OR "NOT" OR "NEAR"')
    expect(buildFtsQuery(['foo*', 'col:bar', '(x)', '^y', '{z}'])).toBe('"foo" OR "colbar" OR "x" OR "y" OR "z"')
  })
  it('doubles embedded double quotes', () => {
    expect(buildFtsQuery(['say "hi"'])).toBe('"say" OR "hi"')
    expect(buildFtsQuery(['a"b'], { phrase: true })).toBe('"a""b"')
  })
  it('phrase mode quotes the whole input', () => {
    expect(buildFtsQuery(['invoice claim', 'rev 3'], { phrase: true })).toBe('"invoice claim rev 3"')
    expect(buildFtsQuery(['invoice claim'], { phrase: true, prefix: true })).toBe('"invoice claim"*')
  })
  it('splits multi-word terms, dedupes case-insensitively and drops empties', () => {
    expect(buildFtsQuery(['invoice claim', 'Invoice', '', '   '])).toBe('"invoice" OR "claim"')
  })
  it('returns empty string when nothing is usable', () => {
    expect(buildFtsQuery([])).toBe('')
    expect(buildFtsQuery(['***', '"'])).toBe('')
    expect(buildFtsQuery([''], { phrase: true })).toBe('')
  })
  it('strips control characters', () => {
    expect(buildFtsQuery(['inv\u0000oice'])).toBe('"invoice"')
  })
})

describe('intentScanHints', () => {
  const matches = (intent: Parameters<typeof intentScanHints>[0], passage: string): boolean => {
    const h = intentScanHints(intent)
    const dated = h.requireDate && findDateMentions(passage, REF).some((m) => m.kind !== 'time')
    const cued = h.cueRegex.test(passage) && (!h.requireName || hasPersonName(passage))
    return dated || cued
  }
  it('deadline: date mention or deadline cue', () => {
    expect(intentScanHints('deadline').requireDate).toBe(true)
    expect(matches('deadline', 'We ship on Oct 27.')).toBe(true)
    expect(matches('deadline', 'The report is due.')).toBe(true)
    expect(matches('deadline', 'Nice weather.')).toBe(false)
  })
  it('assignment: cue plus a person name', () => {
    expect(matches('assignment', 'Karthik will own the tracker.')).toBe(true)
    expect(matches('assignment', 'Someone will own the tracker.')).toBe(false)
    expect(matches('assignment', 'Karthik likes the tracker.')).toBe(false)
  })
  it('decision: decision cues', () => {
    expect(matches('decision', 'We agreed to go with Rev-3.')).toBe(true)
    expect(matches('decision', 'We looked at Rev-3.')).toBe(false)
  })
  it('topic / mention / generic: nothing', () => {
    for (const i of ['topic', 'mention', 'generic'] as const) {
      const h = intentScanHints(i)
      expect(h.requireDate).toBe(false)
      expect(h.cueRegex.test('agreed by Friday Karthik will')).toBe(false)
    }
  })
  it('returns non-global regexes that are safe to reuse', () => {
    const h = intentScanHints('decision')
    expect(h.cueRegex.global).toBe(false)
    expect(h.cueRegex.test('agreed')).toBe(true)
    expect(h.cueRegex.test('agreed')).toBe(true)
  })
})

describe('scorePassage', () => {
  const terms = ['pms', 'invoice']
  it('scores passages with more term hits higher', () => {
    const a = scorePassage('The PMS invoice was sent.', terms, 'generic', REF)
    const b = scorePassage('The weather was nice.', terms, 'generic', REF)
    const c = scorePassage('PMS only here.', terms, 'generic', REF)
    expect(a).toBeGreaterThan(c)
    expect(c).toBeGreaterThan(b)
    expect(b).toBe(0)
  })
  it('matches stems by prefix', () => {
    expect(scorePassage('Invoices were discussed', ['invoice'], 'generic', REF)).toBeGreaterThan(0)
  })
  it('boosts deadline passages containing dates for deadline intent', () => {
    const dated = scorePassage("I'll send the PMS by Friday.", ['pms'], 'deadline', REF)
    const undated = scorePassage("I'll send the PMS soon.", ['pms'], 'deadline', REF)
    expect(dated).toBeGreaterThan(undated)
  })
  it('boosts assignment passages with names and ownership cues', () => {
    const named = scorePassage('Karthik will own the lead tracker.', ['tracker'], 'assignment', REF)
    const plain = scorePassage('The lead tracker exists.', ['tracker'], 'assignment', REF)
    expect(named).toBeGreaterThan(plain)
  })
  it('boosts decision passages with decision cues', () => {
    const d = scorePassage('We agreed to go with Rev-3 for the claim.', ['claim'], 'decision', REF)
    const n = scorePassage('The claim was mentioned.', ['claim'], 'decision', REF)
    expect(d).toBeGreaterThan(n)
  })
  it('penalises very long passages', () => {
    const short = scorePassage('pms invoice', terms, 'generic', REF)
    const long = scorePassage('pms invoice ' + 'filler word '.repeat(100), terms, 'generic', REF)
    expect(short).toBeGreaterThan(long)
  })
  it('returns > 0 for a cue-only passage when terms is empty', () => {
    expect(scorePassage("I'll send it by Friday.", [], 'deadline', REF)).toBeGreaterThan(0)
    expect(scorePassage('Karthik will handle it.', [], 'assignment', REF)).toBeGreaterThan(0)
    expect(scorePassage('We agreed.', [], 'decision', REF)).toBeGreaterThan(0)
    expect(scorePassage('Nothing relevant here.', [], 'deadline', REF)).toBe(0)
  })
  it('is deterministic and returns 0 for empty passage', () => {
    expect(scorePassage('', terms, 'generic', REF)).toBe(0)
    expect(scorePassage('PMS invoice', terms, 'deadline', REF)).toBe(scorePassage('PMS invoice', terms, 'deadline', REF))
  })
})
