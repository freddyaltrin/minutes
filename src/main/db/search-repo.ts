import type { Database } from './database'
import type { AskResult, SearchFilters, SearchHit, SearchResult } from '@shared/types'
import { buildFtsQuery, classifyQuestion, scorePassage, tokenize, highlightTerms, makeSnippet, intentScanHints, findDateMentions, hasPersonName } from '@shared/text'

/**
 * Deterministic full-text search over notes, transcript segments and extracted suggestions.
 * Uses FTS5 bm25 ranking; no embeddings, no semantic models.
 */

/** Drops suggestion hits whose text is already shown as a transcript or note passage of the same note. */
function dropContainedExtractions(hits: SearchHit[]): SearchHit[] {
  const plain = (h: SearchHit): string => h.snippet.replace(/<\/?mark>/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  const passages = hits.filter((h) => h.kind !== 'extraction').map((h) => ({ noteId: h.noteId, text: plain(h) }))
  return hits.filter((h) => {
    if (h.kind !== 'extraction') return true
    const t = plain(h).replace(/…$/, '')
    return !passages.some((p) => p.noteId === h.noteId && t.length > 12 && p.text.includes(t))
  })
}

export class SearchRepo {
  constructor(private readonly db: Database) {}

  /** Builds an FTS5 MATCH string from free text. Quoted phrases are kept as phrases. */
  static toMatch(text: string, prefix = true): { match: string; terms: string[] } {
    const phrases: string[] = []
    const rest = text.replace(/"([^"]+)"/g, (_m, p: string) => {
      phrases.push(p.trim())
      return ' '
    })
    const words = tokenize(rest)
    const parts: string[] = []
    for (const p of phrases) if (p) parts.push(buildFtsQuery([p], { phrase: true }))
    const wordQuery = buildFtsQuery(words, { prefix })
    if (wordQuery) parts.push(wordQuery)
    // Phrases and words must all be present; words among themselves are already OR'ed by buildFtsQuery
    // so we AND phrase groups with the word group for precision.
    const match = parts.map((p) => `(${p})`).join(' AND ')
    return { match, terms: [...phrases.flatMap((p) => tokenize(p)), ...words] }
  }

  private noteFilterSql(f: SearchFilters, alias: string): { sql: string; params: (string | number)[] } {
    const clauses = [`${alias}.deleted_at IS NULL`]
    const params: (string | number)[] = []
    if (!f.archived) clauses.push(`${alias}.archived = 0`)
    if (f.folderId) {
      clauses.push(`${alias}.folder_id = ?`)
      params.push(f.folderId)
    }
    if (f.from) {
      clauses.push(`COALESCE(${alias}.meeting_at, ${alias}.created_at) >= ?`)
      params.push(f.from)
    }
    if (f.to) {
      clauses.push(`COALESCE(${alias}.meeting_at, ${alias}.created_at) <= ?`)
      params.push(f.to)
    }
    return { sql: clauses.join(' AND '), params }
  }

  query(text: string, filters: SearchFilters, limit = 60): SearchResult {
    const t0 = performance.now()
    const trimmed = text.trim()
    if (!trimmed) return { query: text, hits: [], total: 0, tookMs: 0 }
    const { match, terms } = SearchRepo.toMatch(trimmed)
    if (!match) return { query: text, hits: [], total: 0, tookMs: 0 }
    const hits: SearchHit[] = []
    const nf = this.noteFilterSql(filters, 'n')
    const per = Math.max(10, Math.ceil(limit / 2))

    const safe = <T>(fn: () => T[]): T[] => {
      try {
        return fn()
      } catch (err) {
        // An FTS syntax error only happens for pathological input; treat as no results.
        if (String((err as Error).message).includes('fts5')) return []
        throw err
      }
    }

    if (filters.scope === 'all' || filters.scope === 'notes') {
      const rows = safe(() =>
        this.db.all<{ note_id: string; title: string; body: string; meeting_at: number | null; updated_at: number; rank: number }>(
          `SELECT f.note_id, n.title, n.body_text AS body, n.meeting_at, n.updated_at, bm25(notes_fts, 4.0, 1.0, 2.0) AS rank
           FROM notes_fts f JOIN notes n ON n.id = f.note_id
           WHERE notes_fts MATCH ? AND ${nf.sql}
           ORDER BY rank LIMIT ?`,
          match,
          ...nf.params,
          per
        )
      )
      for (const r of rows) {
        const snippetSource = makeSnippet(r.body, terms, 90) || r.body.slice(0, 180)
        hits.push({
          kind: 'note',
          noteId: r.note_id,
          noteTitle: r.title,
          meetingAt: r.meeting_at,
          updatedAt: r.updated_at,
          snippet: highlightTerms(snippetSource, terms, 220),
          refId: r.note_id,
          startMs: null,
          rank: r.rank
        })
      }
    }
    if (filters.scope === 'all' || filters.scope === 'transcripts') {
      const rows = safe(() =>
        this.db.all<{ segment_id: string; note_id: string; title: string; text: string; start_ms: number | null; meeting_at: number | null; updated_at: number; rank: number }>(
          `SELECT f.segment_id, f.note_id, n.title, s.text, s.start_ms, n.meeting_at, n.updated_at, bm25(segments_fts) AS rank
           FROM segments_fts f JOIN transcript_segments s ON s.id = f.segment_id JOIN notes n ON n.id = f.note_id
           WHERE segments_fts MATCH ? AND ${nf.sql}
           ORDER BY rank LIMIT ?`,
          match,
          ...nf.params,
          per
        )
      )
      for (const r of rows) {
        hits.push({
          kind: 'transcript',
          noteId: r.note_id,
          noteTitle: r.title,
          meetingAt: r.meeting_at,
          updatedAt: r.updated_at,
          snippet: highlightTerms(makeSnippet(r.text, terms, 110) || r.text, terms, 240),
          refId: r.segment_id,
          startMs: r.start_ms,
          rank: r.rank
        })
      }
    }
    if (filters.scope === 'all' || filters.scope === 'actions') {
      const rows = safe(() =>
        this.db.all<{ extraction_id: string; note_id: string; title: string; text: string; start_ms: number | null; meeting_at: number | null; updated_at: number; rank: number }>(
          `SELECT f.extraction_id, f.note_id, n.title, e.text, e.start_ms, n.meeting_at, n.updated_at, bm25(extractions_fts) AS rank
           FROM extractions_fts f JOIN extractions e ON e.id = f.extraction_id JOIN notes n ON n.id = f.note_id
           WHERE extractions_fts MATCH ? AND e.dismissed = 0 AND ${filters.scope === 'actions' ? "e.kind = 'action' AND " : ''} ${nf.sql}
           ORDER BY rank LIMIT ?`,
          match,
          ...nf.params,
          per
        )
      )
      for (const r of rows) {
        hits.push({
          kind: 'extraction',
          noteId: r.note_id,
          noteTitle: r.title,
          meetingAt: r.meeting_at,
          updatedAt: r.updated_at,
          snippet: highlightTerms(r.text, terms, 240),
          refId: r.extraction_id,
          startMs: r.start_ms,
          rank: r.rank
        })
      }
    }
    // bm25 returns negative numbers (lower = better). Stable deterministic order: rank, then recency.
    hits.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt)
    const seen = new Set<string>()
    const unique = hits.filter((h) => {
      const key = h.noteId + '|' + h.snippet.replace(/<\/?mark>/g, '').toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const final = dropContainedExtractions(unique)
    return { query: text, hits: final.slice(0, limit), total: final.length, tookMs: Math.round(performance.now() - t0) }
  }

  /** Evidence retrieval for a natural-language question. Returns passages, never an answer. */
  ask(question: string, filters: SearchFilters, referenceDate = new Date()): AskResult {
    const cls = classifyQuestion(question)
    const terms = cls.terms
    // With content terms we retrieve candidates through FTS; without them (e.g. "what deadlines were
    // mentioned?") we scan recent passages for the intent's cues instead, so an empty term list is
    // still answerable with evidence.
    const scan = terms.length === 0
    const hints = intentScanHints(cls.intent)
    if (scan && !hints.requireDate && hints.cueRegex.source === '$^') {
      return { question, intent: cls.intent, terms, hits: [], explanation: cls.explanation + ' No searchable terms were found in the question — try naming a topic, person or project.' }
    }
    const searchTerms = Array.from(new Set([...terms, ...cls.expandedTerms])).slice(0, 24)
    const match = scan ? '' : buildFtsQuery(searchTerms, { prefix: true })
    const passes = (text: string): boolean => {
      if (!scan) return true
      if (hints.requireDate && findDateMentions(text, referenceDate).length === 0 && !hints.cueRegex.test(text)) return false
      if (!hints.requireDate && !hints.cueRegex.test(text)) return false
      if (hints.requireName && !hasPersonName(text)) return false
      return true
    }
    const whereFts = (table: string): string => (scan ? '1 = 1' : `${table} MATCH ?`)
    const ftsParams = scan ? [] : [match]

    const nf = this.noteFilterSql(filters, 'n')
    const candidates: SearchHit[] = []
    const wrap = <T>(fn: () => T[]): T[] => {
      try {
        return fn()
      } catch {
        return []
      }
    }
    // Transcript segments and extracted suggestions are the natural "passages"; note bodies are split into sentences.
    const segRows = wrap(() =>
      this.db.all<{ segment_id: string; note_id: string; title: string; text: string; start_ms: number | null; meeting_at: number | null; updated_at: number }>(
        `SELECT f.segment_id, f.note_id, n.title, s.text, s.start_ms, n.meeting_at, n.updated_at
         FROM segments_fts f JOIN transcript_segments s ON s.id = f.segment_id JOIN notes n ON n.id = f.note_id
         WHERE ${whereFts('segments_fts')} AND ${nf.sql} ORDER BY ${scan ? 'n.updated_at DESC, s.seq' : 'bm25(segments_fts)'} LIMIT ${scan ? 3000 : 200}`,
        ...ftsParams,
        ...nf.params
      )
    )
    for (const r of segRows) {
      if (!passes(r.text)) continue
      const score = scorePassage(r.text, terms, cls.intent, referenceDate)
      if (score <= 0) continue
      candidates.push({
        kind: 'transcript',
        noteId: r.note_id,
        noteTitle: r.title,
        meetingAt: r.meeting_at,
        updatedAt: r.updated_at,
        snippet: highlightTerms(r.text, terms, 320),
        refId: r.segment_id,
        startMs: r.start_ms,
        rank: -score
      })
    }
    const extRows = wrap(() =>
      this.db.all<{ extraction_id: string; note_id: string; title: string; text: string; kind: string; start_ms: number | null; meeting_at: number | null; updated_at: number }>(
        `SELECT f.extraction_id, f.note_id, n.title, e.text, e.kind, e.start_ms, n.meeting_at, n.updated_at
         FROM extractions_fts f JOIN extractions e ON e.id = f.extraction_id JOIN notes n ON n.id = f.note_id
         WHERE ${whereFts('extractions_fts')} AND e.dismissed = 0 AND ${nf.sql} ORDER BY ${scan ? 'n.updated_at DESC' : 'bm25(extractions_fts)'} LIMIT ${scan ? 1000 : 100}`,
        ...ftsParams,
        ...nf.params
      )
    )
    const kindBoost: Record<string, Record<string, number>> = {
      deadline: { deadline: 0.5, action: 0.2 },
      assignment: { action: 0.5 },
      decision: { decision: 0.6 },
      topic: { topic: 0.2 },
      mention: {},
      generic: {}
    }
    for (const r of extRows) {
      if (!passes(r.text)) continue
      const score = scorePassage(r.text, terms, cls.intent, referenceDate) + (kindBoost[cls.intent]?.[r.kind] ?? 0)
      if (score <= 0) continue
      candidates.push({
        kind: 'extraction',
        noteId: r.note_id,
        noteTitle: r.title,
        meetingAt: r.meeting_at,
        updatedAt: r.updated_at,
        snippet: highlightTerms(r.text, terms, 320),
        refId: r.extraction_id,
        startMs: r.start_ms,
        rank: -score
      })
    }
    const noteRows = wrap(() =>
      this.db.all<{ note_id: string; title: string; body: string; meeting_at: number | null; updated_at: number }>(
        `SELECT f.note_id, n.title, n.body_text AS body, n.meeting_at, n.updated_at
         FROM notes_fts f JOIN notes n ON n.id = f.note_id WHERE ${whereFts('notes_fts')} AND ${nf.sql} ORDER BY ${scan ? 'n.updated_at DESC' : 'bm25(notes_fts)'} LIMIT ${scan ? 300 : 60}`,
        ...ftsParams,
        ...nf.params
      )
    )
    for (const r of noteRows) {
      // Pick the best sentence of the note as the passage.
      const sentences = r.body.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 8)
      let best: { s: string; score: number } | null = null
      for (const s of sentences) {
        if (!passes(s)) continue
        const score = scorePassage(s, terms, cls.intent, referenceDate)
        if (score > 0 && (!best || score > best.score)) best = { s, score }
      }
      if (!best) continue
      candidates.push({
        kind: 'note',
        noteId: r.note_id,
        noteTitle: r.title,
        meetingAt: r.meeting_at,
        updatedAt: r.updated_at,
        snippet: highlightTerms(best.s, terms, 320),
        refId: r.note_id,
        startMs: null,
        rank: -best.score
      })
    }
    // Dedupe identical passages (a transcript line that also became a suggestion).
    const seen = new Set<string>()
    const hits = candidates
      .sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt)
      .filter((h) => {
        const key = h.noteId + '|' + h.snippet.replace(/<\/?mark>/g, '').toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, 60)
    return { question, intent: cls.intent, terms, hits: dropContainedExtractions(hits).slice(0, 40), explanation: cls.explanation }
  }
}
