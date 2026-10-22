// TranscriptionService orchestration over a scripted FakeWhisperEngine: resource planning against
// fake hardware, live sessions, crash containment, lag deferral, the background job runner and the
// single-model policy. No whisper.cpp runtime, no real model files (a dummy file under
// <userData>/models/whisper/ counts as "installed"; the sha256 check only runs in verify/download).
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../../src/main/db/database'
import { NotesRepo } from '../../../src/main/db/notes-repo'
import { TranscriptsRepo } from '../../../src/main/db/transcripts-repo'
import { SettingsRepo } from '../../../src/main/db/settings-repo'
import { JobsRepo } from '../../../src/main/db/jobs-repo'
import { TranscriptionService } from '../../../src/main/services/whisper/transcription-service'
import { modelFileName } from '../../../src/main/services/whisper/model-catalog'
import { planWindows } from '../../../src/main/services/whisper/audio-windows'
import { buildWavHeader } from '../../../src/main/services/transcription/wav'
import type { HardwareProvider } from '../../../src/main/services/whisper/hardware'
import type { AppContext } from '../../../src/main/context'
import type { TranscriptionConfig } from '@shared/transcription-types'
import { FakeWhisperEngine, fakeEngine } from './fake-engine'

const GB = 1024 ** 3
const BYTES_PER_MS = 32 // 16 kHz mono PCM16

// ------------------------------------------------------------------ helpers

interface HwSpec {
  totalGb: number
  availableGb: number
  cores: number
  avx2: boolean
}

function hwProvider(spec: HwSpec): HardwareProvider {
  const total = spec.totalGb * GB
  const available = spec.availableGb * GB
  return {
    platform: () => 'linux',
    arch: () => 'x64',
    cpus: () => Array.from({ length: spec.cores }, () => ({ model: 'Intel(R) Core(TM) Fake' })),
    totalmem: () => total,
    freemem: () => available,
    readMeminfo: () => `MemTotal:       ${total / 1024} kB\nMemFree:        ${available / 1024} kB\nMemAvailable:   ${available / 1024} kB\n`,
    readCpuinfo: () => `model name\t: Intel(R) Core(TM) Fake\nflags\t\t: fpu sse sse2 sse4_2 avx${spec.avx2 ? ' avx2 fma f16c' : ''}\n`,
    env: () => ({}),
    cpuFeaturesHint: null,
    now: () => Date.now()
  }
}

const HW_16GB: HwSpec = { totalGb: 16, availableGb: 10, cores: 8, avx2: true }
const HW_8GB_WEAK: HwSpec = { totalGb: 8, availableGb: 1.75, cores: 2, avx2: false }

interface Ctx {
  ctx: AppContext
  db: Database
  userData: string
  emitted: { name: string; payload: unknown }[]
  notesChanged: string[][]
}

function makeCtx(): Ctx {
  const userData = mkdtempSync(join(tmpdir(), 'minutes-unit-ts-'))
  mkdirSync(join(userData, 'data'), { recursive: true })
  mkdirSync(join(userData, 'recordings'), { recursive: true })
  mkdirSync(join(userData, 'tmp'), { recursive: true })
  const db = new Database(join(userData, 'data', 'minutes.sqlite'))
  const emitted: { name: string; payload: unknown }[] = []
  const notesChanged: string[][] = []
  const log = { info: () => {}, warn: () => {}, error: () => {}, write: () => {} }
  const ctx = {
    db,
    notes: new NotesRepo(db),
    transcripts: new TranscriptsRepo(db),
    settings: new SettingsRepo(db),
    log,
    paths: { userData, temp: join(userData, 'tmp'), recordings: join(userData, 'recordings') },
    emit: (name: string, payload?: unknown) => emitted.push({ name, payload }),
    notesChanged: (ids: string[]) => notesChanged.push(ids)
  } as unknown as AppContext
  return { ctx, db, userData, emitted, notesChanged }
}

function installModels(userData: string, ids: string[]): void {
  const dir = join(userData, 'models', 'whisper')
  mkdirSync(dir, { recursive: true })
  for (const id of ids) writeFileSync(join(dir, modelFileName(id)), 'not a real model; list() only checks existence')
}

interface Harness extends Ctx {
  svc: TranscriptionService
  fake: FakeWhisperEngine
  liveStatuses: string[]
}

const DEFAULT_INSTALLED = ['tiny.en-q5_1', 'base.en-q5_1', 'small.en-q5_1']

