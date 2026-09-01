// Compounding Health benchmark (4-axis) — the value-core analog of Brain Health
// (brain-health.ts). Brain Health answers "is the brain GRAPH coherent / grounded /
// fresh / clean?"; Compounding Health answers "is DUIN's LEARNING LOOP actually
// compounding, or is it silently frozen?" — the "learning-liveness monitor" the
// value-core audit found missing.
//
// GOVERNING PRINCIPLE (2026-07-17 rework — "sufficiency, not appetite"):
//   The benchmark scores the METABOLIC QUALITY of what genuinely arrives — NOT how much
//   arrived. A larger vault / ledger / fact-store never scores higher for being larger.
//   A mind at rest (no new input to process) is NOT sick: an unmeasurable signal is NEUTRAL
//   (excluded from the weighting), never 0. The pathology on this benchmark is the OPPOSITE
//   of idleness — it is APPETITE: accumulation outpacing digestion (intake climbing while the
//   resolved/graduated fraction stalls). Appetite is surfaced (backlogPressure) and TRIPS a
//   regression WARN; it is never rewarded. So: reward good digestion, stay neutral at rest,
//   flag hoarding.
//
// The four axes each map onto one stage of the compounding loop, and each is designed so a
// SPECIFIC upcoming fix provably moves it:
//   STABILITY    → construction converges (doesn't churn/clobber; deliberate consolidation is fine)
//   METABOLISM   → the claim/verdict engine DIGESTS what it holds (isn't frozen with a backlog)
//   COMPOUNDING  → the earn/promote loop actually GRADUATES facts (honestly)
//   GROUNDING    → the best-validated retrieval path + calibration are in use
//
// PURITY of the CORE is the whole point (mirrors brain-health.ts): `computeCompoundingHealth`
// performs NO I/O, no Date.now()/new Date() (the report time is injected as `builtAt`, and
// even the ledger-age is injected pre-computed as `ledgerFreshnessHours`), no DB reads — every
// signal arrives pre-loaded in `deps`, so each axis scorer unit-tests against a hand-built
// fixture. The thin live loader (`computeCompoundingHealthLive`, in compounding-health-live.ts)
// gathers those deps from the running app.

// ──────────────────── injected shapes (minimal, source-compatible) ────────────

/** One operator fact, compatible with OperatorFact (operator-model.ts). Only the fields
 *  the compounding axis needs are typed; presence of `govern`/`efficacy` is load-bearing. */
export interface CompoundingFact {
  /** 'candidate' | 'provisional' | 'promoted' | 'vetoed' | 'reverted'. */
  status: string
  /** Probation start — set when a human promotes a candidate → provisional. */
  provisionalAt?: number | null
  /** Distinct sessions survived on probation (survival signal). */
  observedSessions?: string[] | null
  /** Measured behavioral efficacy — PRESENCE is the coverage signal (0 today). */
  efficacy?: unknown
  /** Govern-loop provenance — PRESENCE is the honest-graduation marker. Legacy promoted
   *  facts (asserted, never juried) have NO govern block, so they DON'T count as earned. */
  govern?: unknown
}

/** STABILITY inputs — the entity-count series (one totalEntities per rebuild) + current count. */
export interface StabilityDeps {
  /** totalEntities per rebuild, oldest→newest (from brain-health-history.jsonl). Already
   *  windowed by the loader to the last N (e.g. 10). Empty ⇒ unmeasurable (neutral). */
  entityCountSeries: number[]
  /** Current entity count (from .brain/state/brain-construction.json). null ⇒ skip currentVsPeak. */
  currentEntities: number | null
}

/** METABOLISM inputs — the claim/verdict engine's freshness + resolution + verdict diversity. */
export interface MetabolismDeps {
  /** now − claim-ledger.jsonl mtime, in HOURS (injected pre-computed; the pure fn never stats).
   *  null ⇒ ledger absent. Under the rework freshness is a GATE, not a reward: a fresh ledger earns
   *  no points (writing ≠ digesting); staleness only penalizes when there is genuine backlog. */
  ledgerFreshnessHours: number | null
  /** Total claim rows in the ledger. Volume — NEVER a numerator that raises the score. */
  claimTotal: number
  /** Rows with a verdictBy set (resolved). */
  claimResolved: number
  /** Distinct verdictBy TYPES present (e.g. ['temporal'] — all-temporal is the degenerate case). */
  verdictTypes: string[]
}

