// rsi-proposer.ts — the PRODUCER the RSI keep-if-better loop was missing. The apply / rollback /
// adjudicate machinery + earned-autonomy ratchet (self-improve-loop.ts / self-improve-registry.ts)
// were built, tested, and scheduler-wired — but UNFED: no production code ever staged an
// InflightChange, so adjudicateInflight iterated an empty ledger. This stages one: a byte-reversible
// edit to a .duin config the brain reads, targeting a fitness engine so adjudicateInflight can A/B
// it on a held-out window and keep-if-better.
//
// SAFETY / MOAT:
//  1. ONE in-flight change per engine — keeps the fitness signal attributable (registry invariant).
//  2. Every change is byte-reversible: applyChange snapshots the current file bytes before writing.
//  3. targetPath is path-confined to the vault's .duin/ tree (never an arbitrary write).
//  4. The proposer NEVER fires itself — the CALLER gates it (backgroundAutonomy + an explicit
//     operator trigger / knob choice). Verdict + rollback are the RSI loop's job.
import { createHash } from 'crypto'
import { applyChange } from './self-improve-loop'
import { isConfinedToDuin } from './rsi-confinement'
import { DEFAULT_MIN_DELTA } from './self-improve-fitness'
import { inflightForEngine, loadInflight, tierFor, upsertInflight, type InflightChange } from './self-improve-registry'
import { rsiTunablesPath, readRsiTunables, RSI_TUNABLE_BOUNDS, type RsiTunables } from './rsi-tunables'
import { readRsiForecasts, forecastByConfig, FORECAST_PREFER_MIN_N, type ConfigForecast } from './rsi-forecast-store'

export interface RsiChangeSpec {
  /** autonomy-graduation bucket, e.g. 'grounding-weight' | 'loop-schedule' | 'kind-weight' */
  changeClass: string
  /** the fitness engine this change targets (a calibration domain) — drives maturity + A/B */
  engine: string
  /** the .duin config the brain reads that this edits (MUST be under <vault>/.duin/) */
  targetPath: string
  /** the proposed new bytes */
  afterBytes: string
  /** ex-ante MAGNITUDE forecast of the fitness delta this move will deliver (calibrated-forecast
   *  contract). Absent ⇒ DEFAULT_MIN_DELTA (the minimum lift the change already claims). */
  predictedDelta?: number
}

export interface ProposeResult {
  staged: boolean
  reason: string
  change?: InflightChange
}

function changeId(spec: RsiChangeSpec): string {
  const h = createHash('sha256').update(`${spec.changeClass}\n${spec.targetPath}\n${spec.afterBytes}`).digest('hex')
  return 'chg-' + h.slice(0, 16)
}

// Re-exported for existing callers/tests; the implementation now lives in rsi-confinement.ts
// so self-improve-loop can share it without closing an import cycle.
export { isConfinedToDuin } from './rsi-confinement'

/** Stage one proposed change into the in-flight ledger — and, unless `opts.stage`, apply it
 *  (byte-reversible). Refuses if:
 *  - the target engine already has an undecided change (one-in-flight-per-engine attribution), or
 *  - targetPath escapes the vault's .duin/ tree.
 *  With `opts.stage` (W2, posture 2026-08-21) the record lands as status 'proposed' and the target
 *  file is NOT touched: the write is ratifyProposed's to make, on the operator's say-so. A staged
 *  row still occupies the engine's one-in-flight slot, so a waiting card can never stack.
 *  PURE of clocks except the injected nowISO. The CALLER decides whether to call this at all. */
