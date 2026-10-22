import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronRight, Copy, Download, FileText, FolderOpen, Mic, MoreHorizontal, Pause, Pencil, Play, Search, Trash2, Upload, X } from 'lucide-react'
import p from './panel.module.css'
import { Button, EmptyState, IconButton, Input, Menu, Tooltip, type MenuItem } from '../ui'
import { store, useApp } from '@renderer/state/app-store'
import { setOverlay, setPanel, toast } from '@renderer/state/actions'
import { useJobs } from '@renderer/state/use-transcription'
import { formatSpeed, modelShortLabel } from '@shared/model-labels'
import type { TranscriptionJob } from '@shared/transcription-types'
import { bus } from '@renderer/lib/bus'
import { formatBytes, formatDateTime, formatDuration } from '@renderer/lib/format'
import { formatTimestamp } from '@shared/text/transcript-parsers'
import type { Recording, Transcript, TranscriptSegment } from '@shared/types'

const LOW_CONFIDENCE = 0.3
const UNDO_MS = 6000

type TranscriptData = {
  transcript: Transcript
  segments: TranscriptSegment[]
} | null

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Splits text into plain and <mark> parts for the given query (case-insensitive). */
function Highlighted({ text, query }: { text: string; query: string }): JSX.Element {
  if (!query) return <>{text}</>
  const re = new RegExp(`(${escapeRegExp(query)})`, 'ig')
  const parts = text.split(re)
  return <>{parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>
}

function channelLabel(ch: TranscriptSegment['channel']): string | null {
  if (ch === 'mic') return 'Me'
  if (ch === 'system') return 'Them'
  return null
}

function segmentLine(seg: TranscriptSegment): string {
  const time = seg.startMs !== null ? `[${formatTimestamp(seg.startMs)}] ` : ''
  const who = channelLabel(seg.channel)
  return `${time}${who ? `${who}: ` : ''}${seg.text}`
}

function Row({
  seg,
  query,
  selected,
  flash,
  onSelect,
  onSave,
  onDelete,
  rowRef
}: {
  seg: TranscriptSegment
  query: string
  selected: boolean
  flash: boolean
  onSelect: () => void
  onSave: (text: string) => Promise<void>
  onDelete: () => void
  rowRef?: (el: HTMLDivElement | null) => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(seg.text)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const low = seg.confidence !== null && seg.confidence < LOW_CONFIDENCE
  const who = channelLabel(seg.channel)
  const matches = !!query && seg.text.toLowerCase().includes(query.toLowerCase())

  useEffect(() => {
    if (editing) {
      setDraft(seg.text)
      setTimeout(() => {
        areaRef.current?.focus()
        areaRef.current?.select()
      }, 0)
    }
  }, [editing, seg.text])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const text = draft.trim()
      if (text && text !== seg.text) void onSave(text)
      setEditing(false)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditing(false)
    }
  }

  return (
    <div
      ref={rowRef}
      className={p.row}
      data-selected={selected ? 'true' : undefined}
      data-flash={flash ? 'true' : undefined}
      data-low={low ? 'true' : undefined}
      data-match={matches ? 'true' : undefined}
      title={low ? 'Low confidence' : undefined}
      onClick={onSelect}
    >
      <span className={p.rowTime}>{seg.startMs !== null ? formatTimestamp(seg.startMs) : ''}</span>
      <div className={p.rowMain}>
        {editing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea ref={areaRef} className={[p.editArea, 'selectable'].join(' ')} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} aria-label="Edit transcript line" />
            <div className={p.editHint}>Enter to save · Esc to cancel</div>
          </div>
        ) : (
          <>
            {who && (
              <span className={p.channel} data-channel={seg.channel}>
                {who}
              </span>
            )}
            <span className={[p.text, 'selectable'].join(' ')}>
              <Highlighted text={seg.text} query={query} />
            </span>
          </>
        )}
      </div>
      {!editing && (
        <div className={p.rowActions} onClick={(e) => e.stopPropagation()}>
          <IconButton label="Edit line" size="sm" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </IconButton>
          <IconButton label="Delete line" size="sm" onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      )}
    </div>
  )
}

