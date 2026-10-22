import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, Calendar, ChevronDown, ChevronRight, Clock, Folder as FolderIcon, Hash, Inbox, Plus, Search, Settings, Sparkles, Star, Trash2, PanelLeftClose } from 'lucide-react'
import s from './layout.module.css'
import { Logo } from './Logo'
import { IconButton, Menu, type MenuItem } from './ui'
import { store, useApp, type View } from '@renderer/state/app-store'
import { createNote, openNote, setOverlay, setView, refreshSidebar, toast, updateSettings } from '@renderer/state/actions'
import { formatShortcut, formatTime, dayGroupLabel } from '@renderer/lib/format'

function NavItem({ view, icon, label, count, folderId, tagId, shortcut, onContextMenu }: { view: View; icon: JSX.Element; label: string; count?: number; folderId?: string; tagId?: string; shortcut?: string; onContextMenu?: (e: React.MouseEvent) => void }): JSX.Element {
  const active = useApp((st) => st.view === view && (folderId ? st.folderId === folderId : true) && (tagId ? st.tagId === tagId : true))
  return (
    <button type="button" className={s.navItem} aria-current={active ? 'true' : undefined} onClick={() => void setView(view, { folderId, tagId })} onContextMenu={onContextMenu}>
      {icon}
      <span className={s.navLabel}>{label}</span>
      {shortcut ? <span className={s.navKbd}>{formatShortcut(shortcut)}</span> : null}
      {count !== undefined && count > 0 && <span className={s.navCount}>{count}</span>}
    </button>
  )
}

function InlineInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className={s.navInput}
      defaultValue={initial}
      placeholder="Folder name"
      onBlur={(e) => (e.target.value.trim() ? onCommit(e.target.value.trim()) : onCancel())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

export function Sidebar(): JSX.Element {
  const counts = useApp((st) => st.counts)
  const folders = useApp((st) => st.folders)
  const tags = useApp((st) => st.tags)
  const upcoming = useApp((st) => st.upcoming)
  const shortcuts = useApp((st) => st.settings.shortcuts)
  const [newFolder, setNewFolder] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [tagsOpen, setTagsOpen] = useState(true)
  const [menu, setMenu] = useState<{ items: MenuItem[]; anchor: { x: number; y: number } } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const folderMenu = (e: React.MouseEvent, id: string, name: string): void => {
    e.preventDefault()
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      items: [
        { id: 'new', label: 'New note in folder', onSelect: () => void createNote({ folderId: id }) },
        { id: 'rename', label: 'Rename', onSelect: () => setRenaming(id) },
        { id: 'sep', label: '', separator: true },
        {
          id: 'delete',
          label: 'Delete folder',
          danger: true,
          onSelect: async () => {
            const ok = await window.minutes.app.confirm({ title: 'Delete folder', message: `Delete the folder “${name}”?`, detail: 'Notes inside it are kept and moved out of the folder.', confirmLabel: 'Delete folder', destructive: true })
            if (!ok) return
            await window.minutes.folders.remove(id)
            if (store.get().folderId === id) await setView('all')
            await refreshSidebar()
          }
        }
      ]
    })
  }

  const tagMenu = (e: React.MouseEvent, id: string, name: string): void => {
    e.preventDefault()
    setMenu({
      anchor: { x: e.clientX, y: e.clientY },
      items: [
        {
          id: 'remove',
          label: `Remove tag “${name}” from all notes`,
          danger: true,
          onSelect: async () => {
            await window.minutes.tags.remove(id)
            if (store.get().tagId === id) await setView('all')
            await refreshSidebar()
          }
        }
      ]
    })
  }

  const soon = upcoming.filter((e) => e.endsAt > Date.now() - 2 * 3600_000).slice(0, 4)

  return (
    <div className={s.sidebarInner}>
      <div className={s.sidebarHeader}>
        <div className={s.brand}>
          <Logo size={18} variant="mark" />
          <span>Minutes</span>
        </div>
        <IconButton label="Hide sidebar" shortcut={shortcuts['nav.sidebar']} size="sm" onClick={() => void updateSettings({ sidebarCollapsed: true })}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>

      <div className={s.sidebarScroll}>
        <button type="button" className={s.navItem} onClick={() => void createNote()}>
          <Plus size={15} />
          <span className={s.navLabel}>New note</span>
          <span className={s.navKbd}>{formatShortcut(shortcuts['note.new'])}</span>
        </button>
        <button type="button" className={s.navItem} onClick={() => setOverlay('search')}>
          <Search size={15} />
          <span className={s.navLabel}>Search</span>
          <span className={s.navKbd}>{formatShortcut(shortcuts['nav.search'])}</span>
        </button>
        <button type="button" className={s.navItem} onClick={() => setOverlay('ask')}>
          <Sparkles size={15} />
          <span className={s.navLabel}>Ask your notes</span>
          <span className={s.navKbd}>{formatShortcut(shortcuts['nav.ask'])}</span>
        </button>

        {soon.length > 0 && (
          <div className={s.sidebarSection}>
            <div className={s.sidebarSectionHeader}>
              <span className={s.sidebarSectionTitle}>Upcoming</span>
            </div>
            {soon.map((ev) => (
              <button
                key={ev.id}
                type="button"
                className={s.upcomingEvent}
                onClick={async () => {
                  const note = await window.minutes.calendar.createNoteForEvent(ev.id)
                  await openNote(note.id)
                }}
              >
                <span className={s.upcomingTitle}>{ev.title}</span>
                <span className={s.upcomingMeta}>
                  {dayGroupLabel(ev.startsAt)} · {formatTime(ev.startsAt)}
                  {ev.noteId ? ' · note ready' : ''}
                </span>
              </button>
            ))}
          </div>
        )}

        <div className={s.sidebarSection}>
          <NavItem view="recent" icon={<Clock size={15} />} label="Recent" count={counts.recent} />
          <NavItem view="all" icon={<Inbox size={15} />} label="All notes" count={counts.all} />
          <NavItem view="favorites" icon={<Star size={15} />} label="Favorites" count={counts.favorites} />
        </div>

        <div className={s.sidebarSection}>
          <div className={s.sidebarSectionHeader}>
            <span className={s.sidebarSectionTitle}>Folders</span>
            <IconButton label="New folder" size="sm" onClick={() => setNewFolder(true)}>
              <Plus size={14} />
            </IconButton>
          </div>
          {folders.map((f) =>
            renaming === f.id ? (
              <InlineInput
                key={f.id}
                initial={f.name}
                onCancel={() => setRenaming(null)}
                onCommit={async (name) => {
                  setRenaming(null)
                  await window.minutes.folders.rename(f.id, name)
                  await refreshSidebar()
                }}
              />
            ) : (
              <NavItem key={f.id} view="folder" folderId={f.id} icon={<FolderIcon size={15} />} label={f.name} count={f.noteCount} onContextMenu={(e) => folderMenu(e, f.id, f.name)} />
            )
          )}
          {newFolder && (
            <InlineInput
              initial=""
              onCancel={() => setNewFolder(false)}
              onCommit={async (name) => {
                setNewFolder(false)
                try {
                  const f = await window.minutes.folders.create(name)
                  await refreshSidebar()
                  await setView('folder', { folderId: f.id })
                } catch (err) {
                  toast((err as Error).message, { kind: 'error' })
                }
              }}
            />
          )}
          {folders.length === 0 && !newFolder && (
            <button type="button" className={s.navItem} onClick={() => setNewFolder(true)} style={{ color: 'var(--fg-muted)' }}>
              <span className={s.navLabel}>Add a folder</span>
            </button>
          )}
        </div>

        {tags.length > 0 && (
          <div className={s.sidebarSection}>
            <div className={s.sidebarSectionHeader} style={{ cursor: 'default' }} onClick={() => setTagsOpen((o) => !o)}>
              <span className={s.sidebarSectionTitle}>Tags</span>
              {tagsOpen ? <ChevronDown size={13} style={{ opacity: 1 }} /> : <ChevronRight size={13} style={{ opacity: 1 }} />}
            </div>
            {tagsOpen && tags.map((t) => <NavItem key={t.id} view="tag" tagId={t.id} icon={<Hash size={15} />} label={t.name} count={t.noteCount} onContextMenu={(e) => tagMenu(e, t.id, t.name)} />)}
          </div>
        )}

        <div className={s.sidebarSection}>
          <NavItem view="archived" icon={<Archive size={15} />} label="Archive" count={counts.archived} />
          <NavItem view="trash" icon={<Trash2 size={15} />} label="Trash" count={counts.trash} />
        </div>
      </div>

      <div className={s.sidebarFooter}>
        <button type="button" className={s.navItem} onClick={() => setOverlay('settings')}>
          <Settings size={15} />
          <span className={s.navLabel}>Settings</span>
          <span className={s.navKbd}>{formatShortcut(shortcuts['nav.settings'])}</span>
        </button>
        {soon.length === 0 && (
          <button type="button" className={s.navItem} onClick={() => setOverlay('settings', 'calendar')} style={{ color: 'var(--fg-muted)' }}>
            <Calendar size={15} />
            <span className={s.navLabel}>Connect a calendar</span>
          </button>
        )}
      </div>
      {menu && <Menu items={menu.items} anchor={menu.anchor} onClose={closeMenu} />}
    </div>
  )
}
