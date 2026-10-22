// Download / verify / install manager for whisper.cpp ggml models.
//
// Models live in `<userData>/models/whisper/` (separate from the app binaries so updates keep
// them). This module only ever writes bytes to disk; it never executes anything. It has no
// Electron dependency so it can be unit-tested with a fake `fetch` and a temp directory.
//
// Download rules:
//   - one in-flight download per model id (a duplicate call returns the same promise)
//   - at most `maxConcurrent` (default 2) downloads run at once, the rest wait in FIFO order
//   - bytes stream into `<file>.part` with a bounded highWaterMark (never buffered whole)
//   - an existing `.part` is resumed with `Range: bytes=<n>-` (206); a 200 restarts from zero
//   - sha256 is computed incrementally; for a resume the existing `.part` is hashed first
//   - progress events are throttled to ~4/s and carry bytesPerSecond
//   - size + sha256 are verified, then the file is atomically renamed into place
//   - on mismatch the file is deleted and the state becomes 'error' with a clear message
//   - cancel(id) aborts via AbortController and leaves the `.part` for a later resume

import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, statSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, stat, copyFile, readdir, unlink, truncate } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import type { ModelCatalogEntry, ModelInstallState, ModelState, StorageUsage } from '@shared/transcription-types'
import { MODEL_CATALOG } from './model-catalog'

export interface ModelManagerLogger {
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export interface ModelManagerOptions {
  /** Directory the model files live in, e.g. `<userData>/models/whisper`. Created on demand. */
  modelsDir: string
  log: ModelManagerLogger
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Catalog override for tests; defaults to MODEL_CATALOG. */
  catalog?: ModelCatalogEntry[]
  /** Maximum concurrent downloads (default 2). */
  maxConcurrent?: number
  /** Minimum interval between progress events per download, ms (default 250 = 4/s). */
  progressIntervalMs?: number
  /** Clock override for tests. */
  now?: () => number
}

export type DownloadProgress = NonNullable<ModelState['download']>

export interface ModelManagerEvents {
  changed: [states: ModelState[]]
  progress: [id: string, download: DownloadProgress]
}

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly code: 'CANCELLED' | 'HTTP' | 'NETWORK' | 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'UNKNOWN_MODEL' | 'IN_USE' | 'BAD_SOURCE'
  ) {
    super(message)
    this.name = 'ModelDownloadError'
  }
}

interface Transient {
  state: Extract<ModelInstallState, 'downloading' | 'verifying' | 'error' | 'corrupt'>
  error: string | null
  download: DownloadProgress | null
}

interface InFlight {
  promise: Promise<void>
  controller: AbortController
}

const PART_SUFFIX = '.part'
const IMPORT_SUFFIX = '.import'
const STREAM_HIGH_WATER_MARK = 1024 * 1024 // 1 MiB
const ORPHAN_PART_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function resolveModelsDir(userData: string): string {
  return join(userData, 'models', 'whisper')
}

export class ModelManager extends EventEmitter<ModelManagerEvents> {
  readonly modelsDir: string
  /** Set by the engine: returns true while a model file is loaded/in use and must not be removed. */
  inUse: (id: string) => boolean = () => false

  private readonly log: ModelManagerLogger
  private readonly fetchImpl: typeof fetch
  private readonly catalog: ModelCatalogEntry[]
  private readonly byId: Map<string, ModelCatalogEntry>
  private readonly maxConcurrent: number
  private readonly progressIntervalMs: number
  private readonly now: () => number

  private readonly transient = new Map<string, Transient>()
  private readonly inFlight = new Map<string, InFlight>()
  private active = 0
  private readonly waiters: { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal }[] = []

