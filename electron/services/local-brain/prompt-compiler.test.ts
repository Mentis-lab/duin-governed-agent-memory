import { describe, it, expect } from 'vitest'
import { compilePrompt, DEFAULT_CONTEXT_BUDGET_TOKENS, type ContextUnit } from './prompt-compiler'
import type { EmbedFn } from '../brain/claim-entities'

// Deterministic fake embedder: known texts get fixed vectors; unknown texts get their own orthogonal
// axis (cosine 0 to everything known). Mirrors output-bound.test.ts's fake.
function fakeEmbed(table: Record<string, number[]>): EmbedFn {
  let axis = 100
  return async (texts: string[]) =>
    texts.map((t) => {
      if (table[t]) return table[t]
      const v = new Array(300).fill(0)
      v[axis++] = 1
      return v
    })
}

const warmEmbed: EmbedFn = fakeEmbed({}) // every text orthogonal, but always returns real vectors
const coldEmbed: EmbedFn = async () => [] // never returns vectors → fail-open trigger

/** The legacy concat the compiler must reproduce byte-for-byte when nothing is dropped/compressed. */
function legacyJoin(units: ContextUnit[]): string {
  return units.filter((u) => u.text).map((u) => u.text).join('\n\n')
}

const query = 'wafer calibration status'

// A representative units array: some blocks present, some absent (empty text).
const units: ContextUnit[] = [
  { kind: 'preamble', tier: 'floor', text: 'You are DUIN. Preamble identity block.' },
  { kind: 'brainGrounding', tier: 'floor', text: 'BRAIN: who the operator is.' },
  { kind: 'aboutOperator', tier: 'drop', text: '' }, // ABSENT
  { kind: 'recall', tier: 'drop', text: 'RECALL: relevant past items.' },
  { kind: 'taste', tier: 'drop', text: '' }, // ABSENT
  { kind: 'skill', tier: 'drop', text: 'SKILL: a proven procedure.' },
  { kind: 'pinnedNote', tier: 'floor', text: 'PINNED NOTE — the authoritative subject.' },
  { kind: 'context', tier: 'compress', text: 'CONTEXT (retrieved for: q):\nnote body here.' }
]

describe('compilePrompt — byte parity (nothing dropped/compressed)', () => {
  it('budget 0 → plain in-order join, byte-identical to the legacy concat', async () => {
    const out = await compilePrompt(units, query, 0, warmEmbed)
    expect(out).toBe(legacyJoin(units))
  })

  it('huge budget → identical join (absent blocks filtered, order preserved)', async () => {
    const out = await compilePrompt(units, query, 1_000_000, warmEmbed)
    expect(out).toBe(legacyJoin(units))
    // Sanity: absent (empty) blocks contribute nothing, separators are exactly '\n\n'.
    expect(out).not.toContain('\n\n\n')
    expect(out.startsWith('You are DUIN. Preamble identity block.')).toBe(true)
  })

  it('cold embedder but under budget → still the byte-identical join (never embeds)', async () => {
    const out = await compilePrompt(units, query, 1_000_000, coldEmbed)
    expect(out).toBe(legacyJoin(units))
  })
})

describe('compilePrompt — over-budget DROP', () => {
  it('drops the least-relevant drop unit; floor units + the relevant unit survive, order preserved', async () => {
    const relevant = 'RECALL: wafer calibration was completed last week.'
    const irrelevant = 'SKILL: how to file an expense report.'
    // One-hot embedder: query and the relevant unit share an axis (cosine 1); the irrelevant unit is
    // orthogonal (cosine 0) → it is the drop target.
    const embed = fakeEmbed({
      [query]: [1, 0, 0],
      [relevant]: [1, 0, 0],
      [irrelevant]: [0, 1, 0]
    })
    const floorA = 'FLOOR-A '.repeat(20)
    const floorB = 'FLOOR-B '.repeat(20)
    const over: ContextUnit[] = [
      { kind: 'preamble', tier: 'floor', text: floorA },
      { kind: 'recall', tier: 'drop', text: relevant },
      { kind: 'skill', tier: 'drop', text: irrelevant },
      { kind: 'pinnedNote', tier: 'floor', text: floorB }
    ]
    // Budget large enough for floors + the relevant unit, but not all four.
    const floorTokens = Math.ceil((floorA.length + floorB.length + relevant.length + 8) / 4)
    const out = await compilePrompt(over, query, floorTokens, embed)
    expect(out).toContain(floorA.trim())
    expect(out).toContain(floorB.trim())
    expect(out).toContain('wafer calibration')
    expect(out).not.toContain('expense report')
    // Order preserved: floorA before recall before pinned floorB.
    expect(out.indexOf(floorA.trim())).toBeLessThan(out.indexOf('wafer calibration'))
    expect(out.indexOf('wafer calibration')).toBeLessThan(out.indexOf(floorB.trim()))
  })
})

