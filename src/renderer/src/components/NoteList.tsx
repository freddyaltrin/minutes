import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, Copy, FolderInput, Mic, PanelLeftOpen, Pin, Plus, RotateCcw, Star, Trash2, Archive, ArchiveRestore } from 'lucide-react'
import s from './layout.module.css'
import { Button, EmptyState, IconButton, Menu, type MenuItem } from './ui'
import { useApp, store } from '@renderer/state/app-store'
import { archiveNote, createNote, destroyNote, duplicateNote, refreshList, restoreNote, selectNote, setNoteFlags, setView, trashNote, updateSettings } from '@renderer/state/actions'
import { attendeeSummary, dayGroupLabel, formatTime, startOfDay } from '@renderer/lib/format'
import type { NoteSummary, SortKey } from '@shared/types'

const VIEW_TITLES: Record<string, string> = { recent: 'Recent', all: 'All notes', favorites: 'Favorites', archived: 'Archive', trash: 'Trash', folder: 'Folder', tag: 'Tag' }

function rowDate(n: NoteSummary, view: string): number {
  if (view === 'trash' && n.deletedAt) return n.deletedAt
  return n.meetingAt ?? n.createdAt
}

export function NoteList(): JSX.Element {
  const notes = useApp((st) => st.notes)
  const loading = useApp((st) => st.notesLoading)
  const view = useApp((st) => st.view)
  const folderId = useApp((st) => st.folderId)
  const tagId = useApp((st) => st.tagId)
  const folders = useApp((st) => st.folders)
  const tags = useApp((st) => st.tags)
  const selectedId = useApp((st) => st.selectedId)
  const collapsed = useApp((st) => st.settings.sidebarCollapsed)
  const recording = useApp((st) => st.recording)
  const shortcuts = useApp((st) => st.settings.shortcuts)
  const [sort, setSort] = useState<SortKey>('meeting')
  const [menu, setMenu] = useState<{ items: MenuItem[]; anchor: { x: number; y: number } | DOMRect; align?: 'left' | 'right' } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const scrollRef = useRef<HTMLDivElement>(null)

  const title = view === 'folder' ? folders.find((f) => f.id === folderId)?.name ?? 'Folder' : view === 'tag' ? `#${tags.find((t) => t.id === tagId)?.name ?? ''}` : VIEW_TITLES[view]

  const sorted = useMemo(() => {
    const arr = [...notes]
    const key = (n: NoteSummary): number | string =>
      sort === 'title' ? n.title.toLowerCase() : sort === 'created' ? n.createdAt : sort === 'updated' ? n.updatedAt : rowDate(n, view)
    arr.sort((a, b) => {
      if (view !== 'trash' && a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ka = key(a)
      const kb = key(b)
      if (typeof ka === 'string' && typeof kb === 'string') return ka.localeCompare(kb)
      return (kb as number) - (ka as number)
    })
    return arr
  }, [notes, sort, view])

  const groups = useMemo(() => {
    const out: { label: string; notes: NoteSummary[] }[] = []
    if (sort === 'title') return [{ label: '', notes: sorted }]
    for (const n of sorted) {
      const label = view !== 'trash' && n.pinned ? 'Pinned' : dayGroupLabel(rowDate(n, view))
      const last = out[out.length - 1]
      if (last && last.label === label) last.notes.push(n)
      else out.push({ label, notes: [n] })
    }
    return out
  }, [sorted, sort, view])

  // Keep the selected row visible when selection changes via keyboard.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const contextMenu = (e: React.MouseEvent, n: NoteSummary): void => {
    e.preventDefault()
    const items: MenuItem[] = []
    if (view === 'trash') {
      items.push({ id: 'restore', label: 'Restore', icon: <RotateCcw size={14} />, onSelect: () => void restoreNote(n.id) })
      items.push({ id: 'destroy', label: 'Delete permanently', icon: <Trash2 size={14} />, danger: true, onSelect: () => void destroyNote(n.id) })
    } else {
      items.push({ id: 'pin', label: n.pinned ? 'Unpin' : 'Pin to top', icon: <Pin size={14} />, onSelect: () => void setNoteFlags(n.id, { pinned: !n.pinned }) })
      items.push({ id: 'fav', label: n.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Star size={14} />, shortcut: shortcuts['note.favorite'], onSelect: () => void setNoteFlags(n.id, { favorite: !n.favorite }) })
      items.push({ id: 'dup', label: 'Duplicate', icon: <Copy size={14} />, shortcut: shortcuts['note.duplicate'], onSelect: () => void duplicateNote(n.id) })
      items.push({ id: 'sep1', label: '', separator: true })
      items.push({ id: 'fh', label: 'Move to folder', heading: true })
      items.push({ id: 'f-none', label: 'No folder', icon: <FolderInput size={14} />, checked: !n.folderId, onSelect: () => void setNoteFlags(n.id, { folderId: null }) })
      for (const f of folders) items.push({ id: `f-${f.id}`, label: f.name, icon: <FolderInput size={14} />, checked: n.folderId === f.id, onSelect: () => void setNoteFlags(n.id, { folderId: f.id }) })
      items.push({ id: 'sep2', label: '', separator: true })
      items.push({ id: 'arch', label: n.archived ? 'Unarchive' : 'Archive', icon: n.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />, onSelect: () => void archiveNote(n.id, !n.archived) })
      items.push({ id: 'trash', label: 'Move to trash', icon: <Trash2 size={14} />, danger: true, shortcut: shortcuts['note.trash'], onSelect: () => void trashNote(n.id) })
    }
    setMenu({ items, anchor: { x: e.clientX, y: e.clientY } })
  }

  const sortMenu = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const opt = (id: SortKey, label: string): MenuItem => ({ id, label, checked: sort === id, onSelect: () => setSort(id) })
    const items: MenuItem[] = [
      { id: 'h', label: 'Sort by', heading: true },
      opt('meeting', 'Meeting date'),
      opt('updated', 'Last edited'),
      opt('created', 'Created'),
      opt('title', 'Title')
    ]
    if (view === 'trash' && notes.length > 0) {
      items.push({ id: 'sep', label: '', separator: true })
      items.push({
        id: 'empty',
        label: 'Empty trash',
        danger: true,
        onSelect: async () => {
          const ok = await window.minutes.app.confirm({ title: 'Empty trash', message: `Permanently delete ${notes.length} note${notes.length === 1 ? '' : 's'}?`, detail: 'This cannot be undone.', confirmLabel: 'Empty trash', destructive: true })
          if (!ok) return
          await window.minutes.notes.emptyTrash()
          await refreshList()
          await selectNote(null)
        }
      })
    }
    setMenu({ items, anchor: r, align: 'right' })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const idx = sorted.findIndex((n) => n.id === selectedId)
      const next = sorted[Math.max(0, Math.min(sorted.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) void selectNote(next.id)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const n = sorted.find((x) => x.id === selectedId)
      if (n && view !== 'trash') void trashNote(n.id)
    } else if (e.key === 'Enter') {
      ;(document.querySelector('.ProseMirror') as HTMLElement | null)?.focus()
    }
  }

  const empty = (): JSX.Element => {
    switch (view) {
      case 'trash':
        return <EmptyState title="Trash is empty" body="Notes you delete stay here for 30 days before they are removed." />
      case 'archived':
        return <EmptyState title="Nothing archived" body="Archive notes you are done with to keep your lists short. They stay searchable." />
      case 'favorites':
        return <EmptyState title="No favorites yet" body="Mark a note as a favorite from its menu, or press the star in the note header." />
      case 'folder':
        return <EmptyState title="This folder is empty" body="Create a note here, or move existing notes in from their menu." action={<Button variant="outline" onClick={() => void createNote()}>New note in folder</Button>} />
      case 'tag':
        return <EmptyState title="No notes with this tag" />
      case 'recent':
        if (store.get().counts.all > 0)
          return <EmptyState title="Nothing in the last 30 days" body="Older notes are under All notes." action={<Button variant="outline" onClick={() => void setView('all')}>Show all notes</Button>} />
        return <EmptyState title="No notes yet" />
      default:
        // The welcome panel beside the list already explains the app and offers the first action.
        return <EmptyState title="No notes yet" />
    }
  }

  return (
    <div className={s.list} onKeyDown={onKeyDown}>
      <div className={s.listHeader}>
        {collapsed && (
          <IconButton label="Show sidebar" shortcut={shortcuts['nav.sidebar']} size="sm" onClick={() => void updateSettings({ sidebarCollapsed: false })}>
            <PanelLeftOpen size={15} />
          </IconButton>
        )}
        <span className={s.listTitle}>{title}</span>
        <IconButton label="Sort" size="sm" onClick={sortMenu}>
          <ArrowUpDown size={14} />
        </IconButton>
        {view !== 'trash' && (
          <IconButton label="New note" shortcut={shortcuts['note.new']} size="sm" onClick={() => void createNote()}>
            <Plus size={16} />
          </IconButton>
        )}
      </div>
      <div ref={scrollRef} className={s.listScroll} role="listbox" aria-label={title} tabIndex={0}>
        {!loading && notes.length === 0 && empty()}
        {groups.map((g) => (
          <div key={g.label || 'all'}>
            {g.label && <div className={s.groupLabel}>{g.label}</div>}
            {g.notes.map((n) => {
              const isRec = recording.noteId === n.id && (recording.status === 'recording' || recording.status === 'paused')
              const date = rowDate(n, view)
              const sub = [n.attendees.length ? attendeeSummary(n.attendees) : '', n.preview].filter(Boolean)[0] ?? ''
              return (
                <div
                  key={n.id}
                  data-id={n.id}
                  role="option"
                  aria-selected={n.id === selectedId}
                  className={s.noteRow}
                  onClick={() => void selectNote(n.id)}
                  onContextMenu={(e) => contextMenu(e, n)}
                >
                  <div className={s.noteRowTop}>
                    {isRec && <span className={s.recDot} aria-label="Recording" />}
                    <span className={s.noteTitle} data-empty={!n.title ? 'true' : undefined}>
                      {n.title || 'Untitled'}
                    </span>
                    <span className={s.noteTime}>{startOfDay(date) === startOfDay(Date.now()) || n.meetingAt ? formatTime(date) : ''}</span>
                  </div>
                  <div className={s.noteSub}>
                    <span>{sub || <span style={{ color: 'var(--fg-faint)' }}>No content</span>}</span>
                    <span style={{ flex: 1 }} />
                    <span className={s.noteIcons}>
                      {n.favorite && <Star size={12} />}
                      {n.hasTranscript && <Mic size={12} />}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {menu && <Menu items={menu.items} anchor={menu.anchor} align={menu.align} onClose={closeMenu} />}
    </div>
  )
}
