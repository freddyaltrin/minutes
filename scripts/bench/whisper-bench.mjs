#!/usr/bin/env node
// Repeatable transcription benchmark for Minutes' whisper.cpp runtime.
//
// Node 22 ESM, no dependencies. Starts whisper-server exactly the way the app does
// (`-m <model> -t <threads> --host 127.0.0.1 --port <p> --no-gpu`), measures load time, then posts
// each audio file in two modes:
//   whole   – the entire file in one /inference request
//   live    – the file split into <= --chunk-ms (default 12000) chunks posted sequentially, the
//             previous chunk's text passed as `prompt` (like the live pipeline); reports per-chunk
//             latency p50/p95 and lag (cumulative processing time - cumulative audio time)
// and records processing time, real-time factor (RTF = processing seconds / audio seconds), peak
// RSS of the worker (Linux: /proc/<pid>/status VmHWM polled every 200 ms; Windows: PowerShell
// Get-Process PeakWorkingSet64, tasklist as a fallback), CPU utilisation (Linux: /proc/<pid>/stat
// utime+stime over wall time; Windows: TotalProcessorTime delta), transcript text, word-level WER
// against a reference when one is given, and a UI-responsiveness proxy (max delay of a 100 ms
// setInterval tick inside this Node process while inference runs out-of-process).
//
// Usage:
//   node scripts/bench/whisper-bench.mjs \
//     --models tiny.en-q5_1,base.en-q5_1 --threads 1,2,4 \
//     --audio a.wav,b.wav --reference a.txt,- \
//     --runtime resources/whisper/linux-x64 --models-dir ~/models \
//     --out docs/benchmarks/2026-10-20T12-00-00Z.json [--official-bench] [--chunk-ms 12000]
//
// Audio must be 16 kHz mono PCM16 WAV (what the app's chunker produces). Convert anything else
// first: ffmpeg -i in.ext -ar 16000 -ac 1 -c:a pcm_s16le out.wav
// A reference list entry of "-" means "no reference for this file" (completeness is reported
// instead of a WER).

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { cpus, totalmem, release, platform, arch } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// ------------------------------------------------------------------------------------ arguments

function parseArgs(argv) {
  const out = {
    models: [],
    threads: [2],
    audio: [],
    reference: [],
    runtime: '',
    modelsDir: '',
    out: '',
    chunkMs: 12000,
    officialBench: false,
    verify: true,
    loadTimeoutMs: 180000,
    requestTimeoutMs: 1800000,
    label: ''
  }
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`)
      return argv[++i]
    }
    switch (a) {
      case '--models': out.models = list(next()); break
      case '--threads': out.threads = list(next()).map(Number); break
      case '--audio': out.audio = list(next()); break
      case '--reference': out.reference = list(next()); break
      case '--runtime': out.runtime = next(); break
      case '--models-dir': out.modelsDir = next(); break
      case '--out': out.out = next(); break
      case '--chunk-ms': out.chunkMs = Number(next()); break
      case '--official-bench': out.officialBench = true; break
      case '--no-verify': out.verify = false; break
      case '--load-timeout-ms': out.loadTimeoutMs = Number(next()); break
      case '--request-timeout-ms': out.requestTimeoutMs = Number(next()); break
      case '--label': out.label = next(); break
      case '-h': case '--help': usage(0); break
      default: throw new Error(`Unknown argument ${a}`)
    }
  }
  if (!out.models.length || !out.audio.length || !out.runtime || !out.modelsDir) usage(1)
  if (out.reference.length && out.reference.length !== out.audio.length) {
    throw new Error('--reference must have one entry per --audio entry (use "-" for none)')
  }
  if (!out.out) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    out.out = join('docs', 'benchmarks', `${ts}.json`)
  }
  return out
}

function usage(code) {
  const text = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')
  ;(code ? process.stderr : process.stdout).write(text + '\n')
  process.exit(code)
}

// ----------------------------------------------------------------------------------------- WAV

/** Parses a RIFF/WAVE file; returns { sampleRate, channels, bits, pcm (Buffer of the data chunk) }. */
function readWav(path) {
  const buf = readFileSync(path)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a RIFF/WAVE file`)
  }
  let off = 12
  let fmt = null
  let pcm = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    let size = buf.readUInt32LE(off + 4)
    const start = off + 8
    if (start + size > buf.length) size = buf.length - start
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) }
    } else if (id === 'data') {
      pcm = buf.subarray(start, start + size)
    }
    off = start + size + (size % 2)
  }
  if (!fmt || !pcm) throw new Error(`${path}: missing fmt or data chunk`)
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16000 || fmt.bits !== 16) {
    throw new Error(`${path}: need 16 kHz mono PCM16 (got format=${fmt.format} ch=${fmt.channels} rate=${fmt.sampleRate} bits=${fmt.bits}); convert with ffmpeg -ar 16000 -ac 1 -c:a pcm_s16le`)
  }
  return { ...fmt, pcm }
}