export function TranscriptPanel({ noteId }: { noteId: string }): JSX.Element {
  const [data, setData] = useState<TranscriptData>(null)
  const [loading, setLoading] = useState(true)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [recOpen, setRecOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [newLine, setNewLine] = useState('')
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [pendingNew, setPendingNew] = useState(0)

  const recording = useApp((st) => st.recording)
  const jumpTo = useApp((st) => st.jumpToSegment)
  const { jobs } = useJobs()
  const noteJobs = useMemo(() => jobs.filter((j) => j.noteId === noteId), [jobs, noteId])
  const activeJobs = noteJobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused')

  const bodyRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<TranscriptData>(null)
  dataRef.current = data
  const atBottom = useRef(true)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const fileRef = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const closeMenu = useCallback(() => setMenu(null), [])

  const recordingThis = recording.noteId === noteId && (recording.status === 'recording' || recording.status === 'paused' || recording.status === 'starting')
  const liveStatus = recording.live?.status ?? recording.transcription.status
  const transcriptionActive = recordingThis && liveStatus !== 'off' && liveStatus !== 'error'

  const load = useCallback(async () => {
    try {
      const [t, recs] = await Promise.all([window.minutes.transcripts.get(noteId), window.minutes.recording.listRecordings(noteId)])
      setData(t)
      setRecordings(recs)
    } catch (err) {
      toast(`Could not load transcript: ${(err as Error).message}`, {
        kind: 'error'
      })
    } finally {
      setLoading(false)
    }
  }, [noteId])

  useEffect(() => {
    setLoading(true)
    setData(null)
    setSelectedId(null)
    setQuery('')
    setPendingNew(0)
    atBottom.current = true
    void load()
  }, [load])

  // Live segments
  useEffect(() => {
    return window.minutes.on.transcriptSegments(({ noteId: id, segments }) => {
      if (id !== noteId || segments.length === 0) return
      if (!dataRef.current) {
        // Transcript was just created by the live recognizer; fetch header + segments once.
        void load()
        return
      }
      setData((prev) => {
        if (!prev) return prev
        const known = new Set(prev.segments.map((s) => s.id))
        const fresh = segments.filter((s) => !known.has(s.id))
        if (fresh.length === 0) return prev
        return {
          transcript: {
            ...prev.transcript,
            segmentCount: prev.transcript.segmentCount + fresh.length
          },
          segments: [...prev.segments, ...fresh]
        }
      })
      if (!atBottom.current) setPendingNew((n) => n + segments.length)
    })
  }, [noteId, load])

  // Recording ended → refresh recordings list
  const prevStatus = useRef(recording.status)
  useEffect(() => {
    if (prevStatus.current !== 'idle' && recording.status === 'idle')
      void window.minutes.recording
        .listRecordings(noteId)
        .then(setRecordings)
        .catch(() => undefined)
    prevStatus.current = recording.status
  }, [recording.status, noteId])

  // A background job for this note finished → reload the transcript it produced.
  const prevActiveJobs = useRef(activeJobs.length)
  useEffect(() => {
    if (prevActiveJobs.current > 0 && activeJobs.length === 0) void load()
    prevActiveJobs.current = activeJobs.length
  }, [activeJobs.length, load])

  // Stick to bottom
  const segCount = data?.segments.length ?? 0
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (atBottom.current) {
      el.scrollTop = el.scrollHeight
      setPendingNew(0)
    }
  }, [segCount])

  const onScroll = (): void => {
    const el = bodyRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    atBottom.current = near
    if (near) setPendingNew(0)
  }

  // Jump to segment from search
  useEffect(() => {
    if (!jumpTo || !data) return
    const row = rowRefs.current.get(jumpTo)
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    setSelectedId(jumpTo)
    setFlashId(jumpTo)
    store.set({ jumpToSegment: null })
    const t = setTimeout(() => setFlashId(null), 1300)
    return () => clearTimeout(t)
  }, [jumpTo, data])

  useEffect(() => {
    if (searchOpen) setTimeout(() => searchRef.current?.focus(), 0)
  }, [searchOpen])

  const segments = data?.segments ?? []
  const q = query.trim()
  const visible = useMemo(() => (q ? segments.filter((s) => s.text.toLowerCase().includes(q.toLowerCase())) : segments), [segments, q])

  // ---------- actions ----------
  const saveSegment = async (id: string, text: string): Promise<void> => {
    try {
      await window.minutes.transcripts.updateSegment(id, text)
      setData((prev) =>
        prev
          ? {
              ...prev,
              segments: prev.segments.map((s) => (s.id === id ? { ...s, text } : s))
            }
          : prev
      )
    } catch (err) {
      toast(`Could not save line: ${(err as Error).message}`, {
        kind: 'error'
      })
    }
  }

  const deleteSegment = async (seg: TranscriptSegment): Promise<void> => {
    try {
      await window.minutes.transcripts.deleteSegment(seg.id)
      setData((prev) => (prev ? { ...prev, segments: prev.segments.filter((s) => s.id !== seg.id) } : prev))
      toast('Line deleted', {
        durationMs: UNDO_MS,
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await window.minutes.transcripts.addManualSegment(noteId, seg.text, seg.startMs)
              await load()
            } catch (err) {
              toast(`Could not restore line: ${(err as Error).message}`, {
                kind: 'error'
              })
            }
          }
        }
      })
    } catch (err) {
      toast(`Could not delete line: ${(err as Error).message}`, {
        kind: 'error'
      })
    }
  }

  const addLine = async (): Promise<void> => {
    const text = newLine.trim()
    if (!text) return
    const startMs = recordingThis ? recording.elapsedMs : null
    try {
      await window.minutes.transcripts.addManualSegment(noteId, text, startMs)
      setNewLine('')
      atBottom.current = true
      await load()
    } catch (err) {
      toast(`Could not add line: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const copyAll = async (): Promise<void> => {
    if (segments.length === 0) return
    await navigator.clipboard.writeText(segments.map(segmentLine).join('\n'))
    toast('Transcript copied', { kind: 'success' })
  }

  const exportAs = async (format: 'txt' | 'srt' | 'vtt' | 'md'): Promise<void> => {
    try {
      const res = await window.minutes.exports.transcript(noteId, format)
      if (res.ok && res.path) toast(`Exported to ${res.path}`, { kind: 'success' })
      else if (res.error) toast(res.error, { kind: 'error' })
    } catch (err) {
      toast(`Export failed: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const pickImport = (): void => fileRef.current?.click()

  const onFileChosen = async (file: File | undefined): Promise<void> => {
    if (fileRef.current) fileRef.current.value = ''
    if (!file) return
    if (segments.length > 0) {
      const ok = await window.minutes.app.confirm({
        title: 'Replace transcript',
        message: 'This note already has a transcript. Replace it with the imported file?',
        detail: `${segments.length} existing lines will be removed.`,
        confirmLabel: 'Replace',
        destructive: true
      })
      if (!ok) return
    }
    try {
      const content = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result ?? ''))
        r.onerror = () => reject(r.error ?? new Error('Could not read file'))
        r.readAsText(file)
      })
      const res = await window.minutes.transcripts.import({
        noteId,
        content,
        format: 'auto',
        fileName: file.name
      })
      toast(`Imported ${res.segmentCount} line${res.segmentCount === 1 ? '' : 's'} from ${file.name}`, { kind: 'success' })
      atBottom.current = true
      await load()
    } catch (err) {
      toast(`Import failed: ${(err as Error).message}`, { kind: 'error' })
    }
  }

  const clearAll = async (): Promise<void> => {
    const ok = await window.minutes.app.confirm({
      title: 'Clear transcript',
      message: 'Remove every line of this transcript?',
      detail: 'Saved recordings are kept. This cannot be undone.',
      confirmLabel: 'Clear',
      destructive: true
    })
    if (!ok) return
    try {
      await window.minutes.transcripts.clear(noteId)
      await load()
    } catch (err) {
      toast(`Could not clear transcript: ${(err as Error).message}`, {
        kind: 'error'
      })
    }
  }

  const deleteRecording = async (rec: Recording): Promise<void> => {
    const ok = await window.minutes.app.confirm({
      title: 'Delete recording',
      message: 'Delete this recording file?',
      detail: `${formatDuration(rec.durationMs)} · ${formatBytes(rec.sizeBytes)}. The transcript is kept. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    try {
      await window.minutes.recording.deleteRecording(rec.id)
      setRecordings((r) => r.filter((x) => x.id !== rec.id))
    } catch (err) {
      toast(`Could not delete recording: ${(err as Error).message}`, {
        kind: 'error'
      })
    }
  }

  const transcribeRecording = async (rec: Recording): Promise<void> => {
    try {
      const job = await window.minutes.jobs.enqueueRecording(noteId, rec.id)
      toast(job.status === 'running' ? 'Transcribing the recording in the background' : 'Recording queued for transcription', { kind: 'success' })
    } catch (err) {
      toast(`Could not start transcription: ${(err as Error).message}`, { kind: 'error', durationMs: 8000 })
    }
  }

  const jobFor = (rec: Recording): TranscriptionJob | undefined => activeJobs.find((j) => j.recordingId === rec.id)

  const menuItems: MenuItem[] = [
    { id: 'eh', label: 'Export transcript', heading: true },
    {
      id: 'txt',
      label: 'Plain text (.txt)…',
      icon: <Download size={14} />,
      disabled: segments.length === 0,
      onSelect: () => void exportAs('txt')
    },
    {
      id: 'srt',
      label: 'Subtitles (.srt)…',
      icon: <Download size={14} />,
      disabled: segments.length === 0,
      onSelect: () => void exportAs('srt')
    },
    {
      id: 'vtt',
      label: 'WebVTT (.vtt)…',
      icon: <Download size={14} />,
      disabled: segments.length === 0,
      onSelect: () => void exportAs('vtt')
    },
    {
      id: 'md',
      label: 'Markdown (.md)…',
      icon: <Download size={14} />,
      disabled: segments.length === 0,
      onSelect: () => void exportAs('md')
    },
    { id: 's1', label: '', separator: true },
    {
      id: 'import',
      label: 'Import transcript file…',
      icon: <Upload size={14} />,
      onSelect: pickImport
    },
    { id: 's2', label: '', separator: true },
    {
      id: 'clear',
      label: 'Clear transcript',
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: segments.length === 0,
      onSelect: () => void clearAll()
    }
  ]

  // ---------- empty states ----------
  const renderEmpty = (): JSX.Element => {
    if (recordingThis && transcriptionActive) {
      const live = recording.live
      const engineName = live?.engine === 'windows-sapi' || recording.transcription.engine === 'windows-sapi' ? 'the Windows speech recognizer' : live?.modelId ? `the ${modelShortLabel(live.modelId)} model` : 'the local speech model'
      const extra = live?.status === 'loading' ? 'Loading the model…' : live?.status === 'lagging' ? `The computer is ${Math.round(live.backlogMs / 1000)} s behind.` : liveStatus === 'processing' ? 'Processing audio…' : ''
      return (
        <EmptyState
          icon={
            <span className={p.listening}>
              <span className={p.listeningDot} />
            </span>
          }
          title="Listening…"
          body={
            <>
              Recognized lines will appear here as they are produced by {engineName}, about one chunk behind speech. {extra}
            </>
          }
        />
      )
    }
    if (recordingThis) {
      const reason = recording.transcriptionUnavailableReason ?? recording.live?.lastError ?? recording.transcription.lastError
      return (
        <EmptyState
          icon={<Mic size={26} strokeWidth={1.25} style={{ color: 'var(--fg-faint)', marginBottom: 8 }} />}
          title="Recording without transcription"
          body={
            <>
              Audio is being recorded, but no lines will appear. <span className="selectable">{reason ?? 'Live transcription is not running for this recording.'}</span>{' '}
              You can still add lines manually below or import a transcript later.
            </>
          }
          action={
            <Button variant="outline" onClick={() => setOverlay('settings', 'transcription')}>
              Transcription settings
            </Button>
          }
        />
      )
    }
    if (activeJobs.length > 0) {
      return (
        <EmptyState
          icon={<FileText size={26} strokeWidth={1.25} style={{ color: 'var(--fg-faint)', marginBottom: 8 }} />}
          title="Transcribing in the background"
          body="Lines appear here when the job finishes. You can keep working; progress is shown above."
        />
      )
    }
    return (
      <EmptyState
        icon={<FileText size={26} strokeWidth={1.25} style={{ color: 'var(--fg-faint)', marginBottom: 8 }} />}
        title="No transcript yet"
        body="Transcripts are produced on this computer by a local speech model (whisper.cpp) while you record or afterwards from a saved recording, or imported from a file. Nothing is sent anywhere."
        action={
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'center'
            }}
          >
            <Button variant="primary" onClick={() => bus.emit('captureCommand', { command: 'start', noteId })}>
              <Mic size={14} /> Record this meeting
            </Button>
            <Button variant="outline" onClick={pickImport}>
              <Upload size={14} /> Import a transcript file
            </Button>
          </div>
        }
      />
    )
  }

  const count = segments.length

  return (
    <>
      <div className={p.header}>
        <span className={p.title}>
          Transcript
          {count > 0 && <span className={p.count}> · {count}</span>}
        </span>
        <div className={p.actions}>
          <IconButton label="Search transcript" size="sm" active={searchOpen} disabled={count === 0 && !searchOpen} onClick={() => setSearchOpen((v) => !v)}>
            <Search size={14} />
          </IconButton>
          <IconButton label="Copy transcript" size="sm" disabled={count === 0} onClick={() => void copyAll()}>
            <Copy size={14} />
          </IconButton>
          <IconButton label="More" size="sm" onClick={(e) => setMenu((e.currentTarget as HTMLElement).getBoundingClientRect())}>
            <MoreHorizontal size={14} />
          </IconButton>
          <IconButton label="Close" size="sm" onClick={() => setPanel('none')}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      {searchOpen && (
        <div className={p.searchBar} role="search">
          <Input
            ref={searchRef}
            value={query}
            placeholder="Search transcript"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                setSearchOpen(false)
              }
            }}
          />
          <span className={p.searchCount}>{q ? `${visible.length} of ${count}` : ''}</span>
          <IconButton
            label="Close search"
            size="sm"
            onClick={() => {
              setQuery('')
              setSearchOpen(false)
            }}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {activeJobs.map((job) => (
        <JobBar key={job.id} job={job} />
      ))}

      <div className={p.bodyWrap}>
        <div ref={bodyRef} className={p.body} onScroll={onScroll}>
          {loading ? null : count === 0 ? (
            renderEmpty()
          ) : (
            <>
              <div className={p.rows}>
                {visible.length === 0 && q && <div className={p.explain}>No lines match “{q}”.</div>}
                {visible.map((seg) => (
                  <Row
                    key={seg.id}
                    seg={seg}
                    query={q}
                    selected={selectedId === seg.id}
                    flash={flashId === seg.id}
                    onSelect={() => setSelectedId((cur) => (cur === seg.id ? null : seg.id))}
                    onSave={(text) => saveSegment(seg.id, text)}
                    onDelete={() => void deleteSegment(seg)}
                    rowRef={(el) => {
                      if (el) rowRefs.current.set(seg.id, el)
                      else rowRefs.current.delete(seg.id)
                    }}
                  />
                ))}
              </div>
              {recordingThis && transcriptionActive && (
                <div className={p.explain}>
                  <span className={p.listening}>
                    <span className={p.listeningDot} /> Listening
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        {pendingNew > 0 && (
          <button
            type="button"
            className={p.newLines}
            onClick={() => {
              const el = bodyRef.current
              if (el) el.scrollTop = el.scrollHeight
              atBottom.current = true
              setPendingNew(0)
            }}
          >
            New lines ↓
          </button>
        )}
      </div>

      {!loading && recordings.length > 0 && (
        <div className={p.recordings}>
          <div className={p.sectionHeader}>
            <button type="button" className={p.sectionToggle} aria-expanded={recOpen} onClick={() => setRecOpen((v) => !v)}>
              {recOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className={p.sectionTitle}>Recordings ({recordings.length})</span>
            </button>
          </div>
          {recOpen &&
            recordings.map((rec) => (
              <div key={rec.id} className={p.recRow}>
                <Mic size={13} style={{ color: 'var(--fg-muted)', flex: 'none' }} />
                <span className={p.recMeta}>
                  {formatDateTime(rec.startedAt)}{' '}
                  <small>
                    · {formatDuration(rec.durationMs)} · {formatBytes(rec.sizeBytes)}
                  </small>
                </span>
                {(() => {
                  const job = jobFor(rec)
                  const why = job ? (job.status === 'running' ? 'Already being transcribed' : job.status === 'paused' ? 'Transcription paused — resume it above' : 'Already queued for transcription') : null
                  const btn = (
                    <Button size="sm" variant="outline" disabled={!!job} onClick={() => void transcribeRecording(rec)}>
                      Transcribe
                    </Button>
                  )
                  return why ? (
                    <Tooltip label={why}>
                      <span style={{ display: 'inline-flex' }}>{btn}</span>
                    </Tooltip>
                  ) : (
                    btn
                  )
                })()}
                <IconButton label="Reveal in folder" size="sm" onClick={() => void window.minutes.recording.revealRecording(rec.id).catch((err: Error) => toast(err.message, { kind: 'error' }))}>
                  <FolderOpen size={13} />
                </IconButton>
                <IconButton label="Delete recording" size="sm" onClick={() => void deleteRecording(rec)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
        </div>
      )}

      <div className={p.footer}>
        <Input
          value={newLine}
          placeholder="Add a line manually…"
          aria-label="Add a transcript line"
          onChange={(e) => setNewLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void addLine()
            }
          }}
        />
      </div>

      <input ref={fileRef} type="file" accept=".srt,.vtt,.txt" style={{ display: 'none' }} onChange={(e) => void onFileChosen(e.target.files?.[0])} />
      {menu && <Menu items={menuItems} anchor={menu} align="right" onClose={closeMenu} />}
    </>
  )
}

/** One quiet line per active background job for this note: progress, speed and pause/cancel. */
function JobBar({ job }: { job: TranscriptionJob }): JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, job.progress)) * 100)
  const speed = formatSpeed(job.rtf)
  const label =
    job.status === 'queued'
      ? 'Queued for background transcription'
      : job.status === 'paused'
        ? `Transcription paused · ${pct}%`
        : `Transcribing in the background · ${pct}%${speed ? ` · ${speed}` : ''}`
  const act = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      toast(`${name} failed: ${(err as Error).message}`, { kind: 'error' })
    }
  }
  return (
    <div className={p.jobBar} data-status={job.status}>
      <div className={p.jobBarLine}>
        <span className={p.jobBarText} title={job.modelId ? `${modelShortLabel(job.modelId)} · ${formatDuration(job.processedMs)} of ${formatDuration(job.totalMs)}` : undefined}>
          {label}
        </span>
        {job.status === 'running' && (
          <IconButton label="Pause transcription" size="sm" onClick={() => void act('Pause', () => window.minutes.jobs.pause(job.id))}>
            <Pause size={13} />
          </IconButton>
        )}
        {job.status === 'paused' && (
          <IconButton label="Resume transcription" size="sm" onClick={() => void act('Resume', () => window.minutes.jobs.resume(job.id))}>
            <Play size={13} />
          </IconButton>
        )}
        <IconButton label="Cancel transcription" size="sm" onClick={() => void act('Cancel', () => window.minutes.jobs.cancel(job.id))}>
          <X size={13} />
        </IconButton>
      </div>
      <div className={p.jobBarTrack} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={p.jobBarFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
