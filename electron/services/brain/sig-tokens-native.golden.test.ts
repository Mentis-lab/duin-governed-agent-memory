// GOLDEN lock for the _sig_tokens port. Any drift (missing CJK bigrams, wrong
// stopword set, overlapping vs maximal alnum runs) silently reorders convergence
// rankings. Expected sets hand-derived from the Python regex + _STOP_TOK.
import { describe, it, expect } from 'vitest'
import { sigTokens } from './sig-tokens-native'

const arr = (s: string): string[] => [...sigTokens(s)].sort()

describe('sig-tokens-native — golden (_sig_tokens parity)', () => {
  it('takes maximal >=4 alnum runs, lowercased; drops <4', () => {
    // "on" (2) dropped; the rest are all STOPWORDS → empty set
    expect(arr('Biweekly report on Project delivery risk')).toEqual([])
    // maximal run: the whole 8-char token, not overlapping 4-grams
    expect(arr('abcdefgh')).toEqual(['abcdefgh'])
    expect(arr('abc 12 xy')).toEqual([]) // nothing >=4
  })

  it('decomposes CJK runs (>=2) into overlapping bigrams; unions with alnum', () => {
    expect(arr('工美周边 sync 2026')).toEqual(['2026', '周边', '工美', '美周', 'sync'].sort())
    expect(arr('工')).toEqual([]) // single ideograph → no bigram
    // overlap semantics: 工美周边 and 工美 share the 工美 bigram
    expect(sigTokens('工美周边').has('工美')).toBe(true)
    expect(sigTokens('工美').has('工美')).toBe(true)
  })

  it('removes stopwords after tokenizing (not before)', () => {
    // "roadmap" survives; "project"/"risk" are stopwords
    expect(arr('roadmap project risk')).toEqual(['roadmap'])
  })

  it('handles empty / falsy input', () => {
    expect(arr('')).toEqual([])
    expect(arr(undefined as unknown as string)).toEqual([])
  })
})
