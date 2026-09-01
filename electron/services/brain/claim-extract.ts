// claim-extract — Phase 0 substrate: turn DUIN's existing STRUCTURED state into Claim rows the
// metabolism can judge. Deliberately DETERMINISTIC + grafted onto what already exists (decisions,
// streams) rather than LLM triple-extraction of prose — so the ledger fills with note-backed,
// judgeable claims at zero model cost, and the world-state judge produces real verdicts on the
// live vault immediately (a resolved decision's open-question claim → stale). Model-based prose
// extraction (arbitrary note chunks → triples) is the later enrichment, not this first cut.
//
// Each claim carries the source id in `justifications` so the world-state gatherer's temporal
// rule fires (resolvedDecisions.has(decId) / passedStreams.has(streamId) ⇒ stale).

import type { Claim, Correction } from './claim-metabolism'
import { classifyMutability, runVerdicts, isPinned, unretire, applySupersessionGuards } from './claim-metabolism'
import { parseDateMs, loadLedger, saveLedger, gatherWorldState } from './claim-ledger'
import { listDecisions } from './decisions-native'
import { loadFutures } from './causal-substrate'
import { anchors } from './anchors-native'
import type { ConstructedData } from './types'
import { getConstruction } from './construct'
import { annotateEntityKeys, entityResolveEnabled } from './claim-entities'
import { proseTripleClaimId } from './claim-ids'
import { applyReinforcement, drainReinforcement, claimReinforceEnabled } from './claim-reinforce'
import { messageOf } from '../guarded'

/** Prose-claim flag. Default ON: the LLM-inferred construction graph is bridged into the ledger as
 *  first-class (proposal-contained) triples, so prose is a PRIMARY substrate, not opt-in — and it
 *  degrades to a no-op when no construction exists. DUIN_CLAIM_PROSE=0 disables (structured only). */
export function claimProseEnabled(): boolean {
  return process.env.DUIN_CLAIM_PROSE !== '0'
}

/**
 * Bridge the LLM-inferred knowledge graph (construct.ts — the "build my brain" prose→entities+edges
 * pass) into judgeable Claim rows: each typed edge {source, target, type} becomes a prose S-R-O
 * triple claim (subject = source entity label, relation = edge type, object = target entity label),
 * carrying the source entity's note as provenance so the temporal/JTMS rules can fire. Marked
 * `source:'prose'` so a wrong triple can never DURABLY supersede a real claim (runVerdicts emits a
 * prose-driven supersession as a proposal). PURE given the construction.
 */
export function constructionClaims(c: ConstructedData | null, now = Date.now()): Claim[] {
  const edges = Array.isArray(c?.edges) ? c!.edges : []
  const tripleRows = Array.isArray(c?.triples) ? c!.triples : []
  if (!c || (!edges.length && !tripleRows.length)) return []
  const byId = new Map((c.entities ?? []).map((e) => [e.id, e]))
  const label = (id: string): string => byId.get(id)?.label ?? id
  const out: Claim[] = []
  const seen = new Set<string>()
  for (const e of edges) {
    if (!e || !e.source || !e.target || e.source === e.target) continue
    const subject = label(e.source).trim()
    const object = label(e.target).trim()
    const relation = String(e.type ?? '').trim()
    if (!subject || !object || !relation) continue
    // Escape the `|` delimiter in each part so two distinct edges can't collide to one id.
    const enc = (s: string): string => s.replace(/\|/g, '%7C')
    const id = `prose:${enc(e.source)}|${enc(relation)}|${enc(e.target)}`
    if (seen.has(id)) continue
    seen.add(id)
    const note = byId.get(e.source)?.note ?? byId.get(e.target)?.note ?? ''
    out.push({
      id,
      chunkId: id,
      notePath: note,
      subject,
      relation,
      object,
      validFrom: now,
      validTo: null,
      observedAt: now,
      supersededBy: null,
      mutability: classifyMutability(relation),
      justifications: note ? [note] : [],
      verdict: 'current',
      verdictBy: null,
      source: 'prose'
    })
  }

  // OPEN-VOCABULARY triples (construct.ts triple pass) — arbitrary subject/relation/object facts
  // lifted from prose, not the fixed entity-edge vocabulary. The Graphiti-style S-R-O layer.
  for (const t of tripleRows) {
    const subject = (t.subject ?? '').trim()
    const object = (t.object ?? '').trim()
    const relation = (t.relation ?? '').trim()
    if (!subject || !object || !relation) continue
    const note = (t.note ?? '').trim()
    // NOTE is part of the key: two notes asserting the same subject-relation-object (e.g. one
    // current, a later one retiring it) must NOT collide to one row — otherwise the second's
    // validUntil + provenance is silently dropped and the claim stays 'current' forever. Mirrors
    // construct.ts's own subject∥relation∥object∥note triple dedup. See claim-ids.ts.
    const id = proseTripleClaimId(subject, relation, object, note)
    if (seen.has(id)) continue
    seen.add(id)
    // LLM-EXTRACTED bitemporal validity (Graphiti-style): validFrom = when the fact became true;
    // validUntil already in the PAST ⇒ the claim is born already-retired ('stale' by 'temporal', a
    // deterministic verdict → persisted). Absent dates default to observed-now / still-valid.
    const vFrom = parseDateMs(t.validFrom ?? null) ?? now
    const vUntil = parseDateMs(t.validUntil ?? null)
    const bornRetired = vUntil !== null && vUntil < now
    out.push({
      id,
      chunkId: id,
      notePath: note,
      subject,
      relation,
      object,
      validFrom: vFrom,
      validTo: bornRetired ? vUntil : null,
      observedAt: vFrom,
      supersededBy: null,
      mutability: classifyMutability(relation),
      justifications: note ? [note] : [],
      verdict: bornRetired ? 'stale' : 'current',
      verdictBy: bornRetired ? 'temporal' : null,
      source: 'prose'
    })
  }
  return out
}

