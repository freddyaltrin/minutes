import { describe, expect, it } from 'vitest'
import {
  STOPWORDS, escapeHtml, highlightTerms, makeSnippet, normalizeTerm, splitSentences, stem, tokenize
} from '@shared/text/tokenize'

describe('tokenize', () => {
  it('lowercases and strips punctuation', () => {
    expect(tokenize('Hello, World! Foo-bar.')).toEqual(['hello', 'world', 'foo', 'bar'])
  })
  it('keeps apostrophes inside words and normalises curly ones', () => {
    expect(tokenize("Don't, we’ll 'quoted'")).toEqual(["don't", "we'll", 'quoted'])
  })
  it('is unicode aware', () => {
    expect(tokenize('Café naïve Zürich 東京 42')).toEqual(['café', 'naïve', 'zürich', '東京', '42'])
  })
  it('returns [] for empty input', () => {
    expect(tokenize('')).toEqual([])
  })
})

describe('STOPWORDS', () => {
  it('has roughly 200+ entries and common words', () => {
    expect(STOPWORDS.size).toBeGreaterThanOrEqual(200)
    for (const w of ['the', 'and', 'is', 'of', "don't"]) expect(STOPWORDS.has(w)).toBe(true)
    expect(STOPWORDS.has('invoice')).toBe(false)
  })
})

describe('stem', () => {
  it('reduces inflections to a common stem', () => {
    expect(stem('running')).toBe(stem('runs'))
    expect(stem('running')).toBe('run')
    expect(stem('meetings')).toBe('meet')
    expect(stem('agreed')).toBe('agre')
    expect(stem('decisions')).toBe('decis')
    expect(stem('conditional')).toBe('condit')
    expect(stem('ponies')).toBe('poni')
    expect(stem('caresses')).toBe('caress')
    expect(stem('happily')).toBe('happili')
  })
  it('leaves short words and non-alphabetic tokens alone', () => {
    expect(stem('is')).toBe('is')
    expect(stem('ABC-123')).toBe('abc-123')
    expect(stem('2026')).toBe('2026')
  })
  it('is deterministic and idempotent-ish on stems', () => {
    expect(stem('deadline')).toBe(stem('deadlines'))
    expect(normalizeTerm('Deadlines')).toBe(stem('deadline'))
  })
})

describe('splitSentences', () => {
  it('splits on terminal punctuation and reports offsets', () => {
    const text = 'First one. Second one! Third?'
    const s = splitSentences(text)
    expect(s.map((x) => x.text)).toEqual(['First one.', 'Second one!', 'Third?'])
    for (const x of s) expect(text.slice(x.start, x.end)).toBe(x.text)
  })
  it('does not split on abbreviations, initials or decimals', () => {
    const s = splitSentences('We met Mr. Smith at 3.5 km, e.g. near J. Doe. Then we left.')
    expect(s.map((x) => x.text)).toEqual(['We met Mr. Smith at 3.5 km, e.g. near J. Doe.', 'Then we left.'])
  })
  it('treats newlines and bullets as boundaries and strips markers', () => {
    const s = splitSentences('Agenda\n- item one\n* item two\n1. numbered item\n\n2) another')
    expect(s.map((x) => x.text)).toEqual(['Agenda', 'item one', 'item two', 'numbered item', 'another'])
  })
  it('handles closing quotes after punctuation', () => {
    const s = splitSentences('He said "go." Then left.')
    expect(s.map((x) => x.text)).toEqual(['He said "go."', 'Then left.'])
  })
  it('returns [] for empty text', () => {
    expect(splitSentences('')).toEqual([])
  })
})

describe('escapeHtml', () => {
  it('escapes all five special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;')
  })
})

describe('highlightTerms', () => {
  it('wraps matches in <mark> case-insensitively with stem prefix matching', () => {
    const html = highlightTerms('The Invoices were invoiced yesterday', ['invoice'])
    expect(html).toBe('The <mark>Invoices</mark> were <mark>invoiced</mark> yesterday')
  })
  it('escapes HTML in the text and never in the mark tags', () => {
    const html = highlightTerms('<b>deadline</b> & co', ['deadline'])
    expect(html).toBe('&lt;b&gt;<mark>deadline</mark>&lt;/b&gt; &amp; co')
  })
  it('truncates to a snippet around the first match when maxLen is given', () => {
    const long = 'x '.repeat(200) + 'needle' + ' y'.repeat(200)
    const html = highlightTerms(long, ['needle'], 60)
    expect(html).toContain('<mark>needle</mark>')
    expect(html.length).toBeLessThan(120)
    expect(html.startsWith('…')).toBe(true)
  })
  it('returns escaped text unchanged when no terms match', () => {
    expect(highlightTerms('plain text', ['zzz'])).toBe('plain text')
  })
})

describe('makeSnippet', () => {
  it('returns the whole text when short', () => {
    expect(makeSnippet('short text', ['short'], 80)).toBe('short text')
  })
  it('centres on the first match with ellipses', () => {
    const text = 'a '.repeat(100) + 'target word here ' + 'b '.repeat(100)
    const snip = makeSnippet(text, ['target'], 30)
    expect(snip).toContain('target')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip.length).toBeLessThanOrEqual(30 * 2 + 2 + 40)
  })
  it('collapses whitespace', () => {
    expect(makeSnippet('a\n\n  b', [], 80)).toBe('a b')
  })
})