describe('compilePrompt — COMPRESS', () => {
  it('shrinks a huge compress (CONTEXT) unit via boundToBudget under budget', async () => {
    const q = 'wafer calibration query'
    const relevantPara = 'the wafer calibration data is right here in this paragraph'
    const fillerPara = 'entirely unrelated filler about the office coffee machine and deploys'
    const embed = fakeEmbed({
      [q]: [1, 0, 0],
      [relevantPara]: [0.99, 0.14, 0],
      [fillerPara]: [0, 1, 0]
    })
    // Build a big CONTEXT block: many filler paragraphs + the one relevant paragraph.
    const contextText =
      'CONTEXT (retrieved for: q):\n' +
      [fillerPara, fillerPara, fillerPara, relevantPara, fillerPara, fillerPara].join('\n\n')
    const floor = 'PREAMBLE identity.'
    const over: ContextUnit[] = [
      { kind: 'preamble', tier: 'floor', text: floor },
      { kind: 'context', tier: 'compress', text: contextText }
    ]
    const budgetTokens = Math.ceil((floor.length + relevantPara.length + 40) / 4)
    const out = await compilePrompt(over, q, budgetTokens, embed)
    expect(out).toContain(floor) // floor untouched
    expect(out.length).toBeLessThan(legacyJoin(over).length) // actually shrank
    expect(out).toContain('wafer calibration data') // relevance-kept chunk survived
  })
})

describe('compilePrompt — DROP-FIRST preserves CONTEXT (phase ordering)', () => {
  it('drops low-value drop blocks before compressing CONTEXT; when dropping alone fits, CONTEXT is kept FULL', async () => {
    const q = 'wafer calibration status'
    const irrelevant = 'SKILL: how to file an expense report, entirely unrelated to the query.'
    const fullContext = 'CONTEXT (retrieved for: q):\nThe complete wafer calibration report body that must survive intact.'
    const embed = fakeEmbed({
      [q]: [1, 0, 0],
      [irrelevant]: [0, 1, 0] // orthogonal → the drop target
    })
    const floor = 'PREAMBLE identity block.'
    const over: ContextUnit[] = [
      { kind: 'preamble', tier: 'floor', text: floor },
      { kind: 'skill', tier: 'drop', text: irrelevant },
      { kind: 'context', tier: 'compress', text: fullContext }
    ]
    // Budget fits floor + full CONTEXT (+ separator), but NOT once the irrelevant drop block is added.
    const budgetTokens = Math.ceil((floor.length + fullContext.length + 8) / 4)
    const out = await compilePrompt(over, q, budgetTokens, embed)
    // The drop block is gone…
    expect(out).not.toContain('expense report')
    // …and because dropping alone fit, CONTEXT was NOT compressed — its full body survives verbatim.
    expect(out).toContain('The complete wafer calibration report body that must survive intact.')
    expect(out).toContain(floor)
  })
})

describe('compilePrompt — FAIL-OPEN', () => {
  it('cold embedder over budget → plain in-order join (never worse than today)', async () => {
    const big = 'x'.repeat(4000)
    const over: ContextUnit[] = [
      { kind: 'preamble', tier: 'floor', text: 'PREAMBLE.' },
      { kind: 'recall', tier: 'drop', text: 'RECALL block.' },
      { kind: 'context', tier: 'compress', text: `CONTEXT (retrieved for: q):\n${big}` }
    ]
    const out = await compilePrompt(over, query, 10 /* tiny */, coldEmbed)
    expect(out).toBe(legacyJoin(over))
  })

  it('DEFAULT_CONTEXT_BUDGET_TOKENS is a sane positive constant', () => {
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS).toBeGreaterThan(0)
  })
})

// ── backlog finding 35 ──────────────────────────────────────────────────────

describe('compilePrompt — fails open when the floor blocks alone blow the budget', () => {
  it('keeps CONTEXT rather than deleting it when no per-unit budget is left', async () => {
    // perUnit was clamped with Math.max(0, ...) and boundToBudget(text, query, 0) keeps
    // nothing — so once the FIXED (floor) blocks alone exceeded the budget, the entire
    // retrieved CONTEXT was silently deleted. That never rescued the budget: the floor
    // blocks are what blew it and they are not compressible. It only removed grounding.
    const q = 'anything'
    const floorText = 'FLOOR-IDENTITY. ' + 'F'.repeat(4000)
    const contextText = 'CONTEXT-BODY ' + 'c'.repeat(400)
    const units: ContextUnit[] = [
      { kind: 'preamble', tier: 'floor', text: floorText },
      { kind: 'context', tier: 'compress', text: contextText }
    ]
    // A budget the FLOOR alone already exceeds, so perUnit goes negative.
    const budgetTokens = Math.ceil(floorText.length / 4) - 100
    const out = await compilePrompt(units, q, budgetTokens, fakeEmbed({}))

    expect(out).toContain('FLOOR-IDENTITY') // floor is never touched
    expect(out).toContain('CONTEXT-BODY') // ...and the context survived with it
  })
})
