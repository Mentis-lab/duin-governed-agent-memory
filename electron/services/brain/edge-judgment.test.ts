import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildEdgeJudgment, applyEdgeJudgment, applyMergeJudgment, type EdgeJudgmentInput, type LearnCorrectionPayload } from './edge-judgment'
import { loadEdgeVerdicts, isEdgeVetoed } from './edge-verdicts'
import { readRevealOutcomes } from './reveal-outcomes'
import { loadAliasOverlay } from './operator-alias-overlay'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'edge-judgment-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const BASE: Omit<EdgeJudgmentInput, 'verdict'> = {
  from: 'person:jon-reyes',
  to: 'topic:usage-based-pricing',
  edgeType: 'contradicts',
  source: 'llm',
  confidence: 0.7,
  ts: '2026-07-18T00:00:00Z'
}

describe('buildEdgeJudgment (pure)', () => {
  it('endorse → endorsed verdict, materialized outcome, positive learn payload with the rule', () => {
    const eff = buildEdgeJudgment({ ...BASE, verdict: 'endorse', candidateRule: 'a pricing memo can contradict a vendor claim' })
    expect(eff.edgeVerdict.verdict).toBe('endorsed')
    expect(eff.revealOutcome.verdict).toBe('materialized')
    expect(eff.revealOutcome.kind).toBe('llm:contradicts')
    expect(eff.learn).toMatchObject({ polarity: 'positive', candidate_rule: 'a pricing memo can contradict a vendor claim', skill: 'live-node-reveal' })
  })

  it('veto → vetoed verdict, refuted outcome, correction learn payload naming the edge', () => {
    const eff = buildEdgeJudgment({ ...BASE, verdict: 'veto', why: 'they never mentioned it' })
    expect(eff.edgeVerdict.verdict).toBe('vetoed')
    expect(eff.revealOutcome.verdict).toBe('refuted')
    expect(eff.learn.polarity).toBe('correction')
    expect(eff.learn.correction).toContain('contradicts')
  })
})

describe('applyEdgeJudgment (fan-out)', () => {
  it('veto writes the edge-verdict (suppresses the edge) + a refuted calibration sample + posts the learn correction', () => {
    const vault = tmpVault()
    const posted: LearnCorrectionPayload[] = []
    applyEdgeJudgment(vault, { ...BASE, verdict: 'veto' }, { postLearn: (p) => posted.push(p) })

    expect(isEdgeVetoed(loadEdgeVerdicts(vault), BASE.from, BASE.to, BASE.edgeType)).toBe(true)
    const outcomes = readRevealOutcomes(vault)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ kind: 'llm:contradicts', verdict: 'refuted' })
    expect(posted).toHaveLength(1)
    expect(posted[0].polarity).toBe('correction')
  })

  it('endorse records an endorsed verdict + materialized sample', () => {
    const vault = tmpVault()
    applyEdgeJudgment(vault, { ...BASE, verdict: 'endorse', candidateRule: 'r' }, {})
    expect(isEdgeVetoed(loadEdgeVerdicts(vault), BASE.from, BASE.to, BASE.edgeType)).toBe(false)
    expect(readRevealOutcomes(vault)[0].verdict).toBe('materialized')
  })

  it('does not throw when no learn poster is injected', () => {
    const vault = tmpVault()
    expect(() => applyEdgeJudgment(vault, { ...BASE, verdict: 'veto' })).not.toThrow()
  })
})

describe('applyMergeJudgment', () => {
  it('confirm folds an operator alias into the overlay; reject undoes it', () => {
    const vault = tmpVault()
    applyMergeJudgment(vault, { label: 'usage based', canonicalId: 'topic:usage-based-pricing', verdict: 'confirm', ts: 't1' })
    expect(loadAliasOverlay(vault).get('usage based')).toBe('topic:usage-based-pricing')
    applyMergeJudgment(vault, { label: 'usage based', canonicalId: 'topic:usage-based-pricing', verdict: 'reject', ts: 't2' })
    expect(loadAliasOverlay(vault).has('usage based')).toBe(false)
  })
})
