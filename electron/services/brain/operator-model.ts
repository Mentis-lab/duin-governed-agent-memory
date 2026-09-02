// Operator-learning loop + PROMOTION GOVERNANCE (F1) — the "gets smarter over
// time, under your control" moat.
//
// Every brain turn, DUIN accrues durable facts about the OPERATOR. But nothing
// becomes a RULE that governs DUIN's behavior without passing a human review
// gate — the promotion governance loop (generalized from the operator's harness):
//
//   capture → CANDIDATE → (reflect: dedup/verify) → [human: promote | veto]
//             candidate facts ground SOFTLY ("noticed, unconfirmed")
//             PROMOTED facts ground STRONGLY ("rules you confirmed — follow")
//             VETOED facts are suppressed AND remembered (never re-surface)
//
// Capture has two paths: keyless heuristics (explicit teaching; no model) and
// key-gated LLM extraction. Persistence is a small JSON in the local-brain
// userData dir; facts are deduped (normalized, incl. vetoed = veto-memory) and
// capped. `buildOperatorBlock()` renders promoted+candidate for grounding.
//
// parse / keyless-extract / dedup / promote / veto / reflect are PURE-ish and
// unit-tested; the LLM calls are best-effort and key-gated.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { atomicWriteFileSync } from '../atomic-write'
import type { MeasureOutcome } from './judgment-measure'
import { join, dirname } from 'path'
import { chatOnce, routeModel } from '../providers/registry'
import { autoSupersede, type ActiveFactRef } from './operator-supersede'
import { cascadeTargets } from './derivation-cascade'
import { gradedCascade, type Degradation } from './derivation-polynomial'
import {
  reliabilityByFact,
  reliabilityBoundsByFact,
  rankByEstablishedTrust,
  type RelFact,
  type RelBound,
  type VerifierCalibration
} from './derivation-reliability'
import { firewallClear } from '../governance/confidential-firewall'
import { messageOf } from '../guarded'
import { classify, OPERATOR_FACT_PROMOTION_CAP_ID } from '../ans/capability-ledger'

// Govern lifecycle (asymmetric — earned slowly, revoked fast):
//   candidate → [human promote] → provisional (PROBATION) → [dual-verifier] → promoted
//                                                          ↘ [jury fail] → reverted (auto)
//   candidate|provisional → [human veto] → vetoed
// 'promoted' is now the CONFIRMED terminal (earned, not asserted); 'provisional' is a
// human-endorsed rule still proving itself; 'reverted' failed verification (excluded +
// remembered so it isn't blindly re-promoted).
export type FactStatus = 'candidate' | 'provisional' | 'promoted' | 'vetoed' | 'reverted'

/** Provenance of a fact — who authored the raw signal (store-ownership contract).
 *  'operator' = the human stated/corrected it (keyless teaching, explicit corrections/vetoes).
 *  'machine'  = model-inferred from a turn (extractWithModel). Machine rows must EARN their
 *  way to 'promoted' through the human/jury gate before they present as operator-confirmed
 *  rules — a machine inference may never masquerade as something the operator asserted.
 *  'external' = ingested from a DE-PRIVILEGED turn (an inbound/channel message that failed
 *  exec-authorization — NOT the operator at the console). Ingestion-trust tiering (SSGM/DRIFT):
 *  external rows are recorded for audit + human review (provenance visible) but QUARANTINED from
 *  grounding (buildOperatorBlock excludes un-promoted external candidates) so a non-operator cannot
 *  poison the governed store by asserting a "fact"; they ground only if a human explicitly promotes. */
export type FactSource = 'operator' | 'machine' | 'external'

/** Every FactSource that may round-trip through persistence. Typed as Record<FactSource, true>
 *  ON PURPOSE: adding a fourth tier to the union above is a TYPE ERROR until it is listed here,
 *  so provenance can never again be silently dropped by the loader. It was silent the first time
 *  because the load-time narrowing was a hand-written `f.source === 'machine' || === 'operator'`
 *  disjunction over a `FactSource | undefined` — TypeScript gives such a check no exhaustiveness
 *  obligation, so when the 'external' tier was added the loader kept compiling while quietly
 *  discarding the tag (and factSource() then defaulted it to the MOST-trusted tier, 'operator'). */
const FACT_SOURCES: Record<FactSource, true> = { operator: true, machine: true, external: true }
const isFactSource = (s: unknown): s is FactSource =>
  typeof s === 'string' && Object.prototype.hasOwnProperty.call(FACT_SOURCES, s)

export interface OperatorFact {
  id: string
  fact: string
  /** 'preference' | 'context' | 'correction' | 'goal' — soft hint. */
  kind: string
  status: FactStatus
  /** Provenance (store-ownership). Absent on legacy rows → treated as 'operator' via factSource(). */
  source?: FactSource
  /** Valid-FROM (bitemporal). When the fact was captured. NOTE: setFact bumps it on every mutation. */
  ts: number
  /** Creation stamp, never mutated (unlike `ts`). The seam's `capturedAt` (W3). Absent on legacy rows. */
  capturedAt?: number
  /** When the fact became a confirmed rule (govern confirm or a human ratify). The seam's stable
   *  `promotedAt` (W3). Absent on rows promoted before the field existed. */
  promotedAt?: number
  /** Valid-TO (bitemporal). Set when this fact is SUPERSEDED by a newer, contradicting
   *  fact — the operator's state changed (e.g. "editor is VSCode" → later "…Neovim"). An
   *  invalidated fact is retained for audit/history but no longer GROUNDS (excluded from
   *  recall + buildOperatorBlock), so DUIN stops acting on stale operator state. Distinct
   *  from `vetoed` (a human said "never true"): invalidated = "was true, now outdated". */
  invalidatedAt?: number
  /** The id of the newer fact that superseded this one (provenance for the invalidation). */
  supersededBy?: string
  /** WHY this fact was invalidated (the machine cause; absent = an ordinary supersedeFact correction).
   *  'cascade' (Reasoning-trace Stage 2): invalidated not by its own supersession but because a premise
   *  it DEPENDS_ON was retired and it lost its last support — the walkable "why it fell", pairing with
   *  dependsOn (which premises) to complete the cascade audit.
   *  'reflect': auto-merged by reflect() into a richer candidate whose content words are a strict
   *  superset (supersededBy = that richer fact). Kept because subset ≠ synonymy — a negated or
   *  qualified superset can absorb a contradictory or more general claim, and this row is the only
   *  record it was ever noticed. */
  invalidatedBy?: string
  /** Probation start (set when a human promotes → provisional). */
  provisionalAt?: number
  /** PROMOTION ORIGIN — did a HUMAN adjudicate this fact's status, or did it arrive at it by machine?
   *
   *  `provisional` has three writers: promoteFact (the human gate), seedFacts (vault principles seeded
   *  by machine) and applyBoundRule (a binding lifting a fact). Status alone therefore cannot answer
   *  "did a person endorse this?", and verifierCalibration was asking exactly that — it reads a
   *  promoted/provisional fold as evidence the NLI verifier was RIGHT. A machine-seeded fact that
   *  acquired a verified edge through recordDerivedFact's text dedup thus counted as a human success
   *  nobody ever gave, inflating the verifier's measured precision and, through the Stage-5 interval,
   *  narrowing bounds that gate grounding.
   *
   *  Set on the two human gates (promoteFact / vetoFact — the two that fire lifecycleHook) as 'human',
   *  and on the automated-learning path (autoPromoteCandidates) as 'auto'. verifierCalibration counts
   *  ONLY 'human' rows, so an 'auto' promotion never contaminates the verifier's measured precision.
   *  Absent means NOT adjudicated at all (a legacy row, or a still-candidate fact) — and absence of
   *  evidence must not be counted as evidence, in either direction. */
  adjudicatedBy?: 'human' | 'auto'
  /** Distinct sessions the fact has SURVIVED on probation (recurrence-clean proxy:
   *  a human re-correction would veto it, so surviving sessions = not recurring). */
  observedSessions?: string[]
  /** W2 (causal survival credit) — distinct sessions in which this fact was actually
   *  RETRIEVED into grounding AND the graded turn was ENDORSED (recall-efficacy →
   *  noteFactEndorsed → converted at the next noteSession boundary). A SEPARATE counter
   *  from observedSessions, never a rewrite (property 8: tenure and earned-in-use are
   *  two different situations and must stay distinguishable). Absent on facts predating
   *  the field — governDecision treats absence as legacy (old survival rule). */
  earnedSessions?: string[]
  /** Auto-revert count — asymmetry memory (revoked-fast, never blindly re-promoted). */
  reverts?: number
  /** Measured behavioral efficacy (A/B judgment-measure). Persisted so the signal can gate
   *  grounding + feed the improvement queue instead of being recomputed and thrown away. */
  efficacy?: FactEfficacy
  /** Govern-loop provenance (item 15): which model juried this fact + the verdict, for audit. */
  govern?: GovernProvenance
  /** Binding-ledger rows this fact is linked to (Phase 1 unification). The rule→fact relation
   *  is many:1 (the same rule text can be bound under different themes, and norm()-dedup collapses
   *  them onto one fact), so this is a SET, not a single id. When a binding's held-out "won't
   *  recur" prediction fails, revertByBindingId() unlinks that id; the fact reverts only if it is
   *  bindingBorn and no linked binding remains. */
  bindingIds?: string[]
  /** True when this fact's provisional/promoted status exists BECAUSE of a bind — a freshly
   *  minted bound-rule fact, or a candidate the bind lifted. An independently-earned fact that a
   *  bind merely LINKS stays false, so a different rule's binding failure only unlinks it and can
   *  never discard the fact's own earned merit. */
  bindingBorn?: boolean
  /** Reasoning-trace provenance (Stage 1): when this fact is a fold (consolidation/reflection) of
   *  several input claims, the DEPENDS_ON edges recording which claims it was derived from and the
   *  independent NLI verdict on that derivation. Distinct from `bindingIds` (binding-ledger links) and
   *  `supersededBy` (contradiction lineage): this is the walkable "why this rule exists". */
  dependsOn?: DependsOnEdge[]
}

/** The durable measured-lift signal for a promoted fact (produced by runMeasurePass). */
export interface FactEfficacy {
  flipRate: number
  flips: number
  regressions: number
  trials: number
  verdict: MeasureOutcome
  measuredAt: number
}

/** Govern-loop audit record (item 15). Inline verdict union (NOT an import of GovernOutcome —
 *  avoids a circular dep with operator-govern). */
export interface GovernProvenance {
  juryModelId: string | null
  juryProvider: string | null
  crossModel: boolean
  // 'ratify' (W3 posture): keyless bar met → parked for the operator, not confirmed.
  verdict: 'confirm' | 'revert' | 'hold' | 'ratify'
  behavioralFlip: boolean | null
  ts: number
  /** W2 audit — earned-in-use vs raw-tenure session counts at decision time, so the
   *  govern audit shows WHY a fact crossed (or didn't): `earned` ticks require the fact
   *  was retrieved + the turn endorsed; `observed` is the legacy tenure counter. Absent
   *  on rows recorded before the field existed. */
  earned?: number
  observed?: number
}

/** A verified reasoning-trace DEPENDS_ON edge (Stage 1). A fold-rule depends_on its input claims; the
 *  verdict is the INDEPENDENT NLI check that the input claims actually entail the rule (never the fold
 *  model's own say-so). `verifier: null` = abstained (no key / parse-miss) → the edge is recorded but
 *  UNVERIFIED (honest "couldn't verify ≠ verified true"), mirroring GovernProvenance's audit shape. */
export interface DependsOnEdge {
  /** the input-claim OperatorFact ids this rule was folded from (the DEPENDS_ON targets) */
  depends_on: string[]
  /** independent NLI label: does depends_on jointly entail this rule? */
  verdict: 'entails' | 'neutral' | 'contradicts'
  /** 0..1 entailment confidence */
  score: number
  /** the judge's one-line justification — the audit "why" (non-authoritative model rationale) */
  rationale: string
  /** the model id that ran the check; null = keyless/abstained (fail-safe, not "verified false") */
  verifier: string | null
  ts: number
}

const MAX_FACTS = 300
const MAX_BLOCK_LINES = 40
/** How many cap-evicted rows to retain as tombstones (traceability without unbounded growth). */
const MAX_EVICTIONS = 200
/** Stage 6: the share of independent derivations a rule must RETAIN to keep grounding at full
 *  authority. At 0.5 a rule demotes to weigh-lightly once it has lost half or more of them
 *  (2→1 demotes, 3→1 demotes, 3→2 does not) — a majority loss means it now rests on materially
 *  different evidence than when it was minted, while losing one of three is too weak a signal to
 *  quiet a confirmed rule over. Weighting only; nothing is ever retracted on this. */
const EROSION_DEMOTE_RATIO = 0.5

/** Tombstone for a row removed WITHOUT a human verdict — cap eviction (a capacity decision) or a
 *  verifier prune (a model's decision). Neither is the operator speaking, so the row's text +
 *  status + provenance are retained (bounded) so "where did that promoted rule go?" is
 *  answerable. Distinct from `vetoed` (a human said never) and `invalidatedAt` (superseded) —
 *  those stay in `facts`. */
export interface EvictionRecord {
  id: string
  fact: string
  kind: string
  status: FactStatus
  source: FactSource
  /** original capture ts */
  ts: number
  /** when the cap eviction removed it */
  evictedAt: number
  /** which call site removed it (seed | record | derive | load | verify-pool) */
  at: string
}

/** THE single tombstone-ledger append. Any path that deletes a row without a human verdict routes
 *  through here so the removal is TRACEABLE (what it said, its status/provenance, when, and which
 *  call site did it) rather than a bare filter. Bounded at MAX_EVICTIONS, newest first. */
function tombstone(dropped: OperatorFact[], at: string): void {
  if (!dropped.length) return
  const now = Date.now()
  evictions = [
    ...dropped.map((f) => ({
      id: f.id,
      fact: f.fact,
      kind: f.kind,
      status: f.status,
      source: factSource(f),
      ts: f.ts,
      evictedAt: now,
      at
    })),
    ...evictions
  ].slice(0, MAX_EVICTIONS)
}

let store: OperatorFact[] = []
let evictions: EvictionRecord[] = []
let storePath: string | null = null
let idCounter = 0

/** THE single cap-eviction path. Status-aware: only churn (candidate/reverted) is evictable
 *  before human-touched rows — promoted/provisional are confirmed and `vetoed` is veto-memory
 *  (losing it re-opens a human-rejected fact to re-adding + re-grounding via the dedup set in
 *  recordFacts). Within churn, operator-STATED rows evict last (HUMAN AUTHORITY, isOperatorStated):
 *  the cap drops the model's noise before the operator's own words. Newest-first within a tier. Every dropped row is TOMBSTONED (see EvictionRecord)
 *  rather than silently deleted. All three call sites (record / seed / derive) plus the load path
 *  route through here so a fourth site cannot drift back to a status-blind slice().
 *  `protectIds` are never evicted (e.g. the fact we just derived — its edge would dangle). */
