import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { TranscriptsRepo, type SegmentInput } from '../../../src/main/db/transcripts-repo'
import { SearchRepo } from '../../../src/main/db/search-repo'
import type { ExtractionDraft } from '../../../src/shared/text'

let db: Database
let notes: NotesRepo
let repo: TranscriptsRepo
let search: SearchRepo
let noteId: string

beforeEach(() => {
  db = new Database(':memory:')
  notes = new NotesRepo(db)
  repo = new TranscriptsRepo(db)
  search = new SearchRepo(db)
  noteId = notes.create({ title: 'Meeting' }).id
})
afterEach(() => db.close())

const seg = (text: string, startMs: number | null = null, extra: Partial<SegmentInput> = {}): SegmentInput => ({
  text,
  startMs,
  endMs: startMs === null ? null : startMs + 1000,
  channel: 'mic',
  confidence: null,
  ...extra
})

const transcriptHits = (q: string): string[] => search.query(q, { scope: 'transcripts' }).hits.map((h) => h.refId)

describe('TranscriptsRepo — transcripts and segments', () => {
  it('ensure creates once and returns the same transcript afterwards', () => {
    expect(repo.getByNote(noteId)).toBeNull()
    const t = repo.ensure(noteId, 'manual', null, 'en')
    expect(t.noteId).toBe(noteId)
    expect(t.source).toBe('manual')
    expect(t.language).toBe('en')
    expect(t.segmentCount).toBe(0)
    const again = repo.ensure(noteId, 'import-srt', 'x', 'fr')
    expect(again.id).toBe(t.id)
    expect(again.source).toBe('manual') // the first call wins
    expect(repo.count()).toBe(1)
    expect(notes.get(noteId)!.transcriptId).toBe(t.id)
    expect(notes.summaries([noteId])[0].hasTranscript).toBe(true)
  })

  it('appendSegments numbers seq continuously, trims text and skips blanks', () => {
    const t = repo.ensure(noteId, 'live', 'windows-sapi', null)
    const first = repo.appendSegments(noteId, t.id, [seg(' one '), seg('   '), seg('two', 500, { confidence: 0.9 })])
    expect(first.map((s) => [s.seq, s.text])).toEqual([
      [0, 'one'],
      [1, 'two']
    ])
    expect(first[1].confidence).toBe(0.9)
    expect(first[1].endMs).toBe(1500)
    const second = repo.appendSegments(noteId, t.id, [seg('three')])
    expect(second[0].seq).toBe(2)
    expect(repo.appendSegments(noteId, t.id, [])).toEqual([])

    const data = repo.getByNote(noteId)!
    expect(data.transcript.segmentCount).toBe(3)
    expect(data.segments.map((s) => s.text)).toEqual(['one', 'two', 'three'])
    expect(data.segments.every((s) => s.transcriptId === t.id)).toBe(true)
    expect(repo.segmentsText(noteId)).toEqual([
      { id: first[0].id, text: 'one', startMs: null },
      { id: first[1].id, text: 'two', startMs: 500 },
      { id: second[0].id, text: 'three', startMs: null }
    ])
    // all indexed for search
    expect(transcriptHits('three')).toEqual([second[0].id])
  })

  it('replaceAll swaps the transcript and its index', () => {
    const t1 = repo.ensure(noteId, 'manual', null, null)
    repo.appendSegments(noteId, t1.id, [seg('alpha words')])
    const t2 = repo.replaceAll(noteId, 'import-vtt', null, 'en', [seg('bravo words', 0), seg('charlie words', 1000)])
    expect(t2.id).not.toBe(t1.id)
    expect(t2.source).toBe('import-vtt')
    expect(t2.segmentCount).toBe(2)
    expect(repo.count()).toBe(1)
    expect(repo.getByNote(noteId)!.segments.map((s) => s.seq)).toEqual([0, 1])
    expect(transcriptHits('alpha')).toEqual([])
    expect(transcriptHits('bravo')).toHaveLength(1)
    expect(transcriptHits('charlie')).toHaveLength(1)
    // old segments are gone (FK cascade) and no orphan FTS rows remain
    expect(Number(db.get('SELECT COUNT(*) AS n FROM transcript_segments')!.n)).toBe(2)
    expect(Number(db.get('SELECT COUNT(*) AS n FROM segments_fts')!.n)).toBe(2)
  })

  it('updateSegment keeps the FTS index in sync', async () => {
    const t = repo.ensure(noteId, 'manual', null, null)
    const [s] = repo.appendSegments(noteId, t.id, [seg('the old wording')])
    await new Promise((r) => setTimeout(r, 5))
    repo.updateSegment(s.id, '  the fresh wording ')
    expect(repo.getByNote(noteId)!.segments[0].text).toBe('the fresh wording')
    expect(transcriptHits('fresh')).toEqual([s.id])
    expect(transcriptHits('old')).toEqual([])
    expect(repo.getByNote(noteId)!.transcript.updatedAt).toBeGreaterThan(t.updatedAt)
  })

  it('deleteSegment removes the row and its index entry', () => {
    const t = repo.ensure(noteId, 'manual', null, null)
    const [a, b] = repo.appendSegments(noteId, t.id, [seg('keep me'), seg('drop me')])
    repo.deleteSegment(b.id)
    expect(repo.getByNote(noteId)!.segments.map((s) => s.id)).toEqual([a.id])
    expect(transcriptHits('drop')).toEqual([])
    expect(transcriptHits('keep')).toEqual([a.id])
    // seq continues after the highest remaining value
    expect(repo.appendSegments(noteId, t.id, [seg('next')])[0].seq).toBe(1)
    expect(repo.getByNote(noteId)!.segments.map((s) => s.text)).toEqual(['keep me', 'next'])
  })

  it('clear removes transcript, segments and index rows for the note only', () => {
    const other = notes.create({ title: 'Other' }).id
    const t = repo.ensure(noteId, 'manual', null, null)
    repo.appendSegments(noteId, t.id, [seg('mine')])
    const to = repo.ensure(other, 'manual', null, null)
    repo.appendSegments(other, to.id, [seg('theirs')])
    repo.clear(noteId)
    expect(repo.getByNote(noteId)).toBeNull()
    expect(repo.count()).toBe(1)
    expect(transcriptHits('mine')).toEqual([])
    expect(transcriptHits('theirs')).toHaveLength(1)
    expect(Number(db.get('SELECT COUNT(*) AS n FROM transcript_segments')!.n)).toBe(1)
    // clearing an empty note is a no-op
    repo.clear(noteId)
  })

  it('transcript rows cascade when the note is destroyed', () => {
    const t = repo.ensure(noteId, 'manual', null, null)
    repo.appendSegments(noteId, t.id, [seg('x')])
    notes.destroy(noteId)
    expect(repo.count()).toBe(0)
    expect(Number(db.get('SELECT COUNT(*) AS n FROM transcript_segments')!.n)).toBe(0)
    expect(Number(db.get('SELECT COUNT(*) AS n FROM segments_fts')!.n)).toBe(0)
  })
})