/** COMPOUNDING inputs — the earn/promote loop's graduation + efficacy + survival + binding drain. */
export interface CompoundingLoopDeps {
  facts: CompoundingFact[]
  /** Rows in binding-ledger.jsonl (0 when absent). */
  bindingCount: number
  /** Rows in corrections.jsonl (the denominator for bindingDrain). */
  correctionCount: number
  /** Auto-promotion (candidate→provisional→governed-promoted) is gated OFF by choice — accept-starvation
   *  (backgroundAutonomy=false / ENACT_ENABLED). When true, a 0 governed-promotion count is a CHOSEN
   *  stance, not a failure: the promotion sub-signal earns READINESS credit (wired + primed) instead of
   *  scoring a realization-zero. Default false = ungated (strict: 0 output IS a failure). */
  promotionGated?: boolean
  /** The correction→binding drain is human-gated by design (no auto-drain path). Same treatment as
   *  promotionGated. Default false = ungated. */
  bindingGated?: boolean
}

/** How the decision-window calibration signal is CONSUMED. 'advisory' = surfaced only (today's
 *  honest baseline); 'gate'/'rerank' = routed into a real decision (the P4 fix flips this). */
export type CalibrationConsumeMode = 'advisory' | 'gate' | 'rerank'

/** GROUNDING inputs — env/config flags describing which retrieval path + calibration wiring is live. */
export interface GroundingConfigDeps {
  /** DUIN_GRAPH_EXPAND_GROUND === '1' — the graph-expand grounding path. OPT-IN / default OFF: its
   *  "+8pp" claim did not reproduce on a real vault (measured 2026-07-25: −9.0pp recall@5 vs the RRF
   *  fusion it replaces), so it no longer ships on. See brain/graph-expand-adapt.ts. */
  graphExpandGround: boolean
  /** DUIN_WHOLENOTE_GROUND === '1' — the validated-better whole-note grounding path (+14pp). */
  wholeNoteGround: boolean
  /** Whether the decision-window calibration signal is routed into a real gate/rerank vs advisory. */
  calibrationMode: CalibrationConsumeMode
  /** DUIN_RETRIEVER_VERIFY !== '0' — citation self-verification (default on). */
  citationVerifyActive: boolean
  /** Informational: decision-window observations available (forecast-track-record). Not scored;
   *  surfaces "N obs available but advisory-only" so the honesty gap is visible. */
  decisionWindowObs: number
}

export interface CompoundingHealthDeps {
  /** Report time — INJECTED (the pure fn never calls Date.now()/new Date()). */
  builtAt: string
  stability: StabilityDeps
  metabolism: MetabolismDeps
  compounding: CompoundingLoopDeps
  grounding: GroundingConfigDeps
  /** OPTIONAL axis-weight override (defaults below). */
  weights?: Partial<AxisWeights>
}

// ──────────────────── report shape ────────────────────

export interface AxisReport {
  score: number // 0-100
  /** FALSE ⇒ the axis had no genuine input to judge (a mind at rest, not a sick one). An unmeasured
   *  axis is NEUTRAL: it is excluded from the overall weighting rather than dragging it toward 0.
   *  Defaults to true when omitted. */
  measured?: boolean
  metrics: Record<string, number>
  notes: string
}
export interface CompoundingHealth {
  overall: number // 0-100 weighted avg of the MEASURED axes
  weakestAxis: string
  /** Axes that had no input to judge (measured === false) — reported so "neutral" is never mistaken
   *  for "healthy". */
  unmeasuredAxes: string[]
  axes: {
    stability: AxisReport
    metabolism: AxisReport
    compounding: AxisReport
    grounding: AxisReport
  }
  builtAt: string
}

export interface AxisWeights {
  stability: number
  metabolism: number
  compounding: number
  grounding: number
}

// Axis weights (document + overrideable). COMPOUNDING dominates because a graduating earn/promote
// loop is the whole VALUE payoff (the analog of brain-health's grounding weight); METABOLISM is the
// engine that feeds it; STABILITY + GROUNDING are the substrate + retrieval quality it compounds over.
export const DEFAULT_AXIS_WEIGHTS: AxisWeights = {
  stability: 0.2,
  metabolism: 0.25,
  compounding: 0.35,
  grounding: 0.2
}

/** The deterministic verdict vocabulary the metabolism engine can mint (mirrors claim-extract.ts
 *  DETERMINISTIC_BY). An engine that only ever emits ONE of these (all-temporal, the live case) is
 *  degenerate — supersession/jtms verdicts never fire. */
export const EXPECTED_VERDICT_TYPES = ['temporal', 'supersession', 'jtms'] as const

// ──────────────────── tuning constants (documented, so a fix's target is explicit) ────────────

/** A clobber = an adjacent rebuild whose entity count dropped MORE than this fraction vs the prior. */
export const CLOBBER_DROP_FRACTION = 0.3
/** Coefficient-of-variation at/above which the entity series is judged pure churn (score 0). */
export const CV_TARGET = 0.75
/** clobberEvents that drive the clobber sub-score to 0 (linear). */
export const CLOBBER_BUDGET = 3
/** Claim-ledger age (hours) under which metabolism is FRESH (frozen-gate = 1, no penalty). */
export const LEDGER_FRESH_HOURS = 6
/** Claim-ledger age (hours) at which the frozen-gate bottoms out (the 24h+ freeze the audit flagged). */
export const LEDGER_STALE_HOURS = 30
/** Floor of the frozen-gate multiplier: a metabolism with an extremely stale ledger keeps at most this
 *  fraction of its capability score. */