function wavHeader(dataBytes, sampleRate = 16000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE((sampleRate * channels * bits) / 8, 28)
  h.writeUInt16LE((channels * bits) / 8, 32); h.writeUInt16LE(bits, 34)
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40)
  return h
}

const pcmSeconds = (pcm) => pcm.length / 2 / 16000

// ----------------------------------------------------------------------------------------- WER

/** lowercase, strip punctuation (keeps letters, digits, apostrophes inside words), numbers as-is. */
export function normaliseWords(text) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/(^|\s)'+|'+(\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** Word-level Levenshtein; returns { wer, substitutions, insertions, deletions, referenceWords, hypothesisWords }. */
export function wordErrorRate(reference, hypothesis) {
  const r = normaliseWords(reference)
  const h = normaliseWords(hypothesis)
  const n = r.length, m = h.length
  // dp[i][j] = { cost, s, i, d } using a flat array of costs plus backpointers.
  const cost = new Array((n + 1) * (m + 1)).fill(0)
  const idx = (i, j) => i * (m + 1) + j
  for (let i = 0; i <= n; i++) cost[idx(i, 0)] = i
  for (let j = 0; j <= m; j++) cost[idx(0, j)] = j
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = cost[idx(i - 1, j - 1)] + (r[i - 1] === h[j - 1] ? 0 : 1)
      const del = cost[idx(i - 1, j)] + 1
      const ins = cost[idx(i, j - 1)] + 1
      cost[idx(i, j)] = Math.min(sub, del, ins)
    }
  }
  // Backtrace for the breakdown.
  let i = n, j = m, S = 0, I = 0, D = 0
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[idx(i, j)] === cost[idx(i - 1, j - 1)] + (r[i - 1] === h[j - 1] ? 0 : 1)) {
      if (r[i - 1] !== h[j - 1]) S++
      i--; j--
    } else if (i > 0 && cost[idx(i, j)] === cost[idx(i - 1, j)] + 1) {
      D++; i--
    } else {
      I++; j--
    }
  }
  return { wer: n ? (S + I + D) / n : null, substitutions: S, insertions: I, deletions: D, referenceWords: n, hypothesisWords: m }
}

// ------------------------------------------------------------------------------------ sampling

const isWin = process.platform === 'win32'
let clkTck = 100
if (!isWin) {
  try { clkTck = Number(execFileSync('getconf', ['CLK_TCK']).toString().trim()) || 100 } catch { /* keep 100 */ }
}

/** One sample of the worker: { rss, peakRss, cpuMs } or null if the process is gone. */
function sampleProcess(pid) {
  try {
    if (!isWin) {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8')
      const rss = Number(/VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1] ?? 0) * 1024
      const peakRss = Number(/VmHWM:\s+(\d+)\s+kB/.exec(status)?.[1] ?? 0) * 1024
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // comm may contain spaces; fields start after the closing paren.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const utime = Number(rest[11]), stime = Number(rest[12])
      return { rss, peakRss, cpuMs: ((utime + stime) * 1000) / clkTck }
    }
    // Windows: one PowerShell call for peak working set, working set and CPU time.
    try {
      const ps = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.PeakWorkingSet64) $($p.WorkingSet64) $($p.TotalProcessorTime.TotalMilliseconds)"`],
        { windowsHide: true, timeout: 5000 }).toString().trim().split(/\s+/)
      return { rss: Number(ps[1]), peakRss: Number(ps[0]), cpuMs: Number(ps[2]) }
    } catch {
      // tasklist only knows the current working set ("Mem Usage" in K); peak is tracked by us.
      const csv = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }).toString()
      const m = /"([\d,.]+) K"/.exec(csv)
      if (!m) return null
      const rss = Number(m[1].replace(/[,.]/g, '')) * 1024
      return { rss, peakRss: rss, cpuMs: null }
    }
  } catch {
    return null
  }
}

