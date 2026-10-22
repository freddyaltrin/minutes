import { describe, it, expect } from 'vitest'
import { SpeechChunker, type SpeechChunk } from '../../../src/main/services/transcription/chunker'

const SR = 16000

function sine(ms: number, amplitude = 8000, freq = 300): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amplitude)
  return out
}

function silence(ms: number, noise = 0): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  if (noise > 0) for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * noise)
  return out
}

function makeChunker(overrides: Partial<ConstructorParameters<typeof SpeechChunker>[0]> = {}) {
  const written: { path: string; samples: number }[] = []
  const chunks: SpeechChunk[] = []
  const chunker = new SpeechChunker({
    workDir: '/work',
    writeFile: (path, pcm) => written.push({ path, samples: pcm.length }),
    ...overrides
  })
  chunker.on('chunk', (c) => chunks.push(c))
  return { chunker, written, chunks }
}

/** Feed a signal in `frameMs` frames starting at `startMs`; returns next offset. */
function feed(chunker: SpeechChunker, signal: Int16Array, startMs: number, frameMs = 100): number {
  const frame = Math.round((SR * frameMs) / 1000)
  let offset = startMs
  for (let i = 0; i < signal.length; i += frame) {
    const part = signal.subarray(i, Math.min(i + frame, signal.length))
    chunker.push(part, offset)
    offset += (part.length * 1000) / SR
  }
  return offset
}

describe('SpeechChunker', () => {
  it('cuts at a pause after at least minChunkMs of audio', () => {
    const { chunker, written, chunks } = makeChunker()
    // 4 s speech, then 2 s silence -> cut ~1 s into the silence
    const signal = new Int16Array([...sine(4000), ...silence(2000)])
    feed(chunker, signal, 0)
    expect(chunks.length).toBe(1)
    expect(chunks[0].offsetMs).toBe(0)
    expect(chunks[0].durationMs).toBeGreaterThanOrEqual(5000)
    expect(chunks[0].durationMs).toBeLessThan(5300)
    expect(chunks[0].path).toMatch(/[\\/]chunk-000001\.wav$/)
    expect(written[0].samples).toBe(Math.round((chunks[0].durationMs * SR) / 1000))
    expect(chunker.stats.cutAtPause).toBe(1)
  })

  it('does not cut on a pause before minChunkMs', () => {
    const { chunker, chunks } = makeChunker()
    // 1 s speech + 1.5 s silence: too short to cut; then speech resumes.
    feed(chunker, new Int16Array([...sine(1000), ...silence(1500), ...sine(1000)]), 0)
    expect(chunks.length).toBe(0)
    expect(chunker.pendingMs).toBeCloseTo(3500)
  })

  it('cuts at maxChunkMs when speech never pauses', () => {
    const { chunker, chunks } = makeChunker()
    const end = feed(chunker, sine(60000), 0)
    expect(end).toBe(60000)
    expect(chunks.length).toBe(2)
    expect(chunks[0].durationMs).toBe(25000)
    expect(chunks[0].offsetMs).toBe(0)
    expect(chunks[1].durationMs).toBe(25000)
    expect(chunks[1].offsetMs).toBe(25000)
    expect(chunker.stats.cutAtMax).toBe(2)
    const tail = chunker.flush()
    expect(tail).not.toBeNull()
    expect(tail!.offsetMs).toBe(50000)
    expect(tail!.durationMs).toBe(10000)
    expect(chunks.length).toBe(3)
  })

  it('skips chunks that are entirely silence and counts them', () => {
    const { chunker, chunks, written } = makeChunker()
    const silent: { offsetMs: number; durationMs: number }[] = []
    chunker.on('silent', (s) => silent.push(s))
    // 30 s of faint noise: silence is discarded in minChunkMs (3 s) pieces,
    // never written, and the recording offset keeps advancing.
    feed(chunker, silence(30000, 20), 0)
    expect(chunker.flush()).toBeNull()
    expect(chunks.length).toBe(0)
    expect(written.length).toBe(0)
    expect(chunker.stats.skippedSilent).toBe(10)
    expect(silent[0]).toEqual({ offsetMs: 0, durationMs: 3000 })
    expect(silent[9]).toEqual({ offsetMs: 27000, durationMs: 3000 })
  })

  it('preserves recording offsets across chunks and pauses', () => {
    const { chunker, chunks } = makeChunker()
    let t = 10000 // recording started 10 s ago
    t = feed(chunker, new Int16Array([...sine(3500), ...silence(1500)]), t)
    t = feed(chunker, new Int16Array([...sine(3500), ...silence(1500)]), t)
    expect(chunks.length).toBe(2)
    expect(chunks[0].offsetMs).toBe(10000)
    expect(chunks[1].offsetMs).toBe(10000 + chunks[0].durationMs)
    expect(chunks[0].seq).toBe(1)
    expect(chunks[1].seq).toBe(2)
  })

  it('closes the current chunk on a timestamp gap (pause/resume)', () => {
    const { chunker, chunks } = makeChunker()
    feed(chunker, sine(2000), 0)
    // Resume 5 s later: previous 2 s of speech should be emitted on its own.
    feed(chunker, sine(500), 7000)
    expect(chunks.length).toBe(1)
    expect(chunks[0].durationMs).toBe(2000)
    expect(chunker.pendingMs).toBeCloseTo(500)
  })

  it('adapts the threshold to a noisy floor', () => {
    const { chunker, chunks } = makeChunker()
    // Loud-ish hum at amplitude 600 is "silence" once the floor adapts, so
    // real speech at 8000 still produces a cut at the hum.
    feed(chunker, new Int16Array([...silence(2000, 600), ...sine(3000), ...silence(2000, 600)]), 0)
    expect(chunks.length).toBe(1)
    expect(chunker.stats.threshold).toBeGreaterThan(0.004)
  })

  it('flush on an empty buffer returns null', () => {
    const { chunker } = makeChunker()
    expect(chunker.flush()).toBeNull()
  })
})
