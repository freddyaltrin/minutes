// Orchestrates everything around speech recognition: configuration, model management, the
// resource plan, the single shared whisper.cpp worker, live sessions fed by the recorder, and the
// background job queue over saved audio. The renderer only ever sees typed status objects and
// talks to this service through validated IPC; it never controls native processes directly.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, basename, sep } from 'node:path'
import type { AppContext } from '../../context'
import { JobsRepo, type JobRecord, type JobSource } from '../../db/jobs-repo'
import { ModelManager, resolveModelsDir } from './model-manager'
import { MODEL_CATALOG, getCatalogEntry } from './model-catalog'
import { ResourceManager } from './resource-manager'
import { PROFILES, DEFAULT_CONFIG, recommendProfile } from './profiles'
import { inspectHardware, applyRuntimeFeatureHint, type HardwareProvider } from './hardware'
import { WhisperEngine, EngineError, runtimeDirFor, type WhisperSegment } from './whisper-engine'
import { planWindows, readWindow, isSilentPcm } from './audio-windows'
import { filterSegments } from './segment-filter'
import { SapiEngine } from '../transcription/sapi-engine'
import type {
  EngineStatus,
  HardwareInfo,
  LiveTranscriptionStatus,
  ModelState,
  ResourcePlan,
  TranscriptionConfig,
  TranscriptionJob
} from '@shared/transcription-types'
import type { TranscriptSegment } from '@shared/types'

const LIVE_FINISH_INLINE_MS = 45_000
const RECENT_WINDOW = 8

export interface LiveSessionOptions {
  noteId: string
  workDir: string
  vocabulary: string[]
  language: string | null
}

/** What the recorder needs from a live session, independent of the engine behind it. */
export interface LiveSession {
  feedWav(path: string, offsetMs: number, durationMs: number, channel: 'mic' | 'system'): void
  /** Resolves when processing has finished or remaining audio has been handed to a background job. */
  stop(): Promise<{ deferredJobId: string | null }>
  status(): LiveTranscriptionStatus
}

export interface TranscriptionServiceEvents {
  liveStatus: [LiveTranscriptionStatus]
  jobs: [TranscriptionJob[]]
  models: [ModelState[]]
}

export class TranscriptionService extends EventEmitter<TranscriptionServiceEvents> {
  readonly models: ModelManager
  readonly resources: ResourceManager
  readonly engine: WhisperEngine
  readonly jobs: JobsRepo
  private hw: HardwareInfo
  private hwAt = 0
  private cpuVariant: string | null = null
  private live: WhisperLiveSession | null = null
  private sapiLive: SapiLiveSession | null = null
  private jobLoop: Promise<void> | null = null
  private kickPending = false
  private jobAbort: AbortController | null = null
  private runningJobId: string | null = null
  private pausedIds = new Set<string>()
  private engineRestarts = 0
  readonly pendingDir: string
  private readonly hardwareProvider: HardwareProvider | undefined

