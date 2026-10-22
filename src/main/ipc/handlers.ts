import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppContext } from '../context'
import { v, partial, ValidationError, type Validator } from './validate'
import { channel } from '@shared/api'
import type { Services } from '../services'
import { SHORTCUT_DEFINITIONS } from '@shared/defaults'
import { analyzeText, parseTranscript } from '@shared/text'
import { SapiEngine } from '../services/transcription/sapi-engine'
import { PROFILES } from '../services/whisper/profiles'

type Handler = (...args: unknown[]) => unknown

/** Registers one invoke handler with argument validators. Errors are returned as plain messages. */
function reg(ctx: AppContext, ns: Parameters<typeof channel>[0], method: string, validators: Validator<unknown>[], fn: Handler): void {
  const ch = channel(ns, method)
  ipcMain.handle(ch, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) throw new Error('Untrusted sender')
    try {
      if (args.length > validators.length) throw new ValidationError(`${ch}: too many arguments`)
      const parsed = validators.map((val, i) => val(args[i], `${ch}.arg${i}`))
      return await fn(...parsed)
    } catch (err) {
      const e = err as Error
      if (!(e instanceof ValidationError)) ctx.log.error(`ipc ${ch} failed`, e)
      // Only the message crosses the boundary; stack traces stay in the log.
      throw new Error(e.message)
    }
  })
}

export function isTrustedSender(url: string): boolean {
  return url.startsWith('file://') || /^https?:\/\/localhost(:\d+)?\//.test(url) || /^https?:\/\/127\.0\.0\.1(:\d+)?\//.test(url)
}

const ID = v.id()
const noteListQuery = v.object({
  view: v.literal(['all', 'recent', 'favorites', 'archived', 'trash', 'folder', 'tag'] as const),
  folderId: v.optional(ID),
  tagId: v.optional(ID),
  sort: v.optional(v.literal(['updated', 'created', 'meeting', 'title'] as const)),
  limit: v.optional(v.number({ int: true, min: 1, max: 5000 })),
  offset: v.optional(v.number({ int: true, min: 0 }))
})
const noteCreate = partial({
  title: v.string({ max: 500 }),
  folderId: v.nullable(ID),
  meetingAt: v.nullable(v.number()),
  meetingEndAt: v.nullable(v.number()),
  calendarEventId: v.nullable(ID),
  attendees: v.array(v.string({ max: 200 }), { max: 200 }),
  bodyJson: v.string({ max: 20_000_000 }),
  bodyText: v.string({ max: 10_000_000 })
})
const noteUpdate = partial({
  title: v.string({ max: 500 }),
  bodyJson: v.string({ max: 20_000_000 }),
  bodyText: v.string({ max: 10_000_000 }),
  meetingAt: v.nullable(v.number()),
  meetingEndAt: v.nullable(v.number()),
  folderId: v.nullable(ID),
  attendees: v.array(v.string({ max: 200 }), { max: 200 }),
  pinned: v.boolean(),
  favorite: v.boolean(),
  archived: v.boolean()
})
const searchFilters = v.object({
  scope: v.literal(['all', 'notes', 'transcripts', 'actions'] as const),
  folderId: v.optional(v.nullable(ID)),
  archived: v.optional(v.boolean()),
  from: v.optional(v.number()),
  to: v.optional(v.number())
})
const transcriptionPatch = partial({
  enabled: v.boolean(),
  engine: v.literal(['whisper', 'windows-sapi', 'none'] as const),
  profile: v.literal(['lightweight', 'balanced', 'high-accuracy', 'custom'] as const),
  modelId: v.nullable(v.string({ max: 60 })),
  threads: v.nullable(v.number({ int: true, min: 1, max: 64 })),
  language: v.nullable(v.string({ max: 20 })),
  allowFallback: v.boolean(),
  backgroundAfterMeeting: v.boolean(),
  customVocabulary: v.array(v.string({ max: 80 }), { max: 500 })
})
const settingsPatch = partial({
  theme: v.literal(['system', 'light', 'dark'] as const),
  sidebarCollapsed: v.boolean(),
  sidebarWidth: v.number({ min: 180, max: 480 }),
  launchAtLogin: v.boolean(),
  startMinimized: v.boolean(),
  defaultView: v.literal(['recent', 'all'] as const),
  editorFontSize: v.number({ min: 12, max: 22 }),
  audio: partial({
    micDeviceId: v.nullable(v.string({ max: 300 })),
    captureSystemAudio: v.boolean(),
    keepRecordings: v.boolean(),
    autoStopSilenceMin: v.number({ min: 0, max: 120 })
  }),
  transcription: transcriptionPatch,
  updates: partial({ checkAutomatically: v.boolean(), lastCheckedAt: v.nullable(v.number()) }),
  shortcuts: v.record(v.string({ max: 60 })),
  recentSearches: v.array(v.string({ max: 200 }), { max: 20 }),
  lastNoteId: v.nullable(ID),
  onboardingDismissed: v.boolean()
})

