import { randomUUID } from 'node:crypto'
import type { Database } from './database'
import { bool } from './database'
import type { Folder, Note, NoteId, NoteListQuery, NoteSummary, Tag } from '@shared/types'
import type { NoteCreateInput, NoteUpdateInput } from '@shared/api'
import { RECENT_DAYS, TRASH_RETENTION_DAYS } from '@shared/defaults'

interface NoteRow {
  id: string
  title: string
  body_json: string
  body_text: string
  created_at: number
  updated_at: number
  meeting_at: number | null
  meeting_end_at: number | null
  calendar_event_id: string | null
  folder_id: string | null
  attendees_json: string
  pinned: number
  favorite: number
  archived: number
  deleted_at: number | null
  transcript_id?: string | null
}

const SUMMARY_COLS = `n.id, n.title, substr(n.body_text, 1, 240) AS body_text, n.created_at, n.updated_at, n.meeting_at,
  n.folder_id, n.attendees_json, n.pinned, n.favorite, n.archived, n.deleted_at,
  (SELECT t.id FROM transcripts t WHERE t.note_id = n.id) AS transcript_id`
const FULL_COLS = `n.*, (SELECT t.id FROM transcripts t WHERE t.note_id = n.id) AS transcript_id`

function parseAttendees(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function cleanPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 160)
}

export class NotesRepo {
  constructor(private readonly db: Database) {}

  // ---------- tags ----------
  private tagsFor(noteId: string): Tag[] {
    return this.db.all<Tag>(
      'SELECT t.id, t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ? ORDER BY t.name COLLATE NOCASE',
      noteId
    )
  }

  private tagsForMany(ids: string[]): Map<string, Tag[]> {
    const map = new Map<string, Tag[]>()
    if (ids.length === 0) return map
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.all<Tag & { note_id: string }>(
      `SELECT nt.note_id, t.id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id IN (${placeholders}) ORDER BY t.name COLLATE NOCASE`,
      ...ids
    )
    for (const r of rows) {
      const list = map.get(r.note_id) ?? []
      list.push({ id: r.id, name: r.name })
      map.set(r.note_id, list)
    }
    return map
  }

  private toNote(r: NoteRow): Note {
    return {
      id: r.id,
      title: r.title,
      bodyJson: r.body_json,
      bodyText: r.body_text,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      meetingAt: r.meeting_at,
      meetingEndAt: r.meeting_end_at,
      calendarEventId: r.calendar_event_id,
      folderId: r.folder_id,
      attendees: parseAttendees(r.attendees_json),
      pinned: !!r.pinned,
      favorite: !!r.favorite,
      archived: !!r.archived,
      deletedAt: r.deleted_at,
      transcriptId: r.transcript_id ?? null,
      tags: this.tagsFor(r.id)
    }
  }

  private toSummary(r: NoteRow, tags: Tag[]): NoteSummary {
    return {
      id: r.id,
      title: r.title,
      preview: cleanPreview(r.body_text),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      meetingAt: r.meeting_at,
      folderId: r.folder_id,
      attendees: parseAttendees(r.attendees_json),
      pinned: !!r.pinned,
      favorite: !!r.favorite,
      archived: !!r.archived,
      deletedAt: r.deleted_at,
      hasTranscript: !!r.transcript_id,
      tags
    }
  }

  private reindex(noteId: string): void {
    const n = this.db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', noteId)
    this.db.run('DELETE FROM notes_fts WHERE note_id = ?', noteId)
    if (!n || n.deleted_at) return
    const tags = this.tagsFor(noteId).map((t) => t.name).join(' ')
    this.db.run('INSERT INTO notes_fts (note_id, title, body, tags) VALUES (?, ?, ?, ?)', noteId, n.title, n.body_text, tags)
  }

