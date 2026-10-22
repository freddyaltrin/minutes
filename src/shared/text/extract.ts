// Rule-based extraction of actions, decisions, questions, deadlines, references and topics
// from note text and transcript segments. Everything is a *suggestion*: `sourceText` is the
// verbatim passage, `text` is the same sentence lightly cleaned (never rewritten), and
// `score` is a ratio of matched rules — not a probability.

import type { Extraction, ExtractionKind } from '../types'
import { findDateMentions, isDeadlineLike, type DateMention } from './dates'
import { textRankPhrases } from './keywords'
import { normalizeTerm, splitSentences, tokenize } from './tokenize'

export type ExtractionDraft = Omit<Extraction, 'id' | 'noteId' | 'dismissed' | 'createdAt'>

export interface AnalyzeInput {
  noteText: string
  segments: Array<{ id: string; text: string; startMs: number | null }>
  referenceDate: Date
}

/** A sentence-sized unit with provenance. */
interface Unit {
  raw: string
  clean: string
  origin: 'note' | 'transcript'
  segmentId: string | null
  startMs: number | null
  /** Global order for stable sorting. */
  order: number
}

// ---- cue tables -------------------------------------------------------------------------

/** Labels that look like "Name:" prefixes but are not speakers. */
const LABEL_WORDS = new Set(['action', 'actions', 'action item', 'action items', 'todo', 'to-do', 'decision', 'decisions', 'note', 'notes', 'question', 'questions', 'deadline', 'reference', 'summary', 'agenda', 'ai', 'next steps'])

