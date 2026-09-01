import { describe, it, expect, afterEach } from 'vitest'
import { cosine, clusterAliases, annotateEntityKeys, blockKeyOf, planEntityBlocks } from './claim-entities'
import { classifyMutability, runVerdicts, entityKeyOf, type Claim, type WorldState } from './claim-metabolism'

const DAY = 86_400_000
const NOW = 1000 * DAY

// Hand-built 2-D unit vectors: aliases point the same way, distinct entities are orthogonal.
const V: Record<string, number[]> = {
  moon1: [1, 0],       // 北澜
  moon2: [0.99, 0.14], // 《北澜》 — ~8° off moon1 (cos ≈ 0.99)
  atlas: [0, 1]        // Project Atlas — orthogonal
}

describe('claim-entities — cosine + clusterAliases', () => {
  it('cosine is 1 for identical, ~0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 5)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 5)
  })
  it('clusters alias vectors to ONE canonical (the longest label), leaves distinct entities apart', () => {
    const labels = ['北澜', '《北澜》', 'Project Atlas']
    const map = clusterAliases(labels, [V.moon1, V.moon2, V.atlas], 0.86)
    expect(map.get('北澜')).toBe(map.get('《北澜》')) // coalesced
    expect(map.get('北澜')).toBe('《北澜》') // canonical = longest form
    expect(map.get('Project Atlas')).toBe('Project Atlas') // distinct entity untouched
  })
  it('a label with no vector stays its own entity (embedder-unavailable safety)', () => {
    const map = clusterAliases(['a', 'b'], [[], []], 0.86)
    expect(map.get('a')).toBe('a')
    expect(map.get('b')).toBe('b')
  })
})

describe('claim-entities — annotateEntityKeys (injected embedder)', () => {
  const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => (t.includes('北澜') ? V.moon1 : t.includes('Atlas') ? V.atlas : [0.5, 0.5]))
  const ENV = 'DUIN_CLAIM_ENTITY_RESOLVE'
  afterEach(() => delete process.env[ENV])

  function claim(id: string, subject: string): Claim {
    return {
      id, chunkId: id, notePath: `${id}.md`, subject, relation: 'status', object: 'x',
      validFrom: NOW, validTo: null, observedAt: NOW, supersededBy: null,
      mutability: classifyMutability('status'), justifications: [], verdict: 'current', verdictBy: null
    }
  }

  it('stamps a shared entityKey on alias subjects', async () => {
    const claims = [claim('a', '北澜'), claim('b', '《北澜》 update')]
    await annotateEntityKeys(claims, async () => [V.moon1, V.moon2])
    expect(claims[0].entityKey).toBe(claims[1].entityKey) // same entity
  })

  it('DUIN_CLAIM_ENTITY_RESOLVE=0 disables (no entityKey stamped)', async () => {
    process.env[ENV] = '0'
    const claims = [claim('a', '北澜'), claim('b', '《北澜》')]
    await annotateEntityKeys(claims, async () => [V.moon1, V.moon2])
    expect(claims[0].entityKey).toBeUndefined()
  })

  it('embedder mismatch/failure → no entityKey (exact-string fallback)', async () => {
    const claims = [claim('a', 'x'), claim('b', 'y')]
    await annotateEntityKeys(claims, async () => []) // empty → mismatch
    expect(claims[0].entityKey).toBeUndefined()
    await annotateEntityKeys(claims, async () => { throw new Error('no embedder') })
    expect(claims[0].entityKey).toBeUndefined()
  })
})

