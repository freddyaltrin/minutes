import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { SearchRepo } from '../../../src/main/db/search-repo'
import { TRASH_RETENTION_DAYS } from '../../../src/shared/defaults'

const DAY = 86_400_000

let db: Database
let repo: NotesRepo
let search: SearchRepo

beforeEach(() => {
  db = new Database(':memory:')
  repo = new NotesRepo(db)
  search = new SearchRepo(db)
})
afterEach(() => db.close())

const ids = (list: { id: string }[]): string[] => list.map((n) => n.id)

describe('NotesRepo — create / get / update', () => {
  it('creates a note with defaults and reads it back', () => {
    const n = repo.create({ title: 'Kickoff', bodyText: 'hello world', attendees: ['Deepak'] })
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(n.title).toBe('Kickoff')
    expect(n.bodyText).toBe('hello world')
    expect(n.bodyJson).toBe('')
    expect(n.attendees).toEqual(['Deepak'])
    expect(n.pinned).toBe(false)
    expect(n.favorite).toBe(false)
    expect(n.archived).toBe(false)
    expect(n.deletedAt).toBeNull()
    expect(n.transcriptId).toBeNull()
    expect(n.tags).toEqual([])
    expect(n.createdAt).toBe(n.updatedAt)
    expect(repo.get(n.id)).toEqual(n)
  })

  it('get returns null for an unknown id', () => {
    expect(repo.get('nope')).toBeNull()
  })

  it('update bumps updated_at only when content changes', async () => {
    const n = repo.create({ title: 'A' })
    // Flag-only patch: updated_at unchanged.
    await new Promise((r) => setTimeout(r, 5))
    const flagged = repo.update(n.id, { favorite: true, pinned: true })
    expect(flagged.favorite).toBe(true)
    expect(flagged.pinned).toBe(true)
    expect(flagged.updatedAt).toBe(n.updatedAt)
    // Metadata-only patch (folder/attendees/meeting): also unchanged.
    const meta = repo.update(n.id, { attendees: ['X'], meetingAt: 123 })
    expect(meta.updatedAt).toBe(n.updatedAt)
    expect(meta.attendees).toEqual(['X'])
    expect(meta.meetingAt).toBe(123)
    // Content patch: bumped.
    await new Promise((r) => setTimeout(r, 5))
    const content = repo.update(n.id, { bodyText: 'new body', bodyJson: '{"type":"doc"}' })
    expect(content.updatedAt).toBeGreaterThan(n.updatedAt)
    expect(content.bodyText).toBe('new body')
    await new Promise((r) => setTimeout(r, 5))
    const titled = repo.update(n.id, { title: 'B' })
    expect(titled.updatedAt).toBeGreaterThan(content.updatedAt)
  })

  it('update with an empty patch returns the note unchanged', () => {
    const n = repo.create({ title: 'A' })
    expect(repo.update(n.id, {})).toEqual(n)
  })

  it('update of an unknown note throws', () => {
    expect(() => repo.update('missing', { title: 'x' })).toThrow(/not found/)
  })
})