const ACTION_CUES: Array<{ name: string; re: RegExp }> = [
  { name: 'commitment', re: /\b(?:i|we|you|they|he|she)(?:'ll|\s+will|\s+shall|\s+need\s+to|\s+needs\s+to|\s+have\s+to|\s+has\s+to|\s+must|\s+should|\s+(?:am|are|is)\s+going\s+to|\s+gonna)\b/i },
  { name: 'label', re: /\b(?:action(?:\s+item)?s?|todo|to-do|next steps?)\s*:/i },
  { name: 'todo', re: /\bTODO\b/ },
  // "let's" counts only when it is not meeting-flow chatter ("let's get started", "let's wrap up").
  { name: 'lets', re: /\blet(?:'s|\s+us)\s+(?!(?:get\s+started|start|begin|wrap(?:\s+up)?|move\s+on|continue|kick\s+off|dive\s+in|jump\s+in|go\s+ahead|see|say|take\s+a\s+look)\b)/i },
  // Sentence-initial imperative verb: "Send the minutes…", "Update the tracker…".
  { name: 'imperative', re: /^(?:send|share|schedule|assign|prepare|draft|update|circulate|book|set\s+up|organi[sz]e|finish|complete|fix|check|confirm|create|write|email|call|ping|remind|submit|deliver|coordinate|arrange|investigate|look\s+into|reach\s+out|follow\s+up|add|remove|ask|get|make|put|bring|take|review)\b/i },
  { name: 'request', re: /\b(?:can|could|would|will)\s+(?:you|someone|somebody|anyone)\b/i },
  { name: 'please', re: /\bplease\b/i },
  { name: 'followup', re: /\bfollow(?:[\s-]?up)\b/i },
  { name: 'verb', re: /\b(?:send|share|schedule|assign|prepare|draft|update|circulate|book|set\s+up|organi[sz]e|finish|complete|fix|check|confirm|create|write|email|call|ping|remind|submit|deliver|review|coordinate|arrange|investigate|look\s+into|reach\s+out|get\s+back|take\s+care|own|handle|sort\s+out)\b/i },
  { name: 'mention', re: /(?:^|\s)@[\w.-]+/ },
  { name: 'checkbox', re: /(?:^|\s)-?\s*\[(?: |x)\]/i },
  // "Priya to send the deck" / "Ravi will check" — a name followed by an infinitive/future verb.
  { name: 'name-to-verb', re: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:to|will|is\s+going\s+to|needs\s+to|has\s+to|should|can|is\s+to)\s+[a-z]+/ },
  { name: 'owner', re: /\b(?:owner|owns|assigned\s+to|responsible|takes?\s+ownership|on\s+it)\b/i }
]
const ACTION_MAX_CUES = 5 // denominator for the ratio (cues + name + date)
/** Actions scoring below this are dropped unless they carry a person name or an explicit cue. */
const WEAK_ACTION_THRESHOLD = 0.35
/** Cue names that count as explicit ("action:", "TODO", "[ ]", "will / need to", "please", "can you"). */
const EXPLICIT_ACTION_CUES: ReadonlySet<string> = new Set(['label', 'todo', 'checkbox', 'commitment', 'please', 'request', 'imperative'])

const DECISION_CUES: RegExp[] = [
  /\bwe\s+(?:decided|agreed|concluded|settled|resolved)\b/i,
  /\b(?:decided|agreed|agreement|consensus|unanimous)\b/i,
  /\bdecision\s*:/i,
  /\bgo\s+with\b/i,
  /\bapproved?\b/i,
  /\bfinali[sz]ed?\b/i,
  /\blet'?s\s+go\s+ahead\b/i,
  /\bgo\s+ahead\s+with\b/i,
  /\bsign(?:ed)?[\s-]?off\b/i,
  /\bconfirmed\b/i,
  /\b(?:we'll|we\s+will)\s+proceed\b/i,
  /\bproceed\s+with\b/i,
  /\bsettled\s+on\b/i,
  /\b(?:the\s+)?(?:final\s+)?(?:call|verdict|outcome)\s+is\b/i
]
const DECISION_MAX_CUES = 3

const QUESTION_START = /^(?:what|when|where|who|whom|whose|why|which|how|can\s+we|could\s+we|should\s+we|shall\s+we|do\s+we|did\s+we|does|are\s+we|is\s+it|is\s+there|will\s+we|would\s+we|have\s+we|has\s+anyone|any\s+idea|any\s+update)\b/i

const DEADLINE_CUES = /\b(?:by|before|until|till|due|deadline|no\s+later\s+than|eod|cob|asap|latest|target|within)\b/i

const REFERENCE_PATTERNS: Array<{ name: string; re: RegExp; score: number }> = [
  { name: 'url', re: /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, score: 1 },
  { name: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, score: 1 },
  { name: 'ticket', re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g, score: 1 },
  { name: 'file', re: /\b[\w()-][\w()-]{0,60}(?:\.[\w()-]+)*\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|md|png|jpe?g|gif|svg|zip|7z|rar|dwg|dxf|json|xml|yaml|yml|ts|js|py|sql|mp4|mp3|wav)\b/gi, score: 0.75 },
  { name: 'money', re: /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?\s*(?:k|m|bn|million|billion|lakh|lakhs|crore|crores)?\b)|\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn|million|billion|lakh|lakhs|crore|crores)?\s?(?:USD|EUR|GBP|INR|AED|SAR|dollars|rupees|euros|pounds|dirhams)\b/gi, score: 0.5 },
  { name: 'quoted', re: /["“]([^"”\n]{3,80})["”]/g, score: 0.5 }
]

// Capitalised words that are not person names.
const NOT_NAMES = new Set([
  'i', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'ok', 'okay', 'todo', 'action', 'decision', 'q1', 'q2',
  'q3', 'q4', 'eod', 'cob', 'asap', 'the', 'and', 'but', 'or', 'we', 'you', 'they', 'it', 'he', 'she', 'this', 'that',
  'yes', 'no', 'not', 'also', 'then', 'so', 'if', 'as', 'at', 'in', 'on', 'for', 'to', 'of', 'by', 'with', 'from',
  'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'everybody', 'nobody', 'there', 'who', 'what', 'which',
  'please', 'thanks', 'team', 'client', 'customer', 'vendor', 'management'
])

// A sentence-initial capitalised word counts as a name only when followed by an ownership/commitment verb.
const INITIAL_NAME_RE = /^([A-Z][a-z]{1,20})(?:\s+[A-Z][a-z]{1,20})?\s+(?:will|'ll|to|is\s+going\s+to|needs?\s+to|has\s+to|should|can|owns?|takes?|handles?|said|agreed|promised|is\s+on\s+it)\b/

/**
 * True if the sentence contains a likely person name: a capitalised word that is not sentence-initial,
 * an @mention, or a sentence-initial capitalised word followed by a commitment verb ("Karthik will…").
 */
export function hasPersonName(sentence: string): boolean {
  if (/(?:^|\s)@[\w.-]+/.test(sentence)) return true
  const initial = INITIAL_NAME_RE.exec(sentence.trim())
  if (initial && !NOT_NAMES.has(initial[1].toLowerCase())) return true
  const re = /(?<=\s)([A-Z][a-z]{1,20})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sentence)) !== null) {
    const before = sentence.slice(0, m.index).trimEnd()
    // Skip words right after a sentence boundary — they are capitalised for grammatical reasons.
    if (before.length === 0 || /[.!?:]$/.test(before)) continue
    if (NOT_NAMES.has(m[1].toLowerCase())) continue
    return true
  }
  return false
}

