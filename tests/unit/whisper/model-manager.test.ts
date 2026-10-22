import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { ModelManager, ModelDownloadError } from '../../../src/main/services/whisper/model-manager'
import type { ModelCatalogEntry } from '../../../src/shared/transcription-types'

// ------------------------------------------------------------------ fixtures

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function entry(id: string, data: Buffer, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id,
    family: 'tiny',
    name: id,
    fileName: `ggml-${id}.bin`,
    url: `https://example.test/models/ggml-${id}.bin`,
    sha256: sha256(data),
    sizeBytes: data.length,
    quantization: 'q5_1',
    english_only: true,
    languages: 'english',
    runtimeMemoryBytes: 100,
    memoryMeasured: false,
    speedClass: 'fastest',
    accuracyClass: 'basic',
    liveCapable: true,
    license: 'MIT',
    ...overrides
  }
}

interface FakeServerOptions {
  /** Bytes served per chunk. */
  chunkSize?: number
  /** For the Nth request (0-based), error the body stream after this many bytes. */
  failAfter?: Record<number, number>
  /** Ignore Range headers and always answer 200 from zero. */
  ignoreRange?: boolean
  /** Delay between chunks (ms) so cancel() can land mid-transfer. */
  chunkDelayMs?: number
}

interface FakeServer {
  fetch: typeof fetch
  requests: { url: string; range: string | null }[]
}

/** Serves `files` (url → bytes) with HTTP Range support over a web ReadableStream body. */
function fakeServer(files: Record<string, Buffer>, opts: FakeServerOptions = {}): FakeServer {
  const requests: FakeServer['requests'] = []
  const chunkSize = opts.chunkSize ?? 1024
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers = new Headers(init?.headers)
    const range = headers.get('range')
    const reqIndex = requests.length
    requests.push({ url, range })
    const data = files[url]
    if (!data) return new Response('not found', { status: 404, statusText: 'Not Found' })
    const signal = init?.signal ?? null
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

    let start = 0
    let status = 200
    const resHeaders: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (range && !opts.ignoreRange) {
      const m = /^bytes=(\d+)-$/.exec(range)
      if (!m) return new Response('bad range', { status: 416 })
      start = Number(m[1])
      if (start >= data.length) return new Response('', { status: 416, statusText: 'Range Not Satisfiable' })
      status = 206
      resHeaders['content-range'] = `bytes ${start}-${data.length - 1}/${data.length}`
    }
    resHeaders['content-length'] = String(data.length - start)
    const failAfter = opts.failAfter?.[reqIndex]
    let pos = start
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('aborted', 'AbortError'))
          return
        }
        if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs))
        if (failAfter !== undefined && sent >= failAfter) {
          controller.error(new Error('socket hang up'))
          return
        }
        if (pos >= data.length) {
          controller.close()
          return
        }
        let end = Math.min(pos + chunkSize, data.length)
        if (failAfter !== undefined) end = Math.min(end, start + failAfter)
        controller.enqueue(new Uint8Array(data.subarray(pos, end)))
        sent += end - pos
        pos = end
      }
    })
    return new Response(body, { status, headers: resHeaders })
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

// --------------------------------------------------------------------- tests

