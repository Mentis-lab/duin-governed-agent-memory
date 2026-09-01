import { describe, it, expect } from 'vitest'
import {
  watchdogConfig,
  watchdogVerdict,
  WATCHDOG_TICK_MS,
  noticeConfig,
  noticeDue,
  noticeLabel,
  noticeWorthSending
} from './turn-watchdog'

// Long-turn notices. The point is NOT to cut anything — it is that with no absolute ceiling,
// "still working" and "wedged" are the same observation from outside. These pin the advisory
// state that tells them apart.
describe('noticeConfig — defaults and env override', () => {
  it('defaults: first at 45s, then every 30s', () => {
    expect(noticeConfig({})).toEqual({ firstMs: 45_000, everyMs: 30_000 })
  })
  it('env overrides both bounds', () => {
    expect(noticeConfig({ DUIN_TURN_NOTICE_FIRST_MS: '10000', DUIN_TURN_NOTICE_EVERY_MS: '5000' }))
      .toEqual({ firstMs: 10_000, everyMs: 5_000 })
  })
  it('0 on either bound disables notices, and stays distinguishable from "not yet due"', () => {
    expect(noticeDue(999_999, 0, noticeConfig({ DUIN_TURN_NOTICE_FIRST_MS: '0' }))).toBe(false)
    expect(noticeDue(999_999, 0, noticeConfig({ DUIN_TURN_NOTICE_EVERY_MS: '0' }))).toBe(false)
  })
  it('empty / non-numeric falls back to the default', () => {
    expect(noticeConfig({ DUIN_TURN_NOTICE_FIRST_MS: '', DUIN_TURN_NOTICE_EVERY_MS: 'nope' }))
      .toEqual({ firstMs: 45_000, everyMs: 30_000 })
  })
})

describe('noticeDue — silent on healthy turns, then paced', () => {
  const cfg = { firstMs: 45_000, everyMs: 30_000 }
  it('says nothing on a turn that closes inside the first threshold', () => {
    expect(noticeDue(0, 0, cfg)).toBe(false)
    expect(noticeDue(44_999, 0, cfg)).toBe(false)
  })
  it('first notice fires exactly at the threshold', () => {
    expect(noticeDue(45_000, 0, cfg)).toBe(true)
  })
  it('does not repeat until the next interval has passed', () => {
    expect(noticeDue(50_000, 1, cfg)).toBe(false)
    expect(noticeDue(74_999, 1, cfg)).toBe(false)
    expect(noticeDue(75_000, 1, cfg)).toBe(true)
  })
  // WAS `expect(sent).toBe(7)`, asserting the flat 30s cadence. The invariant this test
  // names — "paces indefinitely" — is intact and still asserted; the literal 7 was the
  // old arithmetic, and repeats now back off (2026-08-26, after an operator pasted five
  // near-identical "round 4/32" lines thirty seconds apart and read them as a fault).
  // The count is deliberately NOT re-pinned to the new number: what matters is that a
  // long turn keeps speaking and does not drum, and a fixed count would have to be
  // rewritten again the next time the cadence is tuned.
  it('paces indefinitely on a 240s runaway, without drumming', () => {
    let sent = 0
    for (let t = 0; t <= 240_000; t += 5_000) if (noticeDue(t, sent, cfg)) sent++
    expect(sent).toBeGreaterThan(1) // it keeps speaking …
    expect(sent).toBeLessThan(7) //  … but less often than the old flat schedule
  })

  it('never goes permanently silent, however long the turn runs', () => {
    let sent = 0
    for (let t = 0; t <= 60 * 60_000; t += 5_000) if (noticeDue(t, sent, cfg)) sent++
    // Capped gap ⇒ roughly one line every few minutes across an hour, not a handful.
    expect(sent).toBeGreaterThan(10)
  })
})

