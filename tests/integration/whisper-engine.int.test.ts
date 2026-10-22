// Runs only when a whisper runtime and a model are available (skipped otherwise).
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WhisperEngine, runtimeDirFor } from '../../src/main/services/whisper/whisper-engine'

const runtimeDir = runtimeDirFor(join(process.cwd(), 'resources'))
const model = process.env.MINUTES_TEST_MODEL ?? '/home/claude/models/ggml-tiny.en-q5_1.bin'
const wav = process.env.MINUTES_TEST_WAV ?? '/home/claude/models/jfk.wav'
const available = existsSync(join(runtimeDir, 'whisper-server')) && existsSync(model) && existsSync(wav)
const log = { info: () => {}, warn: () => {}, error: () => {} }

describe.skipIf(!available)('WhisperEngine (integration)', () => {
  it('loads a model, transcribes a WAV with timestamps, survives a crash and reloads', async () => {
    const engine = new WhisperEngine({ runtimeDir, log })
    const variants: string[] = []
    engine.on('cpuVariant', (v) => variants.push(v))
    expect(engine.status().runtimeAvailable).toBe(true)
    await engine.load('tiny.en-q5_1', model, 2)
    expect(engine.isLoaded).toBe(true)
    expect(engine.status().loadTimeMs).toBeGreaterThan(0)
    expect(variants.length).toBe(1)
    const segs = await engine.transcribeWavFile(wav)
    expect(segs.length).toBeGreaterThan(0)
    expect(segs.map((s) => s.text).join(' ').toLowerCase()).toContain('ask not what your country')
    expect(segs[0].startMs).toBe(0)
    expect(segs[segs.length - 1].endMs).toBeGreaterThan(9000)
    expect(engine.workerMemoryBytes()).toBeGreaterThan(20 * 1024 * 1024)
    // two serialised requests
    const [a, b] = await Promise.all([engine.transcribeWavFile(wav), engine.transcribeWavFile(wav)])
    expect(a.length).toBe(b.length)
    // crash containment: kill the worker and make sure the engine reports it and can reload
    const crashed = new Promise<void>((r) => engine.once('crashed', () => r()))
    process.kill(engine.pid!, 'SIGKILL')
    await crashed
    expect(engine.isLoaded).toBe(false)
    await expect(engine.transcribeWavFile(wav)).rejects.toMatchObject({ code: 'NOT_LOADED' })
    await engine.load('tiny.en-q5_1', model, 2)
    expect(engine.isLoaded).toBe(true)
    await engine.stop()
    expect(engine.status().processAlive).toBe(false)
  }, 120_000)

  it('fails cleanly on a bad model file', async () => {
    const engine = new WhisperEngine({ runtimeDir, log, loadTimeoutMs: 30_000 })
    const bad = join(process.cwd(), 'package.json')
    await expect(engine.load('bad', bad, 1)).rejects.toMatchObject({ code: 'LOAD_FAILED' })
    expect(engine.status().processAlive).toBe(false)
    expect(readFileSync(bad, 'utf8').length).toBeGreaterThan(0)
  }, 60_000)
})
