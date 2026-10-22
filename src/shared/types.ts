// Shared domain types used by main, preload and renderer.
// Everything here must be structured-clone safe (no classes, no functions).

export type NoteId = string
export type FolderId = string
export type TagId = string
export type TranscriptId = string

export interface Note {
  id: NoteId
  title: string
  /** TipTap/ProseMirror JSON document, serialized. Empty string = empty doc. */
  bodyJson: string
  /** Plain-text projection of bodyJson used for search, export and processing. */
  bodyText: string
  createdAt: number
  updatedAt: number
  meetingAt: number | null
  meetingEndAt: number | null
  calendarEventId: string | null
  folderId: FolderId | null
  attendees: string[]
  pinned: boolean
  favorite: boolean
  archived: boolean
  deletedAt: number | null
  transcriptId: TranscriptId | null
  tags: Tag[]
}

/** Lightweight row for lists — avoids shipping full bodies for every note. */
export interface NoteSummary {
  id: NoteId
  title: string
  preview: string
  createdAt: number
  updatedAt: number
  meetingAt: number | null
  folderId: FolderId | null
  attendees: string[]
  pinned: boolean
  favorite: boolean
  archived: boolean
  deletedAt: number | null
  hasTranscript: boolean
  tags: Tag[]
}

export interface Folder {
  id: FolderId
  name: string
  position: number
  createdAt: number
  noteCount: number
}

export interface Tag {
  id: TagId
  name: string
}

export type TranscriptSource =
  | 'live'          // produced by a local recognizer during a recording
  | 'background'    // produced by a background job over saved audio
  | 'import-srt'
  | 'import-vtt'
  | 'import-txt'
  | 'manual'

export type AudioChannel = 'mic' | 'system' | 'unknown'

export interface Transcript {
  id: TranscriptId
  noteId: NoteId
  source: TranscriptSource
  engine: string | null
  language: string | null
  createdAt: number
  updatedAt: number
  segmentCount: number
}

export interface TranscriptSegment {
  id: string
  transcriptId: TranscriptId
  seq: number
  startMs: number | null
  endMs: number | null
  channel: AudioChannel
  text: string
  /** Recognizer confidence 0..1 when the engine reports one; null for imports. */
  confidence: number | null
}

export type ExtractionKind = 'action' | 'decision' | 'question' | 'deadline' | 'topic' | 'reference'

export interface Extraction {
  id: string
  noteId: NoteId
  kind: ExtractionKind
  text: string
  /** Original passage the suggestion was derived from. Never synthesized. */
  sourceText: string
  sourceSegmentId: string | null
  sourceOrigin: 'note' | 'transcript'
  startMs: number | null
  /** Deterministic score used for ordering; not a probability. */
  score: number
  dismissed: boolean
  createdAt: number
}

export interface Recording {
  id: string
  noteId: NoteId
  path: string
  startedAt: number
  durationMs: number
  sizeBytes: number
  sampleRate: number
  channels: number
}

export interface CalendarEvent {
  id: string
  sourceId: string
  uid: string
  title: string
  startsAt: number
  endsAt: number
  attendees: string[]
  location: string | null
  description: string | null
  noteId: NoteId | null
}

export interface CalendarSource {
  id: string
  kind: 'ics-url' | 'ics-file'
  label: string
  url: string | null
  lastFetchedAt: number | null
  lastError: string | null
  eventCount: number
}

export type SortKey = 'updated' | 'created' | 'meeting' | 'title'

export interface NoteListQuery {
  view: 'all' | 'recent' | 'favorites' | 'archived' | 'trash' | 'folder' | 'tag'
  folderId?: FolderId
  tagId?: TagId
  sort?: SortKey
  limit?: number
  offset?: number
}

export interface SearchFilters {
  scope: 'all' | 'notes' | 'transcripts' | 'actions'
  folderId?: FolderId | null
  archived?: boolean
  from?: number
  to?: number
}

