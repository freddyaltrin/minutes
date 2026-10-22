import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Archive, Calendar, Copy, Download, Pin, Star, X } from 'lucide-react'
import p from './panel.module.css'
import { Button, IconButton, Input, Select, Switch } from '../ui'
import { useApp } from '@renderer/state/app-store'
import { flushSave, patchCurrent, queueSave, refreshSidebar, setNoteFlags, setPanel, toast } from '@renderer/state/actions'
import { bus } from '@renderer/lib/bus'
import { formatDateTime } from '@renderer/lib/format'
import type { Note } from '@shared/types'

/** Formats a timestamp for an <input type="datetime-local"> in local time. */
function toLocalInput(ms: number | null): string {
  if (ms === null) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v: string): number | null {
  if (!v) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

function wordCount(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** Token editor: Enter/comma adds, Backspace on empty input removes last, × removes one. */
function TokenEditor({
  values,
  onChange,
  placeholder,
  suggestions,
  listId,
  ariaLabel
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  suggestions?: string[]
  listId?: string
  ariaLabel: string
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const add = (raw: string): void => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...values]
    for (const part of parts) if (!next.some((v) => v.toLowerCase() === part.toLowerCase())) next.push(part)
    if (next.length !== values.length) onChange(next)
    setDraft('')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add(draft)
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      e.preventDefault()
      onChange(values.slice(0, -1))
    }
  }

  return (
    <div className={p.tokens} onClick={() => inputRef.current?.focus()}>
      {values.map((v) => (
        <span key={v} className={p.token}>
          <span>{v}</span>
          <button type="button" className={p.tokenRemove} aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className={p.tokenInput}
        value={draft}
        placeholder={values.length === 0 ? placeholder : ''}
        aria-label={ariaLabel}
        list={listId}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value
          if (v.includes(',')) add(v)
          else setDraft(v)
        }}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
      />
      {listId && suggestions && (
        <datalist id={listId}>
          {suggestions
            .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      )}
    </div>
  )
}

export function DetailsPanel({ note }: { note: Note }): JSX.Element {
  const folders = useApp((st) => st.folders)
  const tags = useApp((st) => st.tags)
  const [transcriptLines, setTranscriptLines] = useState<number | null>(null)
  const [showEnd, setShowEnd] = useState(note.meetingEndAt !== null)

  useEffect(() => {
    setShowEnd(note.meetingEndAt !== null)
  }, [note.id, note.meetingEndAt])

  useEffect(() => {
    let alive = true
    if (!note.transcriptId) {
      setTranscriptLines(0)
      return
    }
    void window.minutes.transcripts
      .get(note.id)
      .then((t) => alive && setTranscriptLines(t ? t.segments.length : 0))
      .catch(() => alive && setTranscriptLines(null))
    return () => {
      alive = false
    }
  }, [note.id, note.transcriptId])

  const setMeeting = (patch: { meetingAt?: number | null; meetingEndAt?: number | null }): void => {
    patchCurrent(patch)
    queueSave(note.id, patch)
  }
  const setAttendees = (attendees: string[]): void => {
    patchCurrent({ attendees })
    queueSave(note.id, { attendees })
  }
  const setTags = async (names: string[]): Promise<void> => {
    try {
      const next = await window.minutes.notes.setTags(note.id, names)
      patchCurrent({ tags: next })
      await refreshSidebar()
    } catch (err) {
      toast(`Could not update tags: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const exportAs = async (f: 'md' | 'txt'): Promise<void> => {
    await flushSave()
    try {
      const res = f === 'md' ? await window.minutes.exports.noteMarkdown(note.id) : await window.minutes.exports.noteText(note.id)
      if (res.ok && res.path) toast(`Exported to ${res.path}`, { kind: 'success' })
      else if (res.error) toast(res.error, { kind: 'error' })
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { kind: 'error' })
    }
  }
  const copyMarkdown = async (): Promise<void> => {
    await flushSave()
    try {
      const text = await window.minutes.exports.render(note.id, 'md')
      await navigator.clipboard.writeText(text)
      toast('Copied as Markdown', { kind: 'success' })
    } catch (err) {
      toast(`Copy failed: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const exportRef = useRef(exportAs)
  exportRef.current = exportAs
  useEffect(() => bus.on('note.export', () => void exportRef.current('md')), [])

  const meetingSet = note.meetingAt !== null
  const words = wordCount(note.bodyText)

  return (
    <>
      <div className={p.header}>
        <span className={p.title}>Details</span>
        <div className={p.actions}>
          <IconButton label="Close" size="sm" onClick={() => setPanel('none')}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      <div className={p.body}>
        <div className={p.form}>
          <div className={p.section}>
            <div className={p.sectionHeader}>
              <span className={p.sectionTitle}>Meeting</span>
            </div>
            <div className={p.field}>
              <label className={p.label} htmlFor="details-start">
                <span>Date &amp; time</span>
                {meetingSet && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setMeeting({ meetingAt: null, meetingEndAt: null })
                      setShowEnd(false)
                    }}
                  >
                    Clear
                  </Button>
                )}
              </label>
              <Input id="details-start" type="datetime-local" value={toLocalInput(note.meetingAt)} onChange={(e) => setMeeting({ meetingAt: fromLocalInput(e.target.value) })} />
              {!meetingSet && <div className={p.help}>Not set — the note shows its creation time, {formatDateTime(note.createdAt)}.</div>}
            </div>
            {showEnd ? (
              <div className={p.field}>
                <label className={p.label} htmlFor="details-end">
                  <span>End time</span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setMeeting({ meetingEndAt: null })
                      setShowEnd(false)
                    }}
                  >
                    Clear
                  </Button>
                </label>
                <Input
                  id="details-end"
                  type="datetime-local"
                  value={toLocalInput(note.meetingEndAt)}
                  min={toLocalInput(note.meetingAt) || undefined}
                  onChange={(e) => setMeeting({ meetingEndAt: fromLocalInput(e.target.value) })}
                />
              </div>
            ) : (
              <div>
                <Button size="sm" variant="outline" disabled={!meetingSet} onClick={() => setShowEnd(true)}>
                  Add end time
                </Button>
              </div>
            )}
            <div className={p.field}>
              <span className={p.label}>
                <span>Attendees</span>
              </span>
              <TokenEditor values={note.attendees} onChange={setAttendees} placeholder="Add attendee, press Enter" ariaLabel="Attendees" />
            </div>
          </div>

          <div className={p.section}>
            <div className={p.sectionHeader}>
              <span className={p.sectionTitle}>Organize</span>
            </div>
            <div className={p.field}>
              <label className={p.label} htmlFor="details-folder">
                <span>Folder</span>
              </label>
              <Select id="details-folder" value={note.folderId ?? ''} onChange={(e) => void setNoteFlags(note.id, { folderId: e.target.value || null })}>
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className={p.field}>
              <span className={p.label}>
                <span>Tags</span>
              </span>
              <TokenEditor
                values={note.tags.map((t) => t.name)}
                onChange={(names) => void setTags(names)}
                placeholder="Add tag, press Enter"
                suggestions={tags.map((t) => t.name)}
                listId="details-tag-suggestions"
                ariaLabel="Tags"
              />
            </div>
            <div className={p.toggleRow}>
              <span>
                <Pin size={14} /> Pinned
              </span>
              <Switch checked={note.pinned} label="Pinned" onChange={(v) => void setNoteFlags(note.id, { pinned: v })} />
            </div>
            <div className={p.toggleRow}>
              <span>
                <Star size={14} /> Favorite
              </span>
              <Switch checked={note.favorite} label="Favorite" onChange={(v) => void setNoteFlags(note.id, { favorite: v })} />
            </div>
            <div className={p.toggleRow}>
              <span>
                <Archive size={14} /> Archived
              </span>
              <Switch checked={note.archived} label="Archived" onChange={(v) => void setNoteFlags(note.id, { archived: v })} />
            </div>
          </div>

          <div className={p.section}>
            <div className={p.sectionHeader}>
              <span className={p.sectionTitle}>Export</span>
            </div>
            <div className={p.exportRow}>
              <Button size="sm" variant="outline" onClick={() => void exportAs('md')}>
                <Download size={13} /> Markdown
              </Button>
              <Button size="sm" variant="outline" onClick={() => void exportAs('txt')}>
                <Download size={13} /> Plain text
              </Button>
              <Button size="sm" variant="outline" onClick={() => void copyMarkdown()}>
                <Copy size={13} /> Copy as Markdown
              </Button>
            </div>
          </div>

          <div className={p.section}>
            <div className={p.sectionHeader}>
              <span className={p.sectionTitle}>Info</span>
            </div>
            <div className={[p.info, 'selectable'].join(' ')}>
              <span className={p.infoKey}>Created</span>
              <span className={p.infoVal}>{formatDateTime(note.createdAt)}</span>
              <span className={p.infoKey}>Last edited</span>
              <span className={p.infoVal}>{formatDateTime(note.updatedAt)}</span>
              <span className={p.infoKey}>Words</span>
              <span className={p.infoVal}>{words.toLocaleString()}</span>
              <span className={p.infoKey}>Transcript lines</span>
              <span className={p.infoVal}>{transcriptLines === null ? '—' : transcriptLines.toLocaleString()}</span>
              {note.calendarEventId && (
                <>
                  <span className={p.infoKey}>Calendar</span>
                  <span className={p.infoVal}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={note.calendarEventId}>
                      <Calendar size={12} /> Linked to a calendar event
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