export const FROZEN_FLOOR = 0.2
/** COMPOUNDING axis blend: how much of the axis is READINESS (loop wired + primed + gated-by-choice) vs
 *  REALIZATION (value actually compounded through use/time). Realization-DOMINANT on purpose so the 80+
 *  ceiling still requires real compounding — a wired-but-cold loop earns "healthy, not sick" credit but
 *  cannot reach the top on readiness alone (readiness maxes the axis at READINESS_WEIGHT·100 = 40). */
export const READINESS_WEIGHT = 0.4
export const REALIZATION_WEIGHT = 0.6
/** Survived-sessions bar a provisional fact must clear to be GENUINELY promotion-ready (would confirm if
 *  ungated). Mirrors DEFAULT_GOVERN_POLICY.minSessions (operator-govern.ts) — the jury path's survival
 *  requirement. Readiness credits only the fraction of provisional facts that clear it, NOT mere
 *  existence (the participation-trophy 100 this replaces). It's a NECESSARY precondition (jury-pass is
 *  also required at runtime), so readiness is an honest upper bound on true would-fire. */
export const PROMOTE_READY_MIN_SESSIONS = 2
/** Grounding path: the floor for the working DEFAULT agentic path (validated paths add on top). */
export const GROUNDING_PATH_FLOOR = 40
/** Total validated pp improvement available (graphExpand +8, wholeNote +14). */
const GROUNDING_PP_TOTAL = 8 + 14
/** Calibration-consumption sub-scores by mode. advisory-only (today) is honestly low. */
export const CALIBRATION_MODE_SCORE: Record<CalibrationConsumeMode, number> = {
  advisory: 20,
  gate: 100,
  rerank: 100
}

// ──────────────────── small pure helpers ────────────────────

const clamp = (x: number, lo = 0, hi = 100): number => (x < lo ? lo : x > hi ? hi : x)
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const round1 = (x: number): number => Math.round(x * 10) / 10
const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** Weighted average of {score,weight} pairs; ignores zero-weight terms. */
function weightedAvg(parts: { score: number; weight: number }[]): number {
  let s = 0
  let w = 0
  for (const p of parts) {
    if (p.weight <= 0) continue
    s += p.score * p.weight
    w += p.weight
  }
  return w === 0 ? 0 : s / w
}

/** Population mean + standard deviation of a series (0/0 on empty). PURE. */
export function meanStd(xs: number[]): { mean: number; std: number } {
  if (xs.length === 0) return { mean: 0, std: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varr = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length
  return { mean, std: Math.sqrt(varr) }
}

/** Count adjacent drops steeper than `dropFraction` (the clobber signature). PURE. */
export function countClobbers(series: number[], dropFraction = CLOBBER_DROP_FRACTION): number {
  let n = 0
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]
    if (prev > 0 && (prev - series[i]) / prev > dropFraction) n++
  }
  return n
}

/** A fact is a GOVERNED promotion (honestly earned) iff it is promoted AND carries a govern block
 *  AND was actually on probation (provisionalAt). This is the HONESTY FIX: legacy promoted facts —
 *  asserted without ever passing the jury — have no govern block and DON'T count (unlike
 *  moat-health.ts, which counts every promoted fact as "confirmed/earned"). PURE. */
export function isGovernedPromotion(f: CompoundingFact): boolean {
  return f.status === 'promoted' && f.govern != null && f.provisionalAt != null
}

// ──────────────────── axis scorers (each PURE, each unit-testable) ────────────

/**
 * STABILITY — construction converges; churn/clobber is bad, deliberate CONSOLIDATION is fine.
 * - entityCountCV = stddev/mean of totalEntities over the window → HIGH cv = churn → low.
 * - clobberEvents = adjacent builds where entities dropped > 30% vs the prior (the clobber signature).
 * - currentVsPeak = current / max(window). REWORK: being below peak is only penalized when there ARE
 *   clobbers in the window (the shortfall is destructive). With zero clobbers a lower current is
 *   deliberate consolidation/subtraction — NOT a defect — so the term is dropped (weight 0). This stops
 *   the benchmark from treating "the graph got smaller" as illness (the operator's calm-by-subtraction).
 */
