// forecast-generator — GRAPH-DERIVED forecasts (the moat: non-obvious, falsifiable,
// GROUNDED — derived from the causal graph's real edges/slack, NOT LLM rollout).
// Replaces "deadline-clock" decision-windows as the foresight surface. Three kinds:
//   • driver     — a common cause behind ≥2 streams (correlated risk / single lever)
//   • convergence — a future milestone carrying many dependent threads (contention)
//   • cascade    — a behind-schedule gate threatening a FUTURE downstream milestone
// Gated (future-only · deduped · ranked by severity) so it emits a few sharp
// forecasts, not one-per-node noise. Read-only over causalGraph(); logging the
// pre-act forecast to the calibration ledger is a separate (write) step.
import { causalGraph, type CGNode, type CGEdge } from './causal-substrate'
import { loadKindRates } from './calibration-weight'
import { scoreResolvedLedger, loadScoredForecasts } from './calibration-scoring'
import { fitRecalibration, recalibrate } from './calibration-recalibrate'

export interface Forecast {
  id: string
  kind: 'driver' | 'convergence' | 'cascade'
  subject: string
  statement: string
  severity: number // higher = more urgent; for ranking + the surface's top-N
  confidence: number
  basis: string[] // the grounding node/edge labels — never a hallucinated claim
  subjects: string[] // RAW ids (stream/task) → map to the resolver's open_ids
  eval_after: string // ISO date the calibration resolver checks the outcome after
  baseConfidence?: number // the prior, before calibration weighting
  calibration?: { rate: number | null; observed: number; gated: boolean; skill?: number | null; recalibrated?: boolean } // the track-record basis
}

const isoOf = (d: Date): string => d.toISOString().slice(0, 10)
/** Node id → raw id the resolver's open_ids uses: 'stream:s1'→'s1', 'task:xyz'→'xyz'. */
const rawId = (nodeId: string): string => nodeId.split(':').slice(1).join(':')
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000)
/** A milestone is still "live" if it has no date or its date is today-or-later.
 *  Past-dated anchors (a finished event) are dropped — the stale-anchor bug the
 *  dry-run caught (cascades pointing at an already-past 试玩会). */
const isFutureAnchor = (n: CGNode, todayIso: string): boolean => {
  const d = String(n.date ?? '').slice(0, 10)
  return !d || d >= todayIso
}

