import { randomUUID } from 'node:crypto'
import type { Database } from './database'
import type { AudioChannel, Extraction, ExtractionKind, Recording, Transcript, TranscriptSegment, TranscriptSource } from '@shared/types'
import type { ExtractionDraft } from '@shared/text'

interface TranscriptRow {
  id: string
  note_id: string
  source: string
  engine: string | null
  language: string | null
  created_at: number
  updated_at: number
  segment_count?: number
}
interface SegmentRow {
  id: string
  transcript_id: string
  seq: number
  start_ms: number | null
  end_ms: number | null
  channel: string
  text: string
  confidence: number | null
}

export interface SegmentInput {
  text: string
  startMs: number | null
  endMs: number | null
  channel: AudioChannel
  confidence: number | null
}

export class TranscriptsRepo {
  constructor(private readonly db: Database) {}

  private toTranscript(r: TranscriptRow): Transcript {
    return {
      id: r.id,
      noteId: r.note_id,
      source: r.source as TranscriptSource,
      engine: r.engine,
      language: r.language,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      segmentCount: Number(r.segment_count ?? 0)
    }
  }
  private toSegment(r: SegmentRow): TranscriptSegment {
    return {
      id: r.id,
      transcriptId: r.transcript_id,
      seq: r.seq,
      startMs: r.start_ms,
      endMs: r.end_ms,
      channel: r.channel as AudioChannel,
      text: r.text,
      confidence: r.confidence
    }
  }

  getByNote(noteId: string): { transcript: Transcript; segments: TranscriptSegment[] } | null {
    const t = this.db.get<TranscriptRow>(
      `SELECT t.*, (SELECT COUNT(*) FROM transcript_segments s WHERE s.transcript_id = t.id) AS segment_count
       FROM transcripts t WHERE t.note_id = ?`,
      noteId
    )
    if (!t) return null
    const segments = this.db
      .all<SegmentRow>('SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY seq', t.id)
      .map((r) => this.toSegment(r))
    return { transcript: this.toTranscript(t), segments }
  }

  /** Returns the existing transcript for the note or creates one. */
  ensure(noteId: string, source: TranscriptSource, engine: string | null, language: string | null): Transcript {
    const existing = this.db.get<TranscriptRow>('SELECT * FROM transcripts WHERE note_id = ?', noteId)
    if (existing) return this.toTranscript(existing)
    const id = randomUUID()
    const now = Date.now()
    this.db.run(
      'INSERT INTO transcripts (id, note_id, source, engine, language, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      noteId,
      source,
      engine,
      language,
      now,
      now
    )
    return this.toTranscript(this.db.get<TranscriptRow>('SELECT * FROM transcripts WHERE id = ?', id)!)
  }