class Sampler {
  constructor(pid, intervalMs) {
    this.pid = pid
    this.intervalMs = intervalMs
    this.samples = []
    this.timer = null
  }
  start() {
    const tick = () => {
      const s = sampleProcess(this.pid)
      if (s) this.samples.push({ t: performance.now(), ...s })
    }
    tick()
    this.timer = setInterval(tick, this.intervalMs)
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const s = sampleProcess(this.pid)
    if (s) this.samples.push({ t: performance.now(), ...s })
  }
  /** Summary over samples taken between t0 and t1 (performance.now() ms). */
  window(t0, t1) {
    const inWin = this.samples.filter((s) => s.t >= t0 - this.intervalMs && s.t <= t1 + this.intervalMs)
    const last = this.samples.at(-1)
    const first = inWin[0], end = inWin.at(-1)
    const maxRss = inWin.reduce((a, s) => Math.max(a, s.rss), 0)
    const peakRss = Math.max(maxRss, ...inWin.map((s) => s.peakRss || 0), last?.peakRss || 0)
    let cpuCores = null
    if (first && end && first.cpuMs !== null && end.cpuMs !== null && end.t > first.t) {
      cpuCores = (end.cpuMs - first.cpuMs) / (end.t - first.t)
    }
    return { peakRssBytes: peakRss, maxSampledRssBytes: maxRss, cpuCores, samples: inWin.length }
  }
}

/** UI-responsiveness proxy: 100 ms interval; records the worst tick delay (ms over the 100 ms target). */
class TickMonitor {
  start() {
    this.maxDelay = 0
    this.ticks = 0
    let last = performance.now()
    this.timer = setInterval(() => {
      const now = performance.now()
      this.maxDelay = Math.max(this.maxDelay, now - last - 100)
      last = now
      this.ticks++
    }, 100)
  }
  stop() {
    clearInterval(this.timer)
    return { maxTickDelayMs: Math.max(0, Math.round(this.maxDelay * 10) / 10), ticks: this.ticks }
  }
}

// ------------------------------------------------------------------------------------- server

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => res(port))
    })
    srv.on('error', rej)
  })
}

async function startServer(runtimeDir, modelPath, threads, loadTimeoutMs) {
  const bin = join(runtimeDir, isWin ? 'whisper-server.exe' : 'whisper-server')
  if (!existsSync(bin)) throw new Error(`whisper-server not found at ${bin}`)
  const port = await freePort()
  const args = ['-m', modelPath, '-t', String(threads), '--host', '127.0.0.1', '--port', String(port), '--no-gpu']
  const t0 = performance.now()
  const child = spawn(bin, args, { cwd: runtimeDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const log = []
  let cpuVariant = null
  const onChunk = (c) => {
    for (const line of c.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      log.push(line)
      const m = /loaded CPU backend from .*ggml-cpu-([a-z0-9]+)/i.exec(line)
      if (m) cpuVariant = m[1]
    }
  }
  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = t0 + loadTimeoutMs
  let ready = false
  while (performance.now() < deadline) {
    if (exited) throw new Error(`whisper-server exited during load:\n${log.slice(-8).join('\n')}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
      if (res.status === 200 || res.status === 404) { ready = true; break }
    } catch { /* not yet */ }
    await sleep(100)
  }
  if (!ready) { child.kill('SIGKILL'); throw new Error('Model load timed out') }
  const loadMs = performance.now() - t0
  return { child, port, loadMs, cpuVariant, log, args: [bin, ...args] }
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  await new Promise((res) => {
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } res() }, 4000)
    child.once('exit', () => { clearTimeout(t); res() })
    try { child.kill() } catch { clearTimeout(t); res() }
  })
}

/** Mirrors WhisperEngine.transcribePcm: multipart WAV, verbose_json, temperature 0 + fallback. */
async function infer(port, pcm, { prompt, timeoutMs }) {
  const wav = Buffer.concat([wavHeader(pcm.length), pcm])
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav')
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  form.append('temperature_inc', '0.2')
  form.append('no_timestamps', 'false')
  form.append('suppress_non_speech', 'true')
  if (prompt) form.append('prompt', prompt.slice(-400))
  const t0 = performance.now()
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`whisper-server returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const ms = performance.now() - t0
  const segments = (json.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: String(s.text ?? '').trim() })).filter((s) => s.text)
  const text = segments.map((s) => s.text).join(' ')
  return { ms, segments, text, t0, t1: t0 + ms }
}

// ----------------------------------------------------------------------------------- helpers

const percentile = (arr, p) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[k]
}
const r2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 100) / 100)
const r3 = (x) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000)
const mb = (b) => (b === null || b === undefined ? '—' : (b / (1024 * 1024)).toFixed(0))
const wordCount = (t) => normaliseWords(t).length

