// Splits a 16 kHz mono PCM16 WAV recording into bounded windows for background transcription
// without loading the whole file: one streaming pass computes frame energies, then windows of at
// most `maxWindowMs` are cut at the quietest frame near the boundary. Windows reference byte ranges
// of the original file, so no audio is copied and nothing is kept in memory between windows.

import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { parseWavHeader, WAV_HEADER_BYTES } from '../transcription/wav'
import type { JobSource } from '../../db/jobs-repo'

export interface WindowOptions {
  maxWindowMs?: number
  /** Look back this far from the hard boundary for a quiet frame. */
  searchBackMs?: number
  frameMs?: number
  channel?: JobSource['channel']
}

export async function planWindows(path: string, opts: WindowOptions = {}): Promise<JobSource[]> {
  const maxWindowMs = opts.maxWindowMs ?? 30_000
  const searchBackMs = opts.searchBackMs ?? 8_000
  const frameMs = opts.frameMs ?? 20
  const channel = opts.channel ?? 'unknown'

  const fh = await open(path, 'r')
  let header
  try {
    // Read enough to cover headers with extra chunks (LIST etc.).
    const head = Buffer.alloc(4096)
    const { bytesRead } = await fh.read(head, 0, 4096, 0)
    header = parseWavHeader(head.subarray(0, bytesRead))
  } finally {
    await fh.close()
  }
  if (header.sampleRate !== 16000 || header.channels !== 1 || header.bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV format (${header.sampleRate} Hz, ${header.channels} ch, ${header.bitsPerSample} bit); expected 16 kHz mono 16-bit`)
  }
  const fileBytes = (await stat(path)).size
  const dataBytes = Math.min(header.dataBytes || fileBytes - header.dataOffset, fileBytes - header.dataOffset)
  const bytesPerMs = 32 // 16000 samples/s × 2 bytes / 1000
  const totalMs = Math.floor(dataBytes / bytesPerMs)
  if (totalMs <= 0) return []

  // Pass 1: frame energies (RMS per 20 ms frame) via a streaming read.
  const frameBytes = frameMs * bytesPerMs
  const energies: number[] = []
  await new Promise<void>((resolve, reject) => {
    let carry: Buffer = Buffer.alloc(0)
    const rs = createReadStream(path, { start: header.dataOffset, end: header.dataOffset + dataBytes - 1, highWaterMark: 1 << 18 })
    rs.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
      let off = 0
      while (off + frameBytes <= buf.length) {
        let sum = 0
        for (let i = 0; i < frameBytes; i += 2) {
          const v = buf.readInt16LE(off + i) / 32768
          sum += v * v
        }
        energies.push(Math.sqrt(sum / (frameBytes / 2)))
        off += frameBytes
      }
      carry = Buffer.from(buf.subarray(off))
    })
    rs.on('end', resolve)
    rs.on('error', reject)
  })

  // Pass 2: choose boundaries.
  const out: JobSource[] = []
  let startFrame = 0
  const framesPerWindow = Math.floor(maxWindowMs / frameMs)
  const searchFrames = Math.floor(searchBackMs / frameMs)
  while (startFrame < energies.length) {
    let endFrame = Math.min(energies.length, startFrame + framesPerWindow)
    if (endFrame < energies.length) {
      // Find the quietest frame in [endFrame - searchFrames, endFrame).
      let best = endFrame
      let bestE = Number.POSITIVE_INFINITY
      for (let f = Math.max(startFrame + 1, endFrame - searchFrames); f < endFrame; f++) {
        if (energies[f] < bestE) {
          bestE = energies[f]
          best = f
        }
      }
      endFrame = best
    }
    const offsetMs = startFrame * frameMs
    const durationMs = (endFrame - startFrame) * frameMs
    out.push({
      path,
      offsetMs,
      durationMs,
      channel,
      byteStart: header.dataOffset + startFrame * frameBytes,
      byteEnd: header.dataOffset + endFrame * frameBytes
    })
    startFrame = endFrame
  }
  return out
}

/** Reads the PCM bytes of one window. */
export async function readWindow(src: JobSource): Promise<Buffer> {
  const fh = await open(src.path, 'r')
  try {
    if (src.byteStart !== undefined && src.byteEnd !== undefined) {
      const len = Math.max(0, src.byteEnd - src.byteStart)
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, src.byteStart)
      return buf
    }
    const size = (await fh.stat()).size
    const buf = Buffer.alloc(Math.max(0, size - WAV_HEADER_BYTES))
    await fh.read(buf, 0, buf.length, WAV_HEADER_BYTES)
    return buf
  } finally {
    await fh.close()
  }
}

/** Returns true when a window is effectively silent (skip it to save CPU; nothing is lost). */
export function isSilentPcm(pcm: Buffer, threshold = 0.004): boolean {
  if (pcm.length < 2) return true
  let sum = 0
  const n = pcm.length / 2
  for (let i = 0; i < pcm.length; i += 2) {
    const v = pcm.readInt16LE(i) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n) < threshold
}
