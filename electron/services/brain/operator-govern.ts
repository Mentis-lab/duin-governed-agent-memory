// operator-govern — the earned-autonomy GOVERN loop for operator facts (the moat
// currency). Upgrades the single human promote-gate into a dual-verifier that CONFIRMS
// a provisional rule only once it has earned trust, and AUTO-REVERTS on a miss.
//
// Asymmetric by construction (granted slowly, revoked fast):
//   Verifier 1 — SURVIVAL: the fact lived through N distinct sessions on probation
//                without a human re-correction (a re-correction would veto it, so
//                survival is the recurrence-clean proxy).
//   Verifier 2 — JURY: an INDEPENDENT check (LLM, distinct role) that the rule still
//                holds and doesn't contradict a confirmed rule.
//   confirm iff (survived ≥ min) AND jury-pass ; revert iff jury-fail ; else hold.
// Keyless (no engine → no jury): survival ALONE can confirm, on a longer bar.
//
// governDecision is PURE + unit-tested; runGovernPass applies it via an injected jury.
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { chatOnce, routeModel, routeDistinctModels, getProviderForModel } from '../providers/registry'
import { firewallClear } from '../governance/confidential-firewall'
import { recordNotice, resolveByActionId } from '../proactive/notices-store'
import {
  listByStatus,
  isFactLive,
  confirmFact,
  revertFact,
  parseOperatorFacts,
  recordGovernProvenance,
  type OperatorFact
} from './operator-model'

export interface GovernEvidence {
  /** Distinct sessions survived on probation (Verifier 1). */
  sessionsObserved: number
  /** W2 (causal survival credit) — sessions in which the fact was RETRIEVED and the turn
   *  ENDORSED (earned-in-use, always ⊆ sessionsObserved). `undefined` = the earned bar
   *  does not apply to this fact (legacy probation predating the field, or the
   *  DUIN_CAUSAL_CREDIT flag is off) → the legacy tenure rule stands. The caller
   *  (runGovernPass) owns that discrimination so this decision stays pure. */
  earnedSessions?: number
  /** Independent jury verdict (Verifier 2). null = jury couldn't run (no engine). */
  juryPass: boolean | null
  /** Held-out BEHAVIORAL oracle (Verifier 3, item 14): did the measured A/B show the rule
   *  changes output? true = flips (keep), false = measured no-lift (blocks confirm → hold),
   *  null/undefined = unmeasured (abstain — never blocks). */
  behavioralFlip?: boolean | null
  /** Schema-graft BACKTEST (Verifier 4, epicycle-reject): replayed against RESOLVED forecasts,
   *  does this fact only coincidentally fit a prediction reality REFUTED? false = epicycle
   *  (blocks confirm → hold, never revert — additive like behavioralFlip); null/undefined =
   *  abstain (no resolved evidence — never blocks). */
  backtestPass?: boolean | null
}

export interface GovernPolicy {
  /** Survival bar to confirm WITH a passing jury. */
  minSessions: number
  /** Longer survival bar to confirm on survival ALONE when no jury is available. */
  minSessionsKeyless: number
  /** W2 — earned-in-use bar (retrieved + endorsed sessions) required on the KEYED confirm
   *  path when the evidence carries an earned count. The keyless branch is not earned-gated
   *  — it cannot be, a keyless install may never grade recalls — but since W3 it no longer
   *  auto-confirms either: bar met → outcome 'ratify' (park + one Needs-you card), so keyless
   *  promotion runs through the operator instead of through tenure. Optional so pre-W2 policy
   *  literals stay valid; absent falls back to 2 — the STRICT direction, so an old literal
   *  can never accidentally waive the bar (safe-default polarity, property 8). */
  minEarnedSessions?: number
}

export const DEFAULT_GOVERN_POLICY: GovernPolicy = { minSessions: 2, minSessionsKeyless: 4, minEarnedSessions: 2 }