function completeness(result, audioSec) {
  const segs = result.segments
  const covered = segs.reduce((a, s) => a + Math.max(0, s.end - s.start), 0)
  const lastEnd = segs.length ? Math.max(...segs.map((s) => s.end)) : 0
  return {
    words: wordCount(result.text),
    segments: segs.length,
    wordsPerMinute: audioSec ? r2((wordCount(result.text) * 60) / audioSec) : null,
    segmentCoverage: audioSec ? r3(Math.min(1, covered / audioSec)) : null,
    lastSegmentEndCoverage: audioSec ? r3(Math.min(1, lastEnd / audioSec)) : null
  }
}

function environment(runtimeDir) {
  const env = {
    platform: platform(), arch: arch(), kernel: release(), node: process.version,
    logicalCores: cpus().length, cpuModel: cpus()[0]?.model ?? 'unknown', totalMemBytes: totalmem(),
    cpuFlags: null, runtimeVersion: null, hypervisor: null
  }
  try {
    const info = readFileSync('/proc/cpuinfo', 'utf8')
    env.cpuModel = /model name\s*:\s*(.+)/.exec(info)?.[1]?.trim() ?? env.cpuModel
    const flags = /flags\s*:\s*(.+)/.exec(info)?.[1]?.split(/\s+/) ?? []
    const interesting = ['sse4_2', 'avx', 'avx2', 'fma', 'f16c', 'avx512f', 'avx512bw', 'avx512_vnni', 'avx_vnni', 'avx512_bf16', 'amx_tile', 'amx_int8', 'hypervisor']
    env.cpuFlags = interesting.filter((f) => flags.includes(f))
    env.hypervisor = flags.includes('hypervisor')
  } catch { /* not Linux */ }
  try { env.runtimeVersion = readFileSync(join(runtimeDir, 'VERSION'), 'utf8').trim() } catch { /* none */ }
  return env
}

function sha256File(path) {
  const h = createHash('sha256')
  h.update(readFileSync(path))
  return h.digest('hex')
}

function verifyModel(modelPath, runtimeDir) {
  const treePath = join(dirname(runtimeDir), 'hf-tree-ggerganov-whisper.cpp.json')
  if (!existsSync(treePath)) return { verified: false, note: `no ${treePath}` }
  const tree = JSON.parse(readFileSync(treePath, 'utf8'))
  const entry = tree.files.find((f) => f.path === basename(modelPath))
  if (!entry) return { verified: false, note: 'not in HF tree capture' }
  const size = statSync(modelPath).size
  if (size !== entry.size) throw new Error(`${modelPath}: size ${size} != published ${entry.size}`)
  const digest = sha256File(modelPath)
  if (digest !== entry.sha256) throw new Error(`${modelPath}: sha256 ${digest} != published ${entry.sha256}`)
  return { verified: true, sha256: digest, sizeBytes: size }
}

function runOfficialBench(runtimeDir, modelPath, threads) {
  const bin = join(runtimeDir, isWin ? 'whisper-bench.exe' : 'whisper-bench')
  if (!existsSync(bin)) return { error: `${bin} missing` }
  // whisper-bench prints its timings to stderr; capture both streams.
  const proc = spawnSync(bin, ['-m', modelPath, '-t', String(threads), '--no-gpu'], { cwd: runtimeDir, windowsHide: true, timeout: 600000, encoding: 'utf8' })
  const all = (proc.stdout ?? '') + (proc.stderr ?? '')
  const num = (re) => { const m = re.exec(all); return m ? Number(m[1]) : null }
  const parsed = {
    exitStatus: proc.status,
    loadMs: num(/load time\s*=\s*([\d.]+) ms/),
    encodeMs: num(/encode time\s*=\s*([\d.]+) ms/),
    decodeMs: num(/decode time\s*=\s*([\d.]+) ms/),
    batchdMs: num(/batchd time\s*=\s*([\d.]+) ms/),
    promptMs: num(/prompt time\s*=\s*([\d.]+) ms/),
    systemInfo: /system_info:\s*(.+)/.exec(all)?.[1]?.trim() ?? null,
    raw: all.split('\n').filter((l) => /time =|system_info|load_backend/.test(l)).join('\n')
  }
  if (proc.status !== 0 || parsed.encodeMs === null) parsed.error = proc.error?.message ?? `exit ${proc.status}, no timings parsed`
  return parsed
}

