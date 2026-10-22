// Scriptable stand-in for WhisperEngine. Mimics only the public surface TranscriptionService uses
// so the orchestration (planning, live sessions, crash containment, the job runner) can be tested
// without the whisper.cpp runtime. Cast with `as unknown as WhisperEngine` where a real one is typed.
import { EventEmitter } from 'node:events'
import type { EngineStatus } from '@shared/transcription-types'
import { EngineError, type WhisperEngine, type WhisperSegment, type TranscribeOptions } from '../../../src/main/services/whisper/whisper-engine'

export interface FakeRequest {
  kind: 'pcm' | 'wav'
  /** PCM byte length (pcm) or file path (wav). */
  input: number | string
  opts: TranscribeOptions
}

export class FakeWhisperEngine extends EventEmitter {
  private loaded = false
  private modelId: string | null = null
  private threads = 0
  /** Segments returned by every request (relative to the chunk start). */
  segments: WhisperSegment[] = [{ startMs: 0, endMs: 900, text: 'hello world', confidence: 0.9 }]
  /** Artificial processing time per request, ms. */
  delayMs = 0
  /** When true, load() rejects with LOAD_FAILED. */
  failLoad = false
  /** Reported by runtimeAvailable(). */
  runtime: { ok: boolean; detail: string } = { ok: true, detail: 'fake runtime' }
  /** Reported by workerMemoryBytes(). */
  memoryBytes: number | null = 300 * 1024 * 1024
  loadCalls: { modelId: string; path: string; threads: number }[] = []
  requests: FakeRequest[] = []
  private crashQueued = 0

  /** Make the next `n` requests crash the (fake) process: they reject with CRASHED and emit 'crashed'. */
  crashNext(n = 1): void {
    this.crashQueued += n
  }

  get transcribeCalls(): number {
    return this.requests.length
  }

  runtimeAvailable(): { ok: boolean; detail: string } {
    return this.runtime
  }

  status(): EngineStatus {
    return {
      engine: 'whisper',
      runtimeAvailable: this.runtime.ok,
      runtimeDetail: this.runtime.detail,
      runtimeVersion: 'fake',
      loadedModelId: this.modelId,
      processAlive: this.loaded,
      lastError: null,
      loadTimeMs: this.loaded ? 1 : null,
      workerMemoryBytes: null,
      cpuVariant: null,
      checkedAt: Date.now()
    }
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get currentModelId(): string | null {
    return this.modelId
  }

  get currentThreads(): number {
    return this.threads
  }

  get pid(): number | null {
    return this.loaded ? 4242 : null
  }

  get pendingRequests(): number {
    return 0
  }

  async load(modelId: string, path: string, threads: number): Promise<void> {
    this.loadCalls.push({ modelId, path, threads })
    if (!this.runtime.ok) throw new EngineError(this.runtime.detail, 'RUNTIME_MISSING')
    if (this.failLoad) {
      this.loaded = false
      this.modelId = null
      throw new EngineError('fake load failure', 'LOAD_FAILED')
    }
    this.loaded = true
    this.modelId = modelId
    this.threads = threads
  }

  async stop(): Promise<void> {
    this.loaded = false
    this.modelId = null
  }

  async transcribePcm(pcm: Buffer, opts: TranscribeOptions = {}): Promise<WhisperSegment[]> {
    this.requests.push({ kind: 'pcm', input: pcm.length, opts })
    return this.run(opts)
  }

  async transcribeWavFile(path: string, opts: TranscribeOptions = {}): Promise<WhisperSegment[]> {
    this.requests.push({ kind: 'wav', input: path, opts })
    return this.run(opts)
  }

  private async run(opts: TranscribeOptions): Promise<WhisperSegment[]> {
    if (!this.loaded) throw new EngineError('No model is loaded', 'NOT_LOADED')
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (opts.signal?.aborted) throw new EngineError('Transcription cancelled', 'ABORTED')
    if (this.crashQueued > 0) {
      this.crashQueued--
      this.loaded = false
      this.modelId = null
      this.emit('crashed', 139, 'segfault')
      throw new EngineError('whisper.cpp process is not running', 'CRASHED')
    }
    return this.segments.map((s) => ({ ...s }))
  }

  workerMemoryBytes(): number | null {
    return this.loaded ? this.memoryBytes : null
  }

  modelFileBytes(): number | null {
    return null
  }
}

export function fakeEngine(): { fake: FakeWhisperEngine; engine: WhisperEngine } {
  const fake = new FakeWhisperEngine()
  return { fake, engine: fake as unknown as WhisperEngine }
}
