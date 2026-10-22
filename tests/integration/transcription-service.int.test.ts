// End-to-end over the real whisper.cpp runtime: live session + background job + lag deferral.
// Skipped when the runtime or the test model is not present.
import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../src/main/db/database'
import { NotesRepo } from '../../src/main/db/notes-repo'
import { TranscriptsRepo } from '../../src/main/db/transcripts-repo'
import { SettingsRepo } from '../../src/main/db/settings-repo'
import { TranscriptionService } from '../../src/main/services/whisper/transcription-service'
import { runtimeDirFor } from '../../src/main/services/whisper/whisper-engine'
import { modelFileName } from '../../src/main/services/whisper/model-catalog'
import type { AppContext } from '../../src/main/context'

const resourcesDir = join(process.cwd(), 'resources')
const model = process.env.MINUTES_TEST_MODEL ?? '/home/claude/models/ggml-tiny.en-q5_1.bin'
const wav = process.env.MINUTES_TEST_WAV ?? '/home/claude/models/jfk.wav'
const available = existsSync(join(runtimeDirFor(resourcesDir), 'whisper-server')) && existsSync(model) && existsSync(wav)

function harness() {
  const userData = mkdtempSync(join(tmpdir(), 'minutes-ts-'))
  const db = new Database(join(userData, 'data', 'minutes.sqlite'))
  const emitted: { name: string; payload: unknown }[] = []
  const log = { info: () => {}, warn: () => {}, error: () => {}, write: () => {} }
  const ctx = {
    db,
    notes: new NotesRepo(db),
    transcripts: new TranscriptsRepo(db),
    settings: new SettingsRepo(db),
    log,
    paths: { userData, temp: join(userData, 'tmp'), recordings: join(userData, 'recordings') },
    emit: (name: string, payload?: unknown) => emitted.push({ name, payload }),
    notesChanged: () => {}
  } as unknown as AppContext
  // Install the test model under the user-data models dir (what the manager expects).
  const modelsDir = join(userData, 'models', 'whisper')
  require('node:fs').mkdirSync(modelsDir, { recursive: true })
  copyFileSync(model, join(modelsDir, modelFileName('tiny.en-q5_1')))
  const svc = new TranscriptionService(ctx, { resourcesDir })
  svc.setConfig({ engine: 'whisper', profile: 'lightweight', modelId: 'tiny.en-q5_1', enabled: true })
  return { ctx, svc, emitted, userData, db }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!available)('TranscriptionService (integration)', () => {
  const h = available ? harness() : null
  afterAll(async () => {
    await h?.svc.shutdown()
    h?.db.close()
  })

  it('plans a model from the installed set and reports hardware', () => {
    const plan = h!.svc.plan()
    expect(plan.modelId).toBe('tiny.en-q5_1')
    expect(plan.threads).toBeGreaterThanOrEqual(1)
    expect(h!.svc.listModels().find((m) => m.id === 'tiny.en-q5_1')?.state).toBe('installed')
    expect(h!.svc.hardware().logicalCores).toBeGreaterThan(0)
  })

  it('live session: chunk files are transcribed, stored with absolute timestamps and deleted', async () => {
    const note = h!.ctx.notes.create({ title: 'live' })
    const workDir = join(h!.userData, 'work')
    require('node:fs').mkdirSync(workDir, { recursive: true })
    const chunk = join(workDir, 'mic-000001.wav')
    copyFileSync(wav, chunk)
    const { session, reason } = await h!.svc.startLive({ noteId: note.id, workDir, vocabulary: ['Americans'], language: 'en' })
    expect(reason).toBeNull()
    expect(session).not.toBeNull()
    const durationMs = ((statSync(chunk).size - 44) / 32) | 0
    session!.feedWav(chunk, 5000, durationMs, 'mic')
    expect(session!.status().queuedChunks).toBe(1)
    const r = await session!.stop()
    expect(r.deferredJobId).toBeNull()
    const t = h!.ctx.transcripts.getByNote(note.id)!
    expect(t.transcript.source).toBe('live')
    expect(t.transcript.engine).toBe('whisper:tiny.en-q5_1')
    expect(t.segments.length).toBeGreaterThan(0)
    expect(t.segments[0].startMs).toBeGreaterThanOrEqual(5000)
    expect(t.segments[0].channel).toBe('mic')
    expect(t.segments.map((s) => s.text).join(' ').toLowerCase()).toContain('country')
    expect(existsSync(chunk)).toBe(false)
    expect(h!.emitted.some((e) => e.name === 'transcriptSegments')).toBe(true)
  }, 120_000)

  it('background job over a saved recording persists progress incrementally and completes', async () => {
    const note = h!.ctx.notes.create({ title: 'bg' })
    // Build a 40 s recording by concatenating the sample (forces ≥ 2 windows).
    const src = readFileSync(wav)
    const pcm = src.subarray(44)
    const copies = 4
    const data = Buffer.concat(Array.from({ length: copies }, () => pcm))
    const { buildWavHeader } = await import('../../src/main/services/transcription/wav')
    const recPath = join(h!.userData, 'rec-mic.wav')
    writeFileSync(recPath, Buffer.concat([buildWavHeader(data.length, 16000, 1), data]))
    const rec = h!.ctx.transcripts.addRecording({ noteId: note.id, path: recPath, startedAt: Date.now(), durationMs: (data.length / 32) | 0, sizeBytes: data.length + 44, sampleRate: 16000, channels: 1 })
    const job = await h!.svc.enqueueRecording(note.id, rec.id)
    expect(job.status).toBe('queued')
    await expect(h!.svc.enqueueRecording(note.id, rec.id)).rejects.toThrow(/already queued/)
    let done = h!.svc.listJobs().find((j) => j.id === job.id)!
    for (let i = 0; i < 600 && done.status !== 'completed' && done.status !== 'failed'; i++) {
      await sleep(200)
      done = h!.svc.listJobs().find((j) => j.id === job.id)!
    }
    expect(done.status).toBe('completed')
    expect(done.progress).toBe(1)
    expect(done.rtf).not.toBeNull()
    expect(done.segmentsWritten).toBeGreaterThan(copies - 1)
    const t = h!.ctx.transcripts.getByNote(note.id)!
    expect(t.segments.length).toBe(done.segmentsWritten)
    // timestamps are absolute and increasing across windows
    const starts = t.segments.map((s) => s.startMs!)
    expect(starts[starts.length - 1]).toBeGreaterThan(20_000)
    expect(existsSync(recPath)).toBe(true) // user recordings are never deleted by a job
  }, 300_000)

  it('pause / resume / cancel / retry transitions', async () => {
    const note = h!.ctx.notes.create({ title: 'ctl' })
    const src = readFileSync(wav)
    const data = Buffer.concat(Array.from({ length: 6 }, () => src.subarray(44)))
    const { buildWavHeader } = await import('../../src/main/services/transcription/wav')
    const recPath = join(h!.userData, 'rec2-mic.wav')
    writeFileSync(recPath, Buffer.concat([buildWavHeader(data.length, 16000, 1), data]))
    const rec = h!.ctx.transcripts.addRecording({ noteId: note.id, path: recPath, startedAt: Date.now(), durationMs: (data.length / 32) | 0, sizeBytes: data.length + 44, sampleRate: 16000, channels: 1 })
    const job = await h!.svc.enqueueRecording(note.id, rec.id)
    await sleep(500)
    h!.svc.pauseJob(job.id)
    for (let i = 0; i < 100 && h!.svc.listJobs().find((j) => j.id === job.id)!.status === 'running'; i++) await sleep(200)
    expect(h!.svc.listJobs().find((j) => j.id === job.id)!.status).toBe('paused')
    h!.svc.cancelJob(job.id)
    expect(h!.svc.listJobs().find((j) => j.id === job.id)!.status).toBe('cancelled')
    h!.svc.retryJob(job.id)
    let st = h!.svc.listJobs().find((j) => j.id === job.id)!
    for (let i = 0; i < 600 && st.status !== 'completed' && st.status !== 'failed'; i++) {
      await sleep(200)
      st = h!.svc.listJobs().find((j) => j.id === job.id)!
    }
    expect(st.status).toBe('completed')
    expect(st.attempts).toBeGreaterThanOrEqual(2)
  }, 300_000)
})
