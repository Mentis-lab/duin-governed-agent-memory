import { describe, it, expect } from 'vitest'
import { bindCandidate, checkRecurrence, correctionFailsBindings, revertBinding, type BindingRow } from './binding-ledger'

const cand = { theme: ['over', 'produce', 'verbose'], count: 3, sample: 'too verbose again' }

describe('binding-ledger — bindCandidate', () => {
  it('mints a row with an open falsifiable prediction + deterministic id', () => {
    const a = bindCandidate(cand, 'Keep it terse.', 1000, 'seed-x')
    const b = bindCandidate(cand, 'Keep it terse.', 1000, 'seed-x')
    expect(a.id).toBe(b.id) // deterministic from the seed
    expect(a.prediction.status).toBe('open')
    expect(a.prediction.claim).toMatch(/not recur/)
    expect(a.reverted).toBeNull()
    expect(a.theme).toEqual(['over', 'produce', 'verbose'])
    expect(a.rule).toBe('Keep it terse.')
    expect(a.members).toBe(3)
  })
  it('id is stable from theme + now when no seed is given', () => {
    expect(bindCandidate(cand, 'r', 42).id).toBe(bindCandidate(cand, 'r', 42).id)
  })
})

describe('binding-ledger — checkRecurrence', () => {
  it('fails an open binding when a new correction overlaps the theme by >=2 tokens', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1)]
    const failed = checkRecurrence(rows, new Set(['over', 'verbose', 'unrelated']), 2000)
    expect(failed).toHaveLength(1)
    expect(rows[0].prediction.status).toBe('failed')
    expect(rows[0].prediction.failedAt).toBe(2000)
  })
  it('does NOT fail on a <2 token overlap', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1)]
    expect(checkRecurrence(rows, new Set(['over', 'x', 'y']), 2000)).toHaveLength(0)
    expect(rows[0].prediction.status).toBe('open')
  })
  it('ignores reverted + already-failed rows', () => {
    const r1 = bindCandidate(cand, 'r', 1, 'a')
    r1.reverted = 500
    const r2 = bindCandidate(cand, 'r', 1, 'b')
    r2.prediction.status = 'failed'
    expect(checkRecurrence([r1, r2], new Set(['over', 'produce', 'verbose']), 3000)).toHaveLength(0)
  })
})

describe('binding-ledger — revertBinding', () => {
  it('reverts a matching row + is idempotent-safe', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1, 'seed-r')]
    expect(revertBinding(rows, 'bind-seed-r', 1000)).toBe(true)
    expect(rows[0].reverted).toBe(1000)
    // second call on an already-reverted id: no-op, returns false, no throw, value unchanged
    expect(revertBinding(rows, 'bind-seed-r', 2000)).toBe(false)
    expect(rows[0].reverted).toBe(1000)
  })
  it('returns false for an unknown id', () => {
    expect(revertBinding([bindCandidate(cand, 'r', 1, 's')], 'nope', 1)).toBe(false)
  })
})

describe('binding-ledger — correctionFailsBindings', () => {
  const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter(Boolean))
  it('fails a binding when the correction row overlaps the theme by >=2 tokens (injected tokenizer)', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1)]
    const failed = correctionFailsBindings(rows, { why: 'too verbose', correction: 'over produce again' }, tokenize, 2000)
    expect(failed).toHaveLength(1)
    expect(rows[0].prediction.status).toBe('failed')
    expect(rows[0].prediction.failedAt).toBe(2000)
  })
  it('leaves bindings open when the correction does not overlap', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1)]
    expect(correctionFailsBindings(rows, { correction: 'something entirely different' }, tokenize, 2000)).toHaveLength(0)
    expect(rows[0].prediction.status).toBe('open')
  })
  it('pools why + correction + candidate_rule into the token set', () => {
    const rows: BindingRow[] = [bindCandidate(cand, 'r', 1)]
    // "over" from why + "verbose" from candidate_rule = 2 tokens across fields → fails
    expect(correctionFailsBindings(rows, { why: 'over', candidate_rule: 'verbose' }, tokenize, 2000)).toHaveLength(1)
  })
})
