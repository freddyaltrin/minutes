// Resource-aware planning for whisper.cpp jobs: memory budget, model eligibility, thread count,
// model selection per profile, the single-model job policy and the live-lag adaptation rules.
//
// Pure and deterministic given its inputs; no Electron, no I/O. Hardware comes from an injected
// provider so tests (and Settings previews) can plan against arbitrary machines.

import type {
  Eligibility,
  HardwareInfo,
  JobKind,
  ModelCatalogEntry,
  ModelState,
  ProfileDefinition,
  ProfileId,
  ResourcePlan,
  TranscriptionConfig
} from '@shared/transcription-types'
import { PIN_ONLY_FAMILIES, PROFILES } from './profiles'

const MB = 1024 ** 2
const GB = 1024 ** 3

/** Extra scratch memory whisper.cpp allocates per additional worker thread (estimate). */
export const PER_THREAD_SCRATCH_BYTES = 64 * MB
/** Chunk I/O buffers + resampled 16 kHz float audio + worker process baseline (estimate). */
export const JOB_OVERHEAD_BYTES = 150 * MB
/** Below this share of total memory, `os.freemem()` is treated as "free, not available" and ignored. */
const FREE_UNRELIABLE_FRACTION = 0.05
/** Conservative available-memory estimate when the OS does not report it. */
const CONSERVATIVE_AVAILABLE_FRACTION = 0.25

export interface ResourceManagerLog {
  info?: (msg: string, ...args: unknown[]) => void
  warn?: (msg: string, ...args: unknown[]) => void
  debug?: (msg: string, ...args: unknown[]) => void
}

export interface ResourceManagerOptions {
  catalog: ModelCatalogEntry[]
  hardware: () => HardwareInfo
  log?: ResourceManagerLog
  now?: () => number
}

export interface BudgetResult {
  budgetBytes: number
  /** The available-memory figure the budget was derived from. */
  availableBytes: number
  /** Explanations of any fallbacks applied (empty when the OS figure was used as-is). */
  reasons: string[]
}

export interface RunningJob {
  kind: JobKind
  bytes: number
  /** Paused jobs do not count against the concurrency limit (the caller pauses background work). */
  paused?: boolean
}

export interface AdaptStatus {
  backlogMs: number
  recentRtf: number | null
  chunkMs: number
}

export type AdaptAction = 'none' | 'warn-lagging' | 'defer-to-background'

export interface AdaptDecision {
  action: AdaptAction
  reason: string
}

export const ADAPT_THRESHOLDS = {
  /** Backlog beyond this multiple of the chunk length is "lagging". */
  laggingBacklogChunks: 2,
  laggingRtf: 1.0,
  deferBacklogMs: 60_000,
  deferRtf: 1.5
} as const

