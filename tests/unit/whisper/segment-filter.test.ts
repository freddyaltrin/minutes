import { describe, it, expect } from 'vitest'
import { filterSegments, isRepetitionLoop, normalizeText } from '../../../src/main/services/whisper/segment-filter'

const seg = (text: string) => ({ text, startMs: 0, endMs: 1000 })

describe('isRepetitionLoop', () => {
  it('detects a phrase repeated three or more times, tolerating a trailing partial', () => {
    expect(isRepetitionLoop("I'm tired. I'm tired. I'm tired. I'm tired. I'm")).toBe(true)
    expect(isRepetitionLoop('Good afternoon. Good afternoon. Good afternoon.')).toBe(true)
    expect(isRepetitionLoop('I think it might have to be better. I think it might have to be better. I think it might have to be better.')).toBe(true)
  })
  it('keeps ordinary speech, short texts and natural double repeats', () => {
    expect(isRepetitionLoop('The valve list is due on Friday and the vendor will confirm.')).toBe(false)
    expect(isRepetitionLoop('No, no, no.')).toBe(false) // too short to judge
    expect(isRepetitionLoop('Okay okay, let us move on to the next item on the agenda.')).toBe(false)
    expect(isRepetitionLoop('Yes. Yes. Right, so the pump goes on the mezzanine.')).toBe(false)
  })
})

describe('filterSegments', () => {
  it('drops echoes of the previous context and resets it when nothing else survives', () => {
    const prev = 'and I think it might have to be better.'
    const r = filterSegments([seg('I think it might have to be better.')], prev)
    expect(r.kept).toHaveLength(0)
    expect(r.droppedEcho).toBe(1)
    expect(r.resetContext).toBe(true)
  })
  it('keeps new speech that follows an echo and does not reset the context', () => {
    const r = filterSegments([seg('I think it might have to be better.'), seg('Next, the piping isometrics.')], 'I think it might have to be better.')
    expect(r.kept.map((s) => s.text)).toEqual(['Next, the piping isometrics.'])
    expect(r.resetContext).toBe(false)
  })
  it('drops repetition loops and consecutive duplicates, keeps the rest verbatim', () => {
    const r = filterSegments([seg(" I'm tired. I'm tired. I'm tired. I'm tired."), seg('We start at nine.'), seg('We start at nine.'), seg('Fine.')], null)
    expect(r.kept.map((s) => s.text)).toEqual(['We start at nine.', 'Fine.'])
    expect(r.droppedRepeat).toBe(1)
    expect(r.droppedEcho).toBe(1)
  })
  it('does not treat short context tails as echoes', () => {
    // "yes" at the end of the context is too short to count as an echo of the whole window.
    const r = filterSegments([seg('Yes.')], 'and then he said yes')
    expect(r.kept).toHaveLength(1)
  })
  it('normalizes punctuation, case and whitespace', () => {
    expect(normalizeText("  I'm  TIRED. ")).toBe("i'm tired")
  })
})
