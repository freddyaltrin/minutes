import { join } from 'node:path'
import { mkdirSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AppContext } from '../context'
import type { RecordingState, TranscriptionState } from '@shared/types'
import type { AudioChunk } from '@shared/api'
import { SpeechChunker } from './transcription/chunker'
import { WavFileWriter, rmsLevel } from './transcription/wav'
import type { TranscriptionService, LiveSession } from './whisper/transcription-service'
import type { LiveTranscriptionStatus } from '@shared/transcription-types'

type Channel = 'mic' | 'system'
const TARGET_RATE = 16000

interface Session {
  id: string
  noteId: string
  startedAt: number
  sampleRate: number
  keepRecordings: boolean
  workDir: string
  writers: Partial<Record<Channel, WavFileWriter>>
  chunkers: Partial<Record<Channel, SpeechChunker>>
  live: LiveSession | null
  liveReason: string | null
  liveStatus: LiveTranscriptionStatus | null
  lastOffsetMs: number
  lastLoudMs: number
  paused: boolean
  engineState: TranscriptionState
}

const OFF_STATE: TranscriptionState = { engine: 'none', status: 'off', queuedChunks: 0, recognizedSegments: 0, lastError: null }

/**
 * Owns the lifecycle of a recording: receives PCM from the renderer, optionally persists WAV files,
 * cuts speech chunks and forwards them to the conventional recognizer, and stores recognized segments.
 * Audio never leaves the machine.
 */
export class RecordingService {
  private session: Session | null = null
  private status: RecordingState['status'] = 'idle'
  private error: string | null = null
  private tick: NodeJS.Timeout | null = null

  constructor(
    private readonly ctx: AppContext,
    private readonly transcription: TranscriptionService
  ) {
    transcription.on('liveStatus', (st) => {
      if (this.session) {
        this.session.liveStatus = st
        this.session.engineState = toLegacyState(st)
        this.publish()
      }
    })
  }

  getState(): RecordingState {
    const s = this.session
    return {
      status: this.status,
      noteId: s?.noteId ?? null,
      startedAt: s?.startedAt ?? null,
      elapsedMs: s ? s.lastOffsetMs : 0,
      micActive: !!s?.chunkers.mic,
      systemActive: !!s?.chunkers.system,
      error: this.error,
      transcription: s?.engineState ?? OFF_STATE,
      live: s?.liveStatus ?? null,
      transcriptionUnavailableReason: s?.liveReason ?? null
    }
  }

  private publish(): void {
    this.ctx.emit('recordingState', this.getState())
  }

  async begin(noteId: string, opts: { sampleRate: number; micLabel: string | null; systemAudio: boolean }): Promise<RecordingState> {
    if (this.session) throw new Error('A recording is already in progress')
    const note = this.ctx.notes.get(noteId)
    if (!note) throw new Error('Note not found')
    this.status = 'starting'
    this.error = null
    this.publish()

    const settings = this.ctx.settings.get()
    const id = randomUUID()
    const workDir = join(this.ctx.paths.temp, 'rec-' + id)
    mkdirSync(workDir, { recursive: true })
    const session: Session = {
      id,
      noteId,
      startedAt: Date.now(),
      sampleRate: TARGET_RATE,
      keepRecordings: settings.audio.keepRecordings,
      workDir,
      writers: {},
      chunkers: {},
      live: null,
      liveReason: null,
      liveStatus: null,
      lastOffsetMs: 0,
      lastLoudMs: 0,
      paused: false,
      engineState: { ...OFF_STATE }
    }
    this.session = session
    this.ctx.log.info('recording begin', { noteId, mic: opts.micLabel, system: opts.systemAudio, keep: session.keepRecordings })

    const channels: Channel[] = opts.systemAudio ? ['mic', 'system'] : ['mic']
    for (const ch of channels) {
      // Live chunk length follows the transcription profile (shorter on weak machines → lower latency per chunk).
      const liveChunkMs = this.transcription.liveChunkMs()
      session.chunkers[ch] = new SpeechChunker({ workDir, sampleRate: TARGET_RATE, filePrefix: ch, maxChunkMs: liveChunkMs, minChunkMs: Math.min(3000, liveChunkMs) })
      session.chunkers[ch]!.on('chunk', (chunk) => {
        if (session.live) session.live.feedWav(chunk.path, chunk.offsetMs, chunk.durationMs, ch)
        else this.safeRm(chunk.path)
      })
      if (session.keepRecordings) {
        const dir = join(this.ctx.paths.recordings, noteId)
        mkdirSync(dir, { recursive: true })
        session.writers[ch] = new WavFileWriter(join(dir, `${new Date(session.startedAt).toISOString().replace(/[:.]/g, '-')}-${ch}.wav`), TARGET_RATE, 1)
      }
    }

    // Transcription (optional). The service decides engine, model and threads from the resource plan.
    if (settings.transcription.enabled) {
      const { session: live, reason } = await this.transcription.startLive({
        noteId,
        workDir,
        vocabulary: settings.transcription.customVocabulary,
        language: settings.transcription.language
      })
      session.live = live
      session.liveReason = reason
      session.liveStatus = live ? live.status() : null
      session.engineState = live ? toLegacyState(live.status()) : { engine: 'none', status: 'off', queuedChunks: 0, recognizedSegments: 0, lastError: reason }
      if (reason) this.ctx.log.warn('recording: live transcription unavailable', { reason })
    } else {
      session.liveReason = 'Transcription is turned off in Settings.'
    }

    this.status = 'recording'
    this.tick = setInterval(() => this.onTick(), 1000)
    this.publish()
    this.ctx.notesChanged([noteId])
    return this.getState()
  }