export function proposeChange(vault: string, spec: RsiChangeSpec, nowISO: string, opts: { stage?: boolean } = {}): ProposeResult {
  if (!isConfinedToDuin(vault, spec.targetPath)) {
    return { staged: false, reason: `targetPath escapes ${vault}/.duin/ — refused` }
  }
  if (inflightForEngine(vault, spec.engine).length > 0) {
    return { staged: false, reason: `engine '${spec.engine}' already has an in-flight change` }
  }
  const rec: InflightChange = {
    id: changeId(spec),
    changeClass: spec.changeClass,
    engine: spec.engine,
    targetPath: spec.targetPath,
    beforeBytes: '', // filled by applyChange from the current file bytes (the rollback snapshot)
    afterBytes: spec.afterBytes,
    proposedAt: nowISO,
    status: 'proposed',
    // Per-change falsifiable contract (AHE): register the ex-ante improvement claim now; adjudicate
    // grades it against the held-out A/B. Distinct from the keep-gate — a change that merely avoids
    // regression is kept but its prediction FAILS, so the archive can weight true winners over
    // no-ops instead of treating every non-regressing knob as equal.
    prediction: { engine: spec.engine, claim: 'target engine wilson_lo improves by >= minDelta on the held-out A/B', minDelta: DEFAULT_MIN_DELTA, predictedDelta: spec.predictedDelta ?? DEFAULT_MIN_DELTA, predictedAt: nowISO },
  }
  if (opts.stage === true) {
    upsertInflight(vault, rec)
    return { staged: true, reason: 'staged awaiting ratification (posture: nothing applies without presence)', change: rec }
  }
  const change = applyChange(vault, rec, nowISO)
  // applyChange refuses (quarantines, writes nothing) a target that escapes the confinement root.
  // Report that honestly rather than claim an apply that did not happen.
  if (change.status !== 'applied') {
    return { staged: true, reason: 'refused: targetPath escapes the confinement root — nothing applied', change }
  }
  return { staged: true, reason: 'staged + applied (byte-reversible; awaiting held-out A/B)', change }
}

// ── The curated knob registry — the ONLY things the loop may tune ──
// Each knob maps to a bounded, CLAMPED .duin tunable (rsi-tunables.ts) + a fitness engine. Ships
// with TWO knobs on deliberately DISTINCT fitness engines — see RSI_KNOBS below. The safety rail is
// NOT "only one knob": it is the curated 2-key allowlist here plus clamp-on-read
// (rsi-tunables.ts:19-22 bounds namedSkillTopK to [1,5] and recallFailureLimit to [10,30], applied
// at :43-49), so a hand-edited or corrupted tunables file cannot push a value out of envelope.
// Add higher-value / domain-mapped knobs here once the loop is proven — a deliberate choice, never
// a guess, and every addition widens the allowlist that is doing the actual containment.
interface RsiKnob {
  changeClass: string
  engine: string
  key: keyof RsiTunables
  step: number
}
// Multi-knob POPULATION (AlphaEvolve): the QD archive explores a knob-space of >1
// dimension, not a single greedy knob. Each maps to a bounded/clamped tunable + a
// fitness engine, so a change on any dimension is A/B-graded and reversible.
// Each knob targets the recall-efficacy engine for the KIND IT ACTUALLY MOVES (self-improve-fitness's
// readFitnessVector projects recall-efficacy:<kind> alongside the calibration domains): namedSkillTopK
// moves how many named-skills are injected → recall-efficacy:named-skill; recallFailureLimit moves the
// failure-recall pool breadth → recall-efficacy:failure. This replaces the prior shared, near-circular
// 'promotion' engine (both knobs on one engine serialized them via the one-in-flight-per-engine
// invariant — not a real population — and A/B'd them against a signal they barely move). Distinct
// engines → genuinely concurrent in-flight AND each graded on the kind it changes.
const RSI_KNOBS = [
  { changeClass: 'named-skill-topk', engine: 'recall-efficacy:named-skill', key: 'namedSkillTopK', step: 1 },
  { changeClass: 'recall-failure-limit', engine: 'recall-efficacy:failure', key: 'recallFailureLimit', step: 5 }
] satisfies RsiKnob[]

