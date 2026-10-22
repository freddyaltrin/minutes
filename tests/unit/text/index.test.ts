import { describe, expect, it } from 'vitest'
import * as text from '@shared/text'

describe('text barrel', () => {
  it('re-exports every module entry point', () => {
    for (const name of [
      'tokenize', 'STOPWORDS', 'stem', 'normalizeTerm', 'splitSentences', 'escapeHtml', 'highlightTerms', 'makeSnippet',
      'extractKeywords', 'textRankPhrases', 'topicGroups',
      'findDateMentions',
      'analyzeText',
      'classifyQuestion', 'buildFtsQuery', 'scorePassage',
      'parseSrt', 'parseVtt', 'parseTxt', 'detectFormat', 'formatTimestamp', 'toSrtTime', 'toVttTime',
      'proseMirrorToMarkdown', 'proseMirrorToText', 'renderNoteMarkdown', 'renderNoteText', 'renderTranscript'
    ]) expect(typeof (text as Record<string, unknown>)[name], name).not.toBe('undefined')
  })
})