function decisionClaims(
  decisions: { id: string; title?: string; status?: string; date?: string }[],
  now: number
): Claim[] {
  return decisions.map((d) => {
    const observedAt = parseDateMs(d.date) ?? now
    return {
      id: `dec:${d.id}`,
      chunkId: `dec:${d.id}`,
      notePath: d.id,
      subject: (d.title || d.id).trim(),
      relation: 'under-decision',
      object: (d.status || 'open').trim(),
      validFrom: observedAt,
      validTo: null,
      observedAt,
      supersededBy: null,
      mutability: classifyMutability('under-decision'),
      justifications: [d.id], // ← lets the temporal rule fire when this decision resolves
      verdict: 'current',
      verdictBy: null
    }
  })
}

function streamClaims(
  streams: { id?: string; title?: string; status?: string }[],
  now: number
): Claim[] {
  const out: Claim[] = []
  for (const s of streams) {
    if (!s.id) continue
    out.push({
      id: `stream:${s.id}`,
      chunkId: `stream:${s.id}`,
      notePath: s.id,
      subject: (s.title || s.id).trim(),
      relation: 'stream-status',
      object: (s.status || 'active').trim(),
      validFrom: now,
      validTo: null,
      observedAt: now,
      supersededBy: null,
      mutability: classifyMutability('stream-status'),
      justifications: [s.id],
      verdict: 'current',
      verdictBy: null
    })
  }
  return out
}

/** Extraction of the current knowledge state into claims (in-memory, no persist). Structured
 *  decisions/streams always; the LLM-inferred construction graph (prose triples) when
 *  DUIN_CLAIM_PROSE is on and a construction exists. */
export function extractClaims(vaultDir: string | null, now = Date.now()): Claim[] {
  if (!vaultDir) return []
  const decisions = (listDecisions(vaultDir)?.decisions ?? []).map((d) => ({ id: d.id, title: d.title, status: d.status, date: d.date }))
  const streams = (loadFutures(vaultDir) ?? []).map((s) => ({ id: s.id, title: s.title, status: s.status }))
  const claims = [...decisionClaims(decisions, now), ...streamClaims(streams, now)]
  if (claimProseEnabled()) {
    try {
      // NOTE: getConstruction() reads the ACTIVE notes-dir's cached graph (keyed by its own injected
      // provider), so prose claims assume vaultDir === the active notes dir (true in normal use).
      claims.push(...constructionClaims(getConstruction(), now))
    } catch (e) { console.debug('[claim-extract] construction unreadable  structured claims only:', messageOf(e)) }
  }
  return claims
}

