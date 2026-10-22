import { describe, expect, it } from 'vitest'
import { downsampleTo16k, floatToInt16, rmsOf } from '@renderer/lib/audio-capture'

describe('downsampleTo16k', () => {
  it('returns a copy when already at 16 kHz', () => {
    const input = Float32Array.from([0.1, 0.2, 0.3])
    const out = downsampleTo16k(input, 16000)
    expect(Array.from(out)).toEqual([0.1, 0.2, 0.3].map((v) => Math.fround(v)))
    expect(out).not.toBe(input)
  })

  it('reduces 48 kHz by exactly 3x', () => {
    const input = new Float32Array(4800).map((_, i) => i / 4800)
    const out = downsampleTo16k(input, 48000)
    expect(out.length).toBe(1600)
    // integer ratio: every third sample, no interpolation error
    expect(out[0]).toBeCloseTo(input[0], 6)
    expect(out[1]).toBeCloseTo(input[3], 6)
    expect(out[1599]).toBeCloseTo(input[4797], 6)
  })

  it('linearly interpolates for non-integer ratios (44.1 kHz)', () => {
    const input = new Float32Array(4410).map((_, i) => i) // ramp with slope 1 per sample
    const out = downsampleTo16k(input, 44100)
    expect(out.length).toBe(1600)
    const ratio = 44100 / 16000
    for (const i of [1, 7, 100, 1599]) expect(out[i]).toBeCloseTo(i * ratio, 3)
  })

  it('does not read past the end of the input', () => {
    const input = Float32Array.from([1, 1, 1, 1, 1])
    const out = downsampleTo16k(input, 22050)
    expect(out.length).toBe(Math.floor(5 / (22050 / 16000)))
    for (const v of out) expect(v).toBeCloseTo(1, 6)
  })

  it('is pure', () => {
    const input = Float32Array.from([0.5, -0.5, 0.25, -0.25, 0, 1])
    const snapshot = Array.from(input)
    const a = downsampleTo16k(input, 32000)
    const b = downsampleTo16k(input, 32000)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(Array.from(input)).toEqual(snapshot)
  })

  it('returns an empty array for empty input', () => {
    expect(downsampleTo16k(new Float32Array(0), 48000).length).toBe(0)
  })
})

describe('floatToInt16', () => {
  it('maps the full range and clips', () => {
    const out = floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5, -0.5]))
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16384, -16384])
  })

  it('maps NaN to silence', () => {
    expect(Array.from(floatToInt16(Float32Array.from([NaN])))).toEqual([0])
  })

  it('preserves length and returns little-endian PCM16 bytes', () => {
    const out = floatToInt16(new Float32Array(100))
    expect(out.length).toBe(100)
    expect(out.byteLength).toBe(200)
    const one = floatToInt16(Float32Array.from([0.5]))
    const bytes = new Uint8Array(one.buffer)
    expect(bytes[0]).toBe(0x00)
    expect(bytes[1]).toBe(0x40)
  })
})

describe('rmsOf', () => {
  it('is 0 for silence and empty input', () => {
    expect(rmsOf(new Float32Array(0))).toBe(0)
    expect(rmsOf(new Float32Array(10))).toBe(0)
  })
  it('is the amplitude for a square wave', () => {
    expect(rmsOf(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 6)
  })
})