  constructor(
    private readonly ctx: AppContext,
    opts: {
      resourcesDir: string
      /** Injected for tests; defaults to a real whisper.cpp process host. */
      engine?: WhisperEngine
      /** Injected for tests; defaults to the OS-backed provider. */
      hardwareProvider?: HardwareProvider
    }
  ) {
    super()
    this.pendingDir = join(ctx.paths.userData, 'pending-audio')
    mkdirSync(this.pendingDir, { recursive: true })
    this.hardwareProvider = opts.hardwareProvider
    this.models = new ModelManager({ modelsDir: resolveModelsDir(ctx.paths.userData), log: ctx.log })
    this.models.inUse = (id) => this.engine.currentModelId === id && this.engine.isLoaded
    this.models.on('changed', () => this.emit('models', this.listModels()))
    this.models.on('progress', () => this.emit('models', this.listModels()))
    this.hw = inspectHardware(this.hardwareProvider)
    this.hwAt = Date.now()
    this.resources = new ResourceManager({ catalog: MODEL_CATALOG, hardware: () => this.hardware(), log: ctx.log })
    this.engine = opts.engine ?? new WhisperEngine({ runtimeDir: runtimeDirFor(opts.resourcesDir), log: ctx.log })
    this.engine.on('cpuVariant', (v) => {
      if (v !== this.cpuVariant) ctx.log.info('whisper: CPU backend variant', { variant: v })
      this.cpuVariant = v
      this.hw = applyRuntimeFeatureHint(this.hw, v)
    })
    this.engine.on('crashed', () => {
      this.live?.onEngineCrashed()
    })
    this.jobs = new JobsRepo(ctx.db)
    const recovered = this.jobs.recoverInterrupted()
    if (recovered) ctx.log.info('transcription: requeued interrupted jobs', { recovered })
    void this.models.cleanupTemp()
    this.cleanupOrphanPending()
  }

  // ---------- configuration ----------
  config(): TranscriptionConfig & { enabled: boolean } {
    const s = this.ctx.settings.get().transcription as Partial<TranscriptionConfig & { enabled: boolean }>
    return { ...DEFAULT_CONFIG, enabled: true, ...s }
  }

  setConfig(patch: Partial<TranscriptionConfig & { enabled: boolean }>): TranscriptionConfig & { enabled: boolean } {
    this.ctx.settings.set({ transcription: { ...this.config(), ...patch } } as never)
    this.emit('models', this.listModels())
    this.emit('liveStatus', this.liveStatus())
    return this.config()
  }

  hardware(refresh = false): HardwareInfo {
    if (refresh || Date.now() - this.hwAt > 30_000) {
      this.hw = inspectHardware(this.hardwareProvider)
      if (this.cpuVariant) this.hw = applyRuntimeFeatureHint(this.hw, this.cpuVariant)
      this.hwAt = Date.now()
    }
    return this.hw
  }

  /** Live chunk target length for the active profile (ms). */
  liveChunkMs(): number {
    return PROFILES[this.config().profile].liveChunkMs
  }

  recommendedProfile(): ReturnType<typeof recommendProfile> {
    return recommendProfile(this.hardware())
  }

  private activeJobBytes(): number {
    const id = this.engine.currentModelId
    if (!id || !this.engine.isLoaded) return 0
    return this.engine.workerMemoryBytes() ?? getCatalogEntry(id)?.runtimeMemoryBytes ?? 0
  }

  plan(): ResourcePlan {
    const cfg = this.config()
    return this.resources.plan(cfg, this.models.list(), this.engine.isLoaded ? 0 : this.activeJobBytes())
  }

  listModels(): ModelState[] {
    const cfg = this.config()
    const hw = this.hardware()
    const profile = PROFILES[cfg.profile]
    const threads = this.resources.threadsFor(hw, profile, cfg)
    const budget = this.resources.budget(hw, profile, 0)
    return this.models.list().map((m) => ({ ...m, eligibility: this.resources.eligibility(m, budget, hw, threads) }))
  }

  engineStatus(): EngineStatus {
    const st = this.engine.status()
    return { ...st, workerMemoryBytes: this.engine.workerMemoryBytes(), cpuVariant: this.cpuVariant }
  }

  // ---------- live ----------
  liveStatus(): LiveTranscriptionStatus {
    if (this.live) return this.live.status()
    if (this.sapiLive) return this.sapiLive.status()
    const cfg = this.config()
    return {
      engine: cfg.enabled ? cfg.engine : 'none',
      modelId: this.engine.currentModelId,
      status: 'off',
      backlogMs: 0,
      queuedChunks: 0,
      recentRtf: null,
      recognizedSegments: 0,
      threads: 0,
      lastError: null,
      deferredToBackground: false
    }
  }