  constructor(opts: ModelManagerOptions) {
    super()
    this.modelsDir = opts.modelsDir
    this.log = opts.log
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init))
    this.catalog = opts.catalog ?? MODEL_CATALOG
    this.byId = new Map(this.catalog.map((e) => [e.id, e]))
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2)
    this.progressIntervalMs = opts.progressIntervalMs ?? 250
    this.now = opts.now ?? (() => Date.now())
  }

  // ----------------------------------------------------------------- paths

  private entry(id: string): ModelCatalogEntry {
    const e = this.byId.get(id)
    if (!e) throw new ModelDownloadError(`Unknown model "${id}"`, 'UNKNOWN_MODEL')
    return e
  }

  private finalPath(id: string): string {
    return join(this.modelsDir, this.entry(id).fileName)
  }

  private partPath(id: string): string {
    return this.finalPath(id) + PART_SUFFIX
  }

  /** Absolute path of the installed model file, or null when it is not installed. */
  getInstalledPath(id: string): string | null {
    if (!this.byId.has(id)) return null
    const p = this.finalPath(id)
    return existsSync(p) ? p : null
  }

  // ------------------------------------------------------------------ state

  list(): ModelState[] {
    return this.catalog.map((e) => this.stateOf(e))
  }

  getState(id: string): ModelState {
    return this.stateOf(this.entry(id))
  }

  private stateOf(e: ModelCatalogEntry): ModelState {
    const t = this.transient.get(e.id)
    const finalPath = join(this.modelsDir, e.fileName)
    let installedBytes: number | null = null
    let installedAt: number | null = null
    let installedPath: string | null = null
    try {
      const st = statSync(finalPath)
      installedBytes = st.size
      installedAt = Math.round(st.mtimeMs)
      installedPath = finalPath
    } catch {
      /* not installed */
    }
    let state: ModelInstallState
    if (t) state = t.state
    else state = installedPath ? 'installed' : 'not-installed'
    return {
      ...e,
      state,
      installedBytes,
      installedPath,
      installedAt,
      download: t?.download ?? null,
      error: t?.error ?? null,
      // Neutral placeholder; the resource manager overlays the real verdict.
      eligibility: { eligible: true, reasons: [], requiredBytes: e.runtimeMemoryBytes, budgetBytes: 0 }
    }
  }

  private setTransient(id: string, t: Transient | null, emitChanged = true): void {
    if (t) this.transient.set(id, t)
    else this.transient.delete(id)
    if (emitChanged) this.emitChanged()
  }

  private emitChanged(): void {
    try {
      this.emit('changed', this.list())
    } catch (err) {
      this.log.warn('model-manager: changed listener threw', err)
    }
  }

  // ----------------------------------------------------------------- verify

  /** Re-hashes the installed file against the catalog. Marks the model 'corrupt' on mismatch. */
  async verify(id: string): Promise<boolean> {
    const e = this.entry(id)
    const p = this.finalPath(id)
    if (!existsSync(p)) return false
    const prev = this.transient.get(id)
    this.setTransient(id, { state: 'verifying', error: null, download: null })
    try {
      const st = await stat(p)
      const digest = await hashFile(p)
      const ok = st.size === e.sizeBytes && digest === e.sha256
      if (ok) {
        this.setTransient(id, null)
      } else {
        const msg =
          st.size !== e.sizeBytes
            ? `Installed file is ${st.size} bytes, expected ${e.sizeBytes}`
            : 'Installed file failed sha256 verification'
        this.log.warn(`model-manager: ${id} corrupt`, { msg })
        this.setTransient(id, { state: 'corrupt', error: msg, download: null })
      }
      return ok
    } catch (err) {
      this.setTransient(id, prev ?? null)
      throw err
    }
  }

  // --------------------------------------------------------------- download

  /**
   * Downloads (or resumes) a model. A second call for the same id while one is in flight
   * returns the same promise. Resolves once the file is verified and installed.
   */
  download(id: string): Promise<void> {
    const existing = this.inFlight.get(id)
    if (existing) return existing.promise
    const e = this.entry(id)
    if (this.getInstalledPath(id) && this.transient.get(id)?.state !== 'corrupt') return Promise.resolve()

    const controller = new AbortController()
    const promise = this.runDownload(e, controller).finally(() => {
      this.inFlight.delete(id)
    })
    // Avoid unhandled-rejection noise when the caller does not await (the state carries the error).
    promise.catch(() => {})
    this.inFlight.set(id, { promise, controller })
    return promise
  }

  /** Aborts an in-flight download. The `.part` file is kept for a later resume. */
  async cancel(id: string): Promise<void> {
    const f = this.inFlight.get(id)
    if (!f) return
    f.controller.abort()
    try {
      await f.promise
    } catch {
      /* expected */
    }
  }

  isDownloading(id: string): boolean {
    return this.inFlight.has(id)
  }

  private async acquireSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new ModelDownloadError('Download cancelled', 'CANCELLED')
    if (this.active < this.maxConcurrent) {
      this.active++
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal }
      this.waiters.push(waiter)
      signal.addEventListener(
        'abort',
        () => {
          const i = this.waiters.indexOf(waiter)
          if (i >= 0) {
            this.waiters.splice(i, 1)
            reject(new ModelDownloadError('Download cancelled', 'CANCELLED'))
          }
        },
        { once: true }
      )
    })
    this.active++
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.waiters.shift()
    if (next) next.resolve()
  }

  private async runDownload(e: ModelCatalogEntry, controller: AbortController): Promise<void> {
    const id = e.id
    const signal = controller.signal
    const partPath = this.partPath(id)
    const finalPath = this.finalPath(id)
    const startedAt = this.now()

    this.setTransient(id, {
      state: 'downloading',
      error: null,
      download: { receivedBytes: 0, totalBytes: e.sizeBytes, bytesPerSecond: 0, startedAt }
    })

    let slot = false
    try {
      await this.acquireSlot(signal)
      slot = true
      await mkdir(this.modelsDir, { recursive: true })

      // --- resume bookkeeping ------------------------------------------------------------
      let existing = 0
      try {
        existing = (await stat(partPath)).size
      } catch {
        existing = 0
      }
      if (existing > e.sizeBytes) {
        this.log.warn(`model-manager: ${id} .part larger than expected, restarting`, { existing })
        await rm(partPath, { force: true })
        existing = 0
      }
      let hash = createHash('sha256')
      if (existing > 0) {
        hash = await hashFile(partPath, signal, hash)
      }

      let received = existing
      const sessionStart = existing
      const sessionStartedAt = this.now()
      let lastProgressAt = 0
      const progress = (force = false): void => {
        const now = this.now()
        if (!force && now - lastProgressAt < this.progressIntervalMs) return
        lastProgressAt = now
        const elapsed = Math.max(1, now - sessionStartedAt)
        const download: DownloadProgress = {
          receivedBytes: received,
          totalBytes: e.sizeBytes,
          bytesPerSecond: Math.round(((received - sessionStart) * 1000) / elapsed),
          startedAt
        }
        const t = this.transient.get(id)
        if (t && t.state === 'downloading') t.download = download
        this.emit('progress', id, download)
      }

      // --- transfer ----------------------------------------------------------------------
      if (existing < e.sizeBytes) {
        const headers: Record<string, string> = { Accept: 'application/octet-stream' }
        if (existing > 0) headers.Range = `bytes=${existing}-`
        let res: Response
        try {
          res = await this.fetchImpl(e.url, { headers, signal, redirect: 'follow' })
        } catch (err) {
          if (signal.aborted) throw new ModelDownloadError('Download cancelled', 'CANCELLED')
          throw new ModelDownloadError(`Network error while downloading ${e.fileName}: ${errorMessage(err)}`, 'NETWORK')
        }

        let appendFrom = existing
        if (res.status === 206 && existing > 0) {
          const cr = res.headers.get('content-range')
          const m = cr ? /bytes\s+(\d+)-/.exec(cr) : null
          if (m && Number(m[1]) !== existing) {
            await res.body?.cancel().catch(() => {})
            throw new ModelDownloadError(`Server resumed at byte ${m[1]} instead of ${existing}`, 'HTTP')
          }
        } else if (res.status === 200) {
          if (existing > 0) {
            // Server ignored the Range header: start over.
            this.log.info(`model-manager: ${id} server returned 200 for a range request, restarting`)
            await truncate(partPath, 0).catch(() => rm(partPath, { force: true }))
            hash = createHash('sha256')
            appendFrom = 0
            received = 0
          }
        } else {
          await res.body?.cancel().catch(() => {})
          throw new ModelDownloadError(`Download failed: HTTP ${res.status} ${res.statusText}`.trim(), 'HTTP')
        }
        if (!res.body) throw new ModelDownloadError('Download failed: empty response body', 'HTTP')

        // The sink is written by hand (not via pipeline) so that a network error or cancel never
        // destroys the write stream with buffered bytes still unflushed: whatever reached the
        // hasher is flushed to the .part before we report failure, which keeps resumes exact.
        const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>, {
          highWaterMark: STREAM_HIGH_WATER_MARK,
          signal
        })
        const sink = createWriteStream(partPath, {
          flags: appendFrom > 0 ? 'a' : 'w',
          highWaterMark: STREAM_HIGH_WATER_MARK
        })
        let sinkError: Error | null = null
        const sinkFailed = new Promise<never>((_, reject) => {
          sink.once('error', (err) => {
            sinkError = err
            reject(err)
          })
        })
        sinkFailed.catch(() => {})
        const closed = once(sink, 'close').catch(() => {})
        let transferError: unknown = null
        try {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            if (sinkError) throw sinkError
            hash.update(chunk)
            received += chunk.length
            progress()
            if (!sink.write(chunk)) await Promise.race([once(sink, 'drain'), sinkFailed])
          }
        } catch (err) {
          transferError = err
        } finally {
          sink.end()
          await closed
        }
        if (transferError) {
          if (signal.aborted) throw new ModelDownloadError('Download cancelled', 'CANCELLED')
          throw new ModelDownloadError(`Connection interrupted while downloading ${e.fileName}: ${errorMessage(transferError)}`, 'NETWORK')
        }
        if (sinkError) throw new ModelDownloadError(`Could not write ${e.fileName}: ${errorMessage(sinkError)}`, 'NETWORK')
        progress(true)
      }

      // --- verify + install --------------------------------------------------------------
      this.setTransient(id, { state: 'verifying', error: null, download: null })
      const actualSize = (await stat(partPath)).size
      if (actualSize !== e.sizeBytes) {
        await rm(partPath, { force: true })
        throw new ModelDownloadError(
          `Downloaded file is ${actualSize} bytes but ${e.sizeBytes} were expected. The file was removed; please try again.`,
          'SIZE_MISMATCH'
        )
      }
      const digest = hash.digest('hex')
      if (digest !== e.sha256) {
        await rm(partPath, { force: true })
        throw new ModelDownloadError(
          `Downloaded ${e.fileName} failed sha256 verification (got ${digest.slice(0, 12)}…, expected ${e.sha256.slice(0, 12)}…). The file was removed; please try again.`,
          'HASH_MISMATCH'
        )
      }
      await rename(partPath, finalPath)
      this.log.info(`model-manager: installed ${id}`, { bytes: e.sizeBytes })
      this.setTransient(id, null)
    } catch (err) {
      const de = err instanceof ModelDownloadError ? err : new ModelDownloadError(errorMessage(err), 'NETWORK')
      if (de.code === 'CANCELLED') {
        this.log.info(`model-manager: ${id} download cancelled (partial kept for resume)`)
        this.setTransient(id, null)
      } else {
        this.log.error(`model-manager: ${id} download failed`, { code: de.code, message: de.message })
        this.setTransient(id, { state: 'error', error: de.message, download: null })
      }
      throw de
    } finally {
      if (slot) this.releaseSlot()
    }
  }

  // ----------------------------------------------------------------- remove

  /** Deletes the installed model and any partial download. Refused while the engine uses it. */
  async remove(id: string): Promise<void> {
    this.entry(id)
    if (this.inUse(id)) throw new ModelDownloadError(`Model "${id}" is in use and cannot be removed`, 'IN_USE')
    await this.cancel(id)
    await rm(this.finalPath(id), { force: true })
    await rm(this.partPath(id), { force: true })
    this.setTransient(id, null)
    this.log.info(`model-manager: removed ${id}`)
  }

  // ----------------------------------------------------------------- import

  /** Copies a user-supplied model file into place after sha256 verification (offline deployment). */
  async importFromFile(sourcePath: string, id: string): Promise<void> {
    const e = this.entry(id)
    let st
    try {
      st = await stat(sourcePath)
    } catch {
      throw new ModelDownloadError(`File not found: ${sourcePath}`, 'BAD_SOURCE')
    }
    if (st.size !== e.sizeBytes) {
      throw new ModelDownloadError(`${basename(sourcePath)} is ${st.size} bytes; ${e.fileName} should be ${e.sizeBytes} bytes`, 'SIZE_MISMATCH')
    }
    this.setTransient(id, { state: 'verifying', error: null, download: null })
    try {
      const digest = await hashFile(sourcePath)
      if (digest !== e.sha256) {
        throw new ModelDownloadError(`${basename(sourcePath)} failed sha256 verification; it is not the published ${e.fileName}`, 'HASH_MISMATCH')
      }
      await mkdir(this.modelsDir, { recursive: true })
      const tmp = this.finalPath(id) + IMPORT_SUFFIX
      await copyFile(sourcePath, tmp)
      await rename(tmp, this.finalPath(id))
      await rm(this.partPath(id), { force: true })
      this.log.info(`model-manager: imported ${id} from file`)
      this.setTransient(id, null)
    } catch (err) {
      const de = err instanceof ModelDownloadError ? err : new ModelDownloadError(errorMessage(err), 'BAD_SOURCE')
      this.setTransient(id, { state: 'error', error: de.message, download: null })
      throw de
    }
  }

  // ---------------------------------------------------------------- storage

  storageUsage(): StorageUsage {
    let modelsBytes = 0
    let tempBytes = 0
    let installedCount = 0
    const known = new Set(this.catalog.map((e) => e.fileName))
    let names: string[] = []
    try {
      names = readdirSync(this.modelsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      let size = 0
      try {
        size = statSync(join(this.modelsDir, name)).size
      } catch {
        continue
      }
      if (name.endsWith(PART_SUFFIX) || name.endsWith(IMPORT_SUFFIX)) tempBytes += size
      else if (known.has(name)) {
        modelsBytes += size
        installedCount++
      }
    }
    return { modelsPath: this.modelsDir, modelsBytes, tempBytes, installedCount }
  }

  /** Removes orphan `.part`/`.import` files older than 7 days that are not being downloaded. */
  async cleanupTemp(maxAgeMs = ORPHAN_PART_MAX_AGE_MS): Promise<string[]> {
    const removed: string[] = []
    let names: string[]
    try {
      names = await readdir(this.modelsDir)
    } catch {
      return removed
    }
    const activeParts = new Set([...this.inFlight.keys()].map((id) => basename(this.partPath(id))))
    const cutoff = this.now() - maxAgeMs
    for (const name of names) {
      if (!(name.endsWith(PART_SUFFIX) || name.endsWith(IMPORT_SUFFIX))) continue
      if (activeParts.has(name)) continue
      const p = join(this.modelsDir, name)
      try {
        const st = await stat(p)
        if (st.mtimeMs < cutoff) {
          await unlink(p)
          removed.push(name)
        }
      } catch {
        /* ignore */
      }
    }
    if (removed.length) this.log.info('model-manager: removed stale partial downloads', removed)
    return removed
  }
}

// ------------------------------------------------------------------ helpers

/** Streams a file through sha256. When `hash` is given it is updated and returned (no digest). */
async function hashFile(path: string, signal?: AbortSignal): Promise<string>
async function hashFile(path: string, signal: AbortSignal | undefined, hash: ReturnType<typeof createHash>): Promise<ReturnType<typeof createHash>>
async function hashFile(path: string, signal?: AbortSignal, hash?: ReturnType<typeof createHash>): Promise<string | ReturnType<typeof createHash>> {
  const h = hash ?? createHash('sha256')
  const rs = createReadStream(path, { highWaterMark: STREAM_HIGH_WATER_MARK })
  const sink = new Writable({
    highWaterMark: STREAM_HIGH_WATER_MARK,
    write(chunk: Buffer, _enc, cb) {
      h.update(chunk)
      cb()
    }
  })
  await pipeline(rs, sink, signal ? { signal } : {})
  return hash ? h : h.digest('hex')
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
