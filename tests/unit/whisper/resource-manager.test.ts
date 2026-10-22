import { describe, it, expect } from 'vitest'
import type { HardwareInfo, ModelCatalogEntry, ModelState, TranscriptionConfig } from '../../../src/shared/transcription-types'
import { MODEL_CATALOG, getCatalogEntry } from '../../../src/main/services/whisper/model-catalog'
import { PROFILES, DEFAULT_CONFIG } from '../../../src/main/services/whisper/profiles'
import {
  ResourceManager,
  PER_THREAD_SCRATCH_BYTES,
  JOB_OVERHEAD_BYTES,
  formatBytes
} from '../../../src/main/services/whisper/resource-manager'

const MB = 1024 ** 2
const GB = 1024 ** 3

function hw(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Intel(R) Core(TM) test',
    logicalCores: 4,
    physicalCores: 2,
    totalMemoryBytes: 16 * GB,
    freeMemoryBytes: 6 * GB,
    availableMemoryBytes: 10 * GB,
    features: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma'],
    featuresReliable: true,
    checkedAt: 0,
    ...overrides
  }
}

/** 8 GB, 2-core, no-AVX2 laptop with 1.5 GB available. */
const MACHINE_8GB = hw({
  logicalCores: 2,
  physicalCores: 2,
  totalMemoryBytes: 8 * GB,
  freeMemoryBytes: 1 * GB,
  availableMemoryBytes: 1.5 * GB, // a loaded 8 GB machine: lightweight budget 768 MB, balanced 512 MB
  features: ['sse4_2', 'avx'],
  featuresReliable: true
})
/** 16 GB, 4-core laptop with 10 GB available. */
const MACHINE_16GB = hw()
/** 32 GB, 8-core desktop with 24 GB available. */
const MACHINE_32GB = hw({
  logicalCores: 8,
  physicalCores: 4,
  totalMemoryBytes: 32 * GB,
  freeMemoryBytes: 20 * GB,
  availableMemoryBytes: 24 * GB
})

function installed(ids: string[]): ModelState[] {
  return ids.map((id) => {
    const e = getCatalogEntry(id)
    if (!e) throw new Error(`test: ${id} not in catalog`)
    return {
      ...e,
      state: 'installed',
      installedBytes: e.sizeBytes,
      installedPath: `/models/${e.fileName}`,
      installedAt: 1,
      download: null,
      error: null,
      eligibility: { eligible: true, reasons: [], requiredBytes: 0, budgetBytes: 0 }
    }
  })
}

function manager(machine: HardwareInfo, catalog: ModelCatalogEntry[] = MODEL_CATALOG): ResourceManager {
  return new ResourceManager({ catalog, hardware: () => machine, now: () => 42 })
}

function cfg(overrides: Partial<TranscriptionConfig> = {}): TranscriptionConfig {
  return { ...DEFAULT_CONFIG, ...overrides }
}

const synthetic: ModelCatalogEntry = {
  id: 'synthetic-q5_1',
  family: 'small',
  name: 'Synthetic',
  fileName: 'ggml-synthetic.bin',
  url: 'https://example.invalid/synthetic',
  sha256: '0'.repeat(64),
  sizeBytes: 500 * MB,
  quantization: 'q5_1',
  english_only: true,
  languages: 'english',
  runtimeMemoryBytes: 1000 * MB,
  memoryMeasured: true,
  speedClass: 'moderate',
  accuracyClass: 'good',
  liveCapable: true,
  license: 'MIT'
}

