#!/usr/bin/env node
// DUIN World-Model Benchmark Loop — Axis 4 (Self-correction · Metric b: improvement-over-time slope)
//
// The question this answers: as the loop runs, does DUIN's prediction error actually trend DOWN?
// That is the difference between a system that measures its error and one that LEARNS from it.
//
// Method: replay the resolved ledger in resolution-date order, bucket into periods, and fit an OLS
// slope over per-period error. Two populations are tracked SEPARATELY and never mixed (see
// lib/ledger.mjs for why):
//   * proper  — probabilistic forecasts, slope of Brier over time. IMPROVING = negative.
//   * signal  — decision-window efficacy, slope of on-time rate over time. IMPROVING = positive.
//
// Honest-null discipline: a slope needs >= 3 populated periods AND >= minN scored rows; below that
// the slope is withheld, not estimated. `self-improve-bench` reports slope 0 today; this scorer
// exists to say whether that 0 is a real flat trend or a structural artifact of a thin ledger.
//
// Usage: node score-trend.mjs <ledger.jsonl> [--period week|month] [--min-n 20] [--json]

import { loadLedger, properSet, signalSet, properScore, efficacyScore, olsSlope, round, byDate } from './lib/ledger.mjs'

function periodKey(iso, mode) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  if (mode === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  // ISO-ish week bucket: year + zero-padded week index from Jan 1.
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.floor((d.getTime() - start) / (7 * 86400_000))
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function bucket(rows, mode) {
  const m = new Map()
  for (const r of [...rows].sort(byDate)) {
    const k = periodKey(r.at, mode)
    if (!k) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function trend(rows, mode, kindLabel, minN) {
  const periods = bucket(rows, mode)
  const series = periods.map(([key, rs], i) => {
    const isProper = kindLabel === 'proper'
    const s = isProper ? properScore(rs, { minN }) : efficacyScore(rs)
    return { x: i, key, n: rs.length, value: isProper ? s.brier : s.rate }
  })
  const usable = series.filter((p) => p.value != null && p.n > 0)
  // Sample-weighted is the headline; unweighted is kept visible so a thin period that swings the
  // naive fit cannot hide behind a single number.
  const slope = usable.length >= 3 ? olsSlope(usable.map((p) => ({ x: p.x, y: p.value, w: p.n }))) : null
  const slopeUnweighted = usable.length >= 3 ? olsSlope(usable.map((p) => ({ x: p.x, y: p.value }))) : null
  const total = rows.length
  const gated = total < minN || usable.length < 3
  return {
    population: kindLabel,
    metric: kindLabel === 'proper' ? 'brier (lower is better)' : 'efficacy rate (higher is better)',
    improvingDirection: kindLabel === 'proper' ? 'negative slope' : 'positive slope',
    totalScored: total,
    periods: usable.length,
    // The claim is withheld, not guessed, when the sample cannot support it.
    slope: gated ? null : round(slope, 5),
    slopeUngated: round(slope, 5),
    slopeUnweighted: round(slopeUnweighted, 5),
    // A sign disagreement between the weighted and unweighted fits means the trend is being
    // carried by low-n periods — treat the slope as unreliable regardless of the gate.
    weightingDisagrees: slope != null && slopeUnweighted != null ? Math.sign(slope) !== Math.sign(slopeUnweighted) : null,
    gated,
    gatedReason: gated ? (total < minN ? `n=${total} < minN=${minN}` : `only ${usable.length} populated period(s), need >= 3`) : null,
    improving: gated || slope == null ? null : kindLabel === 'proper' ? slope < 0 : slope > 0,
    series: usable.map((p) => ({ period: p.key, n: p.n, value: round(p.value) }))
  }
}

function main() {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  const mode = args.includes('--period') ? args[args.indexOf('--period') + 1] : 'week'
  const minN = parseInt(args[args.indexOf('--min-n') + 1]) || 20
  const asJson = args.includes('--json')
  if (!path) {
    console.error('usage: node score-trend.mjs <ledger.jsonl> [--period week|month] [--min-n N] [--json]')
    process.exit(2)
  }

  const { rows, malformed } = loadLedger(path)
  const report = {
    axis: '4b · self-correction · improvement-over-time slope',
    ledger: path,
    period: mode,
    rowsRead: rows.length,
    malformed,
    proper: trend(properSet(rows), mode, 'proper', minN),
    signal: trend(signalSet(rows), mode, 'signal', minN)
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(`\nDUIN world-model benchmark — Axis 4b (improvement slope)`)
  console.log(`ledger: ${path}  ·  ${rows.length} rows  ·  period=${mode}\n`)
  for (const p of [report.proper, report.signal]) {
    console.log(`${p.population.toUpperCase().padEnd(7)} ${p.metric}`)
    console.log(`  scored=${p.totalScored}  periods=${p.periods}  slope=${p.slope ?? 'GATED'} (weighted)  unweighted=${p.slopeUnweighted ?? 'n/a'}${p.gated ? `  (${p.gatedReason})` : ''}`)
    if (!p.gated && p.improving != null) console.log(`  improving: ${p.improving ? 'YES' : 'NO'} (want ${p.improvingDirection})`)
    if (p.weightingDisagrees) console.log(`  ⚠ weighted and unweighted fits disagree in SIGN — trend carried by low-n periods, do not rely on it`)
    if (p.series.length) console.log(`  series: ${p.series.map((s) => `${s.period}:${s.value}(n${s.n})`).join('  ')}`)
    console.log('')
  }
}

main()
