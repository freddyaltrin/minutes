import { describe, it, expect } from 'vitest'
import {
  inspectHardware,
  applyRuntimeFeatureHint,
  featuresFromHint,
  parseMemAvailable,
  parseCpuinfoFlags,
  estimatePhysicalCores,
  defaultHardwareProvider,
  FALLBACK_LOGICAL_CORES,
  FALLBACK_TOTAL_MEMORY,
  FALLBACK_FREE_MEMORY,
  type HardwareProvider
} from '../../../src/main/services/whisper/hardware'

const GB = 1024 ** 3

const LINUX_CPUINFO = `processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz
flags\t\t: fpu vme de pse tsc msr pae mce cx8 sse sse2 ssse3 fma cx16 sse4_1 sse4_2 avx f16c avx2 bmi1 bmi2
processor\t: 1
model name\t: Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz
flags\t\t: fpu sse4_2 avx avx2
`

const LINUX_MEMINFO = `MemTotal:       16303424 kB
MemFree:          812340 kB
MemAvailable:    9876544 kB
Buffers:          123456 kB
`

function provider(overrides: Partial<HardwareProvider> = {}): HardwareProvider {
  return {
    platform: () => 'linux',
    arch: () => 'x64',
    cpus: () => Array.from({ length: 8 }, () => ({ model: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz' })),
    totalmem: () => 16303424 * 1024,
    freemem: () => 812340 * 1024,
    readMeminfo: () => LINUX_MEMINFO,
    readCpuinfo: () => LINUX_CPUINFO,
    env: () => ({}),
    cpuFeaturesHint: null,
    now: () => 1_700_000_000_000,
    ...overrides
  }
}

describe('parsers', () => {
  it('parses MemAvailable from /proc/meminfo', () => {
    expect(parseMemAvailable(LINUX_MEMINFO)).toBe(9876544 * 1024)
    expect(parseMemAvailable('MemTotal: 1 kB\n')).toBeNull()
    expect(parseMemAvailable(null)).toBeNull()
    expect(parseMemAvailable('MemAvailable: abc kB')).toBeNull()
  })

  it('parses the known feature flags from /proc/cpuinfo, in canonical order', () => {
    expect(parseCpuinfoFlags(LINUX_CPUINFO)).toEqual({
      features: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma'],
      reliable: true
    })
    expect(parseCpuinfoFlags('flags\t: fpu sse sse2\n')).toEqual({ features: [], reliable: true })
    expect(parseCpuinfoFlags('model name: foo\n')).toEqual({ features: [], reliable: false })
    expect(parseCpuinfoFlags(null)).toEqual({ features: [], reliable: false })
  })

  it('estimates physical cores as logical/2 on x86 parts with ≥ 4 logical cores', () => {
    expect(estimatePhysicalCores(8, 'Intel(R) Core(TM) i7-8550U')).toBe(4)
    expect(estimatePhysicalCores(16, 'AMD Ryzen 7 5800X 8-Core Processor')).toBe(8)
    expect(estimatePhysicalCores(2, 'Intel(R) Core(TM) i3')).toBe(2)
    expect(estimatePhysicalCores(4, 'Intel(R) Celeron(R) N4020')).toBe(4)
    expect(estimatePhysicalCores(8, 'Apple M1')).toBe(8)
    expect(estimatePhysicalCores(0, 'x')).toBeNull()
  })
})

describe('inspectHardware on Linux', () => {
  it('reads cores, memory, MemAvailable and reliable features', () => {
    const hw = inspectHardware(provider())
    expect(hw.platform).toBe('linux')
    expect(hw.logicalCores).toBe(8)
    expect(hw.physicalCores).toBe(4)
    expect(hw.cpuModel).toContain('i5-8250U')
    expect(hw.totalMemoryBytes).toBe(16303424 * 1024)
    expect(hw.freeMemoryBytes).toBe(812340 * 1024)
    expect(hw.availableMemoryBytes).toBe(9876544 * 1024)
    expect(hw.features).toEqual(['sse4_2', 'avx', 'avx2', 'f16c', 'fma'])
    expect(hw.featuresReliable).toBe(true)
    expect(hw.checkedAt).toBe(1_700_000_000_000)
  })

  it('reports no AVX2 reliably on an old CPU', () => {
    const hw = inspectHardware(
      provider({
        cpus: () => [{ model: 'Intel(R) Core(TM)2 Duo CPU E8400' }, { model: 'Intel(R) Core(TM)2 Duo CPU E8400' }],
        readCpuinfo: () => 'flags\t: fpu sse sse2 ssse3 sse4_1\n'
      })
    )
    expect(hw.features).toEqual([])
    expect(hw.featuresReliable).toBe(true)
    expect(hw.physicalCores).toBe(2)
  })

  it('leaves availableMemory null when /proc/meminfo is unreadable', () => {
    const hw = inspectHardware(provider({ readMeminfo: () => null }))
    expect(hw.availableMemoryBytes).toBeNull()
  })
})

describe('inspectHardware on Windows', () => {
  it('uses freemem as available memory and marks features unreliable', () => {
    const hw = inspectHardware(
      provider({
        platform: () => 'win32',
        cpus: () => Array.from({ length: 4 }, () => ({ model: 'Intel(R) Core(TM) i3-7100U CPU @ 2.40GHz' })),
        totalmem: () => 8 * GB,
        freemem: () => 3 * GB,
        readMeminfo: () => null,
        readCpuinfo: () => null
      })
    )
    expect(hw.platform).toBe('win32')
    expect(hw.availableMemoryBytes).toBe(3 * GB)
    expect(hw.features).toEqual([])
    expect(hw.featuresReliable).toBe(false)
    expect(hw.physicalCores).toBe(2)
  })

  it('falls back to PROCESSOR_IDENTIFIER for the model name', () => {
    const hw = inspectHardware(
      provider({
        platform: () => 'win32',
        cpus: () => [{ model: '' }, { model: '' }],
        env: () => ({ PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model 142 Stepping 10, GenuineIntel' })
      })
    )
    expect(hw.cpuModel).toContain('Intel64 Family 6')
  })

  it('applies a cpuFeaturesHint from the provider', () => {
    const hw = inspectHardware(provider({ platform: () => 'win32', cpuFeaturesHint: 'haswell' }))
    expect(hw.featuresReliable).toBe(true)
    expect(hw.features).toContain('avx2')
  })
})

describe('runtime feature hints', () => {
  it('maps ggml CPU variant names to feature lists', () => {
    expect(featuresFromHint('sandybridge')).toEqual(['sse4_2', 'avx'])
    expect(featuresFromHint('haswell')).toEqual(['sse4_2', 'avx', 'avx2', 'f16c', 'fma'])
    expect(featuresFromHint('x64')).toEqual([])
    expect(featuresFromHint('sse42')).toEqual(['sse4_2'])
    expect(featuresFromHint('skylakex')).toContain('avx512f')
    expect(featuresFromHint('icelake')).toContain('avx512f')
    expect(featuresFromHint('alderlake')).toContain('avx2')
    expect(featuresFromHint('alderlake')).not.toContain('avx512f')
    expect(featuresFromHint('zen4')).toContain('avx512f')
    expect(featuresFromHint('Zen 4')).toContain('avx512f')
    expect(featuresFromHint('AVX2 FMA F16C')).toEqual(['avx2', 'f16c', 'fma'])
    expect(featuresFromHint('unknown-thing')).toBeNull()
    expect(featuresFromHint('')).toBeNull()
  })

  it('applyRuntimeFeatureHint upgrades an unreliable reading and merges a reliable one', () => {
    const base = inspectHardware(provider({ platform: () => 'win32' }))
    expect(base.featuresReliable).toBe(false)
    const hinted = applyRuntimeFeatureHint(base, 'sandybridge')
    expect(hinted.featuresReliable).toBe(true)
    expect(hinted.features).toEqual(['sse4_2', 'avx'])
    expect(base.features).toEqual([]) // original untouched

    const linux = inspectHardware(provider())
    const merged = applyRuntimeFeatureHint(linux, 'zen4')
    expect(merged.features).toEqual(['sse4_2', 'avx', 'avx2', 'avx512f', 'f16c', 'fma'])

    expect(applyRuntimeFeatureHint(base, 'garbage')).toBe(base)
    expect(applyRuntimeFeatureHint(base, null)).toBe(base)
  })
})

describe('robustness', () => {
  it('never throws and falls back to conservative values when the provider fails', () => {
    const boom = () => {
      throw new Error('boom')
    }
    const hw = inspectHardware({
      platform: boom,
      arch: boom,
      cpus: boom,
      totalmem: boom,
      freemem: boom,
      readMeminfo: boom,
      readCpuinfo: boom,
      env: boom,
      now: boom
    })
    expect(hw.logicalCores).toBe(FALLBACK_LOGICAL_CORES)
    expect(hw.totalMemoryBytes).toBe(FALLBACK_TOTAL_MEMORY)
    expect(hw.freeMemoryBytes).toBe(FALLBACK_FREE_MEMORY)
    expect(hw.availableMemoryBytes).toBeNull()
    expect(hw.featuresReliable).toBe(false)
    expect(hw.features).toEqual([])
    expect(hw.cpuModel).toBe('Unknown CPU')
    expect(hw.platform).toBe('unknown')
    expect(typeof hw.checkedAt).toBe('number')
  })

  it('handles bogus numbers (NaN, negative, free > total)', () => {
    const hw = inspectHardware(provider({ totalmem: () => NaN, freemem: () => -5, cpus: () => [] }))
    expect(hw.totalMemoryBytes).toBe(FALLBACK_TOTAL_MEMORY)
    expect(hw.freeMemoryBytes).toBe(FALLBACK_FREE_MEMORY)
    expect(hw.logicalCores).toBe(FALLBACK_LOGICAL_CORES)
    const hw2 = inspectHardware(provider({ totalmem: () => 1 * GB, freemem: () => 2 * GB, readMeminfo: () => null }))
    expect(hw2.freeMemoryBytes).toBe(1 * GB)
  })

  it('runs against the real OS quickly and sanely', () => {
    const t0 = performance.now()
    const hw = inspectHardware(defaultHardwareProvider())
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(50)
    expect(hw.logicalCores).toBeGreaterThanOrEqual(1)
    expect(hw.totalMemoryBytes).toBeGreaterThan(0)
    expect(hw.freeMemoryBytes).toBeGreaterThan(0)
    expect(hw.freeMemoryBytes).toBeLessThanOrEqual(hw.totalMemoryBytes)
  })
})
