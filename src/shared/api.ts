// The complete, typed contract between renderer and main.
// The preload exposes exactly this surface as `window.minutes`.
// Main registers one validated handler per method. Nothing else is exposed.

import type {
  EngineStatus,
  HardwareInfo,
  LiveTranscriptionStatus,
  ModelState,
  ProfileDefinition,
  ProfileId,
  ResourcePlan,
  StorageUsage,
  TranscriptionJob
} from './transcription-types'
import type {
  AskResult,
  AudioDevice,
  BackupInfo,
  CalendarEvent,
  CalendarSource,
  Diagnostics,
  ExportResult,
  Extraction,
  ExtractionKind,
  Folder,
  Note,
  NoteId,
  NoteListQuery,
  NoteSummary,
  Recording,
  RecordingState,
  SearchFilters,
  SearchResult,
  Settings,
  ShortcutDefinition,
  StorageInfo,
  Tag,
  Transcript,
  TranscriptSegment,
  TranscriptionEngineInfo,
  TranscriptionSettings,
  UpdateState
} from './types'

export interface TranscriptionOverview {
  engine: EngineStatus
  live: LiveTranscriptionStatus
  plan: ResourcePlan
  hardware: HardwareInfo
  recommendedProfile: ProfileId
  profiles: ProfileDefinition[]
  config: TranscriptionSettings
}

export interface NoteCreateInput {
  title?: string
  folderId?: string | null
  meetingAt?: number | null
  meetingEndAt?: number | null
  calendarEventId?: string | null
  attendees?: string[]
  bodyJson?: string
  bodyText?: string
}

export interface NoteUpdateInput {
  title?: string
  bodyJson?: string
  bodyText?: string
  meetingAt?: number | null
  meetingEndAt?: number | null
  folderId?: string | null
  attendees?: string[]
  pinned?: boolean
  favorite?: boolean
  archived?: boolean
}

export interface TranscriptImportInput {
  noteId: NoteId
  /** Raw file contents. */
  content: string
  format: 'srt' | 'vtt' | 'txt' | 'auto'
  fileName?: string
}

export interface AudioChunk {
  /** Little-endian PCM16 mono at `sampleRate`. Transferred as ArrayBuffer. */
  pcm: ArrayBuffer
  sampleRate: number
  channel: 'mic' | 'system' | 'mix'
  /** Milliseconds since recording start for the first sample in this chunk. */
  offsetMs: number
}

