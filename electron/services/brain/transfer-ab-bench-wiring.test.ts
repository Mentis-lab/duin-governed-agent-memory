// transfer-ab-bench-wiring.test.ts — the moat-fit grader was SHADOW (2026-07-25 eval): fully built
// and unit-tested, but the only thing that ever ran it was a manual POST /debug/transfer-ab, so the
// RSI bench left `named-skill-lift` hardcoded null and the pilot's headline question — does the
// accumulated brain fit the operator better than the same model cold? — had no standing answer.
//
// This suite proves the closed loop: a run is recorded, the bench reads the freshest one back, and
// every null it can still report carries the REASON it is null (never-measured / stale / below the
// sample floor) rather than being the blank the slot used to hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Release M11: a pass spends 72 cloud calls and runs only under backgroundAutonomy. The existing
// closed-loop cases below establish that switch ON; the gate's own case flips it OFF.
const settingsState: Record<string, unknown> = { backgroundAutonomy: true }
vi.mock('../settings-helper', () => ({
  readSettings: (): Record<string, unknown> => settingsState
}))

import { recordTransferRun, latestTransferRun } from './transfer-ab-store'
import { resolveNamedSkillLift, scoreBench, type BenchInputs } from './self-improve-bench'
import { aggregateFitLift, type FitVerdict, type TransferDeps } from './transfer-ab'
import {
  transferAbTick,
  transferAbPassDue,
  transferAbTickEnabled,
  transferAbPassAllowed,
  startTransferAbTick,
  stopTransferAbTick
} from './transfer-ab-tick'
import type { AutonomyState } from './self-improve-registry'

/** Injected deps where the grounded answer always wins — a decisive pass with no model. */
const ALWAYS_GROUNDED: TransferDeps = {
  grounding: () => 'operator profile',
  answer: (_q, g) => (g ? 'grounded' : 'cold'),
  judge: (_q, a) => (a === 'grounded' ? 'A' : 'B'),
  coin: () => true
}

const NOW = '2026-07-25T00:00:00.000Z'
const daysBefore = (n: number): string =>
  new Date(Date.parse(NOW) - n * 24 * 60 * 60_000).toISOString()

let vault = ''
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-transfer-ab-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  settingsState.backgroundAutonomy = true
})
afterEach(() => rmSync(vault, { recursive: true, force: true }))

