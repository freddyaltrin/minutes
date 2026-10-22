import { describe, it, expect } from 'vitest'
import type { HardwareInfo } from '../../../src/shared/transcription-types'
import {
  PROFILES,
  PROFILE_IDS,
  DEFAULT_CONFIG,
  PIN_ONLY_FAMILIES,
  recommendProfile,
  getProfile
} from '../../../src/main/services/whisper/profiles'

const GB = 1024 ** 3

function hw(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'test',
    logicalCores: 4,
    physicalCores: 2,
    totalMemoryBytes: 16 * GB,
    freeMemoryBytes: 8 * GB,
    availableMemoryBytes: 10 * GB,
    features: ['sse4_2', 'avx', 'avx2', 'f16c', 'fma'],
    featuresReliable: true,
    checkedAt: 0,
    ...overrides
  }
}

describe('PROFILES', () => {
  it('defines all four profiles with the agreed ceilings', () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...PROFILE_IDS].sort())
    for (const id of PROFILE_IDS) expect(PROFILES[id].id).toBe(id)

    const l = PROFILES.lightweight
    expect(l.preferredModels).toEqual(['tiny.en-q5_1', 'tiny-q5_1', 'tiny.en-q8_0', 'tiny-q8_0', 'base.en-q5_1', 'base-q5_1'])
    expect(l.maxThreads).toBe(2)
    expect(l.threadFraction).toBe(0.5)
    expect(l.safetyMarginBytes).toBe(0.75 * GB)
    expect(l.maxConcurrentJobs).toBe(1)
    expect(l.liveChunkMs).toBe(12000)

    const b = PROFILES.balanced
    expect(b.preferredModels[0]).toBe('base.en-q5_1')
    expect(b.preferredModels).toContain('small.en-q5_1')
    expect(b.preferredModels).toHaveLength(8)
    expect(b.maxThreads).toBe(6)
    expect(b.safetyMarginBytes).toBe(1 * GB)
    expect(b.liveChunkMs).toBe(10000)
    expect(b.description).toContain('docs/benchmarks.md')

    const h = PROFILES['high-accuracy']
    expect(h.preferredModels[0]).toBe('small.en-q5_1')
    expect(h.preferredModels).toContain('medium.en-q5_0')
    expect(h.preferredModels).toContain('large-v3-turbo-q5_0')
    expect(h.maxThreads).toBe(6)
    expect(h.threadFraction).toBe(0.75)
    expect(h.safetyMarginBytes).toBe(1.5 * GB)

    const c = PROFILES.custom
    expect(c.preferredModels).toEqual([])
    expect(c.maxThreads).toBe(8)
    expect(c.safetyMarginBytes).toBe(1 * GB)
  })

  it('marks medium and large families as pin-only', () => {
    expect(PIN_ONLY_FAMILIES.has('medium')).toBe(true)
    expect(PIN_ONLY_FAMILIES.has('large-v3-turbo')).toBe(true)
    expect(PIN_ONLY_FAMILIES.has('large-v3')).toBe(true)
    expect(PIN_ONLY_FAMILIES.has('small')).toBe(false)
  })

  it('getProfile falls back to balanced for an unknown id', () => {
    expect(getProfile('nope' as never).id).toBe('balanced')
  })
})

describe('DEFAULT_CONFIG', () => {
  it('matches the agreed defaults', () => {
    expect(DEFAULT_CONFIG).toEqual({
      engine: 'whisper',
      profile: 'balanced',
      modelId: null,
      threads: null,
      language: null,
      allowFallback: true,
      backgroundAfterMeeting: true,
      customVocabulary: []
    })
  })
})

describe('recommendProfile', () => {
  it('recommends lightweight below 12 GB', () => {
    expect(recommendProfile(hw({ totalMemoryBytes: 8 * GB }))).toBe('lightweight')
    expect(recommendProfile(hw({ totalMemoryBytes: 12 * GB - 1 }))).toBe('lightweight')
    expect(recommendProfile(hw({ totalMemoryBytes: 12 * GB }))).toBe('balanced')
  })

  it('recommends lightweight for ≤ 2 logical cores', () => {
    expect(recommendProfile(hw({ logicalCores: 2, physicalCores: 2 }))).toBe('lightweight')
    expect(recommendProfile(hw({ logicalCores: 3, physicalCores: 3 }))).toBe('balanced')
  })

  it('recommends lightweight when AVX2 is reliably absent, but not when features are unknown', () => {
    expect(recommendProfile(hw({ features: ['sse4_2', 'avx'], featuresReliable: true }))).toBe('lightweight')
    expect(recommendProfile(hw({ features: [], featuresReliable: false }))).toBe('balanced')
  })

  it('recommends high-accuracy at ≥ 28 GB, ≥ 8 cores and AVX2', () => {
    expect(recommendProfile(hw({ totalMemoryBytes: 32 * GB, logicalCores: 8, physicalCores: 4 }))).toBe('high-accuracy')
    expect(recommendProfile(hw({ totalMemoryBytes: 28 * GB, logicalCores: 8, physicalCores: 4 }))).toBe('high-accuracy')
    expect(recommendProfile(hw({ totalMemoryBytes: 28 * GB - 1, logicalCores: 8, physicalCores: 4 }))).toBe('balanced')
    expect(recommendProfile(hw({ totalMemoryBytes: 32 * GB, logicalCores: 6, physicalCores: 3 }))).toBe('balanced')
    // Unknown features (Windows without a runtime hint) still allow high-accuracy.
    expect(
      recommendProfile(hw({ totalMemoryBytes: 32 * GB, logicalCores: 8, features: [], featuresReliable: false }))
    ).toBe('high-accuracy')
  })

  it('is deterministic', () => {
    const h = hw({ totalMemoryBytes: 16 * GB })
    expect(recommendProfile(h)).toBe(recommendProfile({ ...h }))
  })
})
