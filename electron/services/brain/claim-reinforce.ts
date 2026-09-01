// claim-reinforce.ts — store.reinforce-arm: spaced-repetition reinforce (MemoryBank). A claim whose
// backing note was USEFULLY RECALLED — it survived in the grounding hits AND was cited in an answer
// the operator then ENDORSED — gets its age-decay clock reset (markUseful → lastUsefulAt = now), so a
// genuinely-useful memory stays fresh instead of aging out. This is NOT reinforce-on-re-observation
// (explicitly refuted): the trigger is used-and-endorsed, not merely seen-again.
//
// Flow (reuses the substrates DUIN already runs, not a parallel system):
//   turn N grounding → stage the active claims whose notes grounded the answer (activeClaimsForHits,
//     claim-recall.ts) → turn N+1 reaction → if it endorses turn N's answer (recall-efficacy's
//     classifyOutcome, injected), enqueue the staged claims that were CITED in that answer → the
//     claim-metabolism single-writer (metabolize) applies markUseful over the about-to-persist ledger
//     (race-safe: one writer). OPT-IN via DUIN_CLAIM_REINFORCE (default off → byte-identical).
//
// PURE-shaped: imports only markUseful + Claim from claim-metabolism; the endorsement classifier and
// the ledger writer are injected, so it unit-tests headless.

import { markUseful, type Claim } from './claim-metabolism'

/** Opt-in. markUseful only advances a decay clock (monotonic, never retires), but turn-level
 *  attribution is coarse, so the operator opts in — same posture as surprise-gate / govern.cumulative.
 *  Default off ⇒ staging + apply are skipped ⇒ byte-identical ledger. */
export function claimReinforceEnabled(): boolean {
  return process.env.DUIN_CLAIM_REINFORCE === '1'
}

/** A staged claim: its id + its note basename (lowercased), for the cited-in-answer check. */
export interface StagedClaim {
  id: string
  base: string
}
interface Pending {
  items: StagedClaim[]
  answer: string
}
// Per-thread turn state (process-singleton — a thread runs in one process). inflight = staged during
// THIS turn's grounding; prior = last turn's, awaiting this turn's reaction (the N→N+1 roll, mirroring
// recall-efficacy's inflight/prior bookkeeping).
const inflight = new Map<string, Pending>()
const prior = new Map<string, Pending>()
// The reinforcement work-queue, drained by the metabolism single-writer.
let queue = new Set<string>()

/** Stage (during turn N's grounding) the active claims whose notes grounded the answer. */
export function stageReinforcementCandidates(threadId: string, items: StagedClaim[]): void {
  inflight.set(threadId, { items, answer: '' })
}

/**
 * Post-turn roll (turn N+1 reacting to turn N's answer). If THIS user message endorses the PRIOR
 * answer, enqueue the prior turn's staged claims that were actually CITED in it (note basename appears
 * in the endorsed answer text) — the "used + endorsed" signal, stronger than "merely matched". Then
 * roll this turn's staged forward as the next prior. `classify` is injected
 * (recall-efficacy.classifyOutcome) so this module doesn't import the local-brain graph. Returns the
 * count enqueued.
 */
export function reinforceTick(
  threadId: string,
  currentUserMsg: string,
  thisAnswer: string,
  classify: (priorAnswer: string, nextUserMsg: string) => 'positive' | 'negative' | null
): number {
  const p = prior.get(threadId)
  let enq = 0
  if (p && p.items.length && classify(p.answer, currentUserMsg) === 'positive') {
    const ans = p.answer.toLowerCase()
    const cited = p.items.filter((it) => it.base && ans.includes(it.base)).map((it) => it.id)
    if (cited.length) {
      enqueueReinforcement(cited)
      enq = cited.length
    }
  }
  const inf = inflight.get(threadId)
  prior.set(threadId, { items: inf?.items ?? [], answer: thisAnswer })
  inflight.delete(threadId)
  return enq
}

/** Add claim-ids to the pending reinforcement queue. */
export function enqueueReinforcement(claimIds: string[]): void {
  for (const id of claimIds) queue.add(id)
}

/** The single-writer pulls the pending ids and clears the queue (drain-once). */
export function drainReinforcement(): Set<string> {
  const out = queue
  queue = new Set()
  return out
}

/**
 * THE markUseful production caller. markUseful each ACTIVE claim (validTo===null) whose id is in
 * `ids`; returns the count reinforced. Applied by metabolize() over the merged, about-to-persist
 * ledger — the claim-metabolism single writer, so there is no cross-writer race. Never touches a
 * retired claim (only-active guard). An empty `ids` (feature off / nothing endorsed) is a no-op.
 */
export function applyReinforcement(claims: Claim[], ids: Set<string>, now: number): number {
  if (ids.size === 0) return 0
  let n = 0
  for (const c of claims) {
    if (c.validTo === null && ids.has(c.id)) {
      markUseful(c, now)
      n++
    }
  }
  return n
}

/** Test-only: clear all turn state + the queue. */
export function __resetClaimReinforce(): void {
  inflight.clear()
  prior.clear()
  queue = new Set()
}