describe('claim-entities — incremental blocked resolution (P7: scales past the old 400 cap)', () => {
  const claim = (id: string, subject: string): Claim => ({
    id, chunkId: id, notePath: `${id}.md`, subject, relation: 'status', object: 'x',
    validFrom: NOW, validTo: null, observedAt: NOW, supersededBy: null,
    mutability: classifyMutability('status'), justifications: [], verdict: 'current', verdictBy: null
  })

  it('blockKeyOf collides aliases (punctuation/space/casing) and separates distinct entities', () => {
    expect(blockKeyOf('北澜')).toBe(blockKeyOf('《北澜》')) // punctuation stripped → same block
    expect(blockKeyOf('Theo')).toBe(blockKeyOf('Theo Q')) // suffix/space → same block
    expect(blockKeyOf('ATLAS')).toBe(blockKeyOf('atlas')) // case-insensitive
    expect(blockKeyOf('Atlas')).not.toBe(blockKeyOf('Project')) // distinct first-2-chars → distinct block
  })

  it('planEntityBlocks embeds ONLY alias candidates — singletons are excluded (bounded, not O(n²))', () => {
    const { toEmbed, blocks } = planEntityBlocks(['北澜', '《北澜》', 'alpha-thing', 'beta-thing'])
    // alpha/beta are alone in their blocks → never embedded; only the 北澜 pair is a candidate
    expect([...toEmbed].sort()).toEqual(['《北澜》', '北澜'].sort())
    expect(blocks).toHaveLength(1)
    expect([...blocks[0]].sort()).toEqual(['《北澜》', '北澜'].sort())
  })

  it('stamps entityKeys on a >400-subject ledger via the blocked path, embedding only the few candidates', async () => {
    const A = 'abcdefghijklmnopqrstuvwxyz'
    const claims: Claim[] = []
    for (let i = 0; i < 500; i++) {
      const key = A[Math.floor(i / 26)] + A[i % 26] // 500 < 676 distinct 2-char prefixes → 500 singleton blocks
      claims.push(claim(`u${i}`, `${key}-subject-${i}`))
    }
    // one alias pair that SHOULD coalesce (both fall in block "北澜")
    claims.push(claim('m1', '北澜'))
    claims.push(claim('m2', '《北澜》'))

    let embeddedCount = 0
    const spyEmbed = async (texts: string[]): Promise<number[][]> => {
      embeddedCount += texts.length
      return texts.map((t) => (t.includes('北澜') ? (t.startsWith('《') ? [0.99, 0.14] : [1, 0]) : [0.5, 0.5]))
    }
    await annotateEntityKeys(claims, spyEmbed)

    // BOUNDED: only the 2 alias candidates were embedded — NOT all 502 (the old cap would have bailed
    // at >400; a naive pass would embed+compare all 502). This asserts the perf approach is bounded.
    expect(embeddedCount).toBeLessThanOrEqual(4)
    // cross-alias claims coalesced to ONE entityKey (the supersession-linking win)
    const m1 = claims.find((c) => c.id === 'm1')!
    const m2 = claims.find((c) => c.id === 'm2')!
    expect(m1.entityKey).toBeDefined()
    expect(m1.entityKey).toBe(m2.entityKey)
    expect(m1.entityKeyConfidence).toBeGreaterThan(0.86) // strong membership recorded
    // a unique subject got NO entityKey (exact-string fallback), proving singletons skip embedding
    expect(claims.find((c) => c.id === 'u0')!.entityKey).toBeUndefined()
  })

  it('embedder throw on a real block → exact-string fallback (no entityKey), never hangs', async () => {
    const claims = [claim('a', '北澜'), claim('b', '《北澜》')] // same block → embed IS attempted
    await annotateEntityKeys(claims, async () => { throw new Error('embedder down') })
    expect(claims[0].entityKey).toBeUndefined()
    expect(claims[1].entityKey).toBeUndefined()
  })
})

describe('claim-entities — resolution coalesces supersession across aliases', () => {
  const emptyWorld = (): WorldState => ({ pastAnchors: new Set(), resolvedDecisions: new Set(), passedStreams: new Set() })
  function claim(p: Partial<Claim> & Pick<Claim, 'id' | 'subject' | 'relation' | 'object'>): Claim {
    return {
      chunkId: `c-${p.id}`, notePath: `${p.id}.md`, validFrom: NOW, validTo: null, observedAt: NOW,
      supersededBy: null, mutability: classifyMutability(p.relation), justifications: [], verdict: 'current', verdictBy: null, ...p
    }
  }
  it('two DIFFERENT subject strings sharing an entityKey supersede — but only as a PROPOSAL (safety)', () => {
    // exact-string keys would NOT match "北澜" vs "《北澜》"; the resolved entityKey coalesces them,
    // but because the RAW subjects differ (an embedding over-merge could be wrong), the supersession
    // is a proposal (verdictBy 'model', un-applied before persist), not a durable retirement.
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, entityKey: 'moonlight' })
    const newer = claim({ id: 'n', subject: '《北澜》', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, entityKey: 'moonlight' })
    expect(entityKeyOf(older)).toBe('moonlight')
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdict).toBe('contradicted') // coalesced → superseded
    expect(older.supersededBy).toBe('n')
    expect(older.verdictBy).toBe('model') // ← PROPOSAL: a cross-alias retirement is never durable
  })
  it('WITHOUT a shared entityKey, the same two do NOT supersede (proves resolution is what links them)', () => {
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'n', subject: '《北澜》', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY })
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdict).toBe('current') // distinct string keys → no supersession
  })
})