/** W2 flag — default ON; '0' disables the earned-in-use requirement (accrual continues either way). */
export function causalCreditEnabled(): boolean {
  return process.env.DUIN_CAUSAL_CREDIT !== '0'
}

/** W2 epoch — probations STARTED before this ship date are legacy: they accrued tenure under
 *  the old rule and holding them to a bar that did not exist would freeze the whole pool
 *  behind ticks nobody was recording. Facts entering probation after it must EARN. */
export const CAUSAL_CREDIT_EPOCH = Date.parse('2026-08-15T00:00:00+08:00')

/** Epoch resolver with an explicit override (DUIN_CAUSAL_CREDIT_EPOCH_MS) — the override
 *  exists for tests and for an operator deliberately re-baselining; unset/blank falls back
 *  to the shipped constant (explicit parse so '0' is honored — unset ≠ zero, property 8). */
export function causalCreditEpochMs(): number {
  const raw = process.env.DUIN_CAUSAL_CREDIT_EPOCH_MS
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return CAUSAL_CREDIT_EPOCH
}

/** 'ratify' (W3, posture 2026-08-21): the keyless survival bar was met but nothing verified the
 *  fact — the machine's honest answer is ASK, not confirm. The caller parks the fact and files
 *  one deduped Needs-you card; DUIN_CAUSAL_CREDIT=0 maps it back to the legacy confirm. */
export type GovernOutcome = 'confirm' | 'revert' | 'hold' | 'ratify'

/** The asymmetric dual-verifier decision. PURE. */
export function governDecision(
  ev: GovernEvidence,
  policy: GovernPolicy = DEFAULT_GOVERN_POLICY
): GovernOutcome {
  // Demotion is instant + automatic (the safe direction): the jury rejected it.
  if (ev.juryPass === false) return 'revert'
  // A measured no-lift (behavioralFlip === false, item 14) OR an epicycle backtest verdict
  // (backtestPass === false, Schema graft) BLOCKS confirmation (→ hold, never revert — additive,
  // not a new wall). Unmeasured/abstained (undefined/null) never blocks, so old behavior holds.
  const blocks = ev.behavioralFlip === false || ev.backtestPass === false
  // W2 — the earned-in-use bar (causal survival credit): when the evidence carries an
  // earned count, tenure alone cannot confirm — the fact must have been retrieved AND
  // endorsed in >= minEarnedSessions distinct sessions. `undefined` = bar not applicable
  // (legacy probation / flag off) → legacy behavior, byte-identical.
  const earnedOk = ev.earnedSessions === undefined || ev.earnedSessions >= (policy.minEarnedSessions ?? 2)
  // Promotion is slow + gated: survived the window AND an independent verifier passed.
  if (ev.juryPass === true && ev.sessionsObserved >= policy.minSessions && !blocks && earnedOk) return 'confirm'
  // Keyless: no jury ran — a fresh keyless install, OR a confidential fact that firewall-abstained
  // on a keyed one. Until W3 this branch CONFIRMED on the longer tenure bar alone, on the stated
  // premise that "a bar keyless cannot meet would mean keyless DUIN can never promote anything."
  // That premise dissolved when the ratify surface shipped (W2): keyless promotes THROUGH the
  // operator now. Bar met → 'ratify' (park + ask), never a silent confirm; the caller maps it
  // back to legacy confirm under the DUIN_CAUSAL_CREDIT=0 kill-switch.
  if (ev.juryPass === null && ev.sessionsObserved >= policy.minSessionsKeyless && !blocks) return 'ratify'
  return 'hold'
}

/** Verifier 3 (item 14): map a fact's persisted A/B efficacy to a behavioral-flip signal.
 *  keep → true (changes output), prune-candidate → false (no lift), else null (unmeasured). */
export function behavioralFlipFromEfficacy(f: OperatorFact): boolean | null {
  const v = f.efficacy?.verdict
  if (v === 'keep') return true
  if (v === 'prune-candidate') return false
  return null
}