export interface MinutesApi {
  notes: {
    list(query: NoteListQuery): Promise<NoteSummary[]>
    get(id: NoteId): Promise<Note | null>
    create(input: NoteCreateInput): Promise<Note>
    update(id: NoteId, patch: NoteUpdateInput): Promise<Note>
    duplicate(id: NoteId): Promise<Note>
    /** Soft delete (moves to trash). */
    trash(id: NoteId): Promise<void>
    restore(id: NoteId): Promise<void>
    /** Permanent delete. */
    destroy(id: NoteId): Promise<void>
    emptyTrash(): Promise<number>
    setTags(id: NoteId, tagNames: string[]): Promise<Tag[]>
    counts(): Promise<{ all: number; favorites: number; archived: number; trash: number; recent: number }>
  }
  folders: {
    list(): Promise<Folder[]>
    create(name: string): Promise<Folder>
    rename(id: string, name: string): Promise<Folder>
    reorder(ids: string[]): Promise<void>
    /** Notes inside are moved to "no folder"; nothing is deleted. */
    remove(id: string): Promise<void>
  }
  tags: {
    list(): Promise<(Tag & { noteCount: number })[]>
    rename(id: string, name: string): Promise<Tag>
    remove(id: string): Promise<void>
  }
  transcripts: {
    get(noteId: NoteId): Promise<{ transcript: Transcript; segments: TranscriptSegment[] } | null>
    import(input: TranscriptImportInput): Promise<{ transcript: Transcript; segmentCount: number }>
    updateSegment(id: string, text: string): Promise<void>
    deleteSegment(id: string): Promise<void>
    clear(noteId: NoteId): Promise<void>
    addManualSegment(noteId: NoteId, text: string, startMs: number | null): Promise<TranscriptSegment>
  }
  extractions: {
    /** Re-runs deterministic analysis on the note body + transcript and stores suggestions. */
    analyze(noteId: NoteId): Promise<Extraction[]>
    list(noteId: NoteId): Promise<Extraction[]>
    update(id: string, patch: { text?: string; dismissed?: boolean; kind?: ExtractionKind }): Promise<Extraction>
    remove(id: string): Promise<void>
  }
  search: {
    query(text: string, filters: SearchFilters, limit?: number): Promise<SearchResult>
    ask(question: string, filters: SearchFilters): Promise<AskResult>
    recent(): Promise<string[]>
    clearRecent(): Promise<void>
  }
  recording: {
    getState(): Promise<RecordingState>
    listDevices(): Promise<AudioDevice[]>
    /** Called by the renderer once capture streams are live. */
    begin(noteId: NoteId, opts: { sampleRate: number; micLabel: string | null; systemAudio: boolean }): Promise<RecordingState>
    pushChunk(chunk: AudioChunk): void
    pause(): Promise<RecordingState>
    resume(): Promise<RecordingState>
    end(reason?: string): Promise<RecordingState>
    reportError(message: string): Promise<RecordingState>
    listRecordings(noteId: NoteId): Promise<Recording[]>
    deleteRecording(id: string): Promise<void>
    revealRecording(id: string): Promise<void>
  }
  transcription: {
    /** Probe of the conventional Windows recognizer (secondary engine). */
    engineInfo(refresh?: boolean): Promise<TranscriptionEngineInfo>
    config(): Promise<TranscriptionSettings>
    setConfig(patch: Partial<TranscriptionSettings>): Promise<TranscriptionSettings>
    status(): Promise<TranscriptionOverview>
    hardware(refresh?: boolean): Promise<HardwareInfo>
    plan(): Promise<ResourcePlan>
  }
  models: {
    list(): Promise<ModelState[]>
    download(id: string): Promise<void>
    cancel(id: string): Promise<void>
    remove(id: string): Promise<void>
    verify(id: string): Promise<boolean>
    /** Opens a file picker and installs a model file the user already has (offline deployment). */
    importFile(id: string): Promise<ModelState | null>
    storage(): Promise<StorageUsage>
    openFolder(): Promise<void>
  }
  jobs: {
    list(): Promise<TranscriptionJob[]>
    enqueueRecording(noteId: NoteId, recordingId: string): Promise<TranscriptionJob>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    cancel(id: string): Promise<void>
    retry(id: string): Promise<void>
    remove(id: string): Promise<void>
  }
  calendar: {
    listSources(): Promise<CalendarSource[]>
    addIcsUrl(label: string, url: string): Promise<CalendarSource>
    addIcsFile(): Promise<CalendarSource | null>
    removeSource(id: string): Promise<void>
    refresh(sourceId?: string): Promise<CalendarSource[]>
    upcoming(days: number): Promise<CalendarEvent[]>
    createNoteForEvent(eventId: string): Promise<Note>
  }
  exports: {
    noteMarkdown(id: NoteId): Promise<ExportResult>
    noteText(id: NoteId): Promise<ExportResult>
    transcript(noteId: NoteId, format: 'txt' | 'srt' | 'vtt' | 'md'): Promise<ExportResult>
    allNotesMarkdown(): Promise<ExportResult>
    /** Returns the export text without writing a file (used for clipboard copy). */
    render(id: NoteId, format: 'md' | 'txt'): Promise<string>
    openExportsFolder(): Promise<void>
  }
  backup: {
    create(): Promise<BackupInfo>
    list(): Promise<BackupInfo[]>
    /** Restores from a chosen file. Returns false if the user cancelled or declined the warning. */
    restore(path?: string): Promise<{ restored: boolean; restartRequired: boolean; error: string | null }>
    openBackupsFolder(): Promise<void>
    storageInfo(): Promise<StorageInfo>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    reset(): Promise<Settings>
    shortcutDefinitions(): Promise<ShortcutDefinition[]>
    diagnostics(): Promise<Diagnostics>
    openLogsFolder(): Promise<void>
    openDataFolder(): Promise<void>
    exportDiagnostics(): Promise<ExportResult>
  }
  updates: {
    getState(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<void>
  }
  app: {
    version(): Promise<string>
    platform(): Promise<NodeJS.Platform>
    openExternal(url: string): Promise<boolean>
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    confirm(opts: { title: string; message: string; detail?: string; confirmLabel: string; destructive?: boolean }): Promise<boolean>
  }
  /** Event subscriptions. Each returns an unsubscribe function. */
  on: {
    recordingState(cb: (s: RecordingState) => void): () => void
    transcriptSegments(cb: (p: { noteId: NoteId; segments: TranscriptSegment[] }) => void): () => void
    updateState(cb: (s: UpdateState) => void): () => void
    shortcut(cb: (id: string) => void): () => void
    notesChanged(cb: (p: { ids: NoteId[] }) => void): () => void
    calendarChanged(cb: () => void): () => void
    windowState(cb: (p: { maximized: boolean; focused: boolean }) => void): () => void
    /** Main asks renderer to start/stop capture (global shortcut, tray, calendar prompt). */
    captureCommand(cb: (p: { command: 'start' | 'stop' | 'toggle'; noteId?: NoteId }) => void): () => void
    log(cb: (p: { level: 'info' | 'warn' | 'error'; message: string }) => void): () => void
    /** Whisper model catalog/install state changed (download progress, install, remove). */
    modelsChanged(cb: (p: ModelState[]) => void): () => void
    /** Live transcription engine status. */
    transcriptionStatus(cb: (s: LiveTranscriptionStatus) => void): () => void
    /** Transcription job queue changed. */
    jobsChanged(cb: (p: TranscriptionJob[]) => void): () => void
  }
}

/** Channel name for an invoke call: `${namespace}:${method}`. */
export const channel = (ns: keyof MinutesApi, method: string): string => `${String(ns)}:${method}`

export const EVENT_CHANNELS = {
  recordingState: 'evt:recordingState',
  transcriptSegments: 'evt:transcriptSegments',
  updateState: 'evt:updateState',
  shortcut: 'evt:shortcut',
  notesChanged: 'evt:notesChanged',
  calendarChanged: 'evt:calendarChanged',
  windowState: 'evt:windowState',
  captureCommand: 'evt:captureCommand',
  log: 'evt:log',
  modelsChanged: 'evt:modelsChanged',
  transcriptionStatus: 'evt:transcriptionStatus',
  jobsChanged: 'evt:jobsChanged'
} as const

export type EventName = keyof typeof EVENT_CHANNELS
