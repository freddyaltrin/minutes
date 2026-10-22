import { createStore } from '@renderer/lib/store'
import type {
  CalendarEvent,
  Folder,
  Note,
  NoteListQuery,
  NoteSummary,
  RecordingState,
  Settings,
  Tag,
  TranscriptionEngineInfo,
  UpdateState
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

export type View = NoteListQuery['view']

export interface Toast {
  id: string
  message: string
  kind: 'info' | 'error' | 'success'
  action?: { label: string; onClick: () => void }
  expiresAt: number
}

export type Panel = 'none' | 'transcript' | 'suggestions' | 'details'
export type Overlay = 'none' | 'search' | 'ask' | 'settings' | 'shortcuts' | 'about'

export interface AppState {
  ready: boolean
  settings: Settings
  theme: 'light' | 'dark'
  platform: string
  windowMaximized: boolean
  windowFocused: boolean

  view: View
  folderId: string | null
  tagId: string | null
  notes: NoteSummary[]
  notesLoading: boolean
  counts: { all: number; favorites: number; archived: number; trash: number; recent: number }
  folders: Folder[]
  tags: (Tag & { noteCount: number })[]

  selectedId: string | null
  current: Note | null
  saveState: 'saved' | 'saving' | 'dirty' | 'error'
  lastSavedAt: number | null

  panel: Panel
  overlay: Overlay
  settingsSection: string
  findInNote: boolean

  recording: RecordingState
  engineInfo: TranscriptionEngineInfo | null
  micLevel: number
  systemLevel: number

  upcoming: CalendarEvent[]
  update: UpdateState | null
  toasts: Toast[]
  /** Segment id to scroll to in the transcript panel (set by search results). */
  jumpToSegment: string | null
}

export const IDLE_RECORDING: RecordingState = {
  status: 'idle',
  noteId: null,
  startedAt: null,
  elapsedMs: 0,
  micActive: false,
  systemActive: false,
  error: null,
  transcription: { engine: 'none', status: 'off', queuedChunks: 0, recognizedSegments: 0, lastError: null },
  live: null,
  transcriptionUnavailableReason: null
}

export const store = createStore<AppState>({
  ready: false,
  settings: DEFAULT_SETTINGS,
  theme: 'light',
  platform: 'win32',
  windowMaximized: false,
  windowFocused: true,
  view: 'recent',
  folderId: null,
  tagId: null,
  notes: [],
  notesLoading: true,
  counts: { all: 0, favorites: 0, archived: 0, trash: 0, recent: 0 },
  folders: [],
  tags: [],
  selectedId: null,
  current: null,
  saveState: 'saved',
  lastSavedAt: null,
  panel: 'none',
  overlay: 'none',
  settingsSection: 'general',
  findInNote: false,
  recording: IDLE_RECORDING,
  engineInfo: null,
  micLevel: 0,
  systemLevel: 0,
  upcoming: [],
  update: null,
  toasts: [],
  jumpToSegment: null
})

export const useApp = store.use