function harness(opts: { hw?: HwSpec; installed?: string[]; config?: Partial<TranscriptionConfig & { enabled: boolean }> } = {}): Harness {
  const c = makeCtx()
  installModels(c.userData, opts.installed ?? DEFAULT_INSTALLED)
  const { fake, engine } = fakeEngine()
  const svc = new TranscriptionService(c.ctx, { resourcesDir: join(c.userData, 'resources'), engine, hardwareProvider: hwProvider(opts.hw ?? HW_16GB) })
  const liveStatuses: string[] = []
  svc.on('liveStatus', (st) => liveStatuses.push(st.status))
  svc.setConfig({ engine: 'whisper', profile: 'balanced', enabled: true, ...opts.config })
  liveStatuses.length = 0 // setConfig itself re-emits the (off) live status
  return { ...c, svc, fake, liveStatuses }
}

/** Writes a 16 kHz mono PCM16 WAV of `ms` milliseconds; silent, or a 440 Hz tone when `loud`. */
function writeChunk(path: string, ms: number, loud = false): void {
  const pcm = Buffer.alloc(ms * BYTES_PER_MS)
  if (loud) fillTone(pcm, 0, pcm.length)
  writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 16000, 1), pcm]))
}

function fillTone(pcm: Buffer, from: number, to: number): void {
  for (let i = from; i + 1 < to; i += 2) {
    const n = i / 2
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * n) / 16000) * 12000), i)
  }
}

/** A silent recording with 1 s tone bursts starting at each of `burstsAtMs`. */
function writeRecording(path: string, totalMs: number, burstsAtMs: number[]): void {
  const pcm = Buffer.alloc(totalMs * BYTES_PER_MS)
  for (const at of burstsAtMs) fillTone(pcm, at * BYTES_PER_MS, Math.min(pcm.length, (at + 1000) * BYTES_PER_MS))
  writeFileSync(path, Buffer.concat([buildWavHeader(pcm.length, 16000, 1), pcm]))
}