// --------------------------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runtimeDir = resolve(args.runtime)
  const modelsDir = resolve(args.modelsDir)
  const env = environment(runtimeDir)
  const startedAt = new Date().toISOString()

  const audios = args.audio.map((p, i) => {
    const path = resolve(p)
    const wav = readWav(path)
    const refArg = args.reference[i]
    const reference = refArg && refArg !== '-' ? readFileSync(resolve(refArg), 'utf8').trim() : null
    return { name: basename(path), path, pcm: wav.pcm, seconds: pcmSeconds(wav.pcm), reference, referencePath: reference ? resolve(refArg) : null }
  })

  const results = { startedAt, label: args.label || null, environment: env, runtimeDir, modelsDir, chunkMs: args.chunkMs, audio: audios.map((a) => ({ name: a.name, path: a.path, seconds: r2(a.seconds), hasReference: !!a.reference, referencePath: a.referencePath })), runs: [], officialBench: [] }

  for (const modelId of args.models) {
    const modelPath = join(modelsDir, `ggml-${modelId}.bin`)
    if (!existsSync(modelPath)) {
      process.stderr.write(`skip ${modelId}: ${modelPath} not found\n`)
      results.runs.push({ modelId, skipped: `model file not found at ${modelPath}` })
      continue
    }
    const verification = args.verify ? verifyModel(modelPath, runtimeDir) : { verified: false, note: 'verification disabled' }
    process.stderr.write(`model ${modelId}: ${verification.verified ? 'sha256 verified' : verification.note}\n`)

    for (const threads of args.threads) {
      process.stderr.write(`\n== ${modelId} × ${threads} thread(s)\n`)
      const srv = await startServer(runtimeDir, modelPath, threads, args.loadTimeoutMs)
      process.stderr.write(`   loaded in ${srv.loadMs.toFixed(0)} ms, backend variant ${srv.cpuVariant ?? 'unknown'}\n`)
      const sampler = new Sampler(srv.child.pid, isWin ? 1000 : 200)
      sampler.start()
      const run = { modelId, modelFile: basename(modelPath), modelSizeBytes: statSync(modelPath).size, verification, threads, loadMs: r2(srv.loadMs), cpuVariant: srv.cpuVariant, pid: srv.child.pid, command: srv.args.join(' '), files: [] }
      try {
        for (const a of audios) {
          const entry = { audio: a.name, audioSeconds: r2(a.seconds), hasReference: !!a.reference }
          // ---- whole file
          {
            const ticks = new TickMonitor(); ticks.start()
            const res = await infer(srv.port, a.pcm, { timeoutMs: args.requestTimeoutMs })
            const ui = ticks.stop()
            const win = sampler.window(res.t0, res.t1)
            entry.whole = {
              processingMs: r2(res.ms), rtf: r3(res.ms / 1000 / a.seconds),
              peakRssBytes: win.peakRssBytes, maxSampledRssBytes: win.maxSampledRssBytes, cpuCores: r2(win.cpuCores), rssSamples: win.samples,
              ui, completeness: completeness(res, a.seconds),
              wer: a.reference ? wordErrorRate(a.reference, res.text) : null,
              text: res.text, segments: res.segments
            }
            process.stderr.write(`   ${a.name} whole: ${(res.ms / 1000).toFixed(2)} s, RTF ${entry.whole.rtf}, peak RSS ${mb(win.peakRssBytes)} MB${entry.whole.wer ? `, WER ${(entry.whole.wer.wer * 100).toFixed(1)}%` : ''}\n`)
          }
          // ---- live-like: sequential <= chunkMs chunks with prompt carry-over
          {
            const chunkBytes = Math.floor((args.chunkMs / 1000) * 16000) * 2
            const chunks = []
            for (let off = 0; off < a.pcm.length; off += chunkBytes) chunks.push(a.pcm.subarray(off, Math.min(a.pcm.length, off + chunkBytes)))
            const ticks = new TickMonitor(); ticks.start()
            const latencies = [], perChunk = []
            let prompt = '', text = '', cumProc = 0, cumAudio = 0, queueLag = 0, maxQueueLag = 0
            const t0 = performance.now()
            let segments = []
            let offsetSec = 0
            for (const c of chunks) {
              const res = await infer(srv.port, c, { prompt, timeoutMs: args.requestTimeoutMs })
              const cs = pcmSeconds(c)
              latencies.push(res.ms)
              cumProc += res.ms / 1000
              cumAudio += cs
              // A live recorder delivers chunks every `cs` seconds: backlog grows when a chunk takes longer than its own duration.
              queueLag = Math.max(0, queueLag + res.ms / 1000 - cs)
              maxQueueLag = Math.max(maxQueueLag, queueLag)
              perChunk.push({ seconds: r2(cs), ms: r2(res.ms), rtf: r3(res.ms / 1000 / cs), lagSec: r2(cumProc - cumAudio), words: wordCount(res.text) })
              segments = segments.concat(res.segments.map((s) => ({ start: s.start + offsetSec, end: s.end + offsetSec, text: s.text })))
              offsetSec += cs
              if (res.text) { text = text ? `${text} ${res.text}` : res.text; prompt = res.text }
            }
            const t1 = performance.now()
            const ui = ticks.stop()
            const win = sampler.window(t0, t1)
            const combined = { text, segments }
            entry.live = {
              chunkMs: args.chunkMs, chunks: chunks.length,
              processingMs: r2(cumProc * 1000), rtf: r3(cumProc / a.seconds),
              latencyP50Ms: r2(percentile(latencies, 50)), latencyP95Ms: r2(percentile(latencies, 95)), latencyMaxMs: r2(Math.max(...latencies)),
              lagSec: r2(cumProc - cumAudio), maxQueueLagSec: r2(maxQueueLag),
              peakRssBytes: win.peakRssBytes, maxSampledRssBytes: win.maxSampledRssBytes, cpuCores: r2(win.cpuCores),
              ui, completeness: completeness(combined, a.seconds),
              wer: a.reference ? wordErrorRate(a.reference, text) : null,
              text, perChunk
            }
            process.stderr.write(`   ${a.name} live : ${chunks.length} chunks, RTF ${entry.live.rtf}, p50 ${entry.live.latencyP50Ms} ms, p95 ${entry.live.latencyP95Ms} ms, lag ${entry.live.lagSec} s${entry.live.wer ? `, WER ${(entry.live.wer.wer * 100).toFixed(1)}%` : ''}\n`)
          }
          run.files.push(entry)
        }
      } finally {
        sampler.stop()
        run.peakRssBytesLifetime = sampler.samples.reduce((a, s) => Math.max(a, s.peakRss || 0, s.rss || 0), 0)
        run.idleRssBytesAfterLoad = sampler.samples[0]?.rss ?? null
        await stopServer(srv.child)
        run.serverLogTail = srv.log.slice(-15)
      }
      results.runs.push(run)

      if (args.officialBench) {
        process.stderr.write(`   whisper-bench -t ${threads} …\n`)
        const ob = runOfficialBench(runtimeDir, modelPath, threads)
        results.officialBench.push({ modelId, threads, ...ob })
        if (ob.encodeMs !== null && ob.encodeMs !== undefined) process.stderr.write(`   encode ${ob.encodeMs} ms, decode ${ob.decodeMs} ms\n`)
        else process.stderr.write(`   ${ob.error ?? 'no timings parsed'}\n`)
      }
    }
  }

  results.finishedAt = new Date().toISOString()
  mkdirSync(dirname(resolve(args.out)), { recursive: true })
  writeFileSync(resolve(args.out), JSON.stringify(results, null, 2))
  process.stderr.write(`\nwrote ${resolve(args.out)}\n\n`)
  process.stdout.write(markdown(results))
}

