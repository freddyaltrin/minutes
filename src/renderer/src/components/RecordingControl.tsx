import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Pause, Play, Square } from 'lucide-react'
import s from './RecordingControl.module.css'
import { Button, Dialog, IconButton, Tooltip } from './ui'
import { store, useApp } from '@renderer/state/app-store'
import { openNote, setOverlay, setPanel, toast, updateSettings } from '@renderer/state/actions'
import { bus } from '@renderer/lib/bus'
import { formatDuration } from '@renderer/lib/format'
import { recordingSession } from '@renderer/lib/recording-session'
import type { NoteId, RecordingState } from '@shared/types'
import { formatSpeed, modelShortLabel } from '@shared/model-labels'

const BAR_COUNT = 5
/** Per-bar gain so quiet speech lights the middle bars first; rms of 0.1 ≈ normal speech. */
const BAR_GAINS = [7, 10, 14, 10, 7]
const BAR_MAX_PX = 14
const BAR_MIN_PX = 2

// ---------- module-level command wiring (lives beyond any mounted control) ----------

const NEEDS_CONFIRM = 'rec.needsConfirm'

recordingSession.onNotice = (msg, kind) => toast(msg, { kind, durationMs: kind === 'error' ? 8000 : 4000 })

type KeepReason = 'no-engine' | 'no-model' | 'disabled'

/**
 * Why nothing durable would come out of a recording on this machine with current settings, or null
 * when either audio is kept or a transcription engine can actually run. Asks main for the current
 * resource plan when Whisper is the engine (a model must be installed and fit in memory).
 */
async function nothingWouldBeKept(): Promise<KeepReason | null> {
  const st = store.get()
  if (st.settings.audio.keepRecordings) return null
  const tr = st.settings.transcription
  if (!tr.enabled || tr.engine === 'none') return 'disabled'
  if (tr.engine === 'windows-sapi') return st.engineInfo && !st.engineInfo.available ? 'no-engine' : null
  try {
    const plan = await window.minutes.transcription.plan()
    return plan.modelId ? null : 'no-model'
  } catch {
    return 'no-model'
  }
}

let startPending = false

async function startFor(noteId: NoteId, opts: { skipConfirm?: boolean } = {}): Promise<void> {
  const st = store.get()
  if (startPending || recordingSession.isActive || st.recording.status === 'starting' || st.recording.status === 'stopping') return
  startPending = true
  let reason: KeepReason | null = null
  try {
    reason = opts.skipConfirm ? null : await nothingWouldBeKept()
  } finally {
    startPending = false
  }
  if (reason) {
    // Let a mounted control show the dialog; otherwise explain via toast.
    const handled = bus.emit(NEEDS_CONFIRM, { noteId, reason })
    if (!handled) {
      toast(
        reason === 'no-model'
          ? 'Recording not started: no speech model is installed and audio files are not kept.'
          : reason === 'disabled'
            ? 'Recording not started: transcription is off and audio files are not kept.'
            : 'Recording not started: no transcription engine is available and audio files are not kept.',
        {
        kind: 'error',
        durationMs: 8000,
        action: { label: 'Settings', onClick: () => setOverlay('settings', 'transcription') }
      })
    }
    return
  }
  try {
    // If loopback is refused, the session has already toasted the precise reason and continues mic-only.
    await recordingSession.start(noteId, {
      micDeviceId: st.settings.audio.micDeviceId,
      systemAudio: st.settings.audio.captureSystemAudio
    })
  } catch (err) {
    toast((err as Error).message, { kind: 'error', durationMs: 8000 })
  }
}

async function stopCurrent(): Promise<void> {
  if (!recordingSession.isActive) return
  try {
    await recordingSession.stop('user')
  } catch (err) {
    toast(`Could not finish the recording: ${(err as Error).message}`, { kind: 'error', durationMs: 8000 })
  }
}

function currentTargetNote(): NoteId | null {
  const cur = store.get().current
  return cur && !cur.deletedAt ? cur.id : null
}

async function toggleFor(noteId: NoteId | null): Promise<void> {
  if (recordingSession.isActive) await stopCurrent()
  else if (noteId) await startFor(noteId)
  else toast('Open a note to start recording.', { kind: 'info' })
}

