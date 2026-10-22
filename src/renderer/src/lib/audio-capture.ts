// Real microphone + system-audio capture for the renderer.
// Produces PCM16 mono 16 kHz chunks for main (`window.minutes.recording.pushChunk`).
// Nothing here is simulated: if a device or loopback is unavailable the caller is told so.

import type { AudioChunk } from '@shared/api'
import type { AudioDevice } from '@shared/types'

export const TARGET_RATE = 16000
/** Worklet posts a frame every FRAME_QUANTA * 128 samples (~100 ms at 48 kHz). */
const FRAME_QUANTA_TARGET_MS = 100
/** Chunks handed to main are ~250 ms of 16 kHz audio. */
const CHUNK_SAMPLES = Math.round(TARGET_RATE * 0.25)
/** Level callbacks are throttled to ~15 Hz per channel. */
const LEVEL_INTERVAL_MS = 1000 / 15

export type CaptureChannel = 'mic' | 'system'

export interface CaptureStartOptions {
  micDeviceId: string | null
  systemAudio: boolean
  onLevel: (ch: CaptureChannel, rms: number) => void
  onChunk: (chunk: AudioChunk) => void
  /** Non-fatal problems (e.g. system audio unavailable). Recording continues. */
  onError: (msg: string) => void
  /** The microphone track ended (device unplugged / disabled). Caller should stop. */
  onDeviceLost: () => void
}

export interface CaptureStartResult {
  micLabel: string | null
  systemAudio: boolean
  contextSampleRate: number
}

// ---------- pure helpers (unit tested) ----------

/**
 * Linear-interpolation downsampler to 16 kHz. Pure: same input → same output.
 * Returns the input (copied) unchanged when `fromRate` is already 16 kHz.
 * Upsampling is not supported (returns input copy) — every real capture rate is ≥ 16 kHz.
 */
export function downsampleTo16k(float32: Float32Array, fromRate: number): Float32Array {
  if (!Number.isFinite(fromRate) || fromRate <= TARGET_RATE) return Float32Array.from(float32)
  const ratio = fromRate / TARGET_RATE
  const outLength = Math.floor(float32.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const a = float32[idx]
    const b = idx + 1 < float32.length ? float32[idx + 1] : a
    out[i] = a + (b - a) * frac
  }
  return out
}

/** Float [-1, 1] → Int16 with hard clipping. Pure. */
export function floatToInt16(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    let v = float32[i]
    if (v > 1) v = 1
    else if (v < -1) v = -1
    else if (Number.isNaN(v)) v = 0
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
  }
  return out
}

/** Root-mean-square of a float frame, 0..1. Pure. */
export function rmsOf(float32: Float32Array): number {
  if (float32.length === 0) return 0
  let sum = 0
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i]
  return Math.sqrt(sum / float32.length)
}

// ---------- worklet source ----------

/**
 * Inline AudioWorkletProcessor: accumulates the first input channel and posts a Float32Array every
 * `quanta` render quanta (128 samples each). Transferred, so no copying on the worklet side.
 */
const WORKLET_SOURCE = `
class MinutesTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const quanta = (options && options.processorOptions && options.processorOptions.quanta) || 32
    this.size = quanta * 128
    this.buf = new Float32Array(this.size)
    this.pos = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input[0]
    if (!ch) return true
    let i = 0
    while (i < ch.length) {
      const n = Math.min(ch.length - i, this.size - this.pos)
      this.buf.set(ch.subarray(i, i + n), this.pos)
      this.pos += n
      i += n
      if (this.pos >= this.size) {
        const out = this.buf
        this.port.postMessage(out, [out.buffer])
        this.buf = new Float32Array(this.size)
        this.pos = 0
      }
    }
    return true
  }
}
registerProcessor('minutes-tap', MinutesTapProcessor)
`

// ---------- per-stream tap ----------

interface Tap {
  channel: CaptureChannel
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode | ScriptProcessorNode
  /** Zero-gain sink so the graph renders without audible output. */
  sink: GainNode
  acc: Int16Array[]
  accSamples: number
  chunkStartMs: number
  lastLevelAt: number
}

/**
 * Owns one AudioContext and one tap per media stream. Lifecycle: start → (pause/resume)* → stop.
 * `stop()` releases every track, node and the context; it is safe to call more than once.
 */