export function scoreStability(deps: StabilityDeps): AxisReport {
  const series = deps.entityCountSeries ?? []
  const builds = series.length
  const { mean, std } = meanStd(series)
  const cv = mean > 0 ? std / mean : 0
  const cvScore = builds >= 2 ? clamp(100 * (1 - cv / CV_TARGET)) : 0

  const clobberEvents = countClobbers(series)
  const clobberScore = builds >= 2 ? clamp(100 * (1 - clobberEvents / CLOBBER_BUDGET)) : 0

  const peak = builds > 0 ? Math.max(...series) : 0
  const hasCurrent = typeof deps.currentEntities === 'number' && deps.currentEntities !== null
  const currentVsPeak = hasCurrent && peak > 0 ? (deps.currentEntities as number) / peak : 0
  // Consolidation-aware: only score current-vs-peak when clobbers are present (destructive shortfall).
  const currentApplies = hasCurrent && peak > 0 && clobberEvents > 0
  const currentScore = currentApplies ? clamp(100 * currentVsPeak) : 0

  // When there is no series yet, stability is unmeasurable → NEUTRAL (measured:false), never 0.
  const measured = builds >= 2 || hasCurrent
  const score =
    builds < 2
      ? weightedAvg([{ score: currentApplies ? currentScore : 0, weight: currentApplies ? 1 : 0 }])
      : weightedAvg([
          { score: cvScore, weight: 0.4 },
          { score: clobberScore, weight: 0.3 },
          { score: currentScore, weight: currentApplies ? 0.3 : 0 }
        ])

  return {
    score: round1(score),
    measured,
    metrics: {
      builds,
      meanEntities: round1(mean),
      entityCountCV: round3(cv),
      clobberEvents,
      peakEntities: peak,
      currentEntities: hasCurrent ? (deps.currentEntities as number) : -1,
      currentVsPeak: round3(currentVsPeak),
      currentVsPeakApplied: currentApplies ? 1 : 0
    },
    notes:
      builds < 2
        ? `only ${builds} build(s) recorded — churn unmeasurable; current ${
            hasCurrent ? deps.currentEntities : '?'
          } entities`
        : `${builds} builds, cv ${round3(cv)} (mean ${round1(mean)}); ${clobberEvents} clobber(s) (>30% drop); current ${
            hasCurrent ? deps.currentEntities : '?'
          }/${peak} peak${clobberEvents === 0 ? ' (below-peak = consolidation, not penalized)' : ''}`
  }
}

/**
 * METABOLISM — the claim/verdict engine RECONCILES what it holds; it is not frozen or inert.
 * REWORK ("sufficiency, not appetite") + CORRECTION (2026-07-17, after inspecting the live ledger):
 *
 *   A claim with NO verdict is a STANDING, uncontested fact — the NORMAL, healthy majority (live: 239
 *   of 287). The verdict vocabulary is temporal/supersession/jtms — all CONTRADICTION verdicts; there
 *   is no "accepted" verdict. So "resolved fraction" is NOT a digestion-quality signal: rewarding a
 *   high resolved fraction would demand more contradictions = reward CHURN, and treating "unresolved"
 *   as a backlog would pathologize a healthy base of standing facts. Both are just appetite in disguise.
 *
 * The score therefore rests on CAPABILITY-IN-USE + LIVENESS (both volume-neutral), never on how many
 * claims exist or what fraction is resolved:
 * - verdictDiversity  = distinct verdict TYPES applied / expected {temporal,supersession,jtms}. Evidence
 *   the engine actually exercises its full reconciliation vocabulary (all-temporal = degenerate).
 * - reconciling        = is ANY reconciliation happening (claimResolved > 0) vs inert.
 * - frozenFactor       = a PENALTY for an extremely stale ledger (the 2-day freeze the audit found).
 *   Freshness earns NO bonus (writing ≠ health); staleness only ever removes score. A single point
 *   can't perfectly tell "stale because at rest" from "stale because frozen", so the precise re-freezing
 *   catch lives in the regression detector; this gate is the blunt single-point backstop.
 * resolutionRate + standingFraction are reported as INFORMATION only (standingFraction is expected HIGH
 * and is not a defect).
 */