describe('the pass gate (release M11) — backgroundAutonomy is the operator\'s opt-in', () => {
  it('is OFF on a fresh install: missing, non-true, or unreadable settings all gate the pass', () => {
    delete settingsState.backgroundAutonomy
    expect(transferAbPassAllowed()).toBe(false)
    settingsState.backgroundAutonomy = 'true'
    expect(transferAbPassAllowed()).toBe(false)
    settingsState.backgroundAutonomy = true
    expect(transferAbPassAllowed()).toBe(true)
  })

  it('records NOTHING when autonomy is off — the 72-call pass never starts', async () => {
    settingsState.backgroundAutonomy = false
    let answers = 0
    const counting: TransferDeps = { ...ALWAYS_GROUNDED, answer: (q, g) => { answers++; return ALWAYS_GROUNDED.answer(q, g) } }
    await transferAbTick(() => vault, counting, ['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(answers).toBe(0)
    expect(latestTransferRun(vault)).toBeNull()
  })

  it('runs and records once autonomy is on — resolved fresh per pass, no restart needed', async () => {
    settingsState.backgroundAutonomy = false
    await transferAbTick(() => vault, ALWAYS_GROUNDED, ['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(latestTransferRun(vault)).toBeNull()
    settingsState.backgroundAutonomy = true
    await transferAbTick(() => vault, ALWAYS_GROUNDED, ['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(latestTransferRun(vault)).not.toBeNull()
  })
})

/** A decided verdict set that clears the n>=5 floor: 4 with-moat wins, 1 cold, 1 tie. */
const CLEARS_FLOOR: FitVerdict[] = ['with-moat', 'with-moat', 'with-moat', 'with-moat', 'cold', 'tie']

describe('transfer-ab history store', () => {
  it('returns null before anything is recorded', () => {
    expect(latestTransferRun(vault)).toBeNull()
  })

  it('reads back the MOST RECENT run', () => {
    recordTransferRun(vault, aggregateFitLift(['with-moat', 'cold']), daysBefore(3))
    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), NOW)

    const rec = latestTransferRun(vault)!
    expect(rec.ts).toBe(NOW)
    expect(rec.fitLift).toBe(3) // 4 with-moat − 1 cold
    expect(rec.verdict).toBe('moat-fits-better')
  })
})

describe('named-skill-lift resolves from the freshest measurement', () => {
  it('reports the measured NET lift, with the raw counts in the note', () => {
    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), NOW)

    const lift = resolveNamedSkillLift(vault, NOW)
    // (4 wins − 1 loss) / 6 decided = 50. NOT the 66.7 a raw win rate would report.
    expect(lift.value).toBe(50)
    expect(lift.note).toContain('fitLift=3')
    expect(lift.note).toContain('moat-fits-better')
  })

  // The efficacy axis averages its parts and treats 0 as "contributes nothing". A win RATE is
  // neutral at 50, so encoding the lift that way scored a useless moat at half marks and a
  // HARMFUL one in positive territory — on installs where rsi-kept-rate is null (all of them
  // today) that number is the whole axis. These two pin the 0-neutral property.
  it('scores a moat that changes nothing at ZERO, not at half marks', () => {
    recordTransferRun(vault, aggregateFitLift(['with-moat', 'with-moat', 'with-moat', 'cold', 'cold', 'cold']), NOW)

    const lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBe(0)
    expect(lift.note).toContain('no-difference')
  })

  it('never reports a POSITIVE efficacy for a moat that makes answers worse', () => {
    recordTransferRun(vault, aggregateFitLift(['with-moat', 'cold', 'cold', 'cold', 'cold', 'tie']), NOW)

    const lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBe(0)
    // The direction is not swallowed — it is stated where a reader will see it.
    expect(lift.note).toContain('cold-fits-better')
  })

  it('rejects an unreadable or future timestamp instead of treating it as fresh', () => {
    // latestTransferRun only validates that ts is a string, so a corrupt tail line reaches here.
    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), 'not-a-date')
    let lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBeNull()
    expect(lift.note).toMatch(/unreadable timestamp/)

    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), daysBefore(-90))
    lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBeNull()
    expect(lift.note).toMatch(/stamped in the future/)
  })

  it('is honest-null BELOW the sample floor, and says so', () => {
    // 2 decided comparisons — under DEFAULT_TRANSFER_POLICY.minSamples (5).
    recordTransferRun(vault, aggregateFitLift(['with-moat', 'cold']), NOW)

    const lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBeNull()
    expect(lift.note).toMatch(/below the sample floor/)
    expect(lift.note).toContain('decided=2')
  })

  it('is honest-null when the last measurement is STALE, and says how old', () => {
    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), daysBefore(30))

    const lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBeNull()
    expect(lift.note).toMatch(/stale/)
    expect(lift.note).toContain('30d')
  })

  it('is honest-null with a REASON when the grader has never run', () => {
    const lift = resolveNamedSkillLift(vault, NOW)
    expect(lift.value).toBeNull()
    // The defect being fixed: the slot used to be a bare null with nothing to explain it.
    expect(lift.note).toMatch(/no transfer-A\/B run recorded/)
  })
})

describe('the bench consumes the measured lift', () => {
  const base = (lift: { value: number | null; note: string }): BenchInputs => ({
    inflight: [],
    autonomy: new Map<string, AutonomyState>(),
    namedSkillCount: 0,
    reuseEventCount: 0,
    capabilities: [],
    moatStatus: 'cold',
    prevCompoundingLevel: null,
    declared: { namedSkillReadback: 1, rsiProducer: 0.5, skillCapBridge: 1 },
    meritAutonomyOn: false,
    namedSkillLift: lift
  })

  it('surfaces the value and its note in efficacyParts, and lets it drive efficacy', () => {
    const b = scoreBench(base({ value: 50, note: 'fitLift=3 (…)' }), NOW)
    const part = b.efficacyParts.find((p) => p.name === 'named-skill-lift')!

    expect(part.value).toBe(50)
    expect(part.note).toContain('fitLift=3')
    // rsi-kept-rate is null here (no adjudicated changes), so efficacy is this part alone —
    // the axis is no longer permanently N/A the way it was with a hardcoded null.
    expect(b.efficacy).toBe(50)
  })

  it('leaves efficacy N/A when the lift is honest-null (no fabricated number)', () => {
    const b = scoreBench(base({ value: null, note: 'below the sample floor: decided=2 of 6' }), NOW)

    expect(b.efficacyParts.find((p) => p.name === 'named-skill-lift')!.value).toBeNull()
    expect(b.efficacy).toBeNull()
  })
})

