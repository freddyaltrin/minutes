// Node side of the Windows SAPI bridge. Spawns resources/sapi/recognizer.ps1
// under Windows PowerShell 5.1 and talks JSON Lines over stdin/stdout.
//
// Nothing here depends on Electron so it can be unit-tested with a fake
// child process (see `SapiEngineOptions.spawn`).

import { EventEmitter } from 'node:events'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptionEngineInfo, TranscriptionState } from '@shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SapiChannel = 'mic' | 'system' | 'mix'

export interface SapiSegment {
  text: string
  confidence: number
  startMs: number
  endMs: number
  channel: SapiChannel
  lowConfidence: boolean
  /** Which grammar produced the result ("dictation" | "vocabulary" | ""). */
  grammar?: string
}

export interface SapiStartOptions {
  culture: string | null
  vocabulary: string[]
  workDir: string
}

export type SapiLogLevel = 'info' | 'warn' | 'error'

export interface SapiEngineEvents {
  segment: (segment: SapiSegment) => void
  state: (state: TranscriptionState) => void
  error: (error: Error) => void
  log: (level: SapiLogLevel, message: string) => void
  queue: (length: number) => void
  /** A chunk file finished processing (successfully or not). */
  done: (info: { path: string; results: number; failed: boolean }) => void
}

/** The minimal child-process surface the engine needs. `ChildProcess` satisfies it. */
export interface ChildLike {
  pid?: number
  stdin: { write(data: string): unknown; end(): unknown; on?(event: 'error', cb: (e: Error) => void): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals | number): boolean
}

export type SpawnFn = (command: string, args: string[], options: { cwd?: string; windowsHide?: boolean }) => ChildLike

export interface SapiEngineOptions {
  /** Absolute path to recognizer.ps1. Resolved automatically when omitted. */
  scriptPath?: string
  /** Injected spawn (tests). Defaults to node:child_process.spawn. */
  spawn?: SpawnFn
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** powershell.exe path override. */
  powershellPath?: string
  probeTimeoutMs?: number
  initTimeoutMs?: number
  /** Time allowed for one chunk to be recognised before the worker is deemed hung. */
  chunkTimeoutMs?: number
  drainTimeoutMs?: number
}

interface WorkerMessage {
  type: string
  [k: string]: unknown
}

interface QueueItem {
  path: string
  offsetMs: number
  channel: SapiChannel
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** resources/sapi/recognizer.ps1 in dev; <resourcesPath>/sapi/recognizer.ps1 when packaged. */
export function resolveDefaultScriptPath(): string {
  const candidates: string[] = []
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    candidates.push(join(resourcesPath, 'sapi', 'recognizer.ps1'))
    candidates.push(join(resourcesPath, 'app.asar.unpacked', 'resources', 'sapi', 'recognizer.ps1'))
  }
  candidates.push(join(process.cwd(), 'resources', 'sapi', 'recognizer.ps1'))
  for (const c of candidates) if (existsSync(c)) return c
  return candidates[candidates.length - 1]
}

export function resolvePowershellPath(): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(full) ? full : 'powershell.exe'
}

function powershellArgs(scriptPath: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
}

function errorToString(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Splits a byte stream into complete lines; keeps the partial tail. */
export class LineBuffer {
  private tail = ''
  push(chunk: Buffer | string): string[] {
    this.tail += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const parts = this.tail.split('\n')
    this.tail = parts.pop() ?? ''
    return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
  }
  /** Returns the remaining partial line (e.g. at process exit). */
  drain(): string | null {
    const t = this.tail.replace(/\r$/, '')
    this.tail = ''
    return t.length ? t : null
  }
}

export function parseWorkerLine(line: string): WorkerMessage | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const obj = JSON.parse(trimmed) as unknown
    if (obj && typeof obj === 'object' && typeof (obj as WorkerMessage).type === 'string') return obj as WorkerMessage
  } catch {
    /* non-JSON noise */
  }
  return null
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

let probeCache: TranscriptionEngineInfo | null = null