export class AudioCapture {
  private ctx: AudioContext | null = null
  private taps: Tap[] = []
  private opts: CaptureStartOptions | null = null
  private workletUrl: string | null = null
  private running = false
  private paused = false
  private startedAt = 0
  private pausedAt: number | null = null
  private pausedTotal = 0

  /** Enumerate microphones. Requests a short-lived permission when labels are hidden. */
  static async listInputs(): Promise<AudioDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    let devices = await navigator.mediaDevices.enumerateDevices()
    let inputs = devices.filter((d) => d.kind === 'audioinput')
    if (inputs.some((d) => !d.label)) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach((t) => t.stop())
        devices = await navigator.mediaDevices.enumerateDevices()
        inputs = devices.filter((d) => d.kind === 'audioinput')
      } catch {
        // Permission denied or no device: return whatever we have (labels may be empty).
      }
    }
    return inputs.map((d) => ({ deviceId: d.deviceId, label: d.label, kind: 'audioinput' as const }))
  }

  /** Elapsed capture time in ms, excluding paused time. */
  get elapsedMs(): number {
    if (!this.running) return 0
    const end = this.pausedAt ?? performance.now()
    return Math.max(0, end - this.startedAt - this.pausedTotal)
  }

  get isRunning(): boolean {
    return this.running
  }

  get isPaused(): boolean {
    return this.paused
  }

  get hasSystemAudio(): boolean {
    return this.taps.some((t) => t.channel === 'system')
  }

  async start(opts: CaptureStartOptions): Promise<CaptureStartResult> {
    if (this.running) throw new Error('Capture already running')
    this.opts = opts
    let micStream: MediaStream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      })
    } catch (err) {
      throw new Error(describeMediaError(err, 'microphone'))
    }
    const micTrack = micStream.getAudioTracks()[0]
    if (!micTrack) {
      micStream.getTracks().forEach((t) => t.stop())
      throw new Error('No microphone track was returned by the system')
    }

    let systemStream: MediaStream | null = null
    if (opts.systemAudio) {
      try {
        // Chromium requires video:true in the request; main's display-media handler only returns audio.
        const ds = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        ds.getVideoTracks().forEach((t) => {
          t.stop()
          ds.removeTrack(t)
        })
        if (ds.getAudioTracks().length === 0) {
          ds.getTracks().forEach((t) => t.stop())
          opts.onError('System audio is not available on this device')
        } else systemStream = ds
      } catch (err) {
        opts.onError(`System audio is not available on this device (${shortError(err)})`)
      }
    }

    try {
      const ctx = new AudioContext()
      this.ctx = ctx
      if (ctx.state === 'suspended') await ctx.resume()
      const useWorklet = await this.loadWorklet(ctx)
      this.running = true
      this.paused = false
      this.pausedAt = null
      this.pausedTotal = 0
      this.startedAt = performance.now()

      this.taps.push(this.makeTap(ctx, 'mic', micStream, useWorklet))
      if (systemStream) this.taps.push(this.makeTap(ctx, 'system', systemStream, useWorklet))

      micTrack.addEventListener('ended', () => {
        if (this.running) this.opts?.onDeviceLost()
      })
      systemStream?.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (!this.running) return
        const tap = this.taps.find((t) => t.channel === 'system')
        if (tap) {
          this.flushTap(tap)
          this.teardownTap(tap)
          this.taps = this.taps.filter((t) => t !== tap)
        }
        this.opts?.onError('System audio stopped; continuing with microphone only')
      })

      return { micLabel: micTrack.label || null, systemAudio: !!systemStream, contextSampleRate: ctx.sampleRate }
    } catch (err) {
      micStream.getTracks().forEach((t) => t.stop())
      systemStream?.getTracks().forEach((t) => t.stop())
      await this.stop()
      throw err instanceof Error ? err : new Error(String(err))
    }
  }

  pause(): void {
    if (!this.running || this.paused) return
    // Hand over whatever is buffered so the pre-pause audio is not lost.
    for (const tap of this.taps) this.flushTap(tap)
    this.paused = true
    this.pausedAt = performance.now()
  }

  resume(): void {
    if (!this.running || !this.paused) return
    this.pausedTotal += performance.now() - (this.pausedAt ?? performance.now())
    this.pausedAt = null
    this.paused = false
  }

  /** Releases tracks, nodes, worklet URL and the AudioContext. Idempotent. */
  async stop(): Promise<void> {
    const wasRunning = this.running
    this.running = false
    this.paused = false
    this.pausedAt = null
    if (wasRunning) for (const tap of this.taps) this.flushTap(tap)
    for (const tap of this.taps) this.teardownTap(tap)
    this.taps = []
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
    }
    const ctx = this.ctx
    this.ctx = null
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close()
      } catch {
        /* already closing */
      }
    }
    this.opts = null
  }

  // ---------- internals ----------

  private async loadWorklet(ctx: AudioContext): Promise<boolean> {
    if (!ctx.audioWorklet) return false
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      this.workletUrl = url
      await ctx.audioWorklet.addModule(url)
      return true
    } catch {
      // Typically a CSP (`script-src`) rejection of the blob: module. Fall back to ScriptProcessorNode.
      if (this.workletUrl) URL.revokeObjectURL(this.workletUrl)
      this.workletUrl = null
      return false
    }
  }

  private makeTap(ctx: AudioContext, channel: CaptureChannel, stream: MediaStream, useWorklet: boolean): Tap {
    const source = ctx.createMediaStreamSource(stream)
    const sink = ctx.createGain()
    sink.gain.value = 0
    const quanta = Math.max(1, Math.round((ctx.sampleRate * FRAME_QUANTA_TARGET_MS) / 1000 / 128))
    const tap: Tap = { channel, stream, source, node: null as unknown as AudioWorkletNode, sink, acc: [], accSamples: 0, chunkStartMs: 0, lastLevelAt: 0 }

    if (useWorklet) {
      const node = new AudioWorkletNode(ctx, 'minutes-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { quanta }
      })
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame(tap, e.data, ctx.sampleRate)
      tap.node = node
    } else {
      // Deprecated but universally available; buffer size must be a power of two.
      const bufferSize = 4096
      const node = ctx.createScriptProcessor(bufferSize, 1, 1)
      node.onaudioprocess = (e) => {
        if (!this.running) return
        this.onFrame(tap, Float32Array.from(e.inputBuffer.getChannelData(0)), ctx.sampleRate)
      }
      tap.node = node
    }
    source.connect(tap.node)
    tap.node.connect(sink)
    sink.connect(ctx.destination)
    return tap
  }

  private onFrame(tap: Tap, frame: Float32Array, fromRate: number): void {
    if (!this.running || !this.opts) return
    const now = performance.now()
    if (now - tap.lastLevelAt >= LEVEL_INTERVAL_MS) {
      tap.lastLevelAt = now
      this.opts.onLevel(tap.channel, this.paused ? 0 : rmsOf(frame))
    }
    if (this.paused) return
    const frameMs = (frame.length / fromRate) * 1000
    if (tap.accSamples === 0) tap.chunkStartMs = Math.max(0, this.elapsedMs - frameMs)
    const pcm = floatToInt16(downsampleTo16k(frame, fromRate))
    tap.acc.push(pcm)
    tap.accSamples += pcm.length
    if (tap.accSamples >= CHUNK_SAMPLES) this.flushTap(tap)
  }

  private flushTap(tap: Tap): void {
    if (tap.accSamples === 0 || !this.opts) return
    // Fresh ArrayBuffer so the caller may transfer it without touching our buffers.
    const merged = new Int16Array(tap.accSamples)
    let off = 0
    for (const part of tap.acc) {
      merged.set(part, off)
      off += part.length
    }
    tap.acc = []
    tap.accSamples = 0
    this.opts.onChunk({ pcm: merged.buffer, sampleRate: TARGET_RATE, channel: tap.channel, offsetMs: Math.round(tap.chunkStartMs) })
  }

  private teardownTap(tap: Tap): void {
    try {
      if ('port' in tap.node) tap.node.port.onmessage = null
      else (tap.node as ScriptProcessorNode).onaudioprocess = null
      tap.source.disconnect()
      tap.node.disconnect()
      tap.sink.disconnect()
    } catch {
      /* already disconnected */
    }
    tap.stream.getTracks().forEach((t) => t.stop())
  }
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.name === 'Error' || !err.name ? err.message : err.name
  return String(err)
}

function describeMediaError(err: unknown, what: string): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `Access to the ${what} was denied. Allow microphone access for Minutes in Windows Settings › Privacy › Microphone.`
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `The selected ${what} was not found. Pick another input device in Settings › Audio.`
    case 'NotReadableError':
    case 'AbortError':
      return `The ${what} is in use by another application or could not be started.`
    default:
      return `Could not start the ${what}: ${err instanceof Error ? err.message : String(err)}`
  }
}