/** Schema-graft BACKTEST helper (PURE, deterministic — no LLM). Replays a candidate fact against
 *  RESOLVED forecasts: token-set Jaccard overlap ≥ 0.6 with a prediction whose resolution === 'miss'
 *  (reality REFUTED it) ⇒ 'epicycle' (the belief only coincidentally fit something reality broke).
 *  No resolved rows or no high-overlap miss ⇒ 'abstain' (default — NEVER over-blocks). Mirrors the
 *  Schema `recurrence_hits` "coincidental fit" reject, conservatively. */
const _btTokens = (s: string): Set<string> =>
  new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2))
function _btJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
export function backtestFact(
  factText: string,
  resolved: { predicted: string; resolution: string }[]
): { verdict: 'epicycle' | 'clear' | 'abstain'; conflictsWith?: string } {
  const ft = _btTokens(factText)
  if (!ft.size || !resolved.length) return { verdict: 'abstain' }
  let best: { overlap: number; predicted: string } | null = null
  for (const r of resolved) {
    if ((r.resolution || '').toLowerCase() !== 'miss') continue
    const ov = _btJaccard(ft, _btTokens(r.predicted))
    if (ov >= 0.6 && (!best || ov > best.overlap)) best = { overlap: ov, predicted: r.predicted }
  }
  return best ? { verdict: 'epicycle', conflictsWith: best.predicted } : { verdict: 'abstain' }
}

/** Load RESOLVED forecast rows (resolution set) from the vault's risk-predictions ledger, mapped
 *  to {predicted, resolution}. Best-effort — missing/corrupt file ⇒ [] (so the backtest abstains). */
export function loadResolvedForecasts(vaultDir: string): { predicted: string; resolution: string }[] {
  try {
    const p = join(vaultDir, '.duin', '_state', 'risk-predictions.jsonl')
    if (!existsSync(p)) return []
    const out: { predicted: string; resolution: string }[] = []
    for (const line of readFileSync(p, 'utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const r = JSON.parse(line) as Record<string, unknown>
        const res = typeof r.resolution === 'string' ? r.resolution : ''
        const pred = typeof r.predicted === 'string' ? r.predicted : ''
        if (res && pred) out.push({ predicted: pred, resolution: res })
      } catch { /* skip corrupt line */ }
    }
    return out
  } catch {
    return []
  }
}

/** Item 15: the jury's provenance alongside its verdict — which model actually voted + whether
 *  it was a genuinely cross-family second opinion. */
export interface JuryResult {
  pass: Set<string> | null
  juryModelId: string | null
  juryProvider: string | null
  crossModel: boolean
}

/** Verifier 2 provider: returns the passing fact-ID set, null when the jury couldn't run (no
 *  engine), or a JuryResult carrying provenance. */
export type GovernJury = (provisional: OperatorFact[]) => Promise<Set<string> | null | JuryResult>

/** Normalize any GovernJury return into {pass, meta}. Bare Set/null carry no provenance. */
function normalizeJury(r: Set<string> | null | JuryResult): {
  pass: Set<string> | null
  meta: { juryModelId: string | null; juryProvider: string | null; crossModel: boolean }
} {
  if (r && typeof r === 'object' && !(r instanceof Set) && 'pass' in r) {
    return { pass: r.pass, meta: { juryModelId: r.juryModelId, juryProvider: r.juryProvider, crossModel: r.crossModel } }
  }
  return { pass: r as Set<string> | null, meta: { juryModelId: null, juryProvider: null, crossModel: false } }
}

export interface GovernPassResult {
  confirmed: number
  reverted: number
  held: number
  /** W3 — keyless candidates that met the survival bar and now wait on the operator
   *  (parked provisional; surfaced as one deduped Needs-you card → Learning surface). */
  awaitingRatify: number
}

// One card, not a pile (posture I4): announce only when the pending count CHANGES, and
// self-resolve the card on the first pass that finds the queue empty. Process-lifetime
// state — a re-announce once per boot is acceptable; a re-bump every 30-min governTick
// over an unchanged queue is nagging, which is exactly what this exists to prevent.
let lastKeylessRatifyCount = 0
/** Test seam. */
export function __resetKeylessRatifyAnnounce(): void {
  lastKeylessRatifyCount = 0
}

