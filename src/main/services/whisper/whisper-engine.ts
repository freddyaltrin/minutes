// Process host for the whisper.cpp HTTP server. The native library runs in its own process so a
// crash (bad model file, unsupported instruction, out-of-memory) never takes the app down; the
// host reports it and the caller decides whether to restart.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { EngineStatus } from '@shared/transcription-types'
import { buildWavHeader } from '../transcription/wav'

export interface WhisperSegment {
  startMs: number
  endMs: number
  text: string
  /** Average token probability when the server reports it (verbose_json), else null. */
  confidence: number | null
}

export interface TranscribeOptions {
  language?: string | null
  /** Text context from the previous window (keeps spelling/casing consistent across chunks). */
  prompt?: string
  temperature?: number
  signal?: AbortSignal
}

export interface WhisperEngineOptions {
  runtimeDir: string
  log: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void }
  /** Startup timeout for model loading. Large models on slow disks can take a while. */
  loadTimeoutMs?: number
  requestTimeoutMs?: number
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: 'RUNTIME_MISSING' | 'LOAD_FAILED' | 'LOAD_TIMEOUT' | 'CRASHED' | 'REQUEST_FAILED' | 'NOT_LOADED' | 'ABORTED' | 'BUSY'
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export interface WhisperEngineEvents {
  status: [EngineStatus]
  log: [level: 'info' | 'warn' | 'error', message: string]
  /** The ggml CPU backend variant the runtime selected (e.g. "haswell", "x64"). */
  cpuVariant: [variant: string]
  crashed: [exitCode: number | null, stderrTail: string]
}

/** Returns the runtime directory for this platform under `resourcesRoot`. */
export function runtimeDirFor(resourcesRoot: string, platform = process.platform, arch = process.arch): string {
  return join(resourcesRoot, 'whisper', `${platform === 'win32' ? 'win' : platform}-${arch}`)
}

export function serverBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'whisper-server.exe' : 'whisper-server'
}

