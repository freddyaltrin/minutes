// Question classification, FTS5 query construction and passage scoring for "Ask your notes".
// Deterministic: intents come from cue words, expansion from stems + a fixed synonym table.

import type { QuestionIntent } from '../types'
import { findDateMentions } from './dates'
import { hasPersonName } from './extract'
import { STOPWORDS, normalizeTerm, tokenize } from './tokenize'

export interface QuestionClassification {
  intent: QuestionIntent
  /** Content words of the question (question scaffolding removed), original lowercase form. */
  terms: string[]
  /** `terms` plus stems and intent-specific synonyms. Unique, order-stable. */
  expandedTerms: string[]
  explanation: string
}

// Words that carry no retrieval signal in a question.
const SCAFFOLDING = new Set([
  'what', 'when', 'where', 'who', 'whom', 'whose', 'why', 'which', 'how', 'did', 'do', 'does', 'was', 'were', 'is',
  'are', 'be', 'been', 'we', 'i', 'you', 'they', 'it', 'us', 'our', 'my', 'me', 'discuss', 'discussed', 'discussing',
  'talk', 'talked', 'talking', 'say', 'said', 'mention', 'mentioned', 'mentions', 'about', 'regarding', 'on', 'of',
  'the', 'a', 'an', 'any', 'anything', 'something', 'there', 'tell', 'show', 'find', 'give', 'know', 'please',
  'meeting', 'meetings', 'note', 'notes', 'with', 'for', 'in', 'to', 'at', 'and', 'or', 'that', 'this', 'these',
  'those', 'have', 'has', 'had', 'can', 'could', 'would', 'should', 'will', 'shall', 'up', 'come', 'came', 'happen',
  'happened', 'going', 'again', 'last', 'time', 'ever', 'get', 'got'
])

// Stems of intent cue words, excluded from content terms.
const CUE_STEMS: ReadonlySet<string> = new Set(['deadline', 'due', 'assigned', 'responsible', 'owner', 'owns', 'decided', 'decide', 'agreed', 'agree', 'decision', 'outcome', 'conclude', 'conclusion', 'approved', 'approve', 'mentioned', 'mention', 'tasks', 'task', 'timeline', 'summary', 'summarize', 'overview', 'verdict'].map((w) => normalizeTerm(w)))

interface IntentRule { intent: QuestionIntent; cues: RegExp[]; synonyms: string[] }

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'mention',
    cues: [/\b(?:where|which|when)\s+(?:was|were|did|is|are)?\s*\w+(?:\s+\w+)?\s+mentioned\b/i, /\bwhich\s+(?:meetings?|notes?)\s+(?:mention|talk|discuss)/i, /\bmentioned\b/i, /\bcome\s+up\b/i],
    synonyms: []
  },
  {
    intent: 'deadline',
    cues: [/\bwhen\b/i, /\bdeadlines?\b/i, /\bdue\b/i, /\bdue\s+dates?\b/i, /\bby\s+when\b/i, /\bwhat\s+date\b/i, /\bhow\s+soon\b/i, /\btimeline\b/i, /\bschedule[d]?\s+for\b/i],
    synonyms: ['due', 'deadline', 'deliver', 'submit', 'by', 'before', 'eod', 'end', 'week', 'friday', 'monday']
  },
  {
    intent: 'assignment',
    cues: [/\bwho\b/i, /\bassign\w*\b/i, /\bresponsib\w*\b/i, /\bowners?\b/i, /\bowns\b/i, /\btasks?\b/i, /\baction\s+items?\b/i, /\bin\s+charge\b/i],
    synonyms: ['will', 'owner', 'responsible', 'assigned', 'take', 'care', 'action', 'follow', 'send', 'handle']
  },
  {
    intent: 'decision',
    cues: [/\bdecid\w*\b/i, /\bagree\w*\b/i, /\bdecisions?\b/i, /\boutcome\b/i, /\bconclu\w*\b/i, /\bapprov\w*\b/i, /\bverdict\b/i, /\bgo\s+with\b/i],
    synonyms: ['agreed', 'decided', 'decision', 'approved', 'go', 'ahead', 'confirmed', 'finalized', 'proceed']
  },
  {
    intent: 'topic',
    cues: [/\bwhat\s+(?:did\s+we\s+)?(?:discuss|talk|say|cover)/i, /\bwhat\s+about\b/i, /\bdiscuss\w*\b/i, /\btalk\w*\s+about\b/i, /\bsummar\w*\b/i, /\boverview\b/i],
    synonyms: []
  }
]

