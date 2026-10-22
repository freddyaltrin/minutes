import { store, type AppState, type Overlay, type Panel, type Toast, type View } from './app-store'
import type { Note, NoteId, Settings } from '@shared/types'
import type { NoteUpdateInput } from '@shared/api'
import { AUTOSAVE_DEBOUNCE_MS, UNDO_WINDOW_MS } from '@shared/defaults'

const api = (): typeof window.minutes => window.minutes

// ---------- theme ----------
const mq = window.matchMedia('(prefers-color-scheme: dark)')
export function applyTheme(settings: Settings): void {
  const theme = settings.theme === 'system' ? (mq.matches ? 'dark' : 'light') : settings.theme
  document.documentElement.dataset.theme = theme
  document.documentElement.style.setProperty('--editor-font-size', `${settings.editorFontSize}px`)
  document.documentElement.style.setProperty('--sidebar-w', `${settings.sidebarWidth}px`)
  store.set({ theme })
}
mq.addEventListener('change', () => applyTheme(store.get().settings))

// ---------- toasts ----------
let toastSeq = 0
export function toast(message: string, opts: { kind?: Toast['kind']; action?: Toast['action']; durationMs?: number } = {}): string {
  const id = `t${++toastSeq}`
  const t: Toast = { id, message, kind: opts.kind ?? 'info', action: opts.action, expiresAt: Date.now() + (opts.durationMs ?? 4000) }
  store.set((s) => ({ toasts: [...s.toasts.filter((x) => x.message !== message), t] }))
  setTimeout(() => dismissToast(id), opts.durationMs ?? 4000)
  return id
}
export function dismissToast(id: string): void {
  store.set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : {}))
}

// ---------- settings ----------
export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const next = await api().settings.set(patch)
  store.set({ settings: next })
  applyTheme(next)
}

/**
 * Changes the transcription configuration through the transcription service (which re-plans and
 * re-emits model eligibility) and mirrors the result into the settings slice of the store.
 */
export async function updateTranscription(patch: Partial<Settings['transcription']>): Promise<boolean> {
  try {
    const next = await api().transcription.setConfig(patch)
    store.set((s) => ({ settings: { ...s.settings, transcription: next } }))
    return true
  } catch (err) {
    toast(`Could not change transcription settings: ${(err as Error).message}`, { kind: 'error' })
    return false
  }
}

// ---------- notes list ----------
let listRequest = 0
export async function refreshList(): Promise<void> {
  const { view, folderId, tagId } = store.get()
  const req = ++listRequest
  const [notes, counts] = await Promise.all([
    api().notes.list({ view, folderId: folderId ?? undefined, tagId: tagId ?? undefined, limit: 2000 }),
    api().notes.counts()
  ])
  if (req !== listRequest) return
  store.set({ notes, counts, notesLoading: false })
}

export async function refreshSidebar(): Promise<void> {
  const [folders, tags] = await Promise.all([api().folders.list(), api().tags.list()])
  store.set({ folders, tags })
}

export async function setView(view: View, opts: { folderId?: string | null; tagId?: string | null } = {}): Promise<void> {
  store.set({ view, folderId: opts.folderId ?? null, tagId: opts.tagId ?? null, notesLoading: true })
  await refreshList()
  // Keep the selection if it is still in the list; otherwise select the first note.
  const { notes, selectedId } = store.get()
  if (!notes.some((n) => n.id === selectedId)) await selectNote(notes[0]?.id ?? null)
}

// ---------- selection & loading ----------
export async function selectNote(id: NoteId | null, opts: { panel?: Panel; jumpToSegment?: string | null } = {}): Promise<void> {
  await flushSave()
  if (!id) {
    store.set({ selectedId: null, current: null, saveState: 'saved', jumpToSegment: null })
    return
  }
  const note = await api().notes.get(id)
  if (!note) {
    store.set({ selectedId: null, current: null })
    return
  }
  store.set({
    selectedId: id,
    current: note,
    saveState: 'saved',
    lastSavedAt: note.updatedAt,
    jumpToSegment: opts.jumpToSegment ?? null,
    ...(opts.panel ? { panel: opts.panel } : {})
  })
  void updateSettings({ lastNoteId: id })
}

/** Ensures the note is visible in the list (switches view if needed) and selects it. */
export async function openNote(id: NoteId, opts: { panel?: Panel; jumpToSegment?: string | null } = {}): Promise<void> {
  const s = store.get()
  if (!s.notes.some((n) => n.id === id)) {
    const note = await api().notes.get(id)
    if (!note) return
    const view: View = note.deletedAt ? 'trash' : note.archived ? 'archived' : 'all'
    store.set({ view, folderId: null, tagId: null })
    await refreshList()
  }
  await selectNote(id, opts)
}

// ---------- autosave ----------
type PatchSource = NoteUpdateInput | (() => NoteUpdateInput)
interface PendingSave {
  id: NoteId
  /** Plain patches merge immediately; lazy patches (editor content) are evaluated once at flush time. */
  patches: PatchSource[]
  timer: ReturnType<typeof setTimeout> | null
}
let pending: PendingSave | null = null
let saving: Promise<void> | null = null

