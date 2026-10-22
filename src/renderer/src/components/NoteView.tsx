import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, ArchiveRestore, Calendar, Copy, Download, FileText, Folder as FolderIcon, Hash, Info, ListChecks, MessageSquareText, MoreHorizontal, RotateCcw, Star, Trash2, Users, Mic } from 'lucide-react'
import layout from './layout.module.css'
import s from './editor.module.css'
import { Button, EmptyState, IconButton, Menu, type MenuItem } from './ui'
import { Editor } from './Editor'
import { RecordingControl } from './RecordingControl'
import { TranscriptPanel } from './panels/TranscriptPanel'
import { SuggestionsPanel } from './panels/SuggestionsPanel'
import { DetailsPanel } from './panels/DetailsPanel'
import { useApp } from '@renderer/state/app-store'
import { archiveNote, createNote, destroyNote, duplicateNote, flushSave, patchCurrent, queueSave, restoreNote, setNoteFlags, setPanel, toast, trashNote } from '@renderer/state/actions'
import { attendeeSummary, formatDate, formatShortcut, formatTime, relativeTime } from '@renderer/lib/format'

function SaveStatus(): JSX.Element {
  const state = useApp((st) => st.saveState)
  const at = useApp((st) => st.lastSavedAt)
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const label = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Edited' : state === 'error' ? 'Not saved' : at ? `Saved ${relativeTime(at)}` : ''
  return (
    <span className={layout.saveStatus} data-state={state} aria-live="polite">
      {label}
    </span>
  )
}