/** Run one govern pass over every provisional fact: gather evidence (survival +
 *  jury), decide, and apply (confirm → promoted / revert → reverted / hold). */
export async function runGovernPass(
  jury: GovernJury,
  policy: GovernPolicy = DEFAULT_GOVERN_POLICY,
  opts: { resolvedForecasts?: { predicted: string; resolution: string }[] } = {}
): Promise<GovernPassResult> {
  // BITEMPORAL LIVENESS. `listByStatus` keys on STATUS ALONE, and supersedeFact retires a fact by
  // stamping `invalidatedAt` while deliberately LEAVING `status` intact (soft-delete, so the audit
  // can walk why a rule fell). A provisional fact the operator has since CORRECTED therefore stays
  // in this list forever — and every ~30 min governTick re-adjudicated it. Its observedSessions are
  // already past the bar (noteSession keeps bumping retired rows), so the keyless branch confirms
  // it, confirmFact flips it to 'promoted', and the materialize seam re-writes the concept file
  // that supersedeFact's `fireMaterialize(old,'retire')` had just moved to `.brain/_retired/`.
  // DUIN resumes asserting the corrected-away rule, unattended.
  //
  // What made it invisible: retiring a fact removes it from every surface an operator can SEE —
  // buildOperatorBlock's `active` helper stops grounding it, the concept file leaves the memory
  // lane — while never touching the one field this reader consulted. So the row looked gone
  // everywhere except here, and the resurrection presented as the govern loop working correctly.
  const prov = listByStatus('provisional').filter(isFactLive)
  if (prov.length === 0) {
    settleKeylessRatifyCard(0)
    return { confirmed: 0, reverted: 0, held: 0, awaitingRatify: 0 }
  }
  // Schema-graft BACKTEST evidence: resolved forecasts are supplied by the caller ONLY when
  // DUIN_GOVERN_BACKTEST is on (see governTick). Empty ⇒ every fact abstains ⇒ zero behavior change.
  const resolved = opts.resolvedForecasts ?? []
  // Confidential-lane firewall: a fact carrying confidential content must NOT reach the
  // external jury. It ABSTAINS (juryPass = null → keyless survival path), never fails —
  // "couldn't verify" is not "failed", so it must not be auto-reverted.
  const confidentialIds = new Set(prov.filter((f) => !firewallClear(f.fact)).map((f) => f.id))
  const provClear = prov.filter((f) => !confidentialIds.has(f.id))
  let juryRaw: Set<string> | null | JuryResult
  try {
    juryRaw = provClear.length ? await jury(provClear) : null
  } catch {
    juryRaw = null
  }
  const { pass: juryPassIds, meta: juryMeta } = normalizeJury(juryRaw)
  let confirmed = 0
  let reverted = 0
  let held = 0
  let awaitingRatify = 0
  for (const f of prov) {
    const juryPass = confidentialIds.has(f.id) ? null : juryPassIds === null ? null : juryPassIds.has(f.id)
    const behavioralFlip = behavioralFlipFromEfficacy(f)
    const backtestPass = resolved.length
      ? (backtestFact(f.fact, resolved).verdict === 'epicycle' ? false : null)
      : null
    // W2 — the earned bar applies only on the KEYED path, to facts whose probation started
    // after the field shipped (legacy probations keep the tenure rule they accrued under),
    // and only while DUIN_CAUSAL_CREDIT is on. Off/legacy/keyless → undefined → pure legacy.
    const requireEarned =
      causalCreditEnabled() && juryPass === true && (f.provisionalAt ?? 0) >= causalCreditEpochMs()
    const earned = f.earnedSessions?.length ?? 0
    const outcome = governDecision(
      {
        sessionsObserved: f.observedSessions?.length ?? 0,
        earnedSessions: requireEarned ? earned : undefined,
        juryPass,
        behavioralFlip,
        backtestPass
      },
      policy
    )
    // W3: 'ratify' = keyless bar met → ASK, don't confirm. The fact stays provisional
    // (already visible on the Learning surface, where promote/revert exist); one deduped
    // card is settled after the loop. Kill-switch DUIN_CAUSAL_CREDIT=0 maps it back to the
    // legacy keyless auto-confirm — and the provenance row stamps the EFFECTIVE verdict,
    // so the audit never claims an ask that was actually an auto-confirm (or vice versa).
    const effective = outcome === 'ratify' && !causalCreditEnabled() ? 'confirm' : outcome
    if (effective === 'confirm') {
      confirmFact(f.id)
      confirmed++
    } else if (effective === 'revert') {
      revertFact(f.id)
      reverted++
    } else if (effective === 'ratify') {
      awaitingRatify++
    } else {
      held++
    }
    // A confidential fact never reached the jury (firewall-abstained) — don't stamp it with the
    // clear-pool's jury model; that would overstate independence in the govern audit.
    const prov = confidentialIds.has(f.id)
      ? { juryModelId: null, juryProvider: null, crossModel: false }
      : { juryModelId: juryMeta.juryModelId, juryProvider: juryMeta.juryProvider, crossModel: juryMeta.crossModel }
    recordGovernProvenance(f.id, {
      ...prov,
      verdict: effective,
      behavioralFlip,
      ts: Date.now(),
      // W2 audit row — earned-in-use vs raw tenure at decision time (the acceptance
      // evidence: a fact never retrieved shows earned 0 and cannot cross the keyed bar).
      earned,
      observed: f.observedSessions?.length ?? 0
    })
  }
  settleKeylessRatifyCard(awaitingRatify)
  return { confirmed, reverted, held, awaitingRatify }
}