/**
 * Merge freshly-extracted claims with an existing ledger by id, PRESERVING the metabolism state
 * so a rebuild never resets earned judgment. New claims come in `current`; disappeared ones are
 * dropped (their notes are gone).
 *
 * Durability (the moat-reversibility guarantee): the fresh extraction always presents a claim as
 * `current` (validTo=null, verdict='current'). If merge only carried `lastUsefulAt`, every prior
 * retirement AND every human reversal would silently resurrect on each rebuild — the deterministic
 * pass re-derives its own verdicts, but a human `reviewState` is NOT deterministic and would be
 * lost. So we carry forward the full metabolism state (validTo/verdict/verdictBy/supersededBy) plus
 * `reviewState`.
 *
 * One correctness guard: if the underlying `object` CHANGED, the claim is genuinely new information
 * and must be re-judged from `current` (a carried-over retirement would stick, since runVerdicts
 * only retires, never un-retires). A human-PINNED claim is the exception — a human decision is
 * never auto-reset, even across an object change.
 */
export function mergeLedger(existing: Claim[], extracted: Claim[]): Claim[] {
  const prior = new Map(existing.map((c) => [c.id, c]))
  return extracted.map((c) => {
    const p = prior.get(c.id)
    if (!p) return c
    const objectUnchanged = p.object.trim().toLowerCase() === c.object.trim().toLowerCase()
    if (objectUnchanged || isPinned(p)) {
      // A freshly born-retired TEMPORAL (its LLM-extracted validUntil has now lapsed since the last
      // build) is a NEW deterministic verdict from this extraction, not stale carry-forward — it must
      // win over a prior 'current' state, else a future-dated expiry never fires once its date passes.
      // A human pin still wins (isPinned short-circuits this — the operator's ruling is never reset).
      const freshTemporalRetire = !isPinned(p) && c.validTo !== null && c.verdictBy === 'temporal' && p.validTo === null
      if (freshTemporalRetire) return { ...c, lastUsefulAt: p.lastUsefulAt }
      return {
        ...c,
        lastUsefulAt: p.lastUsefulAt,
        validTo: p.validTo,
        verdict: p.verdict,
        verdictBy: p.verdictBy,
        supersededBy: p.supersededBy,
        // carry the applied-model-retirement marker so the CUMULATIVE per-entity over-retirement bound
        // (applySupersessionGuards, DEFECT 3) counts prior model retirements across rebuilds — without
        // this every tick would reset the budget and the slow-gutting bound would never accumulate.
        modelRetired: p.modelRetired,
        reviewState: p.reviewState
      }
    }
    // object changed and not human-pinned → fresh `current`, re-judged this tick
    return { ...c, lastUsefulAt: p.lastUsefulAt }
  })
}

export type ResolveAction = 'confirm' | 'revert'
export interface ResolveResult { ok: boolean; claim?: Claim; reason?: string; ledger: Claim[] }

/**
 * PURE: apply a human review decision to a loaded ledger (mutates the matched claim in place and
 * returns it for persistence). This is the moat-reversibility surface — a govern/operator can undo
 * a wrong verdict ('revert' → durable unretire → pinned 'reverted') or ratify the current state
 * ('confirm' → pinned 'confirmed'). Once pinned, the deterministic pass and rebuild-merge both
 * leave it alone (see runVerdicts pin guards + mergeLedger), so the decision survives every tick.
 */
export function resolveClaimReview(ledger: Claim[], claimId: string, action: ResolveAction): ResolveResult {
  const claim = ledger.find((c) => c.id === claimId)
  if (!claim) return { ok: false, reason: 'claim not found', ledger }
  if (action === 'revert') unretire(claim)
  else if (action === 'confirm') claim.reviewState = 'confirmed'
  else return { ok: false, reason: 'unknown action', ledger }
  return { ok: true, claim, ledger }
}

/**
 * I/O wrapper: load → resolve → persist. Returns the resolved claim (or an error reason). The
 * resolve is durable because it writes the whole ledger back; a subsequent shadow/live tick reads
 * the pinned row and skips it. No-op-safe: a missing claim leaves the ledger untouched.
 */
export function applyClaimResolution(vaultDir: string | null, claimId: string, action: ResolveAction): ResolveResult {
  if (!vaultDir) return { ok: false, reason: 'no notes dir', ledger: [] }
  const res = resolveClaimReview(loadLedger(vaultDir), claimId, action)
  if (res.ok) saveLedger(vaultDir, res.ledger)
  return res
}