/** The QUALITY-DIVERSITY ARCHIVE (SIA activation — the frozen-RSI unblock). The resolved
 *  self-improve ledger already records every tried variant with its outcome ('kept'|'rolled-back'),
 *  but the greedy +step proposer never read it — so a rolled-back variant was a dead state that the
 *  blind cycle would re-propose identically, trapping the loop in a local optimum (DGM/ADAS/GEA: keep
 *  the archive of stepping stones, don't only keep the champion). This reads that history as the
 *  archive: value → outcome for this knob. PURE-ish (reads the ledger, no clock). */
/** A tried value's archive verdict: 'improved' = kept AND its per-change contract held (delivered a
 *  real lift, predictionHeld); 'kept' = kept but flat (no regression, no lift); 'rolled-back' = failed. */
export type KnobVerdict = 'improved' | 'kept' | 'rolled-back'

export function archivedKnobValues(vault: string, knob: RsiKnob): Map<number, KnobVerdict> {
  const m = new Map<number, KnobVerdict>()
  const tp = rsiTunablesPath(vault)
  for (const c of loadInflight(vault)) {
    if (c.targetPath !== tp || (c.status !== 'kept' && c.status !== 'rolled-back' && c.status !== 'dismissed')) continue
    try {
      const v = (JSON.parse(c.afterBytes) as Record<string, unknown>)[knob.key]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      // Consume the per-change contract (predictionHeld): a KEPT change that actually delivered a lift
      // is 'improved' (a proven winner to converge to); kept-but-flat is just 'kept'. A DISMISSED
      // proposal maps to 'rolled-back': the operator said no, and patient means never asking the
      // same value again — not that it failed on evidence. (ledger last-write-wins)
      const verdict: KnobVerdict = c.status === 'rolled-back' || c.status === 'dismissed' ? 'rolled-back' : c.predictionHeld === true ? 'improved' : 'kept'
      m.set(v, verdict)
    } catch { /* skip a corrupt row */ }
  }
  return m
}

/** Archive-guided stepping-stone search over a knob's clamped range (explore → exploit).
 *  EXPLORE: prefer an UNEXPLORED value (novelty); NEVER re-propose a 'rolled-back' dead-end; skip cur.
 *  EXPLOIT: when novelty is exhausted, CONVERGE to a proven-'improved' value (its contract held) rather
 *  than resting at a possibly-flat current — this is where the per-change contract (predictionHeld)
 *  becomes load-bearing, steering the loop back to a value that actually delivered a lift.
 *  Returns null only when there is neither a novel nor a proven-improving value to move to. PURE. */
export function nextKnobValue(cur: number, bound: { min: number; max: number }, archive: Map<number, KnobVerdict>): number | null {
  for (let v = bound.min; v <= bound.max; v++) { // explore
    if (v === cur) continue
    if (archive.get(v) === 'rolled-back') continue // known-bad: don't repeat the greedy dead-end
    if (!archive.has(v)) return v // unexplored → novelty stepping stone
  }
  for (let v = bound.min; v <= bound.max; v++) { // exploit (consumes the improvement contract)
    if (v !== cur && archive.get(v) === 'improved') return v // converge to a proven winner
  }
  return null // no novel value and no proven-improving value to move to → rest
}

/** The JOINT (multi-dimensional) quality-diversity archive: value → verdict over the FULL knob-config
 *  descriptor (namedSkillTopK × recallFailureLimit), reconstructed from the ledger (each change's
 *  afterBytes carries the whole tunables object). The per-knob archive (archivedKnobValues) sees one
 *  scalar axis; this sees the 2-D CELL a change actually landed in — the frontier QD move (DGM/ADAS:
 *  keep diverse stepping-stones over a descriptor space, not per-scalar bins). Meaningful now that the
 *  two knobs run on DISTINCT engines (P1) so their values genuinely co-vary. PURE-ish (reads ledger). */