describe('the scheduled tick is the production producer', () => {
  it('records a run for the configured vault', async () => {
    await transferAbTick(() => vault, ALWAYS_GROUNDED, ['q1', 'q2', 'q3', 'q4', 'q5'])

    const rec = latestTransferRun(vault)!
    expect(rec.decided).toBe(5)
    expect(rec.fitLift).toBe(5)
    expect(rec.verdict).toBe('moat-fits-better')
  })

  it('records on a COLD vault, where .duin/_state does not exist yet', async () => {
    // durableAppend opens with 'a' and creates no parent dirs. Without an explicit mkdir this
    // throws ENOENT, the best-effort catch swallows it, and the bench then reports "the grader has
    // never been asked" about a grader that ran and spent the calls. Every other test in this file
    // pre-creates the dir in beforeEach, so only this one can catch it.
    rmSync(join(vault, '.duin'), { recursive: true, force: true })
    expect(existsSync(join(vault, '.duin', '_state'))).toBe(false)

    await transferAbTick(() => vault, ALWAYS_GROUNDED, ['q1', 'q2', 'q3', 'q4', 'q5'])

    expect(latestTransferRun(vault)?.decided).toBe(5)
  })

  it('is a no-op with no vault configured — and measures nothing', async () => {
    await transferAbTick(() => null, ALWAYS_GROUNDED, ['q1', 'q2', 'q3', 'q4', 'q5'])
    expect(latestTransferRun(vault)).toBeNull()
  })

  it('SKIPS a pass when a recent run already answers the question', async () => {
    // A timer alone measures once per app LAUNCH: eight restarts in a day = eight passes = ~200
    // model calls, against a "daily" claim. The due-check reads the history, so it survives restarts.
    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), new Date().toISOString())

    await transferAbTick(
      () => vault,
      {
        grounding: () => 'operator profile',
        answer: () => {
          throw new Error('ran a measurement pass that was not due')
        },
        judge: () => 'A'
      },
      ['q1', 'q2', 'q3', 'q4', 'q5']
    )

    // Still the run we seeded — decided=6, not the 5-query pass that must not have run.
    expect(latestTransferRun(vault)!.decided).toBe(6)
  })

  it('is due when nothing was ever recorded, and not due right after one', () => {
    const now = Date.parse(NOW)
    expect(transferAbPassDue(vault, now)).toBe(true)

    recordTransferRun(vault, aggregateFitLift(CLEARS_FLOOR), NOW)
    expect(transferAbPassDue(vault, now)).toBe(false)
    // ...and due again once the cadence has elapsed.
    expect(transferAbPassDue(vault, now + 24 * 60 * 60_000)).toBe(true)
  })
})

describe('the tick scheduler honours its gate and is idempotent', () => {
  const prev = process.env.DUIN_TRANSFER_AB_TICK
  afterEach(() => {
    stopTransferAbTick()
    if (prev === undefined) delete process.env.DUIN_TRANSFER_AB_TICK
    else process.env.DUIN_TRANSFER_AB_TICK = prev
  })

  it('is enabled by default and off for the documented kill-switch values', () => {
    delete process.env.DUIN_TRANSFER_AB_TICK
    expect(transferAbTickEnabled()).toBe(true)
    for (const v of ['0', 'false']) {
      process.env.DUIN_TRANSFER_AB_TICK = v
      expect(transferAbTickEnabled()).toBe(false)
    }
  })

  it('start/stop/start leaves no orphaned timer behind', () => {
    delete process.env.DUIN_TRANSFER_AB_TICK
    // A second start must not arm a second interval (the guard is `if (timer) return`), and stop
    // must clear BOTH the settle timeout and the interval or the process never exits in tests.
    expect(() => {
      startTransferAbTick(() => null)
      startTransferAbTick(() => null)
      stopTransferAbTick()
      startTransferAbTick(() => null)
      stopTransferAbTick()
      stopTransferAbTick()
    }).not.toThrow()
  })
})