/** Persisted ledger rows for spot-check (the audit surface). Empty until persistence lands. */
export function loadPersistedLedger(vaultDir: string | null): Claim[] {
  if (!vaultDir) return []
  return loadLedger(vaultDir)
}

export interface MetabolismShadow {
  total: number
  active: number
  byVerdict: Record<string, number>
  worldState: { resolvedDecisions: number; passedStreams: number }
  corrections: Correction[]
}

const EMPTY_SHADOW: MetabolismShadow = { total: 0, active: 0, byVerdict: {}, worldState: { resolvedDecisions: 0, passedStreams: 0 }, corrections: [] }

/** LIVE-metabolism flag. Default ON (validated live: persists deterministic verdicts + runs the
 *  clock tick; retired claims feed the read-side recall demotion, and human reversals survive a
 *  re-run — verified end-to-end). DUIN_CLAIM_METABOLISM_LIVE=0 ⇒ compute-only shadow (no persist,
 *  no tick). */
export function claimMetabolismLive(): boolean {
  return process.env.DUIN_CLAIM_METABOLISM_LIVE !== '0'
}

/**
 * SUPERSESSION-APPLY flag (P7). Default ON: model-proposed supersessions (prose winners + high-
 * confidence cross-alias coalescings) are APPLIED through applySupersessionGuards, so the metabolism
 * does real DYNAMIC supersession — not only clock-expiry — and verdict diversity rises on the live
 * ledger. Default-ON is justified because every applied retirement is (a) REVERSIBLE (retire-not-
 * delete + human unretire/pins), (b) confidence-gated, and (c) tripwire-bounded, and because the
 * phase is inert (diversity stays frozen at temporal-only) if left off. DUIN_CLAIM_SUPERSESSION=0 is
 * the instant conservative kill-switch → the prior proposal-only behavior, byte-for-byte.
 */
export function supersessionApplyEnabled(): boolean {
  return process.env.DUIN_CLAIM_SUPERSESSION !== '0'
}

// Deterministic verdict authors — only these durably retire a claim. A model-authored verdict is a
// PROPOSAL (surfaced in corrections), never a persisted retirement, so a wrong LLM call can't
// silently bury a true claim. (runVerdicts emits only deterministic verdicts today; this is the
// seam that keeps the later model-verdict pass honest-by-construction.)
const DETERMINISTIC_BY = new Set<Claim['verdictBy']>(['supersession', 'temporal', 'jtms'])

/**
 * The shared metabolism pipeline: extract the current structured state → merge with the persisted
 * ledger (carrying earned + human-reviewed state) → run the deterministic verdicts against the live
 * world-state. When `persist` is false this runs on a COPY and writes nothing (SHADOW — surfaces
 * what the metabolism WOULD do). When true it mutates the real merged array and saveLedger()s, but
 * ONLY the deterministic retirements — a model verdict is un-applied before write (proposal-only).
 */
/** Machine-greppable tag for the write-SKIP alert (a real transient-wipe was refused). Exported so
 *  a health monitor / log scan and the unit test reference the same stable string. The 2-day freeze
 *  went unnoticed precisely because the skip used to be silent (and, worse, MISFIRING). */
export const WRITE_SKIP_TAG = '[metabolism:write-skip]'

// WIPE-GUARD tuning. The refusal keys on ABSOLUTE degeneracy of the CURRENT extraction, never a
// ratio of the (churning, restore-inflatable) prior — see reconcileLedgerForPersist.
const WIPE_NEAR_EMPTY = 2 // an extraction of ≤ this many claims is a failed/empty read, not content
const WIPE_BIG_PRIOR = 20 // …and only a substantial prior is worth protecting from a near-empty collapse