  // ---------- queries ----------
  list(q: NoteListQuery): NoteSummary[] {
    const where: string[] = []
    const params: (string | number)[] = []
    switch (q.view) {
      case 'trash':
        where.push('n.deleted_at IS NOT NULL')
        break
      case 'archived':
        where.push('n.deleted_at IS NULL', 'n.archived = 1')
        break
      case 'favorites':
        where.push('n.deleted_at IS NULL', 'n.favorite = 1')
        break
      case 'folder':
        where.push('n.deleted_at IS NULL', 'n.archived = 0', 'n.folder_id = ?')
        params.push(q.folderId ?? '')
        break
      case 'tag':
        where.push('n.deleted_at IS NULL', 'EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag_id = ?)')
        params.push(q.tagId ?? '')
        break
      case 'recent':
        where.push('n.deleted_at IS NULL', 'n.archived = 0', 'COALESCE(n.meeting_at, n.updated_at) >= ?')
        params.push(Date.now() - RECENT_DAYS * 86400_000)
        break
      case 'all':
      default:
        where.push('n.deleted_at IS NULL', 'n.archived = 0')
    }
    const sortCol =
      q.sort === 'created'
        ? 'n.created_at DESC'
        : q.sort === 'title'
          ? 'n.title COLLATE NOCASE ASC'
          : q.sort === 'updated'
            ? 'n.updated_at DESC'
            : 'COALESCE(n.meeting_at, n.created_at) DESC'
    const order = q.view === 'trash' ? 'n.deleted_at DESC' : `n.pinned DESC, ${sortCol}`
    const limit = Math.min(Math.max(q.limit ?? 500, 1), 5000)
    const offset = Math.max(q.offset ?? 0, 0)
    const rows = this.db.all<NoteRow>(
      `SELECT ${SUMMARY_COLS} FROM notes n WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset
    )
    const tags = this.tagsForMany(rows.map((r) => r.id))
    return rows.map((r) => this.toSummary(r, tags.get(r.id) ?? []))
  }

  get(id: NoteId): Note | null {
    const r = this.db.get<NoteRow>(`SELECT ${FULL_COLS} FROM notes n WHERE n.id = ?`, id)
    return r ? this.toNote(r) : null
  }

  summaries(ids: NoteId[]): NoteSummary[] {
    if (ids.length === 0) return []
    const rows = this.db.all<NoteRow>(
      `SELECT ${SUMMARY_COLS} FROM notes n WHERE n.id IN (${ids.map(() => '?').join(',')})`,
      ...ids
    )
    const tags = this.tagsForMany(rows.map((r) => r.id))
    return rows.map((r) => this.toSummary(r, tags.get(r.id) ?? []))
  }

  counts(): { all: number; favorites: number; archived: number; trash: number; recent: number } {
    const r = this.db.get<Record<string, number>>(
      `SELECT
        SUM(CASE WHEN deleted_at IS NULL AND archived = 0 THEN 1 ELSE 0 END) AS all_count,
        SUM(CASE WHEN deleted_at IS NULL AND favorite = 1 THEN 1 ELSE 0 END) AS favorites,
        SUM(CASE WHEN deleted_at IS NULL AND archived = 1 THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash,
        SUM(CASE WHEN deleted_at IS NULL AND archived = 0 AND COALESCE(meeting_at, updated_at) >= ? THEN 1 ELSE 0 END) AS recent
       FROM notes`,
      Date.now() - RECENT_DAYS * 86400_000
    )
    return {
      all: Number(r?.all_count ?? 0),
      favorites: Number(r?.favorites ?? 0),
      archived: Number(r?.archived ?? 0),
      trash: Number(r?.trash ?? 0),
      recent: Number(r?.recent ?? 0)
    }
  }

  // ---------- mutations ----------
  create(input: NoteCreateInput): Note {
    const id = randomUUID()
    const now = Date.now()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO notes (id, title, body_json, body_text, created_at, updated_at, meeting_at, meeting_end_at,
          calendar_event_id, folder_id, attendees_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.title ?? '',
        input.bodyJson ?? '',
        input.bodyText ?? '',
        now,
        now,
        input.meetingAt ?? null,
        input.meetingEndAt ?? null,
        input.calendarEventId ?? null,
        input.folderId ?? null,
        JSON.stringify(input.attendees ?? [])
      )
      this.reindex(id)
    })
    return this.get(id)!
  }

  update(id: NoteId, patch: NoteUpdateInput): Note {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    const add = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`)
      params.push(v)
    }
    if (patch.title !== undefined) add('title', patch.title)
    if (patch.bodyJson !== undefined) add('body_json', patch.bodyJson)
    if (patch.bodyText !== undefined) add('body_text', patch.bodyText)
    if (patch.meetingAt !== undefined) add('meeting_at', patch.meetingAt)
    if (patch.meetingEndAt !== undefined) add('meeting_end_at', patch.meetingEndAt)
    if (patch.folderId !== undefined) add('folder_id', patch.folderId)
    if (patch.attendees !== undefined) add('attendees_json', JSON.stringify(patch.attendees))
    if (patch.pinned !== undefined) add('pinned', bool(patch.pinned))
    if (patch.favorite !== undefined) add('favorite', bool(patch.favorite))
    if (patch.archived !== undefined) add('archived', bool(patch.archived))
    const contentChanged = patch.title !== undefined || patch.bodyJson !== undefined || patch.bodyText !== undefined
    if (contentChanged) add('updated_at', Date.now())
    if (sets.length === 0) return this.get(id)!
    params.push(id)
    this.db.transaction(() => {
      const res = this.db.run(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`, ...params)
      if (Number(res.changes) === 0) throw new Error(`Note ${id} not found`)
      if (contentChanged) this.reindex(id)
    })
    return this.get(id)!
  }

  duplicate(id: NoteId): Note {
    const src = this.get(id)
    if (!src) throw new Error('Note not found')
    const copy = this.create({
      title: src.title ? `${src.title} (copy)` : '',
      bodyJson: src.bodyJson,
      bodyText: src.bodyText,
      folderId: src.folderId,
      meetingAt: src.meetingAt,
      meetingEndAt: src.meetingEndAt,
      attendees: src.attendees
    })
    if (src.tags.length) this.setTags(copy.id, src.tags.map((t) => t.name))
    return this.get(copy.id)!
  }

  trash(id: NoteId): void {
    this.db.transaction(() => {
      this.db.run('UPDATE notes SET deleted_at = ?, pinned = 0 WHERE id = ? AND deleted_at IS NULL', Date.now(), id)
      this.reindex(id)
    })
  }

  restore(id: NoteId): void {
    this.db.transaction(() => {
      this.db.run('UPDATE notes SET deleted_at = NULL WHERE id = ?', id)
      this.reindex(id)
    })
  }

  destroy(id: NoteId): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM notes_fts WHERE note_id = ?', id)
      this.db.run('DELETE FROM segments_fts WHERE note_id = ?', id)
      this.db.run('DELETE FROM extractions_fts WHERE note_id = ?', id)
      this.db.run('DELETE FROM notes WHERE id = ?', id)
    })
  }

  emptyTrash(): number {
    const ids = this.db.all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL').map((r) => r.id)
    this.db.transaction(() => ids.forEach((id) => this.destroy(id)))
    return ids.length
  }

  purgeExpiredTrash(): number {
    const cutoff = Date.now() - TRASH_RETENTION_DAYS * 86400_000
    const ids = this.db.all<{ id: string }>('SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?', cutoff).map((r) => r.id)
    this.db.transaction(() => ids.forEach((id) => this.destroy(id)))
    return ids.length
  }

  setTags(id: NoteId, tagNames: string[]): Tag[] {
    const names = Array.from(new Set(tagNames.map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean)))
    this.db.transaction(() => {
      this.db.run('DELETE FROM note_tags WHERE note_id = ?', id)
      for (const name of names) {
        let tag = this.db.get<Tag>('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE', name)
        if (!tag) {
          tag = { id: randomUUID(), name }
          this.db.run('INSERT INTO tags (id, name) VALUES (?, ?)', tag.id, tag.name)
        }
        this.db.run('INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)', id, tag.id)
      }
      // drop orphan tags
      this.db.run('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM note_tags)')
      this.reindex(id)
    })
    return this.tagsFor(id)
  }

  // ---------- folders ----------
  listFolders(): Folder[] {
    return this.db
      .all<{ id: string; name: string; position: number; created_at: number; note_count: number }>(
        `SELECT f.*, (SELECT COUNT(*) FROM notes n WHERE n.folder_id = f.id AND n.deleted_at IS NULL AND n.archived = 0) AS note_count
         FROM folders f ORDER BY f.position, f.created_at`
      )
      .map((r) => ({ id: r.id, name: r.name, position: r.position, createdAt: r.created_at, noteCount: Number(r.note_count) }))
  }

  createFolder(name: string): Folder {
    const id = randomUUID()
    const pos = (this.db.get<{ m: number | null }>('SELECT MAX(position) AS m FROM folders')?.m ?? -1) + 1
    this.db.run('INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, ?, ?)', id, name.trim(), pos, Date.now())
    return this.listFolders().find((f) => f.id === id)!
  }

  renameFolder(id: string, name: string): Folder {
    this.db.run('UPDATE folders SET name = ? WHERE id = ?', name.trim(), id)
    const f = this.listFolders().find((x) => x.id === id)
    if (!f) throw new Error('Folder not found')
    return f
  }

  reorderFolders(ids: string[]): void {
    this.db.transaction(() => ids.forEach((id, i) => this.db.run('UPDATE folders SET position = ? WHERE id = ?', i, id)))
  }

  removeFolder(id: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE notes SET folder_id = NULL WHERE folder_id = ?', id)
      this.db.run('DELETE FROM folders WHERE id = ?', id)
    })
  }

  // ---------- tags (global) ----------
  listTags(): (Tag & { noteCount: number })[] {
    return this.db
      .all<{ id: string; name: string; c: number }>(
        `SELECT t.id, t.name, (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
          WHERE nt.tag_id = t.id AND n.deleted_at IS NULL) AS c FROM tags t ORDER BY t.name COLLATE NOCASE`
      )
      .map((r) => ({ id: r.id, name: r.name, noteCount: Number(r.c) }))
  }

  renameTag(id: string, name: string): Tag {
    const clean = name.trim()
    this.db.transaction(() => {
      this.db.run('UPDATE tags SET name = ? WHERE id = ?', clean, id)
      const ids = this.db.all<{ note_id: string }>('SELECT note_id FROM note_tags WHERE tag_id = ?', id)
      ids.forEach((r) => this.reindex(r.note_id))
    })
    return { id, name: clean }
  }

  removeTag(id: string): void {
    this.db.transaction(() => {
      const ids = this.db.all<{ note_id: string }>('SELECT note_id FROM note_tags WHERE tag_id = ?', id)
      this.db.run('DELETE FROM tags WHERE id = ?', id)
      ids.forEach((r) => this.reindex(r.note_id))
    })
  }

  /** Rebuilds every FTS index from source tables (used after restore). */
  rebuildIndexes(): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM notes_fts')
      const ids = this.db.all<{ id: string }>('SELECT id FROM notes')
      ids.forEach((r) => this.reindex(r.id))
      this.db.run('DELETE FROM segments_fts')
      this.db.run(
        `INSERT INTO segments_fts (segment_id, note_id, text)
         SELECT s.id, t.note_id, s.text FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id`
      )
      this.db.run('DELETE FROM extractions_fts')
      this.db.run('INSERT INTO extractions_fts (extraction_id, note_id, text) SELECT id, note_id, text FROM extractions WHERE dismissed = 0')
    })
  }
}