export function markdown(results) {
  const e = results.environment
  const lines = []
  lines.push(`### Environment`)
  lines.push(``)
  lines.push(`- CPU: ${e.cpuModel} (${e.logicalCores} logical cores${e.hypervisor ? ', virtualised' : ''}); flags: ${(e.cpuFlags ?? []).join(' ') || 'n/a'}`)
  lines.push(`- RAM: ${(e.totalMemBytes / 1024 ** 3).toFixed(1)} GiB; OS: ${e.platform} ${e.kernel}; Node ${e.node}`)
  lines.push(`- Runtime: ${e.runtimeVersion ?? 'unknown'}`)
  lines.push(`- Run: ${results.startedAt} → ${results.finishedAt}${results.label ? ` (${results.label})` : ''}; live chunk ${results.chunkMs} ms`)
  lines.push(``)
  lines.push(`### Whole-file`)
  lines.push(``)
  lines.push(`| Model | Threads | Backend | Load (ms) | Audio | Audio (s) | Proc (s) | RTF | Peak RSS (MB) | CPU (cores) | WER | Words / Segs / Coverage | Max tick delay (ms) |`)
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|`)
  for (const r of results.runs) {
    if (r.skipped) { lines.push(`| ${r.modelId} | — | — | — | skipped: ${r.skipped} | | | | | | | | |`); continue }
    for (const f of r.files) {
      const w = f.whole
      const werCell = w.wer ? `${(w.wer.wer * 100).toFixed(1)}% (S${w.wer.substitutions} I${w.wer.insertions} D${w.wer.deletions} / ${w.wer.referenceWords})` : 'no reference'
      lines.push(`| ${r.modelId} | ${r.threads} | ${r.cpuVariant ?? '?'} | ${r.loadMs.toFixed(0)} | ${f.audio} | ${f.audioSeconds} | ${(w.processingMs / 1000).toFixed(2)} | ${w.rtf} | ${mb(w.peakRssBytes)} | ${w.cpuCores ?? '—'} | ${werCell} | ${w.completeness.words} / ${w.completeness.segments} / ${w.completeness.lastSegmentEndCoverage} | ${w.ui.maxTickDelayMs} |`)
    }
  }
  lines.push(``)
  lines.push(`### Live-like (sequential ≤${results.chunkMs} ms chunks, prompt carry-over)`)
  lines.push(``)
  lines.push(`| Model | Threads | Audio | Chunks | RTF | Latency p50 (ms) | p95 (ms) | max (ms) | Lag (s) | Max queue lag (s) | Peak RSS (MB) | WER | Words / Segs | Max tick delay (ms) |`)
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`)
  for (const r of results.runs) {
    if (r.skipped) continue
    for (const f of r.files) {
      const l = f.live
      const werCell = l.wer ? `${(l.wer.wer * 100).toFixed(1)}%` : 'no reference'
      lines.push(`| ${r.modelId} | ${r.threads} | ${f.audio} | ${l.chunks} | ${l.rtf} | ${l.latencyP50Ms} | ${l.latencyP95Ms} | ${l.latencyMaxMs} | ${l.lagSec} | ${l.maxQueueLagSec} | ${mb(l.peakRssBytes)} | ${werCell} | ${l.completeness.words} / ${l.completeness.segments} | ${l.ui.maxTickDelayMs} |`)
    }
  }
  if (results.officialBench.length) {
    lines.push(``)
    lines.push(`### whisper-bench (official encoder benchmark)`)
    lines.push(``)
    lines.push(`| Model | Threads | Load (ms) | Encode (ms) | Decode (ms) | Batchd (ms) | Prompt (ms) |`)
    lines.push(`|---|---|---|---|---|---|---|`)
    for (const b of results.officialBench) {
      lines.push(`| ${b.modelId} | ${b.threads} | ${b.loadMs ?? '—'} | ${b.encodeMs ?? '—'} | ${b.decodeMs ?? '—'} | ${b.batchdMs ?? '—'} | ${b.promptMs ?? (b.error ? `error: ${b.error}` : '—')} |`)
    }
  }
  lines.push(``)
  lines.push(`### Peak RSS per model (lifetime VmHWM / PeakWorkingSet of the worker, all files, per thread count)`)
  lines.push(``)
  lines.push(`| Model | Threads | Idle after load (MB) | Peak (MB) | Peak (bytes) |`)
  lines.push(`|---|---|---|---|---|`)
  for (const r of results.runs) {
    if (r.skipped) continue
    lines.push(`| ${r.modelId} | ${r.threads} | ${mb(r.idleRssBytesAfterLoad)} | ${mb(r.peakRssBytesLifetime)} | ${r.peakRssBytesLifetime} |`)
  }
  lines.push(``)
  return lines.join('\n')
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`\nbenchmark failed: ${err.stack ?? err.message}\n`)
    process.exit(1)
  })
}