describe('budget', () => {
  const rm = manager(MACHINE_16GB)

  it('is available − safety margin − active job bytes, floored at zero', () => {
    expect(rm.budget(MACHINE_16GB, PROFILES.balanced)).toBe(10 * GB - PROFILES.balanced.safetyMarginBytes)
    expect(rm.budget(MACHINE_16GB, PROFILES.balanced, 1 * GB)).toBe(10 * GB - PROFILES.balanced.safetyMarginBytes - 1 * GB)
    expect(rm.budget(hw({ availableMemoryBytes: 1 * GB }), PROFILES.balanced)).toBe(0)
  })

  it('uses free memory when available is unknown and free looks plausible', () => {
    const d = rm.budgetDetail(hw({ availableMemoryBytes: null, freeMemoryBytes: 6 * GB }), PROFILES.lightweight)
    expect(d.availableBytes).toBe(6 * GB)
    expect(d.budgetBytes).toBe(6 * GB - PROFILES.lightweight.safetyMarginBytes)
    expect(d.reasons.join(' ')).toMatch(/using free memory/)
  })

  it('falls back to 25% of total when available is unknown and free is < 5% of total', () => {
    const machine = hw({ availableMemoryBytes: null, totalMemoryBytes: 16 * GB, freeMemoryBytes: 0.5 * GB })
    const d = rm.budgetDetail(machine, PROFILES.balanced)
    expect(d.availableBytes).toBe(4 * GB)
    expect(d.budgetBytes).toBe(4 * GB - PROFILES.balanced.safetyMarginBytes)
    expect(d.reasons.join(' ')).toMatch(/unreliable/)
    expect(d.reasons.join(' ')).toMatch(/25%/)
  })
})

describe('eligibility', () => {
  const rm = manager(MACHINE_16GB)

  it('required = runtime + 64 MB per extra thread + 150 MB overhead', () => {
    const e1 = rm.eligibility(synthetic, 10 * GB, MACHINE_16GB, 1)
    expect(e1.requiredBytes).toBe(1000 * MB + JOB_OVERHEAD_BYTES)
    const e4 = rm.eligibility(synthetic, 10 * GB, MACHINE_16GB, 4)
    expect(e4.requiredBytes).toBe(1000 * MB + 3 * PER_THREAD_SCRATCH_BYTES + JOB_OVERHEAD_BYTES)
    expect(e4.requiredBytes).toBe(1342 * MB)
    expect(PER_THREAD_SCRATCH_BYTES).toBe(64 * MB)
    expect(JOB_OVERHEAD_BYTES).toBe(150 * MB)
  })

  it('is eligible iff required ≤ budget and explains the shortfall', () => {
    const exactly = 1000 * MB + JOB_OVERHEAD_BYTES
    expect(rm.eligibility(synthetic, exactly, MACHINE_16GB, 1).eligible).toBe(true)
    const short = rm.eligibility(synthetic, exactly - 1, MACHINE_16GB, 1)
    expect(short.eligible).toBe(false)
    expect(short.budgetBytes).toBe(exactly - 1)
    expect(short.reasons[0]).toMatch(/^needs ~1\.1 GB, budget is 1\.1 GB$/)
  })

  it('notes a CPU without AVX2, pin-only families and unmeasured memory', () => {
    const e = rm.eligibility(synthetic, 10 * GB, MACHINE_8GB, 1)
    expect(e.eligible).toBe(true)
    expect(e.reasons).toContain('CPU without AVX2 — expect slow processing')
    expect(e.reasons.some((r) => /estimate/.test(r))).toBe(false)

    const medium = getCatalogEntry('medium.en-q5_0')!
    const em = rm.eligibility(medium, 10 * GB, MACHINE_32GB, 4)
    expect(em.eligible).toBe(true)
    expect(em.reasons.some((r) => /medium models are not auto-selected/.test(r))).toBe(true)
    expect(em.reasons.some((r) => /estimate/.test(r))).toBe(true)
  })
})