/**
 * Decide what to write to the ledger given the freshly-merged `toPersist` and the on-disk `prior`.
 * Two data-loss guards, both PURE + unit-tested:
 *  (1) PIN RE-INJECTION — mergeLedger keeps only claims present in the FRESH extraction, so a
 *      transient extraction miss (empty/zeroed construction cache during a reindex, an fs read fail)
 *      drops any prior claim absent this tick. For a HUMAN-PINNED claim (reviewState confirmed/
 *      reverted) that's permanent loss of the operator's ruling — the next healthy tick re-extracts
 *      it as a fresh, unpinned claim. Carry every pinned prior forward verbatim when it's missing
 *      from toPersist, so pin durability never depends on surviving the fresh extraction (the
 *      moat-reversibility guarantee mergeLedger's docstring claims to uphold).
 *  (2) WIPE-GUARD (re-baseline-safe) — refuse a write ONLY when the CURRENT extraction is itself
 *      degenerate (collapsed to near-nothing), NOT when it is merely smaller than the prior. The old
 *      `withPins.length < prior.length * 0.5` ratio-floor DEADLOCKED the live ledger: a moat-restore
 *      re-inflated `prior` to an older, larger construction generation (4821 rows) while a healthy
 *      extraction now yields ~263, so `263 < 4821·0.5` returned null EVERY tick → the ledger froze
 *      for days. A genuinely-smaller extraction from a HEALTHY construction is a legitimate
 *      RE-BASELINE and MUST persist. We therefore refuse only the transient-WIPE signature — a
 *      total collapse (0 claims left, any prior) or a near-empty collapse of a substantial ledger
 *      (≤ WIPE_NEAR_EMPTY claims left while prior ≥ WIPE_BIG_PRIOR). Both mean the vault read failed;
 *      neither describes 263-from-4821, which now writes and UNFREEZES the ledger on the next tick.
 * Returns the array to write, or null to keep the prior ledger untouched (a real wipe was refused,
 * and WRITE_SKIP_TAG is logged so the skip is observable — it never silently freezes again).
 */
export function reconcileLedgerForPersist(prior: Claim[], toPersist: Claim[]): Claim[] | null {
  const persistIds = new Set(toPersist.map((c) => c.id))
  const rescuedPins = prior.filter((p) => isPinned(p) && !persistIds.has(p.id))
  const withPins = rescuedPins.length ? [...toPersist, ...rescuedPins] : toPersist
  const totalCollapse = withPins.length === 0 && prior.length > 0
  const nearEmptyCollapseOfBigLedger = withPins.length <= WIPE_NEAR_EMPTY && prior.length >= WIPE_BIG_PRIOR
  if (totalCollapse || nearEmptyCollapseOfBigLedger) {
    console.warn(
      `${WRITE_SKIP_TAG} refusing to persist a (near-)empty ledger: extraction=${toPersist.length} ` +
        `(withPins=${withPins.length}) vs prior=${prior.length}; keeping prior. This is the ` +
        `transient-wipe signature (failed/empty construction), NOT a re-baseline. If it repeats, ` +
        `the metabolism read is failing.`
    )
    return null
  }
  return withPins
}

