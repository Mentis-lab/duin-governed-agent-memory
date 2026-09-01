// calibration-registry.ts — make "was this constant ever measured against the real corpus?" a
// question the system can answer about itself.
//
// THE PATTERN THIS EXISTS TO CATCH. A threshold or weight is chosen once, against whatever data was
// in front of the author, and then never rechecked. It keeps working in tests (which use fixtures
// shaped to it) and silently does the wrong thing in production. Found FIVE times in one day
// (2026-07-28), in five different subsystems:
//
//   1. graph-expand `beta=1.2 > alpha=1.0` + `hubDfCap` — tuned on 10-20-note corpora, measured
//      -9.0pp recall@5 / -10.3pp MRR on the real 12,798-vector vault. Reverted to opt-in.
//   2. `THIN_RETRIEVAL_MAX = 0.35` — compared against a cosine-ish score whose real range is
//      [0.387, 0.744]. It sits BELOW THE ENTIRE OBSERVED RANGE: it fires on 0/90 on-corpus AND
//      0/18 off-corpus queries. Not mis-tuned — unfireable. Its own file documents a *different*
//      bug (score vs rawScore) at length and never noticed this one.
//   3. `TRIPWIRE_HIGH_DEGREE = 6` — assumes real duplicate entities are low-degree; the entity
//      rebuild audit observes them at degree 8-37.
//   4. `RECALL_FLOOR = 0.28` — annotated "from forward_brief.py", i.e. copied from a different
//      system's embedding space and never measured in this one.
//   5. A `searchK` hypothesis derived from LoCoMo that did not survive contact with the real vault.
//
// Every one was caught in minutes by a cheap read-only measurement. None was caught by a test,
// because a constant that never fires breaks nothing — it just quietly removes a feature.
//
// So: constants that gate behavior REGISTER the measurement behind them. The audit then answers
// three questions no test asks — was it ever measured, was it measured against THIS corpus, and can
// it physically fire given the range of the signal it is compared to.
//
// This is a LEDGER, not an enforcement gate. It reports; a human decides. Registering a constant is
// cheap; the discipline is that an unregistered gating constant shows up as `never-calibrated`
// rather than as nothing at all.

export type ConstantIntent =
  /** compared against a signal with `<` or `>` — can be unfireable if outside the signal's range */
  | 'threshold'
  /** a relative weight — range checks do not apply, but context drift does */
  | 'weight'
  /** a count/budget — context drift applies */
  | 'budget'

export interface Calibration {
  /** ISO date the measurement was taken */
  measuredAt: string
  /** the corpus + model the measurement is only valid within. A constant calibrated in one
   *  embedding space means something different in another. */
  context: string
  /** observed range of the SIGNAL this constant is compared against (not of the constant) */
  observed: { min: number; max: number; n: number }
  /** how it was measured, so it can be re-run */
  method?: string
}

export interface RegisteredConstant {
  /** `<module>.<CONSTANT>` */
  id: string
  value: number
  intent: ConstantIntent
  /** the signal it is compared against. Two constants are only comparable when this matches. */
  signal: string
  /** null = NEVER MEASURED against a real corpus. That is a finding, not a gap in the registry. */
  calibration: Calibration | null
  /**
   * Which corpus this constant lives against. Default 'retrieval'.
   *
   * The drift check needs a baseline, and there is only one per DOMAIN — the retrieval corpus is
   * the embedder, but a learning-loop threshold lives against the corrections stream. Auditing a
   * corrections-stream constant against the embedder context reports drift that is not drift: the
   * constant is calibrated on exactly the corpus it operates on. Constants outside the audit's
   * known domain are drift-EXEMPT rather than drift-flagged, because inventing a baseline we do
   * not have would put a confident false finding in the list this registry exists to keep true.
   * Freshness and range checks still apply to every domain.
   */
  domain?: string
  note?: string
}

export type FindingKind =
  | 'ok'
  | 'never-calibrated'
  /** threshold below the entire observed signal range — can never fire */
  | 'unfireable-low'
  /** threshold above the entire observed range — always fires */
  | 'unfireable-high'
  /** calibrated in a context that is not the active one */
  | 'context-drift'
  /** calibration older than the freshness budget */
  | 'stale'

export type Severity = 'high' | 'medium' | 'none'

export interface Finding {
  id: string
  kind: FindingKind
  severity: Severity
  detail: string
}