describe('threadsFor', () => {
  const rm = manager(MACHINE_16GB)

  it('uses floor(logical × fraction) clamped to [1, maxThreads] and the physical core count', () => {
    // 4 logical, 2 physical, balanced 0.5 → 2
    expect(rm.threadsFor(MACHINE_16GB, PROFILES.balanced, cfg())).toBe(2)
    // 8 logical, 4 physical, high-accuracy 0.75 → 6 → capped by physical 4
    expect(rm.threadsFor(MACHINE_32GB, PROFILES['high-accuracy'], cfg())).toBe(4)
    // 16 logical, physical unknown, high-accuracy → 12 → maxThreads 6
    expect(rm.threadsFor(hw({ logicalCores: 16, physicalCores: null }), PROFILES['high-accuracy'], cfg())).toBe(6)
    // 2 logical, lightweight 0.5 → 1
    expect(rm.threadsFor(MACHINE_8GB, PROFILES.lightweight, cfg())).toBe(1)
    // 1 logical core → 1, never 0
    expect(rm.threadsFor(hw({ logicalCores: 1, physicalCores: 1 }), PROFILES.balanced, cfg())).toBe(1)
  })

  it('leaves at least one core free on machines with ≥ 4 logical cores', () => {
    // 4 logical, physical unknown, custom 0.75 → 3 (≤ logical − 1)
    expect(rm.threadsFor(hw({ logicalCores: 4, physicalCores: null }), PROFILES.custom, cfg({ profile: 'custom' }))).toBe(3)
    // 4 logical, custom with explicit 8 threads → capped at 3
    expect(
      rm.threadsFor(hw({ logicalCores: 4, physicalCores: null }), PROFILES.custom, cfg({ profile: 'custom', threads: 8 }))
    ).toBe(3)
  })

  it('honours an explicit thread count only for the custom profile', () => {
    expect(rm.threadsFor(MACHINE_32GB, PROFILES.custom, cfg({ profile: 'custom', threads: 5 }))).toBe(5)
    expect(rm.threadsFor(MACHINE_32GB, PROFILES.custom, cfg({ profile: 'custom', threads: 0 }))).toBe(4)
    expect(rm.threadsFor(MACHINE_32GB, PROFILES.balanced, cfg({ profile: 'balanced', threads: 1 }))).toBe(4)
  })
})

