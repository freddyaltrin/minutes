import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { TranscriptsRepo } from '../../../src/main/db/transcripts-repo'
import { SearchRepo } from '../../../src/main/db/search-repo'
import type { ExtractionDraft } from '../../../src/shared/text'

const REF = new Date(2026, 9, 20, 10, 0, 0)

let db: Database
let notes: NotesRepo
let transcripts: TranscriptsRepo
let search: SearchRepo

beforeEach(() => {
  db = new Database(':memory:')
  notes = new NotesRepo(db)
  transcripts = new TranscriptsRepo(db)
  search = new SearchRepo(db)
})
afterEach(() => db.close())

const plain = (s: string): string => s.replace(/<\/?mark>/g, '')

function seed(): { petroka: string; evervolt: string; archived: string; folderId: string; segId: string } {
  const folder = notes.createFolder('Clients')
  const petroka = notes.create({
    title: 'Petroka weekly',
    bodyText: 'Discussed the NFUP scope with Petroka. The isometric list is due by 25 October. We agreed to go with the SP3D route.',
    folderId: folder.id,
    meetingAt: REF.getTime() - 86_400_000
  })
  const t = transcripts.ensure(petroka.id, 'import-srt', null, null)
  const segs = transcripts.appendSegments(petroka.id, t.id, [
    { text: 'Good morning everyone, quick status round.', startMs: 0, endMs: 4000, channel: 'mic', confidence: null },
    { text: 'Petroka asked for the revised quote before the weekend.', startMs: 61_000, endMs: 66_000, channel: 'mic', confidence: null },
    { text: 'Karthik will send the RLM sheet to the client on Friday.', startMs: 120_000, endMs: 125_000, channel: 'mic', confidence: null }
  ])
  const evervolt = notes.create({
    title: 'EverVolt interiors',
    bodyText: 'Ground floor plan review. Lighting layout pending. Exact phrase marker here.',
    meetingAt: REF.getTime() - 2 * 86_400_000
  })
  const archived = notes.create({ title: 'Old archive', bodyText: 'Petroka onboarding from last year.' })
  notes.update(archived.id, { archived: true })
  return { petroka: petroka.id, evervolt: evervolt.id, archived: archived.id, folderId: folder.id, segId: segs[1].id }
}

describe('SearchRepo.toMatch', () => {
  it('builds OR-ed prefix tokens from free text', () => {
    const { match, terms } = SearchRepo.toMatch('petroka quote')
    expect(match).toBe('("petroka"* OR "quote"*)')
    expect(terms).toEqual(['petroka', 'quote'])
  })

  it('keeps quoted phrases as phrases and ANDs them with the word group', () => {
    const { match, terms } = SearchRepo.toMatch('"exact phrase" marker')
    expect(match).toBe('("exact phrase") AND ("marker"*)')
    expect(terms).toEqual(['exact', 'phrase', 'marker'])
  })

  it('without prefix', () => {
    expect(SearchRepo.toMatch('alpha', false).match).toBe('("alpha")')
  })

  it('neutralises FTS operators and punctuation', () => {
    expect(SearchRepo.toMatch('foo AND bar').match).toBe('("foo"* OR "and"* OR "bar"*)')
    expect(SearchRepo.toMatch('NOT foo').match).toBe('("not"* OR "foo"*)')
    expect(SearchRepo.toMatch('foo*').match).toBe('("foo"*)')
    expect(SearchRepo.toMatch('(foo) OR {bar}').match).toBe('("foo"* OR "or"* OR "bar"*)')
    expect(SearchRepo.toMatch('col:value ^x').match).toBe('("col"* OR "value"* OR "x"*)')
    expect(SearchRepo.toMatch('"unterminated').match).toBe('("unterminated"*)')
    expect(SearchRepo.toMatch('""').match).toBe('')
    expect(SearchRepo.toMatch('   ').match).toBe('')
  })

  it('handles unicode and apostrophes', () => {
    expect(SearchRepo.toMatch('Zürich café').match).toBe('("zürich"* OR "café"*)')
    expect(SearchRepo.toMatch("don't").match).toBe('("don\'t"*)')
    expect(SearchRepo.toMatch('日本語 テスト').match).toBe('("日本語"* OR "テスト"*)')
  })

  it('never produces a MATCH string that makes FTS5 throw', () => {
    seed()
    const inputs = [
      'foo AND bar',
      'foo OR bar NOT baz',
      '"exact phrase"',
      '"exact phrase" AND other',
      'NOT',
      'AND',
      '*',
      '**',
      'a*b*c',
      '(petroka)',
      '((()))',
      ')(',
      'col:petroka',
      '^petroka',
      '{petroka}',
      '[petroka]',
      '"',
      '"""',
      '" "',
      'NEAR(a b)',
      'a + b',
      'a - b',
      'Zürich',
      'naïve café',
      'العربية',
      '🙂 emoji',
      "o'brien",
      '\u0000\u0001ctrl',
      'x'.repeat(2000)
    ]
    for (const q of inputs) {
      expect(() => search.query(q, { scope: 'all' }), JSON.stringify(q)).not.toThrow()
      expect(() => search.ask(q, { scope: 'all' }, REF), JSON.stringify(q)).not.toThrow()
    }
  })
})

