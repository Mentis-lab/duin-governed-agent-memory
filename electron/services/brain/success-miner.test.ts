import { describe, it, expect, beforeEach } from 'vitest'
import {
  isEndorsement,
  captureSuccessFromTurn,
  recordSuccess,
  getSuccesses,
  __resetSuccessStore,
  type TurnMessage
} from './success-miner'

beforeEach(() => __resetSuccessStore())

describe('isEndorsement', () => {
  it('accepts short affirmations (EN + CJK)', () => {
    expect(isEndorsement('perfect')).toBe(true)
    expect(isEndorsement('yes exactly, ship it')).toBe(true)
    expect(isEndorsement('很好，完美')).toBe(true)
    expect(isEndorsement('👍')).toBe(true)
  })
  it('rejects corrections dressed as agreement', () => {
    expect(isEndorsement('yes but change the header')).toBe(false)
    expect(isEndorsement('对，不过这里不对')).toBe(false)
    expect(isEndorsement('not quite')).toBe(false)
  })
  it('rejects long turns (a new request, not a yes) and empties', () => {
    expect(isEndorsement('x'.repeat(200))).toBe(false)
    expect(isEndorsement('')).toBe(false)
  })
})

describe('captureSuccessFromTurn', () => {
  const history: TurnMessage[] = [
    { role: 'user', content: 'summarize the deploy plan' },
    { role: 'assistant', content: 'Here is the deploy plan: build, mirror, launch.' }
  ]

  it('captures (prior query, prior answer) on an endorsement', () => {
    const t = captureSuccessFromTurn('perfect, exactly right', history)
    expect(t).not.toBeNull()
    expect(t!.query).toBe('summarize the deploy plan')
    expect(t!.answer).toContain('deploy plan')
    expect(getSuccesses()).toHaveLength(1)
  })

  it('captures nothing when the turn is not an endorsement', () => {
    expect(captureSuccessFromTurn('now do the rollback plan', history)).toBeNull()
    expect(getSuccesses()).toHaveLength(0)
  })

  it('is reaction-grounded — a bare endorsement with no prior answer is dropped', () => {
    expect(captureSuccessFromTurn('yes!', [{ role: 'user', content: 'hi' }])).toBeNull()
    expect(getSuccesses()).toHaveLength(0)
  })
})

describe('recordSuccess', () => {
  it('snippets long answers and stores a trace', () => {
    const t = recordSuccess('q', 'a'.repeat(5000))
    expect(t.answer.length).toBeLessThanOrEqual(600)
    expect(getSuccesses()[0].id).toBe(t.id)
  })
})