function evictToCap(at: string, protectIds?: Iterable<string>): OperatorFact[] {
  if (store.length <= MAX_FACTS) return []
  const evictLast = (s: FactStatus): number => (s === 'candidate' || s === 'reverted' ? 1 : 0)
  // 0 = human-touched status, 1 = operator-stated churn, 2 = machine churn.
  const tier = (f: OperatorFact): number => (evictLast(f.status) === 0 ? 0 : isOperatorStated(f) ? 1 : 2)
  const keep = new Set(
    [...store]
      .sort((a, b) => tier(a) - tier(b) || b.ts - a.ts)
      .slice(0, MAX_FACTS)
      .map((f) => f.id)
  )
  if (protectIds) for (const id of protectIds) keep.add(id)
  const dropped = store.filter((f) => !keep.has(f.id))
  if (!dropped.length) return []
  store = store.filter((f) => keep.has(f.id))
  tombstone(dropped, at)
  const earned = dropped.filter((f) => f.status !== 'candidate' && f.status !== 'reverted')
  if (earned.length) {
    // Should be unreachable while churn remains: only fires when the store is ALL human-touched.
    console.warn(
      `[operator-model] cap eviction (${at}) dropped ${earned.length} human-touched fact(s):`,
      earned.map((f) => `${f.status}:${f.fact.slice(0, 60)}`)
    )
  }
  return dropped
}

/** Cap-eviction tombstones, newest first (audit: what the cap dropped, when, and from where). */
export function getEvictionLog(): EvictionRecord[] {
  return [...evictions]
}

function mkId(): string {
  idCounter += 1
  return `of_${idCounter.toString(36)}_${Math.floor(performance.now() % 1e9).toString(36)}`
}

/** Move an unreadable / wrong-shape operator-model.json aside to `<name>.<ISO-stamp>.corrupt` so the
 *  first persist() of the session cannot overwrite it. Never deletes; never overwrites in place.
 *  Returns false when the rename itself failed — the caller then clears `storePath` so persist()
 *  abstains rather than clobbering bytes we could not preserve. Twin of learn-store's
 *  `quarantineCorruptTaste` / capability-ledger's `quarantineCorruptStore`. */