describe('noticeLabel — legible, and honest before the loop starts', () => {
  it('names the round and the cap once the loop is running', () => {
    expect(noticeLabel(90_000, 7, 32)).toBe('still working — round 7/32 · 90s elapsed')
  })
  it('says "preparing" rather than naming a round that has not started', () => {
    expect(noticeLabel(45_000, 0, 0)).toBe('still working — preparing · 45s elapsed')
  })
  it('never reports a round beyond the cap', () => {
    expect(noticeLabel(60_000, 99, 32)).toContain('round 32/32')
  })
})

describe('watchdogConfig — env parsing + back-compat', () => {
  it('defaults: 90s stall, NO ceiling (maxMs 0) — long agent turns run unbounded while progressing', () => {
    expect(watchdogConfig({})).toEqual({ stallMs: 90_000, maxMs: 0 })
  })
  it('DUIN_TURN_STALL_MS / DUIN_TURN_MAX_MS override the defaults', () => {
    expect(watchdogConfig({ DUIN_TURN_STALL_MS: '120000', DUIN_TURN_MAX_MS: '1800000' })).toEqual({
      stallMs: 120_000,
      maxMs: 1_800_000
    })
  })
  it('0 disables each limit independently', () => {
    expect(watchdogConfig({ DUIN_TURN_STALL_MS: '0' }).stallMs).toBe(0)
    expect(watchdogConfig({ DUIN_TURN_MAX_MS: '0' }).maxMs).toBe(0)
  })
  it('legacy DUIN_TURN_DEADLINE_MS, if set, overrides the ceiling (keeps operator intent)', () => {
    expect(watchdogConfig({ DUIN_TURN_DEADLINE_MS: '300000' }).maxMs).toBe(300_000)
    // legacy disable → no ceiling, stall still active
    expect(watchdogConfig({ DUIN_TURN_DEADLINE_MS: '0' })).toEqual({ stallMs: 90_000, maxMs: 0 })
  })
  it('DUIN_TURN_MAX_MS is used only when the legacy knob is NOT set', () => {
    expect(watchdogConfig({ DUIN_TURN_DEADLINE_MS: '250000', DUIN_TURN_MAX_MS: '900000' }).maxMs).toBe(250_000)
  })
  it('empty / non-numeric falls back to the default', () => {
    expect(watchdogConfig({ DUIN_TURN_STALL_MS: '', DUIN_TURN_MAX_MS: 'nope' })).toEqual({
      stallMs: 90_000,
      maxMs: 0
    })
  })
  it('DUIN_TURN_MAX_MS opts INTO a ceiling when set', () => {
    expect(watchdogConfig({ DUIN_TURN_MAX_MS: '3600000' }).maxMs).toBe(3_600_000)
  })
})

describe('watchdogVerdict — progress-aware cut decision', () => {
  const cfg = { stallMs: 90_000, maxMs: 900_000 }
  const start = 1_000_000

  it('does not cut while progress is recent and under the ceiling', () => {
    const now = start + 300_000 // 5 min in
    expect(watchdogVerdict(now, start, now - 10_000, cfg)).toEqual({ cut: false })
  })

  it('a long BUT progressing turn survives well past the old 180s flat cap', () => {
    const now = start + 600_000 // 10 min in
    // progress 30s ago (e.g. a tool result just landed) → keep going
    expect(watchdogVerdict(now, start, now - 30_000, cfg)).toEqual({ cut: false })
  })

  it('cuts as STALLED when no progress for >= stallMs', () => {
    const now = start + 200_000
    expect(watchdogVerdict(now, start, now - 90_000, cfg)).toEqual({ cut: true, reason: 'stalled' })
  })

  it('cuts at the absolute ceiling even if progress is recent (slow-runaway backstop)', () => {
    const now = start + 900_000
    // token streamed 1s ago — still cut, because the ceiling is a hard backstop
    expect(watchdogVerdict(now, start, now - 1_000, cfg)).toEqual({ cut: true, reason: 'max-wallclock' })
  })

  it('reports max-wallclock (not stalled) when both fire — the stronger signal', () => {
    const now = start + 950_000
    expect(watchdogVerdict(now, start, now - 200_000, cfg).reason).toBe('max-wallclock')
  })

  it('stallMs=0 disables the idle cut; maxMs=0 disables the ceiling', () => {
    const noStall = { stallMs: 0, maxMs: 900_000 }
    expect(watchdogVerdict(start + 500_000, start, start, noStall)).toEqual({ cut: false })
    const noMax = { stallMs: 90_000, maxMs: 0 }
    const now = start + 10_000_000
    expect(watchdogVerdict(now, start, now - 1_000, noMax)).toEqual({ cut: false })
  })

  it('tick interval is a sane small poll', () => {
    expect(WATCHDOG_TICK_MS).toBeGreaterThan(0)
    expect(WATCHDOG_TICK_MS).toBeLessThanOrEqual(10_000)
  })
})