export function scoreMetabolism(deps: MetabolismDeps): AxisReport {
  const claimTotal = deps.claimTotal
  const ageH = deps.ledgerFreshnessHours
  const ledgerKnown = !(ageH === null || ageH === undefined || !Number.isFinite(ageH))

  const distinctTypes = new Set(deps.verdictTypes.filter(Boolean))
  const verdictDiversity = distinctTypes.size / EXPECTED_VERDICT_TYPES.length
  const diversityScore = clamp(100 * verdictDiversity)
  const reconciling = deps.claimResolved > 0
  const livenessScore = reconciling ? 100 : 0

  const parts = [
    { score: diversityScore, weight: claimTotal > 0 ? 0.6 : 0 },
    { score: livenessScore, weight: claimTotal > 0 ? 0.4 : 0 }
  ]
  const measured = claimTotal > 0 // no claims ⇒ AT REST (neutral, excluded from overall), never 0
  const capability = weightedAvg(parts)

  // FROZEN GATE — penalty only; freshness never rewards. Fresh ⇒ 1 (no penalty); stale ⇒ decays to floor.
  let frozenFactor = 1
  if (ledgerKnown) {
    if ((ageH as number) <= LEDGER_FRESH_HOURS) frozenFactor = 1
    else
      frozenFactor =
        FROZEN_FLOOR +
        (1 - FROZEN_FLOOR) * clamp01(1 - ((ageH as number) - LEDGER_FRESH_HOURS) / (LEDGER_STALE_HOURS - LEDGER_FRESH_HOURS))
  }
  const score = measured ? capability * frozenFactor : 0

  const resolutionRate = claimTotal > 0 ? deps.claimResolved / claimTotal : 0
  const standingFraction = claimTotal > 0 ? (claimTotal - deps.claimResolved) / claimTotal : 0

  return {
    score: round1(score),
    measured,
    metrics: {
      ledgerFreshnessHours: ledgerKnown ? round1(ageH as number) : -1,
      claimTotal,
      claimResolved: deps.claimResolved,
      resolutionRate: round3(resolutionRate),
      standingFraction: round3(standingFraction),
      verdictTypeCount: distinctTypes.size,
      verdictDiversity: round3(verdictDiversity),
      frozenFactor: round3(frozenFactor)
    },
    notes: !measured
      ? `no claims — metabolism AT REST (neutral, not scored)`
      : `${deps.claimResolved} reconciled, ${claimTotal - deps.claimResolved} standing (${(
          standingFraction * 100
        ).toFixed(0)}% uncontested — healthy); verdict types {${[...distinctTypes].join(',')}} = ${distinctTypes.size}/${
          EXPECTED_VERDICT_TYPES.length
        }; ledger ${ledgerKnown ? round1(ageH as number) + 'h' : 'ABSENT'}${
          frozenFactor < 1 ? ` STALE (frozen-gate ${round3(frozenFactor)})` : ''
        }`
  }
}

/**
 * COMPOUNDING — the earn/promote loop, scored as READINESS (wired + primed) × REALIZATION (actually
 * compounded). REWORK (2026-07-17, "don't score a chosen gate as disease"): two of the four sub-signals
 * are gated OFF by deliberate accept-starvation (governed promotion needs autonomy/jury; the binding
 * drain is human-gated). Scoring their 0 output as a realization-failure pathologizes a chosen stance —
 * the same mislabel we corrected on the metabolism axis. So:
 * - REALIZATION (value actually compounded, the honest headroom that only USE + TIME can lift):
 *     efficacyCoverage (facts measured / total) + survivalProgress (provisional facts that survived ≥1
 *     observed session / provisional). Both have LIVE recorders; both are legitimately cold at first.
 * - READINESS (loop wired + primed, and its 0 is explained by a KNOWN by-design gate):
 *     promotion + binding earn READINESS (100) ONLY when gated AND primed (there IS input on probation /
 *     there ARE corrections). An UNGATED loop with 0 output scores its realization (0) — readiness can
 *     never be gamed by simply not shipping.
 * - axis = readiness·READINESS_WEIGHT + realization·REALIZATION_WEIGHT (realization-dominant → 80+ still
 *     requires real compounding; a wired-but-cold loop tops out at READINESS_WEIGHT·100 = 40).
 * Empty populations (no facts / no provisional / no corrections) are UNMEASURED (weight 0), not 0 — an
 * earn loop with nothing on probation is at rest, not failing; if BOTH sides are empty, measured:false.
 */
