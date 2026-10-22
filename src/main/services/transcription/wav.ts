// PCM / WAV helpers for the transcription pipeline.
// Plain Node, no native modules. All WAV output is 16-bit PCM little-endian.

import { closeSync, openSync, writeSync, fstatSync } from 'node:fs'

export const WAV_HEADER_BYTES = 44

export interface WavHeader {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Byte length of the data chunk. */
  dataBytes: number
  /** Number of sample frames (per channel). */
  frames: number
  durationMs: number
  /** Byte offset of the first PCM sample in the file. */
  dataOffset: number
}

/** Build a canonical 44-byte RIFF/WAVE header for 16-bit PCM. */
export function buildWavHeader(dataBytes: number, sampleRate: number, channels: number, bitsPerSample = 16): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError(`invalid sampleRate ${sampleRate}`)
  if (!Number.isInteger(channels) || channels <= 0) throw new RangeError(`invalid channels ${channels}`)
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const h = Buffer.alloc(WAV_HEADER_BYTES)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16) // fmt chunk size
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(byteRate, 28)
  h.writeUInt16LE(blockAlign, 32)
  h.writeUInt16LE(bitsPerSample, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** Parse a canonical header produced by buildWavHeader / writeWav. Throws on anything else. */
export function parseWavHeader(buf: Buffer): WavHeader {
  if (buf.length < WAV_HEADER_BYTES) throw new Error('WAV too short')
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file')
  // Walk chunks so that files with extra chunks (LIST etc.) also parse.
  let pos = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let dataBytes = -1
  let dataOffset = WAV_HEADER_BYTES
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      const fmt = buf.readUInt16LE(pos + 8)
      if (fmt !== 1) throw new Error(`unsupported WAV format tag ${fmt} (only PCM)`)
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bitsPerSample = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      dataBytes = size
      dataOffset = pos + 8
      break
    }
    pos += 8 + size + (size % 2)
  }
  if (!sampleRate || !channels || !bitsPerSample) throw new Error('WAV missing fmt chunk')
  if (dataBytes < 0) throw new Error('WAV missing data chunk')
  const frames = Math.floor(dataBytes / ((channels * bitsPerSample) / 8))
  return { sampleRate, channels, bitsPerSample, dataBytes, frames, durationMs: (frames * 1000) / sampleRate, dataOffset }
}

function toPcmBuffer(pcm16: Int16Array | Buffer): Buffer {
  if (Buffer.isBuffer(pcm16)) return pcm16
  // Int16Array is host-endian; every platform we ship on is little-endian.
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
}

/** Write a whole 16-bit PCM WAV file synchronously. */
export function writeWav(path: string, pcm16: Int16Array | Buffer, sampleRate: number, channels: number): void {
  const data = toPcmBuffer(pcm16)
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, buildWavHeader(data.length, sampleRate, channels))
    let off = 0
    while (off < data.length) off += writeSync(fd, data, off, data.length - off)
  } finally {
    closeSync(fd)
  }
}

/**
 * Streaming WAV writer: open → append*(Buffer|Int16Array) → finalize().
 * The header is written with placeholder sizes and patched on finalize so a
 * crash mid-recording still leaves a readable (if unsized) file.
 */
export class WavFileWriter {
  private fd: number | null
  private dataBytes = 0
  readonly path: string
  readonly sampleRate: number
  readonly channels: number

  constructor(path: string, sampleRate: number, channels: number) {
    this.path = path
    this.sampleRate = sampleRate
    this.channels = channels
    this.fd = openSync(path, 'w')
    writeSync(this.fd, buildWavHeader(0, sampleRate, channels))
  }

  get bytesWritten(): number {
    return this.dataBytes
  }

  get durationMs(): number {
    return (this.dataBytes / (this.channels * 2) / this.sampleRate) * 1000
  }

  get isOpen(): boolean {
    return this.fd !== null
  }

  append(chunk: Buffer | Int16Array): void {
    if (this.fd === null) throw new Error('WavFileWriter already finalized')
    const data = toPcmBuffer(chunk)
    let off = 0
    while (off < data.length) off += writeSync(this.fd, data, off, data.length - off)
    this.dataBytes += data.length
  }

  /** Patch the RIFF/data sizes and close. Safe to call twice. */
  finalize(): { path: string; dataBytes: number; durationMs: number } {
    if (this.fd !== null) {
      try {
        const actual = fstatSync(this.fd).size - WAV_HEADER_BYTES
        if (actual >= 0 && actual !== this.dataBytes) this.dataBytes = actual
        const sizes = Buffer.alloc(4)
        sizes.writeUInt32LE(36 + this.dataBytes, 0)
        writeSync(this.fd, sizes, 0, 4, 4)
        sizes.writeUInt32LE(this.dataBytes, 0)
        writeSync(this.fd, sizes, 0, 4, 40)
      } finally {
        closeSync(this.fd)
        this.fd = null
      }
    }
    return { path: this.path, dataBytes: this.dataBytes, durationMs: this.durationMs }
  }
}

/** Float32 [-1, 1] → Int16 with clipping. */
export function pcmFloat32ToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    let s = f32[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    else if (Number.isNaN(s)) s = 0
    out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767)
  }
  return out
}

/**
 * Linear-interpolation resampler for mono Float32. Adequate for speech going
 * from 44.1/48 kHz down to 16 kHz (the recognizer's own front-end band-limits
 * further). Returns the input untouched when rates match.
 */
export function downsampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) throw new RangeError('sample rates must be positive')
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  const last = input.length - 1
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = i0 + 1 <= last ? i0 + 1 : last
    const frac = pos - i0
    out[i] = input[i0] + (input[i1] - input[i0]) * frac
  }
  return out
}

/** Clipped sum of two Int16 streams. Shorter input is zero-padded. */
export function mixPcm16(a: Int16Array, b: Int16Array): Int16Array {
  const n = Math.max(a.length, b.length)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const s = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0)
    out[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }
  return out
}

/** RMS level normalised to 0..1 (1 = full-scale square wave). */
export function rmsLevel(int16: Int16Array): number {
  if (int16.length === 0) return 0
  let acc = 0
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768
    acc += v * v
  }
  return Math.sqrt(acc / int16.length)
}
