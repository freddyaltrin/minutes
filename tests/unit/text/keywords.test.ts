import { describe, expect, it } from 'vitest'
import { cosineSimilarity, extractKeywords, isContentToken, textRankPhrases, topicGroups } from '@shared/text/keywords'

describe('isContentToken', () => {
  it('rejects stopwords, numbers and short tokens', () => {
    expect(isContentToken('the')).toBe(false)
    expect(isContentToken('42')).toBe(false)
    expect(isContentToken('ab')).toBe(false)
    expect(isContentToken('invoice')).toBe(true)
  })
})

describe('extractKeywords', () => {
  it('ranks frequent content words for a single document (TF fallback)', () => {
    const kws = extractKeywords(['The invoice claim was discussed. The invoice is due. Claim rev 3 of the invoice.'])
    expect(kws[0].term).toBe('invoice')
    expect(kws[0].score).toBe(1)
    expect(kws.map((k) => k.term)).toContain('claim')
    expect(kws.map((k) => k.term)).not.toContain('the')
  })
  it('uses IDF across documents so shared terms rank lower', () => {
    const docs = ['project schedule schedule', 'project budget budget', 'project risks risks']
    const multi = extractKeywords(docs).map((k) => k.term)
    const single = extractKeywords([docs.join(' ')]).map((k) => k.term)
    // "project" is in every doc: with IDF it drops below the distinctive terms; without IDF it is top.
    expect(single[0]).toBe('project')
    expect(multi.indexOf('project')).toBeGreaterThan(multi.indexOf('schedule'))
    expect(multi.indexOf('project')).toBeGreaterThan(multi.indexOf('budget'))
    expect(multi.indexOf('project')).toBeGreaterThan(multi.indexOf('risks'))
  })
  it('respects topN and returns readable surface forms', () => {
    const kws = extractKeywords(['meetings meetings meetings scheduled scheduled'], { topN: 1 })
    expect(kws).toHaveLength(1)
    expect(kws[0].term).toBe('meetings')
  })
  it('returns [] for empty input', () => {
    expect(extractKeywords([])).toEqual([])
    expect(extractKeywords([''])).toEqual([])
  })
  it('is deterministic', () => {
    const doc = ['alpha beta gamma alpha beta delta epsilon zeta']
    expect(extractKeywords(doc)).toEqual(extractKeywords(doc))
  })
})

describe('textRankPhrases', () => {
  const text = `The secondary support drafting standard was reviewed. Secondary support details must follow the bolted support standard.
  Ravi asked about the secondary support pilot. The pilot covers welded and bolted supports on the MM5162 project.
  We also looked at the invoice claim briefly.`

  it('finds the dominant multi-word phrase', () => {
    const phrases = textRankPhrases(text, 5)
    expect(phrases.length).toBeGreaterThan(0)
    expect(phrases[0].score).toBe(1)
    expect(phrases.map((p) => p.term.toLowerCase()).some((t) => t.includes('secondary support'))).toBe(true)
  })
  it('does not merge phrases across sentence boundaries', () => {
    const t = 'We discussed alpha. Beta was next. Alpha again. Beta again. Alpha. Beta.'
    const phrases = textRankPhrases(t, 5)
    expect(phrases.map((p) => p.term)).not.toContain('alpha beta')
  })
  it('returns [] for stopword-only text', () => {
    expect(textRankPhrases('the and of to', 5)).toEqual([])
  })
  it('respects topN', () => {
    expect(textRankPhrases(text, 2).length).toBeLessThanOrEqual(2)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors, 0 for disjoint', () => {
    const a = new Map([['x', 2], ['y', 1]])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1)
    expect(cosineSimilarity(a, new Map([['z', 1]]))).toBe(0)
    expect(cosineSimilarity(a, new Map())).toBe(0)
  })
})

describe('topicGroups', () => {
  const mk = (texts: string[], step = 10_000) => texts.map((text, i) => ({ text, startMs: i * step }))

  it('splits where vocabulary shifts', () => {
    const segs = mk([
      'The invoice claim for the FST project needs the PMS rev three.',
      'PMS rev three invoice figures were checked against the claim.',
      'Invoice claim totals are fine for the FST milestone.',
      'The office lease renewal with TIDEL Park expires in December.',
      'TIDEL Park lease terms include parking and power backup.',
      'Lease renewal paperwork for the office goes to admin.'
    ])
    const blocks = topicGroups(segs, { windowSize: 3, threshold: 0.2 })
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ from: 0, to: 2, startMs: 0 })
    expect(blocks[1]).toMatchObject({ from: 3, to: 5 })
    expect(blocks[0].keywords.length).toBeLessThanOrEqual(3)
    expect(blocks[0].label.toLowerCase()).toMatch(/invoice|claim|pms/)
    expect(blocks[1].label.toLowerCase()).toMatch(/lease|tidel|park/)
  })
  it('splits on large time gaps even with similar vocabulary', () => {
    const segs = [
      { text: 'budget review budget review', startMs: 0 },
      { text: 'budget review again', startMs: 5_000 },
      { text: 'budget review once more', startMs: 500_000 },
      { text: 'budget review final', startMs: 505_000 }
    ]
    const blocks = topicGroups(segs, { maxGapMs: 60_000 })
    expect(blocks.map((b) => b.from)).toEqual([0, 2])
  })
  it('strips speaker prefixes from labels', () => {
    const segs = mk(['Ravi: invoice invoice invoice', 'Ravi: invoice claim', 'Ravi: claim invoice'])
    const [block] = topicGroups(segs)
    expect(block.keywords).not.toContain('ravi')
  })
  it('returns [] for no segments and one block for a single segment', () => {
    expect(topicGroups([])).toEqual([])
    expect(topicGroups(mk(['hello world project']))).toHaveLength(1)
  })
})