export declare interface SapiEngine {
  on<K extends keyof SapiEngineEvents>(event: K, listener: SapiEngineEvents[K]): this
  once<K extends keyof SapiEngineEvents>(event: K, listener: SapiEngineEvents[K]): this
  off<K extends keyof SapiEngineEvents>(event: K, listener: SapiEngineEvents[K]): this
  emit<K extends keyof SapiEngineEvents>(event: K, ...args: Parameters<SapiEngineEvents[K]>): boolean
}

export class SapiEngine extends EventEmitter {
  private readonly opts: Required<Pick<SapiEngineOptions, 'probeTimeoutMs' | 'initTimeoutMs' | 'chunkTimeoutMs' | 'drainTimeoutMs'>> & SapiEngineOptions
  private readonly spawnFn: SpawnFn
  private readonly platform: NodeJS.Platform

  private child: ChildLike | null = null
  private lines = new LineBuffer()
  private exited = false
  private exitInfo: { code: number | null; signal: string | null } | null = null
  private stopping = false

  private queue: QueueItem[] = []
  private inFlight: { item: QueueItem; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null
  private drainWaiters: (() => void)[] = []
  private exitWaiters: (() => void)[] = []

  private state: TranscriptionState = {
    engine: 'windows-sapi',
    status: 'off',
    queuedChunks: 0,
    recognizedSegments: 0,
    lastError: null
  }

  constructor(options: SapiEngineOptions = {}) {
    super()
    this.opts = {
      probeTimeoutMs: 20_000,
      initTimeoutMs: 30_000,
      chunkTimeoutMs: 120_000,
      drainTimeoutMs: 60_000,
      ...options
    }
    this.spawnFn = options.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike)
    this.platform = options.platform ?? process.platform
  }

  // ---- static probe -------------------------------------------------------

  static clearProbeCache(): void {
    probeCache = null
  }

  /**
   * Checks whether the Windows recognizer can be used. Cached after the first
   * call; pass `refresh=true` to re-run.
   */
  static async probe(options: SapiEngineOptions = {}, refresh = false): Promise<TranscriptionEngineInfo> {
    if (probeCache && !refresh) return probeCache
    const engine = new SapiEngine(options)
    const info = await engine.runProbe()
    probeCache = info
    return info
  }

