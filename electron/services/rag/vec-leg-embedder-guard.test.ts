import { describe, it, expect } from 'vitest'
import { vectorLegEmbedderMatch } from './vec-leg-embedder-guard'

// Guard for the silent same-width embedder-swap corruption: the RAG vector leg
// runs one KNN across the shared rag_chunk_vec index, so a query embedded with a
// DIFFERENT embedder than a collection's stored vectors compares two unrelated
// 384-dim spaces and returns confidently mis-ranked hits. Before this guard the
// vector leg ran unconditionally; these cases pin the fail-safe (skip → lexical
// only) behaviour that replaces it.

describe('vectorLegEmbedderMatch', () => {
  it('is inert when no query embedder id is supplied (legacy path runs the leg)', () => {
    // Back-compat: callers that never pass queryEmbedderId keep today's behaviour.
    expect(vectorLegEmbedderMatch(undefined, ['bge-small-en-v1.5']).safe).toBe(true)
  })

  it('runs the leg when the query embedder matches the collection embedder', () => {
    expect(
      vectorLegEmbedderMatch('multilingual-e5-small', ['multilingual-e5-small']).safe
    ).toBe(true)
  })

  it('SKIPS the leg on a same-width swap (bge-small index queried with e5)', () => {
    // The exact shipped-default-flip scenario: both are 384-dim, so the width
    // guard (assertEmbedderFitsRagVec) passes — only the id comparison catches it.
    const check = vectorLegEmbedderMatch('multilingual-e5-small', ['bge-small-en-v1.5'])
    expect(check.safe).toBe(false)
    expect(check.mismatched).toEqual(['bge-small-en-v1.5'])
    expect(check.reason).toMatch(/different embedding space/)
  })

  it('SKIPS the leg when any queried collection differs (multi-collection query)', () => {
    const check = vectorLegEmbedderMatch('multilingual-e5-small', [
      'multilingual-e5-small',
      'bge-small-en-v1.5'
    ])
    expect(check.safe).toBe(false)
    expect(check.mismatched).toEqual(['bge-small-en-v1.5'])
  })

  it('fails OPEN on missing/empty collection embedder ids (never skip on absent data)', () => {
    expect(vectorLegEmbedderMatch('multilingual-e5-small', []).safe).toBe(true)
    expect(vectorLegEmbedderMatch('multilingual-e5-small', ['']).safe).toBe(true)
  })

  it('dedupes the mismatched-id evidence', () => {
    const check = vectorLegEmbedderMatch('e5', ['bge', 'bge', 'e5'])
    expect(check.safe).toBe(false)
    expect(check.mismatched).toEqual(['bge'])
  })
})
