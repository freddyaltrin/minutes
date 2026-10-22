// Display helpers for whisper model ids, usable from main and renderer alike. Pure functions; the
// naming mirrors model-catalog.ts (`<Family> (<English|Multilingual>, <quant>)`) so a label derived
// here from an id matches the catalog `name` for the same id.

import type { ModelFamily } from './transcription-types'

export const FAMILY_LABELS: Record<ModelFamily, string> = {
  tiny: 'Tiny',
  base: 'Base',
  small: 'Small',
  medium: 'Medium',
  'large-v3-turbo': 'Large v3 Turbo',
  'large-v3': 'Large v3'
}

/** Families shown by default; the rest sit behind the "larger models" disclosure. */
export const COMMON_FAMILIES: ModelFamily[] = ['tiny', 'base', 'small']
export const LARGE_FAMILIES: ModelFamily[] = ['medium', 'large-v3-turbo', 'large-v3']

const FAMILY_ORDER: ModelFamily[] = ['large-v3-turbo', 'large-v3', 'medium', 'small', 'base', 'tiny']

export function familyOfModelId(id: string): ModelFamily | null {
  return FAMILY_ORDER.find((f) => id === f || id.startsWith(f + '.') || id.startsWith(f + '-')) ?? null
}

/** "base.en-q5_1" → "Base (English, q5_1)"; unknown ids are returned unchanged. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'no model'
  const family = familyOfModelId(id)
  if (!family) return id
  const rest = id.slice(family.length)
  const english = rest.startsWith('.en')
  const m = /-(q8_0|q5_1|q5_0)$/.exec(rest)
  return `${FAMILY_LABELS[family]} (${english ? 'English' : 'Multilingual'}, ${m ? m[1] : 'f16'})`
}

/** Short form for tight spaces: "Base · en · q5_1". */
export function modelShortLabel(id: string | null | undefined): string {
  if (!id) return 'no model'
  const family = familyOfModelId(id)
  if (!family) return id
  const rest = id.slice(family.length)
  const m = /-(q8_0|q5_1|q5_0)$/.exec(rest)
  return [FAMILY_LABELS[family], rest.startsWith('.en') ? 'en' : null, m ? m[1] : 'f16'].filter(Boolean).join(' · ')
}

export const SPEED_WORDS: Record<string, string> = {
  fastest: 'Fastest',
  fast: 'Fast',
  moderate: 'Moderate',
  slow: 'Slow',
  'very-slow': 'Very slow'
}

export const ACCURACY_WORDS: Record<string, string> = {
  basic: 'Basic',
  fair: 'Fair',
  good: 'Good',
  high: 'High',
  highest: 'Highest'
}

/** Languages offered in Settings, stored as ISO 639-1 codes. */
export const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ta', label: 'Tamil' },
  { code: 'ar', label: 'Arabic' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' }
]

/** "2.1× real time" when faster than real time, otherwise "slower than real time (RTF 1.8)". */
export function formatSpeed(rtf: number | null): string | null {
  if (rtf === null || !Number.isFinite(rtf) || rtf <= 0) return null
  if (rtf <= 1) return `${(1 / rtf).toFixed(1)}× real time`
  return `slower than real time (RTF ${rtf.toFixed(1)})`
}