describe('plan', () => {
  const trio = ['tiny.en-q5_1', 'base.en-q5_1', 'small.en-q5_1']

  it('returns a model-less plan for non-whisper engines', () => {
    const p = manager(MACHINE_16GB).plan(cfg({ engine: 'windows-sapi' }), installed(trio))
    expect(p.engine).toBe('windows-sapi')
    expect(p.modelId).toBeNull()
    expect(p.considered).toEqual([])
    expect(p.rationale.join(' ')).toMatch(/does not use whisper/)
    const off = manager(MACHINE_16GB).plan(cfg({ engine: 'none' }), [])
    expect(off.modelId).toBeNull()
    expect(off.rationale.join(' ')).toMatch(/turned off/)
  })

  it('8 GB / 2-core machine: lightweight picks tiny, balanced picks base, never small', () => {
    const rm = manager(MACHINE_8GB)
    const light = rm.plan(cfg({ profile: 'lightweight' }), installed(trio))
    expect(light.modelId).toBe('tiny.en-q5_1')
    expect(light.threads).toBe(1)
    expect(light.budgetBytes).toBe(1.5 * GB - PROFILES.lightweight.safetyMarginBytes)

    const bal = rm.plan(cfg({ profile: 'balanced' }), installed(trio))
    expect(bal.budgetBytes).toBe(1.5 * GB - PROFILES.balanced.safetyMarginBytes)
    expect(bal.modelId).toBe('base.en-q5_1')
    const small = bal.considered.find((c) => c.modelId === 'small.en-q5_1')!
    expect(small.installed).toBe(true)
    expect(small.eligibility.eligible).toBe(false)
    expect(small.eligibility.reasons[0]).toMatch(/^needs ~/)
    expect(bal.rationale.join(' ')).toMatch(/without AVX2/)
  })

  it('8 GB machine with a tighter budget skips base and takes tiny, never small', () => {
    const tight = { ...MACHINE_8GB, availableMemoryBytes: 1.4 * GB }
    const p = manager(tight).plan(cfg({ profile: 'balanced' }), installed([...trio, 'tiny-q5_1']))
    // tiny.en-q5_1 carries a measured 30 s-window peak (140 MiB with headroom, docs/benchmarks.md),
    // below the estimated base.en-q5_1, so it is the one that fits this 410 MB budget.
    expect(p.modelId).toBe('tiny.en-q5_1')
    expect(p.considered.find((c) => c.modelId === 'base.en-q5_1')!.eligibility.eligible).toBe(false)
    expect(p.considered.find((c) => c.modelId === 'tiny.en-q5_1')!.eligibility.eligible).toBe(true)
    expect(p.considered.find((c) => c.modelId === 'small.en-q5_1')!.eligibility.eligible).toBe(false)
  })

  it('8 GB machine with nothing eligible explains what would be needed', () => {
    const starved = { ...MACHINE_8GB, availableMemoryBytes: 1.1 * GB }
    const p = manager(starved).plan(cfg({ profile: 'balanced' }), installed(['base.en-q5_1', 'small.en-q5_1']))
    expect(p.modelId).toBeNull()
    expect(p.requiredBytes).toBe(0)
    const text = p.rationale.join(' ')
    expect(text).toMatch(/Closest option base\.en-q5_1 needs ~/)
    expect(text).toMatch(/free ~\d+ MB of memory/)
    expect(text).toMatch(/or install tiny\.en-q5_1 \(~\d+ MB, still needs more memory than the budget\)/)

    const roomy = { ...MACHINE_8GB, availableMemoryBytes: 1.4 * GB }
    const p2 = manager(roomy).plan(cfg({ profile: 'balanced' }), installed(['base.en-q5_1', 'small.en-q5_1']))
    expect(p2.modelId).toBeNull()
    expect(p2.rationale.join(' ')).toMatch(/free ~\d+ MB of memory or install tiny\.en-q5_1\.$/)
  })

  it('16 GB balanced picks base.en-q5_1 first', () => {
    const p = manager(MACHINE_16GB).plan(cfg(), installed(trio))
    expect(p.modelId).toBe('base.en-q5_1')
    expect(p.threads).toBe(2)
    expect(p.considered[0]).toMatchObject({ modelId: 'base.en-q5_1', installed: true })
    expect(p.considered.map((c) => c.modelId)).toEqual(PROFILES.balanced.preferredModels)
    expect(p.rationale.join(' ')).toMatch(/benchmarks\.md/)
    expect(p.hardware).toBe(MACHINE_16GB)
    expect(p.plannedAt).toBe(42)
  })

  it('32 GB high-accuracy picks small, never medium, even when medium is installed', () => {
    const p = manager(MACHINE_32GB).plan(
      cfg({ profile: 'high-accuracy' }),
      installed(['medium.en-q5_0', 'small.en-q5_1', 'base.en-q5_1'])
    )
    expect(p.modelId).toBe('small.en-q5_1')
    const medium = p.considered.find((c) => c.modelId === 'medium.en-q5_0')!
    expect(medium.installed).toBe(true)
    expect(medium.eligibility.eligible).toBe(true) // fits, but is pin-only
    // With only medium installed it still is not chosen.
    const only = manager(MACHINE_32GB).plan(cfg({ profile: 'high-accuracy' }), installed(['medium.en-q5_0']))
    expect(only.modelId).toBeNull()
    expect(only.rationale.join(' ')).toMatch(/only used when pinned explicitly/)
  })

  it('pinned medium on 32 GB with budget is chosen', () => {
    const p = manager(MACHINE_32GB).plan(
      cfg({ profile: 'high-accuracy', modelId: 'medium.en-q5_0' }),
      installed(['medium.en-q5_0', 'small.en-q5_1'])
    )
    expect(p.modelId).toBe('medium.en-q5_0')
    expect(p.considered[0].modelId).toBe('medium.en-q5_0')
    expect(p.requiredBytes).toBeGreaterThan(1 * GB)
    expect(p.requiredBytes).toBeLessThan(p.budgetBytes)
  })

  it('pinned medium on 8 GB falls back with rationale when allowed, or returns null when not', () => {
    const models = installed(['medium.en-q5_0', 'base.en-q5_1', 'tiny.en-q5_1'])
    const rm = manager(MACHINE_8GB)
    const fb = rm.plan(cfg({ profile: 'balanced', modelId: 'medium.en-q5_0', allowFallback: true }), models)
    expect(fb.modelId).toBe('base.en-q5_1')
    expect(fb.rationale.join(' ')).toMatch(/Pinned model medium\.en-q5_0 is needs ~.*fell back to base\.en-q5_1/)
    expect(fb.considered[0]).toMatchObject({ modelId: 'medium.en-q5_0', installed: true })
    expect(fb.considered[0].eligibility.eligible).toBe(false)

    const strict = rm.plan(cfg({ profile: 'balanced', modelId: 'medium.en-q5_0', allowFallback: false }), models)
    expect(strict.modelId).toBeNull()
    expect(strict.rationale.join(' ')).toMatch(/fallback is disabled/)
    // Every candidate is still reported for the UI.
    expect(strict.considered.map((c) => c.modelId)).toEqual(['medium.en-q5_0', ...PROFILES.balanced.preferredModels])
  })

  it('pinned model that is not installed is reported and fallen back from', () => {
    const p = manager(MACHINE_16GB).plan(cfg({ modelId: 'small.en-q8_0' }), installed(['base.en-q5_1']))
    expect(p.modelId).toBe('base.en-q5_1')
    expect(p.considered[0]).toMatchObject({ modelId: 'small.en-q8_0', installed: false })
    expect(p.considered[0].eligibility.reasons[0]).toBe('not installed')
    expect(p.rationale.join(' ')).toMatch(/small\.en-q8_0 is not installed; fell back to base\.en-q5_1/)
  })

  it('custom profile considers only the pinned model', () => {
    const rm = manager(MACHINE_16GB)
    const p = rm.plan(cfg({ profile: 'custom', modelId: 'small.en-q5_1', threads: 3 }), installed(trio))
    expect(p.modelId).toBe('small.en-q5_1')
    expect(p.threads).toBe(3)
    expect(p.considered.map((c) => c.modelId)).toEqual(['small.en-q5_1'])
    const none = rm.plan(cfg({ profile: 'custom', modelId: null }), installed(trio))
    expect(none.modelId).toBeNull()
    expect(none.rationale.join(' ')).toMatch(/No model is pinned/)
  })

  it('nothing installed: suggests the cheapest model to install', () => {
    const p = manager(MACHINE_16GB).plan(cfg({ profile: 'lightweight' }), [])
    expect(p.modelId).toBeNull()
    expect(p.rationale.join(' ')).toMatch(/install tiny(\.en)?-q5_1/)
    expect(p.considered.every((c) => !c.installed)).toBe(true)
  })

  it('an unknown pinned id is reported, not thrown', () => {
    const p = manager(MACHINE_16GB).plan(cfg({ modelId: 'ggml-does-not-exist' }), installed(trio))
    expect(p.modelId).toBe('base.en-q5_1')
    expect(p.considered[0].eligibility.reasons).toEqual(['unknown model id'])
    expect(p.rationale.join(' ')).toMatch(/Unknown model id/)
  })

  it('active job bytes shrink the budget', () => {
    const rm = manager(MACHINE_8GB)
    const free = rm.plan(cfg({ profile: 'lightweight' }), installed(trio))
    const busy = rm.plan(cfg({ profile: 'lightweight' }), installed(trio), 500 * MB)
    expect(free.budgetBytes - busy.budgetBytes).toBe(500 * MB)
    expect(busy.modelId).toBeNull()
  })

  it('is deterministic for identical inputs', () => {
    const rm = manager(MACHINE_32GB)
    const a = rm.plan(cfg({ profile: 'high-accuracy' }), installed(trio))
    const b = rm.plan(cfg({ profile: 'high-accuracy' }), installed(trio))
    expect(a).toEqual(b)
  })
})