function materialize(p: PendingSave): NoteUpdateInput {
  let out: NoteUpdateInput = {}
  for (const src of p.patches) out = { ...out, ...(typeof src === 'function' ? src() : src) }
  return out
}

/** Queues a content change; coalesces rapid edits and persists after a short pause. */
export function queueSave(id: NoteId, patch: PatchSource): void {
  if (pending && pending.id !== id) void flushSave()
  if (pending && pending.timer) clearTimeout(pending.timer)
  const patches = pending?.id === id ? pending.patches : []
  // A newer lazy editor patch supersedes an older one; plain patches are kept and merged in order.
  if (typeof patch === 'function') {
    const idx = patches.findIndex((x) => typeof x === 'function')
    if (idx >= 0) patches.splice(idx, 1)
  }
  patches.push(patch)
  pending = { id, patches, timer: null }
  store.set({ saveState: 'dirty' })
  pending.timer = setTimeout(() => void flushSave(), AUTOSAVE_DEBOUNCE_MS)
}

export async function flushSave(): Promise<void> {
  if (saving) await saving
  if (!pending) return
  const { id, timer } = pending
  if (timer) clearTimeout(timer)
  const patch = materialize(pending)
  pending = null
  if (Object.keys(patch).length === 0) {
    store.set({ saveState: 'saved' })
    return
  }
  store.set({ saveState: 'saving' })
  saving = (async () => {
    try {
      const updated = await api().notes.update(id, patch)
      store.set((s) => ({
        saveState: pending ? 'dirty' : 'saved',
        lastSavedAt: updated.updatedAt,
        current: s.current?.id === id ? { ...s.current, ...updated, bodyJson: patch.bodyJson ?? s.current.bodyJson, bodyText: patch.bodyText ?? s.current.bodyText } : s.current
      }))
      if (patch.bodyText !== undefined || patch.title !== undefined) {
        const cur = store.get().current
        if (cur && cur.id === id) {
          store.set((s) => ({
            notes: s.notes.map((n) => (n.id === id ? { ...n, title: cur.title, preview: cur.bodyText.replace(/\s+/g, ' ').trim().slice(0, 160), updatedAt: updated.updatedAt } : n))
          }))
        }
      }
    } catch (err) {
      store.set({ saveState: 'error' })
      toast(`Could not save: ${(err as Error).message}`, { kind: 'error', durationMs: 8000 })
      // Re-queue so the edit is not lost.
      pending = { id, patches: [patch], timer: setTimeout(() => void flushSave(), 5000) }
    } finally {
      saving = null
    }
  })()
  await saving
}

window.addEventListener('beforeunload', () => {
  if (pending) {
    // Best effort: IPC invoke is async but the main process keeps running long enough to persist.
    const { id } = pending
    const patch = materialize(pending)
    pending = null
    if (Object.keys(patch).length) void api().notes.update(id, patch)
  }
})

/** Local-only update of the current note (used after title/body edits so the UI reflects it immediately). */
export function patchCurrent(patch: Partial<Note>): void {
  store.set((s) => (s.current ? { current: { ...s.current, ...patch } } : {}))
  const cur = store.get().current
  if (!cur) return
  // keep the list row in sync without reloading
  store.set((s) => ({
    notes: s.notes.map((n) =>
      n.id === cur.id
        ? { ...n, title: cur.title, preview: cur.bodyText.replace(/\s+/g, ' ').trim().slice(0, 160), pinned: cur.pinned, favorite: cur.favorite, archived: cur.archived }
        : n
    )
  }))
}

// ---------- note mutations ----------
export async function createNote(input: { title?: string; folderId?: string | null } = {}): Promise<Note> {
  await flushSave()
  const s = store.get()
  const folderId = input.folderId !== undefined ? input.folderId : s.view === 'folder' ? s.folderId : null
  const note = await api().notes.create({ title: input.title ?? '', folderId })
  if (s.view === 'trash' || s.view === 'archived' || s.view === 'favorites' || (s.view === 'tag' && s.tagId)) {
    store.set({ view: folderId ? 'folder' : 'all', folderId, tagId: null })
  }
  await refreshList()
  await selectNote(note.id)
  return note
}

export async function setNoteFlags(id: NoteId, patch: Pick<NoteUpdateInput, 'pinned' | 'favorite' | 'archived' | 'folderId'>): Promise<void> {
  await api().notes.update(id, patch)
  if (store.get().current?.id === id) patchCurrent(patch as Partial<Note>)
  await refreshList()
  await refreshSidebar()
}

export async function trashNote(id: NoteId): Promise<void> {
  await flushSave()
  const s = store.get()
  const idx = s.notes.findIndex((n) => n.id === id)
  const full = s.notes[idx]?.title || 'Untitled note'
  const title = full.length > 48 ? full.slice(0, 47).trimEnd() + '…' : full
  await api().notes.trash(id)
  await refreshList()
  if (s.selectedId === id) {
    const next = store.get().notes[Math.min(idx, store.get().notes.length - 1)]
    await selectNote(next?.id ?? null)
  }
  toast(`“${title}” moved to trash`, {
    durationMs: UNDO_WINDOW_MS,
    action: {
      label: 'Undo',
      onClick: async () => {
        await api().notes.restore(id)
        await refreshList()
        await selectNote(id)
      }
    }
  })
}