/** File / refresh / clear the ONE keyless-ratify card. Announce only when the pending count
 *  changed (a steady queue re-bumped every governTick is nagging); resolve on the first pass
 *  that finds the queue empty, so the card can never rot into a guilt pile (posture I4).
 *  Best-effort: the inbox is an affordance, never a precondition for governing. */
function settleKeylessRatifyCard(pending: number): void {
  if (pending === lastKeylessRatifyCount) return
  try {
    if (pending > 0) {
      recordNotice({
        kind: 'approval',
        severity: 'info',
        needsDecision: true,
        title: pending === 1 ? 'A candidate belief awaits your review' : `${pending} candidate beliefs await your review`,
        body: 'Met the survival bar with no jury to verify — promote or revert in the Learning panel.',
        actionId: 'govern:keyless-review',
        dedupKey: 'govern:keyless-review',
        deepLink: 'duin://tool/learning'
      })
    } else {
      resolveByActionId('govern:keyless-review')
    }
  } catch {
    /* inbox write is best-effort */
  }
  lastKeylessRatifyCount = pending
}

const JURY_SYSTEM =
  'You are an INDEPENDENT verifier — NOT the extractor, NOT the operator. Given RULES ' +
  'already confirmed and CANDIDATE rules on probation, return a JSON array of only the ' +
  'candidate strings (verbatim) that are DURABLE, still hold, and do NOT contradict a ' +
  'confirmed rule. A rule that is vague, situational, or conflicting must be OMITTED.'

const juryNorm = (s: string): string => s.toLowerCase().replace(/[.?!]+$/, '').replace(/\s+/g, ' ').trim()

/** Default Verifier 2 — a key-gated LLM in an INDEPENDENT role, batched over the
 *  probation pool. No engine → null (the decision falls back to keyless survival). */
/** How many independent model families vote. 1 restores the pre-panel single-juror behavior. */
const JURY_PANEL_SIZE = ((): number => {
  // Explicit parse rather than `Number(env) || 3`: an operator reading `Math.max(1, …)` expects
  // DUIN_JURY_PANEL=1 to mean one juror, and the falsy-OR idiom would hand back 3 for `0` while
  // honouring `1` — inconsistent in the one place the value is a deliberate choice.
  const raw = process.env.DUIN_JURY_PANEL
  if (raw === undefined || raw.trim() === '') return 3
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 3
})()