describe('canStartJob', () => {
  const rm = manager(MACHINE_16GB)
  const profile = PROFILES.balanced

  it('allows the first job of either kind', () => {
    expect(rm.canStartJob('live', [], profile)).toEqual({ ok: true })
    expect(rm.canStartJob('background', [], profile)).toEqual({ ok: true })
  })

  it('never starts a background job while a live job runs', () => {
    const r = rm.canStartJob('background', [{ kind: 'live', bytes: 500 * MB }], profile)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/live transcription is running/)
  })

  it('rejects a second live job', () => {
    expect(rm.canStartJob('live', [{ kind: 'live', bytes: 1 }], profile).ok).toBe(false)
  })

  it('live takes precedence over a running background job: caller must pause it first', () => {
    const blocked = rm.canStartJob('live', [{ kind: 'background', bytes: 1 }], profile)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/pause the running background job/)
    const paused = rm.canStartJob('live', [{ kind: 'background', bytes: 1, paused: true }], profile)
    expect(paused).toEqual({ ok: true })
  })

  it('enforces maxConcurrentJobs for background jobs', () => {
    const r = rm.canStartJob('background', [{ kind: 'background', bytes: 1 }], profile)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/only 1 transcription job may run/)
    const twoJobs = { ...profile, maxConcurrentJobs: 2 }
    expect(rm.canStartJob('background', [{ kind: 'background', bytes: 1 }], twoJobs).ok).toBe(true)
  })
})

