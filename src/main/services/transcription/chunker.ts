// Cuts a continuous 16 kHz PCM16 stream into WAV chunk files at speech pauses
// so the (file-based) SAPI worker can transcribe them one at a time.
//
// Pure logic apart from the file write, which is injectable for tests.

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { rmsLevel, writeWav } from './wav'

export interface SpeechChunk {
  path: string
  /** Milliseconds since recording start of the first sample in the file. */
  offsetMs: number
  durationMs: number
  /** Sequence number of the written file (1-based). */
  seq: number
}

export interface SpeechChunkerOptions {
  workDir: string
  sampleRate?: number
  /** Pause length that closes a chunk. Default 1000 ms. */
  trailingSilenceMs?: number
  /** Minimum audio before a pause may close a chunk. Default 3000 ms. */
  minChunkMs?: number
  /** Hard cut. Default 25000 ms. */
  maxChunkMs?: number
  /** Analysis window. Default 20 ms. */
  windowMs?: number
  /** Absolute RMS floor (0..1) below which audio is always "silence". Default 0.008 (~ -42 dBFS); 0.004 let AGC-lifted office noise through as "speech" on the first Windows install. */
  minFloor?: number
  /** Threshold = max(minFloor, noiseMultiplier × running noise floor). Default 2. */
  noiseMultiplier?: number
  /** Upper bound for the adaptive noise floor (0..1). Default 0.02 (~ -34 dBFS). */
  maxFloor?: number
  /** A gap in offsetMs larger than this closes the current chunk. Default 750 ms. */
  maxGapMs?: number
  /** File name prefix. Default "chunk". */
  filePrefix?: string
  /** Injected writer (tests). Default writes a real WAV. */
  writeFile?: (path: string, pcm16: Int16Array, sampleRate: number) => void
}

export interface SpeechChunkerStats {
  emitted: number
  skippedSilent: number
  /** Chunks closed by the hard length limit. */
  cutAtMax: number
  /** Chunks closed by a detected pause. */
  cutAtPause: number
  noiseFloor: number
  threshold: number
}

export interface SpeechChunkerEvents {
  chunk: (chunk: SpeechChunk) => void
  silent: (info: { offsetMs: number; durationMs: number }) => void
}

export declare interface SpeechChunker {
  on<K extends keyof SpeechChunkerEvents>(event: K, listener: SpeechChunkerEvents[K]): this
  once<K extends keyof SpeechChunkerEvents>(event: K, listener: SpeechChunkerEvents[K]): this
  off<K extends keyof SpeechChunkerEvents>(event: K, listener: SpeechChunkerEvents[K]): this
  emit<K extends keyof SpeechChunkerEvents>(event: K, ...args: Parameters<SpeechChunkerEvents[K]>): boolean
}

export class SpeechChunker extends EventEmitter {
  readonly sampleRate: number
  private readonly workDir: string
  private readonly trailingSilenceMs: number
  private readonly minChunkMs: number
  private readonly maxChunkMs: number
  private readonly windowSamples: number
  private readonly windowMs: number
  private readonly minFloor: number
  private readonly noiseMultiplier: number
  private readonly maxFloor: number
  private readonly maxGapMs: number
  private readonly filePrefix: string
  private readonly writeFile: (path: string, pcm16: Int16Array, sampleRate: number) => void

  // Current chunk buffer
  private buf: Int16Array
  private len = 0
  private chunkStartMs: number | null = null
  /** Expected offsetMs of the next incoming sample (continuity check). */
  private expectedNextMs: number | null = null

  // Analysis state
  private analysed = 0 // samples of `buf` already analysed
  private trailingSilence = 0 // ms
  private hadSpeech = false
  private noiseFloor: number
  private seq = 0

  private readonly _stats: SpeechChunkerStats

  constructor(opts: SpeechChunkerOptions) {
    super()
    this.workDir = opts.workDir
    this.sampleRate = opts.sampleRate ?? 16000
    this.trailingSilenceMs = opts.trailingSilenceMs ?? 1000
    this.minChunkMs = opts.minChunkMs ?? 3000
    this.maxChunkMs = opts.maxChunkMs ?? 25000
    this.windowMs = opts.windowMs ?? 20
    this.windowSamples = Math.max(1, Math.round((this.sampleRate * this.windowMs) / 1000))
    this.minFloor = opts.minFloor ?? 0.008
    this.noiseMultiplier = opts.noiseMultiplier ?? 2
    this.maxFloor = Math.max(opts.maxFloor ?? 0.02, this.minFloor)
    this.maxGapMs = opts.maxGapMs ?? 750
    this.filePrefix = opts.filePrefix ?? 'chunk'
    this.writeFile = opts.writeFile ?? ((p, pcm, sr) => writeWav(p, pcm, sr, 1))
    this.noiseFloor = this.minFloor
    this.buf = new Int16Array(Math.ceil((this.sampleRate * (this.maxChunkMs + 1000)) / 1000))
    this._stats = { emitted: 0, skippedSilent: 0, cutAtMax: 0, cutAtPause: 0, noiseFloor: this.noiseFloor, threshold: this.threshold }
  }