function quarantineCorruptOperatorModel(path: string, cause: unknown): boolean {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${path}.${stamp}.corrupt`
  try {
    renameSync(path, sidecar)
    console.error(
      `[operator-model] UNUSABLE operator-model.json at ${path} (${messageOf(cause)}) — quarantined to ` +
        `${sidecar}; the in-memory store reset to EMPTY, so promoted/provisional facts and vetoed ` +
        'veto-memory from that file are NOT restored automatically (a lost vetoed row also lets a ' +
        'human-rejected fact be re-added and re-grounded). Recover the sidecar by hand or via restoreLatestMoat.'
    )
    return true
  } catch (e) {
    console.error(
      `[operator-model] UNUSABLE operator-model.json at ${path} (${messageOf(cause)}) and quarantine ` +
        `FAILED (${messageOf(e)}) — persistence DISABLED for this session rather than overwriting bytes ` +
        'we could not preserve. Facts learned this session are in-memory only; fix or move the file and restart.'
    )
    return false
  }
}

/** Wire the persistence path (local-brain userData dir) + load existing facts.
 *
 *  Why the failure branches quarantine instead of falling back to `store = []`: storePath is set
 *  BEFORE the read, so a failed load leaves persistence armed, and the very next mutation
 *  (recordFacts/setFact/seedFacts → persist) atomicWriteFileSync's `{facts: [<1 new candidate>]}`
 *  over the whole file — destroying every promoted/provisional fact AND the vetoed rows that ARE the
 *  veto-memory (recordFacts' dedup set is rebuilt from the store, so rejected facts become
 *  re-addable). The 5-minute projectMoatToVault then mirrors the wipe onto the durable vault copy.
 *
 *  Pattern B: the ABSENT-file case is already safe (cold start, nothing to lose) and a healthy file
 *  round-trips; only the TRUNCATED/drifted file destroys — and the shape-drift variant is the quiet
 *  one, since `Array.isArray(raw.facts) ? raw.facts : []` yields an empty store with NO thrown error
 *  when the top-level key drifted (`{operatorFacts:[…]}`) or the file is a bare JSON array. So the
 *  guard validates the SHAPE, not just the parse — as learn-store.ts:110 does for the same case. */
export function setOperatorModelPath(userDataDir: string): void {
  storePath = join(userDataDir, 'operator-model.json')
  try {
    if (existsSync(storePath)) {
      const text = readFileSync(storePath, 'utf-8')
      if (!text.trim()) return // empty file holds nothing to preserve; cold store is correct
      const parsed: unknown = JSON.parse(text)
      const shape =
        !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          ? `not a JSON object: ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`
          : !Array.isArray((parsed as { facts?: unknown }).facts)
            ? `missing/!array 'facts' key (top-level keys: ${Object.keys(parsed as object).slice(0, 8).join(', ') || 'none'})`
            : null
      if (shape) {
        // Parses fine, but we cannot carry it forward. Preserve it rather than clobber it.
        store = []
        evictions = []
        if (!quarantineCorruptOperatorModel(storePath, new Error(shape))) storePath = null
        return
      }
      const raw = parsed as {
        facts?: Partial<OperatorFact>[]
        evictions?: EvictionRecord[]
      }
      evictions = (Array.isArray(raw.evictions) ? raw.evictions : [])
        .filter((e) => e && typeof e.fact === 'string' && typeof e.evictedAt === 'number')
        .slice(0, MAX_EVICTIONS)
      // NOTE: no status-blind slice() here. An over-cap file (restore / merge / hand-edit) is
      // trimmed by the SAME status-aware evictToCap below, so a load can never silently drop a
      // promoted/vetoed row and then have the next persist() write that truncation back.
      store = (Array.isArray(raw.facts) ? raw.facts : [])
        .filter((f) => typeof f?.fact === 'string' && f.fact.trim())
        .map((f) => ({
          id: f.id || mkId(),
          fact: (f.fact as string).trim(),
          kind: f.kind || 'context',
          status: (f.status as FactStatus) || 'candidate',
          ts: f.ts || Date.now(),
          // Provenance must survive reload — else every persisted 'machine' fact silently
          // reads as 'operator' after a restart (a false ownership claim), and every persisted
          // 'external' fact escapes its SSGM/DRIFT quarantine (isQuarantinedExternal() goes
          // false, so an un-promoted non-operator claim starts grounding). Validate against the
          // whole FactSource union, not a hand-listed subset. Legacy rows with no source stay
          // undefined → factSource() defaults them to 'operator'.
          ...(isFactSource(f.source) ? { source: f.source } : {}),
          ...(typeof f.invalidatedAt === 'number' ? { invalidatedAt: f.invalidatedAt } : {}),
          ...(typeof f.supersededBy === 'string' ? { supersededBy: f.supersededBy } : {}),
          ...(typeof f.invalidatedBy === 'string' ? { invalidatedBy: f.invalidatedBy } : {}),
          ...(typeof f.provisionalAt === 'number' ? { provisionalAt: f.provisionalAt } : {}),
          ...(typeof f.capturedAt === 'number' ? { capturedAt: f.capturedAt } : {}),
          ...(typeof f.promotedAt === 'number' ? { promotedAt: f.promotedAt } : {}),
          // Must survive reload like `source` does: an adjudication that evaporated on restart would
          // silently re-open the same miscount it exists to close (and an 'auto' row that reverted to
          // undefined could be re-promoted by the automation as if never seen).
          ...(f.adjudicatedBy === 'human' || f.adjudicatedBy === 'auto'
            ? { adjudicatedBy: f.adjudicatedBy }
            : {}),
          ...(Array.isArray(f.observedSessions) ? { observedSessions: f.observedSessions as string[] } : {}),
          // W2 causal credit: the earned-endorsement counter is durable state
          // exactly like observedSessions — dropping it on reload reset every
          // fact's earned credit each restart and stalled keyed promotion
          // (review fix 2026-08-15).
          ...(Array.isArray(f.earnedSessions) ? { earnedSessions: f.earnedSessions as string[] } : {}),
          ...(typeof f.reverts === 'number' ? { reverts: f.reverts } : {}),
          ...(f.efficacy ? { efficacy: f.efficacy as FactEfficacy } : {}),
          ...(f.govern ? { govern: f.govern as GovernProvenance } : {}),
          ...(Array.isArray(f.bindingIds)
            ? { bindingIds: (f.bindingIds as unknown[]).filter((x): x is string => typeof x === 'string') }
            : {}),
          ...(f.bindingBorn === true ? { bindingBorn: true } : {}),
          // Reasoning-trace provenance must survive reload — else the "why this rule exists" audit
          // silently empties on restart. Keep only well-formed edges.
          ...(Array.isArray(f.dependsOn)
            ? {
                dependsOn: (f.dependsOn as DependsOnEdge[]).filter(
                  (e) => e && Array.isArray(e.depends_on) && typeof e.verdict === 'string'
                )
              }
            : {})
        }))
      evictToCap('load')
    }
  } catch (e) {
    // Unreadable / unparseable (crash-truncated write, disk fault, a hand-edit that broke JSON).
    // Empty is the only safe in-memory state, but it must NOT be written back over the file.
    store = []
    evictions = []
    if (storePath && !quarantineCorruptOperatorModel(storePath, e)) storePath = null
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    // H2 (DUIN_PORTABILITY_PASS_REVIEW): atomic write — the 5-min projector reads this file, so a
    // torn write here would propagate a truncated operator model into the durable vault record.
    atomicWriteFileSync(
      storePath,
      JSON.stringify({ facts: store, ...(evictions.length ? { evictions } : {}) }, null, 2),
      0o644
    )
  } catch (e) {
    console.warn('[operator-model] persist failed:', (e as Error)?.message) // M6 — don't lose learned facts silently
  }
  if (changeHook) {
    try {
      changeHook()
    } catch (e) {
      console.debug('[operator-model] change hook never blocks:', messageOf(e))
    }
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[.?!]+$/, '').replace(/\s+/g, ' ').trim()

/** A fact that has been superseded (bitemporal valid-TO set) — retained for audit but no
 *  longer grounds. Distinct from vetoed: invalidated facts DON'T block re-assertion (the
 *  operator's state can change back), so they're excluded from the dedup guard. */
const isInvalidated = (f: OperatorFact): boolean => typeof f.invalidatedAt === 'number'

/** BITEMPORAL LIVENESS, exported for readers OUTSIDE this module. Every semantic retirement here
 *  (supersedeFact, reflect, cascadeInvalidateDerived) stamps `invalidatedAt` and deliberately leaves
 *  `status` intact — soft-delete, so the audit can still walk why a rule fell. `listByStatus`
 *  therefore keeps serving retired rows FOREVER and each reader must apply this predicate itself,
 *  exactly as the in-file readers do (buildOperatorBlock's `active`, verifyPool). Cross-module
 *  readers had no way to express that check at all, which is how operator-govern acquired one. */
export const isFactLive = (f: OperatorFact): boolean => !isInvalidated(f)

/** Provenance accessor — legacy rows persisted before the source tag existed are
 *  treated as operator-authored (the pre-tag capture was keyless/human teaching). */
export function factSource(f: OperatorFact): FactSource {
  return f.source ?? 'operator'
}

/** HUMAN AUTHORITY. A fact the operator STATED (keyless capture, source 'operator' — legacy untagged rows
 *  included, see factSource) or a fact a human ADJUDICATED (promote/veto, adjudicatedBy 'human'). Every
 *  model-driven retirement path in this module — the auto-supersession judge (runAutoSupersede +
 *  supersedeFact), verifyPool's prune, reflect's absorption, and the cap's eviction order — consults this
 *  predicate, so that "a fact you stated is never aged out by a model on its own" (README, architecture.md,
 *  constitution §3) is code rather than copy. Only the operator's own later statement (a keyless trigger,
 *  source 'operator') may supersede such a fact. Vetoed rows are excluded from grounding by status already. */
export function isOperatorStated(f: OperatorFact): boolean {
  return factSource(f) === 'operator' || f.adjudicatedBy === 'human'
}

/** Ingestion-trust tiering (SSGM/DRIFT): an un-promoted 'external' fact (captured from a de-privileged
 *  turn) is QUARANTINED — it must not reach grounding by ANY path (the whole-dump buildOperatorBlock,
 *  the default-on recall assembly, or laundering through consolidation into an operator-sourced rule)
 *  until a human explicitly promotes it. A promoted/provisional external fact a human vouched for is
 *  NOT quarantined. This is the single predicate every grounding/consolidation site shares, so the
 *  quarantine can't silently leak on a path that forgot to check it. */
export function isQuarantinedExternal(f: OperatorFact): boolean {
  return factSource(f) === 'external' && f.status !== 'promoted' && f.status !== 'provisional'
}

/** Add facts as CANDIDATES (deduped by normalized text across ALL statuses, so a
 *  vetoed fact is never re-added — veto memory). Returns # added. Each fact carries
 *  a `source` provenance tag (default 'operator'; model-inferred facts pass 'machine'). */
export function recordFacts(facts: { fact: string; kind?: string; source?: FactSource }[]): number {
  // Dedup across all statuses EXCEPT invalidated — a superseded fact can be re-asserted
  // (state changed back), so it shouldn't block re-adding, unlike vetoed veto-memory.
  const seen = new Set(store.filter((f) => !isInvalidated(f)).map((f) => norm(f.fact)))
  let added = 0
  for (const f of facts) {
    const text = (f.fact || '').trim()
    if (!text || text.length < 3 || text.length > 300) continue
    if (!verifyCandidate(text).ok) continue // dual-verifier (keyless gate) — drop junk at the door
    const key = norm(text)
    if (seen.has(key)) continue
    seen.add(key)
    store.unshift({ id: mkId(), fact: text, kind: f.kind || 'context', status: 'candidate', ts: Date.now(), capturedAt: Date.now(), source: f.source ?? 'operator' })
    added++
  }
  if (added) {
    evictToCap('record')
    persist()
  }
  if (added) emitFactEvent('operator.fact.recorded', { count: added })
  return added
}

/** Supersede an existing fact with a newer, contradicting one — the bitemporal invalidation
 *  mechanism the operator-memory moat was missing (facts were "evergreen", superseded only by
 *  dedup/human-veto). Records `newText` as a fresh candidate and marks the prior fact
 *  invalidated (valid-TO = now, supersededBy = new id) so it stops grounding but is kept for
 *  audit. Callable by the govern/correction path or key-gated extraction when it detects that
 *  the operator's stated X changed. No-op if `oldId` is unknown or already invalidated.
 *  Returns the new fact's id (or null if the new text failed the capture guards).
 *  HUMAN AUTHORITY: a caller retiring on a MODEL's behalf must pass `source: 'machine'` — such a
 *  replacement is refused when `old` is operator-stated (isOperatorStated). An omitted `source` is the
 *  human-driven correction contract and inherits the old row's provenance. */
export function supersedeFact(oldId: string, newText: string, kind?: string, source?: FactSource): { newId: string | null; superseded: boolean } {
  const old = store.find((f) => f.id === oldId)
  if (!old || isInvalidated(old)) return { newId: null, superseded: false }
  // HUMAN AUTHORITY (isOperatorStated): a replacement authored by a model ('machine') or by a de-privileged
  // sender ('external') may not retire a fact the operator stated or a human adjudicated. Only the operator's
  // own statement supersedes it. Refusing here, at the mutator, means no future caller can launder a model
  // conclusion into the operator's provenance (constitution §3); the refusal mints no orphan replacement.
  if (isOperatorStated(old) && (source === 'machine' || source === 'external')) {
    console.debug(`[operator-model] supersede refused: a ${source} replacement cannot retire operator-stated fact ${oldId}`)
    return { newId: null, superseded: false }
  }
  const text = (newText || '').trim()
  if (!text || text.length < 3 || text.length > 300 || !verifyCandidate(text).ok) {
    return { newId: null, superseded: false }
  }
  // Reuse the new fact if it already exists as an active fact (don't duplicate); else create it.
  const key = norm(text)
  let target = store.find((f) => !isInvalidated(f) && norm(f.fact) === key)
  if (!target) {
    // Provenance: the new fact updates the superseded one, so it inherits that fact's
    // source lineage unless the caller (e.g. key-gated machine extraction) overrides it.
    // Never leave it untagged — an untagged fact silently reads as operator-authored.
    target = { id: mkId(), fact: text, kind: kind || old.kind || 'correction', status: 'candidate', ts: Date.now(), capturedAt: Date.now(), source: source ?? factSource(old) }
    store.unshift(target)
  } else if (isQuarantinedExternal(target)) {
    // The reused row is a pre-planted, still-quarantined 'external' candidate with the same
    // normalized text as this trusted replacement. Retiring `old` in its favor while it keeps
    // source 'external' would WIPE the subject: the real fact is invalidated + cascade-retired,
    // yet the "new" value never grounds (isQuarantinedExternal stays true). A trusted supersession
    // IS the vouching event that lifts quarantine — grant it the same provenance a freshly-minted
    // replacement would get (caller override, else `old`'s lineage) so the correction can ground.
    // Subtle because the create branch tagged provenance but the reuse branch never did, so an
    // attacker who planted the external row first turned the operator's correction into a net erase.
    target.source = source ?? factSource(old)
  }
  old.invalidatedAt = Date.now()
  old.supersededBy = target.id
  fireMaterialize(old, 'retire') // the seam — a superseded fact must not keep grounding (idempotent)
  // STAGE 2: retiring this premise cascades to the derived rules that rested on it (foundational
  // counting — only those that lose their last support; the new target fact is a fresh premise, unaffected).
  cascadeInvalidateDerived(new Set([oldId]))
  persist()
  return { newId: target.id, superseded: true }
}

/** Cold-start seed: add facts with an explicit status (candidate | provisional), sharing
 *  recordFacts' guards (dedup across ALL statuses incl. veto-memory, keyless junk-gate, char
 *  bounds). A `provisional` seed gets a probation clock so the govern loop can start verifying it
 *  — the legitimate way to seed HUMAN-VALIDATED vault principles as endorsed-but-still-proving.
 *  Idempotent (re-running adds nothing new). Never seeds `promoted` — that stays earned. */
export function seedFacts(items: { fact: string; kind?: string; status?: 'candidate' | 'provisional'; source?: FactSource }[]): { added: number; provisional: number } {
  const seen = new Set(store.map((f) => norm(f.fact)))
  let added = 0
  let provisional = 0
  for (const it of items) {
    const text = (it.fact || '').trim()
    if (!text || text.length < 3 || text.length > 300) continue
    if (!verifyCandidate(text).ok) continue
    const key = norm(text)
    if (seen.has(key)) continue
    seen.add(key)
    const status: FactStatus = it.status === 'provisional' ? 'provisional' : 'candidate'
    // Seeds default to operator-authored provenance (human-validated vault principles). A seed a MODEL
    // wrote (the DUIN_LADDER instinct summary) must say so, or the human-authority guards protect it.
    const f: OperatorFact = { id: mkId(), fact: text, kind: it.kind || 'principle', status, ts: Date.now(), capturedAt: Date.now(), source: it.source ?? 'operator' }
    if (status === 'provisional') {
      f.provisionalAt = Date.now()
      provisional++
    }
    store.unshift(f)
    added++
  }
  if (added) {
    // Was a status-blind `store.slice(0, MAX_FACTS)`: because seeds are unshifted, that trimmed the
    // OLDEST rows — exactly where earned `promoted` and veto-memory `vetoed` live — and persist()
    // fired immediately after. seedFacts never seeds `promoted`, so a re-seed could not restore it.
    // Same status-aware, tombstoning eviction as the other two call sites now.
    evictToCap('seed')
    persist()
  }
  return { added, provisional }
}

// ──────────────────── promotion governance (human gate) ────────────────────

// Lifecycle hook: a human verdict (promote/veto) is the signal the vault
// metabolism wants. operator-model stays pure/keyless — main.ts injects a hook
// that forwards the verdict into .duin/_state/corrections.jsonl (learn-bridge).
// Default no-op so unit tests and headless paths carry no engine dependency.
export type OperatorLifecycleHook = (
  fact: OperatorFact,
  action: 'promote' | 'veto',
  reason?: string
) => void
let lifecycleHook: OperatorLifecycleHook | null = null
export function setOperatorLifecycleHook(fn: OperatorLifecycleHook | null): void {
  lifecycleHook = fn
}

let measureHook: ((id: string) => void) | null = null
/** Item 13 — fired when a fact earns 'promoted' (via confirmFact) so it gets a first efficacy read
 *  incrementally instead of waiting for a bulk pass. Injected from main (fire-and-forget, key-gated)
 *  to avoid an operator-model → judgment-measure-live import cycle. */
export function setMeasureHook(fn: ((id: string) => void) | null): void {
  measureHook = fn
}

let materializeHook: ((f: OperatorFact, action: 'promote' | 'retire') => void) | null = null
/** The SEAM (PLANNING/DUIN_SEAM_BUILD_SPEC.md) — fired on promote (materialize a portable
 *  OKF concept file) and on revert/veto/supersede (retire it out of the grounding lane).
 *  Injected from main; the hook impl is flag-gated + fire-and-forget, so a concept-write
 *  failure can never block or crash the govern loop. */
export function setMaterializeHook(
  fn: ((f: OperatorFact, action: 'promote' | 'retire') => void) | null
): void {
  materializeHook = fn
}
/** Internal: safely fire the materialize hook (never throws into a caller). */
function fireMaterialize(f: OperatorFact | null, action: 'promote' | 'retire'): void {
  if (!f || !materializeHook) return
  try {
    materializeHook({ ...f }, action)
  } catch (e) {
    console.debug('[operator-model] seam hook never blocks:', messageOf(e))
  }
}

// Live-refresh seam: fired (fire-and-forget) after ANY mutation persists, so a live
// UI (LearningPanel) refreshes without polling — and, crucially, on AUTOMATIC changes
// (capture/govern loop), not just human veto. Injected from main; default no-op keeps
// this module pure for tests + the vault projector (no electron dependency here).
let changeHook: (() => void) | null = null
export function setOperatorChangeHook(fn: (() => void) | null): void {
  changeHook = fn
}

function setFact(id: string, mut: (f: OperatorFact) => void): OperatorFact | null {
  const f = store.find((x) => x.id === id)
  if (!f) return null
  mut(f)
  f.ts = Date.now()
  persist()
  return f
}

/** Human gate (verdict + optional 'why' forwarded to the learn loop): a candidate the
 *  human endorses lands on PROBATION — provisional, not yet a confirmed rule. It grounds
 *  softly and earns 'promoted' only by surviving + passing the dual-verifier (see
 *  operator-govern). The optional `reason` is forwarded as the correction's `why`. */
export function promoteFact(id: string, reason?: string): boolean {
  const f = setFact(id, (x) => {
    x.status = 'provisional'
    x.provisionalAt = Date.now()
    x.adjudicatedBy = 'human' // the human gate — the only thing verifierCalibration may count as a ruling
    if (!Array.isArray(x.observedSessions)) x.observedSessions = []
  })
  if (f && lifecycleHook) {
    try {
      lifecycleHook({ ...f }, 'promote', reason)
    } catch (e) { console.debug('[operator-model] best-effort  a forwarding failure never blocks the human gate:', messageOf(e)) }
  }
  // Telemetry, not just the correction forward above: autoPromoteCandidates emits this same
  // type with `by: 'auto'` for the machine transition, but this — the HUMAN half of the
  // identical candidate->provisional move — never did, so the events ledger could only ever
  // show the unattended promoter turning. `by` disambiguates the two origins in one query.
  if (f) emitFactEvent('operator.fact.promoted', { id: f.id, by: 'human' })
  if (f) fireMaterialize(f, 'promote') // W3: the seam projects provisional facts too
  return !!f
}
/** Human gate: suppress a fact AND remember the veto (never re-surface). Optional
 *  `reason` flows to the correction's `why`. */
export function vetoFact(id: string, reason?: string): boolean {
  const f = setFact(id, (x) => {
    x.status = 'vetoed'
    x.adjudicatedBy = 'human' // the refutation half of the same signal — a person said "never true"
  })
  if (f) {
    // STAGE 2: a veto retires the premise → cascade to derived rules that lose their last support.
    cascadeInvalidateDerived(new Set([id]))
    fireMaterialize(f, 'retire') // the seam — a vetoed fact must not keep grounding
    if (lifecycleHook) {
      try {
        lifecycleHook({ ...f }, 'veto', reason)
      } catch (e) { console.debug('[operator-model] best-effort:', messageOf(e)) }
    }
  }
  if (f) emitFactEvent('operator.fact.vetoed', { id: f.id })
  return !!f
}
/** Govern loop CONFIRM (dual-verifier passed): provisional -> confirmed 'promoted'.
 *  A machine transition — no human hook. */
export function confirmFact(id: string): boolean {
  let flipped = false
  const f = setFact(id, (x) => {
    // LIVENESS, not just status. A superseded fact keeps `status: 'provisional'` on purpose
    // (supersedeFact soft-deletes so the bi-temporal audit survives), so the status check alone
    // let a retired rule be re-confirmed — and the `fireMaterialize(f, 'promote')` below then
    // re-writes `<vault>/.brain/memory/concept-<id>.md` (concept-materialize slugFor) for a
    // rule the operator had already
    // corrected away, undoing supersedeFact's own `fireMaterialize(old, 'retire')`. Guarding at
    // the mutator and not only at the caller is deliberate: THIS transition is what
    // re-materialises the concept, so no future caller can resurrect a retired row by reading
    // status alone the way runGovernPass did.
    if (x.status === 'provisional' && isFactLive(x)) {
      x.status = 'promoted'
      x.promotedAt = Date.now() // the seam's stable date (W3)
      flipped = true
    }
  })
  if (flipped && measureHook) {
    try {
      measureHook(id) // item 13 — incremental measure on promotion; fire-and-forget
    } catch (e) { console.debug('[operator-model] never block confirm:', messageOf(e)) }
  }
  if (flipped) fireMaterialize(f, 'promote') // the seam — materialize the portable concept
  if (f) emitFactEvent('operator.fact.confirmed', { id: f.id, status: f.status })
  return !!f
}
/** Govern loop AUTO-REVERT (jury failed): provisional/promoted -> 'reverted'. Excluded
 *  from grounding and remembered so it isn't blindly re-promoted. Machine transition. */
export function revertFact(id: string): boolean {
  let changed = false
  const f = setFact(id, (x) => {
    if (x.status === 'provisional' || x.status === 'promoted') {
      x.status = 'reverted'
      x.reverts = (x.reverts ?? 0) + 1
      changed = true
    }
  })
  if (changed) fireMaterialize(f, 'retire') // the seam — reverted facts must not keep grounding
  if (f) emitFactEvent('operator.fact.reverted', { id: f.id, status: f.status })
  return !!f
}

/** W5 human verb — RATIFY: the person lands a live provisional fact as a confirmed rule. The govern
 *  loop's confirmFact is the automatic word (glossary: "Confirm … never a human act"); this is the
 *  operator's. Stamps adjudicatedBy 'human' and promotedAt, forwards the endorsement to the learn
 *  loop, projects through the seam. Refuses anything that is not a live provisional fact. */
export function ratifyFact(id: string, reason?: string): boolean {
  const f = store.find((x) => x.id === id)
  if (!f || f.status !== 'provisional' || !isFactLive(f)) return false
  setFact(id, (x) => {
    x.status = 'promoted'
    x.promotedAt = Date.now()
    x.adjudicatedBy = 'human'
  })
  if (lifecycleHook) {
    try {
      lifecycleHook({ ...f }, 'promote', reason)
    } catch (e) { console.debug('[operator-model] best-effort — a forwarding failure never blocks the human gate:', messageOf(e)) }
  }
  if (measureHook) {
    try {
      measureHook(id)
    } catch (e) { console.debug('[operator-model] never block ratify:', messageOf(e)) }
  }
  fireMaterialize(f, 'promote')
  emitFactEvent('operator.fact.confirmed', { id: f.id, status: f.status, by: 'human' })
  return true
}

/** W5 human verb — UN-VETO: the person takes a veto back. The fact returns to probation under human
 *  authority (provisional, adjudicatedBy 'human'), exactly where promoteFact puts an endorsed
 *  candidate; it earns 'promoted' through the govern loop or a ratify. Refuses non-vetoed rows. */
export function unvetoFact(id: string, reason?: string): boolean {
  const f = store.find((x) => x.id === id)
  if (!f || f.status !== 'vetoed') return false
  setFact(id, (x) => {
    x.status = 'provisional'
    x.provisionalAt = Date.now()
    x.adjudicatedBy = 'human'
    if (!Array.isArray(x.observedSessions)) x.observedSessions = []
  })
  if (lifecycleHook) {
    try {
      lifecycleHook({ ...f }, 'promote', reason)
    } catch (e) { console.debug('[operator-model] best-effort:', messageOf(e)) }
  }
  fireMaterialize(f, 'promote')
  emitFactEvent('operator.fact.unvetoed', { id: f.id })
  return true
}

/** W5 human verb — REVERT a supersession: the person says the OLD fact still holds. The old row is
 *  reinstated (valid-to cleared, human authority, standing kept) and the replacement that retired it
 *  is vetoed. Derived rules the supersession cascaded are not restored. Refuses a row that was not
 *  superseded. */
export function revertSupersession(oldId: string, reason?: string): boolean {
  const old = store.find((x) => x.id === oldId)
  if (!old || !isInvalidated(old) || !old.supersededBy) return false
  const replacementId = old.supersededBy
  delete old.invalidatedAt
  delete old.supersededBy
  delete old.invalidatedBy
  old.adjudicatedBy = 'human'
  old.ts = Date.now()
  persist()
  const rep = store.find((x) => x.id === replacementId)
  if (rep && !isInvalidated(rep) && rep.status !== 'vetoed') {
    vetoFact(rep.id, reason ?? 'the operator reinstated the fact it replaced')
  }
  if (old.status === 'promoted' || old.status === 'provisional') fireMaterialize(old, 'promote')
  emitFactEvent('operator.fact.reinstated', { id: old.id, replaced: replacementId })
  return true
}

/** Keyless facts parked at 'ratify' (provisional, live, jury abstained and the survival bar met) —
 *  what the Learning panel's "Awaiting your ratification" section and the Needs-you card list. */
export function getAwaitingRatify(): OperatorFact[] {
  return store.filter((f) => f.status === 'provisional' && isFactLive(f) && f.govern?.verdict === 'ratify')
}

/** Superseded rows (valid-to set by a supersession), newest first — the "Superseded" list. */
export function getSupersededFacts(): OperatorFact[] {
  return store
    .filter((f) => isInvalidated(f) && !!f.supersededBy)
    .sort((a, b) => (b.invalidatedAt ?? 0) - (a.invalidatedAt ?? 0))
}

/** Learning automation — the human endorse gate, removed. Advances every candidate that has already
 *  cleared capture (verifyCandidate + dedup, and — on the main path — reflect + the dual-verifier) onto
 *  PROBATION: provisional, adjudicatedBy 'auto'. This is the mechanical replacement for a person clicking
 *  Endorse. It changes WHO endorses, not the rigor after: the fact still grounds only SOFTLY as
 *  provisional and earns 'promoted' exclusively through the govern loop (dual-verifier + survived
 *  sessions), so nothing auto-confirms itself into a followed rule.
 *
 *  Two boundaries are deliberately preserved:
 *   1. EXTERNAL-sourced captures are skipped — they stay `candidate`, which keeps them QUARANTINED from
 *      grounding (isQuarantinedExternal). The SSGM/DRIFT quarantine is a poisoning defense against a
 *      de-privileged inbound turn, NOT the taste gate the operator asked to automate; a non-operator
 *      still cannot reach the prompt without a human.
 *   2. This is a MACHINE transition — it does NOT fire the lifecycle hook (mirroring confirmFact), so an
 *      auto-promotion never lands in corrections.jsonl / taste masquerading as a human verdict. The full
 *      lifecycle record (status, adjudicatedBy:'auto', provisionalAt, ts) stays on the fact, so the
 *      operator-model store IS the auditable "what DUIN learned, unattended" list (getAllOperatorFacts).
 *
 *  Returns the number promoted. */
/**
 * Best-effort lifecycle telemetry for the Remember loop.
 *
 * Of 34,807 rows in `events`, not one matched memory / fact / capture / promotion /
 * correction — so every question about whether this loop was turning had to be
 * answered by diffing file mtimes by hand. A loop that cannot report on itself is
 * a loop nobody notices has stopped (constitution property 7).
 *
 * INJECTED rather than imported, following the four hooks already in this module
 * (lifecycle / measure / materialize / change). A static `import` of event-log would
 * drag the database handle and electron's `app` into every unit test of this file,
 * and a lazy `require` is simply undefined under vitest's ESM — it would swallow
 * every emission and be unverifiable, which is how instrumentation ends up existing
 * and reporting nothing.
 */
export type OperatorEventHook = (type: string, payload: Record<string, unknown>) => void
let eventHook: OperatorEventHook | null = null
export function setOperatorEventHook(fn: OperatorEventHook | null): void {
  eventHook = fn
}

function emitFactEvent(type: string, payload: Record<string, unknown>): void {
  if (!eventHook) return
  try {
    eventHook(type, payload)
  } catch {
    /* telemetry is never load-bearing */
  }
}

/** Log-once latch so a held promoter does not spam a line every turn. */
let heldPromotionLogged = false

export function autoPromoteCandidates(): number {
  // The governor's decision is binding here — this is the unattended promoter.
  //
  // On 2026-07-30 the earned-autonomy governor demoted this capability to `hold`
  // on real evidence (97 reverts against 48 ratifies) and NOTHING READ THAT
  // DECISION: `classify()` had no caller for it, so promotion carried on straight
  // through the demotion. A governor that decides correctly into a void is worse
  // than no governor, because it looks like a safeguard.
  //
  // Only `hold` blocks. `stage` is the registration default and blocking it would
  // freeze the one arm of the Learn loop that actually turns — the governor
  // reaches `hold` deliberately, from evidence, and that is the signal worth
  // honouring. Human promotion (`promoteFact`) and the govern pass's own
  // `confirmFact` are untouched: this gate is about acting unattended.
  // 'unknown' blocks too, and for the opposite reason to 'hold': hold is a decision, unknown is the
  // absence of one. The ledger resets to [] on corruption, so without this a governor hold reached
  // from real evidence would not survive a bad file and unattended promotion would quietly resume.
  // Blocking on "I cannot tell" is the only safe reading when the alternative is acting unwatched.
  const promotionRung = classify(OPERATOR_FACT_PROMOTION_CAP_ID)
  if (promotionRung === 'hold' || promotionRung === 'unknown') {
    if (!heldPromotionLogged) {
      heldPromotionLogged = true
      console.warn(
        '[operator-model] auto-promotion is on HOLD — the autonomy governor demoted ' +
          `"${OPERATOR_FACT_PROMOTION_CAP_ID}" after too many reverts. Candidates will ` +
          'accumulate until it is ratified back up.'
      )
    }
    emitFactEvent('operator.promotion.held', {
      capability: OPERATOR_FACT_PROMOTION_CAP_ID,
      candidates: store.filter((f) => f.status === 'candidate').length
    })
    return 0
  }
  heldPromotionLogged = false
  let promoted = 0
  const now = Date.now()
  // Read ONCE, before the loop: the semiring's input (relInput) is source-tier + dependsOn only and
  // never reads `status`, so flipping rows to provisional below cannot move any entry in this map.
  const rel = groundingReliability()
  for (const f of store) {
    if (f.status !== 'candidate' || isInvalidated(f)) continue
    if (factSource(f) === 'external') continue // stays quarantined — human-gated by design
    // ...and the SIBLING quarantine, which this loop used to lift on the very next capture turn.
    //
    // isLowTrustDerived exempts 'provisional'/'promoted' because its contract is "suppressed until a
    // HUMAN promotes it" — but THIS is the unattended promoter, and it granted that status with no
    // human and no reliability read. So a fold the independent NLI verifier labelled `contradicts`
    // (edgeTrust 0.1), or one that laundered an external premise (capped ≤0.3), was suppressed from
    // grounding for exactly one turn and then re-admitted here by a machine — and re-admitted UNDER A
    // STRONGER TIER, since buildOperatorBlock gates only the candidate list and prints provisional
    // rules as "Endorsed, on probation (apply — being validated)". The Stage-3 poisoning defense had
    // a one-turn half-life.
    //
    // What made it invisible: both grounding consumers (buildOperatorBlock, the agui recall path) call
    // the predicate correctly, so every test aimed at the gate passed. The leak was upstream of them —
    // a status WRITE that silently satisfied the predicate's exemption clause.
    if (isLowTrustDerived(f, rel.get(f.id) ?? 1)) continue // poison-suspect — waits for a real verdict
    f.status = 'provisional'
    f.provisionalAt = now
    f.adjudicatedBy = 'auto'
    if (!Array.isArray(f.observedSessions)) f.observedSessions = []
    fireMaterialize(f, 'promote') // W3: the seam projects provisional facts too
    promoted++
  }
  if (promoted) {
    persist()
    emitFactEvent('operator.fact.promoted', { count: promoted, by: 'auto' })
  }
  return promoted
}
/** Phase 1 unification — apply a HUMAN-CONFIRMED binding's rule to grounding by landing it
 *  in the operator-model lifecycle. The binding-ledger already closes the recurrence→bind→
 *  held-out-prediction loop, but (per its own header) never applied the bound rule to the
 *  prompt. This is that missing arrow: a bound rule enters as a PROVISIONAL fact (human-
 *  endorsed, on probation), so it grounds softly immediately (buildOperatorBlock's provisional
 *  tier) and earns 'promoted' + rerank-inclusion only via the existing govern pass. If the
 *  same rule text is already an active fact, it is linked + lifted to provisional rather than
 *  duplicated — unless that row already carries a VERDICT: a 'vetoed' row returns null (veto
 *  memory) and a 'reverted' row is linked but never lifted, so its `reverts` history stands.
 *  `source` defaults 'operator' (a bind is a human confirmation). Returns the fact id, or null
 *  if the rule failed the capture guards or its text is under veto. */
export function recordBoundRule(rule: string, bindingId: string, source: FactSource = 'operator'): string | null {
  let text = (rule || '').trim()
  const bid = (bindingId || '').trim()
  if (!text || text.length < 3 || !bid) return null
  if (text.length > 300) text = text.slice(0, 300) // clip (bindings have no length cap) rather than silently drop
  if (!verifyCandidate(text).ok) return null
  const key = norm(text)
  // Look the row up by TEXT ALONE, then let its STATUS choose the policy. Folding the status test
  // into the lookup (`… && f.status !== 'vetoed' && f.status !== 'reverted'`) left `existing`
  // undefined for exactly the two statuses that carry a verdict, so execution fell through to the
  // unconditional mint below and re-created the rule as a BRAND-NEW provisional fact — fresh id,
  // bindingBorn, no `reverts`. That silently voided the two memories this store promises:
  // recordFacts' "deduped across ALL statuses, so a vetoed fact is never re-added" veto memory,
  // and operator-govern's own claim (in the mass-revert guard) that reverting "blocks re-linking
  // via recordBoundRule". What made it invisible: nothing was overwritten and no counter moved —
  // the verdicted row sat untouched in the store beside its resurrected twin, so only the prompt
  // showed the rule was back under "Endorsed, on probation".
  const matches = store.filter((f) => !isInvalidated(f) && norm(f.fact) === key)
  // Veto memory: a human said "never true" of this text. A bind IS a human confirmation, but it
  // confirms a theme's recurrence — not this refutation — so it must not overrule the veto. The
  // caller (POST /state/bind-candidate) already handles the null and keeps the binding ledger row.
  // Asked over ALL matching rows rather than just the first, so the veto still wins on a store the
  // old fall-through already polluted — there, the re-minted twin is NEWER and `store` is
  // newest-first, so a positional lookup would find the twin and never see the veto behind it.
  if (matches.some((f) => f.status === 'vetoed')) return null
  const existing = matches[0]
  if (existing) {
    // Link an already-known rule (don't duplicate). The binding id joins the fact's link SET.
    if (!Array.isArray(existing.bindingIds)) existing.bindingIds = []
    if (!existing.bindingIds.includes(bid)) existing.bindingIds.push(bid)
    if (existing.status === 'candidate') {
      // The bind endorses this candidate → provisional, and that endorsement is bind-caused,
      // so it is bindingBorn (a later binding failure may revert it).
      existing.status = 'provisional'
      existing.provisionalAt = Date.now()
      existing.bindingBorn = true
      if (!Array.isArray(existing.observedSessions)) existing.observedSessions = []
    }
    // A pre-existing provisional/promoted fact keeps its INDEPENDENT merit: bindingBorn stays
    // falsy, so a binding failure only unlinks it — its own earned status is never discarded.
    // A 'reverted' row keeps its VERDICT the same way: the candidate-only lift above cannot raise
    // it, so the govern loop's `reverts` counter and history survive this re-bind. Recording the
    // link is still worth it (the audit shows which binding re-asserted a failed rule) and cannot
    // double-count: revertByBindingId only decrements a provisional/promoted row.
    persist()
    if (existing.status === 'provisional' && isFactLive(existing)) fireMaterialize(existing, 'promote') // W3
    return existing.id
  }
  const f: OperatorFact = {
    id: mkId(),
    fact: text,
    kind: 'correction',
    status: 'provisional',
    ts: Date.now(),
    capturedAt: Date.now(),
    provisionalAt: Date.now(),
    observedSessions: [],
    source,
    bindingIds: [bid],
    bindingBorn: true
  }
  store.unshift(f)
  persist()
  fireMaterialize(f, 'promote') // W3: a bound rule lands provisional and projects at once
  return f.id
}

/** Phase 1 unification — a binding's held-out "won't recur" prediction FAILED (a matching
 *  correction recurred), so this binding no longer justifies its linked fact: UNLINK it. The
 *  fact reverts (provisional/promoted → 'reverted') only if it is bindingBorn AND no other
 *  linked binding still justifies it — so (a) an independently-earned fact a bind merely linked
 *  is unlinked but keeps its merit, and (b) a rule justified by two bindings survives until BOTH
 *  fail. Returns the number of facts actually reverted. */
export function revertByBindingId(bindingId: string): number {
  const bid = (bindingId || '').trim()
  if (!bid) return 0
  let reverted = 0
  let changed = false
  for (const f of store) {
    if (!Array.isArray(f.bindingIds) || !f.bindingIds.includes(bid)) continue
    f.bindingIds = f.bindingIds.filter((x) => x !== bid) // the failed binding no longer justifies it
    changed = true
    if (f.bindingBorn && f.bindingIds.length === 0 && (f.status === 'provisional' || f.status === 'promoted')) {
      f.status = 'reverted'
      f.reverts = (f.reverts ?? 0) + 1
      reverted++
      fireMaterialize(f, 'retire') // the seam — this demotion must retire the concept too
    }
  }
  if (changed) persist()
  return reverted
}

/** Survival counter (Verifier 1 / recurrence-clean proxy): record that every provisional
 *  fact lived through one more DISTINCT session without a human re-correction. Returns
 *  the number of facts bumped. */
export function noteSession(sessionId: string): number {
  const sid = (sessionId || '').trim()
  if (!sid) return 0
  let bumped = 0
  let changed = false
  for (const f of store) {
    if (f.status !== 'provisional') continue
    if (!Array.isArray(f.observedSessions)) f.observedSessions = []
    if (!f.observedSessions.includes(sid)) {
      f.observedSessions.push(sid)
      bumped++
      changed = true
    }
    // W2 (causal survival credit): convert a pending endorsement (recall-efficacy graded a
    // trusted turn positive while THIS fact was injected) into an EARNED session tick, on the
    // same boundary clock as the tenure counter above — so earned ⊆ observed by construction.
    if (endorsedPending.has(f.id)) {
      if (!Array.isArray(f.earnedSessions)) f.earnedSessions = []
      if (!f.earnedSessions.includes(sid)) {
        f.earnedSessions.push(sid)
        changed = true
      }
      endorsedPending.delete(f.id)
    }
  }
  // Hygiene: pending entries whose fact is gone or no longer provisional can never convert —
  // drop them so the set can't accumulate across promotions/reverts.
  for (const id of [...endorsedPending]) {
    const f = store.find((x) => x.id === id)
    if (!f || f.status !== 'provisional') endorsedPending.delete(id)
  }
  if (changed) persist()
  return bumped
}

// W2 — endorsement staging between the recall-efficacy grade (turn-level) and the session
// boundary (noteSession). In-memory by design: a restart loses at most one session's pending
// endorsements, which only DELAYS earning (the safe direction — a tick can be re-earned).
const endorsedPending = new Set<string>()

/** Record that these operator facts were injected on a turn the operator then ENDORSED
 *  (called by recall-efficacy on a positive grade of a TRUSTED turn). The pending mark
 *  converts to an earned session tick at the next noteSession boundary. Returns how many
 *  ids were staged. */
export function noteFactEndorsed(ids: string[]): number {
  let n = 0
  for (const id of ids) {
    if (typeof id === 'string' && id) {
      endorsedPending.add(id)
      n++
    }
  }
  return n
}

/** Test seam (W2). */
export function __clearEndorsedPending(): void {
  endorsedPending.clear()
}
/** Record a fresh A/B measurement onto a promoted fact (durable). Additive — does NOT change
 *  status or prune (prune stays human-gated); it persists the measured signal so grounding + the
 *  improvement queue can read it instead of re-running the costly A/B. */
export function recordMeasurement(
  id: string,
  m: { verdict: MeasureOutcome; flips: number; regressions: number; trials: number; flipRate: number }
): void {
  const f = store.find((x) => x.id === id)
  if (!f) return
  f.efficacy = {
    flipRate: m.flipRate,
    flips: m.flips,
    regressions: m.regressions,
    trials: m.trials,
    verdict: m.verdict,
    measuredAt: Date.now()
  }
  persist()
}

/** Facts whose latest A/B measurement flagged them prune-candidate (measured no-lift / regression),
 *  ordered regressions-first — the durable feed into the improvement queue (item 3). */
export function pruneCandidatesFromStore(): { id: string; text: string }[] {
  return store
    // Only PROMOTED rules become prune-fact proposals — a reverted fact keeps its efficacy but is
    // already a retire-rule candidate, so status-guarding here avoids duplicate review entries.
    .filter((f) => f.status === 'promoted' && f.efficacy?.verdict === 'prune-candidate')
    .sort((a, b) => (b.efficacy?.regressions ?? 0) - (a.efficacy?.regressions ?? 0))
    .map((f) => ({ id: f.id, text: f.fact }))
}

/** Reasoning-trace Stage 2 — cascade a premise RETRACTION over the verified DEPENDS_ON edges. Given the
 *  just-retired premise ids, invalidate the DERIVED facts that lose their last support (foundational
 *  belief-base contraction via counting; a rule with an alternate intact derivation SURVIVES; human-
 *  confirmed rules are protected; missing/evicted premises count as live so eviction never cascades).
 *  SOFT-delete (invalidatedAt, invalidatedBy:'cascade') — never hard-delete, so the bi-temporal audit can
 *  still walk why a rule fell. Returns the cascaded ids; persists iff anything changed. Called from the
 *  retraction paths (supersedeFact / vetoFact) — the retraction stays an EXPLICIT input (choosing the
 *  minimal retraction set is NP-hard; only the forward walk must be cheap). */
export function cascadeInvalidateDerived(retired: Set<string>): string[] {
  const targets = cascadeTargets(store, retired)
  if (targets.length === 0) return []
  const now = Date.now()
  const t = new Set(targets)
  for (const f of store) {
    if (t.has(f.id) && f.invalidatedAt == null) {
      f.invalidatedAt = now
      f.invalidatedBy = 'cascade'
    }
  }
  persist()
  return targets
}

/** Stage 6 — SUPPORT EROSION, the graded half of the cascade.
 *
 *  Stage 2 answers retraction with a boolean, so a rule that loses one of two justifications survives at
 *  completely undiminished confidence: the brain forgets it is now standing on weaker ground. This
 *  measures that loss. It is computed statelessly — no extra bookkeeping on the retraction path — by
 *  evaluating each fact's how-provenance polynomial twice over the SAME structure: once as if nothing
 *  had ever been retired, and once against the store's actual retirements. The gap is how much the
 *  rule's support has eroded since it was minted.
 *
 *  Reported, never enforced. Losing a justification is grounds to re-examine a belief, not to delete it,
 *  and a promoted rule quietly losing its evidence is exactly what the operator needs surfaced while the
 *  system still refuses to retract it on its own. */
export function supportErosion(): Map<string, Degradation> {
  const relFacts: RelFact[] = store.map((f) => ({ id: f.id, source: factSource(f), dependsOn: f.dependsOn }))
  const retired = store.filter((f) => isInvalidated(f) || f.status === 'vetoed').map((f) => f.id)
  const out = new Map<string, Degradation>()
  if (retired.length === 0) return out
  // The store's own retirements ARE the dead set — cascadeTargets already decided them on the retraction
  // path, so this only grades the survivors and never re-litigates a death. Human-confirmed rules are
  // leaves: they cannot be auto-retracted, so their premises must not be inlined into their dependents.
  const protectedRule = (id: string): boolean => {
    const s = store.find((x) => x.id === id)?.status
    return s === 'promoted' || s === 'provisional'
  }
  for (const d of gradedCascade(relFacts, { dead: retired, isLeaf: (f) => protectedRule(f.id) }).degraded) out.set(d.id, d)
  return out
}

/** Record govern-loop provenance on a fact (item 15). Additive; persists WHY a fact was
 *  confirmed / reverted / held + which model juried it. */
export function recordGovernProvenance(id: string, p: GovernProvenance): void {
  const f = store.find((x) => x.id === id)
  if (!f) return
  f.govern = p
  persist()
}

/** Record a FOLD-derived rule + its verified reasoning-trace provenance (Stage 1). A consolidation/
 *  reflection fold collapses several input claims into one rule; this records the rule (dedup by
 *  normalized text like recordFacts — a re-fold attaches the edge to the existing fact instead of
 *  duplicating) AND a DEPENDS_ON edge naming the input claims + the INDEPENDENT NLI verdict on that
 *  derivation (never the fold model's own say-so). Returns the rule's fact id (null if the text failed
 *  the capture guards). The edge is the walkable "why this rule exists" that buildGovernAudit joins.
 *  A null `verify` (keyless / abstained) still records the edge but UNVERIFIED (verifier: null).
 *  A fold whose rule text dedups onto one of its OWN premises records NO edge (a fact may not be its
 *  own premise); it returns that premise's id, since the rule is already in the store — see below. */
export function recordDerivedFact(
  fact: string,
  kind: string,
  dependsOn: string[],
  verify: { label: 'entails' | 'neutral' | 'contradicts'; score: number; rationale: string; verifier: string | null } | null
): string | null {
  const text = (fact || '').trim()
  if (!text || text.length < 3 || text.length > 300) return null
  if (!verifyCandidate(text).ok) return null // same capture guard as recordFacts — drop junk at the door
  const key = norm(text)
  let f = store.find((x) => !isInvalidated(x) && norm(x.fact) === key)
  // A fold must never become its OWN premise. The dedup above matches by NORMALIZED text (case +
  // trailing punctuation stripped), and the callers pass the cluster's own member ids as `dependsOn` —
  // so when the fold model just echoes one of its input claims back as the "rule", `find` resolves onto
  // a fact that is ALSO in `dependsOn`, and the edge below would make that fact depend on itself.
  // Circular justification carries no support, and everything downstream then misreads the echoed
  // capture as a derived rule: cascadeTargets stops treating it as a root, so retiring a SIBLING premise
  // soft-deletes the operator's own directly-captured fact with invalidatedBy:'cascade'; and
  // reliabilityByFact caps it at the edge's trust (0.1 for a `contradicts` verdict), dropping a human
  // capture below TRUST_FLOOR so isLowTrustDerived suppresses it from grounding and auto-promotion.
  // The rule text is already in the store — as the premise — so the echo is recorded as nothing at all.
  // (Recording it as a SECOND node instead would split one proposition across two ids, fragmenting the
  // alternate-support count, the erosion reading and the audit, which the dedup exists to prevent.)
  // What made it invisible: the fact's TEXT never changes, so the store still reads exactly as the
  // operator left it — only the edge underneath it is new, and only a sibling's retirement reveals it.
  if (f && dependsOn.includes(f.id)) return f.id
  if (!f) {
    f = { id: mkId(), fact: text, kind: kind || 'context', status: 'candidate', ts: Date.now(), capturedAt: Date.now(), source: 'machine' }
    store.unshift(f)
    evictToCap('derive', [f.id]) // never evict the fact we just derived (its edge would dangle)
  }
  const edge: DependsOnEdge = {
    depends_on: dependsOn.filter((x) => typeof x === 'string' && x),
    verdict: verify?.label ?? 'neutral',
    score: verify?.score ?? 0,
    rationale: verify?.rationale ?? '',
    verifier: verify?.verifier ?? null,
    ts: Date.now()
  }
  f.dependsOn = [...(f.dependsOn ?? []), edge]
  persist()
  return f.id
}

/** The govern audit trail (item 15) + reasoning-trace provenance (Stage 1): every fact carrying govern
 *  OR derivation provenance, newest first. For a fold-derived rule the audit JOINS each DEPENDS_ON edge's
 *  input-claim ids back to their fact TEXT (`premises`) — so the audit walks WHY a rule exists (the input
 *  claims it was folded from + the independent NLI verdict), not only which ids. */
export function buildGovernAudit(): {
  generatedAt: number
  facts: {
    id: string
    fact: string
    status: FactStatus
    govern?: GovernProvenance
    dependsOn?: (DependsOnEdge & { premises: string[] })[]
    /** Stage 3: calibrated reliability over the derivation trust-semiring, capped by source tier
     *  (min(provenance_tier, content_score)) — the poisoning-resistant "how much to trust this rule". */
    reliability?: number
    /** Stage 5: the same trust as an INTERVAL, discounted by the verifier's measured precision. The
     *  WIDTH is the audit's point: a narrow band means the derivation has been checked by a verifier we
     *  have actually measured; a wide one means the number rests on an unmeasured check. `hi` never
     *  exceeds `reliability`, so this can only ever read as more cautious than the point. */
    reliabilityBounds?: RelBound
    /** Stage 6: how much this rule's support has ERODED since it was minted — present only when a
     *  premise it rested on has since been retired. A boolean cascade cannot show this: the rule
     *  survived, so it reports nothing at all, even though it now rests on fewer derivations. */
    supportErosion?: Degradation
  }[]
} {
  const textOf = (id: string): string => store.find((x) => x.id === id)?.fact ?? id
  // Trust semiring over the whole store's derivation graph (Stage 3), computed once for the audit.
  const rel = reliabilityByFact(relInput())
  const relB = reliabilityBoundsByFact(relInput(), verifierCalibration())
  const erosion = supportErosion()
  return {
    generatedAt: Date.now(),
    facts: store
      .filter((f) => f.govern || (f.dependsOn && f.dependsOn.length > 0))
      .map((f) => ({
        id: f.id,
        fact: f.fact,
        status: f.status,
        ...(f.govern ? { govern: f.govern } : {}),
        ...(f.dependsOn && f.dependsOn.length > 0
          ? {
              dependsOn: f.dependsOn.map((e) => ({ ...e, premises: e.depends_on.map(textOf) })),
              reliability: rel.get(f.id) ?? tierScoreOf(f), // calibrated, poisoning-capped trust
              ...(relB.has(f.id) ? { reliabilityBounds: relB.get(f.id)! } : {}), // + how well established
              ...(erosion.has(f.id) ? { supportErosion: erosion.get(f.id)! } : {}) // + what support it has LOST
            }
          : {})
      }))
      .sort((a, b) => (b.govern?.ts ?? b.dependsOn?.[0]?.ts ?? 0) - (a.govern?.ts ?? a.dependsOn?.[0]?.ts ?? 0))
  }
}

/** Source-tier fallback for a fact's reliability (operator > machine > external), used when the semiring
 *  has no entry. Mirrors derivation-reliability.tierScore over the store's own source lineage. */
function tierScoreOf(f: OperatorFact): number {
  const s = factSource(f)
  return s === 'operator' ? 1.0 : s === 'external' ? 0.3 : 0.7
}

/** The store as trust-semiring input, source normalized via factSource (so a legacy null-source row
 *  reads as the canonical 'operator', consistent with the rest of the store — not the raw 0.7 default). */
const relInput = (): RelFact[] => store.map((f) => ({ id: f.id, source: factSource(f), dependsOn: f.dependsOn }))

/** Query the calibrated reliability of a single fact (Stage 3 trust semiring). A read surface for the
 *  audit + the grounding gate that suppresses a low-trust derived rule. */
export function factReliability(id: string): number {
  return reliabilityByFact(relInput()).get(id) ?? 0.5
}

/** The whole-store reliability map (Stage 3 trust semiring) — the shared input for every grounding gate
 *  (buildOperatorBlock's whole-dump path AND the agui-grounding recall path), so the fold-laundering
 *  poisoning defense covers EVERY grounding path, not only the fallback. */
export function groundingReliability(): Map<string, number> {
  return reliabilityByFact(relInput())
}

/** Stage 5 — the LEARNED WEIGHT, measured from live HUMAN adjudication rather than assumed.
 *
 *  The Stage-3 semiring treats a verified 'entails' edge as if the NLI check itself were certain. Whether
 *  that verifier is actually right is an empirical question the store can already answer: when the
 *  verifier claimed a fold's premises entailed its rule, a human later either promoted that rule (the
 *  verifier was right) or vetoed it (wrong). Counting those gives the verifier's observed precision,
 *  which `verifierBounds` turns into a Wilson-95 interval — narrow once well observed, honestly wide
 *  while it is not.
 *
 *  WHAT COUNTS, and why `reverted` is excluded:
 *    - `provisional` / `promoted` count as the verifier having been right, `vetoed` as wrong.
 *    - `reverted` is EXCLUDED because revertFact is the govern jury's MACHINE transition, and that jury
 *      resolves through routeModel('extraction') — the SAME model the NLI verifier uses when no distinct
 *      model is available. Counting it would let the verifier grade its own homework and pass the result
 *      off as independent evidence. `confirmFact` is likewise not a separate datum; it only moves an
 *      already-provisional fact to promoted.
 *    - `candidate` is unadjudicated — not a silent success. Counting it would manufacture precision out
 *      of inactivity.
 *
 *  THIS IS AN ADJUDICATION SIGNAL, NOT A PURELY HUMAN ONE — stated precisely because the distinction was
 *  overclaimed once already. `vetoFact` is a human action, but `provisional` has THREE writers and only
 *  one is a human gate: promoteFact (human), seedFacts (e.g. world-update-act-write-native seeds a
 *  machine-generated summary as provisional under DUIN_LADDER=1), and applyBoundRule (promotes from the
 *  binding ledger without touching promoteFact). Since recordDerivedFact dedupes a fold onto any active
 *  fact by normalized text, a machine-seeded provisional can acquire a verified edge and read as a
 *  success no human ever adjudicated. Isolating the human path would need a promotion-origin marker the
 *  store does not currently carry.
 *
 *  CONSEQUENCE, stated honestly: that contamination inflates measured precision, and because Wilson's
 *  lower bound rises monotonically with the hit rate, it raises `lo` — which IS the ranking key in
 *  rankByEstablishedTrust. So contamination can make RANKING less conservative. What it cannot do is
 *  break the safety invariant: `vb.hi <= 1` keeps every `hi <= the Stage-3 point` regardless of how the
 *  ledger is skewed, so no amount of inflation lets a fact outrank the point estimate that gates it. */
export function verifierCalibration(): VerifierCalibration {
  let correct = 0
  let observed = 0
  for (const f of store) {
    // Only folds where the verifier made a positive claim are evidence about its precision; an abstained
    // (verifier null) or 'neutral' edge asserted nothing a human could confirm or refute.
    if (!f.dependsOn?.some((e) => e.verifier != null && e.verdict === 'entails')) continue
    // ...and only where a HUMAN actually ruled. `provisional` has three writers (promoteFact human,
    // seedFacts machine, applyBoundRule), so status alone counted a machine-seeded fact that picked up
    // a verified edge via text dedup as a success no person ever gave — measuring the verifier against
    // its own side of the ledger. Absent marker ⇒ not evidence, in either direction.
    if (f.adjudicatedBy !== 'human') continue
    if (f.status === 'promoted' || f.status === 'provisional') {
      correct++
      observed++
    } else if (f.status === 'vetoed') {
      observed++
    }
  }
  return { correct, observed }
}

/** The whole-store reliability BOUNDS map (Stage 5) — the distributional counterpart of
 *  groundingReliability, discounted by the verifier's measured precision. By construction every `hi` is
 *  ≤ the Stage-3 point, so any decision driven by these bounds is tighten-only. */
export function groundingReliabilityBounds(): Map<string, RelBound> {
  return reliabilityBoundsByFact(relInput(), verifierCalibration())
}

/** Below this calibrated reliability a DERIVED candidate rule is suppressed from grounding (Stage 3
 *  poisoning defense). 0.35 sits above the external tier (0.3) and below the unverified-fold neutral
 *  (0.5): a fold that laundered EXTERNAL content (reliability ≤0.3, capped by the external premise) or
 *  rode a 'contradicts' edge (0.1) is gated, while an ordinary operator-premise fold (verified 0.7 or
 *  unverified 0.5) still grounds. Closes the gap the source-tag quarantine misses — a fold relabels its
 *  source 'machine', so isQuarantinedExternal alone can't see the external premise underneath it. */
export const TRUST_FLOOR = 0.35

/** A DERIVED candidate whose calibrated reliability is below the floor — poison-suspect, suppressed from
 *  grounding until a human promotes it (human-confirmed rules are exempt, like the external quarantine). */
export function isLowTrustDerived(f: OperatorFact, reliability: number): boolean {
  return (
    !!f.dependsOn &&
    f.dependsOn.length > 0 &&
    reliability < TRUST_FLOOR &&
    f.status !== 'promoted' &&
    f.status !== 'provisional'
  )
}

/** Item 9 — the persisted measured efficacy per promoted + provisional fact, for the read-only
 *  duin_efficacy surface (no model calls; reads what runMeasurePass already recorded). */
export function efficacySummary(): { id: string; fact: string; status: FactStatus; efficacy: FactEfficacy | null }[] {
  return [...listByStatus('promoted'), ...listByStatus('provisional')].map((f) => ({
    id: f.id,
    fact: f.fact,
    status: f.status,
    efficacy: f.efficacy ?? null
  }))
}

export function listByStatus(status: FactStatus): OperatorFact[] {
  return store.filter((f) => f.status === status)
}

// Content words (>2 chars) for auto-merge subsumption — drops short stopwords
// ("i", "on", "a") so "dark mode" ⊂ "I prefer dark mode" merges, but distinct
// facts ("ship on Fridays" vs "…Mondays") do not.
function contentWords(s: string): Set<string> {
  return new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2))
}
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (!b.has(w)) return false
  return true
}

/** Reflect (auto-merge): collapse a candidate whose content words are a PROPER
 *  subset of another candidate's — the less-rich phrasing of the same fact. Keeps
 *  the human review queue clean; keeps genuinely different facts apart. Pure,
 *  keyless. Returns # merged.
 *
 *  SOFT-delete, like every other semantic retirement in this store (supersedeFact:378,
 *  cascadeInvalidateDerived:657 — "never hard-delete, so the bi-temporal audit can still
 *  walk why a rule fell"). This call site used to `store.filter(...)` the subsumed row OUT,
 *  and that was UNRECOVERABLE data loss on correct input, because SUBSET IS NOT SYNONYMY:
 *  negation and qualification are ADDITIVE at the word level, so the richer superset can be
 *  the semantically OPPOSITE or a strictly NARROWER claim.
 *    - "ships code on fridays" {ships,code,fridays} ⊂ "never ships code on fridays"
 *      {never,ships,code,fridays} — contradictory, not duplicate. ("never" is 5 chars, so
 *      contentWords keeps it; only ≤2-char stopwords are dropped.)
 *    - "reviews PRs" ⊂ "reviews PRs from Ana only" — a general operator rule replaced by a
 *      narrow one.
 *  reflect() runs unconditionally on every capture turn (learnFromTurn), and the candidate
 *  row is the ONLY record that the fact was ever noticed, so the destroyed side never reached
 *  human review at all. The merge still happens — the subsumed row stops grounding
 *  (buildOperatorBlock + the review queue both exclude invalidated) — but it is now
 *  TRACEABLE: invalidatedAt (when), supersededBy (which richer fact absorbed it),
 *  invalidatedBy 'reflect' (how), retained in getAllOperatorFacts() for audit and recovery.
 *  Already-invalidated candidates are skipped so a merged row is never re-merged. */
export function reflect(): number {
  const cands = store.filter((f) => f.status === 'candidate' && !isInvalidated(f))
  const words = new Map(cands.map((f) => [f.id, contentWords(f.fact)]))
  /** subsumed id -> the richer candidate's id that absorbed it (the supersededBy lineage). */
  const merged = new Map<string, string>()
  for (const a of cands) {
    for (const b of cands) {
      if (a.id === b.id || merged.has(a.id) || merged.has(b.id)) continue
      // SSGM/DRIFT quarantine — poisoning by SUPERSESSION. A quarantined 'external' candidate must
      // never be the ABSORBER of a trusted row: the tombstone stamped below is the same retirement
      // supersedeFact performs, and learnFromTurn deliberately withholds that power from an
      // untrusted turn one line before it calls us ("only the operator's own turns can invalidate
      // operator state" — runAutoSupersede is gated on `trusted`, reflect() was not). Without this,
      // an unauthenticated inbound message (server.ts → learnFromTurn(q, a, execOk=false)) erases an
      // operator-taught fact from grounding AND from getPendingReview — where a human would have
      // caught it — just by echoing it back as a word-superset, and the absorber stays quarantined
      // so neither row grounds. Invisible because reflect() keyed only off `status`: both rows read
      // as plain candidates, and provenance lives in `source`, which this loop never consulted.
      // Same-trust pools are untouched (external may still absorb external), so a store with no
      // external rows merges exactly as before.
      if (isQuarantinedExternal(b) && !isQuarantinedExternal(a)) continue
      // HUMAN AUTHORITY (isOperatorStated): a model-inferred superset may not absorb the operator's own
      // statement — the absorbed row stops grounding, which is a model retiring what the operator said.
      // Operator-stated rows still merge among themselves; machine rows merge exactly as before.
      if (isOperatorStated(a) && !isOperatorStated(b)) continue
      const wa = words.get(a.id)!
      const wb = words.get(b.id)!
      if (wa.size > 0 && wa.size < wb.size && isSubset(wa, wb)) merged.set(a.id, b.id)
    }
  }
  if (merged.size) {
    const now = Date.now()
    for (const f of store) {
      const richer = merged.get(f.id)
      if (richer && f.invalidatedAt == null) {
        f.invalidatedAt = now
        f.supersededBy = richer
        f.invalidatedBy = 'reflect'
      }
    }
    persist()
  }
  return merged.size
}

/** Render the operator profile for grounding: confirmed RULES (strong) +
 *  noticed candidates (soft). Vetoed excluded. Empty when nothing learned.
 *
 *  FUSE (self-evolution Move 2, WS2.2): optional `staleIds` — facts the
 *  learning-metabolism flagged as currency-stale (they mention a resolved
 *  decision / passed stream). When provided + non-empty, those facts are
 *  DOWN-WEIGHTED: pulled out of their normal tier and re-rendered LAST under a
 *  "weigh lightly" header — never dropped. Called with no arg (the default), the
 *  output is byte-identical to before, so the wiring is inert until the caller
 *  opts in behind its flag. */
export function buildOperatorBlock(staleIds?: Set<string>): string {
  const hasStale = staleIds !== undefined && staleIds.size > 0
  const isStale = (f: OperatorFact): boolean => hasStale && staleIds!.has(f.id)
  // Bitemporally-invalidated (superseded) facts are excluded from grounding entirely —
  // they describe outdated operator state, kept only for audit (getAllOperatorFacts).
  const active = (s: FactStatus): OperatorFact[] => listByStatus(s).filter((f) => !isInvalidated(f))
  // Stage 5: every block section is positionally capped, so all three award scarce slots by established
  // trust rather than enumeration order (see rankByEstablishedTrust — no-op unless the cap binds).
  const relBounds = groundingReliabilityBounds()
  const promotedAll = rankByEstablishedTrust(active('promoted'), MAX_BLOCK_LINES, relBounds)
  const provisionalAll = rankByEstablishedTrust(active('provisional'), MAX_BLOCK_LINES, relBounds)
  // Ingestion-trust tiering (SSGM/DRIFT): an un-promoted candidate captured from an UNTRUSTED turn
  // (factSource 'external' — a de-privileged inbound/channel message) is QUARANTINED from grounding.
  // It stays recorded for audit + human review, but never enters the prompt as a soft signal, so an
  // external party cannot poison grounding by asserting a "fact". It grounds only once a human
  // explicitly promotes it. Same predicate as the recall path + consolidation (isQuarantinedExternal).
  // ...AND (Stage 3) a poison-suspect DERIVED candidate — a fold whose calibrated reliability fell below
  // TRUST_FLOOR because it laundered external content or rode a refuted derivation — is suppressed too.
  // The source-tag quarantine can't catch it (a fold relabels its source 'machine'); the trust semiring
  // can. This is the load-bearing CONSUMER of reliability: it changes the grounding decision.
  // ...AND (Stage 5) when more candidates survive the gate than the block can hold, the scarce slots are
  // awarded by ESTABLISHED trust (the distributional lower bound) instead of list position, so a
  // weakly-evidenced fold cannot crowd out a well-established fact merely by being enumerated first.
  // No-op unless the cap actually binds; it reorders within the already-gated set and admits nothing.
  const relBlock = groundingReliability()
  const eligibleCandidates = active('candidate').filter(
    (f) => !isQuarantinedExternal(f) && !isLowTrustDerived(f, relBlock.get(f.id) ?? 1)
  )
  const candidatesAll = rankByEstablishedTrust(eligibleCandidates, MAX_BLOCK_LINES, relBounds)
  // Item 12 (efficacy-weighted grounding): a fact MEASURED as no-lift/regression
  // (efficacy.verdict === 'prune-candidate') is demoted out of "follow these" into a "weigh
  // lightly" line — measurement governs weighting; prune stays human-gated. Unmeasured facts
  // (no efficacy, or keep/inconclusive) are byte-unchanged.
  const isNoLift = (f: OperatorFact): boolean => f.efficacy?.verdict === 'prune-candidate'
  // Stage 6 CONSUMER — support erosion GOVERNS grounding weight (never retraction).
  //
  // supportErosion() measured which SURVIVING rules quietly lost justification, and nothing
  // consumed it: it was a read surface hanging off the govern audit. So a promoted rule that had
  // lost most of its independent derivations kept grounding the agent from "Rules the operator
  // confirmed (follow these)" at exactly the authority it no longer earns — the precise gap the
  // graded cascade exists to expose, left un-acted-on.
  //
  // This demotes it into the same weigh-lightly treatment MEASUREMENT already produces (isNoLift),
  // and nothing more. The fact is not retracted, not deleted, not un-promoted in the store: losing
  // support is grounds to re-examine a belief, not to delete it (derivation-polynomial.ts's
  // documented contract, and the reason that module refuses to decide death at all). Governance
  // stays human. What changes is how heavily the prompt leans on it.
  //
  // Keyed on the SUPPORT COUNT, not the trust delta. Under that module's MAX combination rule,
  // losing a NON-argmax derivation moves trust by EXACTLY ZERO while the support count falls
  // (derivation-polynomial.ts:52) — a trust-keyed threshold would silently miss the common case,
  // which is the same "a flat delta must not be read as nothing was lost" trap stated there.
  //
  // Fires only on a MAJORITY loss, and never on an `approximate` reading: a truncated polynomial
  // can OVER-report erosion, and acting on a possibly-overstated loss is the one way this could
  // wrongly quiet a rule that is still well supported. Same fail-safe posture as the staleness
  // fusion (under-sampled ⇒ don't act).
  const erosionByFact = supportErosion()
  const isEroded = (f: OperatorFact): boolean => {
    const d = erosionByFact.get(f.id)
    if (!d || d.approximate) return false
    return d.supportAfter < d.supportBefore && d.supportAfter <= d.supportBefore * EROSION_DEMOTE_RATIO
  }
  const isDemoted = (f: OperatorFact): boolean => isStale(f) || isNoLift(f) || isEroded(f)
  const promoted = promotedAll.filter((f) => !isDemoted(f))
  const provisional = provisionalAll.filter((f) => !isDemoted(f))
  const candidates = candidatesAll.filter((f) => !isDemoted(f))
  const demotedAll = [...promotedAll, ...provisionalAll, ...candidatesAll].filter(isDemoted)
  const stale = demotedAll.filter(isStale)
  const noLift = demotedAll.filter((f) => isNoLift(f) && !isStale(f))
  // Erosion is reported only when it is the REASON — a fact already demoted as stale or no-lift
  // keeps the explanation the operator acted on, rather than being re-labelled underneath them.
  const eroded = demotedAll.filter((f) => isEroded(f) && !isStale(f) && !isNoLift(f))
  if (
    promoted.length === 0 &&
    provisional.length === 0 &&
    candidates.length === 0 &&
    stale.length === 0 &&
    noLift.length === 0 &&
    eroded.length === 0
  )
    return ''
  const parts: string[] = ['<operator_profile>']
  if (promoted.length) {
    parts.push('Rules the operator confirmed (follow these):')
    parts.push(...promoted.map((f) => `- ${f.fact}`))
  }
  if (provisional.length) {
    parts.push('Endorsed, on probation (apply — being validated):')
    parts.push(...provisional.map((f) => `- ${f.fact}`))
  }
  if (candidates.length) {
    parts.push('Noticed (unconfirmed — treat as soft signal):')
    parts.push(...candidates.map((f) => `- ${f.fact}`))
  }
  if (stale.length) {
    parts.push('Possibly stale — mentions a resolved topic, weigh lightly:')
    parts.push(...stale.map((f) => `- ${f.fact}`))
  }
  if (noLift.length) {
    parts.push('Under review — measured no lift on output, weigh lightly (prune-candidate):')
    parts.push(...noLift.map((f) => `- ${f.fact}`))
  }
  if (eroded.length) {
    parts.push('Support eroded — most of the evidence this was derived from has been retired, weigh lightly:')
    parts.push(...eroded.map((f) => `- ${f.fact}`))
  }
  parts.push('</operator_profile>')
  return parts.join('\n')
}

/** Test/inspection helpers. */
/** ACTIVE operator facts (excludes bitemporally-invalidated/superseded ones) — the source
 *  for grounding + recall, so stale operator state never re-enters the prompt. Use
 *  getAllOperatorFacts() for audit/history that needs the invalidated rows too. */
export function getOperatorFacts(): OperatorFact[] {
  return store.filter((f) => !isInvalidated(f))
}

/** ALL facts including invalidated/superseded — for audit, history, and the govern UI. */
export function getAllOperatorFacts(): OperatorFact[] {
  return [...store]
}

/** The human-review QUEUE: CANDIDATE facts awaiting the operator's promote/veto verdict.
 *  This is the ONLY path candidate→provisional (a rule DUIN follows), so a non-empty queue
 *  is real, actionable work — this getter is what surfaces "you have N facts waiting for
 *  your review" on the daily Home digest. Excludes bitemporally-invalidated candidates
 *  (superseded operator state) so the count reflects only live decisions. Newest-captured
 *  first (`capturedAt` = the fact's valid-FROM ts). Deterministic + keyless; NEVER promotes
 *  (the moat stays human-controlled — this only makes the queue visible). `vaultDir` is
 *  accepted for reader symmetry with the other digest sources but is unused: the store is
 *  already wired to the userData dir via setOperatorModelPath. */
export interface PendingReview {
  count: number
  items: { id: string; text: string; capturedAt: number }[]
}
export function getPendingReview(_vaultDir?: string): PendingReview {
  const items = listByStatus('candidate')
    .filter((f) => !isInvalidated(f))
    .map((f) => ({ id: f.id, text: f.fact, capturedAt: f.ts }))
  return { count: items.length, items }
}
export function __resetOperatorModel(): void {
  store = []
  evictions = []
  idCounter = 0
}

// ──────────────────── capture: keyless heuristics ────────────────────

const KEYLESS_PATTERNS: { re: RegExp; kind: string }[] = [
  { re: /\bremember(?: that)?\s+(.+)/i, kind: 'context' },
  { re: /\b(?:i|we)\s+(?:prefer|like|want|always|never|usually)\s+(.+)/i, kind: 'preference' },
  { re: /\bmy\s+([a-z][\w\s]{1,40}?\s+is\s+.+)/i, kind: 'context' },
  { re: /\b(?:actually|no,|correction:)\s*(.+)/i, kind: 'correction' },
  { re: /\bfrom now on\s+(.+)/i, kind: 'preference' }
]

/** Pull explicitly-taught facts from the user's text — no model needed. */
export function extractKeylessFacts(userText: string): { fact: string; kind: string }[] {
  const out: { fact: string; kind: string }[] = []
  const text = (userText || '').trim()
  if (!text) return out
  for (const { re, kind } of KEYLESS_PATTERNS) {
    const m = text.match(re)
    if (m && m[1]) {
      const fact = m[1].replace(/[.?!]+$/, '').trim()
      if (fact.length >= 3 && fact.length <= 300) out.push({ fact, kind })
    }
  }
  return out
}

// ──────────────────── dual-verifier ────────────────────

const FILLER = new Set(['ok', 'okay', 'thanks', 'thank you', 'yes', 'no', 'hi', 'hello', 'sure', 'done', 'cool', 'nice'])

/** Keyless verifier gate (first of the dual pass): reject obvious non-facts at
 *  capture — questions, fillers, contentless fragments. */
// Memory-write injection isolation (SIA activation, SSGM/DRIFT): a captured "fact" that is actually
// a prompt-injection payload must never enter the GOVERNED store — memory poisoning would let a
// note/turn steer all future grounding. Specific injection signatures only (instruction-override /
// role-impersonation / system-tags), NOT generic imperatives, so a legit "always lead with the
// outcome" preference is unaffected. PURE.
const INJECTION_SIGNATURES: RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|the\s+above|earlier)\b[^.]*\b(?:instruction|prompt|rule|direction|context)/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|earlier)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bforget\s+(?:everything|all\s+(?:previous|prior))/i,
  /(?:^|\n)\s*(?:system|assistant)\s*:/i,
  /<\/?(?:system|assistant|im_start|im_end)>/i,
  /\boverride\s+(?:your|the)\s+(?:instruction|system|prompt|guardrail)/i
]
/** True when text carries prompt-injection signatures — used to keep poisoned content out of the
 *  governed operator-fact store (a fact is a short distilled statement; injection signatures in one
 *  are almost certainly a poisoning attempt, not a genuine operator preference). */
export function looksInjected(text: string): boolean {
  const t = String(text || '')
  return INJECTION_SIGNATURES.some((re) => re.test(t))
}

export function verifyCandidate(fact: string): { ok: boolean; reason: string } {
  const t = (fact || '').trim()
  if (t.length < 3) return { ok: false, reason: 'too short' }
  if (/\?\s*$/.test(t)) return { ok: false, reason: 'looks like a question' }
  if (FILLER.has(t.toLowerCase())) return { ok: false, reason: 'filler' }
  if (contentWords(t).size < 1) return { ok: false, reason: 'no content words' }
  if (looksInjected(t)) return { ok: false, reason: 'injection-shaped (memory-poisoning guard)' }
  return { ok: true, reason: 'ok' }
}

const VERIFY_SYSTEM =
  'You are a STRICT verifier, independent from the extractor. Given CANDIDATE ' +
  'facts about an operator and the RULES already confirmed, return a JSON array ' +
  'of only the candidate strings (verbatim) that are DURABLE, specific, and do ' +
  'NOT contradict a confirmed rule. Drop vague, one-off, or contradictory ones.'

/** Key-gated second verifier pass (the "dual" — a role distinct from extraction):
 *  prunes the candidate pool to durable, non-contradictory facts so the human
 *  reviews quality. Rejected candidates are DROPPED (not vetoed — veto is the
 *  human's verdict; a re-learned + re-verified fact can return). No engine → no-op.
 *  A pass that would drop the WHOLE pool is treated as a failed verifier and abstains — see below.
 *  Drops are TOMBSTONED into the eviction ledger, so every removal stays answerable. */
export async function verifyPool(): Promise<{ kept: number; dropped: number }> {
  const model = routeModel('extraction')
  if (!model) return { kept: 0, dropped: 0 }
  // BITEMPORAL LIVENESS — both halves of the payload. `listByStatus` filters on status ALONE, while
  // every semantic retirement in this file (supersedeFact, reflect, cascadeInvalidateDerived) stamps
  // `invalidatedAt` and deliberately LEAVES `status` intact — soft-delete, so the audit can still walk
  // why a rule fell. A retired row therefore stays in listByStatus('candidate'/'promoted') FOREVER, and
  // every reader has to apply the liveness predicate itself, exactly as the sibling reader in this file
  // does (buildOperatorBlock's `active` helper). That asymmetry is what made this invisible: the row
  // vanishes from grounding and from the review queue the moment it is retired, so from every surface an
  // operator can see it is gone — only this reader, which consults status alone, still believed it.
  //
  // On the candidate half, a retired row also silently DISARMED the abstain-on-total-drop guard below:
  // it inflated `sendable.length` while being un-deletable (`doomed` already re-checks liveness), so a
  // verifier that rejected 100% of the LIVE pool still failed the `dropIds.size === sendable.length`
  // test and the live candidates were hard-deleted anyway.
  const cands = listByStatus('candidate').filter((f) => !isInvalidated(f))
  if (cands.length === 0) return { kept: 0, dropped: 0 }
  // CONFIDENTIAL-LANE FIREWALL. This is an AUTONOMOUS background send — learnFromTurn fires it on
  // every capturing turn (and an inbound channel message reaches that same path via server.ts's
  // de-privileged learnFromTurn call), so it is precisely what confidential-firewall exists to guard:
  // the operator never chose this cloud call. Both halves of the payload must be filtered, mirroring
  // the sibling that ships the SAME two lists to the SAME routeModel('extraction') — operator-govern's
  // runGovernPass (confidentialIds) and defaultGovernJury (`confirmed`).
  //
  // What made it invisible: every surface that REPORTS firewall activity already filters — the govern
  // jury and judgment-measure-live both redact these exact rows — so an operator watching those saw
  // the firewall working while this sibling had already shipped the identical corpus verbatim.
  //
  // A withheld candidate is ABSTAINED, not merely omitted from the payload: it is excluded from
  // `dropIds` too, because omission from the keep-list here means HARD DELETE. Filtering only the
  // outbound text would have deleted every confidential candidate on the first pass — turning an
  // egress fix into a data-loss bug.
  // The promoted half is the sharp edge of the liveness note above: shipping a RETIRED rule under the
  // literal header `RULES (confirmed)` turns VERIFY_SYSTEM's "do NOT contradict a confirmed rule"
  // against the operator's own correction. supersedeFact mints the replacement as a CANDIDATE, and
  // learnFromTurn awaits verifyPool on that same turn — so the verifier is shown "uses Neovim" next to
  // the dead rule "uses VSCode", dutifully omits it, and omission from this keep-list means HARD DELETE.
  // Net: the old fact is invalidated AND its replacement is destroyed, leaving DUIN knowing nothing
  // about the subject and only an `evictions` tombstone as the trace. learnFromTurn orders
  // runAutoSupersede BEFORE verifyPool for the express purpose of preventing this ("a correction that
  // contradicts a promoted rule must RETIRE the stale rule, not be dropped by the dual-verifier as
  // conflicting with a confirmed rule") — reading by status alone defeated that ordering silently,
  // because retiring a rule never changes the field this reader consults. Nor is it a one-turn window —
  // evictToCap ranks 'promoted' last for eviction, so the dead rule would sit in this prompt
  // indefinitely, pruning every later candidate that contradicts it.
  const rules = listByStatus('promoted')
    .filter((f) => !isInvalidated(f))
    .map((f) => f.fact)
    .filter((t) => firewallClear(t))
  const sendable = cands.filter((c) => firewallClear(c.fact))
  // Nothing left to verify → don't open the external call at all (and don't ship the rules alone).
  if (sendable.length === 0) return { kept: cands.length, dropped: 0 }
  try {
    const r = await chatOnce(
      [
        { role: 'system', content: VERIFY_SYSTEM },
        {
          role: 'user',
          content: `RULES (confirmed):\n${rules.join('\n') || '(none)'}\n\nCANDIDATES:\n${sendable.map((c) => c.fact).join('\n')}`
        }
      ],
      model,
      undefined,
      { purpose: 'other', role: 'operator-verify' }
    )
    // Parse the keep-list UNCAPPED (bounded by the pool itself), exactly as operator-govern's jury
    // does. parseOperatorFacts defaults to 8 to match the EXTRACTION prompt, where capping bounds how
    // much ONE turn may add — correct there, a live data-loss bug here: this keep-list's semantics make
    // omission mean HARD DELETE, so a pool of 14 with a PERFECT reply echoing all 14 verbatim was sliced
    // to the first 8 and the remaining 6 were deleted. On a CORRECT reply, every pass, with no error
    // anywhere, and the abstain-on-total-drop guard below can never catch it (exactly 8 always survive,
    // so dropIds.size === cands.length is unreachable). Total failure was guarded; partial was not.
    const keep = new Set(parseOperatorFacts(r.content, sendable.length).map(norm))
    // Only the pool that was actually SENT can be judged; firewall-withheld candidates are absent
    // from `sendable` and therefore never enter dropIds (see the abstain note above).
    const dropIds = new Set(sendable.filter((c) => !keep.has(norm(c.fact))).map((c) => c.id))
    // ABSTAIN-ON-TOTAL-DROP. Retention here requires the verifier to echo each candidate back
    // VERBATIM (norm-matched), so a reply that fails to parse, gets truncated, or paraphrases every
    // line yields an EMPTY keep-set — and the line below hard-deletes, with no bi-temporal tombstone
    // to recover from. That turns one malformed model reply into the silent loss of the entire
    // candidate pool, including the input consolidation is about to fold. A genuine prune essentially
    // never rejects 100% of a pool, so "drop everything" is far better explained by a failed verifier
    // than by every candidate being bad. Treat it as an abstention and keep the pool, mirroring the
    // abstain-on-miss convention the rest of the brain already follows (derivation-verify returns null
    // on a parse-miss rather than a false verdict; operator-govern's jury holds rather than reverting).
    // Deliberately conservative in the DATA-PRESERVING direction: this can only ever delete LESS.
    // Measured against the pool that was SENT (`sendable`), not the whole candidate list — otherwise a
    // single firewall-withheld candidate would make `dropIds.size === cands.length` unreachable and
    // silently disarm this guard.
    if (dropIds.size === sendable.length) {
      console.debug(`[operator-model] verifyPool abstained: verifier kept none of ${sendable.length} — treating as a failed pass, pool preserved`)
      return { kept: cands.length, dropped: 0 }
    }
    // RE-RESOLVE AGAINST THE LIVE STORE BEFORE DELETING. `cands` is a snapshot taken BEFORE a
    // seconds-long `await chatOnce` above, and dropIds is derived purely from it — the row's CURRENT
    // status is never consulted. The main process keeps running during that await: the operator can
    // click promote or veto in the govern UI (ipcMain.handle('operator:promote'/'operator:veto') →
    // promoteFact/vetoFact), and supersede/cascade can stamp invalidatedAt. Those mutate the fact
    // objects IN PLACE (setFact does store.find → mut), so the ids in dropIds still match and the
    // hard-delete below silently destroyed a verdict a human had just given. A veto is the worst
    // case: recordFacts rebuilds its dedup set from `store` alone, and the tombstone goes to
    // `evictions`, not `store` — so deleting a vetoed row erases the VETO MEMORY, and the fact the
    // human rejected can be re-captured and re-grounded on the very next turn.
    //
    // What made it invisible: the bug needs a concurrent human action inside the await window, so
    // every single-threaded test passes, and both the abstain-on-total-drop guard and the tombstone
    // ledger above look like they cover data loss — they cover a bad VERIFIER, not a stale snapshot.
    //
    // Only remove rows still in the state that was actually verified: an untouched candidate — and never
    // one the operator stated: a model's keep-list is not the operator's veto (HUMAN AUTHORITY, isOperatorStated).
    const doomed = store.filter((f) => dropIds.has(f.id) && f.status === 'candidate' && !isInvalidated(f) && !isOperatorStated(f))
    if (doomed.length) {
      // TRACEABLE PRUNE. A model deciding a fact is not durable is not the operator vetoing it, so the
      // row does not just vanish: tombstone it into the same bounded ledger cap eviction writes to
      // (getEvictionLog), stamped `verify-pool`. Previously this was a bare filter + persist with no
      // record anywhere, which made a wrongful drop both silent and unanswerable — {kept,dropped} alone
      // is indistinguishable from a legitimate prune.
      tombstone(doomed, 'verify-pool')
      const doomedIds = new Set(doomed.map((f) => f.id))
      store = store.filter((f) => !doomedIds.has(f.id))
      persist()
    }
    // Report what was ACTUALLY removed, not what the stale snapshot nominated.
    return { kept: cands.length - doomed.length, dropped: doomed.length }
  } catch {
    return { kept: 0, dropped: 0 }
  }
}

// ──────────────────── capture: key-gated LLM extraction ────────────────────

const EXTRACTION_SYSTEM =
  'You extract DURABLE facts about the OPERATOR (the human) from one exchange — ' +
  'stable preferences, working context, who/what they care about, and corrections ' +
  'they make. NOT one-off task details, NOT facts about the world. Return a JSON ' +
  'array of short strings (max 8), each a single durable fact phrased about the ' +
  'operator (e.g. "Prefers concise answers", "Works on the ProjectA launch", ' +
  '"Corrected: the deadline is Dec 15"). If nothing durable, return [].'

/** Parse the LLM's JSON array of fact strings. Tolerant of fences/prose.
 *
 *  `max` defaults to 8 to match the EXTRACTION prompt above ("max 8"), where capping is correct: it
 *  bounds how much a single turn may add. It is NOT correct for every caller. The govern jury reuses
 *  this parser to read a keep-list over the whole probation pool, and there omission means REVERT — so a
 *  silent cap turns "the reply listed more than 8" into "every fact past the 8th failed the jury". With
 *  14 facts on probation, a perfect reply endorsing all 14 still reverted 6. Any caller whose semantics
 *  make omission destructive must pass its own bound. */
export function parseOperatorFacts(text: string, max = 8): string[] {
  if (!text) return []
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) return []
  try {
    const arr = JSON.parse(m[0]) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter((s) => s.length >= 3 && s.length <= 300)
      .slice(0, max)
  } catch {
    return []
  }
}

async function extractWithModel(query: string, answer: string): Promise<string[]> {
  const model = routeModel('extraction')
  if (!model) return [] // no engine → keyless only
  try {
    const r = await chatOnce(
      [
        { role: 'system', content: EXTRACTION_SYSTEM },
        { role: 'user', content: `OPERATOR said:\n${query}\n\nDUIN answered:\n${answer.slice(0, 2000)}` }
      ],
      model,
      undefined,
      { purpose: 'other', role: 'operator-learning' }
    )
    // Extraction keeps the DEFAULT cap of 8: here the bound is correct, limiting how much a single turn
    // may add. Only callers whose semantics make omission destructive (the govern jury's keep-list,
    // verifyPool's prune) pass their own bound.
    return parseOperatorFacts(r.content)
  } catch {
    return []
  }
}

const SUPERSEDE_SYSTEM =
  'You are a STRICT change-detector, independent from extraction. Given a NEW fact ' +
  'about the operator and a numbered list of EXISTING facts, decide if the NEW fact ' +
  'is an explicit TEMPORAL REPLACEMENT of exactly ONE existing fact — the SAME ' +
  'subject whose value changed (e.g. new "editor is Neovim" replaces old "editor is ' +
  'VSCode"). Reply with ONLY the number of the single fact it replaces, or "NONE". ' +
  'Be conservative: reply NONE unless it is clearly the same subject with a new value. ' +
  'An additive or merely-related fact is NONE.'

/** Real LLM supersession judge (the fuzzy gate). Receives ONLY the deterministic
 *  overlap-bounded candidates, so it can never reach an unrelated fact. Returns
 *  the chosen candidate's id, or null. Conservative + fail-safe (no engine / parse
 *  miss / error / confidential-lane content → null). Uses a numeric index for robust
 *  back-mapping — over the FILTERED list, see below. */
async function realSupersedeJudge(newText: string, candidates: ActiveFactRef[]): Promise<string | null> {
  const model = routeModel('extraction')
  if (!model) return null
  // CONFIDENTIAL-LANE FIREWALL. Same autonomous-egress class verifyPool was fixed for, on a path that
  // fires MORE often: learnFromTurn runs runAutoSupersede on every TRUSTED capturing turn, and its pool
  // is getOperatorFacts() — every active fact, promoted and provisional and candidate alike. A fact on
  // the operator's denylist reaches this judge exactly when it clears the deterministic overlap floor
  // against the new fact, i.e. when the operator corrects THAT SAME SUBJECT — so the leak fires on the
  // most ordinary use of the feature, not an edge case, on a cloud call the operator never initiated.
  //
  // What made it invisible: this module already imports firewallClear and applies it 150 lines up in
  // verifyPool, over the same corpus and the same routeModel('extraction'). The guard being present in
  // the file made the module look covered, and every surface that REPORTS firewall activity (the govern
  // jury, judgment-measure-live) filters these rows — so an operator watching those saw it working.
  //
  // ABSTAIN, don't send (confidential-firewall.ts's stated rule): a lost supersession leaves the stale
  // fact active and reversible by the human govern loop, which is strictly cheaper than an egress leak.
  // A confidential NEW fact leaks just by being the prompt, hence the first check.
  if (!firewallClear(newText)) return null
  const sendable = candidates.filter((c) => firewallClear(c.fact))
  if (sendable.length === 0) return null
  try {
    const r = await chatOnce(
      [
        { role: 'system', content: SUPERSEDE_SYSTEM },
        {
          role: 'user',
          content: `NEW fact:\n${newText}\n\nEXISTING facts:\n${sendable
            .map((c, i) => `${i + 1}. ${c.fact}`)
            .join('\n')}\n\nWhich number does the NEW fact replace? Reply with just the number, or NONE.`
        }
      ],
      model,
      undefined,
      { purpose: 'other', role: 'operator-supersede' }
    )
    if (/\bNONE\b/i.test(r.content)) return null
    const m = r.content.match(/\d+/)
    if (!m) return null
    const idx = Number.parseInt(m[0], 10) - 1
    // Back-map against the list the model actually SAW. Indexing `candidates` here would let a
    // withheld row be RETIRED by index drift: the judge's "2" means the 2nd sendable fact, and
    // autoSupersede's "may only pick a candidate we offered" guard checks the unfiltered list, so
    // it would wave the wrong id through. Filtering the payload without moving the back-map turns
    // an egress fix into a supersede-the-wrong-fact bug.
    return sendable[idx]?.id ?? null
  } catch {
    return null
  }
}

/** Gated auto-supersession pass: retire active facts that a change-signal-bearing
 *  new fact explicitly replaces (three gates: change-signal → referent-overlap →
 *  LLM confirm). Reversible (supersedeFact keeps the old fact for audit). No-op
 *  unless a new fact carries a change signal. Best-effort.
 *
 *  Two pools, by who authored the trigger (HUMAN AUTHORITY, isOperatorStated):
 *    - the operator's OWN keyless teaching may retire ANY active fact, and the
 *      replacement is tagged 'operator' (the operator changed their mind);
 *    - a MODEL-extracted fact may retire only machine facts, and its replacement is
 *      tagged 'machine' — it never inherits the retired row's 'operator' provenance
 *      (constitution §3). Before this split the judge saw every active fact with the
 *      model's inferences as triggers, and the replacement wore the operator's tag.
 *  Each pool keeps autoSupersede's default judge budget; an empty pool makes no call. */
async function runAutoSupersede(keylessTexts: string[], llmTexts: string[]): Promise<number> {
  let superseded = 0
  const pass = async (newFacts: string[], pool: OperatorFact[], source: FactSource): Promise<void> => {
    if (newFacts.length === 0 || pool.length === 0) return
    const active: ActiveFactRef[] = pool.map((f) => ({ id: f.id, fact: f.fact }))
    try {
      const r = await autoSupersede({
        newFacts,
        activeFacts: active,
        judge: realSupersedeJudge,
        // No lexical change-marker requirement: silently-stated contradictions must
        // auto-invalidate too. The deterministic overlap floor + LLM judge remain
        // the gates; maxJudgeCalls bounds cost, change-marker facts judged first.
        apply: (oldId, newText) => supersedeFact(oldId, newText, undefined, source).superseded
      })
      superseded += r.superseded
    } catch {
      /* best-effort: a judge/apply failure retires nothing */
    }
  }
  await pass(keylessTexts, getOperatorFacts(), 'operator')
  await pass(llmTexts, getOperatorFacts().filter((f) => !isOperatorStated(f)), 'machine')
  return superseded
}

/** Capture-surprise gate (Nemori prediction-error): given machine-inferred candidate facts, return
 *  only those surprising enough to capture — dropping candidates that near-paraphrase an existing
 *  ACTIVE fact (no new signal). Conservative + fail-open + fail-SAFE: no active facts, a cold/broken
 *  embedder, or ANY error keeps every candidate. The production embedder (embedForRecall) and the
 *  pure gate are lazy-imported so operator-model's static graph (and its vitest load) stay light. */
async function gateBySurprise(candidates: string[]): Promise<string[]> {
  try {
    const existing = getOperatorFacts().map((f) => f.fact)
    if (existing.length === 0) return candidates
    const [{ embedForRecall }, { surpriseGate }] = await Promise.all([
      import('../local-brain/index-store'),
      import('./surprise-gate')
    ])
    const res = await surpriseGate(candidates, existing, embedForRecall)
    return res.keep
  } catch {
    return candidates // fail-safe: never drop a fact to a broken gate
  }
}

/** Learn from one brain turn → CANDIDATES (await human promotion). Keyless
 *  heuristics always; LLM extraction when an engine is configured; a gated
 *  auto-supersession pass retires facts the operator explicitly changed; then
 *  reflect to keep the review queue clean. Best-effort, fire-and-forget. */
export async function learnFromTurn(query: string, answer: string, trusted = true): Promise<number> {
  // Ingestion-trust tiering (SSGM/DRIFT): when the turn is DE-PRIVILEGED (trusted=false — an inbound/
  // channel message that failed exec-authorization, i.e. NOT the operator at the console), every fact
  // extracted from it is provenance-tagged 'external', NOT 'operator'/'machine'. External facts are
  // recorded for audit + human review (provenance visible via getOperatorFacts) but QUARANTINED from
  // grounding until a human promotes them — so a non-operator cannot teach the governed store, nor can
  // an untrusted "my X is now Y" masquerade as operator teaching. Default trusted=true → the operator's
  // own local turns are byte-identical to before.
  const keylessSrc: FactSource = trusted ? 'operator' : 'external'
  const machineSrc: FactSource = trusted ? 'machine' : 'external'
  // Keyless facts come from the OWN message (regex teaching: "my X is Y", "from now on …"); LLM facts
  // are model-inferred from the turn and must earn promotion before grounding as confirmed rules.
  const keyless = extractKeylessFacts(query)
  let total = recordFacts(keyless.map((k) => ({ ...k, source: keylessSrc })))
  // Fail-open: the (optional) model-extraction layer must never take down capture — the keyless
  // facts are already recorded, and this runs fire-and-forget (void learnFromTurn), so a throw from
  // the model router/keychain would otherwise become an unhandled rejection and skip supersession.
  let llm: string[] = []
  try {
    llm = await extractWithModel(query, answer)
  } catch (e) { console.debug('[operator-model] model extraction unavailable — keyless capture stands:', messageOf(e)) }
  // Capture-surprise gate (Nemori prediction-error): machine-inferred candidates that merely
  // restate an existing active fact carry no new signal — skip them. Applied ONLY to LLM facts;
  // the operator's OWN keyless teaching is never gated. Fail-safe + fail-open: any error, or a
  // cold embedder, keeps every candidate (capture must never silently lose a fact to the gate).
  const surprising = llm.length ? await gateBySurprise(llm) : []
  if (surprising.length) total += recordFacts(surprising.map((fact) => ({ fact, kind: 'context', source: machineSrc })))
  // Auto-supersession runs BEFORE verifyPool: a correction that contradicts a
  // promoted rule must RETIRE the stale rule (bitemporal), not be dropped by the
  // dual-verifier as "conflicting with a confirmed rule" (which assumes the old
  // rule is still true). Gated + reversible; see operator-supersede.ts. SKIPPED for an untrusted
  // turn — a de-privileged sender must never be able to RETIRE a governed operator fact (poisoning
  // by supersession); only the operator's own turns can invalidate operator state.
  if (trusted) await runAutoSupersede(keyless.map((k) => k.fact), llm)
  if (total) {
    reflect() // auto-merge near-duplicates
    // dual-verifier: key-gated prune to durable, non-contradictory (no-op keyless). Awaited (not
    // fire-and-forget as before) so the automated endorsement below runs on the ALREADY-pruned pool —
    // a candidate the verifier drops must not be auto-promoted first. learnFromTurn is itself called
    // fire-and-forget (void), so awaiting here adds no user-facing latency, and a model-layer failure
    // is swallowed so the automated promotion still proceeds on the keyless-verified candidates.
    try {
      await verifyPool()
    } catch (e) {
      console.debug('[operator-model] verify pool unavailable:', messageOf(e))
    }
    // Learning is automated (no human endorse gate): every surviving non-external candidate is
    // auto-endorsed onto probation. It still earns 'promoted' only via the govern loop; external
    // captures stay quarantined. See autoPromoteCandidates.
    autoPromoteCandidates()
  }
  return total
}