// ── heartbeat noise ─────────────────────────────────────────────────────────────
//
// OPERATOR REPORT, 2026-08-26, first half: "I feel like that should not be streamed".
// The pasted trace showed FIVE consecutive near-identical lines —
//
//   still working — round 4/32 · 75s elapsed
//   still working — round 4/32 · 105s elapsed
//   still working — round 4/32 · 135s elapsed   (…165s, 195s)
//
// — same round, thirty seconds apart, during one long tool call. A flat interval turns
// a healthy long turn into a wall of text that reads as malfunction rather than as
// reassurance. Two changes: the gap backs off, and the line is suppressed entirely
// while output is visibly flowing.

describe('noticeDue — repeats back off instead of drumming', () => {
  const cfg = { firstMs: 45_000, everyMs: 30_000 }

  it('the first notice is unchanged', () => {
    expect(noticeDue(44_000, 0, cfg)).toBe(false)
    expect(noticeDue(45_000, 0, cfg)).toBe(true)
  })

  it('each subsequent gap doubles', () => {
    // #2 at 45 + 30 = 75s
    expect(noticeDue(74_000, 1, cfg)).toBe(false)
    expect(noticeDue(75_000, 1, cfg)).toBe(true)
    // #3 at 45 + 30 + 60 = 135s — NOT 105s, which is where the flat schedule put it
    expect(noticeDue(105_000, 2, cfg)).toBe(false)
    expect(noticeDue(135_000, 2, cfg)).toBe(true)
    // #4 at 45 + 30 + 60 + 120 = 255s
    expect(noticeDue(200_000, 3, cfg)).toBe(false)
    expect(noticeDue(255_000, 3, cfg)).toBe(true)
  })

  it('the reported case: five notices no longer fit in the first 195 seconds', () => {
    let sent = 0
    for (let t = 0; t <= 195_000; t += 1_000) {
      if (noticeDue(t, sent, cfg)) sent++
    }
    expect(sent).toBeLessThanOrEqual(3)
  })

  it('the gap is capped so a very long turn still speaks', () => {
    // With doubling alone, notice 10 would be days away.
    expect(noticeDue(60 * 60_000, 9, cfg)).toBe(true)
  })

  it('disabled config still reads as disabled, not as not-yet-due', () => {
    expect(noticeDue(10_000_000, 0, { firstMs: 0, everyMs: 30_000 })).toBe(false)
    expect(noticeDue(10_000_000, 0, { firstMs: 45_000, everyMs: 0 })).toBe(false)
  })
})

describe('noticeWorthSending — silent while the panel is scrolling', () => {
  it('says nothing when tokens streamed a moment ago', () => {
    // The operator can already see it working; a line saying so is noise on top of
    // the very content that proves it.
    expect(noticeWorthSending(1_000_000, 1_000_000 - 500)).toBe(false)
    expect(noticeWorthSending(1_000_000, 1_000_000 - 9_000)).toBe(false)
  })

  it('speaks once the turn has gone quiet — the case it exists for', () => {
    expect(noticeWorthSending(1_000_000, 1_000_000 - 10_000)).toBe(true)
    expect(noticeWorthSending(1_000_000, 1_000_000 - 120_000)).toBe(true)
  })
})