  /**
   * Starts a live session for a recording. Returns null (with a reason) when transcription is off or
   * unavailable, so the recorder can continue without it and the UI can say why.
   */
  async startLive(opts: LiveSessionOptions): Promise<{ session: LiveSession | null; reason: string | null }> {
    const cfg = this.config()
    if (!cfg.enabled || cfg.engine === 'none') return { session: null, reason: 'Transcription is turned off in Settings.' }
    if (this.live || this.sapiLive) return { session: null, reason: 'Another live transcription is already running.' }
    if (cfg.engine === 'windows-sapi') {
      const info = await SapiEngine.probe()
      if (!info.available) return { session: null, reason: info.detail }
      const s = new SapiLiveSession(this.ctx, opts, () => (this.sapiLive = null))
      try {
        await s.start(cfg.language, cfg.customVocabulary)
      } catch (err) {
        return { session: null, reason: (err as Error).message }
      }
      this.sapiLive = s
      return { session: s, reason: null }
    }
    // whisper
    const rt = this.engine.runtimeAvailable()
    if (!rt.ok) return { session: null, reason: rt.detail }
    const plan = this.plan()
    if (!plan.modelId) return { session: null, reason: plan.rationale.join(' ') || 'No eligible model is installed.' }
    const gate = this.resources.canStartJob('live', this.runningJobs(), PROFILES[cfg.profile])
    let pausedForLive: string | null = null
    if (!gate.ok) {
      // Live wins: pause the background job at its next chunk boundary; it resumes when live ends.
      if (this.runningJobId) {
        pausedForLive = this.runningJobId
        this.pauseJob(this.runningJobId)
      }
    }
    try {
      await this.ensureModel(plan.modelId, plan.threads)
    } catch (err) {
      if (pausedForLive) this.resumeJob(pausedForLive)
      return { session: null, reason: `Could not load model ${plan.modelId}: ${(err as Error).message}` }
    }
    this.engineRestarts = 0 // restart budget is per session, even when the model was already loaded
    const session = new WhisperLiveSession(this, opts, plan, cfg.language, cfg.customVocabulary.join(', '))
    this.live = session
    session.on('status', (st) => this.emit('liveStatus', st))
    session.on('done', () => {
      this.live = null
      this.emit('liveStatus', this.liveStatus())
      if (pausedForLive) this.resumeJob(pausedForLive) // no-op unless it is still paused
      this.kickJobs()
    })
    this.emit('liveStatus', session.status())
    return { session, reason: null }
  }

  private async ensureModel(modelId: string, threads: number): Promise<void> {
    if (this.engine.isLoaded && this.engine.currentModelId === modelId && this.engine.currentThreads === threads) return
    const path = this.models.getInstalledPath(modelId)
    if (!path) throw new Error('model file is not installed')
    await this.engine.load(modelId, path, threads)
    this.engineRestarts = 0
  }

  /** Called by a live session after a crash: at most two restarts per session. */
  async recoverEngine(modelId: string, threads: number): Promise<boolean> {
    if (this.engineRestarts >= 2) return false
    this.engineRestarts++
    try {
      const path = this.models.getInstalledPath(modelId)
      if (!path) return false
      await this.engine.load(modelId, path, threads)
      return true
    } catch (err) {
      this.ctx.log.error('transcription: engine restart failed', err)
      return false
    }
  }

  /** Persists segments for a note and notifies the renderer. */
  storeSegments(noteId: string, source: 'live' | 'background', modelId: string, segs: { startMs: number; endMs: number; text: string; channel: 'mic' | 'system' | 'unknown'; confidence: number | null }[]): TranscriptSegment[] {
    if (segs.length === 0) return []
    const t = this.ctx.transcripts.ensure(noteId, source, `whisper:${modelId}`, this.config().language)
    const stored = this.ctx.transcripts.appendSegments(
      noteId,
      t.id,
      segs.map((s) => ({ text: s.text, startMs: Math.round(s.startMs), endMs: Math.round(s.endMs), channel: s.channel, confidence: s.confidence }))
    )
    if (stored.length) this.ctx.emit('transcriptSegments', { noteId, segments: stored })
    return stored
  }