export function NoteView(): JSX.Element {
  const note = useApp((st) => st.current)
  const panel = useApp((st) => st.panel)
  const platform = useApp((st) => st.platform)
  const shortcuts = useApp((st) => st.settings.shortcuts)
  const folders = useApp((st) => st.folders)
  const [menu, setMenu] = useState<{ items: MenuItem[]; anchor: DOMRect } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const counts = useApp((st) => st.counts)

  // Autosize the title textarea.
  const resizeTitle = (): void => {
    const el = titleRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = el.scrollHeight + 'px'
  }
  useEffect(resizeTitle, [note?.id, note?.title, panel])
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      resizeTitle()
      setNarrow(el.clientWidth < 780)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [note === null])

  if (!note) {
    return (
      <div className={layout.main}>
        <div className={layout.mainHeader} data-overlay={platform === 'win32' ? 'true' : undefined}>
          <span className={layout.mainHeaderSpacer} />
        </div>
        {counts.all + counts.archived + counts.trash === 0 ? (
          <div className={s.welcome} ref={bodyRef}>
            <h1>Welcome to Minutes</h1>
            <p>A quiet place for meeting notes. Everything stays on this computer — no account, no cloud. Transcription runs on this computer with an open-source speech model (whisper.cpp); nothing is sent to any server. Suggestions and search are rule-based.</p>
            <ul>
              <li>Press <kbd>{formatShortcut(shortcuts['note.new'])}</kbd> to start a note, or create one from an upcoming calendar event.</li>
              <li>Use <strong>Record</strong> during a meeting to capture audio and a transcript; the speech model is downloaded once from Settings › Transcription.</li>
              <li>Import a transcript from another tool (.srt, .vtt or .txt) into any note.</li>
              <li>Search everything with <kbd>{formatShortcut(shortcuts['nav.search'])}</kbd>; find passages by question with <kbd>{formatShortcut(shortcuts['nav.ask'])}</kbd>.</li>
            </ul>
            <Button variant="primary" onClick={() => void createNote()}>
              New note
            </Button>
          </div>
        ) : (
          <div ref={bodyRef} style={{ flex: 1 }}>
            <EmptyState icon={<FileText size={28} strokeWidth={1.25} style={{ color: 'var(--fg-faint)', marginBottom: 8 }} />} title="No note selected" body="Pick a note from the list, or start a new one for your next meeting." />
          </div>
        )}
      </div>
    )
  }

  const inTrash = !!note.deletedAt
  const when = note.meetingAt ?? note.createdAt
  const folder = folders.find((f) => f.id === note.folderId)

  const moreMenu = (e: React.MouseEvent): void => {
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const items: MenuItem[] = inTrash
      ? [
          { id: 'restore', label: 'Restore from trash', icon: <RotateCcw size={14} />, onSelect: () => void restoreNote(note.id) },
          { id: 'destroy', label: 'Delete permanently', icon: <Trash2 size={14} />, danger: true, onSelect: () => void destroyNote(note.id) }
        ]
      : [
          { id: 'details', label: 'Note details', icon: <Info size={14} />, onSelect: () => setPanel('details') },
          { id: 'dup', label: 'Duplicate', icon: <Copy size={14} />, shortcut: shortcuts['note.duplicate'], onSelect: () => void duplicateNote(note.id) },
          { id: 'sep0', label: '', separator: true },
          { id: 'eh', label: 'Export', heading: true },
          { id: 'md', label: 'Markdown file…', icon: <Download size={14} />, onSelect: () => void exportAs('md') },
          { id: 'txt', label: 'Plain text file…', icon: <Download size={14} />, onSelect: () => void exportAs('txt') },
          { id: 'copy', label: 'Copy as Markdown', icon: <Copy size={14} />, onSelect: () => void copyAs('md') },
          { id: 'sep1', label: '', separator: true },
          { id: 'arch', label: note.archived ? 'Unarchive' : 'Archive', icon: note.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />, onSelect: () => void archiveNote(note.id, !note.archived) },
          { id: 'trash', label: 'Move to trash', icon: <Trash2 size={14} />, danger: true, shortcut: shortcuts['note.trash'], onSelect: () => void trashNote(note.id) }
        ]
    setMenu({ items, anchor })
  }

  const exportAs = async (f: 'md' | 'txt'): Promise<void> => {
    await flushSave()
    const res = f === 'md' ? await window.minutes.exports.noteMarkdown(note.id) : await window.minutes.exports.noteText(note.id)
    if (res.ok) toast(`Exported to ${res.path}`, { kind: 'success' })
    else if (res.error) toast(res.error, { kind: 'error' })
  }
  const copyAs = async (f: 'md' | 'txt'): Promise<void> => {
    await flushSave()
    const text = await window.minutes.exports.render(note.id, f)
    await navigator.clipboard.writeText(text)
    toast('Copied to clipboard', { kind: 'success' })
  }

  return (
    <div className={layout.main}>
      <div className={layout.mainHeader} data-overlay={platform === 'win32' ? 'true' : undefined}>
        <span className={layout.mainHeaderSpacer} />
        <SaveStatus />
        {!inTrash && <RecordingControl noteId={note.id} />}
        {!inTrash && (
          <IconButton label="Favorite" shortcut={shortcuts['note.favorite']} active={note.favorite} onClick={() => void setNoteFlags(note.id, { favorite: !note.favorite })}>
            <Star size={16} fill={note.favorite ? 'currentColor' : 'none'} />
          </IconButton>
        )}
        <IconButton label="Transcript" shortcut={shortcuts['nav.transcript']} active={panel === 'transcript'} onClick={() => setPanel('transcript')}>
          <MessageSquareText size={16} />
        </IconButton>
        <IconButton label="Suggestions" active={panel === 'suggestions'} onClick={() => setPanel('suggestions')}>
          <ListChecks size={16} />
        </IconButton>
        <IconButton label="More" onClick={moreMenu}>
          <MoreHorizontal size={16} />
        </IconButton>
      </div>

      <div className={layout.mainBody} ref={bodyRef} data-narrow={narrow && panel !== 'none' ? 'true' : undefined}>
        <div className={layout.noteColumn}>
          <div className={s.scroll}>
            <div className={s.page}>
              {inTrash && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', margin: '12px 0 0', background: 'var(--bg-inset)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--fg-secondary)' }}>
                  <Trash2 size={14} />
                  <span style={{ flex: 1 }}>This note is in the trash and will be deleted after 30 days.</span>
                  <Button size="sm" variant="outline" onClick={() => void restoreNote(note.id)}>
                    Restore
                  </Button>
                </div>
              )}
              <textarea
                ref={titleRef}
                className={s.title}
                rows={1}
                value={note.title}
                placeholder="Untitled"
                readOnly={inTrash}
                aria-label="Note title"
                onChange={(e) => {
                  const title = e.target.value.replace(/\n/g, ' ')
                  patchCurrent({ title })
                  queueSave(note.id, { title })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || (e.key === 'ArrowDown' && (e.target as HTMLTextAreaElement).selectionStart === note.title.length)) {
                    e.preventDefault()
                    ;(document.querySelector('.ProseMirror') as HTMLElement | null)?.focus()
                  }
                }}
              />
              <div className={s.meta}>
                <button type="button" className={s.metaItem} onClick={() => setPanel('details')}>
                  <Calendar size={13} />
                  <span>
                    {formatDate(when, { withYear: true })}, {formatTime(when)}
                    {note.meetingEndAt ? ` – ${formatTime(note.meetingEndAt)}` : ''}
                  </span>
                </button>
                <span className={s.metaGroup}>
                  <button type="button" className={s.metaItem} data-placeholder={note.attendees.length === 0 ? 'true' : undefined} onClick={() => setPanel('details')}>
                    <Users size={13} />
                    <span>{note.attendees.length ? attendeeSummary(note.attendees, 3) : 'Add attendees'}</span>
                  </button>
                </span>
                {folder && (
                  <span className={s.metaGroup}>
                    <button type="button" className={s.metaItem} onClick={() => setPanel('details')}>
                      <FolderIcon size={13} />
                      <span>{folder.name}</span>
                    </button>
                  </span>
                )}
                {note.transcriptId && (
                  <span className={s.metaGroup}>
                    <button type="button" className={s.metaItem} onClick={() => setPanel('transcript')}>
                      <Mic size={13} />
                      <span>Transcript</span>
                    </button>
                  </span>
                )}
                {note.tags.map((t, i) => (
                  <span key={t.id} className={s.metaGroup}>
                    <button type="button" className={s.tag} onClick={() => setPanel('details')}>
                      <Hash size={12} />
                      <span>{t.name}</span>
                    </button>
                  </span>
                ))}
              </div>
              {inTrash ? (
                <div className="selectable" style={{ whiteSpace: 'pre-wrap', color: 'var(--fg-secondary)', lineHeight: 'var(--leading-relaxed)' }}>
                  {note.bodyText || <span style={{ color: 'var(--fg-faint)' }}>Empty note</span>}
                </div>
              ) : (
                <Editor key={note.id} noteId={note.id} initialJson={note.bodyJson} />
              )}
            </div>
          </div>
          <div id="editor-toolbar-host" className={layout.toolbarHost} />
        </div>
        {panel === 'transcript' && (
          <aside className={layout.panel} aria-label="Transcript">
            <TranscriptPanel noteId={note.id} />
          </aside>
        )}
        {panel === 'suggestions' && (
          <aside className={layout.panel} aria-label="Suggestions">
            <SuggestionsPanel noteId={note.id} />
          </aside>
        )}
        {panel === 'details' && (
          <aside className={layout.panel} aria-label="Note details">
            <DetailsPanel note={note} />
          </aside>
        )}
      </div>
      {menu && <Menu items={menu.items} anchor={menu.anchor} align="right" onClose={closeMenu} />}
    </div>
  )
}