describe('SearchRepo.query', () => {
  it('returns nothing for blank input', () => {
    seed()
    expect(search.query('   ', { scope: 'all' })).toEqual({ query: '   ', hits: [], total: 0, tookMs: 0 })
    expect(search.query('""', { scope: 'all' }).hits).toEqual([])
  })

  it('prefix matches: "petro" finds Petroka in notes and transcripts', () => {
    const s = seed()
    const res = search.query('petro', { scope: 'all' })
    const kinds = new Set(res.hits.map((h) => h.kind))
    expect(kinds.has('note')).toBe(true)
    expect(kinds.has('transcript')).toBe(true)
    expect(res.hits.some((h) => h.noteId === s.petroka && h.kind === 'note')).toBe(true)
    expect(res.hits.some((h) => h.refId === s.segId)).toBe(true)
    expect(res.total).toBe(res.hits.length)
    expect(res.tookMs).toBeGreaterThanOrEqual(0)
  })

  it('snippets are HTML-escaped and contain <mark> around matched terms', () => {
    const s = seed()
    notes.update(s.evervolt, { bodyText: 'Lighting <b>layout</b> & fixtures pending.' })
    const res = search.query('lighting', { scope: 'notes' })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0].snippet).toContain('<mark>Lighting</mark>')
    expect(res.hits[0].snippet).toContain('&lt;b&gt;')
    expect(res.hits[0].snippet).toContain('&amp;')
    expect(res.hits[0].noteTitle).toBe('EverVolt interiors')
  })

  it('phrase search requires adjacency', () => {
    const s = seed()
    expect(search.query('"exact phrase"', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([s.evervolt])
    expect(search.query('"phrase exact"', { scope: 'notes' }).hits).toEqual([])
    expect(search.query('"marker here"', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([s.evervolt])
    // phrase AND word: both must be present in the same document
    expect(search.query('"exact phrase" lighting', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([s.evervolt])
    expect(search.query('"exact phrase" petroka', { scope: 'notes' }).hits).toEqual([])
  })

  it('transcript hits carry the segment id and startMs', () => {
    const s = seed()
    const res = search.query('revised quote', { scope: 'transcripts' })
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]).toMatchObject({ kind: 'transcript', refId: s.segId, startMs: 61_000, noteId: s.petroka })
    expect(res.hits[0].snippet).toContain('<mark>revised</mark>')
  })

  it('scope filters restrict the kinds returned', () => {
    seed()
    expect(search.query('petroka', { scope: 'notes' }).hits.every((h) => h.kind === 'note')).toBe(true)
    expect(search.query('petroka', { scope: 'transcripts' }).hits.every((h) => h.kind === 'transcript')).toBe(true)
    expect(search.query('petroka', { scope: 'actions' }).hits).toEqual([])
  })

  it('actions scope returns only action-kind extractions; all returns every kind', () => {
    const s = seed()
    transcripts.replaceExtractions(s.petroka, [
      { kind: 'action', text: 'Send widget quote', sourceText: 'a', sourceSegmentId: null, sourceOrigin: 'note', startMs: null, score: 1 },
      { kind: 'decision', text: 'Chose widget A', sourceText: 'b', sourceSegmentId: null, sourceOrigin: 'note', startMs: null, score: 1 }
    ])
    const actions = search.query('widget', { scope: 'actions' }).hits
    expect(actions.map((h) => plain(h.snippet))).toEqual(['Send widget quote'])
    const all = search.query('widget', { scope: 'all' }).hits.filter((h) => h.kind === 'extraction')
    expect(all.map((h) => plain(h.snippet)).sort()).toEqual(['Chose widget A', 'Send widget quote'])
  })

  it('archived notes are excluded unless archived: true; trashed never', () => {
    const s = seed()
    expect(search.query('onboarding', { scope: 'notes' }).hits).toEqual([])
    expect(search.query('onboarding', { scope: 'notes', archived: true }).hits.map((h) => h.noteId)).toEqual([s.archived])
    notes.trash(s.archived)
    expect(search.query('onboarding', { scope: 'notes', archived: true }).hits).toEqual([])
  })

  it('folder and date filters apply to every kind', () => {
    const s = seed()
    expect(search.query('petroka', { scope: 'all', folderId: s.folderId }).hits.every((h) => h.noteId === s.petroka)).toBe(true)
    expect(search.query('petroka', { scope: 'all', folderId: 'other' }).hits).toEqual([])
    // Petroka note meeting is REF-1d; evervolt REF-2d
    const from = REF.getTime() - 1.5 * 86_400_000
    expect(search.query('review', { scope: 'notes', from }).hits).toEqual([])
    expect(search.query('review', { scope: 'notes', to: from }).hits.map((h) => h.noteId)).toEqual([s.evervolt])
  })

  it('respects the limit; total counts the retrieved candidates (per-kind window of max(10, limit/2))', () => {
    for (let i = 0; i < 15; i++) notes.create({ title: `n${i}`, bodyText: `common token ${i}` })
    const res = search.query('common', { scope: 'notes' }, 5)
    expect(res.hits).toHaveLength(5)
    expect(res.total).toBe(10)
    const wide = search.query('common', { scope: 'notes' }, 60)
    expect(wide.hits).toHaveLength(15)
    expect(wide.total).toBe(15)
  })

  it('apostrophes in the query match apostrophes in the text', () => {
    const n = notes.create({ title: 'x', bodyText: "We don't have O'Brien's sign-off yet" })
    expect(search.query("don't", { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([n.id])
    expect(search.query("O'Brien", { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([n.id])
    expect(search.query('sign-off', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([n.id])
  })

  it('dedupes identical snippets and drops suggestions already shown as transcript lines', () => {
    const s = seed()
    const line = 'Karthik will send the RLM sheet to the client on Friday.'
    transcripts.replaceExtractions(s.petroka, [
      { kind: 'action', text: line, sourceText: line, sourceSegmentId: null, sourceOrigin: 'transcript', startMs: 120_000, score: 1 },
      { kind: 'action', text: 'send the RLM sheet', sourceText: line, sourceSegmentId: null, sourceOrigin: 'transcript', startMs: 120_000, score: 1 }
    ])
    const res = search.query('rlm', { scope: 'all' })
    expect(res.hits.filter((h) => h.kind === 'transcript')).toHaveLength(1)
    // Both suggestions are contained in the transcript line and therefore dropped.
    expect(res.hits.filter((h) => h.kind === 'extraction')).toHaveLength(0)
  })

  it('is deterministic across calls', () => {
    seed()
    const a = search.query('petroka friday', { scope: 'all' })
    const b = search.query('petroka friday', { scope: 'all' })
    expect(a.hits).toEqual(b.hits)
  })
})

describe('SearchRepo.ask', () => {
  it('deadline intent without terms scans for dated passages', () => {
    const s = seed()
    const res = search.ask('what deadlines were mentioned?', { scope: 'all' }, REF)
    expect(res.intent).toBe('deadline')
    expect(res.terms).toEqual([])
    expect(res.hits.length).toBeGreaterThan(0)
    const texts = res.hits.map((h) => plain(h.snippet))
    expect(texts.some((t) => /25 October/.test(t))).toBe(true)
    expect(texts.some((t) => /Friday/.test(t))).toBe(true)
    // Greeting line has no date or cue and must not appear.
    expect(texts.some((t) => /Good morning/.test(t))).toBe(false)
    expect(res.hits.every((h) => h.noteId === s.petroka)).toBe(true)
    expect(res.explanation).toMatch(/deadline/i)
  })

  it('a question with neither terms nor scannable intent explains itself with no hits', () => {
    seed()
    const res = search.ask('what was mentioned?', { scope: 'all' }, REF)
    expect(res.hits).toEqual([])
    expect(res.explanation).toMatch(/No searchable terms/)
  })

  it('"where was Petroka mentioned" returns the transcript segment with its startMs', () => {
    const s = seed()
    const res = search.ask('where was Petroka mentioned', { scope: 'all' }, REF)
    expect(res.intent).toBe('mention')
    expect(res.terms).toEqual(['petroka'])
    const seg = res.hits.find((h) => h.kind === 'transcript')
    expect(seg).toBeDefined()
    expect(seg!.refId).toBe(s.segId)
    expect(seg!.startMs).toBe(61_000)
    expect(seg!.snippet).toContain('<mark>Petroka</mark>')
    // The note body sentence that names Petroka is also offered as evidence.
    const note = res.hits.find((h) => h.kind === 'note')
    expect(note).toBeDefined()
    expect(plain(note!.snippet)).toMatch(/Petroka/)
    // Archived note is filtered out by default.
    expect(res.hits.some((h) => h.noteId === s.archived)).toBe(false)
  })

  it('drops extraction hits whose text is contained in a returned transcript line', () => {
    const s = seed()
    const line = 'Petroka asked for the revised quote before the weekend.'
    transcripts.replaceExtractions(s.petroka, [
      { kind: 'action', text: 'revised quote before the weekend', sourceText: line, sourceSegmentId: s.segId, sourceOrigin: 'transcript', startMs: 61_000, score: 1 },
      { kind: 'action', text: 'Petroka wants a totally different thing entirely', sourceText: 'x', sourceSegmentId: null, sourceOrigin: 'note', startMs: null, score: 1 }
    ])
    const res = search.ask('where was Petroka mentioned', { scope: 'all' }, REF)
    const ext = res.hits.filter((h) => h.kind === 'extraction').map((h) => plain(h.snippet))
    expect(ext).not.toContain('revised quote before the weekend')
    expect(ext).toContain('Petroka wants a totally different thing entirely')
  })

  it('decision intent surfaces the agreed passage', () => {
    seed()
    const res = search.ask('what did we decide about SP3D?', { scope: 'all' }, REF)
    expect(res.intent).toBe('decision')
    expect(res.hits.length).toBeGreaterThan(0)
    expect(plain(res.hits[0].snippet)).toMatch(/agreed to go with the SP3D route/)
  })

  it('is deterministic across two calls', () => {
    seed()
    const q = 'who will send the RLM sheet?'
    const a = search.ask(q, { scope: 'all' }, REF)
    const b = search.ask(q, { scope: 'all' }, REF)
    expect(a).toEqual(b)
    expect(a.hits.length).toBeGreaterThan(0)
    expect(a.hits[0].kind).toBe('transcript')
  })

  it('honours scope filters even in scan mode', () => {
    seed()
    const res = search.ask('what deadlines were mentioned?', { scope: 'all', folderId: 'none' }, REF)
    expect(res.hits).toEqual([])
  })
})