  /** Moves leftover live chunk files out of the recorder's temp dir and queues a job over them. */
  deferSources(noteId: string, sources: JobSource[], kind: 'background' = 'background'): JobRecord | null {
    if (sources.length === 0) return null
    const dir = join(this.pendingDir, noteId)
    mkdirSync(dir, { recursive: true })
    const moved: JobSource[] = []
    for (const s of sources) {
      try {
        const dest = join(dir, basename(s.path))
        renameSync(s.path, dest)
        moved.push({ ...s, path: dest })
      } catch (err) {
        this.ctx.log.error('transcription: could not preserve chunk', { path: s.path, err: (err as Error).message })
      }
    }
    if (moved.length === 0) return null
    const job = this.jobs.create({ kind, noteId, recordingId: null, modelId: null, sources: moved })
    this.ctx.log.info('transcription: deferred live audio to background job', { jobId: job.id, chunks: moved.length })
    this.emitJobs()
    this.kickJobs()
    return job
  }

  // ---------- background jobs ----------
  listJobs(): TranscriptionJob[] {
    return this.jobs.list({ limit: 100 }).map(toPublicJob)
  }

  private emitJobs(): void {
    this.emit('jobs', this.listJobs())
  }

  private runningJobs(): { kind: 'live' | 'background'; bytes: number; paused?: boolean }[] {
    const out: { kind: 'live' | 'background'; bytes: number; paused?: boolean }[] = []
    if (this.live || this.sapiLive) out.push({ kind: 'live', bytes: this.activeJobBytes() })
    if (this.runningJobId) out.push({ kind: 'background', bytes: this.activeJobBytes(), paused: this.pausedIds.has(this.runningJobId) })
    return out
  }

  async enqueueRecording(noteId: string, recordingId: string): Promise<TranscriptionJob> {
    const rec = this.ctx.transcripts.getRecording(recordingId)
    if (!rec) throw new Error('Recording not found')
    if (this.jobs.existsFor(noteId, recordingId)) throw new Error('A transcription job for this recording is already queued')
    const channel: JobSource['channel'] = /-mic\.wav$/i.test(rec.path) ? 'mic' : /-system\.wav$/i.test(rec.path) ? 'system' : 'unknown'
    const sources = await planWindows(rec.path, { channel })
    if (sources.length === 0) throw new Error('The recording is empty')
    const job = this.jobs.create({ kind: 'background', noteId, recordingId, modelId: null, sources })
    this.emitJobs()
    this.kickJobs()
    return toPublicJob(job)
  }

  pauseJob(id: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    if (j.status === 'running') {
      this.pausedIds.add(id)
      this.jobs.setStatus(id, 'paused')
    } else if (j.status === 'queued') this.jobs.setStatus(id, 'paused')
    this.emitJobs()
  }

  resumeJob(id: string): void {
    const j = this.jobs.get(id)
    if (!j || j.status !== 'paused') return
    this.pausedIds.delete(id)
    this.jobs.setStatus(id, 'queued')
    this.emitJobs()
    this.kickJobs()
  }

  cancelJob(id: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    if (this.runningJobId === id) this.jobAbort?.abort()
    this.pausedIds.delete(id)
    this.jobs.setStatus(id, 'cancelled')
    this.emitJobs()
  }

  retryJob(id: string): void {
    const j = this.jobs.get(id)
    if (!j || (j.status !== 'failed' && j.status !== 'cancelled')) return
    this.jobs.requeue(id)
    this.emitJobs()
    this.kickJobs()
  }

  removeJob(id: string): void {
    const j = this.jobs.get(id)
    if (!j) return
    if (j.status === 'running') this.cancelJob(id)
    this.jobs.remove(id)
    this.deletePendingFiles(j)
    this.emitJobs()
  }