let wired = false
function wireCommands(): void {
  if (wired) return
  wired = true
  bus.on('rec.toggle', () => void toggleFor(currentTargetNote()))
  bus.on('rec.pause', () => void recordingSession.togglePause())
  bus.on('captureCommand', (payload) => {
    const p = (payload ?? {}) as { command?: 'start' | 'stop' | 'toggle'; noteId?: NoteId }
    const target = p.noteId ?? currentTargetNote()
    switch (p.command) {
      case 'start':
        if (!recordingSession.isActive && target) void startFor(target)
        break
      case 'stop':
        void stopCurrent()
        break
      case 'toggle':
        void toggleFor(target)
        break
    }
  })
}
wireCommands()

// ---------- component ----------

export function RecordingControl({ noteId }: { noteId: NoteId }): JSX.Element {
  const rec = useApp((st) => st.recording)
  const shortcuts = useApp((st) => st.settings.shortcuts)
  const [confirm, setConfirm] = useState<{ noteId: NoteId; reason: KeepReason } | null>(null)

  useEffect(() => {
    return bus.on(NEEDS_CONFIRM, (payload) => {
      const p = payload as { noteId?: NoteId; reason?: KeepReason } | undefined
      setConfirm({ noteId: p?.noteId ?? noteId, reason: p?.reason ?? 'disabled' })
    })
  }, [noteId])

  const closeConfirm = useCallback(() => setConfirm(null), [])
  const confirmFor = confirm?.noteId ?? null
  const reason = confirm?.reason ?? null

  const live = rec.status === 'recording' || rec.status === 'paused'
  const isOther = live && rec.noteId !== null && rec.noteId !== noteId

  return (
    <div className={s.root}>
      {rec.status === 'idle' && <RecordButton shortcut={shortcuts['rec.toggle']} onClick={() => void startFor(noteId)} />}
      {rec.status === 'error' && (
        <>
          <span className={s.error} role="alert">
            <span className={s.errorText} title={rec.error ?? undefined}>
              {rec.error ?? 'Recording failed'}
            </span>
            <button type="button" className={s.retry} onClick={() => void startFor(noteId)}>
              Retry
            </button>
          </span>
        </>
      )}
      {rec.status === 'starting' && (
        <Button variant="outline" disabled className={s.starting}>
          Starting…
        </Button>
      )}
      {rec.status === 'stopping' && (
        <Button variant="outline" disabled className={s.starting}>
          {rec.transcription.queuedChunks > 0 ? `Finishing · ${rec.transcription.queuedChunks} ${rec.transcription.queuedChunks === 1 ? 'chunk' : 'chunks'} left` : 'Finishing…'}
        </Button>
      )}
      {live && !isOther && <LivePill rec={rec} shortcuts={shortcuts} />}
      {live && isOther && rec.noteId && <OtherNotePill noteId={rec.noteId} paused={rec.status === 'paused'} />}
      {live && !isOther && <TranscriptionStatus rec={rec} />}

      {confirmFor && (
        <Dialog
          title="Nothing would be kept"
          onClose={closeConfirm}
          width={420}
          footer={
            <>
              <Button onClick={closeConfirm}>Cancel</Button>
              <Button
                variant="outline"
                onClick={() => {
                  closeConfirm()
                  setOverlay('settings', 'transcription')
                }}
              >
                {reason === 'no-model' ? 'Open model settings' : 'Open transcription settings'}
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  const target = confirmFor
                  closeConfirm()
                  try {
                    await updateSettings({ audio: { ...store.get().settings.audio, keepRecordings: true } })
                  } catch (err) {
                    toast(`Could not change settings: ${(err as Error).message}`, { kind: 'error' })
                    return
                  }
                  void startFor(target, { skipConfirm: true })
                }}
              >
                Keep audio files
              </Button>
            </>
          }
        >
          <p className={s.dialogBody}>
            {reason === 'disabled'
              ? 'Transcription is turned off in Settings and recording storage is off, so this recording would produce nothing.'
              : reason === 'no-model'
                ? 'No speech model is installed (or none fits in memory) and recording storage is off, so this recording would produce nothing.'
                : 'The Windows speech recognizer is not available on this computer and recording storage is off, so this recording would produce nothing.'}{' '}
            {reason === 'no-model' ? 'Turn on “Keep audio files” to save the audio, or download a model in Settings.' : 'Turn on “Keep audio files” to save the audio, or change the transcription settings.'}
          </p>
        </Dialog>
      )}
    </div>
  )
}

