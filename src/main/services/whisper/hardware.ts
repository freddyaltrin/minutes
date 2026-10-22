// Hardware inspection for the whisper.cpp transcription subsystem.
//
// Pure, synchronous and fast (< 50 ms): every OS access goes through an injectable
// `HardwareProvider`, so tests can feed fake /proc contents and the default provider
// reads only `os.*` plus two small files. `inspectHardware` never throws — any failure
// degrades to conservative fallbacks (2 cores, 4 GB total, 1 GB free, features unreliable).
//
// Platform notes
// - Linux: available memory comes from /proc/meminfo `MemAvailable` (kernel ≥ 3.14), which
//   accounts for reclaimable page cache; `os.freemem()` on Linux is the much smaller "free".
//   CPU features come from the `flags` line of /proc/cpuinfo.
// - Windows: `os.freemem()` is implemented via GlobalMemoryStatusEx().ullAvailPhys, i.e. it
//   already reports *available* physical memory (standby pages included), so it is used
//   directly as availableMemoryBytes. No `wmic` / PowerShell is spawned. CPU feature flags
//   are not exposed by Node on Windows, so `features` is [] and `featuresReliable` is false
//   until the whisper worker reports the ggml CPU variant it selected
//   (see `applyRuntimeFeatureHint`). PROCESSOR_IDENTIFIER is used only for the model name.
// - macOS: `os.freemem()` is "free" pages only; availableMemoryBytes stays null and the
//   resource manager falls back to its conservative estimate.

import os from 'node:os'
import { readFileSync } from 'node:fs'
import type { HardwareInfo } from '@shared/transcription-types'

export interface HardwareProvider {
  platform: () => string
  arch: () => string
  cpus: () => { model: string }[]
  totalmem: () => number
  freemem: () => number
  /** Raw text of /proc/meminfo (Linux) or null when unavailable. */
  readMeminfo: () => string | null
  /** Raw text of /proc/cpuinfo (Linux) or null when unavailable. */
  readCpuinfo: () => string | null
  env: () => Record<string, string | undefined>
  /** Optional ggml CPU variant / feature hint, e.g. "haswell" or "avx2". */
  cpuFeaturesHint?: string | null
  now?: () => number
}

export const FALLBACK_LOGICAL_CORES = 2
export const FALLBACK_TOTAL_MEMORY = 4 * 1024 ** 3
export const FALLBACK_FREE_MEMORY = 1 * 1024 ** 3

/** Feature flags we care about for whisper.cpp/ggml CPU performance, in canonical spelling. */
export const KNOWN_FEATURES = ['sse4_2', 'avx', 'avx2', 'avx512f', 'f16c', 'fma'] as const
export type KnownFeature = (typeof KNOWN_FEATURES)[number]

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export function defaultHardwareProvider(): HardwareProvider {
  const isLinux = process.platform === 'linux'
  return {
    platform: () => os.platform(),
    arch: () => os.arch(),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    readMeminfo: () => (isLinux ? safeRead('/proc/meminfo') : null),
    readCpuinfo: () => (isLinux ? safeRead('/proc/cpuinfo') : null),
    env: () => process.env,
    cpuFeaturesHint: null,
    now: () => Date.now()
  }
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse `MemAvailable:   12345 kB` from /proc/meminfo; null when missing or malformed. */
export function parseMemAvailable(meminfo: string | null): number | null {
  if (!meminfo) return null
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo)
  if (!m) return null
  const kb = Number(m[1])
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null
}

/** Parse the first `flags:` line of /proc/cpuinfo into our canonical feature list. */
export function parseCpuinfoFlags(cpuinfo: string | null): { features: string[]; reliable: boolean } {
  if (!cpuinfo) return { features: [], reliable: false }
  const m = /^(?:flags|Features)\s*:\s*(.+)$/m.exec(cpuinfo)
  if (!m) return { features: [], reliable: false }
  const set = new Set(m[1].trim().toLowerCase().split(/\s+/))
  const features = KNOWN_FEATURES.filter((f) => set.has(f))
  return { features: [...features], reliable: true }
}