/** Classifies a natural-language question into a retrieval intent and extracts search terms. */
export function classifyQuestion(q: string): QuestionClassification {
  const question = (q ?? '').trim()
  // Collect every rule that fires; the winner is chosen after terms are known (see below).
  const fired: Array<{ rule: IntentRule; cue: string }> = []
  for (const rule of INTENT_RULES) {
    const hit = rule.cues.find((re) => re.test(question))
    if (hit) fired.push({ rule, cue: hit.exec(question)?.[0] ?? '' })
  }

  // Content terms: remove scaffolding and stopwords, keep order, unique.
  const seen = new Set<string>()
  const terms: string[] = []
  for (const tok of tokenize(question)) {
    if (SCAFFOLDING.has(tok) || STOPWORDS.has(tok)) continue
    // Intent cue words themselves are not content terms ("deadline" in "what is the deadline for X").
    if (CUE_STEMS.has(normalizeTerm(tok))) continue
    if (tok.length < 2) continue
    if (!seen.has(tok)) { seen.add(tok); terms.push(tok) }
  }

  // Intent priority: a specific intent (deadline / assignment / decision) beats the generic
  // 'mention' cue ("what deadlines were mentioned?" is a deadline question). 'mention' only wins
  // when there is a concrete subject left after scaffolding removal ("where was Petroka mentioned").
  let intent: QuestionIntent = 'generic'
  let matchedCue = ''
  let synonyms: string[] = []
  const pick = (r: { rule: IntentRule; cue: string } | undefined): boolean => {
    if (!r) return false
    intent = r.rule.intent
    matchedCue = r.cue
    synonyms = r.rule.synonyms
    return true
  }
  const specific = fired.find((f) => f.rule.intent === 'deadline' || f.rule.intent === 'assignment' || f.rule.intent === 'decision')
  const mention = fired.find((f) => f.rule.intent === 'mention')
  const topic = fired.find((f) => f.rule.intent === 'topic')
  pick(specific) || pick(mention && terms.length > 0 ? mention : undefined) || pick(topic)

  const expanded: string[] = []
  const addTerm = (t: string): void => { if (t && !seen.has(t)) { seen.add(t); expanded.push(t) } }
  // A stem is only useful for prefix matching when it is a real prefix of the word ("decid" for
  // "decide"); forms like "fridai" (Porter y→i) are skipped.
  const addStem = (w: string): void => { const st = normalizeTerm(w); if (st !== w && w.startsWith(st)) addTerm(st) }
  for (const t of terms) addStem(t)
  for (const s of synonyms) { addTerm(s); addStem(s) }
  const expandedTerms = [...terms, ...expanded]

  const explanation = intent === 'generic'
    ? `No intent cue found; matching on terms: ${terms.join(', ') || '(none)'}.`
    : `Intent "${intent}" from cue "${matchedCue}"; matching on terms: ${terms.join(', ') || '(none)'}${synonyms.length ? `; expanded with ${synonyms.slice(0, 4).join(', ')}` : ''}.`

  return { intent, terms, expandedTerms, explanation }
}

/**
 * Builds a safe FTS5 MATCH expression. Each term is double-quoted (internal quotes doubled),
 * so FTS operators (AND, OR, NOT, the star, NEAR, column filters) in user input are treated literally.
 * `prefix` appends `*` after the closing quote; `phrase` quotes the entire input as one phrase.
 * Returns '' when nothing usable remains — callers should skip the MATCH in that case.
 */