describe('NotesRepo — list views and ordering', () => {
  it('filters by view', () => {
    const plain = repo.create({ title: 'plain' })
    const fav = repo.create({ title: 'fav' })
    repo.update(fav.id, { favorite: true })
    const arch = repo.create({ title: 'arch' })
    repo.update(arch.id, { archived: true })
    const favArch = repo.create({ title: 'fav+arch' })
    repo.update(favArch.id, { favorite: true, archived: true })
    const trashed = repo.create({ title: 'trashed' })
    repo.trash(trashed.id)

    expect(ids(repo.list({ view: 'all' })).sort()).toEqual([plain.id, fav.id].sort())
    expect(ids(repo.list({ view: 'recent' })).sort()).toEqual([plain.id, fav.id].sort())
    // favorites includes archived favorites but not trashed
    expect(ids(repo.list({ view: 'favorites' })).sort()).toEqual([fav.id, favArch.id].sort())
    expect(ids(repo.list({ view: 'archived' })).sort()).toEqual([arch.id, favArch.id].sort())
    expect(ids(repo.list({ view: 'trash' }))).toEqual([trashed.id])
  })

  it('recent excludes notes older than the recent window (by meeting date)', () => {
    const old = repo.create({ title: 'old', meetingAt: Date.now() - 40 * DAY })
    const fresh = repo.create({ title: 'fresh' })
    expect(ids(repo.list({ view: 'recent' }))).toEqual([fresh.id])
    expect(ids(repo.list({ view: 'all' })).sort()).toEqual([old.id, fresh.id].sort())
  })

  it('folder and tag views', () => {
    const f = repo.createFolder('Clients')
    const inFolder = repo.create({ title: 'in', folderId: f.id })
    const outside = repo.create({ title: 'out' })
    expect(ids(repo.list({ view: 'folder', folderId: f.id }))).toEqual([inFolder.id])
    expect(ids(repo.list({ view: 'folder', folderId: 'nope' }))).toEqual([])

    const tags = repo.setTags(outside.id, ['Urgent'])
    expect(ids(repo.list({ view: 'tag', tagId: tags[0].id }))).toEqual([outside.id])
    // archived notes still appear in the tag view; trashed ones do not
    repo.update(outside.id, { archived: true })
    expect(ids(repo.list({ view: 'tag', tagId: tags[0].id }))).toEqual([outside.id])
    repo.trash(outside.id)
    expect(ids(repo.list({ view: 'tag', tagId: tags[0].id }))).toEqual([])
  })

  it('pinned notes come first, then by sort key', () => {
    const t0 = Date.now()
    const a = repo.create({ title: 'a', meetingAt: t0 - 3 * DAY })
    const b = repo.create({ title: 'b', meetingAt: t0 - 2 * DAY })
    const c = repo.create({ title: 'c', meetingAt: t0 - 1 * DAY })
    repo.update(a.id, { pinned: true })
    // default sort: meeting date desc, pinned first
    expect(ids(repo.list({ view: 'all' }))).toEqual([a.id, c.id, b.id])
    // title sort still pins first
    expect(ids(repo.list({ view: 'all', sort: 'title' }))).toEqual([a.id, b.id, c.id])
    repo.update(c.id, { pinned: true })
    expect(ids(repo.list({ view: 'all', sort: 'title' }))).toEqual([a.id, c.id, b.id])
  })

  it('honours limit and offset', () => {
    for (let i = 0; i < 5; i++) repo.create({ title: `n${i}`, meetingAt: i })
    const page1 = repo.list({ view: 'all', limit: 2 })
    const page2 = repo.list({ view: 'all', limit: 2, offset: 2 })
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(ids(page1)).not.toEqual(ids(page2))
  })

  it('summaries carry preview, tags and hasTranscript', () => {
    const n = repo.create({ title: 'S', bodyText: '  lots   of\n\nwhitespace  ' })
    repo.setTags(n.id, ['x'])
    const [s] = repo.summaries([n.id])
    expect(s.preview).toBe('lots of whitespace')
    expect(s.tags.map((t) => t.name)).toEqual(['x'])
    expect(s.hasTranscript).toBe(false)
    expect(repo.summaries([])).toEqual([])
  })
})

