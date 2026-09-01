import { describe, expect, it } from 'vitest'

import { afterAll } from 'vitest'
import {
  EVIDENCE_CALIBRATED_EMBEDDER,
  EVIDENCE_FLOOR,
  assessEvidence,
  evidenceCaveat,
  evidenceGateEnabled
} from './evidence-gate'

// The polarity was untested, so flipping the default changed live answer
// behaviour without a single test failing. Pin it: a silent flip back to
// opt-in would make the gate dead code that still looks shipped.
describe('evidenceGateEnabled — ON by default (opt-OUT)', () => {
  const orig = process.env.DUIN_EVIDENCE_GATE
  afterAll(() => {
    if (orig === undefined) delete process.env.DUIN_EVIDENCE_GATE
    else process.env.DUIN_EVIDENCE_GATE = orig
  })

  it('is TRUE when the flag is unset — shipped work must not sit behind a default-off flag', () => {
    delete process.env.DUIN_EVIDENCE_GATE
    expect(evidenceGateEnabled()).toBe(true)
  })

  it('is false ONLY for an explicit "0" — the documented opt-out', () => {
    process.env.DUIN_EVIDENCE_GATE = '0'
    expect(evidenceGateEnabled()).toBe(false)
  })

  it('stays enabled for any other value, so a stray env cannot silently disable it', () => {
    for (const v of ['', '1', 'true', 'yes', 'off']) {
      process.env.DUIN_EVIDENCE_GATE = v
      expect(evidenceGateEnabled(), `value ${JSON.stringify(v)} must not disable`).toBe(true)
    }
  })
})

const E = EVIDENCE_CALIBRATED_EMBEDDER
const at = (...raw: (number | undefined)[]): { rawScore?: number }[] => raw.map((r) => ({ rawScore: r }))

describe('assessEvidence — abstention must be EARNED by low relevance', () => {
  it('confident retrieval is sufficient', () => {
    const a = assessEvidence({ hits: at(0.6, 0.5), embedderId: E })
    expect(a).toMatchObject({ sufficient: true, reason: 'ok', bestAbsolute: 0.6 })
    expect(evidenceCaveat(a)).toBe('')
  })

  it('thin retrieval is insufficient and carries the best score it saw', () => {
    const a = assessEvidence({ hits: at(0.42, 0.41), embedderId: E })
    expect(a).toMatchObject({ sufficient: false, reason: 'thin', bestAbsolute: 0.42 })
    expect(evidenceCaveat(a)).toContain("don't have this in your notes")
  })

  it('judges on the BEST hit, not the average — one strong hit is enough', () => {
    expect(assessEvidence({ hits: at(0.39, 0.39, 0.7), embedderId: E }).sufficient).toBe(true)
  })

  it('is exact at the boundary: strictly-below abstains, equal does not', () => {
    expect(assessEvidence({ hits: at(EVIDENCE_FLOOR - 1e-9), embedderId: E }).sufficient).toBe(false)
    expect(assessEvidence({ hits: at(EVIDENCE_FLOOR), embedderId: E }).sufficient).toBe(true)
  })

  it('empty retrieval abstains — nothing came back, so nothing supports an answer', () => {
    const a = assessEvidence({ hits: [], embedderId: E })
    expect(a).toMatchObject({ sufficient: false, reason: 'no-hits', bestAbsolute: null })
    expect(evidenceCaveat(a)).toContain('Retrieval returned nothing')
  })
})

describe('assessEvidence — fail-open on missing signal', () => {
  it('lexical-only hits (no rawScore) do NOT abstain', () => {
    // BM25 has no absolute scale, so lexical-only hits carry no rawScore. Reading that as "thin"
    // would abstain on exactly the CJK exact-term matches the lexical leg exists to catch.
    const a = assessEvidence({ hits: at(undefined, undefined), embedderId: E })
    expect(a).toMatchObject({ sufficient: true, reason: 'no-absolute-signal', bestAbsolute: null })
    expect(evidenceCaveat(a)).toBe('')
  })

  it('a non-finite rawScore is ignored rather than treated as zero', () => {
    expect(assessEvidence({ hits: at(NaN, 0.6), embedderId: E })).toMatchObject({
      sufficient: true,
      bestAbsolute: 0.6
    })
    // NaN alone ⇒ no usable signal ⇒ fail open, NOT abstain
    expect(assessEvidence({ hits: at(NaN), embedderId: E }).reason).toBe('no-absolute-signal')
  })
})

describe('assessEvidence — embedder guard stops a stale constant from acting', () => {
  it('goes inert on a different embedder', () => {
    for (const id of ['bge-m3', 'bge-small-en-v1.5']) {
      const a = assessEvidence({ hits: at(0.1), embedderId: id })
      expect(a).toMatchObject({ sufficient: true, reason: 'uncalibrated-embedder' })
      expect(evidenceCaveat(a)).toBe('')
    }
  })

  it('goes inert when the embedder is unknown', () => {
    expect(assessEvidence({ hits: at(0.1) }).reason).toBe('uncalibrated-embedder')
    expect(assessEvidence({ hits: at(0.1), embedderId: null }).reason).toBe('uncalibrated-embedder')
  })
})

describe('EVIDENCE_FLOOR — locks the measured calibration', () => {
  it('sits inside the observed e5 band, not on an intuitive 0-1 scale', () => {
    // Measured on the real index: off-corpus best-hit ~0.39-0.50, on-corpus ~0.44-0.74.
    // A threshold outside that band cannot separate them; 0.35 (uncertainty-gate's) fires on
    // NOTHING, which is the defect this constant exists to avoid repeating.
    expect(EVIDENCE_FLOOR).toBeGreaterThan(0.39)
    expect(EVIDENCE_FLOOR).toBeLessThan(0.50)
    expect(assessEvidence({ hits: at(0.35), embedderId: E }).sufficient).toBe(false)
  })

  it('admits every on-corpus minimum observed, and rejects the off-corpus median', () => {
    expect(assessEvidence({ hits: at(0.436), embedderId: E }).sufficient).toBe(true) // on-title min
    expect(assessEvidence({ hits: at(0.451), embedderId: E }).sufficient).toBe(true) // on-verbatim min
    expect(assessEvidence({ hits: at(0.430), embedderId: E }).sufficient).toBe(false) // off median
  })
})