export function readRuntimeVersion(runtimeDir: string): string | null {
  try {
    return readFileSync(join(runtimeDir, 'VERSION'), 'utf8').trim() || null
  } catch {
    return null
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Whisper is known to invent short stock phrases on silence or background noise ("Thanks for
 * watching.", "Subtitles by …", a lone "you"). whisper.cpp reports, per segment, the probability
 * that the window held no speech and the mean token log-probability; the OpenAI reference
 * implementation treats no_speech_prob > 0.6 together with avg_logprob < −1.0 as "no speech".
 * The stock-phrase list is applied only when the no-speech probability is already elevated, so
 * a real "thank you" in a meeting is kept. Seen on the first Windows installation, 2026-10-20:
 * a 90 s recording of office noise produced exactly one segment, "Thanks for watching. Bye!".
 */
export function isLikelyHallucination(seg: { text: string; avg_logprob?: number; no_speech_prob?: number }): boolean {
  const noSpeech = typeof seg.no_speech_prob === 'number' ? seg.no_speech_prob : 0
  const logprob = typeof seg.avg_logprob === 'number' ? seg.avg_logprob : 0
  if (noSpeech > 0.6 && logprob < -1.0) return true
  const norm = seg.text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!norm) return false
  if (noSpeech > 0.3 && HALLUCINATION_PHRASES.some((p) => norm === p || norm.startsWith(p + ' ') || norm.endsWith(' ' + p))) return true
  return false
}

const HALLUCINATION_PHRASES = [
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'thank you for listening',
  'subtitles by',
  'subtitles by the amara org community',
  'please subscribe',
  'like and subscribe',
  'see you in the next video',
  'bye',
  'you',
  'thank you'
]

export class WhisperEngine extends EventEmitter<WhisperEngineEvents> {
  private child: ChildProcess | null = null
  private port = 0
  private loadedModelId: string | null = null
  private loadedModelPath: string | null = null
  private threads = 0
  private loadTimeMs: number | null = null
  private lastError: string | null = null
  private stderrTail: string[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private pending = 0
  private stopping = false
  private readonly opts: Required<Pick<WhisperEngineOptions, 'loadTimeoutMs' | 'requestTimeoutMs'>> & WhisperEngineOptions
  private readonly spawnImpl: typeof spawn
  private readonly fetchImpl: typeof fetch

  constructor(options: WhisperEngineOptions) {
    super()
    this.opts = { loadTimeoutMs: 180_000, requestTimeoutMs: 600_000, ...options }
    this.spawnImpl = options.spawnImpl ?? spawn
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  get binaryPath(): string {
    return join(this.opts.runtimeDir, serverBinaryName())
  }

  runtimeAvailable(): { ok: boolean; detail: string } {
    if (!existsSync(this.binaryPath)) return { ok: false, detail: `Runtime not found at ${this.binaryPath}` }
    const dlls = (() => {
      try {
        return readdirSync(this.opts.runtimeDir).filter((f) => /ggml-cpu/.test(f))
      } catch {
        return []
      }
    })()
    if (process.platform === 'win32' && dlls.length === 0) return { ok: false, detail: 'Runtime is missing the ggml CPU backend libraries' }
    return { ok: true, detail: `whisper.cpp runtime (CPU, ${dlls.length} CPU backend variant${dlls.length === 1 ? '' : 's'})` }
  }

  status(): EngineStatus {
    const rt = this.runtimeAvailable()
    return {
      engine: 'whisper',
      runtimeAvailable: rt.ok,
      runtimeDetail: rt.detail,
      runtimeVersion: readRuntimeVersion(this.opts.runtimeDir),
      loadedModelId: this.loadedModelId,
      processAlive: !!this.child && this.child.exitCode === null && !this.child.killed,
      lastError: this.lastError,
      loadTimeMs: this.loadTimeMs,
      workerMemoryBytes: null,
      cpuVariant: null,
      checkedAt: Date.now()
    }
  }

  get isLoaded(): boolean {
    return this.status().processAlive && this.loadedModelId !== null
  }

  get currentModelId(): string | null {
    return this.loadedModelId
  }

  get currentThreads(): number {
    return this.threads
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get pendingRequests(): number {
    return this.pending
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  /**
   * Starts a server process with the given model. Any previously loaded model is unloaded first
   * (single-model policy). Rejects with EngineError on failure; the process is never left running
   * after a failed load.
   */
  async load(modelId: string, modelPath: string, threads: number): Promise<void> {
    if (this.pending > 0) throw new EngineError('Engine is busy', 'BUSY')
    const rt = this.runtimeAvailable()
    if (!rt.ok) throw new EngineError(rt.detail, 'RUNTIME_MISSING')
    if (!existsSync(modelPath)) throw new EngineError(`Model file not found: ${modelPath}`, 'LOAD_FAILED')
    await this.stop()
    this.stopping = false
    this.lastError = null
    this.stderrTail = []
    this.port = await freePort()
    const t0 = Date.now()
    const args = ['-m', modelPath, '-t', String(Math.max(1, threads)), '--host', '127.0.0.1', '--port', String(this.port), '--no-gpu']
    this.opts.log.info('whisper: starting server', { modelId, threads, port: this.port })
    const child = this.spawnImpl(this.binaryPath, args, { cwd: this.opts.runtimeDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this.loadedModelId = modelId
    this.loadedModelPath = modelPath
    this.threads = threads

    const onLine = (line: string): void => {
      if (!line.trim()) return
      this.stderrTail.push(line)
      if (this.stderrTail.length > 60) this.stderrTail.shift()
      const m = /loaded CPU backend from .*ggml-cpu-([a-z0-9]+)/i.exec(line)
      if (m) this.emit('cpuVariant', m[1])
      if (/error|failed|cannot/i.test(line)) this.emit('log', 'warn', line)
    }
    let buf = ''
    const consume = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const parts = buf.split(/\r?\n/)
      buf = parts.pop() ?? ''
      parts.forEach(onLine)
    }
    child.stderr?.on('data', consume)
    child.stdout?.on('data', consume)

    let exited = false
    let exitCode: number | null = null
    child.once('exit', (code) => {
      exited = true
      exitCode = code
      if (this.child === child) this.child = null
      if (!this.stopping) {
        this.lastError = `whisper.cpp process exited unexpectedly (code ${code ?? 'signal'}). ${this.stderrTail.slice(-3).join(' | ')}`.trim()
        this.opts.log.error('whisper: process crashed', { code, tail: this.stderrTail.slice(-10) })
        this.emit('crashed', code, this.stderrTail.join('\n'))
      }
      this.loadedModelId = null
      this.loadedModelPath = null
      this.emitStatus()
    })
    child.once('error', (err) => {
      this.lastError = err.message
      this.opts.log.error('whisper: spawn failed', err)
    })

    // Wait for the HTTP server to answer; the model is loaded before it starts listening.
    const deadline = t0 + this.opts.loadTimeoutMs
    while (Date.now() < deadline) {
      if (exited) {
        const tail = this.stderrTail.slice(-5).join('\n')
        throw new EngineError(`Could not load model (exit code ${exitCode ?? 'signal'}). ${tail}`, 'LOAD_FAILED')
      }
      try {
        const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1500) })
        if (res.status === 200 || res.status === 404) break
      } catch {
        /* not ready yet */
      }
      await delay(150)
    }
    if (Date.now() >= deadline && !exited) {
      await this.stop()
      throw new EngineError('Model loading timed out', 'LOAD_TIMEOUT')
    }
    this.loadTimeMs = Date.now() - t0
    this.opts.log.info('whisper: model ready', { modelId, loadTimeMs: this.loadTimeMs })
    this.emitStatus()
  }

  /** Stops the server process. Safe to call repeatedly. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopping = true
    this.child = null
    this.loadedModelId = null
    this.loadedModelPath = null
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    this.emitStatus()
  }

  /**
   * Transcribes 16 kHz mono PCM16 audio. Requests are serialised: whisper.cpp processes one window
   * at a time and a second request would only queue inside the server while holding memory.
   */
  async transcribePcm(pcm: Buffer, opts: TranscribeOptions = {}): Promise<WhisperSegment[]> {
    if (!this.isLoaded) throw new EngineError('No model is loaded', 'NOT_LOADED')
    const run = async (): Promise<WhisperSegment[]> => {
      const wav = Buffer.concat([buildWavHeader(pcm.length, 16000, 1), pcm])
      const form = new FormData()
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
      form.append('response_format', 'verbose_json')
      form.append('temperature', String(opts.temperature ?? 0))
      form.append('temperature_inc', '0.2')
      form.append('no_timestamps', 'false')
      form.append('suppress_non_speech', 'true')
      if (opts.language) form.append('language', opts.language)
      if (opts.prompt) form.append('prompt', opts.prompt.slice(-400))
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs)
      const onAbort = (): void => controller.abort()
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: controller.signal })
        if (!res.ok) throw new EngineError(`whisper.cpp returned HTTP ${res.status}`, 'REQUEST_FAILED')
        const json = (await res.json()) as { segments?: { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }[]; text?: string }
        const segs = (json.segments ?? [])
          .filter((s) => !isLikelyHallucination(s))
          .map((s) => ({
            startMs: Math.round(s.start * 1000),
            endMs: Math.round(s.end * 1000),
            text: s.text.trim(),
            confidence: typeof s.avg_logprob === 'number' ? Math.max(0, Math.min(1, Math.exp(s.avg_logprob))) : null
          }))
        return segs.filter((s) => s.text.length > 0)
      } catch (err) {
        if (opts.signal?.aborted) throw new EngineError('Transcription cancelled', 'ABORTED')
        if (!this.isLoaded) throw new EngineError(this.lastError ?? 'whisper.cpp process is not running', 'CRASHED')
        if (err instanceof EngineError) throw err
        throw new EngineError(`Request failed: ${(err as Error).message}`, 'REQUEST_FAILED')
      } finally {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
    }
    // Serialise: one request at a time, errors of earlier requests do not block later ones.
    this.pending++
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    try {
      return await p
    } finally {
      this.pending--
    }
  }

  /** Convenience for files produced by the chunker (16 kHz mono PCM16 WAV with a 44-byte header). */
  async transcribeWavFile(path: string, opts: TranscribeOptions = {}): Promise<WhisperSegment[]> {
    const data = await readFile(path)
    if (data.length < 44) return []
    return this.transcribePcm(data.subarray(44), opts)
  }

  /** Resident memory of the worker process when the platform exposes it cheaply. */
  workerMemoryBytes(): number | null {
    const pid = this.pid
    if (!pid) return null
    try {
      if (process.platform === 'linux') {
        const st = readFileSync(`/proc/${pid}/status`, 'utf8')
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(st)
        return m ? Number(m[1]) * 1024 : null
      }
      if (process.platform === 'win32') {
        // tasklist is the cheapest built-in probe (~50 ms); cache it for 10 s so status polls stay light.
        const now = Date.now()
        if (this.winMemCache && now - this.winMemCache.at < 10_000) return this.winMemCache.bytes
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 3000, windowsHide: true })
        // "whisper-server.exe","1234","Console","1","1,23,456 K"
        const m = /"([\d.,\u00a0 ]+) K"\s*$/m.exec(out)
        const bytes = m ? Number(m[1].replace(/[^\d]/g, '')) * 1024 : null
        this.winMemCache = { at: now, bytes }
        return bytes
      }
    } catch {
      /* ignore */
    }
    return null
  }
  private winMemCache: { at: number; bytes: number | null } | null = null

  modelFileBytes(): number | null {
    try {
      return this.loadedModelPath ? statSync(this.loadedModelPath).size : null
    } catch {
      return null
    }
  }
}