const SEVERITY: Record<FindingKind, Severity> = {
  ok: 'none',
  // an unfireable threshold silently removes the feature it guards — the worst case, because
  // nothing errors and no test fails
  'unfireable-low': 'high',
  'unfireable-high': 'high',
  'context-drift': 'high',
  'never-calibrated': 'medium',
  stale: 'medium'
}

const DAY_MS = 86_400_000

/**
 * Audit the registry. PURE — `today` and the registry are injected so this is deterministic and
 * testable, and so the audit can be re-run against a historical date.
 *
 * Order matters: an unfireable threshold is reported ahead of context drift, because it is true
 * regardless of which corpus you are in.
 */
export function auditConstants(
  constants: RegisteredConstant[],
  opts: { today: string; activeContext?: string; maxAgeDays?: number }
): Finding[] {
  const maxAgeDays = opts.maxAgeDays ?? 180
  const now = Date.parse(opts.today)
  const out: Finding[] = []

  for (const c of constants) {
    if (!c.calibration) {
      out.push({
        id: c.id,
        kind: 'never-calibrated',
        severity: SEVERITY['never-calibrated'],
        detail: `${c.id} = ${c.value} gates behavior on "${c.signal}" but has never been measured against a real corpus.${c.note ? ` ${c.note}` : ''}`
      })
      continue
    }
    const { observed, context, measuredAt } = c.calibration

    if (c.intent === 'threshold' && observed.n > 0) {
      if (c.value < observed.min) {
        out.push({
          id: c.id,
          kind: 'unfireable-low',
          severity: SEVERITY['unfireable-low'],
          detail: `${c.id} = ${c.value} sits BELOW the entire observed range of "${c.signal}" [${observed.min}, ${observed.max}] (n=${observed.n}) — it can never fire, so the behavior it guards is effectively absent.`
        })
        continue
      }
      if (c.value > observed.max) {
        out.push({
          id: c.id,
          kind: 'unfireable-high',
          severity: SEVERITY['unfireable-high'],
          detail: `${c.id} = ${c.value} sits ABOVE the entire observed range of "${c.signal}" [${observed.min}, ${observed.max}] (n=${observed.n}) — it always fires, so the guard is unconditional.`
        })
        continue
      }
    }

    const domain = c.domain ?? 'retrieval'
    if (opts.activeContext && domain === 'retrieval' && context !== opts.activeContext) {
      out.push({
        id: c.id,
        kind: 'context-drift',
        severity: SEVERITY['context-drift'],
        detail: `${c.id} = ${c.value} was calibrated against "${context}" but the active context is "${opts.activeContext}". A threshold measured in one embedding space / corpus means something different in another.`
      })
      continue
    }

    const ageDays = Math.floor((now - Date.parse(measuredAt)) / DAY_MS)
    if (Number.isFinite(ageDays) && ageDays > maxAgeDays) {
      out.push({
        id: c.id,
        kind: 'stale',
        severity: SEVERITY.stale,
        detail: `${c.id} was last measured ${ageDays} days ago (budget ${maxAgeDays}); the corpus has almost certainly moved.`
      })
      continue
    }

    out.push({ id: c.id, kind: 'ok', severity: 'none', detail: `${c.id} = ${c.value} — measured ${measuredAt} against ${context}.` })
  }

  // worst first, then stable by id, so the report reads as a priority list
  const rank: Record<Severity, number> = { high: 0, medium: 1, none: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.id < b.id ? -1 : 1))
}

// ─────────────────────────── the registry ───────────────────────────
// Only constants with a REAL measurement carry a calibration. Everything else is honestly null —
// the point is to surface how many gating constants have never been measured, not to fabricate
// provenance for them.

/** The embedding space every cosine-ish retrieval threshold below is compared in. */
export const ACTIVE_RETRIEVAL_CONTEXT = 'operator vault / multilingual-e5-small'

/** Measured 2026-07-28: DUIN's own recipe (query: prefix, mean-pool, L2-norm) reproduced against the
 *  live vec0 table. 45 on-corpus verbatim + 45 on-corpus title-only + 18 off-corpus queries. */
const NOTE_CHUNK_COSINE: Calibration = {
  measuredAt: '2026-07-28',
  context: ACTIVE_RETRIEVAL_CONTEXT,
  observed: { min: 0.387, max: 0.744, n: 108 },
  method:
    'best-hit rawScore (1 - cosine distance) over 12,798 vectors; on-corpus [0.436,0.744], off-corpus [0.387,0.495]'
}