/** Parse the first `model name:` line of /proc/cpuinfo. */
export function parseCpuinfoModel(cpuinfo: string | null): string | null {
  if (!cpuinfo) return null
  const m = /^(?:model name|Model|Hardware)\s*:\s*(.+)$/m.exec(cpuinfo)
  return m ? m[1].trim() : null
}

/**
 * Map a ggml CPU-variant / microarchitecture name (as whisper.cpp logs when it loads a
 * backend) or a feature keyword to the feature list implied by it. Unknown strings return
 * null so the caller can leave the info untouched.
 */
export function featuresFromHint(hint: string): string[] | null {
  const h = hint.trim().toLowerCase().replace(/[\s-]+/g, '')
  if (!h) return null
  const SSE42 = ['sse4_2']
  const AVX = ['sse4_2', 'avx']
  const AVX2 = ['sse4_2', 'avx', 'avx2', 'f16c', 'fma']
  const AVX512 = ['sse4_2', 'avx', 'avx2', 'f16c', 'fma', 'avx512f']
  const table: Record<string, string[]> = {
    // generic / feature keywords
    x64: [],
    x86_64: [],
    generic: [],
    sse42: SSE42,
    sse4_2: SSE42,
    avx: AVX,
    avx2: AVX2,
    avx512: AVX512,
    avx512f: AVX512,
    // Intel microarchitectures
    nehalem: SSE42,
    westmere: SSE42,
    sandybridge: AVX,
    ivybridge: ['sse4_2', 'avx', 'f16c'],
    haswell: AVX2,
    broadwell: AVX2,
    skylake: AVX2,
    kabylake: AVX2,
    coffeelake: AVX2,
    cometlake: AVX2,
    alderlake: AVX2,
    raptorlake: AVX2,
    meteorlake: AVX2,
    skylakex: AVX512,
    skylakeavx512: AVX512,
    cascadelake: AVX512,
    icelake: AVX512,
    icelakeserver: AVX512,
    icelakeclient: AVX512,
    tigerlake: AVX512,
    sapphirerapids: AVX512,
    // AMD
    bulldozer: AVX,
    piledriver: AVX2,
    zen: AVX2,
    znver1: AVX2,
    zen2: AVX2,
    znver2: AVX2,
    zen3: AVX2,
    znver3: AVX2,
    zen4: AVX512,
    znver4: AVX512,
    zen5: AVX512,
    znver5: AVX512
  }
  if (h in table) return [...table[h]]
  // Fallback: a bare bundle of keywords such as "avx2 fma f16c".
  const words = hint.toLowerCase().split(/[^a-z0-9_.]+/).filter(Boolean)
  const set = new Set<string>()
  for (const w of words) {
    const canon = w.replace('sse4.2', 'sse4_2').replace('sse42', 'sse4_2')
    if ((KNOWN_FEATURES as readonly string[]).includes(canon)) set.add(canon)
  }
  return set.size ? KNOWN_FEATURES.filter((f) => set.has(f)) : null
}

/** Apply a runtime CPU-variant hint (from the whisper worker) to a HardwareInfo. Returns a copy. */
export function applyRuntimeFeatureHint(info: HardwareInfo, hint: string | null | undefined): HardwareInfo {
  if (!hint) return info
  const features = featuresFromHint(hint)
  if (features === null) return info
  // A reliable /proc/cpuinfo reading is at least as good as the hint — merge, don't downgrade.
  const merged = info.featuresReliable ? new Set([...info.features, ...features]) : new Set(features)
  return { ...info, features: KNOWN_FEATURES.filter((f) => merged.has(f)), featuresReliable: true }
}