/** Removes speaker prefix, checklist markers and label prefixes; collapses whitespace. */
export function cleanSentence(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim()
  // Leading timestamp "[00:12:34]" or "12:34" from pasted transcripts.
  s = s.replace(/^\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s+/, '')
  // Speaker prefix "Name:" or "Name Surname:" (but not label words like "Action:").
  const sp = /^([A-Z][\w'.-]*(?:\s+[A-Z][\w'.-]*){0,2}):\s+/.exec(s)
  if (sp && !LABEL_WORDS.has(sp[1].toLowerCase())) s = s.slice(sp[0].length)
  // Checklist markers.
  s = s.replace(/^-?\s*\[(?: |x)\]\s*/i, '')
  // Trailing/leading quotes left by cleaning.
  return s.trim()
}

const isQuestion = (clean: string): boolean => clean.endsWith('?') || QUESTION_START.test(clean)

function buildUnits(input: AnalyzeInput): Unit[] {
  const units: Unit[] = []
  let order = 0
  for (const s of splitSentences(input.noteText ?? '')) {
    units.push({ raw: s.text, clean: cleanSentence(s.text), origin: 'note', segmentId: null, startMs: null, order: order++ })
  }
  for (const seg of input.segments ?? []) {
    for (const s of splitSentences(seg.text ?? '')) {
      units.push({ raw: s.text, clean: cleanSentence(s.text), origin: 'transcript', segmentId: seg.id, startMs: seg.startMs, order: order++ })
    }
  }
  // Drop units with no real content.
  return units.filter((u) => tokenize(u.clean).length >= 2)
}

const draft = (u: Unit, kind: ExtractionKind, text: string, score: number): ExtractionDraft => ({
  kind,
  text,
  sourceText: u.raw,
  sourceSegmentId: u.segmentId,
  sourceOrigin: u.origin,
  startMs: u.startMs,
  score: Math.max(0, Math.min(1, Math.round(score * 1000) / 1000))
})

const KIND_ORDER: Record<ExtractionKind, number> = { action: 0, decision: 1, deadline: 2, question: 3, reference: 4, topic: 5 }

function dedupe(items: Array<ExtractionDraft & { order: number }>): Array<ExtractionDraft & { order: number }> {
  const seen = new Map<string, ExtractionDraft & { order: number }>()
  for (const it of items) {
    const key = it.kind + '|' + tokenize(it.text).map(normalizeTerm).join(' ')
    const prev = seen.get(key)
    if (!prev || it.score > prev.score) seen.set(key, it)
  }
  return [...seen.values()]
}

/**
 * Analyses note text + transcript segments and returns extraction suggestions sorted by kind,
 * then score descending, then original position.
 */