describe('NotesRepo — duplicate', () => {
  it('copies content, metadata and tags with a "(copy)" title', () => {
    const f = repo.createFolder('F')
    const src = repo.create({ title: 'Orig', bodyText: 'body', bodyJson: '{"a":1}', folderId: f.id, meetingAt: 5, attendees: ['Sam'] })
    repo.setTags(src.id, ['alpha', 'beta'])
    const copy = repo.duplicate(src.id)
    expect(copy.id).not.toBe(src.id)
    expect(copy.title).toBe('Orig (copy)')
    expect(copy.bodyText).toBe('body')
    expect(copy.bodyJson).toBe('{"a":1}')
    expect(copy.folderId).toBe(f.id)
    expect(copy.meetingAt).toBe(5)
    expect(copy.attendees).toEqual(['Sam'])
    expect(copy.tags.map((t) => t.name)).toEqual(['alpha', 'beta'])
    // Tags are shared rows, not duplicated.
    expect(repo.listTags().map((t) => t.noteCount)).toEqual([2, 2])
  })

  it('untitled note duplicates to an untitled note', () => {
    const src = repo.create({})
    expect(repo.duplicate(src.id).title).toBe('')
  })

  it('throws for unknown ids', () => {
    expect(() => repo.duplicate('missing')).toThrow(/not found/i)
  })
})

describe('NotesRepo — trash lifecycle', () => {
  it('trash → restore → destroy', () => {
    const n = repo.create({ title: 'T' })
    repo.update(n.id, { pinned: true })
    repo.trash(n.id)
    const trashed = repo.get(n.id)!
    expect(trashed.deletedAt).not.toBeNull()
    expect(trashed.pinned).toBe(false) // trashing unpins
    expect(ids(repo.list({ view: 'all' }))).toEqual([])
    expect(ids(repo.list({ view: 'trash' }))).toEqual([n.id])

    repo.restore(n.id)
    expect(repo.get(n.id)!.deletedAt).toBeNull()
    expect(ids(repo.list({ view: 'all' }))).toEqual([n.id])

    repo.destroy(n.id)
    expect(repo.get(n.id)).toBeNull()
    expect(db.get('SELECT COUNT(*) AS n FROM notes_fts')!.n).toBe(0)
  })

  it('trashing twice keeps the original deleted_at', async () => {
    const n = repo.create({ title: 'T' })
    repo.trash(n.id)
    const first = repo.get(n.id)!.deletedAt
    await new Promise((r) => setTimeout(r, 5))
    repo.trash(n.id)
    expect(repo.get(n.id)!.deletedAt).toBe(first)
  })

  it('emptyTrash removes only trashed notes', () => {
    const keep = repo.create({ title: 'keep' })
    const a = repo.create({ title: 'a' })
    const b = repo.create({ title: 'b' })
    repo.trash(a.id)
    repo.trash(b.id)
    expect(repo.emptyTrash()).toBe(2)
    expect(repo.get(a.id)).toBeNull()
    expect(repo.get(b.id)).toBeNull()
    expect(repo.get(keep.id)).not.toBeNull()
    expect(repo.emptyTrash()).toBe(0)
  })

  it('purgeExpiredTrash deletes only notes trashed longer than the retention window', () => {
    const recent = repo.create({ title: 'recent' })
    repo.trash(recent.id)
    const old = repo.create({ title: 'old' })
    db.run('UPDATE notes SET deleted_at = ? WHERE id = ?', Date.now() - (TRASH_RETENTION_DAYS + 1) * DAY, old.id)
    expect(repo.purgeExpiredTrash()).toBe(1)
    expect(repo.get(old.id)).toBeNull()
    expect(repo.get(recent.id)).not.toBeNull()
    expect(repo.purgeExpiredTrash()).toBe(0)
  })

  it('destroy cascades transcript rows and clears every FTS table', () => {
    const n = repo.create({ title: 'N', bodyText: 'x' })
    db.run("INSERT INTO transcripts (id, note_id, source, created_at, updated_at) VALUES ('t1', ?, 'manual', 1, 1)", n.id)
    db.run("INSERT INTO transcript_segments (id, transcript_id, seq, text) VALUES ('s1', 't1', 0, 'hello')")
    db.run("INSERT INTO segments_fts (segment_id, note_id, text) VALUES ('s1', ?, 'hello')", n.id)
    db.run(
      "INSERT INTO extractions (id, note_id, kind, text, source_text, source_origin, created_at) VALUES ('e1', ?, 'action', 'do', 'do', 'note', 1)",
      n.id
    )
    db.run("INSERT INTO extractions_fts (extraction_id, note_id, text) VALUES ('e1', ?, 'do')", n.id)
    repo.destroy(n.id)
    for (const t of ['transcripts', 'transcript_segments', 'segments_fts', 'extractions', 'extractions_fts', 'notes_fts']) {
      expect(Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)!.n), t).toBe(0)
    }
  })
})

