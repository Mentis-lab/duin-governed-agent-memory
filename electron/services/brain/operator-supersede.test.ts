import { describe, it, expect } from 'vitest'
import {
  hasChangeSignal,
  contentTokens,
  referentOverlap,
  candidateSupersedeTargets,
  autoSupersede,
  type ActiveFactRef
} from './operator-supersede'

describe('hasChangeSignal', () => {
  it('fires on explicit temporal-change markers', () => {
    for (const t of [
      'Operator no longer uses VSCode',
      'Switched to Neovim',
      'Now works on the Beilan launch',
      'Corrected: the deadline is Dec 15',
      'Moved to Shenzhen',
      'Actually prefers dark mode instead of light'
    ]) {
      expect(hasChangeSignal(t)).toBe(true)
    }
  })
  it('does NOT fire on additive/stable facts', () => {
    for (const t of ['Prefers concise answers', 'Works in game publishing', 'Cares about calibration', '']) {
      expect(hasChangeSignal(t)).toBe(false)
    }
  })
})

describe('contentTokens + referentOverlap', () => {
  it('drops stopwords and change verbs, keeping subject tokens', () => {
    const toks = contentTokens('Operator switched to Neovim editor')
    expect(toks.has('neovim')).toBe(true)
    expect(toks.has('editor')).toBe(true)
    expect(toks.has('switched')).toBe(false) // change verb excluded
    expect(toks.has('operator')).toBe(false) // stopword
  })
  it('overlap counts shared subject tokens', () => {
    expect(referentOverlap('editor is VSCode', 'editor switched to Neovim')).toBeGreaterThanOrEqual(1)
    expect(referentOverlap('lives in Shenzhen', 'prefers dark mode')).toBe(0)
  })
})

describe('candidateSupersedeTargets', () => {
  const active: ActiveFactRef[] = [
    { id: 'a', fact: 'Primary editor is VSCode' },
    { id: 'b', fact: 'Lives in Beijing' },
    { id: 'c', fact: 'Prefers concise answers' }
  ]
  it('returns same-subject candidates above the overlap floor, strongest first', () => {
    const out = candidateSupersedeTargets('Primary editor is now Neovim, no longer VSCode', active, 1)
    expect(out.map((c) => c.id)).toContain('a')
    expect(out.map((c) => c.id)).not.toContain('c')
  })
  it('excludes an exact restatement (dedup, not contradiction)', () => {
    const out = candidateSupersedeTargets('Lives in Beijing', active, 1)
    expect(out.map((c) => c.id)).not.toContain('b')
  })
  it('returns nothing when overlap is below the floor', () => {
    expect(candidateSupersedeTargets('Enjoys hiking on weekends', active, 2)).toEqual([])
  })
})

describe('autoSupersede — gated orchestration', () => {
  const active: ActiveFactRef[] = [
    { id: 'a', fact: 'Primary editor is VSCode' },
    { id: 'b', fact: 'Lives in Beijing' }
  ]

  it('skips facts with no overlapping candidate (deterministic floor, not marker)', async () => {
    let judgeCalls = 0
    const r = await autoSupersede({
      newFacts: ['Enjoys hiking on weekends', 'Drinks oolong tea'],
      activeFacts: active, // editor/Beijing — no subject overlap
      judge: async () => (judgeCalls++, 'a'),
      apply: () => true,
      minOverlap: 2
    })
    expect(r.superseded).toBe(0)
    expect(judgeCalls).toBe(0) // judge never consulted — no same-subject candidate
  })

  it('fires on a SILENTLY-stated contradiction (no change-marker word)', async () => {
    // "Primary editor is Neovim" replaces "Primary editor is VSCode" with NO
    // change word — the previously-missing case. Overlap floor + judge catch it.
    const applied: string[] = []
    const r = await autoSupersede({
      newFacts: ['Primary editor is Neovim'],
      activeFacts: active,
      judge: async (_t, cands) => cands[0].id, // judge confirms same-subject replacement
      apply: (oldId) => (applied.push(oldId), true),
      minOverlap: 1
    })
    expect(r.superseded).toBe(1)
    expect(applied).toEqual(['a'])
  })

  it('bounds judge calls with maxJudgeCalls', async () => {
    let judgeCalls = 0
    await autoSupersede({
      newFacts: ['Primary editor is Neovim', 'Primary editor is Emacs', 'Primary editor is Nano'],
      activeFacts: [{ id: 'a', fact: 'Primary editor is VSCode' }],
      judge: async () => {
        judgeCalls++
        return null // never actually retire, just count calls
      },
      apply: () => true,
      minOverlap: 1,
      maxJudgeCalls: 2
    })
    expect(judgeCalls).toBeLessThanOrEqual(2)
  })

  it('supersedes when all three gates pass', async () => {
    const applied: Array<{ oldId: string; newText: string }> = []
    const r = await autoSupersede({
      newFacts: ['Primary editor is now Neovim, no longer VSCode'],
      activeFacts: active,
      judge: async (_t, cands) => cands[0].id, // judge picks strongest candidate (a)
      apply: (oldId, newText) => (applied.push({ oldId, newText }), true),
      minOverlap: 1
    })
    expect(r.superseded).toBe(1)
    expect(applied[0].oldId).toBe('a')
  })

  it('ignores a judge that picks an id NOT in the offered candidates (anti-hallucination)', async () => {
    let applied = 0
    const r = await autoSupersede({
      newFacts: ['Editor changed, no longer the old one'],
      activeFacts: active,
      judge: async () => 'zzz-not-offered',
      apply: () => (applied++, true),
      minOverlap: 1
    })
    expect(r.superseded).toBe(0)
    expect(applied).toBe(0)
  })

  it('a null judge verdict is a no-op', async () => {
    const r = await autoSupersede({
      newFacts: ['Editor switched but unclear to what'],
      activeFacts: active,
      judge: async () => null,
      apply: () => true,
      minOverlap: 1
    })
    expect(r.superseded).toBe(0)
  })

  it('a throwing judge skips that fact without crashing', async () => {
    const r = await autoSupersede({
      newFacts: ['Primary editor changed to Neovim'],
      activeFacts: active,
      judge: async () => {
        throw new Error('LLM down')
      },
      apply: () => true,
      minOverlap: 1
    })
    expect(r.superseded).toBe(0)
  })

  it('does not retire the same old fact twice across two new facts', async () => {
    const applyCalls: string[] = []
    const r = await autoSupersede({
      newFacts: ['Primary editor is now Neovim', 'Editor changed to Neovim again'],
      activeFacts: active,
      judge: async (_t, cands) => cands[0]?.id ?? null,
      apply: (oldId) => (applyCalls.push(oldId), true),
      minOverlap: 1
    })
    // 'a' can be retired only once; the second new fact finds it already retired.
    expect(applyCalls.filter((id) => id === 'a').length).toBe(1)
    expect(r.superseded).toBe(1)
  })
})
