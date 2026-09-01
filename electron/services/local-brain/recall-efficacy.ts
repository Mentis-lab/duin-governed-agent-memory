// recall-efficacy — the JOIN that gives β_conf calibration teeth (WS1 Item 3b).
//
// PROBLEM (verified in the ticket): the recall-candidate kinds — operator facts
// (`context`/`preference`/`correction`/`principle`), `taste`, and `failure` — are a
// DISJOINT namespace from the forecast keyspace `loadKindRates` scores
// (`driver`/`convergence`/`cascade`/`decision-window`). So `loadKindRates().get(fact.kind)`
// misses for every operator memory and β_conf calibration is structurally inert.
//
// This module is the missing ledger: a per-RECALL-kind empirical efficacy rate keyed to
// the recall namespace, in the SAME `KindRate` shape `loadKindRates` returns, so it drops
// straight into `calFactor` as the `kindRates` source.
//
// ── The usefulness signal (SIMPLE + explicit, by design) ─────────────────────────────
// A recalled fact's KIND earns a signed observation from the NEXT operator turn, reusing
// the two signals the brain already trusts (successTick / learnFromTurn):
//   • POSITIVE (useful=1): the next turn ENDORSES the answer that leaned on that recall
//     (`isEndorsement`) — the confirmed items helped, so their kinds proved useful.
//   • NEGATIVE (useful=0): the next turn CORRECTS that answer (`detectCorrection` →
//     polarity 'correction') — the recall preceded a correction, so its kinds bit wrong.
//   • NEITHER: no observation (honest — silence is not evidence).
// Every recall-kind injected on the graded turn shares that turn's single signed
// observation. Gated below CAL_MIN_N (20) → neutral, exactly like the forecast ledger.
//
// This is deliberately COARSE (turn-level attribution across all injected kinds, not
// per-fact credit assignment). A richer signal — per-fact attribution via which bullet
// the model actually cited, or decayed/weighted observations — plugs in at
// `aggregateEfficacy` (change how observations are counted) without touching callers.
// See the `// RICHER-SIGNAL` marker below.
//
// Persistence: append-only jsonl at `.duin/_state/recall-efficacy.jsonl`, single-writer
// (the electron :8799 process), one atomic append per graded turn.

import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { CAL_MIN_N, wilson } from '../brain/calibration-resolve-native'
import type { KindRate } from '../brain/calibration-weight'
import { isEndorsement } from '../brain/success-miner'
import { noteFactEndorsed } from '../brain/operator-model'
import { detectCorrection, runCaptureHook } from '../capture-hook'
import { messageOf } from '../guarded'

/** One signed observation: a recall-kind was injected on a turn that the next turn
 *  then endorsed (useful=1) or corrected (useful=0). */
export interface RecallObservation {
  ts: number
  kind: string
  useful: 0 | 1
}

function ledgerPath(vaultDir: string): string {
  return join(vaultDir, '.duin', '_state', 'recall-efficacy.jsonl')
}

/** Read the raw observation ledger (skipping blank/corrupt lines). Pure fs — missing
 *  file → []. */