describe('NotesRepo — tags', () => {
  it('setTags creates, trims, dedupes case-insensitively and returns sorted tags', () => {
    const n = repo.create({ title: 'N' })
    const tags = repo.setTags(n.id, [' Client ', 'client', 'CLIENT', 'urgent', '', '  ', 'two   words'])
    expect(tags.map((t) => t.name)).toEqual(['Client', 'two words', 'urgent'])
    expect(repo.listTags()).toHaveLength(3)
  })

  it('reuses an existing tag regardless of case and keeps its original spelling', () => {
    const a = repo.create({ title: 'A' })
    const b = repo.create({ title: 'B' })
    const [ta] = repo.setTags(a.id, ['Petroka'])
    const [tb] = repo.setTags(b.id, ['petroka'])
    expect(tb.id).toBe(ta.id)
    expect(tb.name).toBe('Petroka')
    expect(repo.listTags()).toEqual([{ id: ta.id, name: 'Petroka', noteCount: 2 }])
  })

  it('drops orphan tags when they are removed from the last note', () => {
    const n = repo.create({ title: 'N' })
    repo.setTags(n.id, ['x', 'y'])
    repo.setTags(n.id, ['y'])
    expect(repo.listTags().map((t) => t.name)).toEqual(['y'])
    repo.setTags(n.id, [])
    expect(repo.listTags()).toEqual([])
    expect(repo.get(n.id)!.tags).toEqual([])
  })

  it('renameTag and removeTag keep the notes index in sync', () => {
    const n = repo.create({ title: 'N' })
    const [t] = repo.setTags(n.id, ['oldname'])
    expect(search.query('oldname', { scope: 'notes' }).hits).toHaveLength(1)
    repo.renameTag(t.id, 'newname')
    expect(repo.get(n.id)!.tags[0].name).toBe('newname')
    expect(search.query('oldname', { scope: 'notes' }).hits).toHaveLength(0)
    expect(search.query('newname', { scope: 'notes' }).hits).toHaveLength(1)
    repo.removeTag(t.id)
    expect(repo.get(n.id)!.tags).toEqual([])
    expect(search.query('newname', { scope: 'notes' }).hits).toHaveLength(0)
  })

  it('listTags does not count trashed notes', () => {
    const n = repo.create({ title: 'N' })
    repo.setTags(n.id, ['t'])
    repo.trash(n.id)
    expect(repo.listTags()[0].noteCount).toBe(0)
  })
})

describe('NotesRepo — folders', () => {
  it('create / rename / reorder / list with note counts', () => {
    const a = repo.createFolder('  Alpha ')
    const b = repo.createFolder('Beta')
    expect(a.name).toBe('Alpha')
    expect(a.position).toBe(0)
    expect(b.position).toBe(1)
    repo.create({ title: 'x', folderId: a.id })
    const archived = repo.create({ title: 'y', folderId: a.id })
    repo.update(archived.id, { archived: true })
    expect(repo.listFolders().map((f) => [f.name, f.noteCount])).toEqual([
      ['Alpha', 1],
      ['Beta', 0]
    ])
    expect(repo.renameFolder(b.id, 'Gamma').name).toBe('Gamma')
    expect(() => repo.renameFolder('missing', 'z')).toThrow(/not found/i)
    repo.reorderFolders([b.id, a.id])
    expect(repo.listFolders().map((f) => f.id)).toEqual([b.id, a.id])
  })

  it('removeFolder moves notes out instead of deleting them', () => {
    const f = repo.createFolder('F')
    const n = repo.create({ title: 'n', folderId: f.id })
    repo.removeFolder(f.id)
    expect(repo.listFolders()).toEqual([])
    const after = repo.get(n.id)!
    expect(after.folderId).toBeNull()
    expect(after.deletedAt).toBeNull()
  })
})