export function registerHandlers(ctx: AppContext, s: Services): void {
  const notesChanged = (ids: string[]): void => ctx.notesChanged(ids)

  // ---------- notes ----------
  reg(ctx, 'notes', 'list', [noteListQuery], (q) => ctx.notes.list(q as never))
  reg(ctx, 'notes', 'get', [ID], (id) => ctx.notes.get(id as string))
  reg(ctx, 'notes', 'create', [noteCreate], (input) => {
    const n = ctx.notes.create(input as never)
    notesChanged([n.id])
    return n
  })
  reg(ctx, 'notes', 'update', [ID, noteUpdate], (id, patch) => {
    const n = ctx.notes.update(id as string, patch as never)
    notesChanged([n.id])
    return n
  })
  reg(ctx, 'notes', 'duplicate', [ID], (id) => {
    const n = ctx.notes.duplicate(id as string)
    notesChanged([n.id])
    return n
  })
  reg(ctx, 'notes', 'trash', [ID], (id) => {
    ctx.notes.trash(id as string)
    notesChanged([id as string])
  })
  reg(ctx, 'notes', 'restore', [ID], (id) => {
    ctx.notes.restore(id as string)
    notesChanged([id as string])
  })
  reg(ctx, 'notes', 'destroy', [ID], (id) => {
    for (const r of ctx.transcripts.listRecordings(id as string)) s.recording.deleteRecording(r.id)
    ctx.notes.destroy(id as string)
    notesChanged([id as string])
  })
  reg(ctx, 'notes', 'emptyTrash', [], () => {
    const ids = ctx.notes.list({ view: 'trash', limit: 5000 }).map((n) => n.id)
    for (const id of ids) for (const r of ctx.transcripts.listRecordings(id)) s.recording.deleteRecording(r.id)
    const n = ctx.notes.emptyTrash()
    notesChanged(ids)
    return n
  })
  reg(ctx, 'notes', 'setTags', [ID, v.array(v.string({ max: 60 }), { max: 50 })], (id, names) => {
    const tags = ctx.notes.setTags(id as string, names as string[])
    notesChanged([id as string])
    return tags
  })
  reg(ctx, 'notes', 'counts', [], () => ctx.notes.counts())

  // ---------- folders / tags ----------
  reg(ctx, 'folders', 'list', [], () => ctx.notes.listFolders())
  reg(ctx, 'folders', 'create', [v.string({ min: 1, max: 80 })], (name) => ctx.notes.createFolder(name as string))
  reg(ctx, 'folders', 'rename', [ID, v.string({ min: 1, max: 80 })], (id, name) => ctx.notes.renameFolder(id as string, name as string))
  reg(ctx, 'folders', 'reorder', [v.array(ID, { max: 500 })], (ids) => ctx.notes.reorderFolders(ids as string[]))
  reg(ctx, 'folders', 'remove', [ID], (id) => {
    ctx.notes.removeFolder(id as string)
    notesChanged([])
  })
  reg(ctx, 'tags', 'list', [], () => ctx.notes.listTags())
  reg(ctx, 'tags', 'rename', [ID, v.string({ min: 1, max: 60 })], (id, name) => {
    const t = ctx.notes.renameTag(id as string, name as string)
    notesChanged([])
    return t
  })
  reg(ctx, 'tags', 'remove', [ID], (id) => {
    ctx.notes.removeTag(id as string)
    notesChanged([])
  })

  // ---------- transcripts ----------
  reg(ctx, 'transcripts', 'get', [ID], (noteId) => ctx.transcripts.getByNote(noteId as string))
  reg(
    ctx,
    'transcripts',
    'import',
    [v.object({ noteId: ID, content: v.string({ max: 50_000_000 }), format: v.literal(['srt', 'vtt', 'txt', 'auto'] as const), fileName: v.optional(v.string({ max: 300 })) })],
    (raw) => {
      const input = raw as { noteId: string; content: string; format: 'srt' | 'vtt' | 'txt' | 'auto'; fileName?: string }
      const parsed = parseTranscript(input.content, input.format === 'auto' ? undefined : input.format, input.fileName)
      if (parsed.length === 0) throw new Error('No transcript lines could be read from that file.')
      const fmt = input.format === 'auto' ? (input.fileName?.toLowerCase().endsWith('.vtt') ? 'vtt' : input.fileName?.toLowerCase().endsWith('.srt') ? 'srt' : 'txt') : input.format
      const source = fmt === 'srt' ? 'import-srt' : fmt === 'vtt' ? 'import-vtt' : 'import-txt'
      const t = ctx.transcripts.replaceAll(
        input.noteId,
        source,
        null,
        null,
        parsed.map((p) => ({
          text: p.speaker ? `${p.speaker}: ${p.text}` : p.text,
          startMs: p.startMs,
          endMs: p.endMs,
          channel: 'unknown' as const,
          confidence: null
        }))
      )
      notesChanged([input.noteId])
      return { transcript: t, segmentCount: parsed.length }
    }
  )
  reg(ctx, 'transcripts', 'updateSegment', [ID, v.string({ max: 20_000 })], (id, text) => ctx.transcripts.updateSegment(id as string, text as string))
  reg(ctx, 'transcripts', 'deleteSegment', [ID], (id) => ctx.transcripts.deleteSegment(id as string))
  reg(ctx, 'transcripts', 'clear', [ID], (noteId) => {
    ctx.transcripts.clear(noteId as string)
    notesChanged([noteId as string])
  })
  reg(ctx, 'transcripts', 'addManualSegment', [ID, v.string({ min: 1, max: 20_000 }), v.nullable(v.number({ min: 0 }))], (noteId, text, startMs) => {
    const t = ctx.transcripts.ensure(noteId as string, 'manual', null, null)
    const [seg] = ctx.transcripts.appendSegments(noteId as string, t.id, [{ text: text as string, startMs: startMs as number | null, endMs: null, channel: 'unknown', confidence: null }])
    notesChanged([noteId as string])
    return seg
  })

  // ---------- extractions ----------
  reg(ctx, 'extractions', 'analyze', [ID], (noteId) => {
    const note = ctx.notes.get(noteId as string)
    if (!note) throw new Error('Note not found')
    const segments = ctx.transcripts.segmentsText(noteId as string)
    const drafts = analyzeText({ noteText: note.bodyText, segments, referenceDate: new Date(note.meetingAt ?? note.createdAt) })
    return ctx.transcripts.replaceExtractions(noteId as string, drafts)
  })
  reg(ctx, 'extractions', 'list', [ID], (noteId) => ctx.transcripts.listExtractions(noteId as string))
  reg(
    ctx,
    'extractions',
    'update',
    [ID, partial({ text: v.string({ max: 5000 }), dismissed: v.boolean(), kind: v.literal(['action', 'decision', 'question', 'deadline', 'topic', 'reference'] as const) })],
    (id, patch) => ctx.transcripts.updateExtraction(id as string, patch as never)
  )
  reg(ctx, 'extractions', 'remove', [ID], (id) => ctx.transcripts.removeExtraction(id as string))

  // ---------- search ----------
  reg(ctx, 'search', 'query', [v.string({ max: 500 }), searchFilters, v.optional(v.number({ int: true, min: 1, max: 500 }))], (text, filters, limit) => {
    const res = ctx.search.query(text as string, filters as never, (limit as number | undefined) ?? 60)
    const q = (text as string).trim()
    if (q.length >= 2 && res.hits.length > 0) {
      const recent = [q, ...ctx.settings.get().recentSearches.filter((r) => r !== q)].slice(0, 10)
      ctx.settings.set({ recentSearches: recent })
    }
    return res
  })
  reg(ctx, 'search', 'ask', [v.string({ max: 500 }), searchFilters], (q, filters) => ctx.search.ask(q as string, filters as never))
  reg(ctx, 'search', 'recent', [], () => ctx.settings.get().recentSearches)
  reg(ctx, 'search', 'clearRecent', [], () => {
    ctx.settings.set({ recentSearches: [] })
  })

  // ---------- recording ----------
  reg(ctx, 'recording', 'getState', [], () => s.recording.getState())
  reg(ctx, 'recording', 'listDevices', [], () => []) // device enumeration happens in the renderer (navigator.mediaDevices)
  reg(
    ctx,
    'recording',
    'begin',
    [ID, v.object({ sampleRate: v.number({ int: true, min: 8000, max: 48000 }), micLabel: v.nullable(v.string({ max: 200 })), systemAudio: v.boolean() })],
    (noteId, opts) => s.recording.begin(noteId as string, opts as never)
  )
  ipcMain.on(channel('recording', 'pushChunk'), (event, raw: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return
    try {
      const chunk = v.object({
        pcm: v.arrayBuffer(2_000_000),
        sampleRate: v.number({ int: true, min: 8000, max: 48000 }),
        channel: v.literal(['mic', 'system', 'mix'] as const),
        offsetMs: v.number({ min: 0 })
      })(raw, 'pushChunk')
      s.recording.pushChunk(chunk)
    } catch (err) {
      ctx.log.warn('bad audio chunk dropped', (err as Error).message)
    }
  })
  reg(ctx, 'recording', 'pause', [], () => s.recording.pause())
  reg(ctx, 'recording', 'resume', [], () => s.recording.resume())
  reg(ctx, 'recording', 'end', [v.optional(v.string({ max: 100 }))], (reason) => s.recording.end((reason as string | undefined) ?? 'user'))
  reg(ctx, 'recording', 'reportError', [v.string({ max: 2000 })], (m) => s.recording.reportError(m as string))
  reg(ctx, 'recording', 'listRecordings', [ID], (noteId) => ctx.transcripts.listRecordings(noteId as string))
  reg(ctx, 'recording', 'deleteRecording', [ID], (id) => s.recording.deleteRecording(id as string))
  reg(ctx, 'recording', 'revealRecording', [ID], (id) => {
    const r = ctx.transcripts.getRecording(id as string)
    if (r) shell.showItemInFolder(r.path)
  })

  // ---------- transcription ----------
  reg(ctx, 'transcription', 'engineInfo', [v.optional(v.boolean())], (refresh) => SapiEngine.probe({}, !!refresh))
  reg(ctx, 'transcription', 'config', [], () => s.transcription.config())
  reg(ctx, 'transcription', 'setConfig', [transcriptionPatch], (patch) => s.transcription.setConfig(patch as never))
  reg(ctx, 'transcription', 'status', [], () => ({
    engine: s.transcription.engineStatus(),
    live: s.transcription.liveStatus(),
    plan: s.transcription.plan(),
    hardware: s.transcription.hardware(),
    recommendedProfile: s.transcription.recommendedProfile(),
    profiles: Object.values(PROFILES),
    config: s.transcription.config()
  }))
  reg(ctx, 'transcription', 'hardware', [v.optional(v.boolean())], (refresh) => s.transcription.hardware(!!refresh))
  reg(ctx, 'transcription', 'plan', [], () => s.transcription.plan())

  // ---------- models ----------
  const MODEL_ID = v.string({ min: 1, max: 60 })
  reg(ctx, 'models', 'list', [], () => s.transcription.listModels())
  reg(ctx, 'models', 'download', [MODEL_ID], (id) => s.transcription.models.download(id as string))
  reg(ctx, 'models', 'cancel', [MODEL_ID], (id) => s.transcription.models.cancel(id as string))
  reg(ctx, 'models', 'remove', [MODEL_ID], (id) => s.transcription.models.remove(id as string))
  reg(ctx, 'models', 'verify', [MODEL_ID], (id) => s.transcription.models.verify(id as string))
  reg(ctx, 'models', 'importFile', [MODEL_ID], async (id) => {
    const res = await dialog.showOpenDialog(ctx.mainWindow!, { title: 'Choose the model file', filters: [{ name: 'ggml model', extensions: ['bin'] }], properties: ['openFile'] })
    if (res.canceled || !res.filePaths[0]) return null
    await s.transcription.models.importFromFile(res.filePaths[0], id as string)
    return s.transcription.listModels().find((m) => m.id === id) ?? null
  })
  reg(ctx, 'models', 'storage', [], () => s.transcription.models.storageUsage())
  reg(ctx, 'models', 'openFolder', [], () => shell.openPath(s.transcription.models.storageUsage().modelsPath))

  // ---------- jobs ----------
  reg(ctx, 'jobs', 'list', [], () => s.transcription.listJobs())
  reg(ctx, 'jobs', 'enqueueRecording', [ID, ID], (noteId, recId) => s.transcription.enqueueRecording(noteId as string, recId as string))
  reg(ctx, 'jobs', 'pause', [ID], (id) => s.transcription.pauseJob(id as string))
  reg(ctx, 'jobs', 'resume', [ID], (id) => s.transcription.resumeJob(id as string))
  reg(ctx, 'jobs', 'cancel', [ID], (id) => s.transcription.cancelJob(id as string))
  reg(ctx, 'jobs', 'retry', [ID], (id) => s.transcription.retryJob(id as string))
  reg(ctx, 'jobs', 'remove', [ID], (id) => s.transcription.removeJob(id as string))

  // ---------- calendar ----------
  reg(ctx, 'calendar', 'listSources', [], () => s.calendar.listSources())
  reg(ctx, 'calendar', 'addIcsUrl', [v.string({ max: 100 }), v.string({ min: 8, max: 2000 })], (label, url) => s.calendar.addIcsUrl(label as string, url as string))
  reg(ctx, 'calendar', 'addIcsFile', [], () => s.calendar.addIcsFile())
  reg(ctx, 'calendar', 'removeSource', [ID], (id) => s.calendar.removeSource(id as string))
  reg(ctx, 'calendar', 'refresh', [v.optional(ID)], (id) => s.calendar.refresh(id as string | undefined))
  reg(ctx, 'calendar', 'upcoming', [v.number({ int: true, min: 1, max: 90 })], (days) => s.calendar.upcoming(days as number))
  reg(ctx, 'calendar', 'createNoteForEvent', [ID], (id) => s.calendar.createNoteForEvent(id as string))

  // ---------- exports ----------
  reg(ctx, 'exports', 'noteMarkdown', [ID], (id) => s.exports.noteMarkdown(id as string))
  reg(ctx, 'exports', 'noteText', [ID], (id) => s.exports.noteText(id as string))
  reg(ctx, 'exports', 'transcript', [ID, v.literal(['txt', 'srt', 'vtt', 'md'] as const)], (id, f) => s.exports.transcript(id as string, f as never))
  reg(ctx, 'exports', 'allNotesMarkdown', [], () => s.exports.allNotesMarkdown())
  reg(ctx, 'exports', 'render', [ID, v.literal(['md', 'txt'] as const)], (id, f) => s.exports.render(id as string, f as never))
  reg(ctx, 'exports', 'openExportsFolder', [], () => s.exports.openExportsFolder())

  // ---------- backup ----------
  reg(ctx, 'backup', 'create', [], () => s.backup.create())
  reg(ctx, 'backup', 'list', [], () => s.backup.list())
  reg(ctx, 'backup', 'restore', [v.optional(v.string({ max: 2000 }))], (p) => s.backup.restore(p as string | undefined))
  reg(ctx, 'backup', 'openBackupsFolder', [], () => s.backup.openBackupsFolder())
  reg(ctx, 'backup', 'storageInfo', [], () => s.backup.storageInfo())

  // ---------- settings ----------
  reg(ctx, 'settings', 'get', [], () => ctx.settings.get())
  reg(ctx, 'settings', 'set', [settingsPatch], (patch) => {
    const before = ctx.settings.get()
    const next = ctx.settings.set(patch as never)
    const p = patch as Partial<typeof next>
    if (p.shortcuts) s.shortcuts.apply()
    const loginChanged = p.launchAtLogin !== undefined && p.launchAtLogin !== before.launchAtLogin
    const minimizedChanged = p.startMinimized !== undefined && p.startMinimized !== before.startMinimized && next.launchAtLogin
    if (loginChanged || minimizedChanged) {
      app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, args: next.startMinimized ? ['--hidden'] : [] })
    }
    if (p.updates?.checkAutomatically !== undefined) s.updater.startBackgroundChecks()
    return next
  })
  reg(ctx, 'settings', 'reset', [], () => {
    const next = ctx.settings.reset()
    s.shortcuts.apply()
    app.setLoginItemSettings({ openAtLogin: false })
    return next
  })
  reg(ctx, 'settings', 'shortcutDefinitions', [], () => SHORTCUT_DEFINITIONS)
  reg(ctx, 'settings', 'diagnostics', [], () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    osVersion: process.getSystemVersion(),
    sqliteVersion: ctx.db.sqliteVersion(),
    userDataPath: ctx.paths.userData,
    uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
    migrations: ctx.db.migrations()
  }))
  reg(ctx, 'settings', 'openLogsFolder', [], () => shell.openPath(ctx.paths.logs))
  reg(ctx, 'settings', 'openDataFolder', [], () => shell.openPath(ctx.paths.userData))
  reg(ctx, 'settings', 'exportDiagnostics', [], async () => {
    const res = await dialog.showSaveDialog(ctx.mainWindow!, {
      defaultPath: join(app.getPath('documents'), 'minutes-diagnostics.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, path: null, cancelled: true, error: null }
    const diag = {
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      osVersion: process.getSystemVersion(),
      storage: s.backup.storageInfo(),
      settings: { ...ctx.settings.get(), recentSearches: '[omitted]' },
      windowsSpeech: await SapiEngine.probe(),
      transcription: {
        config: s.transcription.config(),
        engine: s.transcription.engineStatus(),
        hardware: s.transcription.hardware(),
        plan: s.transcription.plan(),
        models: s.transcription.listModels().map((m) => ({ id: m.id, state: m.state, eligible: m.eligibility.eligible })),
        jobs: s.transcription.listJobs()
      },
      recording: s.recording.getState()
    }
    writeFileSync(res.filePath, JSON.stringify(diag, null, 2))
    return { ok: true, path: res.filePath, cancelled: false, error: null }
  })

  // ---------- updates ----------
  reg(ctx, 'updates', 'getState', [], () => s.updater.getState())
  reg(ctx, 'updates', 'check', [], () => s.updater.check())
  reg(ctx, 'updates', 'download', [], () => s.updater.download())
  reg(ctx, 'updates', 'install', [], () => s.updater.install())

  // ---------- app ----------
  reg(ctx, 'app', 'version', [], () => app.getVersion())
  reg(ctx, 'app', 'platform', [], () => process.platform)
  reg(ctx, 'app', 'openExternal', [v.string({ max: 2000 })], async (url) => {
    const u = url as string
    if (!/^https?:\/\//i.test(u) && !/^mailto:/i.test(u)) return false
    await shell.openExternal(u)
    return true
  })
  reg(ctx, 'app', 'isMaximized', [], () => !!ctx.mainWindow?.isMaximized())
  reg(
    ctx,
    'app',
    'confirm',
    [v.object({ title: v.string({ max: 200 }), message: v.string({ max: 500 }), detail: v.optional(v.string({ max: 2000 })), confirmLabel: v.string({ max: 60 }), destructive: v.optional(v.boolean()) })],
    async (raw) => {
      const o = raw as { title: string; message: string; detail?: string; confirmLabel: string; destructive?: boolean }
      const { response } = await dialog.showMessageBox(ctx.mainWindow!, {
        type: o.destructive ? 'warning' : 'question',
        title: o.title,
        message: o.message,
        detail: o.detail,
        buttons: [o.confirmLabel, 'Cancel'],
        defaultId: o.destructive ? 1 : 0,
        cancelId: 1,
        noLink: true
      })
      return response === 0
    }
  )
  for (const m of ['minimize', 'toggleMaximize', 'close'] as const) {
    ipcMain.on(channel('app', m), (event) => {
      if (!isTrustedSender(event.senderFrame?.url ?? '')) return
      const w = BrowserWindow.fromWebContents(event.sender)
      if (!w) return
      if (m === 'minimize') w.minimize()
      else if (m === 'close') w.close()
      else w.isMaximized() ? w.unmaximize() : w.maximize()
    })
  }
}