export function readObservations(vaultDir: string | null): RecallObservation[] {
  if (!vaultDir) return []
  let text: string
  try {
    text = readFileSync(ledgerPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const out: RecallObservation[] = []
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim()
    if (!ln) continue
    try {
      const o = JSON.parse(ln) as Record<string, unknown>
      const kind = String(o.kind ?? '')
      if (!kind) continue
      out.push({ ts: Number(o.ts ?? 0), kind, useful: o.useful === 1 || o.useful === true ? 1 : 0 })
    } catch (e) { console.debug('[recall-efficacy] skip corrupt line:', messageOf(e)) }
  }
  return out
}

/**
 * Aggregate raw observations → per-kind `KindRate` (rate = useful/observed, gated below
 * minN). PURE — the whole scoring model lives here so a RICHER-SIGNAL (weighting, decay,
 * per-fact credit) is a change to THIS function alone.
 */
export function aggregateEfficacy(obs: RecallObservation[], minN = CAL_MIN_N): Map<string, KindRate> {
  const acc = new Map<string, { useful: number; observed: number }>()
  for (const o of obs) {
    const a = acc.get(o.kind) ?? { useful: 0, observed: 0 }
    a.observed += 1
    a.useful += o.useful
    acc.set(o.kind, a)
  }
  const out = new Map<string, KindRate>()
  for (const [kind, a] of acc) {
    out.set(kind, {
      rate: a.observed > 0 ? a.useful / a.observed : null,
      observed: a.observed,
      gated: a.observed < minN
    })
  }
  return out
}

/** kind → empirical recall-efficacy rate, gated below minN. The `kindRates` source for
 *  `calFactor` in the recall namespace (mirrors `loadKindRates`' contract). Pure fs. */
export function loadRecallEfficacy(vaultDir: string | null, minN = CAL_MIN_N): Map<string, KindRate> {
  return aggregateEfficacy(readObservations(vaultDir), minN)
}

/** One recall kind's efficacy as an RSI fitness engine (same shape as self-improve-fitness's
 *  EngineFitness): `recall-efficacy:<kind>`, Wilson-lower-bound of useful/observed, n, gated<minN. */
export interface RecallEngineFitness {
  engine: string
  score: number | null
  n: number
  gated: boolean
}

/** Per-recall-kind efficacy projected as RSI fitness ENGINES, windowed by [since, until) (ISO dates,
 *  matching self-improve-fitness.readFitnessVector's contract) so a knob change is judged only on the
 *  recall outcomes that resolved AFTER it was applied — a free temporal held-out, exactly like the
 *  calibration domains. This is what lets an RSI knob that moves ONE recall kind (namedSkillTopK →
 *  named-skill breadth, recallFailureLimit → failure breadth) be A/B'd against whether that kind's
 *  measured usefulness actually improved, instead of against the near-circular 'promotion' domain.
 *  Same Wilson-lo + n>=CAL_MIN_N gate as the rest of calibration. PURE fs. */
export function recallEfficacyFitness(
  vaultDir: string | null,
  since?: string,
  until?: string,
  minN = CAL_MIN_N
): RecallEngineFitness[] {
  const sinceMs = since ? Date.parse(since) : NaN
  const untilMs = until ? Date.parse(until) : NaN
  const acc = new Map<string, { useful: number; observed: number }>()
  for (const o of readObservations(vaultDir)) {
    if (!Number.isNaN(sinceMs) && o.ts < sinceMs) continue
    if (!Number.isNaN(untilMs) && o.ts >= untilMs) continue
    const a = acc.get(o.kind) ?? { useful: 0, observed: 0 }
    a.observed += 1
    a.useful += o.useful
    acc.set(o.kind, a)
  }
  const out: RecallEngineFitness[] = []
  for (const [kind, a] of acc) {
    out.push({
      engine: `recall-efficacy:${kind}`,
      score: a.observed > 0 ? wilson(a.useful, a.observed)[0] : null,
      n: a.observed,
      gated: a.observed < minN,
    })
  }
  return out
}

/**
 * Append one signed observation per recall-kind for a graded turn. Single-writer, atomic
 * (one `appendFileSync` = one O_APPEND syscall). Deduplicates kinds so a turn that
 * injected three `preference` facts records `preference` once. Best-effort — never throws
 * into the caller (efficacy accrual must never break a turn).
 */
export function recordRecallOutcome(vaultDir: string | null, kinds: string[], useful: boolean): void {
  if (!vaultDir) return
  const uniq = [...new Set(kinds.map((k) => (k ?? '').trim()).filter(Boolean))]
  if (uniq.length === 0) return
  try {
    const ts = Date.now()
    const lines = uniq.map((kind) => JSON.stringify({ ts, kind, useful: useful ? 1 : 0 } satisfies RecallObservation)).join('\n') + '\n'
    const p = ledgerPath(vaultDir)
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, lines, 'utf-8')
  } catch (e) { console.debug('[recall-efficacy] efficacy accrual is upkeep  never affects the turn:', messageOf(e)) }
}

// ──────────────────── per-thread attribution (the successTick mirror) ────────────────────
// The recall happens on turn N (grounding build); the signal arrives on turn N+1 (the
// operator's reaction). We therefore hold turn N's injected kinds + answer per thread
// until turn N+1 grades them — exactly how successTick holds the prior (query, answer).

interface PriorTurn {
  answer: string
  kinds: string[]
  /** W2 (causal survival credit): the operator-fact ids actually injected on that turn.
   *  A positive grade credits THESE facts via noteFactEndorsed — the per-fact
   *  attribution the header reserves as the RICHER-SIGNAL upgrade. */
  factIds: string[]
}
// A staged slot carries the turn it was built for. `turnKey` is that turn's user message;
// the tick grades with the SAME message as currentUserMsg, so the roll-forward can tell a
// slot staged for THIS turn from the residue of an earlier turn whose tick never ran (an
// aborted/errored/deadline turn skips recallEfficacyTick, stranding its staged kinds). Without
// that check a later turn's tick would roll the stale kinds forward and a turn after THAT would
// fabricate efficacy observations against them. An empty turnKey = unstamped (legacy callers /
// no turn identity) → the roll-forward keeps its old, undiscriminated behaviour.
interface StagedKinds {
  kinds: string[]
  turnKey: string
  /** W2: fact ids injected on the turn being built (parallel to `kinds`; may be empty). */
  factIds: string[]
}
const inflightKinds = new Map<string, StagedKinds>() // kinds injected on the turn being built
const priorByThread = new Map<string, PriorTurn>() // the last completed turn, awaiting its grade
const MAX_THREADS = 200