describe('adapt', () => {
  const rm = manager(MACHINE_16GB)
  const profile = PROFILES.balanced
  const chunkMs = 10000

  it('does nothing when keeping up', () => {
    expect(rm.adapt({ backlogMs: 5000, recentRtf: 0.6, chunkMs }, profile).action).toBe('none')
    expect(rm.adapt({ backlogMs: 2 * chunkMs, recentRtf: 1.0, chunkMs }, profile).action).toBe('none')
    expect(rm.adapt({ backlogMs: 0, recentRtf: null, chunkMs }, profile).action).toBe('none')
  })

  it('warns when backlog exceeds two chunks or RTF exceeds 1.0', () => {
    expect(rm.adapt({ backlogMs: 2 * chunkMs + 1, recentRtf: 0.8, chunkMs }, profile).action).toBe('warn-lagging')
    // A slow RTF warns only once more than one chunk is actually waiting.
    expect(rm.adapt({ backlogMs: 1000, recentRtf: 1.01, chunkMs }, profile).action).toBe('none')
    expect(rm.adapt({ backlogMs: chunkMs + 1, recentRtf: 1.01, chunkMs }, profile).action).toBe('warn-lagging')
    // Falls back to the profile chunk length when chunkMs is 0.
    expect(rm.adapt({ backlogMs: 25000, recentRtf: null, chunkMs: 0 }, profile).action).toBe('warn-lagging')
  })

  it('defers to background when backlog exceeds 60 s or RTF exceeds 1.5', () => {
    const d1 = rm.adapt({ backlogMs: 60001, recentRtf: 0.9, chunkMs }, profile)
    expect(d1.action).toBe('defer-to-background')
    expect(d1.reason).toMatch(/after the meeting/)
    expect(rm.adapt({ backlogMs: 60000, recentRtf: 0.9, chunkMs }, profile).action).toBe('warn-lagging')
    expect(rm.adapt({ backlogMs: 0, recentRtf: 1.51, chunkMs }, profile).action).toBe('defer-to-background')
    expect(rm.adapt({ backlogMs: 0, recentRtf: 1.5, chunkMs }, profile).action).toBe('none')
    expect(rm.adapt({ backlogMs: chunkMs + 1, recentRtf: 1.5, chunkMs }, profile).action).toBe('warn-lagging')
  })

  it('is deterministic and never suggests a model switch', () => {
    const s = { backlogMs: 30000, recentRtf: 1.2, chunkMs }
    expect(rm.adapt(s, profile)).toEqual(rm.adapt(s, profile))
    expect(rm.adapt(s, profile).reason).not.toMatch(/model/i)
  })
})

describe('formatBytes', () => {
  it('formats GB with one decimal and MB as integers', () => {
    expect(formatBytes(1.5 * GB)).toBe('1.5 GB')
    expect(formatBytes(16 * GB)).toBe('16 GB')
    expect(formatBytes(700 * MB)).toBe('700 MB')
    expect(formatBytes(512 * 1024)).toBe('512 KB')
  })
})