export function generateForecasts(vaultDir: string | null, today: Date = new Date()): Forecast[] {
  const { nodes, edges } = causalGraph(vaultDir, '', today)
  const todayIso = isoOf(today)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const outOf = (id: string): CGEdge[] => edges.filter((e) => e.source === id)
  const inTo = (id: string): CGEdge[] => edges.filter((e) => e.target === id)
  const out: Forecast[] = []

  const horizon = isoOf(addDays(today, 30)) // standing-risk kinds get a 30-day check horizon

  // ── DRIVER — a common cause behind ≥2 streams (correlated; the highest-value kind) ──
  for (const dr of nodes.filter((n) => n.kind === 'driver')) {
    const streamEdges = outOf(dr.id).filter((e) => e.type === 'drives')
    const streams = streamEdges.map((e) => byId.get(e.target)?.label).filter((x): x is string => !!x)
    const subjects = streamEdges.map((e) => rawId(e.target)).filter(Boolean)
    if (streams.length >= 2) {
      out.push({
        id: `fc:driver:${dr.id}`,
        kind: 'driver',
        subject: dr.label,
        statement: `«${dr.label}» is the common cause behind ${streams.length} streams — they move together; one lever swings all of them.`,
        severity: streams.length * 2,
        confidence: 0.7,
        basis: streams,
        subjects,
        eval_after: horizon
      })
    }
  }

  // ── CONVERGENCE — a FUTURE milestone carrying many dependent threads (contention) ──
  const convThreshold = 3
  const convs = nodes
    .filter((n) => n.kind === 'anchor' && n.converges && isFutureAnchor(n, todayIso))
    .map((n) => ({
      n,
      feeders: inTo(n.id).map((e) => byId.get(e.source)?.label).filter((x): x is string => !!x),
      feederIds: inTo(n.id).map((e) => rawId(e.source)).filter(Boolean)
    }))
    .filter((c) => c.feeders.length >= convThreshold)
    .sort((a, b) => b.feeders.length - a.feeders.length)
  for (const c of convs) {
    out.push({
      id: `fc:conv:${c.n.id}`,
      kind: 'convergence',
      subject: c.n.label,
      statement: `«${c.n.label}» carries ${c.feeders.length} dependent threads — highest-contention milestone; a shared point of overload.`,
      severity: c.feeders.length,
      confidence: 0.6,
      basis: c.feeders,
      subjects: c.feederIds,
      eval_after: String(c.n.date ?? '').slice(0, 10) || horizon
    })
  }

  // ── CASCADE — behind-schedule gates threatening a FUTURE milestone (deduped per anchor) ──
  const perAnchor = new Map<string, { anchor: CGNode; worst: number; gates: string[]; ids: string[] }>()
  for (const g of nodes.filter((n) => n.kind === 'gate' && typeof n.slack === 'number' && (n.slack as number) < 0)) {
    for (const e of outOf(g.id)) {
      const a = byId.get(e.target)
      if (!a || a.kind !== 'anchor' || !isFutureAnchor(a, todayIso)) continue
      const behind = Math.abs(g.slack as number)
      const cur = perAnchor.get(a.id) ?? { anchor: a, worst: 0, gates: [], ids: [] }
      cur.worst = Math.max(cur.worst, behind)
      cur.gates.push(`${g.label} (${behind}d behind)`)
      cur.ids.push(rawId(g.id)) // the behind-schedule task id → resolver checks if still open
      perAnchor.set(a.id, cur)
    }
  }
  for (const { anchor, worst, gates, ids } of perAnchor.values()) {
    out.push({
      id: `fc:cascade:${anchor.id}`,
      kind: 'cascade',
      subject: anchor.label,
      statement: `«${anchor.label}» (${String(anchor.date ?? '?')}) is threatened by ${gates.length} behind-schedule feeder${gates.length > 1 ? 's' : ''} (worst ${worst}d) — the slippage propagates to the milestone, not just the task.`,
      severity: worst + gates.length,
      confidence: worst > 14 ? 0.75 : 0.6,
      basis: gates.slice(0, 6),
      subjects: ids,
      eval_after: String(anchor.date ?? '').slice(0, 10) || horizon
    })
  }

  // ── CALIBRATION FEEDBACK — weight confidence + ranking by each kind's proven rate ──
  // A kind with enough observations gets its EMPIRICAL rate as confidence (the honest,
  // learned-over-time number); a gated kind (< min_n) keeps its prior. Ranking is by
  // priority = severity × confidence, so kinds DUIN has learned to trust rise, and
  // kinds that keep not-materializing sink. This is the connections-adjust-over-time loop.
  const rates = loadKindRates(vaultDir)
  // Item 16: only let the empirical rate OVERWRITE the prior when calibration DEMONSTRABLY beats
  // the base rate (proper-score skillScore > 0). A thin/unskilled ledger keeps every prior —
  // honest-by-construction, matching the Wilson/min_n discipline.
  const skill = scoreResolvedLedger(vaultDir).skillScore
  const calTrusted = skill != null && skill > 0
  // Item 17 (now APPLIED): fit a leakage-safe leave-one-out Platt recalibration on the resolved
  // ledger and APPLY it to production confidence — the corrective half of the loop, previously
  // computed + surfaced but never consumed. `fitRecalibration` is `applied` ONLY when skill > 0
  // AND n ≥ min_n, so a thin/degenerate/inflated ledger (skill ≤ 0) is a strict no-op: the
  // corrector can never amplify a bad resolution signal (the honesty-by-construction discipline).
  const recal = fitRecalibration(loadScoredForecasts(vaultDir), skill)
  for (const f of out) {
    const kr = rates.get(f.kind)
    f.baseConfidence = f.confidence
    // ONE calibration per forecast (never double-corrected): a trusted, non-gated kind uses its
    // observed frequency (that empirical rate IS the calibration); otherwise the stated prior is
    // corrected by the fitted Platt recalibration — the previously-inert "corrective half", now
    // applied where it is the right correction. Both branches are strictly skill-gated.
    const usedEmpirical = calTrusted && !!kr && !kr.gated && kr.rate != null
    if (usedEmpirical) f.confidence = kr!.rate as number
    else if (recal.applied && recal.params) f.confidence = recalibrate(f.baseConfidence, recal.params)
    f.calibration = kr
      ? { rate: kr.rate, observed: kr.observed, gated: kr.gated, skill, recalibrated: recal.applied && !usedEmpirical }
      : { rate: null, observed: 0, gated: true, skill, recalibrated: recal.applied }
  }
  return out.sort((a, b) => b.severity * b.confidence - a.severity * a.confidence)
}
