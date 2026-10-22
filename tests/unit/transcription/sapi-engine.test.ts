import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  LineBuffer,
  SapiEngine,
  parseWorkerLine,
  type ChildLike,
  type SapiSegment,
  type SpawnFn
} from '../../../src/main/services/transcription/sapi-engine'
import type { TranscriptionState } from '../../../src/shared/types'

/** A scriptable stand-in for the PowerShell worker process. */
class FakeChild extends EventEmitter implements ChildLike {
  pid = 4242
  writes: string[] = []
  commands: Record<string, unknown>[] = []
  ended = false
  killed = false
  stdoutEmitter = new EventEmitter()
  stderrEmitter = new EventEmitter()
  stdout = { on: (ev: 'data', cb: (c: Buffer | string) => void) => this.stdoutEmitter.on(ev, cb) }
  stderr = { on: (ev: 'data', cb: (c: Buffer | string) => void) => this.stderrEmitter.on(ev, cb) }
  stdin = {
    write: (data: string) => {
      this.writes.push(data)
      for (const line of data.split('\n')) if (line.trim()) this.commands.push(JSON.parse(line))
      this.onCommand?.(this.commands[this.commands.length - 1])
      return true
    },
    end: () => {
      this.ended = true
    },
    on: () => undefined
  }
  onCommand: ((cmd: Record<string, unknown>) => void) | null = null

  kill(): boolean {
    this.killed = true
    // Real processes exit asynchronously.
    setTimeout(() => this.emit('exit', null, 'SIGTERM'), 0)
    return true
  }

  /** Emit raw stdout bytes (may contain partial lines). */
  out(text: string): void {
    this.stdoutEmitter.emit('data', Buffer.from(text, 'utf8'))
  }
  json(obj: unknown): void {
    this.out(JSON.stringify(obj) + '\n')
  }
  err(text: string): void {
    this.stderrEmitter.emit('data', Buffer.from(text, 'utf8'))
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal)
  }
}