function RecordButton({ shortcut, onClick }: { shortcut?: string; onClick: () => void }): JSX.Element {
  return (
    <Tooltip label="Record" shortcut={shortcut}>
      <Button variant="outline" className={s.record} onClick={onClick}>
        <Mic size={14} />
        Record
      </Button>
    </Tooltip>
  )
}

/** Shortens a sentence-long reason to something that fits the header; the full text goes in the tooltip. */
function shortReason(reason: string): string {
  const firstSentence = reason.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '')
  return firstSentence.length > 48 ? firstSentence.slice(0, 46).trimEnd() + '…' : firstSentence
}

function TranscriptionStatus({ rec }: { rec: RecordingState }): JSX.Element | null {
  const live = rec.live
  const unavailable = rec.transcriptionUnavailableReason
  let text: string
  let kind: 'ok' | 'warn' | 'error' = 'ok'
  let title: string | undefined
  // Keep the header quiet: a short label; the full reason lives in the tooltip and in the transcript panel.
  if (live && live.status !== 'off') {
    const model = live.engine === 'windows-sapi' ? 'Windows Speech' : modelShortLabel(live.modelId)
    const behind = `${Math.round(live.backlogMs / 1000)} s behind`
    switch (live.status) {
      case 'loading':
        text = 'Loading model…'
        break
      case 'listening':
        text = `Transcribing · ${model}`
        title = `${live.threads} threads${live.recentRtf ? ` · ${formatSpeed(live.recentRtf)}` : ''}`
        break
      case 'processing':
        text = live.backlogMs >= 3000 ? `Processing · ${behind}` : `Transcribing · ${model}`
        title = `${model} · ${live.queuedChunks} chunk${live.queuedChunks === 1 ? '' : 's'} queued${live.recentRtf ? ` · ${formatSpeed(live.recentRtf)}` : ''}`
        break
      case 'lagging':
        if (live.deferredToBackground) {
          text = 'Will finish after the meeting'
          title = `The computer cannot keep up (${behind}); the saved recording will be transcribed in the background.`
        } else {
          text = `Lagging · ${behind}`
          title = `${model} is slower than real time here${live.recentRtf ? ` (${formatSpeed(live.recentRtf)})` : ''}.`
        }
        kind = 'warn'
        break
      default:
        text = 'Transcription failed'
        title = live.lastError ?? undefined
        kind = 'error'
    }
  } else if (live?.deferredToBackground) {
    text = 'Will finish after the meeting'
    title = 'Live transcription stopped; the saved recording will be transcribed in the background.'
    kind = 'warn'
  } else if (unavailable) {
    text = `No transcription: ${shortReason(unavailable)}`
    title = unavailable
    kind = 'warn'
  } else {
    const t = rec.transcription
    if (t.status === 'error') {
      text = 'Transcription failed'
      title = t.lastError ?? undefined
      kind = 'error'
    } else if (t.status === 'off') {
      text = 'Transcription off'
      title = t.lastError ?? undefined
    } else text = t.engine === 'windows-sapi' ? 'Transcribing · Windows Speech' : 'Transcribing'
  }
  return (
    <span className={s.status} data-kind={kind} title={title}>
      {text}
    </span>
  )
}

// ---------- live pill (this note) ----------

