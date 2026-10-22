// Tokenization, stemming, sentence splitting and snippet/highlight helpers.
// Pure, deterministic, dependency-free. Runs in both main and renderer.

/** Common English stopwords (~200). Kept as a Set for O(1) lookups. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', "aren't", 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', "can't", 'cannot', 'could', "couldn't",
  'did', "didn't", 'do', 'does', "doesn't", 'doing', "don't", 'down', 'during',
  'each', 'else', 'ever', 'every',
  'few', 'for', 'from', 'further',
  'get', 'gets', 'got', 'had', "hadn't", 'has', "hasn't", 'have', "haven't", 'having', 'he', "he'd", "he'll", "he's",
  'her', 'here', "here's", 'hers', 'herself', 'him', 'himself', 'his', 'how', "how's",
  'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it', "it's", 'its', 'itself',
  'just', 'let', "let's", 'like',
  'me', 'more', 'most', "mustn't", 'my', 'myself',
  'no', 'nor', 'not', 'of', 'off', 'ok', 'okay', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours',
  'ourselves', 'out', 'over', 'own',
  'really', 'same', 'say', 'says', 'said', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so',
  'some', 'such', 'sure',
  'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's", 'these',
  'they', "they'd", "they'll", "they're", "they've", 'thing', 'things', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'us', 'very',
  'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've", 'were', "weren't", 'what', "what's", 'when', "when's",
  'where', "where's", 'which', 'while', 'who', "who's", 'whom', 'why', "why's", 'will', 'with', "won't", 'would',
  "wouldn't",
  'yeah', 'yes', 'yet', 'you', "you'd", "you'll", "you're", "you've", 'your', 'yours', 'yourself', 'yourselves',
  // conversational filler that is noise in meeting transcripts
  'um', 'uh', 'hmm', 'mm', 'oh', 'well', 'also', 'actually', 'basically', 'maybe', 'kind', 'sort', 'lot', 'going',
  'gonna', 'want', 'know', 'think', 'mean', 'right', 'now', 'one', 'two', 'make', 'need', 'thanks', 'thank', 'hi',
  'hello', 'hey', 'bye', 'guys', 'everyone', 'something', 'anything', 'everything', 'nothing', 'done', 'go', 'went',
  'come', 'came', 'take', 'took', 'put', 'see', 'saw', 'look', 'much', 'many', 'way', 'back', 'still', 'already',
  'even', 'though', 'although', 'however', 'therefore', 'thus', 'etc', 'via', 'per', 'vs', 'next', 'last', 'use', 'used',
  'using', 'new', 'first', 'second', 'able', 'around', 'bit', 'little', 'big', 'good', 'great', 'fine', 'nice', 'today',
  'tomorrow', 'yesterday'
])

// Unicode-aware word token: letters/digits, with apostrophes allowed *inside* a word ("don't", "we'll").
// Curly apostrophes are normalized to straight ones first.
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu

// Variant that also keeps hyphens inside words ("as-built", "sign-off") as a single token.
const WORD_HYPHEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

/**
 * Lowercase, unicode-aware word tokens. Punctuation stripped; apostrophes kept inside words.
 * With `hyphens: true`, hyphenated compounds stay one token (used for topic extraction).
 */
export function tokenize(text: string, opts: { hyphens?: boolean } = {}): string[] {
  if (!text) return []
  const out: string[] = []
  const re = opts.hyphens ? WORD_HYPHEN_RE : WORD_RE
  for (const m of text.toLowerCase().matchAll(re)) out.push(m[0].replace(/’/g, "'"))
  return out
}

// ---------------------------------------------------------------------------
// Stemmer: a compact Porter-style suffix stripper. Deterministic, English only.
// It is intentionally conservative: we only need matching stems to agree with
// each other (search/keywords), not linguistically perfect roots.
// ---------------------------------------------------------------------------

const isVowel = (w: string, i: number): boolean => {
  const c = w[i]
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return true
  // 'y' is a vowel when preceded by a consonant
  if (c === 'y') return i === 0 ? false : !isVowel(w, i - 1)
  return false
}

/** Porter "measure": number of VC sequences in the word. */
const measure = (w: string): number => {
  let m = 0
  let prevVowel = false
  for (let i = 0; i < w.length; i++) {
    const v = isVowel(w, i)
    if (!v && prevVowel) m++
    prevVowel = v
  }
  return m
}

const containsVowel = (w: string): boolean => {
  for (let i = 0; i < w.length; i++) if (isVowel(w, i)) return true
  return false
}

const endsDoubleConsonant = (w: string): boolean =>
  w.length >= 2 && w[w.length - 1] === w[w.length - 2] && !isVowel(w, w.length - 1)

