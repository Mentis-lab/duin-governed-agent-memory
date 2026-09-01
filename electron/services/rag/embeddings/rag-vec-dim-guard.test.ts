import { describe, expect, it } from 'vitest'
import {
  RAG_VEC_DIMENSIONS,
  RagEmbedderDimensionError,
  assertEmbedderFitsRagVec
} from './rag-vec-dim-guard'
import { EMBEDDING_CATALOG } from './catalog'

// Pure guard — no db/electron, so these run unconditionally (never behind a
// HAS_NATIVE_SQLITE skip). They pin the exact regression: bge-m3 (1024-dim) was
// added to the catalogue AFTER the RAG vec table was frozen at FLOAT[384], and
// selecting it silently killed the vector leg.

describe('assertEmbedderFitsRagVec (RAG vec dimension guard)', () => {
  it('accepts every 384-dim catalogue embedder and returns its entry', () => {
    const fits = EMBEDDING_CATALOG.filter((e) => e.dimensions === RAG_VEC_DIMENSIONS)
    // Guard against the catalogue silently dropping all 384-dim entries.
    expect(fits.length).toBeGreaterThan(0)
    for (const e of fits) {
      expect(assertEmbedderFitsRagVec(e.id).id).toBe(e.id)
    }
  })

  it('rejects a wider embedder (bge-m3, 1024-dim) with a structured error', () => {
    const wide = EMBEDDING_CATALOG.find((e) => e.dimensions !== RAG_VEC_DIMENSIONS)
    // This test is only meaningful while the catalogue actually ships a
    // non-384 embedder — that mismatch IS the defect being guarded.
    expect(wide, 'expected a non-384 embedder in the catalogue').toBeTruthy()
    try {
      assertEmbedderFitsRagVec(wide!.id)
      throw new Error('expected assertEmbedderFitsRagVec to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(RagEmbedderDimensionError)
      const e = err as RagEmbedderDimensionError
      expect(e.embedderId).toBe(wide!.id)
      expect(e.embedderDimensions).toBe(wide!.dimensions)
      expect(e.vecDimensions).toBe(RAG_VEC_DIMENSIONS)
      expect(e.message).toContain(String(wide!.dimensions))
      expect(e.message).toContain(String(RAG_VEC_DIMENSIONS))
    }
  })

  it('rejects bge-m3 specifically (the frontier 1024-dim model)', () => {
    // Named explicitly so the test still fails loudly if bge-m3 stays 1024 but
    // the generic "find a non-384 model" heuristic above ever stops finding it.
    expect(() => assertEmbedderFitsRagVec('bge-m3')).toThrow(RagEmbedderDimensionError)
  })

  it('throws a plain Error (not the dimension error) for an unknown id', () => {
    expect(() => assertEmbedderFitsRagVec('not-a-real-embedder')).toThrow(/unknown embedder/i)
  })
})
