// exemption.mjs — L2, always last: did the suite teach the brain? After every turn, the isolated
// instance's operator-model.json must hold 0 new candidates, notices.json no belief notice, and
// the vault's corrections stream no new row (W10: "a bench run leaves 0 candidates, 0 taste rows,
// 0 notices"). `unverified` until lane A honours x-duin-bench (detected via TURN_START.bench).

import { res, unverified } from '../lib/probe-utils.mjs'

export const name = 'exemption'
export const lane = 'L2'

export async function run(ctx) {
  const base = ctx.baseline
  const now = ctx.readLearningState()
  const newFacts = now.facts.filter((f) => !base.factIds.has(f.id))
  const newCandidates = newFacts.filter((f) => f.status === 'candidate' || f.status === 'provisional')
  const newBeliefNotices = Math.max(0, now.beliefNotices - base.beliefNotices)
  const newCorrections = Math.max(0, now.corrections - base.corrections)
  const observedPass = newCandidates.length === 0 && newBeliefNotices === 0 && newCorrections === 0
  const honored = ctx.benchHonored()
  const evidence = {
    benchHeaderHonored: honored,
    turns: ctx.threadIds.size,
    newFacts: newFacts.length,
    newCandidates: newCandidates.slice(0, 5).map((f) => `${f.status}/${f.source ?? 'operator'}: ${String(f.fact).slice(0, 70)}`),
    newBeliefNotices,
    newCorrections
  }
  if (!honored) return [unverified('bench_exemption', observedPass, evidence, 'lane A (x-duin-bench → learning/taste/turn-beat off, journal bench:true) has not landed')]
  return [res('bench_exemption', observedPass, evidence)]
}