  private deletePendingFiles(j: JobRecord): void {
    for (const s of j.sources) {
      if (s.path.startsWith(this.pendingDir + sep)) {
        try {
          rmSync(s.path, { force: true })
        } catch {
          /* ignore */
        }
      }
    }
    const dir = join(this.pendingDir, j.noteId)
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  /** Deletes pending-audio files no job refers to any more (crash leftovers). */
  private cleanupOrphanPending(): void {
    const referenced = new Set(this.jobs.activeSourcePaths())
    try {
      for (const noteDir of readdirSync(this.pendingDir)) {
        const dir = join(this.pendingDir, noteDir)
        for (const f of readdirSync(dir)) {
          const p = join(dir, f)
          if (!referenced.has(p)) rmSync(p, { force: true })
        }
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      /* ignore */
    }
  }

  kickJobs(): void {
    if (this.jobLoop) {
      // A kick while the loop is winding down (e.g. the live 'done' handler right after
      // deferSources kicked) must not be lost: run the loop once more when it settles.
      this.kickPending = true
      return
    }
    this.kickPending = false
    this.jobLoop = this.runJobs().finally(() => {
      this.jobLoop = null
      if (this.kickPending) this.kickJobs()
    })
  }

  private async runJobs(): Promise<void> {
    for (;;) {
      const cfg = this.config()
      if (!cfg.enabled || cfg.engine !== 'whisper') return
      if (this.live || this.sapiLive) return
      const job = this.jobs.nextQueued()
      if (!job) return
      const gate = this.resources.canStartJob('background', this.runningJobs(), PROFILES[cfg.profile])
      if (!gate.ok) return
      await this.runJob(job)
    }
  }

  private async runJob(job: JobRecord): Promise<void> {
    const cfg = this.config()
    const plan = this.plan()
    if (!plan.modelId) {
      this.jobs.setStatus(job.id, 'failed', { error: plan.rationale.join(' ') || 'No eligible model is installed.' })
      this.emitJobs()
      return
    }
    this.runningJobId = job.id
    this.jobAbort = new AbortController()
    const signal = this.jobAbort.signal
    this.jobs.setStatus(job.id, 'running', { modelId: plan.modelId })
    this.emitJobs()
    const t0 = Date.now()
    let processed = job.processedMs
    let elapsedBase = job.elapsedMs
    let written = job.segmentsWritten
    const prompts: Record<string, string> = {}
    const vocabulary = cfg.customVocabulary.join(', ')
    const language = languageFor(plan.modelId, cfg.language)
    try {
      await this.ensureModel(plan.modelId, plan.threads)
      for (let i = job.nextIndex; i < job.sources.length; i++) {
        if (signal.aborted) throw new EngineError('cancelled', 'ABORTED')
        if (this.pausedIds.has(job.id)) {
          this.jobs.progress(job.id, { processedMs: processed, elapsedMs: elapsedBase + (Date.now() - t0), segmentsWritten: written, nextIndex: i })
          this.emitJobs()
          return
        }
        if (this.live || this.sapiLive) {
          // A live recording started: yield at this boundary, keep everything for later.
          this.jobs.progress(job.id, { processedMs: processed, elapsedMs: elapsedBase + (Date.now() - t0), segmentsWritten: written, nextIndex: i })
          this.jobs.setStatus(job.id, 'queued')
          this.emitJobs()
          return
        }
        const src = job.sources[i]
        const pcm = await readWindow(src)
        if (!isSilentPcm(pcm)) {
          const raw = await this.engine.transcribePcm(pcm, { language, prompt: buildPrompt(vocabulary, prompts[src.channel]), signal })
          const f = filterSegments(raw, prompts[src.channel])
          if (f.droppedRepeat || f.droppedEcho) this.ctx.log.info('transcription: dropped segments', { jobId: job.id, repeat: f.droppedRepeat, echo: f.droppedEcho })
          const segs = f.kept
          const abs = segs.map((s) => ({ ...s, startMs: src.offsetMs + s.startMs, endMs: src.offsetMs + s.endMs, channel: src.channel }))
          const stored = this.storeSegments(job.noteId, 'background', plan.modelId, abs)
          written += stored.length
          if (f.resetContext) prompts[src.channel] = ''
          else if (segs.length) prompts[src.channel] = segs.map((s) => s.text).join(' ').slice(-300)
        }
        processed += src.durationMs
        this.jobs.progress(job.id, { processedMs: processed, elapsedMs: elapsedBase + (Date.now() - t0), segmentsWritten: written, nextIndex: i + 1 })
        this.emitJobs()
      }
      this.jobs.setStatus(job.id, 'completed')
      this.ctx.log.info('transcription: job completed', { jobId: job.id, processedMs: processed, elapsedMs: elapsedBase + (Date.now() - t0) })
      this.deletePendingFiles(this.jobs.get(job.id)!)
      this.ctx.notesChanged([job.noteId])
    } catch (err) {
      const e = err as EngineError
      if (e.code === 'ABORTED') {
        if (this.jobs.get(job.id)?.status === 'running') this.jobs.setStatus(job.id, 'cancelled')
      } else {
        this.jobs.setStatus(job.id, 'failed', { error: e.message })
        this.ctx.log.error('transcription: job failed', { jobId: job.id, err: e.message })
      }
    } finally {
      this.runningJobId = null
      this.jobAbort = null
      this.emitJobs()
    }
  }

  async shutdown(): Promise<void> {
    this.jobAbort?.abort()
    if (this.live) await this.live.stop()
    if (this.sapiLive) await this.sapiLive.stop()
    await this.engine.stop()
  }
}

/**
 * Language parameter for whisper.cpp: ".en" models only know English (sending anything else is
 * ignored with a warning), multilingual models auto-detect when no language is configured.
 */
export function languageFor(modelId: string, configured: string | null): string {
  const entry = getCatalogEntry(modelId)
  if (entry?.english_only) return 'en'
  return configured && configured !== 'auto' ? configured : 'auto'
}

/** Prompt = custom vocabulary (always) + the tail of the previous window (context). */
export function buildPrompt(vocabulary: string, previous: string | undefined): string | undefined {
  const parts = [vocabulary.trim(), (previous ?? '').trim()].filter(Boolean)
  if (parts.length === 0) return undefined
  return parts.join('. ').slice(-600)
}

function toPublicJob(j: JobRecord): TranscriptionJob {
  const { sources: _s, nextIndex: _n, ...pub } = j
  return pub
}

// ---------- whisper live session ----------
interface QueuedChunk {
  path: string
  offsetMs: number
  durationMs: number
  channel: 'mic' | 'system'
}

class WhisperLiveSession extends EventEmitter<{ status: [LiveTranscriptionStatus]; done: [] }> implements LiveSession {
  private queue: QueuedChunk[] = []
  private inFlight: QueuedChunk | null = null
  private pumping = false
  private stopped = false
  private deferred = false
  private error: string | null = null
  private recognized = 0
  private recent: { audioMs: number; procMs: number }[] = []
  private processedChunks = 0
  private prompts: Record<string, string> = {}
  private stopResolve: ((r: { deferredJobId: string | null }) => void) | null = null
  private crashed = false

  constructor(
    private readonly svc: TranscriptionService,
    private readonly opts: LiveSessionOptions,
    private readonly plan: ResourcePlan,
    private readonly language: string | null,
    vocabulary: string
  ) {
    super()
    this.vocabulary = vocabulary
  }
  private readonly vocabulary: string

  status(): LiveTranscriptionStatus {
    const backlogMs = this.queue.reduce((a, c) => a + c.durationMs, 0) + (this.inFlight?.durationMs ?? 0)
    const recentRtf = this.recent.length ? this.recent.reduce((a, r) => a + r.procMs, 0) / Math.max(1, this.recent.reduce((a, r) => a + r.audioMs, 0)) : null
    let status: LiveTranscriptionStatus['status'] = 'listening'
    if (this.error) status = 'error'
    else if (this.deferred || this.svc.resources.adapt({ backlogMs, recentRtf, chunkMs: PROFILES[this.plan.profile].liveChunkMs }, PROFILES[this.plan.profile]).action === 'warn-lagging') status = 'lagging'
    else if (this.inFlight || this.queue.length) status = 'processing'
    return {
      engine: 'whisper',
      modelId: this.plan.modelId,
      status,
      backlogMs,
      queuedChunks: this.queue.length + (this.inFlight ? 1 : 0),
      recentRtf,
      recognizedSegments: this.recognized,
      threads: this.plan.threads,
      lastError: this.error,
      deferredToBackground: this.deferred
    }
  }

  private publish(): void {
    this.emit('status', this.status())
  }

  feedWav(path: string, offsetMs: number, durationMs: number, channel: 'mic' | 'system'): void {
    if (this.stopped) return
    this.queue.push({ path, offsetMs, durationMs, channel })
    const verdict = this.svc.resources.adapt(
      { backlogMs: this.status().backlogMs, recentRtf: this.status().recentRtf, chunkMs: PROFILES[this.plan.profile].liveChunkMs },
      PROFILES[this.plan.profile]
    )
    if (verdict.action === 'defer-to-background' && !this.deferred) {
      this.deferred = true
      this.svc['ctx'].log.warn('transcription: live processing cannot keep up; remaining audio will be transcribed after the meeting', { reason: verdict.reason })
    }
    this.publish()
    void this.pump()
  }

  onEngineCrashed(): void {
    this.crashed = true
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.queue.length && !this.deferred) {
        if (this.crashed) {
          const ok = await this.svc.recoverEngine(this.plan.modelId!, this.plan.threads)
          if (!ok) {
            this.error = 'The transcription process stopped and could not be restarted; remaining audio will be transcribed after the meeting.'
            this.deferred = true
            this.publish()
            break
          }
          this.crashed = false
        }
        const chunk = this.queue.shift()!
        this.inFlight = chunk
        this.publish()
        const t0 = Date.now()
        try {
          const raw = await this.svc.engine.transcribeWavFile(chunk.path, {
            language: languageFor(this.plan.modelId!, this.language),
            prompt: buildPrompt(this.vocabulary, this.prompts[chunk.channel])
          })
          const f = filterSegments(raw, this.prompts[chunk.channel])
          if (f.droppedRepeat || f.droppedEcho) this.svc['ctx'].log.info('transcription: dropped live segments', { repeat: f.droppedRepeat, echo: f.droppedEcho })
          const segs = f.kept
          const abs = segs.map((s) => ({ ...s, startMs: chunk.offsetMs + s.startMs, endMs: chunk.offsetMs + s.endMs, channel: chunk.channel }))
          const stored = this.svc.storeSegments(this.opts.noteId, 'live', this.plan.modelId!, abs)
          this.recognized += stored.length
          if (f.resetContext) this.prompts[chunk.channel] = ''
          else if (segs.length) this.prompts[chunk.channel] = segs.map((s) => s.text).join(' ').slice(-300)
          rmSync(chunk.path, { force: true })
        } catch (err) {
          const e = err as EngineError
          if (e.code === 'CRASHED' || e.code === 'NOT_LOADED') {
            this.crashed = true
            this.queue.unshift(chunk) // keep the audio; retry after restart
          } else {
            this.error = e.message
            this.queue.unshift(chunk)
            this.deferred = true
            this.svc['ctx'].log.error('transcription: live chunk failed', { err: e.message })
          }
        } finally {
          // The first request after a model load pays for graph allocation and page-in; it says
          // nothing about steady-state speed, so it is excluded from the RTF window.
          if (this.processedChunks++ > 0) {
            this.recent.push({ audioMs: chunk.durationMs, procMs: Date.now() - t0 })
            if (this.recent.length > RECENT_WINDOW) this.recent.shift()
          }
          this.inFlight = null
          this.publish()
        }
      }
    } finally {
      this.pumping = false
      if (this.stopped) this.finish()
    }
  }