export function jointConfigKey(topK: number, failLimit: number): string {
  return `${topK}x${failLimit}`
}
export function archivedJointConfigs(vault: string): Map<string, KnobVerdict> {
  const m = new Map<string, KnobVerdict>()
  const tp = rsiTunablesPath(vault)
  for (const c of loadInflight(vault)) {
    if (c.targetPath !== tp || (c.status !== 'kept' && c.status !== 'rolled-back' && c.status !== 'dismissed')) continue
    try {
      const cfg = JSON.parse(c.afterBytes) as Record<string, unknown>
      const topK = cfg.namedSkillTopK
      const failLimit = cfg.recallFailureLimit
      if (typeof topK !== 'number' || typeof failLimit !== 'number') continue
      // dismissed → 'rolled-back' for the same reason as the scalar archive: never re-ask a value
      // the operator already declined.
      const verdict: KnobVerdict = c.status === 'rolled-back' || c.status === 'dismissed' ? 'rolled-back' : c.predictionHeld === true ? 'improved' : 'kept'
      m.set(jointConfigKey(topK, failLimit), verdict) // ledger last-write-wins
    } catch { /* skip a corrupt row */ }
  }
  return m
}

/** Per joint-config-cell forecast history from the rsi-forecast ledger (the calibrated-forecast
 *  contract's SELECTION read): `${topK}x${failLimit}` → { meanActual, hitRate, n }. meanActual seeds a
 *  revisit's predictedDelta; hitRate lets proposeNextRsiKnob PREFER well-modeled cells among the
 *  improving ones. Reads the SAME ledger calibration-native aggregates into the rsi-forecast domain —
 *  one file, a global domain + this per-cell selector, never a parallel store. PURE (reads fs). */
export function forecastAccuracyByConfig(vault: string): Map<string, ConfigForecast> {
  return forecastByConfig(readRsiForecasts(vault))
}

/** QUALITY-DIVERSITY stepping-stone search over a knob's clamped range, aware of BOTH the per-knob
 *  scalar archive AND the JOINT descriptor space (via jointKeyFor, which pins the other knob at its
 *  current value). EXPLORE: a value that is NOVEL in the single OR the joint space and whose joint CELL
 *  is not known-bad; NEVER a rolled-back scalar value or joint cell. EXPLOIT: among the proven-'improved'
 *  values, PREFER the one whose joint cell has the highest FORECAST hit-rate (a well-modeled winner over
 *  a merely-lucky one) — a secondary tie-break that never overrides lift and is inert on a cold ledger
 *  (falls back to the prior linear order). Returns null when neither novel nor proven. PURE. */
export function nextKnobValueQD(
  cur: number,
  bound: { min: number; max: number },
  singleArchive: Map<number, KnobVerdict>,
  jointKeyFor: (v: number) => string,
  jointArchive: Map<string, KnobVerdict>,
  forecast?: Map<string, ConfigForecast>
): number | null {
  for (let v = bound.min; v <= bound.max; v++) { // explore
    if (v === cur) continue
    if (singleArchive.get(v) === 'rolled-back' || jointArchive.get(jointKeyFor(v)) === 'rolled-back') continue
    if (!singleArchive.has(v) || !jointArchive.has(jointKeyFor(v))) return v // novel stepping stone (scalar or joint)
  }
  // exploit: collect the proven-improving candidates in the prior linear order, then prefer the one
  // whose joint cell is best-FORECAST (>= FORECAST_PREFER_MIN_N resolutions). Cold/thin cells score -1,
  // preserving the original first-improved behavior when no forecast history exists.
  const improved: number[] = []
  for (let v = bound.min; v <= bound.max; v++) {
    if (v === cur) continue
    if (jointArchive.get(jointKeyFor(v)) === 'improved' || singleArchive.get(v) === 'improved') improved.push(v)
  }
  if (improved.length === 0) return null
  const hitScore = (v: number): number => {
    const f = forecast?.get(jointKeyFor(v))
    return f && f.n >= FORECAST_PREFER_MIN_N ? f.hitRate : -1
  }
  let best = improved[0]
  let bestScore = hitScore(best)
  for (const v of improved.slice(1)) {
    const s = hitScore(v)
    if (s > bestScore) { best = v; bestScore = s } // strict > keeps linear order among ties/cold cells
  }
  return best
}