  pushChunk(chunk: AudioChunk): void {
    const s = this.session
    if (!s || this.status !== 'recording' || s.paused) return
    if (chunk.sampleRate !== TARGET_RATE) return // renderer is responsible for resampling to 16 kHz
    const ch: Channel = chunk.channel === 'system' ? 'system' : 'mic'
    const pcm = new Int16Array(chunk.pcm.slice(0))
    const durationMs = (pcm.length / TARGET_RATE) * 1000
    s.lastOffsetMs = Math.max(s.lastOffsetMs, chunk.offsetMs + durationMs)
    if (rmsLevel(pcm) > 0.01) s.lastLoudMs = s.lastOffsetMs
    s.writers[ch]?.append(pcm)
    s.chunkers[ch]?.push(pcm, chunk.offsetMs)
  }

  async pause(): Promise<RecordingState> {
    if (this.session && this.status === 'recording') {
      this.session.paused = true
      this.status = 'paused'
      this.publish()
    }
    return this.getState()
  }

  async resume(): Promise<RecordingState> {
    if (this.session && this.status === 'paused') {
      this.session.paused = false
      this.status = 'recording'
      this.publish()
    }
    return this.getState()
  }

  async reportError(message: string): Promise<RecordingState> {
    this.ctx.log.error('renderer capture error', message)
    this.error = message
    if (this.session) await this.end('error')
    else {
      this.status = 'error'
      this.publish()
      setTimeout(() => {
        if (this.status === 'error') {
          this.status = 'idle'
          this.publish()
        }
      }, 6000)
    }
    return this.getState()
  }

  async end(reason = 'user'): Promise<RecordingState> {
    const s = this.session
    if (!s) return this.getState()
    this.status = 'stopping'
    this.publish()
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    this.ctx.log.info('recording end', { reason, elapsedMs: s.lastOffsetMs })
    try {
      // flush() emits 'chunk' like any other cut, so the listener registered in begin() feeds the live session.
      for (const ch of Object.keys(s.chunkers) as Channel[]) s.chunkers[ch]!.flush()
      if (s.live) {
        s.engineState = { ...s.engineState, status: 'processing' }
        this.publish()
        const { deferredJobId } = await s.live.stop()
        if (deferredJobId) this.ctx.log.info('recording: remaining audio queued for background transcription', { deferredJobId })
      }
      for (const ch of Object.keys(s.writers) as Channel[]) {
        const w = s.writers[ch]!
        const info = w.finalize()
        if (info.dataBytes > 0) {
          const rec = this.ctx.transcripts.addRecording({
            noteId: s.noteId,
            path: info.path,
            startedAt: s.startedAt,
            durationMs: info.durationMs,
            sizeBytes: statSync(info.path).size,
            sampleRate: TARGET_RATE,
            channels: 1
          })
          const cfg = this.ctx.settings.get().transcription
          if (cfg.enabled && cfg.engine === 'whisper' && cfg.backgroundAfterMeeting && !s.live) {
            void this.transcription.enqueueRecording(s.noteId, rec.id).catch((err) => this.ctx.log.warn('recording: could not queue background transcription', (err as Error).message))
          }
        } else this.safeRm(info.path)
      }
    } catch (err) {
      this.error = (err as Error).message
      this.ctx.log.error('recording end failed', err)
    } finally {
      rmSync(s.workDir, { recursive: true, force: true })
      this.session = null
      this.status = this.error && reason === 'error' ? 'error' : 'idle'
      this.publish()
      this.ctx.notesChanged([s.noteId])
      if (this.status === 'error') {
        setTimeout(() => {
          if (this.status === 'error' && !this.session) {
            this.status = 'idle'
            this.error = null
            this.publish()
          }
        }, 8000)
      }
    }
    return this.getState()
  }

  private onTick(): void {
    const s = this.session
    if (!s || this.status !== 'recording') return
    const silenceMin = this.ctx.settings.get().audio.autoStopSilenceMin
    if (silenceMin > 0 && s.lastOffsetMs - s.lastLoudMs > silenceMin * 60_000 && s.lastOffsetMs > 60_000) {
      this.ctx.log.info('auto-stop after silence', { silenceMin })
      this.ctx.emit('captureCommand', { command: 'stop', noteId: s.noteId })
      return
    }
    this.publish()
  }

  private safeRm(path: string): void {
    try {
      if (existsSync(path)) rmSync(path, { force: true })
    } catch {
      /* ignore */
    }
  }

  /** Remove stale temp directories from crashed sessions. */
  cleanupTemp(): void {
    try {
      for (const name of readdirSync(this.ctx.paths.temp)) {
        if (name.startsWith('rec-')) rmSync(join(this.ctx.paths.temp, name), { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
  }

  deleteRecording(id: string): void {
    const rec = this.ctx.transcripts.getRecording(id)
    if (!rec) return
    this.safeRm(rec.path)
    this.ctx.transcripts.deleteRecording(id)
  }

  recordingsBytes(): number {
    let total = 0
    for (const r of this.ctx.transcripts.allRecordings()) {
      try {
        total += statSync(r.path).size
      } catch {
        /* missing file */
      }
    }
    return total
  }
}

function toLegacyState(st: LiveTranscriptionStatus): TranscriptionState {
  return {
    engine: st.engine,
    status: st.status === 'off' ? 'off' : st.status === 'error' ? 'error' : st.status === 'listening' ? 'listening' : st.status === 'lagging' ? 'processing' : 'processing',
    queuedChunks: st.queuedChunks,
    recognizedSegments: st.recognizedSegments,
    lastError: st.lastError
  }
}