function addRecording(h: Harness, noteId: string, path: string, durationMs: number) {
  return h.ctx.transcripts.addRecording({ noteId, path, startedAt: Date.now(), durationMs, sizeBytes: durationMs * BYTES_PER_MS + 44, sampleRate: 16000, channels: 1 })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(pred: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

function jobOf(h: Harness, id: string) {
  return h.svc.jobs.get(id)!
}

// -------------------------------------------------------------------- tests

describe('TranscriptionService (fake engine)', () => {
  const open: Harness[] = []
  const track = (h: Harness): Harness => {
    open.push(h)
    return h
  }
  afterEach(async () => {
    for (const h of open.splice(0)) {
      await h.svc.shutdown()
      h.db.close()
      rmSync(h.userData, { recursive: true, force: true })
    }
  })

  // 1 ------------------------------------------------------------------------
  describe('resource selection', () => {
    it('lightweight profile on an 8 GB / 2-core / no-AVX2 machine plans tiny', () => {
      const h = track(harness({ hw: HW_8GB_WEAK, config: { profile: 'lightweight' } }))
      const plan = h.svc.plan()
      expect(plan.modelId).toBe('tiny.en-q5_1')
      expect(plan.threads).toBe(1)
      expect(plan.hardware.totalMemoryBytes).toBe(8 * GB)
      expect(plan.hardware.features).not.toContain('avx2')
      expect(h.svc.recommendedProfile()).toBe('lightweight')
    })

    it('balanced profile on a 16 GB machine plans base', () => {
      const h = track(harness({ hw: HW_16GB, config: { profile: 'balanced' } }))
      const plan = h.svc.plan()
      expect(plan.modelId).toBe('base.en-q5_1')
      expect(plan.threads).toBe(4)
      expect(h.svc.recommendedProfile()).toBe('balanced')
    })

    it('pinned medium on 8 GB falls back when allowed and the rationale says so', () => {
      const h = track(harness({ hw: HW_8GB_WEAK, installed: [...DEFAULT_INSTALLED, 'medium.en-q5_0'], config: { profile: 'lightweight', modelId: 'medium.en-q5_0', allowFallback: true } }))
      const plan = h.svc.plan()
      expect(plan.modelId).toBe('tiny.en-q5_1')
      expect(plan.rationale.join(' ')).toMatch(/Pinned model medium\.en-q5_0 is needs .* fell back to tiny\.en-q5_1 \(fallback allowed\)/)
      const medium = plan.considered.find((c) => c.modelId === 'medium.en-q5_0')!
      expect(medium.installed).toBe(true)
      expect(medium.eligibility.eligible).toBe(false)
    })

    it('pinned medium with allowFallback=false selects nothing and startLive refuses without loading', async () => {
      const h = track(harness({ hw: HW_8GB_WEAK, installed: [...DEFAULT_INSTALLED, 'medium.en-q5_0'], config: { profile: 'lightweight', modelId: 'medium.en-q5_0', allowFallback: false } }))
      const plan = h.svc.plan()
      expect(plan.modelId).toBeNull()
      expect(plan.rationale.join(' ')).toMatch(/fallback is disabled; nothing selected/)
      const r = await h.svc.startLive({ noteId: 'n', workDir: h.userData, vocabulary: [], language: null })
      expect(r.session).toBeNull()
      expect(r.reason).toMatch(/fallback is disabled/)
      expect(h.fake.loadCalls).toHaveLength(0)
      expect(h.svc.liveStatus().status).toBe('off')
    })
  })

  // 2 ------------------------------------------------------------------------
  describe('startLive refusals', () => {
    const liveOpts = (h: Harness) => ({ noteId: h.ctx.notes.create({ title: 'x' }).id, workDir: h.userData, vocabulary: [], language: null })

    it('reports a reason when disabled, engine none, runtime missing, no model, or load fails — and never gets stuck', async () => {
      const h = track(harness())

      h.svc.setConfig({ enabled: false })
      let r = await h.svc.startLive(liveOpts(h))
      expect(r).toEqual({ session: null, reason: 'Transcription is turned off in Settings.' })

      h.svc.setConfig({ enabled: true, engine: 'none' })
      r = await h.svc.startLive(liveOpts(h))
      expect(r.session).toBeNull()
      expect(r.reason).toMatch(/turned off/)

      h.svc.setConfig({ engine: 'whisper' })
      h.fake.runtime = { ok: false, detail: 'Runtime not found at /nowhere' }
      r = await h.svc.startLive(liveOpts(h))
      expect(r).toEqual({ session: null, reason: 'Runtime not found at /nowhere' })
      h.fake.runtime = { ok: true, detail: 'fake' }

      h.fake.failLoad = true
      r = await h.svc.startLive(liveOpts(h))
      expect(r.session).toBeNull()
      expect(r.reason).toMatch(/^Could not load model base\.en-q5_1: fake load failure/)
      expect(h.fake.loadCalls).toHaveLength(1)
      expect(h.svc.liveStatus().status).toBe('off')
      expect(h.fake.isLoaded).toBe(false)

      // Not left in a 'live' state: the next attempt succeeds.
      h.fake.failLoad = false
      r = await h.svc.startLive(liveOpts(h))
      expect(r.reason).toBeNull()
      expect(r.session).not.toBeNull()
      expect(h.fake.isLoaded).toBe(true)
      expect(h.svc.liveStatus().status).toBe('listening')
      // A second concurrent session is refused while this one runs.
      const second = await h.svc.startLive(liveOpts(h))
      expect(second.reason).toMatch(/already running/)
      await r.session!.stop()
    })

    it('reports a reason when no model is installed', async () => {
      const h = track(harness({ installed: [] }))
      const r = await h.svc.startLive(liveOpts(h))
      expect(r.session).toBeNull()
      expect(r.reason).toMatch(/None of the models for this profile is installed/)
      expect(h.fake.loadCalls).toHaveLength(0)
    })
  })

  // 3 ------------------------------------------------------------------------
  it('live session happy path: segments stored with absolute offsets and channels, chunk files deleted', async () => {
    // Language and vocabulary come from settings (the recorder passes the same values in opts).
    const h = track(harness({ config: { language: 'en', customVocabulary: ['Dexterity'] } }))
    const note = h.ctx.notes.create({ title: 'live' })
    const workDir = join(h.userData, 'work')
    mkdirSync(workDir)
    const paths = [1, 2, 3].map((i) => join(workDir, `chunk-${i}.wav`))
    for (const p of paths) writeChunk(p, 1000)
    h.fake.segments = [
      { startMs: 100, endMs: 500, text: 'first', confidence: 0.8 },
      { startMs: 500, endMs: 900, text: 'second', confidence: null }
    ]

    const { session, reason } = await h.svc.startLive({ noteId: note.id, workDir, vocabulary: ['Dexterity'], language: 'en' })
    expect(reason).toBeNull()
    expect(h.fake.loadCalls).toEqual([{ modelId: 'base.en-q5_1', path: join(h.userData, 'models', 'whisper', 'ggml-base.en-q5_1.bin'), threads: 4 }])
    expect(session!.status()).toMatchObject({ engine: 'whisper', modelId: 'base.en-q5_1', status: 'listening', threads: 4, queuedChunks: 0 })

    session!.feedWav(paths[0], 0, 1000, 'mic')
    session!.feedWav(paths[1], 1000, 1000, 'system')
    session!.feedWav(paths[2], 2000, 1000, 'mic')
    expect(session!.status().status).toBe('processing')
    expect(session!.status().queuedChunks).toBe(3)
    expect(session!.status().backlogMs).toBe(3000)

    const r = await session!.stop()
    expect(r).toEqual({ deferredJobId: null })

    // Engine saw every chunk, in order, with the vocabulary as the first prompt.
    expect(h.fake.requests.map((q) => q.input)).toEqual(paths)
    expect(h.fake.requests[0].opts).toMatchObject({ language: 'en', prompt: 'Dexterity' })
    expect(h.fake.requests[2].opts.prompt).toBe('Dexterity. first second') // vocabulary is always kept, plus rolling context

    const t = h.ctx.transcripts.getByNote(note.id)!
    expect(t.transcript.source).toBe('live')
    expect(t.transcript.engine).toBe('whisper:base.en-q5_1')
    expect(t.segments.map((s) => [s.startMs, s.endMs, s.channel, s.text])).toEqual([
      [100, 500, 'mic', 'first'],
      [500, 900, 'mic', 'second'],
      [1100, 1500, 'system', 'first'],
      [1500, 1900, 'system', 'second'],
      [2100, 2500, 'mic', 'first'],
      [2500, 2900, 'mic', 'second']
    ])
    for (const p of paths) expect(existsSync(p)).toBe(false)
    expect(session!.status().recognizedSegments).toBe(6)

    const segEvents = h.emitted.filter((e) => e.name === 'transcriptSegments')
    expect(segEvents).toHaveLength(3)
    expect((segEvents[0].payload as { noteId: string }).noteId).toBe(note.id)

    // listening → processing → listening, then 'off' once the session is gone.
    expect(h.liveStatuses[0]).toBe('listening')
    expect(h.liveStatuses).toContain('processing')
    expect(h.liveStatuses.at(-1)).toBe('off')
    expect(h.liveStatuses.at(-2)).toBe('listening')
    expect(h.svc.liveStatus().status).toBe('off')
    expect(h.svc.listJobs()).toHaveLength(0)
  })

  // 4 ------------------------------------------------------------------------
  describe('crash containment', () => {
    it('restarts the engine after a crash and retries the chunk; the restart budget is per session', async () => {
      const h = track(harness())
      const note = h.ctx.notes.create({ title: 'crash' })
      const workDir = join(h.userData, 'work')
      mkdirSync(workDir)
      const paths = [1, 2, 3].map((i) => join(workDir, `c-${i}.wav`))
      for (const p of paths) writeChunk(p, 1000)

      const { session } = await h.svc.startLive({ noteId: note.id, workDir, vocabulary: [], language: null })
      session!.feedWav(paths[0], 0, 1000, 'mic')
      await until(() => session!.status().recognizedSegments === 1, 2000, 'first chunk')
      h.fake.crashNext()
      session!.feedWav(paths[1], 1000, 1000, 'mic')
      session!.feedWav(paths[2], 2000, 1000, 'mic')
      const r = await session!.stop()
      expect(r.deferredJobId).toBeNull()

      expect(h.fake.loadCalls).toHaveLength(2) // initial load + one restart
      expect(h.fake.requests.filter((q) => q.input === paths[1])).toHaveLength(2) // crashed, then retried
      const segs = h.ctx.transcripts.getByNote(note.id)!.segments
      expect(segs.map((s) => s.startMs)).toEqual([0, 1000, 2000])
      for (const p of paths) expect(existsSync(p)).toBe(false)
      expect(session!.status().deferredToBackground).toBe(false)
      expect(session!.status().lastError).toBeNull()

      // A new session starts with a fresh restart budget (the engine is still loaded, so no reload).
      const note2 = h.ctx.notes.create({ title: 'crash2' })
      const more = [4, 5].map((i) => join(workDir, `c-${i}.wav`))
      for (const p of more) writeChunk(p, 1000)
      const s2 = (await h.svc.startLive({ noteId: note2.id, workDir, vocabulary: [], language: null })).session!
      h.fake.crashNext(2)
      s2.feedWav(more[0], 0, 1000, 'mic')
      s2.feedWav(more[1], 1000, 1000, 'mic')
      const r2 = await s2.stop()
      expect(r2.deferredJobId).toBeNull()
      expect(s2.status().deferredToBackground).toBe(false)
      expect(h.ctx.transcripts.getByNote(note2.id)!.segments.map((s) => s.startMs)).toEqual([0, 1000])
      expect(h.fake.loadCalls).toHaveLength(4)
    })

    it('after two failed restarts the session defers and stop() queues the leftover chunks as a job', async () => {
      const h = track(harness())
      const note = h.ctx.notes.create({ title: 'crash-hard' })
      const workDir = join(h.userData, 'work')
      mkdirSync(workDir)
      const paths = [1, 2, 3].map((i) => join(workDir, `c-${i}.wav`))
      for (const p of paths) writeChunk(p, 1000, true)

      const { session } = await h.svc.startLive({ noteId: note.id, workDir, vocabulary: [], language: null })
      h.fake.crashNext(3)
      for (let i = 0; i < 3; i++) session!.feedWav(paths[i], i * 1000, 1000, 'mic')
      await until(() => session!.status().deferredToBackground, 3000, 'deferral')
      const st = session!.status()
      expect(st.status).toBe('error')
      expect(st.lastError).toMatch(/could not be restarted/)
      expect(h.fake.loadCalls).toHaveLength(3) // initial + 2 restarts, then gave up
      expect(h.ctx.transcripts.getByNote(note.id)).toBeNull()

      const r = await session!.stop()
      expect(r.deferredJobId).not.toBeNull()
      const job = jobOf(h, r.deferredJobId!)
      expect(job.kind).toBe('background')
      expect(job.noteId).toBe(note.id)
      expect(job.totalMs).toBe(3000)
      const pendingNoteDir = join(h.svc.pendingDir, note.id)
      expect(job.sources.map((s) => s.path)).toEqual(paths.map((p) => join(pendingNoteDir, p.split('/').pop()!)))
      expect(job.sources.map((s) => [s.offsetMs, s.durationMs, s.channel])).toEqual([
        [0, 1000, 'mic'],
        [1000, 1000, 'mic'],
        [2000, 1000, 'mic']
      ])
      for (const p of paths) expect(existsSync(p)).toBe(false)
      for (const s of job.sources) expect(existsSync(s.path)).toBe(true)

      // The deferred job starts on its own once the live session is gone and finishes the audio.
      await until(() => jobOf(h, job.id).status === 'completed', 5000, 'deferred job completion')
      expect(h.fake.loadCalls).toHaveLength(4) // the job reloaded the crashed engine
      const done = jobOf(h, job.id)
      expect(done.segmentsWritten).toBe(3)
      expect(done.processedMs).toBe(3000)
      const t = h.ctx.transcripts.getByNote(note.id)!
      expect(t.transcript.source).toBe('background')
      expect(t.segments.map((s) => s.startMs)).toEqual([0, 1000, 2000])
      for (const s of job.sources) expect(existsSync(s.path)).toBe(false)
      expect(existsSync(pendingNoteDir)).toBe(false)
      expect(h.notesChanged).toEqual([[note.id]])
    })
  })

  // 5 ------------------------------------------------------------------------
  it('lag deferral: slow engine → lagging → deferred; leftovers become a job that runs later', async () => {
    const h = track(harness())
    const note = h.ctx.notes.create({ title: 'lag' })
    const workDir = join(h.userData, 'work')
    mkdirSync(workDir)
    const paths = [0, 1, 2, 3, 4].map((i) => join(workDir, `l-${i}.wav`))
    for (const p of paths) writeChunk(p, 400, true)
    const { session } = await h.svc.startLive({ noteId: note.id, workDir, vocabulary: [], language: null })

    // The first chunk after a load is warm-up and does not count towards the RTF window.
    h.fake.delayMs = 0
    session!.feedWav(paths[0], 0, 400, 'mic')
    await until(() => session!.status().recognizedSegments === 1, 3000, 'warm-up chunk')
    expect(session!.status().recentRtf).toBeNull()

    // rtf ≈ 1.25: above the lagging threshold (1.0) but below the deferral threshold (1.5).
    // With nothing waiting in the queue a slow engine is not "lagging" — speech pauses let it catch up.
    h.fake.delayMs = 500
    session!.feedWav(paths[1], 400, 400, 'mic')
    await until(() => session!.status().recognizedSegments === 2, 3000, 'chunk 1')
    const slow = session!.status()
    expect(slow.recentRtf).toBeGreaterThan(1.0)
    expect(slow.recentRtf).toBeLessThan(1.5)
    expect(slow.status).toBe('listening')
    expect(slow.deferredToBackground).toBe(false)

    // Now much slower: the rolling rtf exceeds 1.5 and the next chunk triggers deferral.
    h.fake.delayMs = 1500
    session!.feedWav(paths[2], 800, 400, 'mic')
    await until(() => session!.status().recognizedSegments === 3, 4000, 'chunk 2')
    expect(session!.status().recentRtf).toBeGreaterThan(1.5)
    expect(session!.status().deferredToBackground).toBe(false)
    session!.feedWav(paths[3], 1200, 400, 'mic')
    const deferred = session!.status()
    expect(deferred.deferredToBackground).toBe(true)
    expect(deferred.status).toBe('lagging')
    session!.feedWav(paths[4], 1600, 400, 'mic')
    expect(h.liveStatuses).toContain('lagging')

    h.fake.delayMs = 0
    const before = h.fake.requests.length
    const r = await session!.stop()
    expect(h.fake.requests.length).toBe(before) // nothing more was processed live after deferral
    expect(r.deferredJobId).not.toBeNull()
    const job = jobOf(h, r.deferredJobId!)
    expect(job.sources.map((s) => s.offsetMs)).toEqual([1200, 1600])
    for (const s of job.sources) expect(s.path.startsWith(join(h.svc.pendingDir, note.id))).toBe(true)
    expect(existsSync(paths[3])).toBe(false)
    expect(existsSync(paths[4])).toBe(false)

    h.svc.kickJobs()
    await until(() => jobOf(h, job.id).status === 'completed', 5000, 'job completion')
    for (const s of job.sources) expect(existsSync(s.path)).toBe(false)
    const t = h.ctx.transcripts.getByNote(note.id)!
    expect(t.segments.map((s) => s.startMs!).sort((a, b) => a - b)).toEqual([0, 400, 800, 1200, 1600])
    expect(h.fake.requests.filter((q) => q.kind === 'pcm')).toHaveLength(2)
  }, 15_000)

  // 6 ------------------------------------------------------------------------
  describe('background jobs over a recording', () => {
    it('skips silent windows, persists progress and completes', async () => {
      const h = track(harness())
      const note = h.ctx.notes.create({ title: 'bg' })
      const recPath = join(h.userData, 'recordings', 'rec-mic.wav')
      writeRecording(recPath, 70_000, [35_000])
      const windows = await planWindows(recPath, { channel: 'mic' })
      expect(windows.length).toBeGreaterThanOrEqual(3)
      expect(windows.reduce((a, w) => a + w.durationMs, 0)).toBe(70_000)
      const rec = addRecording(h, note.id, recPath, 70_000)

      const jobsEvents: string[][] = []
      h.svc.on('jobs', (js) => jobsEvents.push(js.map((j) => j.status)))
      const job = await h.svc.enqueueRecording(note.id, rec.id)
      expect(job.totalMs).toBe(70_000)
      await expect(h.svc.enqueueRecording(note.id, rec.id)).rejects.toThrow(/already queued/)
      await until(() => jobOf(h, job.id).status === 'completed', 5000, 'completion')

      expect(h.fake.requests).toHaveLength(1) // only the window with the blip reached the engine
      const w = windows.find((x) => x.offsetMs <= 35_000 && x.offsetMs + x.durationMs > 35_000)!
      expect(h.fake.requests[0]).toMatchObject({ kind: 'pcm', input: w.durationMs * BYTES_PER_MS, opts: { language: 'en' } }) // base.en is English-only → 'en' even with no configured language
      const done = jobOf(h, job.id)
      expect(done).toMatchObject({ status: 'completed', processedMs: 70_000, progress: 1, segmentsWritten: 1, nextIndex: windows.length, modelId: 'base.en-q5_1', attempts: 1 })
      expect(done.rtf).not.toBeNull()
      expect(done.startedAt).not.toBeNull()
      expect(done.finishedAt).not.toBeNull()
      const t = h.ctx.transcripts.getByNote(note.id)!
      expect(t.segments).toHaveLength(1)
      expect(t.segments[0].startMs).toBe(w.offsetMs)
      expect(t.segments[0].channel).toBe('mic')
      expect(jobsEvents.flat()).toContain('running')
      expect(existsSync(recPath)).toBe(true) // user recordings are never deleted by a job
      expect(h.notesChanged).toEqual([[note.id]])
    })

    it('pause stops the engine at the next window boundary; resume completes', async () => {
      const h = track(harness())
      const note = h.ctx.notes.create({ title: 'pause' })
      const recPath = join(h.userData, 'recordings', 'rec-system.wav')
      writeRecording(recPath, 70_000, [5_000, 15_000, 25_000, 35_000, 45_000, 55_000, 65_000])
      const rec = addRecording(h, note.id, recPath, 70_000)
      h.fake.delayMs = 150
      const job = await h.svc.enqueueRecording(note.id, rec.id)
      expect(jobOf(h, job.id).status).toBe('running')
      await until(() => h.fake.requests.length >= 1, 2000, 'first window')
      h.svc.pauseJob(job.id)
      expect(jobOf(h, job.id).status).toBe('paused')
      await sleep(400)
      const calls = h.fake.requests.length
      expect(calls).toBe(1)
      await sleep(400)
      expect(h.fake.requests.length).toBe(calls) // nothing further while paused
      const paused = jobOf(h, job.id)
      expect(paused.status).toBe('paused')
      expect(paused.nextIndex).toBe(1)
      expect(paused.processedMs).toBeGreaterThan(0)
      expect(paused.progress).toBeLessThan(1)

      h.fake.delayMs = 0
      h.svc.resumeJob(job.id)
      await until(() => jobOf(h, job.id).status === 'completed', 5000, 'completion')
      const done = jobOf(h, job.id)
      expect(done.processedMs).toBe(70_000)
      expect(done.attempts).toBe(2)
      expect(h.fake.requests.every((q) => q.opts.prompt === undefined || typeof q.opts.prompt === 'string')).toBe(true)
      expect(h.ctx.transcripts.getByNote(note.id)!.segments.map((s) => s.channel).every((c) => c === 'system')).toBe(true)
    })

    it('cancel on a running job → cancelled; retry → completes with attempts ≥ 2', async () => {
      const h = track(harness())
      const note = h.ctx.notes.create({ title: 'cancel' })
      const recPath = join(h.userData, 'recordings', 'rec.wav')
      writeRecording(recPath, 70_000, [5_000, 15_000, 25_000, 35_000, 45_000, 55_000, 65_000])
      const rec = addRecording(h, note.id, recPath, 70_000)
      h.fake.delayMs = 150
      const job = await h.svc.enqueueRecording(note.id, rec.id)
      await until(() => h.fake.requests.length >= 1, 2000, 'first window')
      h.svc.cancelJob(job.id)
      expect(jobOf(h, job.id).status).toBe('cancelled')
      expect(h.fake.requests[0].opts.signal?.aborted).toBe(true)
      await sleep(400)
      expect(jobOf(h, job.id).status).toBe('cancelled')
      const callsAfterCancel = h.fake.requests.length
      expect(callsAfterCancel).toBe(1)

      h.fake.delayMs = 0
      h.svc.retryJob(job.id)
      await until(() => jobOf(h, job.id).status === 'completed', 5000, 'completion')
      const done = jobOf(h, job.id)
      expect(done.attempts).toBeGreaterThanOrEqual(2)
      expect(done.error).toBeNull()
      expect(done.processedMs).toBe(70_000)
      expect(h.ctx.transcripts.getByNote(note.id)!.segments.map((s) => s.channel).every((c) => c === 'unknown')).toBe(true)
    })
  })

  // 7 ------------------------------------------------------------------------
  it('single-model policy: live pauses the running job and it resumes after the live session ends', async () => {
    const h = track(harness())
    const bgNote = h.ctx.notes.create({ title: 'bg' })
    const recPath = join(h.userData, 'recordings', 'rec-mic.wav')
    writeRecording(recPath, 70_000, [5_000, 15_000, 25_000, 35_000, 45_000, 55_000, 65_000])
    const rec = addRecording(h, bgNote.id, recPath, 70_000)
    h.fake.delayMs = 150
    const job = await h.svc.enqueueRecording(bgNote.id, rec.id)
    expect(jobOf(h, job.id).status).toBe('running')
    expect(h.fake.loadCalls).toHaveLength(1)

    const liveNote = h.ctx.notes.create({ title: 'live' })
    const workDir = join(h.userData, 'work')
    mkdirSync(workDir)
    const chunk = join(workDir, 'c-1.wav')
    writeChunk(chunk, 1000)
    const { session, reason } = await h.svc.startLive({ noteId: liveNote.id, workDir, vocabulary: [], language: null })
    expect(reason).toBeNull()
    expect(jobOf(h, job.id).status).toBe('paused')
    expect(h.fake.loadCalls).toHaveLength(1) // same model, no reload
    // The runner yields at its next window boundary and the engine is then the live session's.
    await until(() => (h.svc as unknown as { runningJobId: string | null }).runningJobId === null, 3000, 'runner to yield')
    const bgCalls = h.fake.requests.filter((q) => q.kind === 'pcm').length
    expect(bgCalls).toBeLessThanOrEqual(1)
    h.fake.delayMs = 0
    session!.feedWav(chunk, 0, 1000, 'mic')
    await until(() => session!.status().recognizedSegments === 1, 2000, 'live chunk')
    expect(h.fake.requests.filter((q) => q.kind === 'pcm')).toHaveLength(bgCalls)
    expect(jobOf(h, job.id).status).toBe('paused')

    const r = await session!.stop()
    expect(r.deferredJobId).toBeNull()
    await until(() => jobOf(h, job.id).status === 'completed', 5000, 'job completion after live')
    const done = jobOf(h, job.id)
    expect(done.processedMs).toBe(70_000)
    expect(done.attempts).toBe(2)
    expect(h.fake.requests.filter((q) => q.kind === 'pcm')).toHaveLength(3) // every loud window exactly once
    expect(h.ctx.transcripts.getByNote(liveNote.id)!.segments).toHaveLength(1)
    expect(h.ctx.transcripts.getByNote(bgNote.id)!.segments).toHaveLength(3)
  })

  // 8 ------------------------------------------------------------------------
  it('interrupted-job recovery: a job left running is queued again when the service starts', () => {
    const c = makeCtx()
    installModels(c.userData, DEFAULT_INSTALLED)
    const note = c.ctx.notes.create({ title: 'interrupted' })
    const repo = new JobsRepo(c.db)
    const pendingPath = join(c.userData, 'pending-audio', note.id, 'c-1.wav')
    mkdirSync(join(c.userData, 'pending-audio', note.id), { recursive: true })
    writeChunk(pendingPath, 1000)
    const orphan = join(c.userData, 'pending-audio', 'other-note', 'orphan.wav')
    mkdirSync(join(c.userData, 'pending-audio', 'other-note'), { recursive: true })
    writeChunk(orphan, 1000)
    const job = repo.create({ kind: 'background', noteId: note.id, recordingId: null, modelId: 'base.en-q5_1', sources: [{ path: pendingPath, offsetMs: 0, durationMs: 1000, channel: 'mic' }] })
    repo.setStatus(job.id, 'running')
    expect(repo.get(job.id)!.status).toBe('running')

    const { engine, fake } = fakeEngine()
    const svc = new TranscriptionService(c.ctx, { resourcesDir: c.userData, engine, hardwareProvider: hwProvider(HW_16GB) })
    const h: Harness = { ...c, svc, fake, liveStatuses: [] }
    track(h)
    expect(repo.get(job.id)!.status).toBe('queued')
    expect(svc.listJobs().map((j) => j.status)).toEqual(['queued'])
    // Startup also removes pending files no job refers to, keeping the referenced one.
    expect(existsSync(pendingPath)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(join(c.userData, 'pending-audio', 'other-note'))).toBe(false)
    expect(fake.loadCalls).toHaveLength(0) // construction never starts the engine
  })

  // 9 ------------------------------------------------------------------------
  it('removeJob deletes its pending files but never a user recording', () => {
    const h = track(harness())
    const note = h.ctx.notes.create({ title: 'remove' })
    const pendingDir = join(h.svc.pendingDir, note.id)
    mkdirSync(pendingDir, { recursive: true })
    const pendingPath = join(pendingDir, 'c-1.wav')
    writeChunk(pendingPath, 1000)
    const userPath = join(h.userData, 'recordings', 'keep-me.wav')
    writeChunk(userPath, 1000)
    const lookalike = join(h.userData, 'pending-audio-not-really', 'c.wav')
    mkdirSync(join(h.userData, 'pending-audio-not-really'), { recursive: true })
    writeChunk(lookalike, 1000)

    const job = h.svc.jobs.create({
      kind: 'background',
      noteId: note.id,
      recordingId: null,
      modelId: null,
      sources: [
        { path: pendingPath, offsetMs: 0, durationMs: 1000, channel: 'mic' },
        { path: userPath, offsetMs: 1000, durationMs: 1000, channel: 'unknown' },
        { path: lookalike, offsetMs: 2000, durationMs: 1000, channel: 'unknown' }
      ]
    })
    h.svc.pauseJob(job.id) // keep the runner away from it
    expect(h.svc.listJobs()).toHaveLength(1)
    h.svc.removeJob(job.id)
    expect(h.svc.listJobs()).toHaveLength(0)
    expect(h.svc.jobs.get(job.id)).toBeNull()
    expect(existsSync(pendingPath)).toBe(false)
    expect(existsSync(pendingDir)).toBe(false)
    expect(existsSync(userPath)).toBe(true)
    expect(existsSync(lookalike)).toBe(true)
    expect(h.svc.removeJob('does-not-exist')).toBeUndefined()
  })
})
