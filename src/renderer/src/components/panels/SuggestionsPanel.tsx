import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CalendarClock, CheckSquare, ChevronDown, ChevronRight, Flag, HelpCircle, Link2, ListChecks, MessageSquareText, Plus, RefreshCw, RotateCcw, Tag, X } from 'lucide-react'
import p from './panel.module.css'
import { Button, EmptyState, IconButton } from '../ui'
import { store, useApp } from '@renderer/state/app-store'
import { setPanel, toast } from '@renderer/state/actions'
import { bus } from '@renderer/lib/bus'
import { formatTimestamp } from '@shared/text/transcript-parsers'
import type { Extraction, ExtractionKind } from '@shared/types'

const ORDER: { kind: ExtractionKind; label: string; icon: JSX.Element }[] = [
  { kind: 'action', label: 'Action items', icon: <CheckSquare size={14} /> },
  { kind: 'decision', label: 'Decisions', icon: <Flag size={14} /> },
  { kind: 'deadline', label: 'Deadlines', icon: <CalendarClock size={14} /> },
  { kind: 'question', label: 'Open questions', icon: <HelpCircle size={14} /> },
  { kind: 'reference', label: 'References', icon: <Link2 size={14} /> },
  { kind: 'topic', label: 'Topics', icon: <Tag size={14} /> }
]

const DEBOUNCE_RECORDING_MS = 2000