/** Measured 2026-07-30 over the live corrections stream (166 operator rows), replicating
 *  learn-native's own tokenizer: 12,090 comparable pairs.
 *
 *  READ THIS BEFORE TRUSTING THE RANGE CHECK ON THESE TWO. The pair-level range is NOT where the
 *  binding gate failed, and the audit's range check cannot see the failure: both constants sat
 *  comfortably inside the observed pair range while the gate produced 0 binding candidates in 166
 *  corrections, because clustering fails at the CLUSTER level (no group ever reached MIN_BIND) and
 *  `auditConstants` only reasons about a single comparison. The cluster-level measurement lives in
 *  the notes below and in learn-native.ts. */
const CORRECTION_PAIR_OVERLAP: Calibration = {
  measuredAt: '2026-07-30',
  context: 'operator corrections stream (166 rows)',
  observed: { min: 0, max: 12, n: 12090 },
  method:
    'token-set intersection over all comparable pairs; median row carries 4 tokens, 43 rows <4, 10 rows 0. jaccard range [0,1.0], p99 0.167, mean 0.010'
}

export const CONSTANT_REGISTRY: RegisteredConstant[] = [
  {
    id: 'learn-native.BIND_OVERLAP_MIN',
    value: 2,
    intent: 'threshold',
    domain: 'learning-loop',
    signal: 'token-set intersection between two corrections',
    calibration: CORRECTION_PAIR_OVERLAP,
    note:
      'Was 3 through 2026-07-30 and in that state the loop could not turn: 36 of 12,090 pairs passed the pair test but no cluster reached MIN_BIND, so 0 binding candidates in 166 corrections. Against a median row of 4 tokens a 3-token intersection demands near-duplicates. Relaxed to 2 at the unchanged Jaccard → 4 clusters ≥MIN_BIND on the same stream. Re-measure with scripts-adjacent probe before tuning further.'
  },
  {
    id: 'learn-native.BIND_JACCARD_MIN',
    value: 0.3,
    intent: 'threshold',
    domain: 'learning-loop',
    signal: 'jaccard overlap between two corrections token sets',
    calibration: CORRECTION_PAIR_OVERLAP,
    note:
      'Measured NOT to be the binding constraint: sweeping it 0.30 → 0.10 with the old overlap floor of 3 still yielded 0 clusters. Left unchanged deliberately — relaxing the ratio without the floor buys nothing and costs precision.'
  },
  {
    id: 'evidence-gate.EVIDENCE_FLOOR',
    value: 0.432,
    intent: 'threshold',
    signal: 'note-chunk best-hit rawScore',
    calibration: NOTE_CHUNK_COSINE,
    note: 'max threshold with zero false abstentions across 90 on-corpus queries.'
  },
  {
    id: 'uncertainty-gate.THIN_RETRIEVAL_MAX',
    value: 0.35,
    intent: 'threshold',
    signal: 'note-chunk best-hit rawScore',
    calibration: NOTE_CHUNK_COSINE,
    note: 'expected finding: unfireable-low. Kept registered at its LIVE value so the audit keeps reporting it until it is fixed.'
  },
  {
    id: 'raw-escalation.ESCALATE_MAX_SCORE',
    value: 0.45,
    intent: 'threshold',
    signal: 'note-chunk best-hit rawScore',
    calibration: NOTE_CHUNK_COSINE
  },
  {
    id: 'personalization-recall.RECALL_FLOOR',
    value: 0.28,
    intent: 'threshold',
    signal: 'operator-fact cosine',
    calibration: null,
    note: 'Annotated in source as "from forward_brief.py" — imported from another system\'s embedding space and never measured in this one. Do NOT assume the note-chunk range applies: operator facts are a different corpus.'
  },
  {
    id: 'entity-resolver.TRIPWIRE_HIGH_DEGREE',
    value: 6,
    intent: 'threshold',
    signal: 'entity-node degree in the brain graph',
    calibration: null,
    note: 'Assumes real duplicate entities are low-degree; the entity rebuild audit observes duplicates at degree 8-37. Measure the degree distribution before tuning the veto.'
  },
  {
    id: 'graph-expand-retrieve.beta',
    value: 1.2,
    intent: 'weight',
    signal: 'graph activation vs BM25 (alpha=1.0)',
    calibration: {
      measuredAt: '2026-07-01',
      context: 'TUNE/10-20-note corpora',
      observed: { min: 0, max: 0, n: 0 },
      method: 'tuned on small synthetic corpora; NOT re-measured at vault scale'
    },
    note: 'beta > alpha promotes weakly-activated reached notes over genuine BM25 hits. Measured -9.0pp recall@5 on the real vault; branch reverted to opt-in.'
  }
]