export function scoreCompounding(deps: CompoundingLoopDeps): AxisReport {
  const facts = deps.facts ?? []
  const total = facts.length
  const provisional = facts.filter((f) => f.status === 'provisional')
  const governedPromotions = facts.filter(isGovernedPromotion).length
  const legacyPromoted = facts.filter((f) => f.status === 'promoted' && !isGovernedPromotion(f)).length
  const promotionGated = deps.promotionGated === true
  const bindingGated = deps.bindingGated === true

  // REALIZATION signals — actual compounded value (RATIOS, volume-neutral).
  const promotionThroughput = provisional.length > 0 ? governedPromotions / provisional.length : 0
  const throughputScore = clamp(100 * promotionThroughput)
  const factsWithEfficacy = facts.filter((f) => f.efficacy != null).length
  const efficacyCoverage = total > 0 ? factsWithEfficacy / total : 0
  const efficacyScore = clamp(100 * efficacyCoverage)
  const survivedProvisional = provisional.filter((f) => (f.observedSessions?.length ?? 0) >= 1).length
  const survivalProgress = provisional.length > 0 ? survivedProvisional / provisional.length : 0
  const survivalScore = clamp(100 * survivalProgress)
  const bindingDrain = deps.correctionCount > 0 ? deps.bindingCount / deps.correctionCount : 0
  const bindingScore = clamp(100 * bindingDrain)

  // READINESS — GRADED, not a flat existence flag. A gated loop earns credit ONLY for the fraction of
  // its material that would ACTUALLY FIRE if ungated: for promotion, provisional facts that clear the
  // govern survival bar (observedSessions ≥ PROMOTE_READY_MIN_SESSIONS). "Wired + has input" is NOT
  // enough — that was the participation-trophy 100. Nothing ripe ⇒ readiness 0 (honest cold-start, the
  // gate isn't what's holding it — ripening is). Ungated ⇒ readiness IS realization (actual throughput).
  const promotionReadyCount = provisional.filter(
    (f) => (f.observedSessions?.length ?? 0) >= PROMOTE_READY_MIN_SESSIONS
  ).length
  const promotionReadyFraction = provisional.length > 0 ? promotionReadyCount / provisional.length : 0
  const promotionReadiness = promotionGated ? clamp(100 * promotionReadyFraction) : throughputScore

  const readinessParts = [{ score: promotionReadiness, weight: provisional.length > 0 ? 1 : 0 }]
  // The correction→binding drain is human-gated with no measurable ripeness signal here, so when gated
  // it is EXCLUDED (neutral) — not given a fake readiness NOR a realization-zero that would pathologize
  // the human gate. Ungated, it scores its realized drain.
  const realizationParts = [
    { score: efficacyScore, weight: total > 0 ? 0.2 : 0 },
    { score: survivalScore, weight: provisional.length > 0 ? 0.25 : 0 },
    { score: bindingScore, weight: !bindingGated && deps.correctionCount > 0 ? 0.15 : 0 }
  ]
  const hasReadiness = readinessParts.some((p) => p.weight > 0)
  const hasRealization = realizationParts.some((p) => p.weight > 0)
  const readiness = weightedAvg(readinessParts)
  const realization = weightedAvg(realizationParts)

  const measured = hasReadiness || hasRealization
  const score = weightedAvg([
    { score: readiness, weight: hasReadiness ? READINESS_WEIGHT : 0 },
    { score: realization, weight: hasRealization ? REALIZATION_WEIGHT : 0 }
  ])

  const gatedLabel = [promotionGated ? 'promotion' : '', bindingGated ? 'binding' : ''].filter(Boolean).join('+')

  return {
    score: round1(score),
    measured,
    metrics: {
      totalFacts: total,
      provisionalFacts: provisional.length,
      governedPromotions,
      legacyPromoted,
      promotionThroughput: round3(promotionThroughput),
      factsWithEfficacy,
      efficacyCoverage: round3(efficacyCoverage),
      survivedProvisional,
      survivalProgress: round3(survivalProgress),
      bindingCount: deps.bindingCount,
      correctionCount: deps.correctionCount,
      bindingDrain: round3(bindingDrain),
      promotionReadyCount,
      promotionReadyFraction: round3(promotionReadyFraction),
      readiness: round1(readiness),
      realization: round1(realization),
      promotionGated: promotionGated ? 1 : 0,
      bindingGated: bindingGated ? 1 : 0
    },
    notes: !measured
      ? `no facts on probation and no corrections — earn loop AT REST (neutral, not scored)`
      : `readiness ${round1(readiness)} (${promotionReadyCount}/${provisional.length} promotion-ready${
          gatedLabel ? `, ${gatedLabel} gated` : ''
        }), realization ${round1(realization)} — ${governedPromotions} governed promo, efficacy ${factsWithEfficacy}/${total}, survival ${survivedProvisional}/${
          provisional.length
        } (cold-start); ${legacyPromoted} legacy`
  }
}

/**
 * GROUNDING — best-validated retrieval path + calibration in use.
 * - groundingPathScore   = floor for the working default agentic path, + the claimed pp gains that
 *   are actually enabled (graphExpand +8, wholeNote +14). Both on ⇒ 100; default only ⇒ floor.
 *   ⚠ CAVEAT (2026-07-25): graphExpand's "+8" is NOT validated — it came from a 10–20-note TUNE
 *   corpus and was REFUTED on the real vault (−9.0pp recall@5, −10.3pp MRR vs the RRF fusion it
 *   replaces; see brain/graph-expand-adapt.ts), which is why DUIN_GRAPH_EXPAND_GROUND is now
 *   default-OFF. The constant is left in place deliberately: rescaling this benchmark is a separate
 *   change with its own pinned fixtures. Read a nonzero graphExpand contribution as "the operator
 *   explicitly opted in", not as "grounding is measurably better".
 * - calibrationConsumed  = is the decision-window signal routed into a real gate/rerank vs advisory-only?
 *   HONEST baseline: 'advisory' scores low today; the P4 fix flips the mode → high.
 * - citationVerifyActive = DUIN_RETRIEVER_VERIFY !== '0' (default on).
 * (Config-only axis — always measurable, volume-neutral, so no appetite surface here.)
 */
