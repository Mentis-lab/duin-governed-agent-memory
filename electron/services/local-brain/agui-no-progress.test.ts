import { describe, it, expect, afterEach } from 'vitest'
import {
  emptyRepeatState,
  noteCallOutcome,
  shouldHaltOnRepeat,
  repeatFailureK,
  repeatRootCause,
  callFingerprint,
  isFailureResult,
  nextRoundBudget
} from './agui-no-progress'

// The repeat-failure ladder. The behaviour that matters is the RESET rule: an agent that retries a
// DIFFERENT way, or that succeeds at anything, must never be halted — otherwise a legitimately
// exploratory turn gets cut short, which is a worse failure than the one this prevents.

const ORIGINAL = process.env.DUIN_AGUI_REPEAT_K
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DUIN_AGUI_REPEAT_K
  else process.env.DUIN_AGUI_REPEAT_K = ORIGINAL
})

const ERR = 'Error: ENOENT no such file'
const OK = 'wrote 12 lines'

describe('repeatFailureK — env threshold', () => {
  it('defaults to 3 (halt on the third identical failure)', () => {
    delete process.env.DUIN_AGUI_REPEAT_K
    expect(repeatFailureK()).toBe(3)
  })
  it('0 disables the ladder', () => {
    process.env.DUIN_AGUI_REPEAT_K = '0'
    expect(shouldHaltOnRepeat({ fingerprint: 'f', count: 99, toolName: 'x' }, repeatFailureK())).toBe(false)
  })
})

describe('isFailureResult', () => {
  it('matches the loop’s own error shape and nothing else', () => {
    expect(isFailureResult('Error: boom')).toBe(true)
    expect(isFailureResult('wrote 3 lines')).toBe(false)
    // A successful result that merely MENTIONS an error is not a failure.
    expect(isFailureResult('Found 2 matches for "Error:" in the log')).toBe(false)
  })
})

describe('callFingerprint', () => {
  it('is stable across key order (same logical call ⇒ same fingerprint)', () => {
    expect(callFingerprint('write_file', { path: 'a', content: 'b' })).toBe(
      callFingerprint('write_file', { content: 'b', path: 'a' })
    )
  })
  it('separates different arguments and different tools', () => {
    expect(callFingerprint('write_file', { path: 'a' })).not.toBe(callFingerprint('write_file', { path: 'b' }))
    expect(callFingerprint('write_file', { path: 'a' })).not.toBe(callFingerprint('read_file', { path: 'a' }))
  })
})

describe('noteCallOutcome — streak folding', () => {
  it('halts on the third identical failure, not the second', () => {
    const k = 3
    let s = emptyRepeatState()
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    expect(shouldHaltOnRepeat(s, k)).toBe(false)
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    expect(shouldHaltOnRepeat(s, k)).toBe(false)
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    expect(shouldHaltOnRepeat(s, k)).toBe(true)
    expect(s.count).toBe(3)
  })

  it('ANY success clears the streak', () => {
    let s = emptyRepeatState()
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    s = noteCallOutcome(s, 'read_file', { path: 'y' }, OK)
    expect(s.count).toBe(0)
    expect(s.fingerprint).toBeNull()
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    expect(shouldHaltOnRepeat(s, 3)).toBe(false)
  })

  it('a DIFFERENT failing call restarts the streak rather than extending it', () => {
    let s = emptyRepeatState()
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    s = noteCallOutcome(s, 'write_file', { path: 'x' }, ERR)
    // The agent tries another path — that is exploration, not a wedge.
    s = noteCallOutcome(s, 'write_file', { path: 'z' }, ERR)
    expect(s.count).toBe(1)
    expect(shouldHaltOnRepeat(s, 3)).toBe(false)
  })

  it('alternating between two broken calls never halts', () => {
    let s = emptyRepeatState()
    for (let i = 0; i < 10; i++) {
      s = noteCallOutcome(s, 'write_file', { path: i % 2 ? 'a' : 'b' }, ERR)
      expect(shouldHaltOnRepeat(s, 3)).toBe(false)
    }
  })
})

describe('repeatRootCause', () => {
  it('names the tool and the count', () => {
    const s = { fingerprint: 'f', count: 3, toolName: 'delete_file' }
    expect(repeatRootCause(s)).toBe('delete_file failed 3 times in a row with identical arguments')
  })
})

// ── the round budget is EARNED ──────────────────────────────────────────────────
//
// OPERATOR REPORT, 2026-08-26: "what is the 32 round limit? I feel like that should
// not be streamed, nor should it be a limit."
//
// Right on the second point, and this file's own header already conceded it — "the
// round cap is a ceiling, not a detector". A fixed count cannot tell a turn that is
// getting somewhere from one that is spinning, which is why it was raised 8 → 16 → 32
// over time: a number being tuned to avoid the symptom of measuring the wrong thing.
// The detectors that measure the right thing now exist (repeat ladder, stall watchdog,
// per-tool timeout, cost meter), so rounds are granted while progress is real.

describe('nextRoundBudget — rounds are granted while the turn is progressing', () => {
  const base = {
    budget: 32,
    hardCap: 256,
    progressWindowMs: 120_000,
    grant: 8,
    now: 1_000_000,
    lastProgressAt: 1_000_000
  }

  it('does nothing mid-budget — a healthy turn is not handed an unbounded loop up front', () => {
    expect(nextRoundBudget({ ...base, round: 0 })).toBe(32)
    expect(nextRoundBudget({ ...base, round: 15 })).toBe(32)
    expect(nextRoundBudget({ ...base, round: 30 })).toBe(32)
  })

  it('extends on the LAST round when progress is recent', () => {
    expect(nextRoundBudget({ ...base, round: 31 })).toBe(40)
  })

  it('does NOT extend when the turn has gone quiet — the old cap still applies to a spinner', () => {
    expect(
      nextRoundBudget({ ...base, round: 31, lastProgressAt: base.now - 200_000 })
    ).toBe(32)
  })

  it('re-earns each grant: the next extension needs fresh progress at the new edge', () => {
    let budget = 32
    // Earns one grant at the edge.
    budget = nextRoundBudget({ ...base, round: 31, budget })
    expect(budget).toBe(40)
    // Mid-grant: nothing happens, however recent the progress.
    expect(nextRoundBudget({ ...base, round: 35, budget })).toBe(40)
    // At the new edge, still progressing: another grant.
    expect(nextRoundBudget({ ...base, round: 39, budget })).toBe(48)
    // At the new edge, gone quiet: stop.
    expect(
      nextRoundBudget({ ...base, round: 39, budget, lastProgressAt: base.now - 200_000 })
    ).toBe(40)
  })

  it('never exceeds the hard ceiling, however well it is going', () => {
    expect(nextRoundBudget({ ...base, round: 251, budget: 252, hardCap: 256 })).toBe(256)
    expect(nextRoundBudget({ ...base, round: 255, budget: 256, hardCap: 256 })).toBe(256)
  })

  it('grant <= 0 restores the old fixed-cap behaviour exactly', () => {
    expect(nextRoundBudget({ ...base, round: 31, grant: 0 })).toBe(32)
    expect(nextRoundBudget({ ...base, round: 31, grant: -1 })).toBe(32)
  })
})