function evict<T>(m: Map<string, T>): void {
  if (m.size > MAX_THREADS) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
}

/** Called during grounding-build: stash the recall-kinds injected on THIS turn for the
 *  given thread, to be graded by the next turn. `turnKey` (the turn's user message) stamps the
 *  slot so the tick only rolls it forward when grading the SAME turn — see StagedKinds. */
export function stageRecalledKinds(threadId: string, kinds: string[], turnKey = '', factIds: string[] = []): void {
  const key = threadId || 'default'
  inflightKinds.set(key, {
    kinds: [...new Set(kinds.filter(Boolean))],
    turnKey,
    factIds: [...new Set(factIds.filter(Boolean))]
  })
  evict(inflightKinds)
}

/** Classify the next operator turn's reaction to the prior answer. PURE.
 *  'positive' = endorsement · 'negative' = correction · null = no signal.
 *
 *  LANGUAGE PARITY — this is the ledger that feeds β_conf calibration and the RSI fitness
 *  engines, so a bias here does not just lose signal, it teaches the wrong lesson. The two
 *  arms are not symmetric by construction: `isEndorsement` has always carried CJK (对 / 没错 /
 *  很好), while `detectCorrection` was ASCII-only until the capture-hook fix — so a Chinese
 *  session could only ever write useful=1.
 *
 *  The correction arm is tested FIRST, and that ordering is load-bearing rather than
 *  cosmetic. A turn that endorses AND overrides ("对，就是这样，不过以后请先查 OKR Tracker")
 *  is a correction: capture-hook's own rule is that an override outranks a validation when
 *  both fire. Asking `isEndorsement` first let it answer for the whole turn, and because its
 *  NEGATION list carries "but" but not 不过, the English form of that same judgment scored
 *  useful=0 while the Chinese form scored useful=1. Ordering it this way makes the verdict
 *  agree with `detectCorrection` in both scripts instead of depending on which arm was asked
 *  first — and it needs no second, drifting copy of the negation vocabulary here. */
export function classifyOutcome(priorAnswer: string, nextUserMsg: string): 'positive' | 'negative' | null {
  if (detectCorrection(priorAnswer, nextUserMsg).polarity === 'correction') return 'negative'
  if (isEndorsement(nextUserMsg)) return 'positive'
  return null
}

/**
 * THE /agui TURN-BOUNDARY CAPTURE ARROW — what makes Learn hear an UNATTENDED turn.
 *
 * Until now `runCaptureHook` had exactly one call site: electron/ipc/chat.ts, the renderer IPC
 * seam. So a correction typed into the desktop window entered the learn ledger, and the identical
 * correction arriving over a channel, a headless run or a CRON turn did not — the paths DUIN runs
 * WITHOUT a human watching were precisely the ones it never learned from. Everything reaching the
 * brain, from every origin, goes through /agui; this module's tick is already called there (twice:
 * the keyless answer path and the streamed model path), and it already holds the exact pair the
 * capture gate needs — the PRIOR assistant answer and THIS turn's operator message — because that
 * is the same pair it grades recall efficacy on. So the arrow belongs here.
 *
 * Deliberately reads `priorByThread` BEFORE recallEfficacyTick rolls it forward; calling it after
 * would hand capture this turn's own answer as the thing being reacted to.
 *
 * It posts to /learn/correction rather than calling appendCorrection directly, and that indirection
 * is load-bearing rather than lazy: the route does three things beyond the append — the binding
 * falsification sweep, revertByBindingId, and endorsementFact→recordFacts→autoPromoteCandidates. A
 * direct store call would make /agui-origin captures second-class, silently skipping the governed
 * half of the loop. Same process, same server, so it is a local socket hop.
 *
 * Best-effort and fire-and-forget: capture must never be able to affect the turn it observes.
 *
 * KNOWN COUPLING, and it is the one thing to fix next: both call sites sit inside
 * `if (recallCalEnabled())` in server.ts, so `DUIN_RECALL_CAL=0` — a RETRIEVAL-calibration
 * kill-switch — would now also silence learning capture on /agui. The flag defaults ON, so capture
 * fires on a default install, but the coupling is wrong and the fix is one line in server.ts
 * (out of this lane): call `captureTurnBoundary` unconditionally, outside that guard.
 */