describe('ModelManager', () => {
  let dir: string
  let modelsDir: string
  const small = randomBytes(10_000)
  const other = randomBytes(6_000)
  const SMALL = entry('tiny.en-q5_1', small)
  const OTHER = entry('base.en-q5_1', other, { family: 'base' })
  const catalog = [SMALL, OTHER]
  const files = { [SMALL.url]: small, [OTHER.url]: other }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'minutes-models-'))
    modelsDir = join(dir, 'models', 'whisper')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function manager(server: FakeServer, extra: Partial<ConstructorParameters<typeof ModelManager>[0]> = {}): ModelManager {
    return new ModelManager({ modelsDir, log: silentLog, fetchImpl: server.fetch, catalog, progressIntervalMs: 0, ...extra })
  }

  it('downloads, verifies and atomically installs a fresh model', async () => {
    const server = fakeServer(files)
    const mm = manager(server)
    const changes: string[] = []
    mm.on('changed', (states) => changes.push(states.find((s) => s.id === SMALL.id)!.state))
    const progress: number[] = []
    mm.on('progress', (id, d) => {
      expect(id).toBe(SMALL.id)
      expect(d.totalBytes).toBe(small.length)
      progress.push(d.receivedBytes)
    })

    expect(mm.list().find((s) => s.id === SMALL.id)!.state).toBe('not-installed')
    await mm.download(SMALL.id)

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].range).toBeNull()
    const installed = join(modelsDir, SMALL.fileName)
    expect(existsSync(installed)).toBe(true)
    expect(existsSync(installed + '.part')).toBe(false)
    expect(readFileSync(installed).equals(small)).toBe(true)
    expect(mm.getInstalledPath(SMALL.id)).toBe(installed)
    const st = mm.list().find((s) => s.id === SMALL.id)!
    expect(st.state).toBe('installed')
    expect(st.installedBytes).toBe(small.length)
    expect(st.installedPath).toBe(installed)
    expect(st.error).toBeNull()
    expect(st.eligibility).toEqual({ eligible: true, reasons: [], requiredBytes: SMALL.runtimeMemoryBytes, budgetBytes: 0 })
    expect(changes).toEqual(['downloading', 'verifying', 'installed'])
    expect(progress.at(-1)).toBe(small.length)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    await expect(mm.verify(SMALL.id)).resolves.toBe(true)
    // Second download of an installed model is a no-op.
    await mm.download(SMALL.id)
    expect(server.requests).toHaveLength(1)
  })

  it('resumes a half-finished download with a Range request and ends with the right sha256', async () => {
    const half = 5_000
    const server = fakeServer(files, { chunkSize: 500, failAfter: { 0: half } })
    const mm = manager(server)

    await expect(mm.download(SMALL.id)).rejects.toMatchObject({ code: 'NETWORK' })
    const part = join(modelsDir, SMALL.fileName + '.part')
    expect(existsSync(part)).toBe(true)
    expect(statSync(part).size).toBe(half)
    let st = mm.list().find((s) => s.id === SMALL.id)!
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/interrupted/i)

    const progress: number[] = []
    mm.on('progress', (_id, d) => progress.push(d.receivedBytes))
    await mm.download(SMALL.id)
    expect(server.requests).toHaveLength(2)
    expect(server.requests[1].range).toBe(`bytes=${half}-`)
    expect(progress[0]).toBeGreaterThan(half)
    expect(progress.at(-1)).toBe(small.length)
    st = mm.list().find((s) => s.id === SMALL.id)!
    expect(st.state).toBe('installed')
    expect(existsSync(part)).toBe(false)
    expect(sha256(readFileSync(join(modelsDir, SMALL.fileName)))).toBe(SMALL.sha256)
  })

  it('restarts from zero when the server answers a Range request with 200', async () => {
    const server = fakeServer(files, { chunkSize: 500, failAfter: { 0: 3_000 }, ignoreRange: true })
    const mm = manager(server)
    await expect(mm.download(SMALL.id)).rejects.toBeInstanceOf(ModelDownloadError)
    const partial = statSync(join(modelsDir, SMALL.fileName + '.part')).size
    expect(partial).toBeGreaterThan(0)
    await mm.download(SMALL.id)
    expect(server.requests[1].range).toBe(`bytes=${partial}-`)
    expect(readFileSync(join(modelsDir, SMALL.fileName)).equals(small)).toBe(true)
  })

  it('reports an error and removes the file on sha256 mismatch', async () => {
    const BAD = entry('base-q5_1', other, { sha256: 'a'.repeat(64), url: 'https://example.test/models/ggml-base-q5_1.bin' })
    const server = fakeServer({ [BAD.url]: other })
    const mm = new ModelManager({ modelsDir, log: silentLog, fetchImpl: server.fetch, catalog: [BAD], progressIntervalMs: 0 })
    await expect(mm.download(BAD.id)).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    const st = mm.list()[0]
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/sha256/)
    expect(existsSync(join(modelsDir, BAD.fileName))).toBe(false)
    expect(existsSync(join(modelsDir, BAD.fileName + '.part'))).toBe(false)
  })

  it('reports an error on a size mismatch (server sent fewer bytes than the catalog says)', async () => {
    const SHORT = entry('base-q8_0', other, { sizeBytes: other.length + 10, url: 'https://example.test/models/ggml-base-q8_0.bin' })
    const server = fakeServer({ [SHORT.url]: other })
    const mm = new ModelManager({ modelsDir, log: silentLog, fetchImpl: server.fetch, catalog: [SHORT], progressIntervalMs: 0 })
    await expect(mm.download(SHORT.id)).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    expect(mm.list()[0].state).toBe('error')
    expect(existsSync(join(modelsDir, SHORT.fileName + '.part'))).toBe(false)
  })

  it('surfaces HTTP failures', async () => {
    const server = fakeServer({})
    const mm = manager(server)
    await expect(mm.download(SMALL.id)).rejects.toMatchObject({ code: 'HTTP' })
    expect(mm.list().find((s) => s.id === SMALL.id)!.error).toMatch(/HTTP 404/)
  })

  it('dedupes concurrent downloads of the same id and caps concurrency at 2', async () => {
    const server = fakeServer(files, { chunkSize: 1000, chunkDelayMs: 2 })
    const mm = manager(server)
    const p1 = mm.download(SMALL.id)
    const p2 = mm.download(SMALL.id)
    expect(p1).toBe(p2)
    expect(mm.isDownloading(SMALL.id)).toBe(true)
    await p1
    expect(server.requests.filter((r) => r.url === SMALL.url)).toHaveLength(1)

    // Concurrency: a third download waits until a slot frees.
    const THIRD = entry('small.en-q5_1', randomBytes(3_000), { family: 'small' })
    const data3 = randomBytes(3_000)
    const T = { ...THIRD, sha256: sha256(data3), sizeBytes: data3.length }
    const srv2 = fakeServer({ ...files, [T.url]: data3 }, { chunkSize: 1000, chunkDelayMs: 5 })
    rmSync(modelsDir, { recursive: true, force: true })
    const mm2 = new ModelManager({ modelsDir, log: silentLog, fetchImpl: srv2.fetch, catalog: [SMALL, OTHER, T], progressIntervalMs: 0 })
    const all = Promise.all([mm2.download(SMALL.id), mm2.download(OTHER.id), mm2.download(T.id)])
    while (srv2.requests.length < 2) await new Promise((r) => setTimeout(r, 1))
    await new Promise((r) => setTimeout(r, 10))
    // The third download must wait for a free slot (each transfer takes ≥ 30 ms with the chunk delay).
    expect(srv2.requests).toHaveLength(2)
    await all
    expect(srv2.requests).toHaveLength(3)
    expect(mm2.list().every((s) => s.state === 'installed')).toBe(true)
  })

  it('cancel() aborts and keeps the .part for resume', async () => {
    const server = fakeServer(files, { chunkSize: 500, chunkDelayMs: 3 })
    const mm = manager(server)
    const p = mm.download(SMALL.id)
    const part = join(modelsDir, SMALL.fileName + '.part')
    await new Promise<void>((resolve) => mm.on('progress', (_id, d) => d.receivedBytes >= 1500 && resolve()))
    await mm.cancel(SMALL.id)
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' })
    const st = mm.list().find((s) => s.id === SMALL.id)!
    expect(st.state).toBe('not-installed')
    expect(st.error).toBeNull()
    expect(existsSync(part)).toBe(true)
    const partial = statSync(part).size
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(small.length)
    expect(mm.storageUsage().tempBytes).toBe(partial)

    await mm.download(SMALL.id)
    expect(server.requests[1].range).toBe(`bytes=${partial}-`)
    expect(readFileSync(join(modelsDir, SMALL.fileName)).equals(small)).toBe(true)
  })

  it('refuses remove() while the model is in use, otherwise deletes model and .part', async () => {
    const server = fakeServer(files)
    const mm = manager(server)
    await mm.download(SMALL.id)
    writeFileSync(join(modelsDir, OTHER.fileName + '.part'), other.subarray(0, 100))
    mm.inUse = (id) => id === SMALL.id
    await expect(mm.remove(SMALL.id)).rejects.toMatchObject({ code: 'IN_USE' })
    expect(existsSync(join(modelsDir, SMALL.fileName))).toBe(true)
    mm.inUse = () => false
    await mm.remove(SMALL.id)
    await mm.remove(OTHER.id)
    expect(existsSync(join(modelsDir, SMALL.fileName))).toBe(false)
    expect(existsSync(join(modelsDir, OTHER.fileName + '.part'))).toBe(false)
    expect(mm.list().find((s) => s.id === SMALL.id)!.state).toBe('not-installed')
    expect(mm.getInstalledPath(SMALL.id)).toBeNull()
  })

  it('verify() flags a tampered installed file as corrupt', async () => {
    const server = fakeServer(files)
    const mm = manager(server)
    await mm.download(SMALL.id)
    const p = join(modelsDir, SMALL.fileName)
    const tampered = Buffer.from(small)
    tampered[10] ^= 0xff
    writeFileSync(p, tampered)
    await expect(mm.verify(SMALL.id)).resolves.toBe(false)
    const st = mm.list().find((s) => s.id === SMALL.id)!
    expect(st.state).toBe('corrupt')
    expect(st.error).toMatch(/sha256/)
    // A corrupt model can be re-downloaded (overwrites via .part + rename).
    await mm.download(SMALL.id)
    expect(mm.list().find((s) => s.id === SMALL.id)!.state).toBe('installed')
    expect(readFileSync(p).equals(small)).toBe(true)
  })

  it('storageUsage() sums installed models and temp files', async () => {
    const server = fakeServer(files)
    const mm = manager(server)
    expect(mm.storageUsage()).toEqual({ modelsPath: modelsDir, modelsBytes: 0, tempBytes: 0, installedCount: 0 })
    await mm.download(SMALL.id)
    await mm.download(OTHER.id)
    writeFileSync(join(modelsDir, 'ggml-medium.bin.part'), Buffer.alloc(123))
    writeFileSync(join(modelsDir, 'unrelated.txt'), 'x')
    expect(mm.storageUsage()).toEqual({
      modelsPath: modelsDir,
      modelsBytes: small.length + other.length,
      tempBytes: 123,
      installedCount: 2
    })
  })

  it('cleanupTemp() removes only orphan .part files older than 7 days', async () => {
    const server = fakeServer(files)
    const mm = manager(server)
    await mm.download(SMALL.id)
    const old = join(modelsDir, 'ggml-medium.bin.part')
    const fresh = join(modelsDir, 'ggml-small.bin.part')
    writeFileSync(old, Buffer.alloc(10))
    writeFileSync(fresh, Buffer.alloc(10))
    const eightDaysAgo = (Date.now() - 8 * 24 * 3600 * 1000) / 1000
    utimesSync(old, eightDaysAgo, eightDaysAgo)
    const removed = await mm.cleanupTemp()
    expect(removed).toEqual(['ggml-medium.bin.part'])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(join(modelsDir, SMALL.fileName))).toBe(true)
  })

  it('importFromFile() installs a good file and rejects a bad hash or size', async () => {
    const mm = manager(fakeServer({}))
    const good = join(dir, 'offline-copy.bin')
    writeFileSync(good, small)
    await mm.importFromFile(good, SMALL.id)
    expect(mm.list().find((s) => s.id === SMALL.id)!.state).toBe('installed')
    expect(readFileSync(join(modelsDir, SMALL.fileName)).equals(small)).toBe(true)
    expect(existsSync(join(modelsDir, SMALL.fileName + '.import'))).toBe(false)

    const bad = join(dir, 'bad.bin')
    const corrupted = Buffer.from(other)
    corrupted[0] ^= 0xff
    writeFileSync(bad, corrupted)
    await expect(mm.importFromFile(bad, OTHER.id)).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    expect(mm.list().find((s) => s.id === OTHER.id)!.state).toBe('error')
    expect(existsSync(join(modelsDir, OTHER.fileName))).toBe(false)

    const short = join(dir, 'short.bin')
    writeFileSync(short, other.subarray(0, 10))
    await expect(mm.importFromFile(short, OTHER.id)).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    await expect(mm.importFromFile(join(dir, 'missing.bin'), OTHER.id)).rejects.toMatchObject({ code: 'BAD_SOURCE' })
    await expect(mm.importFromFile(good, 'not-a-model')).rejects.toMatchObject({ code: 'UNKNOWN_MODEL' })
  })
})