const draft = (kind: ExtractionDraft['kind'], text: string, sourceText = text, extra: Partial<ExtractionDraft> = {}): ExtractionDraft => ({
  kind,
  text,
  sourceText,
  sourceSegmentId: null,
  sourceOrigin: 'note',
  startMs: null,
  score: 0.5,
  ...extra
})

const actionHits = (q: string): string[] => search.query(q, { scope: 'actions' }).hits.map((h) => h.refId)

describe('TranscriptsRepo — extractions', () => {
  it('replaceExtractions stores drafts, dedupes by (kind, sourceText) and indexes them', () => {
    const out = repo.replaceExtractions(noteId, [
      draft('action', 'Send the invoice', 'We will send the invoice by Friday.', { score: 0.9 }),
      draft('action', 'Send the invoice again', 'we will send the invoice by friday.'), // same key (case/space-insensitive)
      draft('decision', 'Go with vendor A', 'We agreed to go with vendor A.', { sourceOrigin: 'transcript', sourceSegmentId: 's1', startMs: 1200 })
    ])
    expect(out).toHaveLength(2)
    const action = out.find((e) => e.kind === 'action')!
    expect(action.text).toBe('Send the invoice')
    expect(action.score).toBe(0.9)
    expect(action.dismissed).toBe(false)
    expect(action.noteId).toBe(noteId)
    const decision = out.find((e) => e.kind === 'decision')!
    expect(decision.sourceSegmentId).toBe('s1')
    expect(decision.startMs).toBe(1200)
    expect(decision.sourceOrigin).toBe('transcript')
    expect(actionHits('invoice')).toEqual([action.id])
    expect(repo.listExtractions(noteId)).toHaveLength(2)
  })

  it('re-analysis preserves id, edited text, dismissed flag and createdAt for the same (kind, sourceText)', async () => {
    const [first] = repo.replaceExtractions(noteId, [draft('action', 'Original text', 'Source sentence.')])
    const edited = repo.updateExtraction(first.id, { text: '  Edited by user ' })
    expect(edited.text).toBe('Edited by user')
    const [other] = repo.replaceExtractions(noteId, [draft('action', 'Original text', 'Source sentence.'), draft('deadline', 'By Friday', 'Due by Friday.')])
    // first survives with user edit
    expect(other.id).toBe(first.id)
    expect(other.text).toBe('Edited by user')
    expect(other.createdAt).toBe(first.createdAt)
    expect(actionHits('edited')).toEqual([first.id])
    expect(actionHits('original')).toEqual([])

    // dismiss, then re-analyse: still dismissed and not searchable
    repo.updateExtraction(first.id, { dismissed: true })
    await new Promise((r) => setTimeout(r, 5))
    const again = repo.replaceExtractions(noteId, [draft('action', 'Original text', 'source sentence.')])
    expect(again).toHaveLength(1)
    expect(again[0].id).toBe(first.id)
    expect(again[0].dismissed).toBe(true)
    expect(again[0].text).toBe('Edited by user')
    expect(actionHits('edited')).toEqual([])

    // a different kind for the same source is a different suggestion
    const mixed = repo.replaceExtractions(noteId, [draft('question', 'Original text?', 'Source sentence.')])
    expect(mixed[0].id).not.toBe(first.id)
    expect(mixed[0].dismissed).toBe(false)
  })

  it('replaceExtractions with no drafts clears the note and leaves other notes untouched', () => {
    const other = notes.create({ title: 'Other' }).id
    repo.replaceExtractions(noteId, [draft('action', 'mine')])
    repo.replaceExtractions(other, [draft('action', 'theirs')])
    expect(repo.replaceExtractions(noteId, [])).toEqual([])
    expect(repo.listExtractions(other)).toHaveLength(1)
    expect(actionHits('theirs')).toHaveLength(1)
    expect(Number(db.get('SELECT COUNT(*) AS n FROM extractions_fts')!.n)).toBe(1)
  })

  it('updateExtraction changes text / kind / dismissed and keeps the index consistent', () => {
    const [e] = repo.replaceExtractions(noteId, [draft('action', 'call the client')])
    const asDecision = repo.updateExtraction(e.id, { kind: 'decision' })
    expect(asDecision.kind).toBe('decision')
    // 'actions' scope only shows action-kind rows; 'all' still finds it
    expect(actionHits('client')).toEqual([])
    expect(search.query('client', { scope: 'all' }).hits.map((h) => h.refId)).toEqual([e.id])
    const dismissed = repo.updateExtraction(e.id, { dismissed: true })
    expect(dismissed.dismissed).toBe(true)
    expect(search.query('client', { scope: 'all' }).hits).toEqual([])
    const back = repo.updateExtraction(e.id, { dismissed: false, text: 'ring the client' })
    expect(back.dismissed).toBe(false)
    expect(search.query('ring', { scope: 'all' }).hits.map((h) => h.refId)).toEqual([e.id])
    expect(() => repo.updateExtraction('missing', { text: 'x' })).toThrow(/not found/i)
  })

  it('removeExtraction deletes the row and its index entry', () => {
    const [a, b] = repo.replaceExtractions(noteId, [draft('action', 'first item'), draft('action', 'second item')])
    repo.removeExtraction(a.id)
    expect(repo.listExtractions(noteId).map((e) => e.id)).toEqual([b.id])
    expect(actionHits('first')).toEqual([])
    expect(actionHits('second')).toEqual([b.id])
    repo.removeExtraction('missing') // no-op
  })

  it('listExtractions orders by kind, then score desc', () => {
    repo.replaceExtractions(noteId, [
      draft('decision', 'd', 'd', { score: 0.1 }),
      draft('action', 'low', 'low', { score: 0.2 }),
      draft('action', 'high', 'high', { score: 0.8 })
    ])
    expect(repo.listExtractions(noteId).map((e) => e.text)).toEqual(['high', 'low', 'd'])
  })
})

describe('TranscriptsRepo — recordings', () => {
  const rec = (startedAt: number, path = `/tmp/${startedAt}.wav`) => ({
    noteId,
    path,
    startedAt,
    durationMs: 1234,
    sizeBytes: 5678,
    sampleRate: 16000,
    channels: 1
  })

  it('add / list / get / delete', () => {
    const b = repo.addRecording(rec(2000))
    const a = repo.addRecording(rec(1000))
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(repo.listRecordings(noteId).map((r) => r.id)).toEqual([a.id, b.id]) // by started_at
    expect(repo.getRecording(b.id)).toEqual(b)
    expect(repo.getRecording('missing')).toBeNull()
    expect(repo.allRecordings()).toHaveLength(2)
    repo.deleteRecording(a.id)
    expect(repo.listRecordings(noteId).map((r) => r.id)).toEqual([b.id])
    expect(repo.listRecordings('other-note')).toEqual([])
  })

  it('recordings cascade with the note', () => {
    repo.addRecording(rec(1))
    notes.destroy(noteId)
    expect(repo.allRecordings()).toEqual([])
  })
})
