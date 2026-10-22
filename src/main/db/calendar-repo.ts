import { randomUUID } from 'node:crypto'
import type { Database } from './database'
import type { CalendarEvent, CalendarSource } from '@shared/types'

export interface EventInput {
  uid: string
  title: string
  startsAt: number
  endsAt: number
  attendees: string[]
  location: string | null
  description: string | null
}

export class CalendarRepo {
  constructor(private readonly db: Database) {}

  private toSource(r: Record<string, unknown>): CalendarSource {
    return {
      id: r.id as string,
      kind: r.kind as CalendarSource['kind'],
      label: r.label as string,
      url: (r.url as string | null) ?? null,
      lastFetchedAt: (r.last_fetched_at as number | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      eventCount: Number(r.event_count ?? 0)
    }
  }

  listSources(): CalendarSource[] {
    return this.db
      .all(`SELECT s.*, (SELECT COUNT(*) FROM calendar_events e WHERE e.source_id = s.id) AS event_count FROM calendar_sources s ORDER BY s.label`)
      .map((r) => this.toSource(r))
  }

  getSource(id: string): CalendarSource | null {
    const r = this.db.get(`SELECT s.*, (SELECT COUNT(*) FROM calendar_events e WHERE e.source_id = s.id) AS event_count FROM calendar_sources s WHERE id = ?`, id)
    return r ? this.toSource(r) : null
  }

  addSource(kind: CalendarSource['kind'], label: string, url: string | null): CalendarSource {
    const id = randomUUID()
    this.db.run('INSERT INTO calendar_sources (id, kind, label, url) VALUES (?, ?, ?, ?)', id, kind, label.trim() || 'Calendar', url)
    return this.getSource(id)!
  }

  removeSource(id: string): void {
    this.db.transaction(() => {
      this.db.run('UPDATE notes SET calendar_event_id = NULL WHERE calendar_event_id IN (SELECT id FROM calendar_events WHERE source_id = ?)', id)
      this.db.run('DELETE FROM calendar_sources WHERE id = ?', id)
    })
  }

  markFetched(id: string, error: string | null): void {
    this.db.run('UPDATE calendar_sources SET last_fetched_at = ?, last_error = ? WHERE id = ?', Date.now(), error, id)
  }

  /** Replaces the events of a source within the given window; notes keep links by (uid, startsAt). */
  replaceEvents(sourceId: string, events: EventInput[], windowStart: number, windowEnd: number): void {
    this.db.transaction(() => {
      const existing = this.db.all<{ id: string; uid: string; starts_at: number }>(
        'SELECT id, uid, starts_at FROM calendar_events WHERE source_id = ? AND starts_at BETWEEN ? AND ?',
        sourceId,
        windowStart,
        windowEnd
      )
      const keyOf = (uid: string, start: number): string => `${uid}@${start}`
      const prevIds = new Map(existing.map((e) => [keyOf(e.uid, e.starts_at), e.id]))
      this.db.run('DELETE FROM calendar_events WHERE source_id = ? AND starts_at BETWEEN ? AND ?', sourceId, windowStart, windowEnd)
      for (const e of events) {
        const id = prevIds.get(keyOf(e.uid, e.startsAt)) ?? randomUUID()
        this.db.run(
          `INSERT OR REPLACE INTO calendar_events (id, source_id, uid, title, starts_at, ends_at, attendees_json, location, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          sourceId,
          e.uid,
          e.title,
          e.startsAt,
          e.endsAt,
          JSON.stringify(e.attendees),
          e.location,
          e.description
        )
      }
    })
  }

  private toEvent(r: Record<string, unknown>): CalendarEvent {
    let attendees: string[] = []
    try {
      attendees = JSON.parse(r.attendees_json as string)
    } catch {
      /* ignore */
    }
    return {
      id: r.id as string,
      sourceId: r.source_id as string,
      uid: r.uid as string,
      title: r.title as string,
      startsAt: Number(r.starts_at),
      endsAt: Number(r.ends_at),
      attendees,
      location: (r.location as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      noteId: (r.note_id as string | null) ?? null
    }
  }

  upcoming(fromMs: number, toMs: number): CalendarEvent[] {
    return this.db
      .all(
        `SELECT e.*, (SELECT n.id FROM notes n WHERE n.calendar_event_id = e.id AND n.deleted_at IS NULL LIMIT 1) AS note_id
         FROM calendar_events e WHERE e.ends_at >= ? AND e.starts_at <= ? ORDER BY e.starts_at LIMIT 500`,
        fromMs,
        toMs
      )
      .map((r) => this.toEvent(r))
  }

  getEvent(id: string): CalendarEvent | null {
    const r = this.db.get(
      `SELECT e.*, (SELECT n.id FROM notes n WHERE n.calendar_event_id = e.id AND n.deleted_at IS NULL LIMIT 1) AS note_id FROM calendar_events e WHERE e.id = ?`,
      id
    )
    return r ? this.toEvent(r) : null
  }
}