export async function archiveNote(id: NoteId, archived: boolean): Promise<void> {
  await flushSave()
  const s = store.get()
  const idx = s.notes.findIndex((n) => n.id === id)
  await api().notes.update(id, { archived })
  await refreshList()
  if (s.selectedId === id && s.view !== 'archived' && s.view !== 'all') {
    const next = store.get().notes[Math.min(idx, store.get().notes.length - 1)]
    await selectNote(next?.id ?? null)
  } else if (s.selectedId === id) {
    if (store.get().notes.some((n) => n.id === id)) patchCurrent({ archived })
    else {
      const next = store.get().notes[Math.min(idx, store.get().notes.length - 1)]
      await selectNote(next?.id ?? null)
    }
  }
  if (archived) {
    toast('Note archived', {
      durationMs: UNDO_WINDOW_MS,
      action: { label: 'Undo', onClick: () => void archiveNote(id, false) }
    })
  }
}

export async function restoreNote(id: NoteId): Promise<void> {
  await api().notes.restore(id)
  await refreshList()
  const s = store.get()
  if (s.selectedId === id && !s.notes.some((n) => n.id === id)) await selectNote(s.notes[0]?.id ?? null)
}

export async function destroyNote(id: NoteId): Promise<void> {
  const ok = await api().app.confirm({
    title: 'Delete permanently',
    message: 'Delete this note permanently?',
    detail: 'The note, its transcript and any saved recordings will be removed. This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true
  })
  if (!ok) return
  const s = store.get()
  const idx = s.notes.findIndex((n) => n.id === id)
  await api().notes.destroy(id)
  await refreshList()
  if (s.selectedId === id) {
    const next = store.get().notes[Math.min(idx, store.get().notes.length - 1)]
    await selectNote(next?.id ?? null)
  }
}

export async function duplicateNote(id: NoteId): Promise<void> {
  await flushSave()
  const n = await api().notes.duplicate(id)
  await refreshList()
  await selectNote(n.id)
}

// ---------- navigation ----------
export function setPanel(panel: Panel): void {
  store.set((s) => ({ panel: s.panel === panel ? 'none' : panel }))
}
export function setOverlay(overlay: Overlay, section?: string): void {
  store.set((s) => ({ overlay: s.overlay === overlay && !section ? 'none' : overlay, ...(section ? { settingsSection: section } : {}) }))
}
export async function selectAdjacent(delta: 1 | -1): Promise<void> {
  const { notes, selectedId } = store.get()
  if (notes.length === 0) return
  const idx = notes.findIndex((n) => n.id === selectedId)
  const next = idx < 0 ? 0 : Math.max(0, Math.min(notes.length - 1, idx + delta))
  await selectNote(notes[next].id)
}

// ---------- bootstrap ----------
export async function bootstrap(): Promise<void> {
  const [settings, recording, platform] = await Promise.all([api().settings.get(), api().recording.getState(), api().app.platform()])
  store.set({ settings, recording, platform, view: settings.defaultView })
  applyTheme(settings)
  await Promise.all([refreshList(), refreshSidebar()])
  const { notes } = store.get()
  const initial = settings.lastNoteId && notes.some((n) => n.id === settings.lastNoteId) ? settings.lastNoteId : notes[0]?.id ?? null
  await selectNote(initial)
  store.set({ ready: true })
  void api().transcription.engineInfo().then((engineInfo) => store.set({ engineInfo }))
  void api().updates.getState().then((update) => store.set({ update }))
  void api().calendar.upcoming(7).then((upcoming) => store.set({ upcoming }))
  void api().app.isMaximized().then((windowMaximized) => store.set({ windowMaximized }))

  const m = api()
  m.on.notesChanged(() => {
    void refreshList()
    void refreshSidebar()
    const cur = store.get().current
    if (cur) {
      // Keep metadata (transcript id, updatedAt) fresh without clobbering in-progress edits.
      void m.notes.get(cur.id).then((fresh) => {
        if (!fresh) return
        store.set((s) =>
          s.current?.id === fresh.id
            ? { current: { ...fresh, bodyJson: s.current.bodyJson, bodyText: s.current.bodyText, title: s.saveState === 'saved' ? fresh.title : s.current.title } }
            : {}
        )
      })
    }
  })
  m.on.recordingState((recording) => store.set({ recording }))
  m.on.updateState((update) => store.set({ update }))
  m.on.windowState(({ maximized, focused }) => store.set({ windowMaximized: maximized, windowFocused: focused }))
  m.on.calendarChanged(() => void m.calendar.upcoming(7).then((upcoming) => store.set({ upcoming })))
  m.on.log(({ level, message }) => toast(message, { kind: level === 'error' ? 'error' : 'info' }))
}

export type { AppState }