function makeSpawn(): { spawn: SpawnFn; children: FakeChild[]; calls: { command: string; args: string[] }[] } {
  const children: FakeChild[] = []
  const calls: { command: string; args: string[] }[] = []
  const spawn: SpawnFn = (command, args) => {
    calls.push({ command, args })
    const c = new FakeChild()
    children.push(c)
    return c
  }
  return { spawn, children, calls }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

beforeEach(() => {
  SapiEngine.clearProbeCache()
})

describe('LineBuffer / parseWorkerLine', () => {
  it('reassembles lines split across chunks and strips CR', () => {
    const lb = new LineBuffer()
    expect(lb.push('{"type":"a"}\r\n{"ty')).toEqual(['{"type":"a"}'])
    expect(lb.push('pe":"b"}\n\n{"type":"c"}')).toEqual(['{"type":"b"}'])
    expect(lb.push('\n')).toEqual(['{"type":"c"}'])
    expect(lb.drain()).toBeNull()
    lb.push('partial')
    expect(lb.drain()).toBe('partial')
  })

  it('ignores non-JSON noise', () => {
    expect(parseWorkerLine('Add-Type : something went wrong')).toBeNull()
    expect(parseWorkerLine('{not json')).toBeNull()
    expect(parseWorkerLine('{"noType":1}')).toBeNull()
    expect(parseWorkerLine(' {"type":"segment","text":"hi"} ')).toEqual({ type: 'segment', text: 'hi' })
  })
})

describe('SapiEngine.probe', () => {
  it('reports unavailable on non-Windows without spawning', async () => {
    const { spawn, calls } = makeSpawn()
    const info = await SapiEngine.probe({ spawn, platform: 'linux', scriptPath: '/x/recognizer.ps1' })
    expect(info.id).toBe('windows-sapi')
    expect(info.available).toBe(false)
    expect(info.detail).toMatch(/only available on Windows/)
    expect(info.languages).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('spawns Windows PowerShell 5.1 with the script and parses the probe reply', async () => {
    const { spawn, children, calls } = makeSpawn()
    const p = SapiEngine.probe({ spawn, platform: 'win32', scriptPath: 'C:\\app\\resources\\sapi\\recognizer.ps1', powershellPath: 'powershell.exe' })
    await tick()
    expect(calls[0].command).toBe('powershell.exe')
    expect(calls[0].args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\app\\resources\\sapi\\recognizer.ps1'])
    const child = children[0]
    expect(child.commands[0]).toEqual({ cmd: 'probe' })
    child.err('some stderr noise\n')
    child.json({ type: 'log', level: 'info', message: 'worker started' })
    // Split the probe reply across two writes.
    const reply = JSON.stringify({
      type: 'probe',
      ok: true,
      dotnet: '4.0.30319.42000',
      recognizers: [
        { id: 'MS-1033-80-DESK', name: 'Microsoft Speech Recognizer 8.0 for Windows (English - US)', culture: 'en-US' },
        { id: 'MS-2057-80-DESK', name: 'Microsoft Speech Recognizer 8.0 for Windows (English - UK)', culture: 'en-GB' }
      ]
    })
    child.out(reply.slice(0, 40))
    child.out(reply.slice(40) + '\n')
    const info = await p
    expect(info.available).toBe(true)
    expect(info.languages).toEqual(['en-US', 'en-GB'])
    expect(info.detail).toMatch(/English - US/)
    expect(child.ended).toBe(true)
    // Cached
    const again = await SapiEngine.probe({ spawn, platform: 'win32', scriptPath: 'x' })
    expect(again).toBe(info)
    expect(children.length).toBe(1)
  })

  it('reports the worker error when probe says ok:false', async () => {
    const { spawn, children } = makeSpawn()
    const p = SapiEngine.probe({ spawn, platform: 'win32', scriptPath: 'x' })
    await tick()
    children[0].json({ type: 'probe', ok: false, error: 'No Windows speech recognizer is installed.' })
    const info = await p
    expect(info.available).toBe(false)
    expect(info.detail).toMatch(/No Windows speech recognizer/)
  })

  it('reports unavailable when the worker exits early', async () => {
    const { spawn, children } = makeSpawn()
    const p = SapiEngine.probe({ spawn, platform: 'win32', scriptPath: 'x' })
    await tick()
    children[0].err('Add-Type : Cannot find assembly System.Speech\n')
    children[0].exit(1)
    const info = await p
    expect(info.available).toBe(false)
    expect(info.detail).toMatch(/exited before answering \(code 1\)/)
    expect(info.detail).toMatch(/System.Speech/)
  })

  it('times out', async () => {
    vi.useFakeTimers()
    try {
      const { spawn } = makeSpawn()
      const p = SapiEngine.probe({ spawn, platform: 'win32', scriptPath: 'x', probeTimeoutMs: 1000 })
      await vi.advanceTimersByTimeAsync(1100)
      const info = await p
      expect(info.available).toBe(false)
      expect(info.detail).toMatch(/did not answer within 1 s/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SapiEngine streaming', () => {
  async function startEngine(opts: { vocabulary?: string[] } = {}) {
    const { spawn, children } = makeSpawn()
    const engine = new SapiEngine({ spawn, platform: 'win32', scriptPath: 'C:\\r.ps1', chunkTimeoutMs: 5000, drainTimeoutMs: 500 })
    const segments: SapiSegment[] = []
    const states: TranscriptionState[] = []
    const errors: Error[] = []
    const logs: string[] = []
    const queueLens: number[] = []
    engine.on('segment', (s) => segments.push(s))
    engine.on('state', (s) => states.push(s))
    engine.on('error', (e) => errors.push(e))
    engine.on('log', (_l, m) => logs.push(m))
    engine.on('queue', (n) => queueLens.push(n))
    const starting = engine.start({ culture: 'en-US', vocabulary: opts.vocabulary ?? ['Dexterity', ' Petroka ', ''], workDir: 'C:\\work' })
    await tick()
    const child = children[0]
    expect(child.commands[0]).toEqual({ cmd: 'init', culture: 'en-US', vocabulary: opts.vocabulary ?? ['Dexterity', 'Petroka'] })
    child.json({ type: 'ready', culture: 'en-US', recognizer: 'MS', vocabularyLoaded: true })
    await starting
    return { engine, child, segments, states, errors, logs, queueLens }
  }

  it('initialises, processes queued files serially and emits segments', async () => {
    const { engine, child, segments, states, queueLens } = await startEngine()
    expect(engine.getState().status).toBe('idle')

    engine.feedWav('C:\\work\\chunk-000001.wav', 0, 'mic')
    engine.feedWav('C:\\work\\chunk-000002.wav', 5000, 'system')
    expect(queueLens).toEqual([1, 2])
    expect(engine.getState().status).toBe('processing')
    // Only the first recognize is sent until "done".
    const recognizes = () => child.commands.filter((c) => c.cmd === 'recognize')
    expect(recognizes()).toEqual([{ cmd: 'recognize', path: 'C:\\work\\chunk-000001.wav', offsetMs: 0, channel: 'mic' }])

    // Segment lines arriving in pieces, with a non-JSON line in between.
    const seg1 = JSON.stringify({ type: 'segment', text: 'hello Dexterity', confidence: 0.91, startMs: 120, endMs: 1800, channel: 'mic', offsetMs: 0, lowConfidence: false, grammar: 'dictation' })
    child.out(seg1.slice(0, 10))
    child.out(seg1.slice(10) + '\nWARNING: unrelated console text\n')
    child.json({ type: 'segment', text: 'maybe', confidence: 0.12, startMs: 2000, endMs: 2400, channel: 'mic', offsetMs: 0, lowConfidence: true })
    child.json({ type: 'segment', text: '   ', confidence: 0.9, startMs: 1, endMs: 2, channel: 'mic', offsetMs: 0 }) // blank text dropped
    child.json({ type: 'done', path: 'C:\\work\\chunk-000001.wav', results: 2 })
    await tick()

    expect(segments).toEqual([
      { text: 'hello Dexterity', confidence: 0.91, startMs: 120, endMs: 1800, channel: 'mic', lowConfidence: false, grammar: 'dictation' },
      { text: 'maybe', confidence: 0.12, startMs: 2000, endMs: 2400, channel: 'mic', lowConfidence: true, grammar: undefined }
    ])
    expect(recognizes().length).toBe(2)
    expect(recognizes()[1]).toMatchObject({ path: 'C:\\work\\chunk-000002.wav', offsetMs: 5000, channel: 'system' })
    expect(engine.getState().recognizedSegments).toBe(2)

    child.json({ type: 'done', path: 'C:\\work\\chunk-000002.wav', results: 0 })
    await tick()
    expect(engine.getState().status).toBe('idle')
    expect(engine.queueLength).toBe(0)
    expect(states.some((s) => s.status === 'processing' && s.queuedChunks === 2)).toBe(true)

    // Graceful stop: shutdown command, then exit.
    const stopping = engine.stop()
    await tick()
    expect(child.commands.at(-1)).toEqual({ cmd: 'shutdown' })
    child.json({ type: 'bye' })
    child.exit(0)
    await stopping
    expect(engine.isRunning).toBe(false)
    expect(engine.getState().status).toBe('off')
  })

  it('stop() waits for the queue to drain before shutting down', async () => {
    const { engine, child } = await startEngine()
    engine.feedWav('C:\\work\\c1.wav', 0, 'mix')
    const stopping = engine.stop()
    await tick()
    expect(child.commands.some((c) => c.cmd === 'shutdown')).toBe(false)
    child.json({ type: 'done', path: 'C:\\work\\c1.wav', results: 0 })
    await tick()
    expect(child.commands.at(-1)).toEqual({ cmd: 'shutdown' })
    child.exit(0)
    await stopping
  })

  it('surfaces worker "error" lines without stopping the queue', async () => {
    const { engine, child, errors } = await startEngine()
    engine.feedWav('C:\\work\\c1.wav', 0, 'mix')
    child.json({ type: 'error', where: 'recognize', message: 'file not found' })
    child.json({ type: 'done', path: 'C:\\work\\c1.wav', results: 0, failed: true })
    await tick()
    expect(errors.length).toBe(1)
    expect(errors[0].message).toMatch(/\[sapi:recognize\] file not found/)
    expect(engine.getState().status).toBe('idle')
    expect(engine.getState().lastError).toMatch(/file not found/)
  })

  it('handles a crash mid-chunk: error state, queue dropped, feed refused', async () => {
    const { engine, child, errors, states } = await startEngine()
    engine.feedWav('C:\\work\\c1.wav', 0, 'mix')
    engine.feedWav('C:\\work\\c2.wav', 1000, 'mix')
    const done: { path: string; failed: boolean }[] = []
    engine.on('done', (d) => done.push(d))
    child.err('Unhandled exception\n')
    child.exit(1)
    await tick()
    expect(errors.length).toBe(1)
    expect(errors[0].message).toMatch(/exited \(code 1\) unexpectedly/)
    const last = states.at(-1)!
    expect(last.status).toBe('error')
    expect(last.queuedChunks).toBe(0)
    expect(last.lastError).toMatch(/1 queued chunk\(s\) dropped/)
    expect(done).toEqual([{ path: 'C:\\work\\c1.wav', results: 0, failed: true }])
    expect(engine.isRunning).toBe(false)
    engine.feedWav('C:\\work\\c3.wav', 2000, 'mix')
    expect(errors.length).toBe(2)
    expect(errors[1].message).toMatch(/not running/)
    await engine.stop() // no-op, must not hang
  })

  it('rejects start() when init fails or the worker dies before ready', async () => {
    const { spawn, children } = makeSpawn()
    const engine = new SapiEngine({ spawn, platform: 'win32', scriptPath: 'x' })
    engine.on('error', () => undefined)
    const p = engine.start({ culture: 'xx-XX', vocabulary: [], workDir: 'C:\\w' })
    await tick()
    children[0].json({ type: 'error', where: 'init', message: "No recognizer installed for culture 'xx-XX'" })
    await expect(p).rejects.toThrow(/xx-XX/)
    expect(engine.getState().status).toBe('error')

    SapiEngine.clearProbeCache()
    const engine2 = new SapiEngine({ spawn, platform: 'win32', scriptPath: 'x' })
    engine2.on('error', () => undefined)
    const p2 = engine2.start({ culture: null, vocabulary: [], workDir: 'C:\\w' })
    await tick()
    children[1].exit(1)
    await expect(p2).rejects.toThrow(/exited/)
  })

  it('kills a hung worker after chunkTimeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const { spawn, children } = makeSpawn()
      const engine = new SapiEngine({ spawn, platform: 'win32', scriptPath: 'x', chunkTimeoutMs: 2000 })
      const errors: Error[] = []
      engine.on('error', (e) => errors.push(e))
      const p = engine.start({ culture: null, vocabulary: [], workDir: 'C:\\w' })
      await vi.advanceTimersByTimeAsync(0)
      children[0].json({ type: 'ready' })
      await p
      engine.feedWav('C:\\w\\c1.wav', 0, 'mix')
      await vi.advanceTimersByTimeAsync(2500)
      expect(errors.some((e) => /did not finish C:\\w\\c1.wav within 2 s/.test(e.message))).toBe(true)
      expect(children[0].killed).toBe(true)
      expect(engine.isRunning).toBe(false)
      expect(engine.getState().status).toBe('error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to start on non-Windows', async () => {
    const { spawn } = makeSpawn()
    const engine = new SapiEngine({ spawn, platform: 'darwin', scriptPath: 'x' })
    await expect(engine.start({ culture: null, vocabulary: [], workDir: '/tmp' })).rejects.toThrow(/only available on Windows/)
  })
})
