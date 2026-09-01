import { describe, it, expect } from 'vitest'
import { buildDigest, type DigestInput } from './loop-digest'
import type { TokenUsage } from './run-journal'

const HOUR = 3_600_000

function input(over: Partial<DigestInput> = {}): DigestInput {
  return {
    loop: { id: 'loop-1', iteration: 5, startedAt: 1_000_000, maxIterations: null },
    backlogStats: { pending: 3, done: 7, error: 0, total: 10 },
    usage: null,
    costUsd: 0,
    nextItem: 'refactor the parser',
    buildStatus: 'green',
    ...over
  }
}

describe('buildDigest — happy path', () => {
  it('renders the canonical status line with all core segments', () => {
    const now = 1_000_000 + 2 * HOUR // 2 hours after start
    const line = buildDigest(input({ costUsd: 1.5 }), now)
    expect(line).toBe(
      'hour 2: 70% done (7/10), 7 files/items, build green, $1.50 spent, next: refactor the parser'
    )
  })

  it('appends a token segment when usage is present', () => {
    const usage: TokenUsage = { inputTokens: 1200, outputTokens: 800 }
    const line = buildDigest(input({ usage, costUsd: 0.25 }), 1_000_000 + HOUR)
    expect(line).toContain('2000 tok')
    expect(line).toContain('$0.25 spent')
  })

  it('surfaces an error count segment when there are errors', () => {
    const line = buildDigest(
      input({ backlogStats: { pending: 1, done: 4, error: 2, total: 7 } }),
      1_000_000
    )
    expect(line).toContain('2 err')
  })
})

describe('buildDigest — the failure the invariant kills (silent/opaque run)', () => {
  it('is PURE/deterministic: same input+now => identical string (no clock read)', () => {
    const i = input()
    const a = buildDigest(i, 1_000_000 + 5 * HOUR)
    const b = buildDigest(i, 1_000_000 + 5 * HOUR)
    expect(a).toBe(b)
    expect(a).toContain('hour 5')
  })

  it('always names the next item so an operator sees what is queued', () => {
    expect(buildDigest(input({ nextItem: 'deploy' }), 1_000_000)).toContain('next: deploy')
  })
})

describe('buildDigest — edge cases (empty, breach boundary, degenerate clock)', () => {
  it('empty backlog reads 0% done, never NaN', () => {
    const line = buildDigest(
      input({ backlogStats: { pending: 0, done: 0, error: 0, total: 0 } }),
      1_000_000
    )
    expect(line).toContain('0% done (0/0)')
    expect(line).not.toContain('NaN')
  })

  it('null startedAt => hour 0', () => {
    const line = buildDigest(
      input({ loop: { id: 'l', iteration: 0, startedAt: null, maxIterations: null } }),
      9_999_999
    )
    expect(line.startsWith('hour 0:')).toBe(true)
  })

  it('clock behind startedAt never yields a negative hour', () => {
    const line = buildDigest(input(), 500_000) // now < startedAt
    expect(line.startsWith('hour 0:')).toBe(true)
  })

  it('null nextItem => next: none', () => {
    expect(buildDigest(input({ nextItem: null }), 1_000_000)).toContain('next: none')
    expect(buildDigest(input({ nextItem: '   ' }), 1_000_000)).toContain('next: none')
  })

  it('caps percentage at 100 and floors at 0 for out-of-range counts', () => {
    const over = buildDigest(
      input({ backlogStats: { pending: 0, done: 15, error: 0, total: 10 } }),
      1_000_000
    )
    expect(over).toContain('100% done')
  })

  it('negative/NaN cost renders as $0.00', () => {
    expect(buildDigest(input({ costUsd: -5 }), 1_000_000)).toContain('$0.00 spent')
    expect(buildDigest(input({ costUsd: NaN }), 1_000_000)).toContain('$0.00 spent')
  })

  it('default now argument is call-compatible with the wired signature', () => {
    // integrator calls buildDigest(input) with no now — must not throw
    expect(() => buildDigest(input())).not.toThrow()
  })
})