  async stop(): Promise<{ deferredJobId: string | null }> {
    if (this.stopped) return { deferredJobId: null }
    this.stopped = true
    const backlog = this.status().backlogMs
    // Small backlogs finish inline (the recorder shows "Finishing"); large ones become a job.
    if (!this.deferred && backlog > LIVE_FINISH_INLINE_MS) this.deferred = true
    return new Promise((resolve) => {
      this.stopResolve = resolve
      if (!this.pumping) this.finish()
    })
  }

  private finish(): void {
    const leftovers: QueuedChunk[] = [...(this.inFlight ? [this.inFlight] : []), ...this.queue]
    this.queue = []
    this.inFlight = null
    let jobId: string | null = null
    if (leftovers.length) {
      const job = this.svc.deferSources(
        this.opts.noteId,
        leftovers.map((c) => ({ path: c.path, offsetMs: c.offsetMs, durationMs: c.durationMs, channel: c.channel }))
      )
      jobId = job?.id ?? null
    }
    this.publish()
    this.emit('done')
    this.stopResolve?.({ deferredJobId: jobId })
    this.stopResolve = null
  }
}

// ---------- Windows SAPI live session (conventional recognizer kept as an optional engine) ----------
class SapiLiveSession implements LiveSession {
  private engine = new SapiEngine()
  private recognized = 0
  private lastError: string | null = null
  private queued = 0
  constructor(private readonly ctx: AppContext, private readonly opts: LiveSessionOptions, private readonly onDone: () => void) {}

