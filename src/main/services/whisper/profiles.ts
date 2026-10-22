// Transcription profiles: model preference order and resource ceilings per profile, plus the
// hardware-based recommendation. Pure data + one pure function; no Electron.

import type { HardwareInfo, ProfileDefinition, ProfileId, TranscriptionConfig } from '@shared/transcription-types'

const GB = 1024 ** 3

// Safety margins are the headroom that must remain for Windows and the other open applications
// AFTER the engine has loaded (budget = available − margin). They were first set at 1.5 / 2.5 / 4 GB,
// which refused every model on a 16 GB office laptop that had 2.1 GB available with Chrome, Word,
// Excel and a mail client open (field check, Oct 2026) even though tiny needs ~0.5 GB. The figures
// below keep roughly 1 GB of paging headroom, which is what matters; the per-model requirement
// (model memory + per-thread scratch + job overhead) is still fully charged against the budget.

/** Model families that are never auto-selected; only an explicit pin (config.modelId) may use them. */
export const PIN_ONLY_FAMILIES: ReadonlySet<string> = new Set(['medium', 'large-v3-turbo', 'large-v3'])

export const PROFILES: Record<ProfileId, ProfileDefinition> = {
  lightweight: {
    id: 'lightweight',
    name: 'Lightweight',
    description:
      'For machines with about 8 GB of RAM or older CPUs (no AVX2, 2 cores). Uses the tiny models ' +
      '(base as a last resort), two threads at most and longer 12 s live chunks so a conferencing ' +
      'app can keep running alongside. Accuracy is basic; a background pass after the meeting ' +
      'with a larger model is recommended when memory allows.',
    preferredModels: ['tiny.en-q5_1', 'tiny-q5_1', 'tiny.en-q8_0', 'tiny-q8_0', 'base.en-q5_1', 'base-q5_1'],
    maxThreads: 2,
    threadFraction: 0.5,
    safetyMarginBytes: 0.75 * GB,
    maxConcurrentJobs: 1,
    liveChunkMs: 12000
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    description:
      'Default for typical 16 GB laptops: the base models first, small when there is room, tiny as a ' +
      'fallback; up to six threads (half the logical cores, never more than the physical ones) and 10 s live chunks. Whether base or small should be the ' +
      'default pick for this profile is to be confirmed by the benchmark procedure in docs/benchmarks.md.',
    preferredModels: [
      'base.en-q5_1',
      'base-q5_1',
      'base.en-q8_0',
      'base-q8_0',
      'small.en-q5_1',
      'small-q5_1',
      'tiny.en-q5_1',
      'tiny-q5_1'
    ],
    // Six, not four: on a 14-thread Core Ultra 7 laptop with office apps open, base.en at four
    // threads ran at about real time on noisy audio and fell 22 s behind (2026-10-20). Half the
    // logical cores, capped by the physical count, still leaves the machine responsive.
    maxThreads: 6,
    threadFraction: 0.5,
    safetyMarginBytes: 1 * GB,
    maxConcurrentJobs: 1,
    liveChunkMs: 10000
  },
  'high-accuracy': {
    id: 'high-accuracy',
    name: 'High accuracy',
    description:
      'For 32 GB machines with 8+ cores and AVX2: the small models first, up to six threads. ' +
      'Medium and large-v3-turbo are listed but are never selected automatically — they are used ' +
      'only when pinned explicitly in Settings and the memory check passes.',
    preferredModels: [
      'small.en-q5_1',
      'small-q5_1',
      'small.en-q8_0',
      'small-q8_0',
      'medium.en-q5_0',
      'medium-q5_0',
      'large-v3-turbo-q5_0',
      'base.en-q5_1',
      'base-q5_1'
    ],
    maxThreads: 6,
    threadFraction: 0.75,
    safetyMarginBytes: 1.5 * GB,
    maxConcurrentJobs: 1,
    liveChunkMs: 10000
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    description:
      'You choose the model and thread count. Only the pinned model is considered; the memory ' +
      'check still applies, with a 1 GB safety margin.',
    preferredModels: [],
    maxThreads: 8,
    threadFraction: 0.75,
    safetyMarginBytes: 1 * GB,
    maxConcurrentJobs: 1,
    liveChunkMs: 10000
  }
}

export const PROFILE_IDS: ProfileId[] = ['lightweight', 'balanced', 'high-accuracy', 'custom']

export const DEFAULT_CONFIG: TranscriptionConfig = {
  engine: 'whisper',
  profile: 'balanced',
  modelId: null,
  threads: null,
  language: null,
  allowFallback: true,
  backgroundAfterMeeting: true,
  customVocabulary: []
}

export function getProfile(id: ProfileId): ProfileDefinition {
  return PROFILES[id] ?? PROFILES.balanced
}

/**
 * Pick a profile from the hardware alone.
 * - lightweight: < 12 GB RAM, or ≤ 2 logical cores, or a reliably-detected CPU without AVX2
 * - high-accuracy: ≥ 28 GB RAM and ≥ 8 logical cores and AVX2 (or features unknown)
 * - balanced otherwise
 */
export function recommendProfile(hw: HardwareInfo): ProfileId {
  const hasAvx2 = hw.features.includes('avx2')
  if (hw.totalMemoryBytes < 12 * GB) return 'lightweight'
  if (hw.logicalCores <= 2) return 'lightweight'
  if (hw.featuresReliable && !hasAvx2) return 'lightweight'
  if (hw.totalMemoryBytes >= 28 * GB && hw.logicalCores >= 8 && (!hw.featuresReliable || hasAvx2)) {
    return 'high-accuracy'
  }
  return 'balanced'
}
