import { useEffect, useRef, useState } from 'react'
import s from './components/layout.module.css'
import { Sidebar } from './components/Sidebar'
import { NoteList } from './components/NoteList'
import { NoteView } from './components/NoteView'
import { ToastHost } from './components/ui'
import { SearchPalette } from './components/SearchPalette'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { ShortcutsDialog, AboutDialog } from './components/HelpDialogs'
import { store, useApp } from './state/app-store'
import { bootstrap, createNote, dismissToast, duplicateNote, flushSave, selectAdjacent, setNoteFlags, setOverlay, setPanel, trashNote, updateSettings } from './state/actions'
import { bus } from './lib/bus'
import { keyToAccelerator, normalizeAccelerator } from '@shared/accelerators'
import { SHORTCUT_DEFINITIONS } from '@shared/defaults'

function runShortcut(id: string): void {
  {
    {
      const st = store.get()
      const cur = st.current
      switch (id) {
        case 'note.new':
          void createNote()
          break
        case 'note.save':
          void flushSave()
          break
        case 'note.duplicate':
          if (cur && !cur.deletedAt) void duplicateNote(cur.id)
          break
        case 'note.trash':
          if (cur && !cur.deletedAt) void trashNote(cur.id)
          break
        case 'note.favorite':
          if (cur && !cur.deletedAt) void setNoteFlags(cur.id, { favorite: !cur.favorite })
          break
        case 'note.find':
          if (cur) store.set({ findInNote: true })
          break
        case 'note.export':
          if (cur) bus.emit('note.export')
          break
        case 'nav.search':
          setOverlay('search')
          break
        case 'nav.ask':
          setOverlay('ask')
          break
        case 'nav.sidebar':
          void updateSettings({ sidebarCollapsed: !st.settings.sidebarCollapsed })
          break
        case 'nav.transcript':
          if (cur) setPanel('transcript')
          break
        case 'nav.next':
          void selectAdjacent(1)
          break
        case 'nav.prev':
          void selectAdjacent(-1)
          break
        case 'nav.settings':
          setOverlay('settings')
          break
        case 'help.shortcuts':
          setOverlay('shortcuts')
          break
        case 'help.about':
          setOverlay('about')
          break
        case 'help.updates':
          setOverlay('settings', 'updates')
          break
        default:
          bus.emit(id)
      }
    }
  }
}

function useShortcutRouter(): void {
  useEffect(() => {
    const off = window.minutes.on.shortcut((id) => runShortcut(id))
    // Fallback for key events that bypass the main process pre-handler (e.g. synthetic input).
    // Real key presses are consumed by main's before-input-event and never reach this listener.
    const onKey = (e: KeyboardEvent): void => {
      const acc = keyToAccelerator({ key: e.key, code: e.code, control: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey })
      if (!acc) return
      const platform = store.get().platform
      const shortcuts = store.get().settings.shortcuts
      for (const def of SHORTCUT_DEFINITIONS) {
        if (def.scope !== 'app') continue
        const a = shortcuts[def.id] ?? def.default
        if (a && normalizeAccelerator(a, platform) === acc) {
          e.preventDefault()
          runShortcut(def.id)
          return
        }
      }
    }
    window.addEventListener('keydown', onKey)
    const offCmd = window.minutes.on.captureCommand((p) => bus.emit('captureCommand', p))
    return () => {
      off()
      offCmd()
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Escape closes overlays / panels / find bar in priority order.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const st = store.get()
      if (st.overlay !== 'none') {
        store.set({ overlay: 'none' })
        e.preventDefault()
      } else if (st.findInNote) {
        store.set({ findInNote: false })
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}

function SidebarResizer(): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; w: number } | null>(null)
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent): void => {
      if (!start.current) return
      const w = Math.max(200, Math.min(400, start.current.w + (e.clientX - start.current.x)))
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
    }
    const onUp = (): void => {
      setDragging(false)
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10)
      if (w) void updateSettings({ sidebarWidth: w })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragging])
  return (
    <div
      className={s.resizeHandle}
      data-dragging={dragging ? 'true' : undefined}
      onMouseDown={(e) => {
        start.current = { x: e.clientX, w: store.get().settings.sidebarWidth }
        setDragging(true)
        e.preventDefault()
      }}
      onDoubleClick={() => void updateSettings({ sidebarWidth: 248 })}
    />
  )
}

export default function App(): JSX.Element {
  const ready = useApp((st) => st.ready)
  const collapsed = useApp((st) => st.settings.sidebarCollapsed)
  const overlay = useApp((st) => st.overlay)
  const toasts = useApp((st) => st.toasts)
  useShortcutRouter()
  useEffect(() => {
    void bootstrap()
  }, [])

  if (!ready) return <div className={s.app} />

  return (
    <div className={s.app} data-sidebar={collapsed ? 'collapsed' : 'open'}>
      <nav className={s.sidebar} aria-label="Navigation" aria-hidden={collapsed}>
        <Sidebar />
        {!collapsed && <SidebarResizer />}
      </nav>
      <NoteList />
      <NoteView />
      {(overlay === 'search' || overlay === 'ask') && <SearchPalette mode={overlay} onClose={() => store.set({ overlay: 'none' })} />}
      {overlay === 'settings' && <SettingsDialog onClose={() => store.set({ overlay: 'none' })} />}
      {overlay === 'shortcuts' && <ShortcutsDialog onClose={() => store.set({ overlay: 'none' })} />}
      {overlay === 'about' && <AboutDialog onClose={() => store.set({ overlay: 'none' })} />}
      <ToastHost toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
