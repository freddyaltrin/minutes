// Keyword extraction (TF-IDF), TextRank phrase ranking and topic segmentation.
// Pure frequency/graph algorithms — nothing learned, nothing external.

import { STOPWORDS, normalizeTerm, splitSentences, tokenize } from './tokenize'

export interface ScoredTerm {
  term: string
  score: number
}

export interface KeywordOptions {
  /** Maximum number of keywords to return (default 20). */
  topN?: number
  /** Minimum token length considered (default 3). */
  minLength?: number
  /** Extra stopwords. */
  extraStopwords?: Iterable<string>
}

/** True if a token is a usable content word (not a stopword, not purely numeric, long enough). */
export function isContentToken(tok: string, minLength = 3, extra?: ReadonlySet<string>): boolean {
  if (tok.length < minLength) return false
  if (STOPWORDS.has(tok)) return false
  if (extra && extra.has(tok)) return false
  if (/^\d+$/.test(tok)) return false
  return true
}

/** Counts tokens into a Map (term -> count). */
function countTerms(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

/**
 * Keeps the most frequent original spelling for each stem so that results are readable
 * ("meeting" instead of "meet").
 */
class SurfaceForms {
  private readonly forms = new Map<string, Map<string, number>>()
  add(stemmed: string, surface: string): void {
    let inner = this.forms.get(stemmed)
    if (!inner) { inner = new Map(); this.forms.set(stemmed, inner) }
    inner.set(surface, (inner.get(surface) ?? 0) + 1)
  }
  best(stemmed: string): string {
    const inner = this.forms.get(stemmed)
    if (!inner) return stemmed
    let bestForm = stemmed
    let bestCount = -1
    for (const [form, count] of inner) {
      // Deterministic tie-break: shorter form first, then lexical order.
      if (count > bestCount || (count === bestCount && (form.length < bestForm.length || (form.length === bestForm.length && form < bestForm)))) {
        bestForm = form
        bestCount = count
      }
    }
    return bestForm
  }
}

/**
 * TF-IDF keywords across the provided documents, scored on the whole collection.
 * With a single document there is no IDF signal, so we fall back to term frequency with
 * stopword removal and a mild length prior (longer tokens are more likely to be topical).
 */
export function extractKeywords(docs: string[], opts: KeywordOptions = {}): ScoredTerm[] {
  const topN = opts.topN ?? 20
  const minLength = opts.minLength ?? 3
  const extra = opts.extraStopwords ? new Set([...opts.extraStopwords].map((s) => s.toLowerCase())) : undefined
  const surfaces = new SurfaceForms()

  const docTerms: Map<string, number>[] = []
  for (const doc of docs) {
    const toks: string[] = []
    for (const t of tokenize(doc)) {
      if (!isContentToken(t, minLength, extra)) continue
      const s = normalizeTerm(t)
      surfaces.add(s, t)
      toks.push(s)
    }
    docTerms.push(countTerms(toks))
  }

  const scores = new Map<string, number>()
  if (docTerms.length <= 1) {
    const tf = docTerms[0] ?? new Map<string, number>()
    let total = 0
    for (const c of tf.values()) total += c
    for (const [term, count] of tf) {
      const lengthPrior = 1 + Math.min(term.length, 10) / 20 // 1.0 .. 1.5
      scores.set(term, (count / Math.max(1, total)) * lengthPrior)
    }
  } else {
    const df = new Map<string, number>()
    for (const tf of docTerms) for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1)
    const N = docTerms.length
    for (const tf of docTerms) {
      let total = 0
      for (const c of tf.values()) total += c
      for (const [term, count] of tf) {
        const idf = Math.log((N + 1) / ((df.get(term) ?? 0) + 1)) + 1
        const s = (count / Math.max(1, total)) * idf
        scores.set(term, (scores.get(term) ?? 0) + s)
      }
    }
  }

  const ranked = [...scores.entries()]
    .map(([term, score]) => ({ term: surfaces.best(term), score }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, topN)
  // Normalize so the top score is 1.
  const max = ranked[0]?.score ?? 1
  return ranked.map((r) => ({ term: r.term, score: max > 0 ? r.score / max : 0 }))
}

// ---------------------------------------------------------------------------
// TextRank
// ---------------------------------------------------------------------------

export interface TextRankOptions {
  /** Co-occurrence window size in tokens (default 4). */
  window?: number
  /** Damping factor (default 0.85). */
  damping?: number
  /** Power-iteration steps (default 50). */
  iterations?: number
  /** Convergence tolerance (default 1e-5). */
  tolerance?: number
}

/** Generic verbs that make poor single-word topics even when they recur in a meeting. */
const TOPIC_FILLER: ReadonlySet<string> = new Set([
  'ahead', 'okay', 'alright', 'really', 'maybe', 'probably', 'basically', 'actually', 'thing', 'things', 'stuff',
  'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'time', 'everyone', 'everybody', 'something', 'anything',
  'morning', 'afternoon', 'evening', 'guys', 'folks', 'kind', 'sort', 'lot', 'lots', 'bit', 'way', 'ways', 'next', 'last'
])

export const TOPIC_VERB_STOPLIST: ReadonlySet<string> = new Set([
  'start', 'started', 'starting', 'share', 'shared', 'sharing', 'send', 'sent', 'sending', 'update', 'updated',
  'updates', 'check', 'checked', 'checking', 'give', 'given', 'gave', 'keep', 'kept', 'wrap', 'invite', 'invited',
  'email', 'emailed', 'call', 'called', 'ping', 'pinged', 'discuss', 'discussed', 'talk', 'talked', 'tell', 'told',
  'ask', 'asked', 'help', 'helped', 'work', 'worked', 'working', 'try', 'tried', 'move', 'moved', 'add', 'added',
  'remove', 'removed', 'finish', 'finished', 'complete', 'completed', 'plan', 'planned', 'schedule', 'scheduled',
  'review', 'reviewed', 'follow', 'followed', 'agree', 'agreed', 'decide', 'decided', 'confirm', 'confirmed',
  'close', 'closed', 'open', 'opened', 'handle', 'handled', 'owns', 'own', 'owned'
])

/**
 * TextRank over content tokens: build an undirected co-occurrence graph within a sliding
 * window, run plain power iteration, then merge adjacent high-scoring tokens (in original
 * order) into multi-word phrases. Phrase score = sum of member scores.
 */
export function textRankPhrases(text: string, topN = 10, opts: TextRankOptions = {}): ScoredTerm[] {
  const window = opts.window ?? 4
  const damping = opts.damping ?? 0.85
  const iterations = opts.iterations ?? 50
  const tolerance = opts.tolerance ?? 1e-5

  // Candidate sequence keeps positions and sentence index so adjacency (for phrase merging) and
  // co-occurrence windows never cross a sentence boundary.
  const surfaces = new SurfaceForms()
  const seq: Array<{ stem: string; surface: string; pos: number; sent: number; candidate: boolean }> = []
  splitSentences(text).forEach((sentence, sent) => {
    for (const t of tokenize(sentence.text, { hyphens: true })) {
      const candidate = isContentToken(t)
      const s = candidate ? normalizeTerm(t) : t
      if (candidate) surfaces.add(s, t)
      seq.push({ stem: s, surface: t, pos: seq.length, sent, candidate })
    }
  })
  const candidates = seq.filter((s) => s.candidate)
  if (candidates.length === 0) return []

  // Build adjacency with edge weights = co-occurrence counts.
  const nodes = new Map<string, number>()
  for (const c of candidates) if (!nodes.has(c.stem)) nodes.set(c.stem, nodes.size)
  const n = nodes.size
  const adj: Map<number, number>[] = Array.from({ length: n }, () => new Map())
  for (let i = 0; i < candidates.length; i++) {
    const a = nodes.get(candidates[i].stem)!
    for (let j = i + 1; j < candidates.length && j < i + window; j++) {
      if (candidates[j].sent !== candidates[i].sent) break
      const b = nodes.get(candidates[j].stem)!
      if (a === b) continue
      adj[a].set(b, (adj[a].get(b) ?? 0) + 1)
      adj[b].set(a, (adj[b].get(a) ?? 0) + 1)
    }
  }
  const weightSum = adj.map((m) => { let s = 0; for (const w of m.values()) s += w; return s })

  // Power iteration.
  let rank = new Array<number>(n).fill(1 / n)
  for (let it = 0; it < iterations; it++) {
    const next = new Array<number>(n).fill((1 - damping) / n)
    for (let a = 0; a < n; a++) {
      if (weightSum[a] === 0) continue
      const share = (damping * rank[a]) / weightSum[a]
      for (const [b, w] of adj[a]) next[b] += share * w
    }
    let delta = 0
    for (let i = 0; i < n; i++) delta += Math.abs(next[i] - rank[i])
    rank = next
    if (delta < tolerance) break
  }

  const stemScore = (s: string): number => rank[nodes.get(s)!]
  const sorted = [...nodes.keys()].sort((a, b) => stemScore(b) - stemScore(a) || a.localeCompare(b))
  // "High-scoring" = within the top third of candidate nodes (at least 5).
  const keepCount = Math.max(5, Math.ceil(n / 3))
  const strong = new Set(sorted.slice(0, keepCount))

  // Merge adjacent strong tokens in original order into phrases.
  const phrases = new Map<string, { score: number; count: number; surface: string }>()
  let i = 0
  while (i < seq.length) {
    if (!seq[i].candidate || !strong.has(seq[i].stem)) { i++; continue }
    let j = i
    const stems: string[] = []
    const words: string[] = []
    while (j < seq.length && seq[j].candidate && strong.has(seq[j].stem) && seq[j].sent === seq[i].sent && stems.length < 3) {
      stems.push(seq[j].stem)
      words.push(seq[j].surface)
      j++
    }
    const key = stems.join(' ')
    const score = stems.reduce((acc, s) => acc + stemScore(s), 0)
    const existing = phrases.get(key)
    if (existing) existing.count++
    else phrases.set(key, { score, count: 1, surface: stems.length === 1 ? surfaces.best(stems[0]) : words.join(' ') })
    i = j
  }

  // Prefer phrases that recur and multi-word phrases; drop short single tokens and generic verbs.
  const ranked = [...phrases.entries()]
    .filter(([key, v]) => {
      const words = key.split(' ').length
      if (words === 1 && v.surface.length < 4) return false
      if (words === 1 && TOPIC_VERB_STOPLIST.has(v.surface)) return false
      // Numbers, ordinals ("25th"), times and adverb-like fillers are never topics.
      if (/^\d+(st|nd|rd|th)?$/.test(v.surface) || /^\d+[:.]\d+/.test(v.surface)) return false
      if (words === 1 && TOPIC_FILLER.has(v.surface)) return false
      return true
    })
    .map(([key, v]) => {
      const words = key.split(' ').length
      return { term: v.surface, score: v.score * (1 + Math.log(v.count)) * (1 + 0.25 * (words - 1)), key }
    })
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
  // Drop a phrase that is a sub-phrase of a higher-ranked phrase ("fst as-built" vs "fst as-built review").
  const kept: typeof ranked = []
  for (const r of ranked) {
    const padded = ' ' + r.key + ' '
    if (kept.some((k) => (' ' + k.key + ' ').includes(padded))) continue
    kept.push(r)
    if (kept.length >= topN) break
  }
  const max = kept[0]?.score ?? 1
  return kept.map((r) => ({ term: r.term, score: max > 0 ? r.score / max : 0 }))
}

// ---------------------------------------------------------------------------
// Topic grouping
// ---------------------------------------------------------------------------

export interface TopicSegmentInput {
  text: string
  startMs: number | null
}

export interface TopicGroupOptions {
  /** Number of segments on each side of a candidate boundary (default 3). */
  windowSize?: number
  /** Cosine similarity below which a boundary is placed (default 0.15). */
  threshold?: number
  /** A time gap (ms) larger than this always starts a new block (default 90s). */
  maxGapMs?: number
  /** Minimum segments per block to avoid fragmentation (default 2). */
  minBlockSize?: number
}

export interface TopicBlock {
  /** Index of the first segment (inclusive). */
  from: number
  /** Index of the last segment (inclusive). */
  to: number
  startMs: number | null
  endMs: number | null
  keywords: string[]
  label: string
}

/** Removes a leading "Name:" / "[00:12] Name:" speaker prefix so speaker names do not dominate topic vectors. */
const stripSpeaker = (t: string): string =>
  t.replace(/^\s*\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*/, '').replace(/^[A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2}:\s+/, '')

function termVector(texts: string[]): Map<string, number> {
  const v = new Map<string, number>()
  for (const t of texts) for (const tok of tokenize(stripSpeaker(t))) {
    if (!isContentToken(tok)) continue
    const s = normalizeTerm(tok)
    v.set(s, (v.get(s) ?? 0) + 1)
  }
  return v
}

export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [k, va] of a) { na += va * va; const vb = b.get(k); if (vb) dot += va * vb }
  for (const vb of b.values()) nb += vb * vb
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Groups consecutive segments into topic blocks. A boundary is placed before segment i when
 * the cosine similarity of the term vectors of the preceding and following windows drops
 * below `threshold`, or when the time gap between segment i-1 and i exceeds `maxGapMs`.
 * Each block is labelled with its top 3 keywords.
 */
