import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WAV_HEADER_BYTES,
  WavFileWriter,
  buildWavHeader,
  downsampleLinear,
  mixPcm16,
  parseWavHeader,
  pcmFloat32ToInt16,
  rmsLevel,
  writeWav
} from '../../../src/main/services/transcription/wav'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'minutes-wav-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('WAV header', () => {
  it('builds a canonical 44-byte PCM header', () => {
    const h = buildWavHeader(32000, 16000, 1)
    expect(h.length).toBe(WAV_HEADER_BYTES)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.readUInt32LE(4)).toBe(36 + 32000)
    expect(h.toString('ascii', 8, 12)).toBe('WAVE')
    expect(h.toString('ascii', 12, 16)).toBe('fmt ')
    expect(h.readUInt32LE(16)).toBe(16)
    expect(h.readUInt16LE(20)).toBe(1)
    expect(h.readUInt16LE(22)).toBe(1)
    expect(h.readUInt32LE(24)).toBe(16000)
    expect(h.readUInt32LE(28)).toBe(32000) // byte rate
    expect(h.readUInt16LE(32)).toBe(2) // block align
    expect(h.readUInt16LE(34)).toBe(16)
    expect(h.toString('ascii', 36, 40)).toBe('data')
    expect(h.readUInt32LE(40)).toBe(32000)
  })

  it('writeWav writes a parseable file with correct sizes', () => {
    const pcm = new Int16Array(16000) // 1 s
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i / 10) * 1000)
    const p = join(dir, 'a.wav')
    writeWav(p, pcm, 16000, 1)
    const buf = readFileSync(p)
    expect(buf.length).toBe(WAV_HEADER_BYTES + 32000)
    const h = parseWavHeader(buf)
    expect(h).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 32000, frames: 16000 })
    expect(h.durationMs).toBeCloseTo(1000)
    // Samples round-trip little-endian
    expect(buf.readInt16LE(WAV_HEADER_BYTES + 2 * 5)).toBe(pcm[5])
  })

  it('WavFileWriter patches sizes on finalize', () => {
    const p = join(dir, 'stream.wav')
    const w = new WavFileWriter(p, 16000, 1)
    w.append(new Int16Array(8000))
    w.append(Buffer.alloc(4000))
    const before = readFileSync(p)
    expect(before.readUInt32LE(40)).toBe(0) // placeholder until finalized
    const info = w.finalize()
    expect(info.dataBytes).toBe(16000 + 4000)
    expect(info.durationMs).toBeCloseTo(625)
    const h = parseWavHeader(readFileSync(p))
    expect(h.dataBytes).toBe(20000)
    expect(h.frames).toBe(10000)
    expect(w.isOpen).toBe(false)
    expect(() => w.append(Buffer.alloc(2))).toThrow()
    expect(w.finalize().dataBytes).toBe(20000) // idempotent
  })

  it('parseWavHeader rejects garbage', () => {
    expect(() => parseWavHeader(Buffer.alloc(10))).toThrow()
    expect(() => parseWavHeader(Buffer.alloc(44))).toThrow(/RIFF/)
  })
})

describe('PCM helpers', () => {
  it('pcmFloat32ToInt16 clips and scales', () => {
    const out = pcmFloat32ToInt16(new Float32Array([0, 1, -1, 2, -2, 0.5, NaN]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0])
  })

  it('downsampleLinear produces the expected length and interpolated values', () => {
    const input = new Float32Array(48000) // 1 s @ 48k ramp
    for (let i = 0; i < input.length; i++) input[i] = i / input.length
    const out = downsampleLinear(input, 48000, 16000)
    expect(out.length).toBe(16000)
    expect(out[0]).toBe(0)
    // Sample k of the output corresponds to input index 3k on a linear ramp.
    expect(out[100]).toBeCloseTo(input[300], 6)
    expect(out[15999]).toBeCloseTo(input[47997], 6)
    // identity when rates match
    expect(downsampleLinear(input, 16000, 16000)).toBe(input)
    // non-integer ratio
    expect(downsampleLinear(new Float32Array(44100), 44100, 16000).length).toBe(16000)
  })

  it('mixPcm16 clips the sum and pads the shorter input', () => {
    const a = new Int16Array([1000, 30000, -30000, 5])
    const b = new Int16Array([1000, 30000, -30000])
    expect(Array.from(mixPcm16(a, b))).toEqual([2000, 32767, -32768, 5])
  })

  it('rmsLevel is 0 for silence and ~0.707 for a full-scale sine', () => {
    expect(rmsLevel(new Int16Array(100))).toBe(0)
    const sine = new Int16Array(16000)
    for (let i = 0; i < sine.length; i++) sine[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 32767)
    expect(rmsLevel(sine)).toBeCloseTo(0.707, 2)
  })
})