export function buildFtsQuery(terms: string[], opts: { prefix?: boolean; phrase?: boolean } = {}): string {
  const quote = (s: string): string => '"' + s.replace(/"/g, '""') + '"'
  const clean = (s: string): string => s.replace(/[\u0000-\u001f]/g, '').trim()
  if (opts.phrase) {
    const joined = clean(terms.join(' ')).replace(/\s+/g, ' ')
    if (!joined) return ''
    return quote(joined) + (opts.prefix ? '*' : '')
  }
  const parts: string[] = []
  const seen = new Set<string>()
  for (const raw of terms) {
    const t = clean(raw)
    if (!t) continue
    // Split on whitespace so a multi-word term becomes several OR'ed tokens, not an implicit AND.
    for (const piece of t.split(/\s+/)) {
      // Strip characters that are never part of a token (FTS5 unicode61 tokenizer drops them anyway).
      // Apostrophes are kept: inside the quotes FTS5 tokenizes "don't" as the phrase don + t, which is
      // exactly how the indexed text was tokenized. Stripping it ("dont") would never match.
      const token = piece.replace(/[*"()^:{}[\]]/g, '')
      if (!token || seen.has(token.toLowerCase())) continue
      seen.add(token.toLowerCase())
      parts.push(quote(token) + (opts.prefix ? '*' : ''))
    }
  }
  return parts.join(' OR ')
}

const DECISION_CUES = /\b(?:decided|agreed|agreement|decision|approved|finali[sz]ed|go\s+ahead|go\s+with|confirmed|sign(?:ed)?[\s-]?off|proceed|consensus)\b/gi
const ASSIGNMENT_CUES = /\b(?:will|i'll|we'll|owner|responsible|assigned|take\s+care|follow(?:[\s-]?up)|action|todo|handle|on\s+it|please)\b|(?:^|\s)@[\w.-]+/gi
const DEADLINE_CUES = /\b(?:by|before|until|due|deadline|eod|cob|asap|no\s+later\s+than)\b/gi

export interface IntentScanHints {
  /** When true, a passage containing a date mention (findDateMentions, non-time) counts as a hit. */
  requireDate: boolean
  /** Non-global, case-insensitive cue pattern; `/$^/` never matches (no cue scanning for this intent). */
  cueRegex: RegExp
  /** When true, a cue hit only counts if the passage also contains a person name (hasPersonName). */
  requireName: boolean
}

/**
 * Hints for scanning passages without FTS when a question has no content terms
 * ("what deadlines were mentioned?"). A passage matches when
 * `(requireDate && it has a date mention) || (cueRegex.test(passage) && (!requireName || hasPersonName(passage)))`.
 * A fresh RegExp is returned on every call so callers never share lastIndex state.
 */
export function intentScanHints(intent: QuestionIntent): IntentScanHints {
  const nonGlobal = (re: RegExp): RegExp => new RegExp(re.source, re.flags.replace('g', ''))
  switch (intent) {
    case 'deadline': return { requireDate: true, cueRegex: nonGlobal(DEADLINE_CUES), requireName: false }
    case 'assignment': return { requireDate: false, cueRegex: nonGlobal(ASSIGNMENT_CUES), requireName: true }
    case 'decision': return { requireDate: false, cueRegex: nonGlobal(DECISION_CUES), requireName: false }
    default: return { requireDate: false, cueRegex: /$^/, requireName: false }
  }
}

const countMatches = (re: RegExp, s: string): number => { re.lastIndex = 0; let n = 0; while (re.exec(s) !== null) n++; return n }

/**
 * Deterministic relevance of a passage to a question: term hits (stem prefix match, weighted
 * by distinct-term coverage) plus intent-specific cue hits. Higher is better; not normalized.
 */
export function scorePassage(passage: string, terms: string[], intent: QuestionIntent, referenceDate: Date): number {
  const toks = tokenize(passage)
  const stems = toks.map(normalizeTerm)
  const termStems = terms.map((t) => normalizeTerm(t)).filter(Boolean)
  if (toks.length === 0) return 0

  // Term hits: count tokens whose stem starts with a query stem; coverage = distinct terms hit.
  let hits = 0
  const covered = new Set<string>()
  for (const s of stems) {
    for (const q of termStems) {
      if (s === q || (q.length >= 3 && s.startsWith(q))) { hits++; covered.add(q) }
    }
  }
  const coverage = termStems.length > 0 ? covered.size / termStems.length : 0
  // Log-damped hits so long passages do not dominate; coverage rewards matching all terms.
  let score = Math.log1p(hits) + coverage * 2

  // Intent cues.
  let cueHits = 0
  if (intent === 'deadline') {
    const mentions = findDateMentions(passage, referenceDate)
    cueHits = mentions.filter((m) => m.kind !== 'time').length + countMatches(DEADLINE_CUES, passage) * 0.5
  } else if (intent === 'assignment') {
    cueHits = countMatches(ASSIGNMENT_CUES, passage) * 0.5 + (hasPersonName(passage) ? 1 : 0)
  } else if (intent === 'decision') {
    cueHits = countMatches(DECISION_CUES, passage)
  }
  score += Math.min(cueHits, 3) * 0.5

  // Mild length normalisation: very long passages are less precise.
  score *= 1 / (1 + Math.log1p(Math.max(0, toks.length - 40) / 40))
  return Math.round(score * 1000) / 1000
}