async function metabolize(vaultDir: string, now: number, persist: boolean): Promise<MetabolismShadow> {
  const prior = loadLedger(vaultDir)
  const merged = mergeLedger(prior, extractClaims(vaultDir, now))
  const decisions = (listDecisions(vaultDir)?.decisions ?? []).map((d) => ({ id: d.id, status: d.status, reviewOn: d.reviewOn }))
  const streams = (loadFutures(vaultDir) ?? []).map((s) => ({ id: s.id, status: s.status, decide_by: s.decide_by }))
  // World-model Stage 1: feed the past-anchor axis. Best-effort — an anchors read failure must not
  // break metabolism, it just leaves pastAnchors empty (today's behavior).
  let anchorRows: { id?: string; name?: string; date?: string; window_end?: string }[] = []
  try {
    anchorRows = (anchors(vaultDir)?.anchors ?? []) as typeof anchorRows
  } catch (e) {
    console.debug('[claim-extract] anchors unavailable  pastAnchors stays empty:', messageOf(e))
  }
  const world = gatherWorldState(decisions, streams, now, anchorRows)
  const target: Claim[] = persist ? merged : merged.map((c) => ({ ...c, justifications: [...c.justifications] }))
  // SEMANTIC ENTITY RESOLUTION (claim-entities.ts): embed the distinct subjects and stamp a canonical
  // entityKey, so the verdict pass coalesces alias/paraphrase variants of the same real thing
  // ("ProjectA" ≈ "《ProjectA》") instead of exact-string keys. Best-effort: no embedder ⇒ exact-string
  // fallback. Lazy import keeps the pure engine decoupled from the local-brain index.
  if (entityResolveEnabled()) {
    try {
      const { embedForRecall } = await import('../local-brain/index-store')
      await annotateEntityKeys(target, embedForRecall)
    } catch (e) { console.debug('[claim-extract] embedder unavailable  runVerdicts keys on raw subjects (todays behavior):', messageOf(e)) }
  }
  const { corrections } = runVerdicts(target, world, now)
  // P7: decide which MODEL-proposed supersessions (prose winners + cross-alias coalescings) are safe
  // to APPLY vs un-apply. Runs in BOTH shadow and live so byVerdict/diversity preview matches what a
  // live tick would persist. Guard-approved retirements become durable verdictBy 'supersession';
  // everything else reverts to 'current' (knowledge preserved). Reversible + confidence + tripwire +
  // pins — see applySupersessionGuards. Kill-switch: DUIN_CLAIM_SUPERSESSION=0 reverts them all.
  applySupersessionGuards(target, undefined, supersessionApplyEnabled())
  // store.reinforce-arm: markUseful the ACTIVE claims that a prior turn's endorsed+cited recall
  // reinforced (drained from the reinforcement queue). This is the single writer, so applying here is
  // race-safe. Persist pass ONLY (the shadow pass must not consume the queue) + opt-in. Mutates
  // `target` so lastUsefulAt flows through toPersist/reconcile to disk. No-op when off / queue empty.
  if (persist && claimReinforceEnabled()) applyReinforcement(target, drainReinforcement(), now)
  if (persist) {
    // SAFETY NET: applySupersessionGuards has already resolved every model proposal (kept → durable
    // 'supersession'; refused → reverted to 'current'), so no verdictBy 'model' should remain. This
    // filter stays as defense-in-depth — any stray non-deterministic retirement is un-applied before
    // it can persist, so a wrong model verdict can never reach disk even if a future path skips the guard.
    const toPersist = target.map((c) =>
      c.validTo !== null && !DETERMINISTIC_BY.has(c.verdictBy)
        ? { ...c, validTo: null, verdict: 'current' as Claim['verdict'], verdictBy: null, supersededBy: null } // proposal-only
        : c
    )
    // DURABILITY + SHRINK-FLOOR (data-loss fix): reconcile the freshly-merged set against the on-disk
    // prior before writing — re-inject human pins that vanished from a transient extraction, and
    // refuse a catastrophic wholesale shrink. See reconcileLedgerForPersist.
    const writeSet = reconcileLedgerForPersist(prior, toPersist)
    // writeSet === null ⇒ a real transient-wipe was refused; reconcileLedgerForPersist already
    // emitted WRITE_SKIP_TAG (the skip is no longer silent). Otherwise persist the reconciled set —
    // a legitimately-smaller-but-healthy extraction (a re-baseline) now writes and unfreezes.
    if (writeSet !== null) saveLedger(vaultDir, writeSet)
  }
  const byVerdict: Record<string, number> = {}
  for (const c of target) byVerdict[c.verdict] = (byVerdict[c.verdict] ?? 0) + 1
  return {
    total: target.length,
    active: target.filter((c) => c.validTo === null).length,
    byVerdict,
    worldState: { resolvedDecisions: world.resolvedDecisions.size, passedStreams: world.passedStreams.size },
    corrections: corrections.slice(0, 100)
  }
}

/**
 * SHADOW run: run the metabolism pipeline on a COPY against the live world-state. Persists NOTHING
 * and does not touch retrieval — it only surfaces what the metabolism WOULD do, so a wrong verdict
 * can be spot-checked before the retrieval penalty is ever turned on.
 */
export async function runShadowMetabolism(vaultDir: string | null, now = Date.now()): Promise<MetabolismShadow> {
  if (!vaultDir) return EMPTY_SHADOW
  return metabolize(vaultDir, now, false)
}

/**
 * LIVE run: same pipeline, but persists the deterministic retirements back to the ledger (so the
 * audit + recall surfaces read real verdicts). Gated by DUIN_CLAIM_METABOLISM_LIVE — OFF delegates
 * to a shadow compute (persist=false), byte-identical to today. Human-pinned claims are left alone
 * by runVerdicts' guards, so a live tick never undoes a reversal.
 */
export async function runLiveMetabolism(vaultDir: string | null, now = Date.now()): Promise<MetabolismShadow> {
  if (!vaultDir) return EMPTY_SHADOW
  return metabolize(vaultDir, now, claimMetabolismLive())
}