export function topicGroups(segments: TopicSegmentInput[], opts: TopicGroupOptions = {}): TopicBlock[] {
  const windowSize = opts.windowSize ?? 3
  const threshold = opts.threshold ?? 0.15
  const maxGapMs = opts.maxGapMs ?? 90_000
  const minBlockSize = opts.minBlockSize ?? 2
  const n = segments.length
  if (n === 0) return []

  // Similarity of the windows on either side of each candidate boundary (null = not evaluable).
  const sims: Array<number | null> = new Array(n).fill(null)
  for (let i = 1; i < n; i++) {
    if (i < minBlockSize || n - i < minBlockSize) continue
    const left = termVector(segments.slice(Math.max(0, i - windowSize), i).map((s) => s.text))
    const right = termVector(segments.slice(i, Math.min(n, i + windowSize)).map((s) => s.text))
    if (left.size === 0 || right.size === 0) continue
    sims[i] = cosineSimilarity(left, right)
  }
  const simAt = (i: number): number => (i >= 1 && i < n && sims[i] !== null ? (sims[i] as number) : Number.POSITIVE_INFINITY)

  const boundaries: number[] = [0]
  let lastBoundary = 0
  for (let i = 1; i < n; i++) {
    const prev = segments[i - 1]
    const cur = segments[i]
    let cut = false
    if (prev.startMs !== null && cur.startMs !== null && cur.startMs - prev.startMs > maxGapMs) cut = true
    else if (i - lastBoundary >= minBlockSize && n - i >= minBlockSize) {
      const s = simAt(i)
      // Cut at a local minimum below the threshold (TextTiling-style), so the boundary lands where
      // the vocabulary shift is sharpest rather than at the first dip.
      if (s < threshold && s <= simAt(i - 1) && s <= simAt(i + 1)) cut = true
    }
    if (cut) { boundaries.push(i); lastBoundary = i }
  }

  const blocks: TopicBlock[] = []
  for (let b = 0; b < boundaries.length; b++) {
    const from = boundaries[b]
    const to = (b + 1 < boundaries.length ? boundaries[b + 1] : n) - 1
    const text = segments.slice(from, to + 1).map((s) => stripSpeaker(s.text)).join('\n')
    const keywords = extractKeywords([text], { topN: 3 }).map((k) => k.term)
    blocks.push({
      from,
      to,
      startMs: segments[from].startMs,
      endMs: segments[to].startMs,
      keywords,
      label: keywords.length > 0 ? keywords.join(', ') : `Block ${b + 1}`
    })
  }
  return blocks
}