function Item({
  item,
  onUpdate,
  onDismiss,
  onRestore
}: {
  item: Extraction
  onUpdate: (patch: { text?: string; dismissed?: boolean }) => Promise<void>
  onDismiss: () => void
  onRestore?: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.text)
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const def = ORDER.find((o) => o.kind === item.kind) ?? ORDER[0]

  useEffect(() => {
    if (editing) {
      setDraft(item.text)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
    }
  }, [editing, item.text])

  const commit = (): void => {
    const text = draft.trim()
    setEditing(false)
    if (text && text !== item.text) void onUpdate({ text })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
    }
  }

  const showInTranscript = (): void => {
    if (!item.sourceSegmentId) return
    store.set({ panel: 'transcript', jumpToSegment: item.sourceSegmentId })
  }

  return (
    <div className={p.item} data-open={open ? 'true' : undefined} data-dismissed={item.dismissed ? 'true' : undefined}>
      <span className={p.itemIcon} aria-hidden>
        {def.icon}
      </span>
      {editing ? (
        <textarea
          ref={inputRef}
          className={[p.editArea, 'selectable'].join(' ')}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          aria-label="Edit suggestion"
        />
      ) : (
        <span
          className={[p.itemText, 'selectable'].join(' ')}
          role="button"
          tabIndex={0}
          title="Click to edit"
          onClick={() => !item.dismissed && setEditing(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !item.dismissed) setEditing(true)
          }}
        >
          {item.text}
        </span>
      )}
      <div className={p.itemActions}>
        {item.kind === 'action' && !item.dismissed && (
          <IconButton label="Add to note as a task" size="sm" onClick={() => bus.emit('editor.insertTask', item.text)}>
            <Plus size={13} />
          </IconButton>
        )}
        <IconButton label={open ? 'Hide source' : 'Show source'} size="sm" active={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </IconButton>
        {item.dismissed ? (
          <IconButton label="Restore" size="sm" onClick={onRestore}>
            <RotateCcw size={13} />
          </IconButton>
        ) : (
          <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
            <X size={13} />
          </IconButton>
        )}
      </div>
      {open && (
        <div className={[p.source, 'selectable'].join(' ')}>
          {item.sourceText}
          <div className={p.sourceMeta}>
            <span>{item.sourceOrigin === 'transcript' ? 'From transcript' : 'From note'}</span>
            {item.startMs !== null && <span>{formatTimestamp(item.startMs)}</span>}
            {item.sourceSegmentId && (
              <button type="button" className={p.linkBtn} onClick={showInTranscript}>
                <MessageSquareText size={11} /> Show in transcript
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function SuggestionsPanel({ noteId }: { noteId: string }): JSX.Element {
  const [items, setItems] = useState<Extraction[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const recording = useApp((st) => st.recording)
  const recordingThis = recording.noteId === noteId && (recording.status === 'recording' || recording.status === 'paused')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inflight = useRef<Promise<void> | null>(null)

  const analyze = useCallback(async (): Promise<void> => {
    if (inflight.current) return inflight.current
    setBusy(true)
    inflight.current = (async () => {
      try {
        const res = await window.minutes.extractions.analyze(noteId)
        // Never show a suggestion without a verbatim source.
        setItems(res.filter((e) => e.sourceText && e.sourceText.trim().length > 0))
      } catch (err) {
        toast(`Could not analyze note: ${(err as Error).message}`, { kind: 'error' })
        setItems((prev) => prev ?? [])
      } finally {
        setBusy(false)
        inflight.current = null
      }
    })()
    return inflight.current
  }, [noteId])

  useEffect(() => {
    setItems(null)
    setShowDismissed(false)
    void analyze()
  }, [analyze])

  // Re-analyze on changes. While recording, debounce so we are not re-running on every recognized line.
  useEffect(() => {
    const schedule = (): void => {
      if (timer.current) clearTimeout(timer.current)
      const rec = store.get().recording
      const live = rec.noteId === noteId && (rec.status === 'recording' || rec.status === 'paused')
      timer.current = setTimeout(() => void analyze(), live ? DEBOUNCE_RECORDING_MS : 400)
    }
    const offNotes = window.minutes.on.notesChanged(({ ids }) => {
      if (ids.length === 0 || ids.includes(noteId)) schedule()
    })
    const offSegs = window.minutes.on.transcriptSegments(({ noteId: id }) => {
      if (id === noteId) schedule()
    })
    return () => {
      offNotes()
      offSegs()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [noteId, analyze])

  const update = async (id: string, patch: { text?: string; dismissed?: boolean }): Promise<void> => {
    try {
      const next = await window.minutes.extractions.update(id, patch)
      setItems((prev) => (prev ? prev.map((e) => (e.id === id ? next : e)) : prev))
    } catch (err) {
      toast(`Could not update suggestion: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const all = items ?? []
  const active = all.filter((e) => !e.dismissed)
  const dismissed = all.filter((e) => e.dismissed)
  const groups = ORDER.map((o) => ({ ...o, items: active.filter((e) => e.kind === o.kind).sort((a, b) => b.score - a.score || a.createdAt - b.createdAt) })).filter((g) => g.items.length > 0)

  return (
    <>
      <div className={p.header}>
        <span className={p.title}>
          Suggestions
          <span className={p.subtitle}>Found by pattern matching — not AI</span>
        </span>
        <div className={p.actions}>
          <IconButton label="Refresh suggestions" size="sm" disabled={busy} onClick={() => void analyze()}>
            <RefreshCw size={14} className={busy ? p.spin : undefined} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={() => setPanel('none')}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      <div className={p.body}>
        {items === null ? null : active.length === 0 && !(showDismissed && dismissed.length > 0) ? (
          <EmptyState
            icon={<ListChecks size={26} strokeWidth={1.25} style={{ color: 'var(--fg-faint)', marginBottom: 8 }} />}
            title="Nothing to suggest yet"
            body={
              <>
                Minutes looks for commitments, decisions, dates and questions in the note text and the transcript. Write a few lines or record the meeting — a longer transcript gives better results.
                {recordingThis ? ' Suggestions update as the transcript grows.' : ''}
              </>
            }
            action={
              <Button variant="outline" onClick={() => void analyze()} disabled={busy}>
                <RefreshCw size={14} /> Check again
              </Button>
            }
          />
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.kind} className={p.group} aria-label={g.label}>
                <div className={p.sectionHeader}>
                  <span className={p.sectionTitle}>{g.label}</span>
                  <span className={p.groupCount}>{g.items.length}</span>
                </div>
                {g.items.map((item) => (
                  <Item key={item.id} item={item} onUpdate={(patch) => update(item.id, patch)} onDismiss={() => void update(item.id, { dismissed: true })} />
                ))}
              </section>
            ))}
            {showDismissed && dismissed.length > 0 && (
              <section className={p.group} aria-label="Dismissed">
                <div className={p.sectionHeader}>
                  <span className={p.sectionTitle}>Dismissed</span>
                  <span className={p.groupCount}>{dismissed.length}</span>
                </div>
                {dismissed.map((item) => (
                  <Item key={item.id} item={item} onUpdate={(patch) => update(item.id, patch)} onDismiss={() => undefined} onRestore={() => void update(item.id, { dismissed: false })} />
                ))}
              </section>
            )}
          </>
        )}
        {items !== null && dismissed.length > 0 && (
          <div className={p.dismissedBar}>
            <span>
              {dismissed.length} dismissed ·{' '}
              <button type="button" className={p.linkBtn} style={{ marginLeft: 0 }} onClick={() => setShowDismissed((v) => !v)}>
                {showDismissed ? 'Hide' : 'Show'}
              </button>
            </span>
          </div>
        )}
      </div>
    </>
  )
}