/** One juror's ballot: the fact-ids it endorsed, or null when it ABSTAINED (no reply, parse-miss,
 *  error, or a reply too partial to trust). Abstain is never a vote to revert. */
async function runOneJuror(
  juryModel: string,
  provisional: OperatorFact[],
  confirmed: string[]
): Promise<Set<string> | null> {
  try {
    const r = await chatOnce(
      [
        { role: 'system', content: JURY_SYSTEM },
        {
          role: 'user',
          content:
            `RULES (confirmed):\n${confirmed.join('\n') || '(none)'}\n\n` +
            `CANDIDATES (on probation):\n${provisional.map((f) => f.fact).join('\n')}`
        }
      ],
      juryModel,
      undefined,
      { purpose: 'other', role: 'operator-govern-jury' }
    )
    // Parse the keep-list UNCAPPED (bounded by the pool itself). parseOperatorFacts defaults to 8 for
    // the extraction prompt, and inheriting that here was a live data-loss bug: the jury's semantics make
    // omission mean REVERT, so a valid reply endorsing 14 facts was silently cut to 8 and the remaining 6
    // were reverted — on a CORRECT reply, every pass, with no error anywhere.
    const parsed = parseOperatorFacts(r.content, provisional.length)
    // Parse-miss / malformed reply → ABSTAIN (null), never fail-all. An empty parse must NOT mark
    // every provisional fact juryPass=false → mass-revert (the poisoning bug: one flaky reply
    // reverts the whole probation pool + bumps revert-counters). A genuine per-fact fail still
    // reverts — the jury parses SOME passes and omits that one; "couldn't verify" ≠ "failed".
    if (parsed.length === 0) return null
    const keep = new Set(parsed.map(juryNorm))
    const pass = new Set<string>()
    for (const f of provisional) if (keep.has(juryNorm(f.fact))) pass.add(f.id)
    // MASS-REVERT GUARD. The reasoning above ("omission = a genuine per-fact fail") only holds while the
    // reply is COMPLETE. Nothing here can distinguish a jury that rejected most of the pool from one that
    // answered about a prefix of it — a model listing 3 of 14, a provider truncating mid-array but still
    // closing it, or a paraphrase that defeats juryNorm's lowercase/punctuation-only matching. Those look
    // identical to mass rejection, and reverting is not cheap: it drops the fact from grounding, bumps
    // `reverts`, blocks re-linking via recordBoundRule, and marks it evictable churn for permanent
    // deletion at MAX_FACTS. A real jury rejecting MOST of a human-endorsed pool in one pass is the
    // extraordinary case; a partial reply is the ordinary one. So abstain and let survival-based
    // confirmation continue, exactly as the empty-parse branch does. Tighten-only: this can only ever
    // revert FEWER facts, never more, and a genuine minority rejection still passes through untouched.
    if (provisional.length > 1 && pass.size * 2 < provisional.length) return null
    return pass
  } catch {
    return null
  }
}

/** Default Verifier 2 — a PANEL of key-gated LLMs in an independent role, batched over the
 *  probation pool. No engine → null (the decision falls back to keyless survival). */