export function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= GB) return `${(bytes / GB).toFixed(abs >= 10 * GB ? 0 : 1)} GB`
  if (abs >= MB) return `${Math.round(bytes / MB)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

export class ResourceManager {
  private readonly catalog: Map<string, ModelCatalogEntry>
  private readonly hardware: () => HardwareInfo
  private readonly log: ResourceManagerLog
  private readonly now: () => number

  constructor(opts: ResourceManagerOptions) {
    this.catalog = new Map(opts.catalog.map((e) => [e.id, e]))
    this.hardware = opts.hardware
    this.log = opts.log ?? {}
    this.now = opts.now ?? (() => Date.now())
  }

  // -------------------------------------------------------------------------
  // Memory budget
  // -------------------------------------------------------------------------

  /** Detailed budget: available − safety margin − memory already held by running jobs, floored at 0. */
  budgetDetail(hw: HardwareInfo, profile: ProfileDefinition, activeJobsBytes = 0): BudgetResult {
    const reasons: string[] = []
    let available: number
    if (hw.availableMemoryBytes !== null && Number.isFinite(hw.availableMemoryBytes)) {
      available = hw.availableMemoryBytes
    } else if (hw.freeMemoryBytes < hw.totalMemoryBytes * FREE_UNRELIABLE_FRACTION) {
      // "free" on Linux/macOS excludes reclaimable cache, so a tiny figure says nothing useful.
      available = Math.floor(hw.totalMemoryBytes * CONSERVATIVE_AVAILABLE_FRACTION)
      reasons.push(
        `OS did not report available memory and free memory (${formatBytes(hw.freeMemoryBytes)}) looks ` +
          `unreliable; assuming 25% of ${formatBytes(hw.totalMemoryBytes)} (${formatBytes(available)}) is available`
      )
    } else {
      available = hw.freeMemoryBytes
      reasons.push('OS did not report available memory; using free memory')
    }
    const budget = Math.max(0, Math.floor(available - profile.safetyMarginBytes - Math.max(0, activeJobsBytes)))
    if (activeJobsBytes > 0) reasons.push(`${formatBytes(activeJobsBytes)} already held by running jobs`)
    return { budgetBytes: budget, availableBytes: available, reasons }
  }

  budget(hw: HardwareInfo, profile: ProfileDefinition, activeJobsBytes = 0): number {
    return this.budgetDetail(hw, profile, activeJobsBytes).budgetBytes
  }

  // -------------------------------------------------------------------------
  // Eligibility
  // -------------------------------------------------------------------------

  /** Memory a job with this model at `threads` threads is expected to need. */
  requiredBytes(entry: ModelCatalogEntry, threads: number): number {
    return entry.runtimeMemoryBytes + PER_THREAD_SCRATCH_BYTES * Math.max(0, threads - 1) + JOB_OVERHEAD_BYTES
  }

  eligibility(entry: ModelCatalogEntry, budgetBytes: number, hw: HardwareInfo, threads: number): Eligibility {
    const required = this.requiredBytes(entry, threads)
    const reasons: string[] = []
    const eligible = required <= budgetBytes
    if (!eligible) {
      reasons.push(`needs ~${formatBytes(required)}, budget is ${formatBytes(Math.max(0, budgetBytes))}`)
    }
    if (hw.featuresReliable && !hw.features.includes('avx2')) {
      reasons.push('CPU without AVX2 — expect slow processing')
    }
    if (!hw.featuresReliable) {
      reasons.push('CPU features not detected — speed unknown until the engine reports its CPU variant')
    }
    if (PIN_ONLY_FAMILIES.has(entry.family)) {
      reasons.push(`${entry.family} models are not auto-selected; pin the model explicitly to use it`)
    }
    if (!entry.liveCapable) {
      reasons.push('not recommended for live transcription on CPU; suitable for background jobs')
    }
    if (!entry.memoryMeasured) {
      reasons.push('memory figure is an estimate')
    }
    return { eligible, reasons, requiredBytes: required, budgetBytes }
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  threadsFor(hw: HardwareInfo, profile: ProfileDefinition, config: TranscriptionConfig): number {
    const logical = Math.max(1, Math.floor(hw.logicalCores || 1))
    const physical = hw.physicalCores !== null && hw.physicalCores > 0 ? Math.floor(hw.physicalCores) : null
    // Leave at least one core for the OS / conferencing app on machines with ≥ 4 cores.
    const hardCap = Math.max(1, logical >= 4 ? logical - 1 : logical)

    if (config.profile === 'custom' && config.threads !== null && Number.isFinite(config.threads) && config.threads >= 1) {
      // Honour the explicit request, but never beyond what the machine has.
      return clamp(Math.floor(config.threads), 1, Math.min(profile.maxThreads, hardCap))
    }
    let threads = clamp(Math.floor(logical * profile.threadFraction), 1, profile.maxThreads)
    if (physical !== null) threads = Math.min(threads, physical)
    threads = Math.min(threads, hardCap)
    return Math.max(1, threads)
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  plan(config: TranscriptionConfig, installed: ModelState[], activeJobsBytes = 0): ResourcePlan {
    const hw = this.hardware()
    const profileId: ProfileId = PROFILES[config.profile] ? config.profile : 'balanced'
    const profile = PROFILES[profileId]
    const plannedAt = this.now()
    const threads = this.threadsFor(hw, profile, config)

    if (config.engine !== 'whisper') {
      return {
        engine: config.engine,
        profile: profileId,
        modelId: null,
        threads,
        budgetBytes: 0,
        requiredBytes: 0,
        rationale: [
          config.engine === 'none'
            ? 'Transcription is turned off; no model is needed.'
            : `Engine "${config.engine}" does not use whisper.cpp models.`
        ],
        considered: [],
        hardware: hw,
        plannedAt
      }
    }

    const { budgetBytes, availableBytes, reasons: budgetReasons } = this.budgetDetail(hw, profile, activeJobsBytes)
    const rationale: string[] = []
    rationale.push(
      `Profile "${profile.name}": ${formatBytes(availableBytes)} available − ${formatBytes(profile.safetyMarginBytes)} ` +
        `safety margin${activeJobsBytes > 0 ? ` − ${formatBytes(activeJobsBytes)} in use` : ''} = ${formatBytes(budgetBytes)} budget.`
    )
    for (const r of budgetReasons) rationale.push(r + '.')
    rationale.push(
      `${threads} thread${threads === 1 ? '' : 's'} (${hw.logicalCores} logical` +
        `${hw.physicalCores !== null ? `, ~${hw.physicalCores} physical` : ''} cores, cap ${profile.maxThreads}).`
    )

    // Candidate order: pinned model first, then the profile's preference list ('custom': pin only).
    const pinned = config.modelId?.trim() || null
    const order: string[] = []
    if (pinned) order.push(pinned)
    if (profileId !== 'custom') for (const id of profile.preferredModels) if (!order.includes(id)) order.push(id)

    const installedById = new Map(installed.filter((m) => m.state === 'installed').map((m) => [m.id, m]))
    const considered: ResourcePlan['considered'] = []
    let chosen: { id: string; eligibility: Eligibility } | null = null
    let pinnedFailed: string | null = null
    const skippedPinOnly: string[] = []
    const unknownIds: string[] = []
    const ineligibleInstalled: { id: string; eligibility: Eligibility }[] = []
    // When a pin exists and fallback is disabled, only the pinned model may be chosen; the rest of
    // the list is still evaluated so `considered` is complete for the Settings UI.
    const mayChooseNonPinned = !pinned || config.allowFallback

    for (const id of order) {
      const entry = this.catalog.get(id) ?? installedById.get(id) ?? null
      if (!entry) {
        unknownIds.push(id)
        considered.push({
          modelId: id,
          installed: false,
          eligibility: { eligible: false, reasons: ['unknown model id'], requiredBytes: 0, budgetBytes }
        })
        continue
      }
      const isInstalled = installedById.has(id)
      const elig = this.eligibility(entry, budgetBytes, hw, threads)
      if (!isInstalled) elig.reasons.unshift('not installed')
      considered.push({ modelId: id, installed: isInstalled, eligibility: elig })
      if (chosen) continue
      if (!isInstalled) {
        if (id === pinned) pinnedFailed = 'not installed'
        continue
      }
      const isPin = id === pinned
      if (!isPin && PIN_ONLY_FAMILIES.has(entry.family)) {
        skippedPinOnly.push(id)
        continue
      }
      if (!elig.eligible) {
        ineligibleInstalled.push({ id, eligibility: elig })
        if (isPin) pinnedFailed = elig.reasons[0] ?? 'not eligible'
        continue
      }
      if (isPin || mayChooseNonPinned) chosen = { id, eligibility: elig }
    }

    if (pinned && pinnedFailed) {
      if (chosen) {
        rationale.push(`Pinned model ${pinned} is ${pinnedFailed}; fell back to ${chosen.id} (fallback allowed).`)
      } else if (!config.allowFallback) {
        rationale.push(`Pinned model ${pinned} is ${pinnedFailed} and fallback is disabled; nothing selected.`)
      }
    }
    if (skippedPinOnly.length) {
      rationale.push(`Skipped ${skippedPinOnly.join(', ')}: medium/large models are only used when pinned explicitly.`)
    }
    if (unknownIds.length) rationale.push(`Unknown model id${unknownIds.length > 1 ? 's' : ''}: ${unknownIds.join(', ')}.`)

    if (chosen) {
      const entry = this.catalog.get(chosen.id) ?? installedById.get(chosen.id)!
      rationale.push(
        `Selected ${chosen.id} (${entry.name}): needs ~${formatBytes(chosen.eligibility.requiredBytes)} of ` +
          `${formatBytes(budgetBytes)}.`
      )
      if (profileId === 'balanced' && entry.family === 'base') {
        rationale.push('Base vs small as the balanced default is pending the docs/benchmarks.md procedure.')
      }
      for (const note of chosen.eligibility.reasons) {
        if (note.startsWith('CPU without AVX2')) rationale.push(note + '.')
      }
      this.log.debug?.('[resource-manager] plan', { profile: profileId, modelId: chosen.id, threads, budgetBytes })
      return {
        engine: 'whisper',
        profile: profileId,
        modelId: chosen.id,
        threads,
        budgetBytes,
        requiredBytes: chosen.eligibility.requiredBytes,
        rationale,
        considered,
        hardware: hw,
        plannedAt
      }
    }

    // Nothing eligible: explain the closest option.
    const installedCandidates = order.filter((id) => installedById.has(id))
    if (installedCandidates.length === 0) {
      const suggestion = this.cheapestSuggestion(
        order.filter((id) => !PIN_ONLY_FAMILIES.has(this.catalog.get(id)?.family ?? '')),
        threads
      )
      rationale.push(
        order.length === 0
          ? 'No model is pinned for the custom profile; choose a model in Settings.'
          : `None of the models for this profile is installed${suggestion ? `; install ${suggestion}` : ''}.`
      )
    } else if (ineligibleInstalled.length) {
      const closest = ineligibleInstalled.reduce((a, b) =>
        a.eligibility.requiredBytes <= b.eligibility.requiredBytes ? a : b
      )
      const shortfall = closest.eligibility.requiredBytes - budgetBytes
      // Cheapest not-installed, auto-selectable candidate that needs less than the closest one.
      const smaller = this.cheapestSuggestion(
        order.filter((id) => !installedById.has(id) && !PIN_ONLY_FAMILIES.has(this.catalog.get(id)?.family ?? '')),
        threads,
        closest.eligibility.requiredBytes - 1
      )
      const smallerEntry = smaller ? this.catalog.get(smaller) : undefined
      const smallerFits = smallerEntry ? this.requiredBytes(smallerEntry, threads) <= budgetBytes : false
      rationale.push(
        `Closest option ${closest.id} needs ~${formatBytes(closest.eligibility.requiredBytes)} but the budget is ` +
          `${formatBytes(budgetBytes)}: free ~${formatBytes(shortfall)} of memory` +
          `${smaller && smallerEntry ? ` or install ${smaller}${smallerFits ? '' : ` (~${formatBytes(this.requiredBytes(smallerEntry, threads))}, still needs more memory than the budget)`}` : ''}.`
      )
    } else if (skippedPinOnly.length) {
      rationale.push('Only medium/large models are installed; pin one explicitly or install a small/base/tiny model.')
    }
    this.log.info?.('[resource-manager] no eligible model', { profile: profileId, budgetBytes })
    return {
      engine: 'whisper',
      profile: profileId,
      modelId: null,
      threads,
      budgetBytes,
      requiredBytes: 0,
      rationale,
      considered,
      hardware: hw,
      plannedAt
    }
  }

  /** Smallest-memory catalog id among `ids` at `threads` threads (optionally needing at most `maxBytes`). */
  private cheapestSuggestion(ids: string[], threads: number, maxBytes?: number): string | null {
    let best: { id: string; mem: number } | null = null
    for (const id of ids) {
      const e = this.catalog.get(id)
      if (!e) continue
      const mem = this.requiredBytes(e, threads)
      if (maxBytes !== undefined && mem > maxBytes) continue
      // Prefer the earlier (preferred) candidate unless a later one is meaningfully (> 2%) smaller.
      if (!best || mem < best.mem * 0.98) best = { id, mem }
    }
    return best?.id ?? null
  }

  // -------------------------------------------------------------------------
  // Job policy
  // -------------------------------------------------------------------------

  /**
   * Single-model policy. At most `profile.maxConcurrentJobs` jobs run at once (paused jobs do not
   * count). Live jobs take precedence: a background job never starts while a live job runs; a
   * live job may start while a background job is running only if the caller pauses it first
   * (reported via `reason`).
   */
  canStartJob(kind: JobKind, running: RunningJob[], profile: ProfileDefinition): { ok: boolean; reason?: string } {
    const active = running.filter((j) => !j.paused)
    const liveRunning = active.some((j) => j.kind === 'live')
    if (kind === 'live') {
      if (liveRunning) return { ok: false, reason: 'a live transcription is already running' }
      if (active.length >= profile.maxConcurrentJobs) {
        return { ok: false, reason: 'pause the running background job first — live transcription takes precedence' }
      }
      return { ok: true }
    }
    // background
    if (liveRunning) return { ok: false, reason: 'a live transcription is running; background jobs wait until it ends' }
    if (active.length >= profile.maxConcurrentJobs) {
      return { ok: false, reason: `only ${profile.maxConcurrentJobs} transcription job${profile.maxConcurrentJobs === 1 ? '' : 's'} may run at a time` }
    }
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Live adaptation
  // -------------------------------------------------------------------------

  /**
   * Live-lag rules. Never switches models mid-recording: the only escalation is deferring the
   * recording to a post-meeting background job.
   */
  adapt(status: AdaptStatus, profile: ProfileDefinition): AdaptDecision {
    const chunkMs = status.chunkMs > 0 ? status.chunkMs : profile.liveChunkMs
    const rtf = status.recentRtf
    const backlog = Math.max(0, status.backlogMs)
    if (backlog > ADAPT_THRESHOLDS.deferBacklogMs) {
      return {
        action: 'defer-to-background',
        reason: `backlog ${Math.round(backlog / 1000)} s exceeds ${ADAPT_THRESHOLDS.deferBacklogMs / 1000} s; live transcription cannot catch up — the recording will be transcribed after the meeting`
      }
    }
    if (rtf !== null && rtf > ADAPT_THRESHOLDS.deferRtf) {
      return {
        action: 'defer-to-background',
        reason: `processing is ${rtf.toFixed(2)}× slower than real time (limit ${ADAPT_THRESHOLDS.deferRtf}); the recording will be transcribed after the meeting`
      }
    }
    if (backlog > ADAPT_THRESHOLDS.laggingBacklogChunks * chunkMs) {
      return {
        action: 'warn-lagging',
        reason: `backlog ${Math.round(backlog / 1000)} s is more than ${ADAPT_THRESHOLDS.laggingBacklogChunks} chunks (${chunkMs} ms each)`
      }
    }
    // A slow RTF alone is not a lag: speech pauses give the engine time to catch up, and silence or
    // noise windows decode slowly without any speech being late. Warn on RTF only once audio is
    // actually waiting (more than one chunk queued).
    if (rtf !== null && rtf > ADAPT_THRESHOLDS.laggingRtf && backlog > chunkMs) {
      return { action: 'warn-lagging', reason: `recent real-time factor ${rtf.toFixed(2)} is above 1.0 and ${Math.round(backlog / 1000)} s is waiting` }
    }
    return { action: 'none', reason: 'keeping up' }
  }
}