  appendSegments(noteId: string, transcriptId: string, inputs: SegmentInput[]): TranscriptSegment[] {
    if (inputs.length === 0) return []
    const out: TranscriptSegment[] = []
    this.db.transaction(() => {
      let seq = (this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM transcript_segments WHERE transcript_id = ?', transcriptId)?.m ?? -1) + 1
      for (const s of inputs) {
        const text = s.text.trim()
        if (!text) continue
        const id = randomUUID()
        this.db.run(
          'INSERT INTO transcript_segments (id, transcript_id, seq, start_ms, end_ms, channel, text, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          transcriptId,
          seq,
          s.startMs,
          s.endMs,
          s.channel,
          text,
          s.confidence
        )
        this.db.run('INSERT INTO segments_fts (segment_id, note_id, text) VALUES (?, ?, ?)', id, noteId, text)
        out.push({ id, transcriptId, seq, startMs: s.startMs, endMs: s.endMs, channel: s.channel, text, confidence: s.confidence })
        seq++
      }
      this.db.run('UPDATE transcripts SET updated_at = ? WHERE id = ?', Date.now(), transcriptId)
    })
    return out
  }

  replaceAll(noteId: string, source: TranscriptSource, engine: string | null, language: string | null, inputs: SegmentInput[]): Transcript {
    return this.db.transaction(() => {
      this.clear(noteId)
      const t = this.ensure(noteId, source, engine, language)
      this.appendSegments(noteId, t.id, inputs)
      return this.getByNote(noteId)!.transcript
    })
  }

  updateSegment(id: string, text: string): void {
    const clean = text.trim()
    this.db.transaction(() => {
      this.db.run('UPDATE transcript_segments SET text = ? WHERE id = ?', clean, id)
      this.db.run('UPDATE segments_fts SET text = ? WHERE segment_id = ?', clean, id)
      this.db.run(
        'UPDATE transcripts SET updated_at = ? WHERE id = (SELECT transcript_id FROM transcript_segments WHERE id = ?)',
        Date.now(),
        id
      )
    })
  }

  deleteSegment(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM transcript_segments WHERE id = ?', id)
      this.db.run('DELETE FROM segments_fts WHERE segment_id = ?', id)
    })
  }

  clear(noteId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM segments_fts WHERE note_id = ?', noteId)
      this.db.run('DELETE FROM transcripts WHERE note_id = ?', noteId)
    })
  }

  segmentsText(noteId: string): { id: string; text: string; startMs: number | null }[] {
    return this.db.all<{ id: string; text: string; startMs: number | null }>(
      `SELECT s.id, s.text, s.start_ms AS startMs FROM transcript_segments s
       JOIN transcripts t ON t.id = s.transcript_id WHERE t.note_id = ? ORDER BY s.seq`,
      noteId
    )
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcripts')?.n ?? 0)
  }

  // ---------- extractions ----------
  private toExtraction(r: Record<string, unknown>): Extraction {
    return {
      id: r.id as string,
      noteId: r.note_id as string,
      kind: r.kind as ExtractionKind,
      text: r.text as string,
      sourceText: r.source_text as string,
      sourceSegmentId: (r.source_segment_id as string | null) ?? null,
      sourceOrigin: r.source_origin as 'note' | 'transcript',
      startMs: (r.start_ms as number | null) ?? null,
      score: Number(r.score),
      dismissed: !!r.dismissed,
      createdAt: Number(r.created_at)
    }
  }

  listExtractions(noteId: string): Extraction[] {
    return this.db
      .all('SELECT * FROM extractions WHERE note_id = ? ORDER BY kind, score DESC, created_at', noteId)
      .map((r) => this.toExtraction(r))
  }

  /**
   * Replaces automatic suggestions, keeping user edits: a stored row whose
   * (kind, source_text) matches a new draft keeps its id, text and dismissed flag.
   */
  replaceExtractions(noteId: string, drafts: ExtractionDraft[]): Extraction[] {
    this.db.transaction(() => {
      const existing = this.listExtractions(noteId)
      const keyOf = (kind: string, src: string): string => `${kind}\u0000${src.trim().toLowerCase()}`
      const byKey = new Map(existing.map((e) => [keyOf(e.kind, e.sourceText), e]))
      this.db.run('DELETE FROM extractions_fts WHERE note_id = ?', noteId)
      this.db.run('DELETE FROM extractions WHERE note_id = ?', noteId)
      const now = Date.now()
      const seen = new Set<string>()
      for (const d of drafts) {
        const key = keyOf(d.kind, d.sourceText)
        if (seen.has(key)) continue
        seen.add(key)
        const prev = byKey.get(key)
        const id = prev?.id ?? randomUUID()
        const text = prev?.text ?? d.text
        const dismissed = prev?.dismissed ? 1 : 0
        this.db.run(
          `INSERT INTO extractions (id, note_id, kind, text, source_text, source_segment_id, source_origin, start_ms, score, dismissed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          noteId,
          d.kind,
          text,
          d.sourceText,
          d.sourceSegmentId,
          d.sourceOrigin,
          d.startMs,
          d.score,
          dismissed,
          prev?.createdAt ?? now
        )
        if (!dismissed) this.db.run('INSERT INTO extractions_fts (extraction_id, note_id, text) VALUES (?, ?, ?)', id, noteId, text)
      }
    })
    return this.listExtractions(noteId)
  }

  updateExtraction(id: string, patch: { text?: string; dismissed?: boolean; kind?: ExtractionKind }): Extraction {
    this.db.transaction(() => {
      const cur = this.db.get('SELECT * FROM extractions WHERE id = ?', id)
      if (!cur) throw new Error('Suggestion not found')
      const text = patch.text !== undefined ? patch.text.trim() : (cur.text as string)
      const dismissed = patch.dismissed !== undefined ? (patch.dismissed ? 1 : 0) : Number(cur.dismissed)
      const kind = patch.kind ?? (cur.kind as string)
      this.db.run('UPDATE extractions SET text = ?, dismissed = ?, kind = ? WHERE id = ?', text, dismissed, kind, id)
      this.db.run('DELETE FROM extractions_fts WHERE extraction_id = ?', id)
      if (!dismissed) this.db.run('INSERT INTO extractions_fts (extraction_id, note_id, text) VALUES (?, ?, ?)', id, cur.note_id as string, text)
    })
    return this.toExtraction(this.db.get('SELECT * FROM extractions WHERE id = ?', id)!)
  }

  removeExtraction(id: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM extractions_fts WHERE extraction_id = ?', id)
      this.db.run('DELETE FROM extractions WHERE id = ?', id)
    })
  }

  // ---------- recordings ----------
  addRecording(r: Omit<Recording, 'id'>): Recording {
    const id = randomUUID()
    this.db.run(
      'INSERT INTO recordings (id, note_id, path, started_at, duration_ms, size_bytes, sample_rate, channels) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      r.noteId,
      r.path,
      r.startedAt,
      r.durationMs,
      r.sizeBytes,
      r.sampleRate,
      r.channels
    )
    return { id, ...r }
  }

  listRecordings(noteId: string): Recording[] {
    return this.db.all('SELECT * FROM recordings WHERE note_id = ? ORDER BY started_at', noteId).map((r) => ({
      id: r.id as string,
      noteId: r.note_id as string,
      path: r.path as string,
      startedAt: Number(r.started_at),
      durationMs: Number(r.duration_ms),
      sizeBytes: Number(r.size_bytes),
      sampleRate: Number(r.sample_rate),
      channels: Number(r.channels)
    }))
  }

  getRecording(id: string): Recording | null {
    const r = this.db.get('SELECT * FROM recordings WHERE id = ?', id)
    if (!r) return null
    return this.listRecordings(r.note_id as string).find((x) => x.id === id) ?? null
  }

  deleteRecording(id: string): void {
    this.db.run('DELETE FROM recordings WHERE id = ?', id)
  }

  allRecordings(): Recording[] {
    return this.db.all<{ note_id: string }>('SELECT DISTINCT note_id FROM recordings').flatMap((r) => this.listRecordings(r.note_id))
  }
}