export function analyzeText(input: AnalyzeInput): ExtractionDraft[] {
  const units = buildUnits(input)
  const out: Array<ExtractionDraft & { order: number }> = []
  const ref = input.referenceDate

  for (const u of units) {
    const c = u.clean
    const words = tokenize(c).length
    const question = isQuestion(c)
    const mentions: DateMention[] = findDateMentions(c, ref)
    const deadlineMentions = mentions.filter(isDeadlineLike)

    // -- action / decision / deadline / question: exactly one kind per sentence ------------------
    // Priority: decision > deadline (only when a date mention actually resolves) > action > question.
    const actionCues = ACTION_CUES.filter((cue) => cue.re.test(c)).map((cue) => cue.name)
    const decisionCues = DECISION_CUES.filter((re) => re.test(c)).length
    const resolvedDeadline = deadlineMentions.some((m) => m.resolved !== null)
    const hasDeadlineCue = DEADLINE_CUES.test(c)
    const hasAction = actionCues.length > 0
    const isRequest = actionCues.includes('request') || actionCues.includes('please') || actionCues.includes('name-to-verb')

    let kind: 'action' | 'decision' | 'deadline' | 'question' | null = null
    let score = 0
    if (decisionCues > 0 && !question && words <= 60) {
      kind = 'decision'
      score = decisionCues / DECISION_MAX_CUES
    } else if (resolvedDeadline && (hasDeadlineCue || hasAction) && words <= 60) {
      // Rules: a resolved date, a deadline cue, an action cue.
      kind = 'deadline'
      score = (1 + (hasDeadlineCue ? 1 : 0) + (hasAction ? 1 : 0)) / 3
    } else if (hasAction && words <= 60 && (!question || isRequest)) {
      const name = hasPersonName(c)
      const dated = deadlineMentions.length > 0 ? 1 : 0
      score = (actionCues.length + (name ? 1 : 0) + dated) / ACTION_MAX_CUES
      // Weak actions survive only with a person name or an explicit cue.
      const explicit = actionCues.some((n) => EXPLICIT_ACTION_CUES.has(n))
      if (score >= WEAK_ACTION_THRESHOLD || name || explicit) kind = 'action'
    }
    if (kind === null && question && words >= 3) {
      kind = 'question'
      // Two rules: ends with "?" and starts with an interrogative.
      score = ((c.endsWith('?') ? 1 : 0) + (QUESTION_START.test(c) ? 1 : 0)) / 2
    }
    if (kind !== null) out.push({ ...draft(u, kind, c, score), order: u.order })

    // -- reference ---------------------------------------------------------------------------
    for (const p of REFERENCE_PATTERNS) {
      p.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = p.re.exec(u.raw)) !== null) {
        const matched = (p.name === 'quoted' ? m[1] : m[0]).trim().replace(/[.,;:]+$/, '')
        if (p.name === 'ticket' && /^(?:Q[1-4]|COVID|ISO|UTF|RFC|SHA)-/i.test(matched)) continue
        if (p.name === 'money' && !/[$€£₹]|\b(?:USD|EUR|GBP|INR|AED|SAR|dollars|rupees|euros|pounds|dirhams)\b/i.test(matched)) continue
        if (matched.length < 3) continue
        out.push({ ...draft(u, 'reference', matched, p.score), order: u.order })
        if (m[0].length === 0) p.re.lastIndex++
      }
    }
  }

  // -- topic -------------------------------------------------------------------------------
  // URLs and e-mail addresses are references, not topics — blank them out before ranking.
  const corpus = units.map((u) => u.clean.replace(/\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi, ' ')).join('\n')
  for (const phrase of textRankPhrases(corpus, 6)) {
    const stems = tokenize(phrase.term, { hyphens: true }).map(normalizeTerm)
    // First sentence containing the phrase tokens in order (stem match) — never fabricate.
    const src = units.find((u) => {
      const toks = tokenize(u.clean, { hyphens: true }).map(normalizeTerm)
      for (let i = 0; i + stems.length <= toks.length; i++) {
        let ok = true
        for (let j = 0; j < stems.length; j++) if (toks[i + j] !== stems[j]) { ok = false; break }
        if (ok) return true
      }
      return false
    })
    if (!src) continue
    out.push({ ...draft(src, 'topic', phrase.term, phrase.score), order: src.order })
  }

  return dedupe(out)
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.score - a.score || a.order - b.order)
    .map(({ order: _o, ...rest }) => rest)
}