  async start(language: string | null, vocabulary: string[]): Promise<void> {
    this.engine.on('segment', (seg) => {
      const t = this.ctx.transcripts.ensure(this.opts.noteId, 'live', 'windows-sapi', language)
      const stored = this.ctx.transcripts.appendSegments(this.opts.noteId, t.id, [
        { text: seg.text, startMs: Math.round(seg.startMs), endMs: Math.round(seg.endMs), channel: seg.channel === 'system' ? 'system' : 'mic', confidence: seg.confidence }
      ])
      this.recognized += stored.length
      if (stored.length) this.ctx.emit('transcriptSegments', { noteId: this.opts.noteId, segments: stored })
    })
    this.engine.on('queue', (n) => (this.queued = n))
    this.engine.on('error', (e) => (this.lastError = e.message))
    this.engine.on('log', (level, msg) => this.ctx.log.write(level, 'sapi: ' + msg))
    await this.engine.start({ culture: language, vocabulary, workDir: this.opts.workDir })
  }

  feedWav(path: string, offsetMs: number, _durationMs: number, channel: 'mic' | 'system'): void {
    this.engine.feedWav(path, offsetMs, channel)
  }

  async stop(): Promise<{ deferredJobId: string | null }> {
    await this.engine.stop()
    this.onDone()
    return { deferredJobId: null }
  }

  status(): LiveTranscriptionStatus {
    const st = this.engine.getState()
    return {
      engine: 'windows-sapi',
      modelId: null,
      status: st.status === 'error' ? 'error' : st.status === 'processing' ? 'processing' : 'listening',
      backlogMs: 0,
      queuedChunks: this.queued,
      recentRtf: null,
      recognizedSegments: this.recognized,
      threads: 1,
      lastError: this.lastError ?? st.lastError,
      deferredToBackground: false
    }
  }
}
