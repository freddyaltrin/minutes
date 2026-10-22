import { contextBridge, ipcRenderer } from 'electron'
import type { MinutesApi } from '../shared/api'
import { channel, EVENT_CHANNELS, type EventName } from '../shared/api'

// The preload exposes exactly the MinutesApi surface. No ipcRenderer, no Node, nothing else.

const invoke =
  <T>(ns: keyof MinutesApi, method: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel(ns, method), ...args)

const send =
  (ns: keyof MinutesApi, method: string) =>
  (...args: unknown[]): void =>
    ipcRenderer.send(channel(ns, method), ...args)

function subscribe(name: EventName) {
  return (cb: (payload: never) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(EVENT_CHANNELS[name], listener)
    return () => ipcRenderer.removeListener(EVENT_CHANNELS[name], listener)
  }
}

/** Builds a namespace object whose methods all invoke `${ns}:${method}`. */
function ns<K extends keyof MinutesApi>(name: K, methods: (keyof MinutesApi[K])[], fireAndForget: (keyof MinutesApi[K])[] = []): MinutesApi[K] {
  const out: Record<string, unknown> = {}
  for (const m of methods) out[m as string] = fireAndForget.includes(m) ? send(name, m as string) : invoke(name, m as string)
  return out as MinutesApi[K]
}

const api: MinutesApi = {
  notes: ns('notes', ['list', 'get', 'create', 'update', 'duplicate', 'trash', 'restore', 'destroy', 'emptyTrash', 'setTags', 'counts']),
  folders: ns('folders', ['list', 'create', 'rename', 'reorder', 'remove']),
  tags: ns('tags', ['list', 'rename', 'remove']),
  transcripts: ns('transcripts', ['get', 'import', 'updateSegment', 'deleteSegment', 'clear', 'addManualSegment']),
  extractions: ns('extractions', ['analyze', 'list', 'update', 'remove']),
  search: ns('search', ['query', 'ask', 'recent', 'clearRecent']),
  recording: ns(
    'recording',
    ['getState', 'listDevices', 'begin', 'pushChunk', 'pause', 'resume', 'end', 'reportError', 'listRecordings', 'deleteRecording', 'revealRecording'],
    ['pushChunk']
  ),
  transcription: ns('transcription', ['engineInfo', 'config', 'setConfig', 'status', 'hardware', 'plan']),
  models: ns('models', ['list', 'download', 'cancel', 'remove', 'verify', 'importFile', 'storage', 'openFolder']),
  jobs: ns('jobs', ['list', 'enqueueRecording', 'pause', 'resume', 'cancel', 'retry', 'remove']),
  calendar: ns('calendar', ['listSources', 'addIcsUrl', 'addIcsFile', 'removeSource', 'refresh', 'upcoming', 'createNoteForEvent']),
  exports: ns('exports', ['noteMarkdown', 'noteText', 'transcript', 'allNotesMarkdown', 'render', 'openExportsFolder']),
  backup: ns('backup', ['create', 'list', 'restore', 'openBackupsFolder', 'storageInfo']),
  settings: ns('settings', ['get', 'set', 'reset', 'shortcutDefinitions', 'diagnostics', 'openLogsFolder', 'openDataFolder', 'exportDiagnostics']),
  updates: ns('updates', ['getState', 'check', 'download', 'install']),
  app: ns('app', ['version', 'platform', 'openExternal', 'minimize', 'toggleMaximize', 'close', 'isMaximized', 'confirm'], ['minimize', 'toggleMaximize', 'close']),
  on: {
    recordingState: subscribe('recordingState'),
    transcriptSegments: subscribe('transcriptSegments'),
    updateState: subscribe('updateState'),
    shortcut: subscribe('shortcut'),
    notesChanged: subscribe('notesChanged'),
    calendarChanged: subscribe('calendarChanged'),
    windowState: subscribe('windowState'),
    captureCommand: subscribe('captureCommand'),
    log: subscribe('log'),
    modelsChanged: subscribe('modelsChanged'),
    transcriptionStatus: subscribe('transcriptionStatus'),
    jobsChanged: subscribe('jobsChanged')
  }
}

contextBridge.exposeInMainWorld('minutes', api)
contextBridge.exposeInMainWorld('minutesPlatform', process.platform)