/** Heuristic: Intel/AMD desktop & mobile parts with ≥ 4 logical cores usually have SMT. */
export function estimatePhysicalCores(logicalCores: number, cpuModel: string): number | null {
  if (!Number.isFinite(logicalCores) || logicalCores < 1) return null
  const m = cpuModel.toLowerCase()
  const x86Vendor = /intel|amd|ryzen|epyc|xeon|core\(tm\)|pentium|celeron|athlon|threadripper/.test(m)
  // Intel Atom / Celeron N-series and most ARM parts have no SMT.
  const noSmt = /atom|celeron(\(r\))? n\d|pentium(\(r\))? (silver|n\d)|apple|\barm\b|snapdragon|cortex/.test(m)
  if (logicalCores >= 4 && x86Vendor && !noSmt) return Math.max(1, Math.floor(logicalCores / 2))
  return logicalCores
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function positiveOr(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback
}

export function inspectHardware(provider: HardwareProvider = defaultHardwareProvider()): HardwareInfo {
  const now = (() => {
    try {
      return provider.now?.() ?? Date.now()
    } catch {
      return Date.now()
    }
  })()

  let platform = 'unknown'
  let arch = 'unknown'
  try {
    platform = provider.platform() || 'unknown'
  } catch {
    /* fallback */
  }
  try {
    arch = provider.arch() || 'unknown'
  } catch {
    /* fallback */
  }

  let logicalCores = FALLBACK_LOGICAL_CORES
  let cpuModel = ''
  try {
    const cpus = provider.cpus()
    if (Array.isArray(cpus) && cpus.length > 0) {
      logicalCores = cpus.length
      cpuModel = (cpus[0]?.model ?? '').trim()
    }
  } catch {
    /* fallback */
  }

  let totalMemoryBytes = FALLBACK_TOTAL_MEMORY
  let freeMemoryBytes = FALLBACK_FREE_MEMORY
  try {
    totalMemoryBytes = positiveOr(provider.totalmem(), FALLBACK_TOTAL_MEMORY)
  } catch {
    /* fallback */
  }
  try {
    freeMemoryBytes = positiveOr(provider.freemem(), FALLBACK_FREE_MEMORY)
  } catch {
    /* fallback */
  }
  if (freeMemoryBytes > totalMemoryBytes) freeMemoryBytes = totalMemoryBytes

  let availableMemoryBytes: number | null = null
  let features: string[] = []
  let featuresReliable = false

  if (platform === 'linux') {
    try {
      availableMemoryBytes = parseMemAvailable(provider.readMeminfo())
    } catch {
      availableMemoryBytes = null
    }
    try {
      const cpuinfo = provider.readCpuinfo()
      const parsed = parseCpuinfoFlags(cpuinfo)
      features = parsed.features
      featuresReliable = parsed.reliable
      if (!cpuModel) cpuModel = parseCpuinfoModel(cpuinfo) ?? ''
    } catch {
      features = []
      featuresReliable = false
    }
  } else if (platform === 'win32') {
    // os.freemem() → GlobalMemoryStatusEx.ullAvailPhys: already "available", see header.
    availableMemoryBytes = freeMemoryBytes
    try {
      const env = provider.env()
      if (!cpuModel) cpuModel = (env.PROCESSOR_IDENTIFIER ?? '').trim()
      if (!cpuModel && env.PROCESSOR_LEVEL) cpuModel = `x86 family ${env.PROCESSOR_LEVEL}`
    } catch {
      /* fallback */
    }
    features = []
    featuresReliable = false
  }
  if (availableMemoryBytes !== null && availableMemoryBytes > totalMemoryBytes) availableMemoryBytes = totalMemoryBytes

  if (!cpuModel) cpuModel = 'Unknown CPU'

  const info: HardwareInfo = {
    platform,
    arch,
    cpuModel,
    logicalCores,
    physicalCores: estimatePhysicalCores(logicalCores, cpuModel),
    totalMemoryBytes,
    freeMemoryBytes,
    availableMemoryBytes,
    features,
    featuresReliable,
    checkedAt: now
  }

  try {
    return applyRuntimeFeatureHint(info, provider.cpuFeaturesHint)
  } catch {
    return info
  }
}

export function hasFeature(hw: HardwareInfo, feature: KnownFeature): boolean {
  return hw.features.includes(feature)
}