// *o: stem ends cvc where the final c is not w, x or y
const endsCvc = (w: string): boolean => {
  const n = w.length
  if (n < 3) return false
  const last = w[n - 1]
  return !isVowel(w, n - 3) && isVowel(w, n - 2) && !isVowel(w, n - 1) && last !== 'w' && last !== 'x' && last !== 'y'
}

const STEP2: Array<[string, string]> = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'], ['izer', 'ize'], ['iser', 'ise'],
  ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'], ['ousli', 'ous'], ['ization', 'ize'],
  ['isation', 'ise'], ['ation', 'ate'], ['ator', 'ate'], ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'],
  ['ousness', 'ous'], ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'], ['logi', 'log']
]
const STEP3: Array<[string, string]> = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['alise', 'al'], ['iciti', 'ic'], ['ical', 'ic'], ['ful', ''], ['ness', '']
]
const STEP4 = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment', 'ent', 'ion', 'ou', 'ism', 'ate', 'iti',
  'ous', 'ive', 'ize', 'ise'
]

/** Small deterministic Porter-style stemmer. Words shorter than 3 chars are returned unchanged. */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length < 3) return w
  // Non-alphabetic words (numbers, ids) are left alone.
  if (!/^[a-z]+$/.test(w)) return w

  // Step 1a: plurals
  if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.endsWith('ies')) w = w.slice(0, -2)
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1)

  // Step 1b: -eed, -ed, -ing
  if (w.endsWith('eed')) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1)
  } else {
    let stripped: string | null = null
    if (w.endsWith('ed') && containsVowel(w.slice(0, -2))) stripped = w.slice(0, -2)
    else if (w.endsWith('ing') && containsVowel(w.slice(0, -3))) stripped = w.slice(0, -3)
    if (stripped !== null) {
      w = stripped
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz') || w.endsWith('is')) w += 'e'
      else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) w = w.slice(0, -1)
      else if (measure(w) === 1 && endsCvc(w)) w += 'e'
    }
  }

  // Step 1c: y -> i
  if (w.endsWith('y') && containsVowel(w.slice(0, -1))) w = w.slice(0, -1) + 'i'

  // Step 2
  for (const [suf, rep] of STEP2) {
    if (w.endsWith(suf)) {
      const base = w.slice(0, -suf.length)
      if (measure(base) > 0) w = base + rep
      break
    }
  }
  // Step 3
  for (const [suf, rep] of STEP3) {
    if (w.endsWith(suf)) {
      const base = w.slice(0, -suf.length)
      if (measure(base) > 0) w = base + rep
      break
    }
  }
  // Step 4
  for (const suf of STEP4) {
    if (w.endsWith(suf)) {
      const base = w.slice(0, -suf.length)
      if (measure(base) > 1) {
        if (suf === 'ion') {
          if (/[st]$/.test(base)) w = base
        } else w = base
      }
      break
    }
  }
  // Step 5a: remove trailing e
  if (w.endsWith('e')) {
    const base = w.slice(0, -1)
    const m = measure(base)
    if (m > 1 || (m === 1 && !endsCvc(base))) w = base
  }
  // Step 5b: ll -> l
  if (w.endsWith('ll') && measure(w) > 1) w = w.slice(0, -1)
  return w
}

/** Canonical form of a term for matching: lowercase + stem. */
export function normalizeTerm(word: string): string {
  return stem(word.toLowerCase().replace(/’/g, "'"))
}

// ---------------------------------------------------------------------------
// Sentence splitting
// ---------------------------------------------------------------------------

export interface SentenceSpan {
  text: string
  /** Offset of the first character of `text` in the original string. */
  start: number
  /** Offset one past the last character of `text`. */
  end: number
}

// Abbreviations after which a period does not end a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'eg', 'ie', 'no', 'inc', 'ltd', 'co',
  'corp', 'dept', 'approx', 'est', 'fig', 'ref', 'rev', 'vol', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
  'sept', 'oct', 'nov', 'dec', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'a.m', 'p.m', 'am', 'pm', 'u.s', 'u.k'
])

/**
 * Splits text into sentences with character offsets. Boundaries are:
 *  - `.`, `!`, `?` (optionally followed by closing quotes/brackets) followed by whitespace,
 *    unless the period belongs to an abbreviation, a decimal number, or a single-letter initial;
 *  - newlines (each line / bullet is its own unit; blank lines always split).
 * Whitespace and leading bullet markers are trimmed from each sentence.
 */