  private async runProbe(): Promise<TranscriptionEngineInfo> {
    const checkedAt = Date.now()
    if (this.platform !== 'win32') {
      return {
        id: 'windows-sapi',
        name: 'Windows Speech Recognition (SAPI)',
        available: false,
        detail: `Live transcription uses the Windows built-in speech recognizer and is only available on Windows (current platform: ${this.platform}).`,
        languages: [],
        checkedAt
      }
    }
    const scriptPath = this.opts.scriptPath ?? resolveDefaultScriptPath()
    if (!existsSync(scriptPath) && !this.opts.spawn) {
      return {
        id: 'windows-sapi',
        name: 'Windows Speech Recognition (SAPI)',
        available: false,
        detail: `Recognizer script not found at ${scriptPath}.`,
        languages: [],
        checkedAt
      }
    }

    return new Promise<TranscriptionEngineInfo>((resolve) => {
      let settled = false
      const finish = (info: Omit<TranscriptionEngineInfo, 'id' | 'name' | 'checkedAt'>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ id: 'windows-sapi', name: 'Windows Speech Recognition (SAPI)', checkedAt, ...info })
        this.kill()
      }
      const timer = setTimeout(() => {
        finish({ available: false, detail: `The recognizer worker did not answer within ${this.opts.probeTimeoutMs / 1000} s. Check that Windows PowerShell 5.1 is present and not blocked.`, languages: [] })
      }, this.opts.probeTimeoutMs)

      const stderrLines: string[] = []
      try {
        this.spawnChild(scriptPath, {
          onMessage: (msg) => {
            if (msg.type !== 'probe') return
            if (msg.ok === true) {
              const recs = Array.isArray(msg.recognizers) ? (msg.recognizers as { id?: string; name?: string; culture?: string }[]) : []
              const languages = [...new Set(recs.map((r) => String(r.culture ?? '')).filter(Boolean))]
              const names = recs.map((r) => `${r.name ?? r.id ?? '?'} (${r.culture ?? '?'})`).join('; ')
              finish({ available: true, detail: `Installed recognizers: ${names}. .NET ${String(msg.dotnet ?? '?')}. Conventional (non-neural) recognizer — accuracy is modest.`, languages })
            } else {
              finish({ available: false, detail: String(msg.error ?? 'Unknown probe failure'), languages: [] })
            }
          },
          onStderr: (line) => stderrLines.push(line),
          onExit: (code, signal) => {
            finish({
              available: false,
              detail: `The recognizer worker exited before answering (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}). ${stderrLines.slice(-3).join(' | ')}`.trim(),
              languages: []
            })
          },
          onSpawnError: (err) => finish({ available: false, detail: `Could not start Windows PowerShell: ${err.message}`, languages: [] })
        })
      } catch (e) {
        finish({ available: false, detail: `Could not start Windows PowerShell: ${errorToString(e)}`, languages: [] })
        return
      }
      this.send({ cmd: 'probe' })
    })
  }

  // ---- lifecycle ---------------------------------------------------------

  getState(): TranscriptionState {
    return { ...this.state }
  }

  get queueLength(): number {
    return this.queue.length + (this.inFlight ? 1 : 0)
  }

  get isRunning(): boolean {
    return this.child !== null && !this.exited
  }

  async start(opts: SapiStartOptions): Promise<void> {
    if (this.child) throw new Error('SapiEngine already started')
    if (this.platform !== 'win32') throw new Error('SapiEngine is only available on Windows')
    const scriptPath = this.opts.scriptPath ?? resolveDefaultScriptPath()
    this.stopping = false
    this.exited = false
    this.exitInfo = null
    this.lines = new LineBuffer()
    this.state = { engine: 'windows-sapi', status: 'idle', queuedChunks: 0, recognizedSegments: 0, lastError: null }

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null
        reject(new Error(`Recognizer did not become ready within ${this.opts.initTimeoutMs / 1000} s`))
      }, this.opts.initTimeoutMs)
      this.readyWaiter = { resolve, reject, timer }
    })

    try {
      this.spawnChild(scriptPath, {
        onMessage: (m) => this.handleMessage(m),
        onStderr: (line) => this.emit('log', 'warn', `[worker stderr] ${line}`),
        onExit: (code, signal) => this.handleExit(code, signal),
        onSpawnError: (err) => this.failAll(new Error(`Could not start Windows PowerShell: ${err.message}`))
      }, opts.workDir)
    } catch (e) {
      const err = new Error(`Could not start Windows PowerShell: ${errorToString(e)}`)
      this.failAll(err)
      throw err
    }

    this.send({ cmd: 'init', culture: opts.culture, vocabulary: opts.vocabulary.map((v) => v.trim()).filter(Boolean) })
    try {
      await ready
    } catch (e) {
      this.abort(e instanceof Error ? e : new Error(errorToString(e)), false)
      throw e
    }
    this.setState({ status: 'idle' })
  }

  /** Queue a finished WAV file for recognition. Serial processing. */
  feedWav(path: string, offsetMs: number, channel: SapiChannel): void {
    if (!this.child || this.exited) {
      this.emitError(new Error(`feedWav(${path}) called while the recognizer is not running`))
      return
    }
    if (this.stopping) {
      this.emit('log', 'warn', `feedWav ignored, engine is stopping: ${path}`)
      return
    }
    this.queue.push({ path, offsetMs, channel })
    this.emit('queue', this.queueLength)
    this.setState({ queuedChunks: this.queueLength })
    this.pump()
  }

  /** Waits for the queue to drain (bounded), then asks the worker to exit. */
  async stop(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    if (this.queueLength > 0 && !this.exited) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.emit('log', 'warn', `Queue did not drain within ${this.opts.drainTimeoutMs / 1000} s; ${this.queueLength} chunk(s) dropped`)
          this.queue = []
          resolve()
        }, this.opts.drainTimeoutMs)
        this.drainWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (!this.exited) {
      this.send({ cmd: 'shutdown' })
      await this.waitForExit(5000)
    }
    if (!this.exited) this.kill()
    this.setState({ status: 'off', queuedChunks: 0 })
  }

  /** Immediate termination. In-flight work is rejected. */
  kill(): void {
    const child = this.child
    if (!child) return
    this.stopping = true
    try {
      child.stdin?.end()
    } catch {
      /* ignore */
    }
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    if (!this.exited) this.handleExit(null, 'SIGTERM')
  }

  // ---- internals ---------------------------------------------------------

  private spawnChild(
    scriptPath: string,
    handlers: {
      onMessage: (m: WorkerMessage) => void
      onStderr: (line: string) => void
      onExit: (code: number | null, signal: string | null) => void
      onSpawnError: (err: Error) => void
    },
    cwd?: string
  ): ChildLike {
    const exe = this.opts.powershellPath ?? resolvePowershellPath()
    const child = this.spawnFn(exe, powershellArgs(scriptPath), { cwd, windowsHide: true })
    this.child = child
    this.exited = false
    const stderrLines = new LineBuffer()
    this.emit('log', 'info', `spawned ${exe} (pid ${child.pid ?? '?'}) with ${scriptPath}`)

    child.stdout?.on('data', (chunk) => {
      for (const line of this.lines.push(chunk)) {
        const msg = parseWorkerLine(line)
        if (msg) handlers.onMessage(msg)
        else handlers.onStderr(`(stdout) ${line}`)
      }
    })
    child.stderr?.on('data', (chunk) => {
      for (const line of stderrLines.push(chunk)) handlers.onStderr(line)
    })
    child.stdin?.on?.('error', (err) => this.emit('log', 'warn', `worker stdin error: ${err.message}`))
    child.on('error', (err) => handlers.onSpawnError(err))
    child.on('exit', (code, signal) => {
      const rest = this.lines.drain()
      if (rest) {
        const msg = parseWorkerLine(rest)
        if (msg) handlers.onMessage(msg)
      }
      handlers.onExit(code, signal)
    })
    return child
  }

  private send(obj: Record<string, unknown>): void {
    const child = this.child
    if (!child || this.exited || !child.stdin) return
    try {
      child.stdin.write(JSON.stringify(obj) + '\n')
    } catch (e) {
      this.emit('log', 'error', `write to worker failed: ${errorToString(e)}`)
    }
  }

  private setState(patch: Partial<TranscriptionState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.getState())
  }

  private handleMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'ready': {
        this.emit('log', 'info', `recognizer ready: ${String(msg.recognizer ?? '')} [${String(msg.culture ?? '')}] vocabulary=${String(msg.vocabularyLoaded)}`)
        const w = this.readyWaiter
        if (w) {
          clearTimeout(w.timer)
          this.readyWaiter = null
          w.resolve()
        }
        break
      }
      case 'segment': {
        const text = typeof msg.text === 'string' ? msg.text.trim() : ''
        if (!text) break
        const confidence = typeof msg.confidence === 'number' ? msg.confidence : 0
        const startMs = typeof msg.startMs === 'number' ? Math.round(msg.startMs) : this.inFlight?.item.offsetMs ?? 0
        const endMs = typeof msg.endMs === 'number' ? Math.round(msg.endMs) : startMs
        const channel = (msg.channel === 'mic' || msg.channel === 'system' || msg.channel === 'mix') ? msg.channel : this.inFlight?.item.channel ?? 'mix'
        const segment: SapiSegment = {
          text,
          confidence,
          startMs,
          endMs: Math.max(endMs, startMs),
          channel,
          lowConfidence: msg.lowConfidence === true || confidence < 0.3,
          grammar: typeof msg.grammar === 'string' ? msg.grammar : undefined
        }
        this.state = { ...this.state, recognizedSegments: this.state.recognizedSegments + 1 }
        this.emit('segment', segment)
        break
      }
      case 'done': {
        const f = this.inFlight
        const results = typeof msg.results === 'number' ? msg.results : 0
        const failed = msg.failed === true
        if (f) {
          clearTimeout(f.timer)
          this.inFlight = null
          f.resolve()
        }
        this.emit('done', { path: typeof msg.path === 'string' ? msg.path : f?.item.path ?? '', results, failed })
        this.afterItem()
        break
      }
      case 'error': {
        const where = String(msg.where ?? '?')
        const message = String(msg.message ?? 'unknown error')
        const err = new Error(`[sapi:${where}] ${message}`)
        this.emit('log', 'error', err.message)
        if (where === 'init' && this.readyWaiter) {
          const w = this.readyWaiter
          clearTimeout(w.timer)
          this.readyWaiter = null
          w.reject(err)
        } else {
          this.state = { ...this.state, lastError: err.message }
          this.emitError(err)
        }
        break
      }
      case 'log':
        this.emit('log', (msg.level === 'warn' || msg.level === 'error' ? msg.level : 'info'), `[worker] ${String(msg.message ?? '')}`)
        break
      case 'bye':
      case 'pong':
      case 'probe':
        break
      default:
        this.emit('log', 'warn', `unknown worker message type "${msg.type}"`)
    }
  }

  private pump(): void {
    if (this.inFlight || !this.child || this.exited) return
    const item = this.queue.shift()
    if (!item) {
      this.setState({ status: 'idle', queuedChunks: 0 })
      const waiters = this.drainWaiters
      this.drainWaiters = []
      for (const w of waiters) w()
      return
    }
    const timer = setTimeout(() => {
      const err = new Error(`Recognizer did not finish ${item.path} within ${this.opts.chunkTimeoutMs / 1000} s; restarting is required`)
      this.abort(err, true)
    }, this.opts.chunkTimeoutMs)
    this.inFlight = {
      item,
      resolve: () => undefined,
      reject: () => undefined,
      timer
    }
    this.setState({ status: 'processing', queuedChunks: this.queueLength })
    this.send({ cmd: 'recognize', path: item.path, offsetMs: item.offsetMs, channel: item.channel })
  }

  private afterItem(): void {
    this.emit('queue', this.queueLength)
    this.pump()
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.exitInfo = { code, signal }
    this.child = null
    const expected = this.stopping
    const msg = `recognizer worker exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`
    this.emit('log', expected ? 'info' : 'error', msg)

    const err = new Error(expected ? msg : `${msg} unexpectedly`)
    if (this.readyWaiter) {
      const w = this.readyWaiter
      clearTimeout(w.timer)
      this.readyWaiter = null
      w.reject(err)
    }
    if (this.inFlight) {
      clearTimeout(this.inFlight.timer)
      const f = this.inFlight
      this.inFlight = null
      f.reject(err)
      this.emit('done', { path: f.item.path, results: 0, failed: true })
    }
    const dropped = this.queue.length
    this.queue = []
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const w of waiters) w()
    const exitWaiters = this.exitWaiters
    this.exitWaiters = []
    for (const w of exitWaiters) w()

    if (expected) {
      this.setState({ status: 'off', queuedChunks: 0 })
    } else {
      this.state = { ...this.state, lastError: `${err.message}${dropped ? `; ${dropped} queued chunk(s) dropped` : ''}` }
      this.setState({ status: 'error', queuedChunks: 0 })
      this.emitError(err)
    }
  }

  /** Kill the worker and leave the engine in the error state. */
  private abort(err: Error, emit: boolean): void {
    this.emit('log', 'error', err.message)
    this.kill()
    this.setState({ status: 'error', queuedChunks: 0, lastError: err.message })
    if (emit) this.emitError(err)
  }

  /** EventEmitter throws on an unhandled 'error'; a worker hiccup must never crash the main process. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err)
    else this.emit('log', 'error', `(unhandled) ${err.message}`)
  }

  private failAll(err: Error): void {
    this.emit('log', 'error', err.message)
    this.state = { ...this.state, lastError: err.message }
    this.stopping = false
    this.handleExit(null, null)
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.exitWaiters.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Exit details of the last worker process, for diagnostics. */
  get lastExit(): { code: number | null; signal: string | null } | null {
    return this.exitInfo
  }
}