export function captureTurnBoundary(threadId: string, currentUserMsg: string, trusted: boolean): void {
  try {
    // INGESTION TRUST. The corrections stream is operator-only by contract — appendCorrection
    // THROWS on a row carrying `source`, so the file has no representation for a non-operator
    // row. That makes trust a gate here, not a tag: an untrusted turn cannot be written in a
    // weaker tier, so it must not be written at all.
    //
    // This guard is the reason the seam exists. Moving capture onto the /agui tick made Learn
    // hear channel, headless and CRON turns — which was the point — but the sibling call four
    // lines above in server.ts (`learnFromTurn(query, answer, execOk)`) had been carrying the
    // trust tier all along and this path was not. A de-privileged inbound turn (channel adapters
    // send execToken:null deliberately) would have been captured as the operator's own teaching,
    // and an endorsement on that path mints an operator-sourced fact that autoPromoteCandidates
    // advances — exactly what operator-model.ts's trust tiering exists to prevent.
    if (!trusted) return
    const prior = priorByThread.get(threadId || 'default')
    if (!prior || !prior.answer.trim()) return // nothing to react TO — capture's own precondition
    void runCaptureHook(prior.answer, currentUserMsg, { session: threadId || 'default' })
  } catch (e) {
    console.debug('[recall-efficacy] capture is best-effort; it must never affect the turn:', messageOf(e))
  }
}

/**
 * End-of-turn tick (call beside successTick): grade the PRIOR turn's recalled kinds by
 * this turn's reaction, then roll THIS turn's staged kinds + answer forward as the new
 * prior. Best-effort. Mirrors successTick's prior/current bookkeeping so the two stay in
 * lock-step. Returns the polarity recorded (for tests/telemetry), or null.
 */
export function recallEfficacyTick(
  vaultDir: string | null,
  threadId: string,
  currentUserMsg: string,
  currentAnswer: string,
  /** Whether this turn carried a valid exec token. Forwarded to captureTurnBoundary, which
   *  refuses to write the operator-only corrections stream for a de-privileged turn. Required,
   *  not defaulted: a default would silently restore the very hole this closes the first time a
   *  new call site forgets it. */
  trusted: boolean
): 'positive' | 'negative' | null {
  const key = threadId || 'default'
  // Learn's capture arrow, fired for EVERY /agui turn — headless, channel and CRON included. Must
  // run before the roll-forward below replaces the prior answer with this turn's. See
  // captureTurnBoundary for why it lives here and what still needs moving in server.ts.
  captureTurnBoundary(key, currentUserMsg, trusted)
  let recorded: 'positive' | 'negative' | null = null
  try {
    const prior = priorByThread.get(key)
    if (prior && prior.kinds.length) {
      const polarity = classifyOutcome(prior.answer, currentUserMsg)
      if (polarity) {
        recordRecallOutcome(vaultDir, prior.kinds, polarity === 'positive')
        recorded = polarity
        // W2 (causal survival credit) — a POSITIVE grade credits the SPECIFIC facts that
        // were injected on the graded turn: they become endorsed-pending, and the next
        // session boundary (noteSession) converts that into an EARNED session tick.
        // Negative grades are deliberately not punished here — the correction itself
        // already flows through capture → /learn/correction → veto/supersede machinery
        // (asymmetry: revocation has its own, faster path). Trust gate: only a trusted
        // turn's endorsement may credit (same tier rule as captureTurnBoundary above —
        // a de-privileged channel turn must not advance any fact toward promotion).
        if (polarity === 'positive' && trusted && prior.factIds.length) {
          noteFactEndorsed(prior.factIds)
        }
      }
    }
  } catch (e) { console.debug('[recall-efficacy] never break the turn:', messageOf(e)) }
  // Roll forward: this turn's injected kinds (staged during grounding) + this answer
  // become the prior awaiting the NEXT turn's grade — but ONLY if the staged slot was built
  // for THIS turn. An aborted/errored/deadline turn skips this tick, so its staged kinds
  // linger in inflightKinds; a later turn's tick would otherwise roll those stale kinds
  // forward and, one endorsement later, fabricate efficacy observations against kinds this
  // turn never recalled. The turnKey stamp (this turn's user message) is the discriminator;
  // an unstamped slot ('') carries no turn identity and keeps the legacy behaviour.
  const staged = inflightKinds.get(key)
  inflightKinds.delete(key)
  const stale = staged !== undefined && staged.turnKey !== '' && staged.turnKey !== currentUserMsg
  const kinds = stale || staged === undefined ? [] : staged.kinds
  const factIds = stale || staged === undefined ? [] : (staged.factIds ?? [])
  if (currentAnswer && currentAnswer.trim()) {
    priorByThread.set(key, { answer: currentAnswer, kinds, factIds })
    evict(priorByThread)
  }
  return recorded
}

/** Test seam — clear the per-thread attribution state. */
export function __resetRecallEfficacy(): void {
  inflightKinds.clear()
  priorByThread.clear()
}