describe('NotesRepo — counts', () => {
  it('reports per-view counts', () => {
    expect(repo.counts()).toEqual({ all: 0, favorites: 0, archived: 0, trash: 0, recent: 0 })
    repo.create({ title: 'a' })
    const fav = repo.create({ title: 'b' })
    repo.update(fav.id, { favorite: true })
    const arch = repo.create({ title: 'c' })
    repo.update(arch.id, { archived: true, favorite: true })
    const tr = repo.create({ title: 'd' })
    repo.trash(tr.id)
    repo.create({ title: 'old', meetingAt: Date.now() - 60 * DAY })
    expect(repo.counts()).toEqual({ all: 3, favorites: 2, archived: 1, trash: 1, recent: 2 })
  })
})

describe('NotesRepo — FTS sync and rebuildIndexes', () => {
  it('a note is searchable after update and not after trash; searchable again after restore', () => {
    const n = repo.create({ title: 'Untitled', bodyText: '' })
    expect(search.query('zebra', { scope: 'notes' }).hits).toHaveLength(0)
    repo.update(n.id, { bodyText: 'The zebra crossed the road' })
    const found = search.query('zebra', { scope: 'notes' })
    expect(found.hits).toHaveLength(1)
    expect(found.hits[0].noteId).toBe(n.id)
    expect(found.hits[0].snippet).toContain('<mark>zebra</mark>')
    repo.trash(n.id)
    expect(search.query('zebra', { scope: 'notes' }).hits).toHaveLength(0)
    repo.restore(n.id)
    expect(search.query('zebra', { scope: 'notes' }).hits).toHaveLength(1)
  })

  it('title changes are indexed', () => {
    const n = repo.create({ title: 'first' })
    repo.update(n.id, { title: 'Quarterly review' })
    expect(search.query('quarterly', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([n.id])
    expect(search.query('first', { scope: 'notes' }).hits).toHaveLength(0)
  })

  it('rebuildIndexes reconstructs every FTS table from source rows', () => {
    const n = repo.create({ title: 'N', bodyText: 'indexed body' })
    db.run("INSERT INTO transcripts (id, note_id, source, created_at, updated_at) VALUES ('t1', ?, 'manual', 1, 1)", n.id)
    db.run("INSERT INTO transcript_segments (id, transcript_id, seq, text) VALUES ('s1', 't1', 0, 'segment words')")
    db.run(
      "INSERT INTO extractions (id, note_id, kind, text, source_text, source_origin, created_at, dismissed) VALUES ('e1', ?, 'action', 'extracted task', 'src', 'note', 1, 0), ('e2', ?, 'action', 'hidden task', 'src2', 'note', 1, 1)",
      n.id,
      n.id
    )
    // Corrupt the indexes.
    db.run('DELETE FROM notes_fts')
    db.run('DELETE FROM segments_fts')
    db.run('DELETE FROM extractions_fts')
    db.run("INSERT INTO notes_fts (note_id, title, body, tags) VALUES ('ghost', 'ghost', 'ghost body', '')")
    expect(search.query('indexed', { scope: 'notes' }).hits).toHaveLength(0)

    repo.rebuildIndexes()
    expect(search.query('indexed', { scope: 'notes' }).hits.map((h) => h.noteId)).toEqual([n.id])
    expect(search.query('segment', { scope: 'transcripts' }).hits.map((h) => h.refId)).toEqual(['s1'])
    const ext = search.query('task', { scope: 'all' }).hits.filter((h) => h.kind === 'extraction')
    expect(ext.map((h) => h.refId)).toEqual(['e1']) // dismissed e2 is not indexed
    expect(Number(db.get("SELECT COUNT(*) AS n FROM notes_fts WHERE note_id = 'ghost'")!.n)).toBe(0)
  })
})