export async function defaultGovernJury(provisional: OperatorFact[]): Promise<JuryResult> {
  const model = routeModel('extraction')
  if (!model || provisional.length === 0) return { pass: null, juryModelId: null, juryProvider: null, crossModel: false }
  // Cross-model jury (item 4): route the second opinion AROUND the extractor's provider so it's a
  // genuinely independent FAMILY, not one model wearing two hats.
  //
  // It is now a PANEL rather than one model. A single juror is a single point of failure whose
  // verdict is binding — `governDecision` reverts instantly on juryPass === false — so its flakiness
  // is spent directly on the operator's facts. On the live brain that is not hypothetical: 89 of 197
  // facts sit reverted, and the campaign traced the verdicts behind them to one flaky model.
  const extractorProvider = getProviderForModel(model)
  const panel = routeDistinctModels(new Set([extractorProvider]), 'extraction', JURY_PANEL_SIZE)
  // Single-provider install: fall back to the extractor model, exactly as before. The same-model
  // check is preserved, just not claimed independent.
  if (panel.length === 0) panel.push(model)
  const providers = panel.map((m) => getProviderForModel(m))
  const meta = {
    juryModelId: panel.join('+'),
    juryProvider: providers.join('+'),
    // Independent iff no juror shares the extractor's family. A one-model panel that fell back to
    // the extractor is the honest false here.
    crossModel: providers.every((p) => p !== extractorProvider)
  }
  // Never send confidential confirmed rules as context to the external jury either.
  //
  // BITEMPORAL LIVENESS — the same trap as `prov` in runGovernPass above, and as the verifyPool
  // sibling in operator-model that ships this identical two-list payload. `listByStatus` keys on
  // STATUS ALONE, while supersedeFact retires a rule by stamping `invalidatedAt` and deliberately
  // LEAVING `status: 'promoted'` (soft-delete, so the audit can walk why a rule fell). A retired
  // rule therefore stays in this list FOREVER, and shipping it under the literal header
  // `RULES (confirmed)` turns JURY_SYSTEM's "do NOT contradict a confirmed rule" against the
  // operator's own correction: told the dead rule still holds, the jurors dutifully OMIT the
  // replacement fact that superseded it — and omission from this keep-list means REVERT. So the
  // corrected-away rule auto-reverts its own successor on the next governTick, unattended, and
  // 'reverted' is remembered precisely so the fact isn't blindly re-promoted. A single stale
  // omission also hides under the mass-revert guard (`pass.size * 2 < provisional.length`), which
  // only trips on a majority — so the destructive path stays wide open for exactly this case.
  //
  // What made it invisible: retiring a rule removes it from every surface an operator can SEE
  // (buildOperatorBlock's `active` helper stops grounding it, the concept file moves to
  // `.brain/_retired/`) while never touching the one field this reader consulted.
  const confirmed = listByStatus('promoted')
    .filter(isFactLive)
    .map((f) => f.fact)
    .filter((t) => firewallClear(t))

  const ballots = await Promise.all(panel.map((m) => runOneJuror(m, provisional, confirmed)))
  const responded = ballots.filter((b): b is Set<string> => b !== null)
  // Every juror abstained → the panel could not run. Same as the old single-juror abstain: the
  // decision falls through to the keyless survival bar rather than reverting anything.
  if (responded.length === 0) return { pass: null, ...meta }

  // A fact is REVERTED only when a MAJORITY of responding jurors omit it; ties keep it.
  //
  // Ties deliberately favor not-reverting, for the same reason the guards above abstain: reverting
  // is the destructive direction — it drops the fact from grounding, bumps `reverts`, blocks
  // re-linking, and marks the fact evictable — while a wrongly-kept fact simply stays on probation
  // and faces the panel again next pass. With one responder this is byte-identical to the previous
  // behavior, so a single-key install is unaffected; with more, it can only ever revert FEWER facts
  // than any single juror would alone. That asymmetry is the entire point: one flaky ballot can no
  // longer spend a fact.
  const pass = new Set<string>()
  for (const f of provisional) {
    const keeps = responded.reduce((n, b) => n + (b.has(f.id) ? 1 : 0), 0)
    if (keeps * 2 >= responded.length) pass.add(f.id)
  }
  // The mass-revert guard again, on the COMBINED verdict: independent jurors can each pass their own
  // partial-reply check and still agree on a prefix, which looks identical to the panel rejecting
  // most of a human-endorsed pool.
  if (provisional.length > 1 && pass.size * 2 < provisional.length) return { pass: null, ...meta }
  return { pass, ...meta }
}