export function splitSentences(text: string): SentenceSpan[] {
  const out: SentenceSpan[] = []
  if (!text) return out

  const push = (start: number, end: number): void => {
    // Trim whitespace and leading list markers ("- ", "* ", "• ", "1. ", "1) ").
    let s = start
    let e = end
    while (s < e && /\s/.test(text[s])) s++
    const lead = /^(?:[-*•▪◦]|\d{1,2}[.)])\s+/.exec(text.slice(s, Math.min(e, s + 6)))
    if (lead) s += lead[0].length
    while (e > s && /\s/.test(text[e - 1])) e--
    if (e > s) out.push({ text: text.slice(s, e), start: s, end: e })
  }

  let segStart = 0
  const n = text.length
  for (let i = 0; i < n; i++) {
    const c = text[i]
    if (c === '\n' || c === '\r') {
      push(segStart, i)
      segStart = i + 1
      continue
    }
    if (c === '.' || c === '!' || c === '?') {
      // Swallow repeated terminators and closing quotes/brackets.
      let j = i + 1
      while (j < n && /[.!?]/.test(text[j])) j++
      while (j < n && /["'”’)\]]/.test(text[j])) j++
      const followedByBoundary = j >= n || /\s/.test(text[j])
      if (!followedByBoundary) continue
      if (c === '.') {
        // Decimal: "3.5" — digit on both sides.
        if (i > 0 && i + 1 < n && /\d/.test(text[i - 1]) && /\d/.test(text[i + 1])) continue
        // Numbered list marker at the start of the line: "1. item".
        const lineLead = text.slice(segStart, i)
        if (/^\s*\d{1,2}$/.test(lineLead)) continue
        // Preceding word (letters and dots) — check abbreviations and initials.
        let k = i - 1
        while (k >= 0 && /[\p{L}.]/u.test(text[k])) k--
        const word = text.slice(k + 1, i).toLowerCase()
        if (word.length === 1 && /\p{L}/u.test(word)) continue // "J. Smith"
        if (ABBREVIATIONS.has(word)) continue
        // Abbreviation with internal dots like "e.g." (word captured as "e.g").
        if (word.includes('.') && ABBREVIATIONS.has(word.replace(/\.$/, ''))) continue
      }
      push(segStart, j)
      segStart = j
      i = j - 1
    }
  }
  push(segStart, n)
  return out
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface MatchSpan { start: number; end: number }

/** Finds spans of words in `text` whose stem starts with the stem of any term (case-insensitive). */
function findTermSpans(text: string, terms: string[]): MatchSpan[] {
  const stems = terms.map((t) => normalizeTerm(t)).filter((t) => t.length > 0)
  const raw = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0)
  if (stems.length === 0) return []
  const spans: MatchSpan[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(WORD_RE)) {
    const word = m[0]
    const ws = normalizeTerm(word)
    const hit = stems.some((s) => ws.startsWith(s)) || raw.some((r) => word.startsWith(r))
    if (hit) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + word.length })
  }
  return spans
}

/**
 * Returns an HTML-escaped copy of `text` (optionally truncated to `maxLen` characters around
 * the first match) with `<mark>` wrapped around words matching any term (prefix match on stems).
 */
export function highlightTerms(text: string, terms: string[], maxLen?: number): string {
  let source = text
  if (maxLen !== undefined && text.length > maxLen) {
    source = makeSnippet(text, terms, Math.floor(maxLen / 2))
  }
  const spans = findTermSpans(source, terms)
  if (spans.length === 0) return escapeHtml(source)
  let html = ''
  let cursor = 0
  for (const sp of spans) {
    html += escapeHtml(source.slice(cursor, sp.start))
    html += '<mark>' + escapeHtml(source.slice(sp.start, sp.end)) + '</mark>'
    cursor = sp.end
  }
  html += escapeHtml(source.slice(cursor))
  return html
}

/**
 * Plain-text snippet of roughly 2*radius characters centred on the first term match.
 * Falls back to the beginning of the text when nothing matches. Adds ellipses where cut.
 */
export function makeSnippet(text: string, terms: string[], radius = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= radius * 2) return clean
  const spans = findTermSpans(clean, terms)
  const centre = spans.length > 0 ? spans[0].start : 0
  let start = Math.max(0, centre - radius)
  let end = Math.min(clean.length, centre + radius)
  // Snap to word boundaries where possible.
  if (start > 0) {
    const sp = clean.lastIndexOf(' ', start)
    if (sp > 0 && start - sp < 20) start = sp + 1
  }
  if (end < clean.length) {
    const sp = clean.indexOf(' ', end)
    if (sp > 0 && sp - end < 20) end = sp
  }
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}
