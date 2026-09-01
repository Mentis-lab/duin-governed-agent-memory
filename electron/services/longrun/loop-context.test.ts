import { describe, it, expect } from 'vitest'
import {
  buildBoundedContext,
  updateRollingSummary,
  DEFAULT_ROLLING_SUMMARY_MAX_CHARS,
  type ChatMessage
} from './loop-context'

// L3 — bounded per-iteration context. Pure; runs everywhere.

describe('buildBoundedContext', () => {
  it('happy path: composes plan(system) + summary(system) + artifact(user) in order', () => {
    const msgs = buildBoundedContext({
      plan: 'PLAN',
      rollingSummary: 'SUMMARY',
      artifactState: 'ARTIFACT',
      maxChars: 1000
    })
    expect(msgs).toEqual<ChatMessage[]>([
      { role: 'system', content: 'PLAN' },
      { role: 'system', content: 'SUMMARY' },
      { role: 'user', content: 'ARTIFACT' }
    ])
  })

  it('never exceeds maxChars (the context-blowup this invariant kills)', () => {
    const msgs = buildBoundedContext({
      plan: 'p'.repeat(500),
      rollingSummary: 's'.repeat(500),
      artifactState: 'a'.repeat(500),
      maxChars: 600
    })
    const total = msgs.reduce((n, m) => n + m.content.length, 0)
    expect(total).toBeLessThanOrEqual(600)
  })

  it('protects the plan first and trims artifactState first', () => {
    const msgs = buildBoundedContext({
      plan: 'p'.repeat(100),
      rollingSummary: 's'.repeat(100),
      artifactState: 'a'.repeat(100),
      maxChars: 100
    })
    // Whole budget goes to the plan; summary + artifact are dropped.
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({ role: 'system', content: 'p'.repeat(100) })
  })

  it('gives the remainder to the summary, then the artifact', () => {
    const msgs = buildBoundedContext({
      plan: 'p'.repeat(40),
      rollingSummary: 's'.repeat(40),
      artifactState: 'a'.repeat(40),
      maxChars: 100
    })
    expect(msgs[0].content).toBe('p'.repeat(40))
    expect(msgs[1].content).toBe('s'.repeat(40))
    // 100 - 40 - 40 = 20 chars left for the artifact. It is still bounded to exactly that —
    // the total-budget guarantee below depends on it — but a trimmed piece now SAYS it was
    // trimmed instead of ending silently mid-content, so the model reading this stack can
    // tell a complete artifact state from a cut one.
    expect(msgs[2].content).toHaveLength(20)
    expect(msgs[2].content.startsWith('a')).toBe(true)
    expect(msgs[2].content.endsWith('…')).toBe(true)
    expect(msgs.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(100)
  })

  it('drops empty pieces (no blank messages)', () => {
    const msgs = buildBoundedContext({
      plan: 'PLAN',
      rollingSummary: '',
      artifactState: '',
      maxChars: 1000
    })
    expect(msgs).toEqual([{ role: 'system', content: 'PLAN' }])
  })

  it('edge: maxChars 0 -> empty stack; negative treated as 0', () => {
    expect(buildBoundedContext({ plan: 'x', rollingSummary: 'y', artifactState: 'z', maxChars: 0 })).toEqual([])
    expect(
      buildBoundedContext({ plan: 'x', rollingSummary: 'y', artifactState: 'z', maxChars: -50 })
    ).toEqual([])
  })

  it('is deterministic', () => {
    const input = { plan: 'A', rollingSummary: 'B', artifactState: 'C', maxChars: 10 }
    expect(buildBoundedContext(input)).toEqual(buildBoundedContext(input))
  })
})

describe('updateRollingSummary', () => {
  it('appends a one-line [sha] task -> outcome fact', () => {
    const out = updateRollingSummary('', {
      itemTask: 'build header',
      outcome: 'done',
      gitSha: 'abcdef1234567',
      advanced: true
    })
    expect(out).toBe('[abcdef1] build header -> done')
  })

  it('appends onto prior lines newest-last', () => {
    const first = updateRollingSummary('', { itemTask: 't1', outcome: 'ok', gitSha: 'aaa', advanced: true })
    const second = updateRollingSummary(first, { itemTask: 't2', outcome: 'ok', gitSha: 'bbb', advanced: true })
    expect(second.split('\n')).toEqual(['[aaa] t1 -> ok', '[bbb] t2 -> ok'])
  })

  it('tags a non-advancing iteration so the L4 signal survives', () => {
    const out = updateRollingSummary('', { itemTask: 't', outcome: 'noop', gitSha: null, advanced: false })
    expect(out).toBe('[-] t -> noop [no-progress]')
  })

  it('evicts the oldest lines to stay within the cap (transcript growth killed)', () => {
    let s = ''
    for (let i = 0; i < 50; i++) {
      s = updateRollingSummary(s, { itemTask: `task${i}`, outcome: 'done', gitSha: `sha${i}`, advanced: true }, 60)
    }
    expect(s.length).toBeLessThanOrEqual(60)
    // Oldest evicted, newest retained.
    expect(s).not.toContain('task0 ')
    expect(s).toContain('task49')
  })

  it('hard-truncates a single line longer than the whole budget', () => {
    const out = updateRollingSummary('', { itemTask: 'x'.repeat(200), outcome: 'y', gitSha: 'z', advanced: true }, 30)
    expect(out.length).toBe(30)
  })

  it('uses the default cap when maxChars omitted', () => {
    const out = updateRollingSummary('', { itemTask: 't', outcome: 'o', advanced: true })
    expect(out.length).toBeLessThanOrEqual(DEFAULT_ROLLING_SUMMARY_MAX_CHARS)
  })

  it('short sha kept verbatim, long sha shortened to 7', () => {
    expect(updateRollingSummary('', { itemTask: 't', outcome: 'o', gitSha: 'ab', advanced: true })).toContain('[ab]')
    expect(
      updateRollingSummary('', { itemTask: 't', outcome: 'o', gitSha: '1234567890', advanced: true })
    ).toContain('[1234567]')
  })
})
