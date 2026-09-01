import { describe, it, expect, beforeEach } from 'vitest'
import {
  mayRunAutomaticWork,
  notePresence,
  isOperatorPresent,
  noteMaterialChange,
  hasMaterialChange,
  consumeMaterialChanges,
  __resetBackgroundGate
} from './background-work-gate'

// The operator rule this encodes (2026-08-25): automatic token-spending work runs only when the
// app is being USED and knowledge is actually being UPDATED. What it replaced: construction fired
// on any watched file change, including DUIN's own memory materialization inside the vault — a
// loop with no human in it that produced ~1,000-1,700 entity nodes a day on an idle machine and
// burned extraction quota on every pass.

const HOUR = 60 * 60_000
const t0 = Date.parse('2026-08-25T12:00:00.000Z')

beforeEach(() => __resetBackgroundGate())

describe('presence', () => {
  it('is false until a real interaction is recorded — a fresh process is not "in use"', () => {
    expect(isOperatorPresent(t0)).toBe(false)
    expect(mayRunAutomaticWork(t0)).toMatchObject({ ok: false, reason: 'operator-away' })
  })

  it('holds for the presence window, then lapses', () => {
    notePresence(t0)
    expect(isOperatorPresent(t0 + HOUR)).toBe(true)
    expect(isOperatorPresent(t0 + 3 * HOUR)).toBe(false)
  })

  it('names how long they have been gone, so the log line is diagnosable', () => {
    notePresence(t0)
    noteMaterialChange({ path: 'a.md', kind: 'created' })
    const v = mayRunAutomaticWork(t0 + 5 * HOUR)
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/5h ago/)
  })
})

describe('material change', () => {
  it('a created note always qualifies', () => {
    noteMaterialChange({ path: 'new.md', kind: 'created' })
    expect(hasMaterialChange()).toBe(true)
  })

  it('a trivial edit does NOT — a timestamp bump must not buy an LLM pass', () => {
    noteMaterialChange({ path: 'x.md', kind: 'updated', deltaBytes: 12 })
    expect(hasMaterialChange()).toBe(false)
  })

  it('a substantive edit does', () => {
    noteMaterialChange({ path: 'x.md', kind: 'updated', deltaBytes: 900 })
    expect(hasMaterialChange()).toBe(true)
  })

  it('an UNMEASURED edit counts — a change we could not size must not be silently discarded', () => {
    noteMaterialChange({ path: 'x.md', kind: 'updated' })
    expect(hasMaterialChange()).toBe(true)
  })
})

describe('the gate', () => {
  it('needs BOTH conditions — presence alone is not a reason to spend', () => {
    notePresence(t0)
    expect(mayRunAutomaticWork(t0)).toMatchObject({ ok: false, reason: 'no-material-change' })
  })

  it('needs BOTH — a change while the operator is away waits for them', () => {
    noteMaterialChange({ path: 'a.md', kind: 'created' })
    expect(mayRunAutomaticWork(t0)).toMatchObject({ ok: false, reason: 'operator-away' })
  })

  it('allows the pass when the operator is here AND content moved', () => {
    notePresence(t0)
    noteMaterialChange({ path: 'a.md', kind: 'created' })
    expect(mayRunAutomaticWork(t0)).toMatchObject({ ok: true })
  })

  it('a declined pass KEEPS its reason to run — the work is deferred, not lost', () => {
    noteMaterialChange({ path: 'a.md', kind: 'created' })
    expect(mayRunAutomaticWork(t0).ok).toBe(false) // away
    notePresence(t0 + HOUR)
    expect(mayRunAutomaticWork(t0 + HOUR)).toMatchObject({ ok: true })
  })

  it('consuming clears it, so a completed pass does not re-run on the same input', () => {
    notePresence(t0)
    noteMaterialChange({ path: 'a.md', kind: 'created' })
    expect(consumeMaterialChanges()).toHaveLength(1)
    expect(mayRunAutomaticWork(t0)).toMatchObject({ ok: false, reason: 'no-material-change' })
  })
})
