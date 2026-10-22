import type { Settings, ShortcutDefinition } from './types'

export const APP_NAME = 'Minutes'

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'note.new', label: 'New note', default: 'CommandOrControl+N', scope: 'app', category: 'Notes' },
  { id: 'note.save', label: 'Save now', default: 'CommandOrControl+S', scope: 'app', category: 'Notes' },
  { id: 'note.duplicate', label: 'Duplicate note', default: 'CommandOrControl+D', scope: 'app', category: 'Notes' },
  { id: 'note.trash', label: 'Move note to trash', default: 'CommandOrControl+Shift+Backspace', scope: 'app', category: 'Notes' },
  { id: 'note.favorite', label: 'Toggle favorite', default: 'CommandOrControl+Shift+F', scope: 'app', category: 'Notes' },
  { id: 'note.find', label: 'Find in note', default: 'CommandOrControl+F', scope: 'app', category: 'Notes' },
  { id: 'nav.search', label: 'Search everything', default: 'CommandOrControl+K', scope: 'app', category: 'Navigation' },
  { id: 'nav.ask', label: 'Ask your notes', default: 'CommandOrControl+J', scope: 'app', category: 'Navigation' },
  { id: 'nav.sidebar', label: 'Toggle sidebar', default: 'CommandOrControl+\\', scope: 'app', category: 'Navigation' },
  { id: 'nav.transcript', label: 'Toggle transcript panel', default: 'CommandOrControl+T', scope: 'app', category: 'Navigation' },
  { id: 'nav.next', label: 'Next note', default: 'CommandOrControl+Down', scope: 'app', category: 'Navigation' },
  { id: 'nav.prev', label: 'Previous note', default: 'CommandOrControl+Up', scope: 'app', category: 'Navigation' },
  { id: 'nav.settings', label: 'Open settings', default: 'CommandOrControl+,', scope: 'app', category: 'Application' },
  { id: 'rec.toggle', label: 'Start / stop recording', default: 'CommandOrControl+Shift+R', scope: 'global', category: 'Recording' },
  { id: 'rec.pause', label: 'Pause / resume recording', default: 'CommandOrControl+Shift+P', scope: 'app', category: 'Recording' }
]

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sidebarCollapsed: false,
  sidebarWidth: 248,
  launchAtLogin: false,
  startMinimized: false,
  defaultView: 'recent',
  editorFontSize: 15,
  audio: {
    micDeviceId: null,
    captureSystemAudio: true,
    keepRecordings: false,
    autoStopSilenceMin: 15
  },
  transcription: {
    enabled: true,
    engine: 'whisper',
    profile: 'balanced',
    modelId: null,
    threads: null,
    language: null,
    allowFallback: true,
    backgroundAfterMeeting: true,
    customVocabulary: []
  },
  updates: {
    checkAutomatically: true,
    lastCheckedAt: null
  },
  shortcuts: Object.fromEntries(SHORTCUT_DEFINITIONS.map((s) => [s.id, s.default])),
  recentSearches: [],
  lastNoteId: null,
  onboardingDismissed: false
}

/** Trash retention: notes in trash older than this are purged on startup. */
export const TRASH_RETENTION_DAYS = 30
/** "Recent" view window. */
export const RECENT_DAYS = 30
/** Editor autosave debounce. */
export const AUTOSAVE_DEBOUNCE_MS = 600
/** Undo window for destructive list actions (trash, archive). */
export const UNDO_WINDOW_MS = 8000