export function scoreGrounding(deps: GroundingConfigDeps): AxisReport {
  const activePp = (deps.graphExpandGround ? 8 : 0) + (deps.wholeNoteGround ? 14 : 0)
  const groundingPathScore = clamp(GROUNDING_PATH_FLOOR + (100 - GROUNDING_PATH_FLOOR) * (activePp / GROUNDING_PP_TOTAL))

  const calibrationScore = CALIBRATION_MODE_SCORE[deps.calibrationMode] ?? CALIBRATION_MODE_SCORE.advisory
  const citationScore = deps.citationVerifyActive ? 100 : 0

  const score = weightedAvg([
    { score: groundingPathScore, weight: 0.4 },
    { score: calibrationScore, weight: 0.35 },
    { score: citationScore, weight: 0.25 }
  ])

  return {
    score: round1(score),
    measured: true,
    metrics: {
      groundingPathScore: round1(groundingPathScore),
      graphExpandGround: deps.graphExpandGround ? 1 : 0,
      wholeNoteGround: deps.wholeNoteGround ? 1 : 0,
      calibrationConsumed: calibrationScore, // numeric proxy; mode string in notes
      citationVerifyActive: deps.citationVerifyActive ? 1 : 0,
      decisionWindowObs: deps.decisionWindowObs
    },
    notes: `grounding path ${
      deps.wholeNoteGround ? 'whole-note' : deps.graphExpandGround ? 'graph-expand' : 'default agentic'
    } (${round1(groundingPathScore)}); calibration ${deps.calibrationMode}${
      deps.calibrationMode === 'advisory' ? ` (${deps.decisionWindowObs} obs available, unconsumed)` : ''
    }; citation-verify ${deps.citationVerifyActive ? 'on' : 'OFF'}`
  }
}

// ──────────────────── the pure benchmark ────────────────────

const isMeasured = (a: AxisReport): boolean => a.measured !== false

/**
 * Compute the 4-axis Compounding Health report from INJECTED deps. PURE + deterministic:
 * no I/O, no clock reads (report time is `deps.builtAt`; ledger age is pre-computed in deps).
 * Every axis degrades gracefully on sparse/empty inputs (never throws). An axis with no genuine input
 * (measured === false) is EXCLUDED from the overall — an at-rest mind is neutral, not scored 0.
 */
export function computeCompoundingHealth(deps: CompoundingHealthDeps): CompoundingHealth {
  const weights: AxisWeights = { ...DEFAULT_AXIS_WEIGHTS, ...(deps.weights ?? {}) }

  const stability = scoreStability(deps.stability)
  const metabolism = scoreMetabolism(deps.metabolism)
  const compounding = scoreCompounding(deps.compounding)
  const grounding = scoreGrounding(deps.grounding)

  const overall = weightedAvg([
    { score: stability.score, weight: isMeasured(stability) ? weights.stability : 0 },
    { score: metabolism.score, weight: isMeasured(metabolism) ? weights.metabolism : 0 },
    { score: compounding.score, weight: isMeasured(compounding) ? weights.compounding : 0 },
    { score: grounding.score, weight: isMeasured(grounding) ? weights.grounding : 0 }
  ])

  // weakestAxis is chosen among MEASURED axes only (an unmeasured axis isn't "weak", it's silent).
  const measuredScores: [string, number][] = (
    [
      ['stability', stability],
      ['metabolism', metabolism],
      ['compounding', compounding],
      ['grounding', grounding]
    ] as [string, AxisReport][]
  )
    .filter(([, a]) => isMeasured(a))
    .map(([n, a]) => [n, a.score])
  const weakestAxis = (measuredScores.length > 0 ? measuredScores : [['none', 0] as [string, number]]).reduce((min, cur) =>
    cur[1] < min[1] ? cur : min
  )[0]

  const unmeasuredAxes = (
    [
      ['stability', stability],
      ['metabolism', metabolism],
      ['compounding', compounding],
      ['grounding', grounding]
    ] as [string, AxisReport][]
  )
    .filter(([, a]) => !isMeasured(a))
    .map(([n]) => n)

  return {
    overall: round1(overall),
    weakestAxis,
    unmeasuredAxes,
    axes: { stability, metabolism, compounding, grounding },
    builtAt: deps.builtAt
  }
}

// ──────────────────── regression detector (PURE) ────────────────────

/** Overall score drop (vs prior report) that trips a WARN. */
export const OVERALL_DROP = 5
/** Per-axis score drop (vs prior report) that trips a WARN. */
export const AXIS_DROP = 10
/** Absolute floor: any MEASURED axis below this WARNs regardless of history (an UNMEASURED axis is
 *  neutral and never trips the floor — idleness is not a defect). */