function LivePill({ rec, shortcuts }: { rec: RecordingState; shortcuts: Record<string, string> }): JSX.Element {
  const paused = rec.status === 'paused'
  const local = recordingSession.isActive
  const systemActive = local ? recordingSession.hasSystemAudio : rec.systemActive
  const timeRef = useRef<HTMLSpanElement>(null)
  const barsRef = useRef<HTMLSpanElement[]>([])
  const dotRef = useRef<HTMLSpanElement>(null)

  // Elapsed time: 1 Hz from the local clock (excludes paused time); falls back to main's figure.
  useEffect(() => {
    const update = (): void => {
      if (!timeRef.current) return
      if (paused) {
        timeRef.current.textContent = 'Paused'
        return
      }
      const ms = recordingSession.isActive ? recordingSession.elapsedMs : store.get().recording.elapsedMs
      timeRef.current.textContent = formatDuration(ms)
    }
    update()
    const t = setInterval(update, 1000)
    return () => clearInterval(t)
  }, [paused])

  // Level meter: rms → bar heights via refs. requestAnimationFrame when motion is allowed,
  // otherwise static heights refreshed at a low rate.
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let micLevel = 0
    let sysLevel = 0
    let shown = 0
    let raf = 0
    let slow: ReturnType<typeof setInterval> | null = null
    let lastSys = -1

    const paint = (): void => {
      const bars = barsRef.current
      for (let i = 0; i < bars.length; i++) {
        const h = paused ? BAR_MIN_PX : Math.round(Math.min(BAR_MAX_PX, Math.max(BAR_MIN_PX, shown * BAR_GAINS[i] * BAR_MAX_PX)))
        if (bars[i]) bars[i].style.height = h + 'px'
      }
      const quiet = sysLevel < 0.005
      if (dotRef.current && (quiet ? 1 : 0) !== lastSys) {
        dotRef.current.dataset.quiet = quiet ? 'true' : 'false'
        lastSys = quiet ? 1 : 0
      }
    }
    const frame = (): void => {
      // fast attack, slow release
      shown = micLevel > shown ? micLevel : shown * 0.85 + micLevel * 0.15
      paint()
      raf = requestAnimationFrame(frame)
    }
    const off = recordingSession.subscribeLevels((ch, rms) => {
      if (ch === 'mic') micLevel = rms
      else sysLevel = rms
    })
    if (reduce) {
      slow = setInterval(() => {
        shown = micLevel
        paint()
      }, 500)
      paint()
    } else raf = requestAnimationFrame(frame)
    return () => {
      off()
      if (raf) cancelAnimationFrame(raf)
      if (slow) clearInterval(slow)
    }
  }, [paused])

  return (
    <span className={s.pill} data-paused={paused ? 'true' : undefined}>
      <button type="button" className={s.body} onClick={() => setPanel('transcript')} aria-label={paused ? 'Recording paused. Open transcript' : 'Recording. Open transcript'}>
        <span className={s.meter} aria-hidden>
          {Array.from({ length: BAR_COUNT }, (_, i) => (
            <span
              key={i}
              className={s.bar}
              ref={(el) => {
                if (el) barsRef.current[i] = el
              }}
            />
          ))}
        </span>
        {systemActive && <span ref={dotRef} className={s.systemDot} data-quiet="true" title="System audio" aria-hidden />}
        <span ref={timeRef} className={s.time}>
          {paused ? 'Paused' : formatDuration(rec.elapsedMs)}
        </span>
      </button>
      {local ? (
        <>
          <IconButton label={paused ? 'Resume' : 'Pause'} shortcut={shortcuts['rec.pause']} size="sm" className={s.pillButton} onClick={() => void recordingSession.togglePause()}>
            {paused ? <Play size={13} /> : <Pause size={13} />}
          </IconButton>
          <IconButton label="Stop recording" shortcut={shortcuts['rec.toggle']} size="sm" className={s.pillButton} onClick={() => void stopCurrent()}>
            <Square size={12} fill="currentColor" />
          </IconButton>
        </>
      ) : (
        // Main reports a recording this renderer does not own (e.g. after a renderer reload): can only end it.
        <IconButton label="Stop recording" size="sm" className={s.pillButton} onClick={() => void window.minutes.recording.end('user')}>
          <Square size={12} fill="currentColor" />
        </IconButton>
      )}
    </span>
  )
}

// ---------- pill for a recording that belongs to another note ----------

function OtherNotePill({ noteId, paused }: { noteId: NoteId; paused: boolean }): JSX.Element {
  const listTitle = useApp((st) => st.notes.find((n) => n.id === noteId)?.title)
  const [title, setTitle] = useState<string | null>(listTitle ?? null)
  useEffect(() => {
    if (listTitle !== undefined) {
      setTitle(listTitle)
      return
    }
    let cancelled = false
    void window.minutes.notes.get(noteId).then((n) => {
      if (!cancelled) setTitle(n?.title ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [noteId, listTitle])
  const label = title === null ? '…' : title || 'Untitled'
  return (
    <span className={s.pill} data-paused={paused ? 'true' : undefined}>
      <span className={s.body} style={{ cursor: 'default' }}>
        <Mic size={13} />
        <span>{paused ? 'Paused' : 'Recording'} ·</span>
        <span className={s.otherTitle} title={label}>
          {label}
        </span>
      </span>
      <button type="button" className={s.goto} onClick={() => void openNote(noteId, { panel: 'transcript' })}>
        Go to note
      </button>
    </span>
  )
}
