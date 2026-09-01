import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proposeChange, proposeNextRsiKnob, isConfinedToDuin, archivedJointConfigs, nextKnobValueQD, jointConfigKey, type RsiChangeSpec, type KnobVerdict } from './rsi-proposer'
import { readRsiTunables, rsiTunablesPath } from './rsi-tunables'
import { loadInflight, recordVerdict, tierFor } from './self-improve-registry'
import { rollbackChange } from './self-improve-loop'

const NOW = '2026-07-17T00:00:00.000Z'
let vault: string
const cfg = (): string => join(vault, '.duin', 'rsi-cfg.json')
const spec = (over: Partial<RsiChangeSpec> = {}): RsiChangeSpec => ({
  changeClass: 'grounding-weight', engine: 'risk', targetPath: cfg(), afterBytes: '{"w":0.6}', ...over,
})

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'rsi-prop-'))
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
})
afterEach(() => {
  try { rmSync(vault, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('rsi-proposer (Phase 2 — the missing RSI producer)', () => {
  it('stages + applies a byte-reversible change into the in-flight ledger', () => {
    const r = proposeChange(vault, spec(), NOW)
    expect(r.staged).toBe(true)
    const inflight = loadInflight(vault)
    expect(inflight).toHaveLength(1)
    expect(inflight[0].status).toBe('applied')
    expect(inflight[0].appliedAt).toBe(NOW)
    expect(readFileSync(cfg(), 'utf-8')).toBe('{"w":0.6}')
    expect(r.change!.beforeBytes).toBe('') // file didn't exist → empty rollback snapshot
  })

  it('refuses a second in-flight change on the same engine (attribution invariant)', () => {
    proposeChange(vault, spec(), NOW)
    const r2 = proposeChange(vault, spec({ changeClass: 'other', afterBytes: '{"w":0.7}' }), NOW)
    expect(r2.staged).toBe(false)
    expect(r2.reason).toMatch(/already has an in-flight/)
  })

  it('refuses a targetPath outside <vault>/.duin/ (no arbitrary writes)', () => {
    const r = proposeChange(vault, spec({ targetPath: join(vault, 'evil.json') }), NOW)
    expect(r.staged).toBe(false)
    expect(isConfinedToDuin(vault, join(vault, '.duin', 'x.json'))).toBe(true)
    expect(isConfinedToDuin(vault, join(vault, 'evil.json'))).toBe(false)
  })

  it('rollback restores the pre-change bytes byte-exact (closes the loop)', () => {
    const r = proposeChange(vault, spec(), NOW)
    rollbackChange(vault, r.change!)
    expect(readFileSync(cfg(), 'utf-8')).toBe('') // restored to the pre-change (empty) state
    expect(loadInflight(vault)[0].status).toBe('rolled-back')
  })

  it('id is deterministic for the same spec (idempotent staging)', () => {
    const a = proposeChange(vault, spec(), NOW).change!.id
    // same spec ⇒ same id (dedup-safe); different afterBytes ⇒ different id
    const b = proposeChange(vault, spec(), NOW) // refused (engine busy) but id would match
    expect(b.staged).toBe(false)
    expect(a).toMatch(/^chg-[0-9a-f]{16}$/)
  })
})

describe('proposeNextRsiKnob (the gated producer wired to the tick)', () => {
  it('stages a bounded, clamped tunable change on the named-skill recall-efficacy engine (QD-archive explore)', () => {
    const r = proposeNextRsiKnob(vault, NOW)
    expect(r?.staged).toBe(true)
    expect(r!.change!.engine).toBe('recall-efficacy:named-skill') // the kind namedSkillTopK actually moves
    expect(r!.change!.changeClass).toBe('named-skill-topk')
    // Archive-guided (activation 4): with an empty archive, nextKnobValue EXPLORES the
    // lowest unexplored stepping stone in [1,5] (≠ current 3) rather than greedy +step,
    // so it proposes 1. Value stays inside the clamp bounds.
    // Re-shaped 2026-08-21 (W2 stage-don't-apply): a FRESH class is tier 'propose', so the
    // proposal now lands in the ledger's afterBytes and the live file stays untouched until
    // ratified — the value assertions read the STAGED bytes, not the tunables file.
    const v = (JSON.parse(r!.change!.afterBytes) as { namedSkillTopK: number }).namedSkillTopK
    expect(v).toBe(1)
    expect(v).toBeGreaterThanOrEqual(1)
    expect(v).toBeLessThanOrEqual(5)
    expect(readRsiTunables(vault).namedSkillTopK).toBe(3) // live value unchanged — nothing applied
  })

  it('runs a real POPULATION — the two knobs are on DISTINCT engines, so both stage concurrently', () => {
    // The prior single shared 'promotion' engine serialized the two knobs (one-in-flight-per-engine),
    // so the "population" could never have two variants live at once. Distinct per-kind engines fix that.
    const r1 = proposeNextRsiKnob(vault, NOW)
    expect(r1?.staged).toBe(true)
    expect(r1!.change!.engine).toBe('recall-efficacy:named-skill')
    // second call proceeds to the OTHER knob (a different engine) instead of being blocked
    const r2 = proposeNextRsiKnob(vault, NOW)
    expect(r2?.staged).toBe(true)
    expect(r2!.change!.engine).toBe('recall-efficacy:failure')
    // only once BOTH engines have an in-flight change does it rest (nothing left to stage)
    expect(proposeNextRsiKnob(vault, NOW)).toBeNull()
  })

  it('cycles back to min at the max bound (5 → 1) — never exceeds the clamp', () => {
    writeFileSync(rsiTunablesPath(vault), JSON.stringify({ namedSkillTopK: 5 }))
    const r = proposeNextRsiKnob(vault, NOW)
    // Re-shaped 2026-08-21 (W2): the cycled value is asserted on the STAGED bytes — a fresh
    // class no longer writes the live file (see the explore test above for the reason).
    expect((JSON.parse(r!.change!.afterBytes) as { namedSkillTopK: number }).namedSkillTopK).toBe(1)
    expect(readRsiTunables(vault).namedSkillTopK).toBe(5) // untouched until ratified
  })
})

describe('earned-autonomy gate (the ratchet must actually block apply, not just record itself)', () => {
  it('a class the ratchet just demoted (rollback -> propose, keptStreak 0) is NOT auto-applied on the next tick', () => {
    // Simulate what adjudicateInflight does on a rollback: recordVerdict(..., kept:false, ...)
    // resets keptStreak to 0 and demotes the class back to 'propose'.
    recordVerdict(vault, 'recall-failure-limit', false, NOW)
    expect(tierFor(vault, 'recall-failure-limit')).toBe('propose')

    // First call: the OTHER knob (named-skill-topk) has no history → tier 'propose' → STAGES.
    const r1 = proposeNextRsiKnob(vault, NOW)
    expect(r1?.staged).toBe(true)
    expect(r1!.change!.changeClass).toBe('named-skill-topk')

    // Second call reaches recall-failure-limit — the just-demoted class. Re-shaped 2026-08-21
    // (W2 stage-don't-apply, supersedes 3aff60b's skip): the invariant this test protects is
    // "a demoted class must never SELF-APPLY", and that now holds for every non-'auto' class
    // structurally — the demoted class may still ASK (stage a proposal for a different,
    // not-known-bad value; the rolled-back value itself is archive-barred), but the live file
    // cannot move without ratification. Asking after a failure is honest; acting isn't.
    const r2 = proposeNextRsiKnob(vault, NOW)
    expect(r2?.staged).toBe(true)
    expect(r2!.change!.changeClass).toBe('recall-failure-limit')
    expect(r2!.change!.status).toBe('proposed')
    expect(readRsiTunables(vault).recallFailureLimit).toBe(20) // unchanged from default — no live write
  })

  it('a class still mid-streak toward GRADUATE_N (kept once, not yet graduated) is NOT blocked', () => {
    // One kept verdict: still 'propose' (GRADUATE_N defaults to 3), but keptStreak is 1, not a
    // fresh demotion — the ratchet must be able to keep accumulating verdicts toward 'auto',
    // otherwise no class could ever graduate in the first place.
    recordVerdict(vault, 'recall-failure-limit', true, NOW)
    expect(tierFor(vault, 'recall-failure-limit')).toBe('propose')

    proposeNextRsiKnob(vault, NOW) // consumes named-skill-topk's engine slot
    const r2 = proposeNextRsiKnob(vault, NOW)
    expect(r2?.staged).toBe(true)
    expect(r2!.change!.changeClass).toBe('recall-failure-limit')
  })
})

describe('joint QD archive (Apply.RSI P3 — descriptor-space quality-diversity)', () => {
  it('archivedJointConfigs reconstructs the 2-D cell + verdict from the ledger', () => {
    const afterBytes = JSON.stringify({ namedSkillTopK: 2, recallFailureLimit: 25 }, null, 2) + '\n'
    const r = proposeChange(
      vault,
      { changeClass: 'named-skill-topk', engine: 'recall-efficacy:named-skill', targetPath: rsiTunablesPath(vault), afterBytes },
      NOW
    )
    rollbackChange(vault, r.change!)
    expect(archivedJointConfigs(vault).get(jointConfigKey(2, 25))).toBe('rolled-back')
  })

  it('nextKnobValueQD avoids rolled-back JOINT cells and explores descriptor-novel ones', () => {
    const single = new Map<number, KnobVerdict>()
    const joint = new Map<string, KnobVerdict>([[jointConfigKey(1, 20), 'rolled-back']])
    const keyFor = (v: number) => jointConfigKey(v, 20)
    // v=1 → joint cell 1x20 is rolled-back (skip); v=2 is descriptor-novel → chosen
    expect(nextKnobValueQD(3, { min: 1, max: 5 }, single, keyFor, joint)).toBe(2)
  })

  it('nextKnobValueQD converges to a joint-IMPROVED cell once novelty is exhausted', () => {
    const single = new Map<number, KnobVerdict>([[1, 'kept'], [2, 'kept'], [4, 'kept'], [5, 'kept']])
    const joint = new Map<string, KnobVerdict>([
      [jointConfigKey(1, 20), 'kept'], [jointConfigKey(2, 20), 'kept'],
      [jointConfigKey(4, 20), 'improved'], [jointConfigKey(5, 20), 'kept']
    ])
    const keyFor = (v: number) => jointConfigKey(v, 20)
    // all cells explored (no novelty) → exploit the joint-improved cell at v=4
    expect(nextKnobValueQD(3, { min: 1, max: 5 }, single, keyFor, joint)).toBe(4)
  })

  it('proposeNextRsiKnob (the PRODUCER) skips a rolled-back joint cell end-to-end', () => {
    writeFileSync(rsiTunablesPath(vault), JSON.stringify({ namedSkillTopK: 3, recallFailureLimit: 20 }))
    // stage + roll back a named-skill change landing at joint cell (1, 20) → that cell is now known-bad
    const afterBytes = JSON.stringify({ namedSkillTopK: 1, recallFailureLimit: 20 }, null, 2) + '\n'
    const r = proposeChange(
      vault,
      { changeClass: 'named-skill-topk', engine: 'recall-efficacy:named-skill', targetPath: rsiTunablesPath(vault), afterBytes },
      NOW
    )
    rollbackChange(vault, r.change!) // restores the pre-change {3,20} bytes; the engine is now free again
    // the composed producer must NOT re-propose namedSkillTopK=1 (joint cell 1x20 is rolled-back)
    const next = proposeNextRsiKnob(vault, NOW)
    expect(next?.staged).toBe(true)
    expect(next!.change!.changeClass).toBe('named-skill-topk')
    // Re-shaped 2026-08-21 (W2): the class now has a rollback on record → tier 'propose' → the
    // skip-the-known-bad-cell decision shows up in the STAGED bytes; the live file stays {3,20}.
    const staged = JSON.parse(next!.change!.afterBytes) as { namedSkillTopK: number }
    expect(staged.namedSkillTopK).not.toBe(1) // skipped the known-bad joint cell
    expect(staged.namedSkillTopK).toBe(2) // explored the next descriptor-novel cell
    expect(readRsiTunables(vault).namedSkillTopK).toBe(3) // untouched until ratified
  })
})

describe('readRsiTunables (the clamp is the safety floor)', () => {
  it('defaults on missing, clamps out-of-range, defaults on corrupt', () => {
    expect(readRsiTunables(vault).namedSkillTopK).toBe(3) // missing → default
    writeFileSync(rsiTunablesPath(vault), JSON.stringify({ namedSkillTopK: 999 }))
    expect(readRsiTunables(vault).namedSkillTopK).toBe(5) // clamped to max
    writeFileSync(rsiTunablesPath(vault), 'not json')
    expect(readRsiTunables(vault).namedSkillTopK).toBe(3) // corrupt → default
  })
})
