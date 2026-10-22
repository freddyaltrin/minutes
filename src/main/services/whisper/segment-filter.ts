// Post-decoding clean-up for whisper output that the model's own thresholds do not catch.
//
// Two failure modes were observed on the first Windows installation (2026-10-20, office
// background noise, base.en-q5_1):
//   1. Repetition loops inside one window: "I'm tired. I'm tired. I'm tired. I'm tired."
//   2. Prompt echo across windows: once a phrase has been decoded it is fed back as context for
//      the next window, and on noise the decoder simply returns the context — "I think it might
//      have to be better." came back unchanged for eight consecutive 10 s windows.
// Both are dropped here, and an echo also clears the context so the loop cannot continue.
// Nothing is rewritten: a segment is either kept verbatim or dropped.

export interface FilterableSegment {
  text: string
}

export interface FilterResult<T extends FilterableSegment> {
  kept: T[]
  droppedRepeat: number
  droppedEcho: number
  /** True when every segment was an echo of the previous context — the caller should reset it. */
  resetContext: boolean
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * True when the text is one phrase repeated three or more times with nothing else, e.g.
 * "i'm tired i'm tired i'm tired i'm" (a trailing partial repeat is tolerated).
 */
export function isRepetitionLoop(text: string): boolean {
  const words = normalizeText(text).split(' ').filter(Boolean)
  if (words.length < 6) return false
  // Try phrase lengths from 1 to a third of the text; the phrase must cover ≥ 85 % of the words.
  for (let len = 1; len <= Math.floor(words.length / 3); len++) {
    const phrase = words.slice(0, len).join(' ')
    let covered = 0
    let i = 0
    while (i + len <= words.length && words.slice(i, i + len).join(' ') === phrase) {
      covered += len
      i += len
    }
    const repeats = covered / len
    if (repeats >= 3 && covered >= words.length * 0.85) return true
  }
  return false
}

/**
 * Drop repetition loops and echoes of the previous context. `previousContext` is the text that
 * was supplied to the decoder as its prompt for this window (the previous window's output).
 */
export function filterSegments<T extends FilterableSegment>(segments: T[], previousContext: string | null | undefined): FilterResult<T> {
  const prev = previousContext ? normalizeText(previousContext) : ''
  const kept: T[] = []
  let droppedRepeat = 0
  let droppedEcho = 0
  let lastKept = ''
  for (const seg of segments) {
    const norm = normalizeText(seg.text)
    if (!norm) continue
    if (isRepetitionLoop(seg.text)) {
      droppedRepeat++
      continue
    }
    // An echo: the whole previous context, or its tail, or the previous kept segment, verbatim.
    const echoOfPrev = prev.length >= 12 && (norm === prev || (norm.length >= 12 && prev.endsWith(norm)))
    if (echoOfPrev || (lastKept && norm === lastKept)) {
      droppedEcho++
      continue
    }
    kept.push(seg)
    lastKept = norm
  }
  const resetContext = segments.length > 0 && kept.length === 0 && droppedEcho > 0
  return { kept, droppedRepeat, droppedEcho, resetContext }
}
