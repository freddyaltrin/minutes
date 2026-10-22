// Ordered, append-only schema migrations. Never edit an applied migration; add a new one.

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    sql: `
      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        body_json TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        meeting_at INTEGER,
        meeting_end_at INTEGER,
        calendar_event_id TEXT,
        folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        attendees_json TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE INDEX idx_notes_updated ON notes(updated_at DESC);
      CREATE INDEX idx_notes_meeting ON notes(meeting_at DESC);
      CREATE INDEX idx_notes_folder ON notes(folder_id);
      CREATE INDEX idx_notes_flags ON notes(archived, deleted_at, favorite);
      CREATE INDEX idx_notes_calendar ON notes(calendar_event_id);

      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
      CREATE TABLE note_tags (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      );
      CREATE INDEX idx_note_tags_tag ON note_tags(tag_id);

      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        engine TEXT,
        language TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE transcript_segments (
        id TEXT PRIMARY KEY,
        transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        start_ms INTEGER,
        end_ms INTEGER,
        channel TEXT NOT NULL DEFAULT 'unknown',
        text TEXT NOT NULL,
        confidence REAL
      );
      CREATE INDEX idx_segments_transcript ON transcript_segments(transcript_id, seq);

      CREATE TABLE extractions (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source_text TEXT NOT NULL,
        source_segment_id TEXT,
        source_origin TEXT NOT NULL,
        start_ms INTEGER,
        score REAL NOT NULL DEFAULT 0,
        dismissed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_extractions_note ON extractions(note_id, kind);

      CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        sample_rate INTEGER NOT NULL,
        channels INTEGER NOT NULL
      );
      CREATE INDEX idx_recordings_note ON recordings(note_id);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );

      CREATE TABLE calendar_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT,
        last_fetched_at INTEGER,
        last_error TEXT
      );

      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
        uid TEXT NOT NULL,
        title TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        attendees_json TEXT NOT NULL DEFAULT '[]',
        location TEXT,
        description TEXT,
        UNIQUE (source_id, uid, starts_at)
      );
      CREATE INDEX idx_events_start ON calendar_events(starts_at);

      -- Full-text search tables. Kept in sync by the repositories inside the same transaction
      -- as the row they index. Regular (not contentless) FTS5 so rows can be deleted by id.
      CREATE VIRTUAL TABLE notes_fts USING fts5(
        note_id UNINDEXED, title, body, tags,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE segments_fts USING fts5(
        segment_id UNINDEXED, note_id UNINDEXED, text,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE extractions_fts USING fts5(
        extraction_id UNINDEXED, note_id UNINDEXED, text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `
  },
  {
    version: 2,
    name: 'transcription-jobs',
    sql: `
      -- Background / deferred transcription jobs. Sources are chunk files or recordings kept on disk
      -- until the job completes, so audio is never discarded while unprocessed.
      CREATE TABLE transcription_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        recording_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL,
        sources_json TEXT NOT NULL,
        processed_ms INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        segments_written INTEGER NOT NULL DEFAULT 0,
        next_index INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX idx_jobs_status ON transcription_jobs(status, created_at);
      CREATE INDEX idx_jobs_note ON transcription_jobs(note_id);
    `
  }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