  get stats(): SpeechChunkerStats {
    return { ...this._stats, noiseFloor: this.noiseFloor, threshold: this.threshold }
  }

  get threshold(): number {
    return Math.max(this.minFloor, this.noiseFloor * this.noiseMultiplier)
  }

  /** Milliseconds currently buffered and not yet emitted. */
  get pendingMs(): number {
    return (this.len * 1000) / this.sampleRate
  }

  /**
   * Feed PCM16 mono samples at `sampleRate`. `offsetMs` is the recording
   * timestamp of the first sample. Frames are expected in order.
   */
  push(pcm16: Int16Array, offsetMs: number): void {
    if (pcm16.length === 0) return

    // Discontinuity (pause/resume, dropped frames): close what we have.
    if (this.expectedNextMs !== null && this.len > 0 && Math.abs(offsetMs - this.expectedNextMs) > this.maxGapMs) {
      this.closeChunk('gap')
    }

    let consumed = 0
    while (consumed < pcm16.length) {
      if (this.chunkStartMs === null) {
        this.chunkStartMs = offsetMs + (consumed * 1000) / this.sampleRate
      }
      const room = this.buf.length - this.len
      const take = Math.min(room, pcm16.length - consumed)
      this.buf.set(pcm16.subarray(consumed, consumed + take), this.len)
      this.len += take
      consumed += take
      this.analyse()
      if (this.len >= this.maxSamples) {
        this._stats.cutAtMax++
        this.closeChunk('max')
      } else if (this.trailingSilence >= this.trailingSilenceMs && this.pendingMs >= this.minChunkMs) {
        this._stats.cutAtPause++
        this.closeChunk('pause')
      }
    }
    this.expectedNextMs = offsetMs + (pcm16.length * 1000) / this.sampleRate
  }

  /** Emit whatever is buffered (end of recording). Returns the chunk if one was written. */
  flush(): SpeechChunk | null {
    if (this.len === 0) return null
    return this.closeChunk('flush')
  }

  private get maxSamples(): number {
    return Math.round((this.sampleRate * this.maxChunkMs) / 1000)
  }

  private analyse(): void {
    while (this.len - this.analysed >= this.windowSamples) {
      const win = this.buf.subarray(this.analysed, this.analysed + this.windowSamples)
      this.analysed += this.windowSamples
      const rms = rmsLevel(win)

      // Adaptive noise floor: tracks down quickly, up slowly (time constant
      // ~10 s) and never above maxFloor, so sustained speech cannot lift it
      // into "silence" territory but a change of ambient hum is followed.
      if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.8 + rms * 0.2
      else this.noiseFloor = this.noiseFloor * 0.998 + rms * 0.002
      if (this.noiseFloor < 1e-5) this.noiseFloor = 1e-5
      if (this.noiseFloor > this.maxFloor) this.noiseFloor = this.maxFloor

      if (rms >= this.threshold) {
        this.hadSpeech = true
        this.trailingSilence = 0
      } else {
        this.trailingSilence += this.windowMs
      }
    }
  }

  private closeChunk(_reason: 'pause' | 'max' | 'gap' | 'flush'): SpeechChunk | null {
    const samples = this.len
    const offsetMs = this.chunkStartMs ?? 0
    const durationMs = (samples * 1000) / this.sampleRate
    const hadSpeech = this.hadSpeech
    const pcm = this.buf.slice(0, samples)

    // Reset state before emitting so listeners may push synchronously.
    this.len = 0
    this.analysed = 0
    this.trailingSilence = 0
    this.hadSpeech = false
    this.chunkStartMs = null

    if (!hadSpeech || samples === 0) {
      this._stats.skippedSilent++
      this.emit('silent', { offsetMs, durationMs })
      return null
    }

    this.seq++
    const path = join(this.workDir, `${this.filePrefix}-${String(this.seq).padStart(6, '0')}.wav`)
    this.writeFile(path, pcm, this.sampleRate)
    this._stats.emitted++
    const chunk: SpeechChunk = { path, offsetMs: Math.round(offsetMs), durationMs: Math.round(durationMs), seq: this.seq }
    this.emit('chunk', chunk)
    return chunk
  }
}