/** Stage the next RSI proposal if the engine has no in-flight change. Uses the JOINT quality-diversity
 *  archive to propose a knob value that is NOVEL in the descriptor space (escaping the local optimum),
 *  never a known-bad joint cell — writing the FULL tunables object so the brain always reads a valid,
 *  clamped file. Returns the ProposeResult, or null when nothing novel to propose. Called ONLY from the
 *  autonomy-gated self-improve tick — never self-fires. */
export function proposeNextRsiKnob(
  vault: string,
  nowISO: string,
  opts: { applyEarnedTier?: boolean } = {}
): ProposeResult | null {
  // Split-gate posture (2026-08-22, operator decision on R3): STAGING (file a Needs-you card,
  // write nothing) is safe on presence, but an autonomous WRITE at earned 'auto' tier keeps the
  // backgroundAutonomy master switch. The caller supplies that decision: the background tick only
  // runs under autonomyOn so it passes the default (true); the engage tick passes autonomyOn()'s
  // live value, so a graduated class STAGES (not applies) while backgroundAutonomy is off. Default
  // true preserves existing callers/tests. Pure module — the settings read stays in the caller.
  const applyEarnedTier = opts.applyEarnedTier !== false
  const cur = readRsiTunables(vault)
  const jointArchive = archivedJointConfigs(vault)
  const forecast = forecastAccuracyByConfig(vault) // per-cell forecast history (empty on a cold ledger)
  for (const knob of RSI_KNOBS) {
    if (inflightForEngine(vault, knob.engine).length > 0) continue
    // Earned-autonomy routing (W2, posture 2026-08-21) — supersedes the narrow just-demoted skip
    // (3aff60b). At tier 'auto' (GRADUATE_N kept verdicts earned) the change applies as before; at
    // 'propose' — a fresh class, one mid-streak, or one the ratchet demoted — it STAGES and waits
    // for the operator to ratify. The old chicken-and-egg worry ("blocking 'propose' makes 'auto'
    // unreachable, since verdicts only accrue from applied changes") is resolved, not ignored:
    // ratification IS the apply path, so verdicts accrue through the human gate and a class still
    // graduates by the same GRADUATE_N ratchet — it just cannot self-apply before it has earned it.
    const stage = tierFor(vault, knob.changeClass) !== 'auto' || !applyEarnedTier
    const bound = RSI_TUNABLE_BOUNDS[knob.key]
    // Pin the OTHER knob at its current value so jointKeyFor maps this knob's candidate to a 2-D cell.
    const jointKeyFor = (v: number): string =>
      knob.key === 'namedSkillTopK' ? jointConfigKey(v, cur.recallFailureLimit) : jointConfigKey(cur.namedSkillTopK, v)
    const next = nextKnobValueQD(cur[knob.key], bound, archivedKnobValues(vault, knob), jointKeyFor, jointArchive, forecast)
    if (next === null) continue // archive exhausted for this knob — no novel stepping stone to try
    const afterBytes = JSON.stringify({ ...cur, [knob.key]: next }, null, 2) + '\n'
    // The ex-ante forecast for this move: the chosen cell's mean actual delta from history, else the
    // minimum lift the change already claims (DEFAULT_MIN_DELTA) — never a silent 0 (which would grade
    // every flat move as "accurately predicted flat"). Its error is graded into the rsi-forecast domain.
    const cellForecast = forecast.get(jointKeyFor(next))
    const predictedDelta = cellForecast && cellForecast.n >= FORECAST_PREFER_MIN_N ? cellForecast.meanActual : DEFAULT_MIN_DELTA
    return proposeChange(
      vault,
      { changeClass: knob.changeClass, engine: knob.engine, targetPath: rsiTunablesPath(vault), afterBytes, predictedDelta },
      nowISO,
      { stage }
    )
  }
  return null
}
