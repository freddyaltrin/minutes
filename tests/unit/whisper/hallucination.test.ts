import { describe, it, expect } from 'vitest'
import { isLikelyHallucination } from '../../../src/main/services/whisper/whisper-engine'

// Field case, 2026-10-20: 90 s of office noise on the first Windows installation produced
// exactly one segment, "Thanks for watching. Bye!" — a stock phrase Whisper invents on silence.
describe('isLikelyHallucination', () => {
  it('drops the OpenAI no-speech case: no_speech_prob > 0.6 with avg_logprob < -1', () => {
    expect(isLikelyHallucination({ text: 'and then we agreed', no_speech_prob: 0.7, avg_logprob: -1.2 })).toBe(true)
    expect(isLikelyHallucination({ text: 'and then we agreed', no_speech_prob: 0.7, avg_logprob: -0.4 })).toBe(false)
    expect(isLikelyHallucination({ text: 'and then we agreed', no_speech_prob: 0.2, avg_logprob: -1.5 })).toBe(false)
  })

  it('drops stock phrases only when the no-speech probability is already elevated', () => {
    expect(isLikelyHallucination({ text: ' Thanks for watching. Bye!', no_speech_prob: 0.45, avg_logprob: -0.3 })).toBe(true)
    expect(isLikelyHallucination({ text: 'Subtitles by the Amara.org community', no_speech_prob: 0.35, avg_logprob: -0.3 })).toBe(true)
    expect(isLikelyHallucination({ text: 'you', no_speech_prob: 0.5, avg_logprob: -0.2 })).toBe(true)
    // The same words in a real meeting, with speech clearly present, are kept.
    expect(isLikelyHallucination({ text: 'Thank you.', no_speech_prob: 0.1, avg_logprob: -0.3 })).toBe(false)
    expect(isLikelyHallucination({ text: 'thanks for watching the demo, any questions', no_speech_prob: 0.1, avg_logprob: -0.3 })).toBe(false)
  })

  it('keeps ordinary speech and copes with missing probabilities', () => {
    expect(isLikelyHallucination({ text: 'The valve list is due on Friday.' })).toBe(false)
    expect(isLikelyHallucination({ text: 'Thanks for watching' })).toBe(false) // no probabilities → no evidence of silence
    expect(isLikelyHallucination({ text: '   ', no_speech_prob: 0.9 })).toBe(false) // empty text is dropped elsewhere
  })
})