export interface SearchHit {
  kind: 'note' | 'transcript' | 'extraction'
  noteId: NoteId
  noteTitle: string
  meetingAt: number | null
  updatedAt: number
  /** Snippet with <mark> tags around matching terms. Already HTML-escaped. */
  snippet: string
  /** Unique id of the hit within its kind (segment id / extraction id / note id). */
  refId: string
  startMs: number | null
  rank: number
}

export interface SearchResult {
  query: string
  hits: SearchHit[]
  total: number
  tookMs: number
}

export type QuestionIntent = 'deadline' | 'assignment' | 'decision' | 'topic' | 'mention' | 'generic'

export interface AskResult {
  question: string
  intent: QuestionIntent
  terms: string[]
  hits: SearchHit[]
  /** Human-readable explanation of how matching was performed. */
  explanation: string
}

import type { TranscriptionConfig } from './transcription-types'

/** Transcription settings: the resource-aware configuration plus the master switch. */
export type TranscriptionSettings = TranscriptionConfig & { enabled: boolean }

export type ThemePreference = 'system' | 'light' | 'dark'

export interface Settings {
  theme: ThemePreference
  sidebarCollapsed: boolean
  sidebarWidth: number
  launchAtLogin: boolean
  startMinimized: boolean
  defaultView: 'recent' | 'all'
  editorFontSize: number
  audio: {
    micDeviceId: string | null
    captureSystemAudio: boolean
    keepRecordings: boolean
    autoStopSilenceMin: number
  }
  transcription: TranscriptionSettings
  updates: {
    checkAutomatically: boolean
    lastCheckedAt: number | null
  }
  shortcuts: Record<string, string>
  recentSearches: string[]
  lastNoteId: NoteId | null
  onboardingDismissed: boolean
}

export interface AudioDevice {
  deviceId: string
  label: string
  kind: 'audioinput' | 'audiooutput'
}

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error'

export interface RecordingState {
  status: RecordingStatus
  noteId: NoteId | null
  startedAt: number | null
  elapsedMs: number
  micActive: boolean
  systemActive: boolean
  error: string | null
  transcription: TranscriptionState
  /** Detailed live status from the transcription service (whisper backlog, lag, deferral). */
  live: import('./transcription-types').LiveTranscriptionStatus | null
  /** Why live transcription is not running for this recording, when it is not. */
  transcriptionUnavailableReason: string | null
}

export interface TranscriptionEngineInfo {
  id: 'whisper' | 'windows-sapi' | 'none'
  name: string
  available: boolean
  /** Why it is unavailable, or usage notes. */
  detail: string
  languages: string[]
  checkedAt: number
}

export interface TranscriptionState {
  engine: TranscriptionEngineInfo['id']
  status: 'off' | 'idle' | 'listening' | 'processing' | 'error'
  queuedChunks: number
  recognizedSegments: number
  lastError: string | null
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error' | 'disabled'
  currentVersion: string
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
  error: string | null
  checkedAt: number | null
}

export interface StorageInfo {
  databasePath: string
  databaseBytes: number
  recordingsPath: string
  recordingsBytes: number
  backupsPath: string
  exportsPath: string
  logsPath: string
  noteCount: number
  transcriptCount: number
  recordingCount: number
}

export interface BackupInfo {
  path: string
  createdAt: number
  sizeBytes: number
  noteCount: number
  appVersion: string
}

export interface Diagnostics {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osVersion: string
  sqliteVersion: string
  userDataPath: string
  uptimeSec: number
  migrations: { version: number; appliedAt: number }[]
}

export interface ExportResult {
  ok: boolean
  path: string | null
  cancelled: boolean
  error: string | null
}

export interface ShortcutDefinition {
  id: string
  label: string
  /** Default accelerator in Electron syntax, e.g. "CommandOrControl+N". */
  default: string
  /** Global shortcuts are registered with the OS; app shortcuts only fire while focused. */
  scope: 'app' | 'global'
  category: 'Notes' | 'Navigation' | 'Recording' | 'Application'
}

export interface UndoableAction {
  id: string
  label: string
  expiresAt: number
}

export interface AppError {
  code: string
  message: string
  detail?: string
}
