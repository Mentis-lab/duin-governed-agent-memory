import { describe, it, expect } from 'vitest'
import { hasInlineDecision, type OwedRow } from './needs-you-decision'

// The rule that decides whether an owed row is a dead end. Node-only, per the panel-test
// convention: the pure helper is tested, the render reads the same answer.

const row = (over: Partial<OwedRow> = {}): OwedRow => ({
  kind: 'approval',
  hasStagedRsi: false,
  awaitingCount: 0,
  ...over
})

describe('hasInlineDecision', () => {
  it('a staged self-tune and a staged loop iteration decide in place', () => {
    expect(hasInlineDecision(row({ actionId: 'rsi:1', hasStagedRsi: true }))).toBe(true)
    expect(hasInlineDecision(row({ kind: 'loop', actionId: 'loop:7' }))).toBe(true)
  })

  it('a loop row with nothing to act on does not', () => {
    expect(hasInlineDecision(row({ kind: 'loop' }))).toBe(false)
  })

  it('the keyless-review card decides in place only while beliefs sit behind it', () => {
    const card = { actionId: 'govern:keyless-review' as const }
    expect(hasInlineDecision(row({ ...card, awaitingCount: 1 }))).toBe(true)
    // The exact shape of the 2026-09-01 stranded card: the queue drained, so its Ratify and
    // Veto buttons do not render, and without a Dismiss the row could never be closed.
    expect(hasInlineDecision(row({ ...card, awaitingCount: 0 }))).toBe(false)
  })

  it('an ordinary approval carries no decision of its own', () => {
    expect(hasInlineDecision(row({ actionId: 'exec:pair:abc' }))).toBe(false)
    expect(hasInlineDecision(row())).toBe(false)
  })
})