export const AXIS_FLOOR = 15
/** Fact-store rise across reports that, without matching graduation, trips the APPETITE warn —
 *  accumulation outpacing integration (the pathology this rework names). */
export const APPETITE_INTAKE_MIN = 20

const AXES = ['stability', 'metabolism', 'compounding', 'grounding'] as const
const EPS = 1e-9

/**
 * PURE: compare the current report against the PRIOR one and return a (possibly empty) list of
 * human-readable regression messages. No I/O. `prev === null` ⇒ only the absolute floors can fire.
 *
 * Regressions (each ⇒ a WARN with before→after delta):
 *   - overall drops > OVERALL_DROP
 *   - any MEASURED axis drops > AXIS_DROP
 *   - promotionThroughput DROPS (the honest earn loop regressing)
 *   - clobberEvents RISE (construction clobber returning)
 *   - ledgerFreshnessHours RISES back above the stale threshold (metabolism re-freezing)
 *   - APPETITE: the FACT store rises ≥ APPETITE_INTAKE_MIN while graduation stays flat — the store
 *     growing without earning (accumulation outpacing integration). We deliberately do NOT trip on
 *     claim-count growth or unresolved fraction: standing/uncontested claims are the healthy majority.
 * Plus history-independent absolute floors: any MEASURED axis < AXIS_FLOOR.
 */
export function detectCompoundingRegression(
  prev: CompoundingHealth | null,
  curr: CompoundingHealth
): string[] {
  const out: string[] = []

  for (const name of AXES) {
    const axis = curr.axes[name]
    if (axis.measured === false) continue
    if (axis.score < AXIS_FLOOR) out.push(`FLOOR: ${name} axis ${round1(axis.score)} < ${AXIS_FLOOR}`)
  }
  if (curr.overall < AXIS_FLOOR) out.push(`FLOOR: overall ${round1(curr.overall)} < ${AXIS_FLOOR}`)

  if (!prev) return out

  if (prev.overall - curr.overall > OVERALL_DROP + EPS) {
    out.push(`overall dropped ${round1(prev.overall)}→${round1(curr.overall)} (Δ${round1(curr.overall - prev.overall)})`)
  }
  for (const name of AXES) {
    if (curr.axes[name].measured === false || prev.axes[name].measured === false) continue
    const a = prev.axes[name].score
    const b = curr.axes[name].score
    if (a - b > AXIS_DROP + EPS) out.push(`${name} axis dropped ${round1(a)}→${round1(b)} (Δ${round1(b - a)})`)
  }

  const pThr = Number(prev.axes.compounding.metrics.promotionThroughput ?? 0)
  const cThr = Number(curr.axes.compounding.metrics.promotionThroughput ?? 0)
  if (pThr - cThr > EPS) {
    out.push(`promotionThroughput dropped ${round3(pThr)}→${round3(cThr)} (earn loop regressing)`)
  }

  const pClob = Number(prev.axes.stability.metrics.clobberEvents ?? 0)
  const cClob = Number(curr.axes.stability.metrics.clobberEvents ?? 0)
  if (cClob > pClob) {
    out.push(`clobberEvents rose ${pClob}→${cClob} (+${cClob - pClob}, construction clobber returning)`)
  }

  const pAge = Number(prev.axes.metabolism.metrics.ledgerFreshnessHours ?? -1)
  const cAge = Number(curr.axes.metabolism.metrics.ledgerFreshnessHours ?? -1)
  if (cAge >= 0 && cAge > LEDGER_STALE_HOURS && cAge - pAge > EPS) {
    out.push(`ledgerFreshnessHours rose ${round1(pAge)}→${round1(cAge)} (metabolism re-freezing)`)
  }

  // ── APPETITE — accumulation outpacing INTEGRATION (the "sufficiency, not appetite" trip) ──
  // Note we do NOT trip on claim-count growth or "unresolved fraction": most claims are standing,
  // uncontested facts (healthy), so those signals would fire on a healthy vault. The clean appetite
  // signal is the FACT store growing while the EARN loop graduates nothing — accumulation without
  // integration. (Re-freezing is caught above via ledgerFreshnessHours.)
  const pFacts = Number(prev.axes.compounding.metrics.totalFacts ?? 0)
  const cFacts = Number(curr.axes.compounding.metrics.totalFacts ?? 0)
  if (cFacts - pFacts >= APPETITE_INTAKE_MIN && cThr <= pThr + EPS) {
    out.push(
      `APPETITE: facts ${pFacts}→${cFacts} (+${cFacts - pFacts}) while graduation ${round3(pThr)}→${round3(
        cThr
      )} flat — store growing without earning`
    )
  }

  return out
}
