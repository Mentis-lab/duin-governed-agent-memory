#!/usr/bin/env node
// DUIN World-Model Benchmark Loop — Axis 2 (Transition · Metric A) + Axis 4 (Self-correction · calibration quality)
//
// Self-contained offline scorer. Reads a resolved-forecast ledger (JSONL) and computes the calibration
// metrics the world-model benchmark loop gates on: Brier, base-rate Brier, Murphy skill, ECE, log-loss,
// a reliability curve, and Wilson lower bounds — overall and per domain. Pure math, ZERO app imports,
// ZERO enactment: it only reads and scores. Point it at the live risk-predictions.jsonl for the real
// baseline (see DUIN-WORLD-MODEL-BUILD-SPEC-2026-07-25.md).
//
// Usage:  node score-calibration.mjs <ledger.jsonl> [--bins 10] [--json]
//
// Row shape is tolerant. Predicted probability is read from the first present of:
//   prob | probability | confidence | p
// Binary outcome is read from the first present of: outcome | useful | correct | hit  (truthy => 1),
//   else derived from a resolution `status`/`resolution` field: POSITIVE statuses => 1.
// Domain/bucket is read from: domain | kind | track  (default "all").
// Rows without a usable (prob, outcome) pair are skipped and counted.

import { readFileSync } from 'node:fs'

const POSITIVE_STATUSES = new Set([
  'materialized', 'hit', 'useful', 'decided', 'decided-on-time', 'on-time', 'true', 'correct', 'confirmed'
])
const NEGATIVE_STATUSES = new Set([
  'averted', 'refuted', 'miss', 'slipped', 'false', 'wrong', 'false_alarm', 'false-alarm'
])
// 'unobserved' / 'moot' / 'open' are treated as unresolved -> skipped.

const first = (row, keys) => { for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k]; return undefined }

function toProb(v) {
  if (typeof v === 'number' && isFinite(v)) return v > 1 ? v / 100 : v
  if (typeof v === 'string') { const n = parseFloat(v); if (isFinite(n)) return n > 1 ? n / 100 : n }
  return undefined
}
const asStatus = (s) => { const k = String(s).toLowerCase(); if (POSITIVE_STATUSES.has(k)) return 1; if (NEGATIVE_STATUSES.has(k)) return 0; return undefined }
function toOutcome(row) {
  const direct = first(row, ['outcome', 'useful', 'correct', 'hit'])
  if (typeof direct === 'boolean') return direct ? 1 : 0
  if (typeof direct === 'number') return direct >= 1 ? 1 : 0
  if (typeof direct === 'string') { const b = asStatus(direct); if (b !== undefined) return b } // e.g. outcome:"slipped"
  // fall back to the risk resolution `verdict` (NOT `resolved`, which is a date). NOTE: exact per-kind
  // binary semantics should be reconciled with calibration-resolve-native.ts:106 in Stage 0 refinement.
  const verdict = first(row, ['verdict', 'status', 'resolution'])
  if (typeof verdict === 'string') { const b = asStatus(verdict); if (b !== undefined) return b }
  return undefined // unresolved (open / unobserved / moot) -> skipped
}

function wilsonLo(k, n, z = 1.96) {
  if (n === 0) return null
  const p = k / n, d = 1 + z * z / n
  const c = p + z * z / (2 * n), m = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return Math.max(0, (c - m) / d)
}

function scoreGroup(rows, bins) {
  const n = rows.length
  if (n === 0) return null
  const yBar = rows.reduce((s, r) => s + r.y, 0) / n
  const brier = rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / n
  const baselineBrier = yBar * (1 - yBar) // Brier of always predicting the base rate
  const skill = baselineBrier > 0 ? 1 - brier / baselineBrier : null
  const eps = 1e-12
  const logLoss = -rows.reduce((s, r) => {
    const p = Math.min(1 - eps, Math.max(eps, r.p))
    return s + (r.y * Math.log(p) + (1 - r.y) * Math.log(1 - p))
  }, 0) / n
  // ECE + reliability curve
  const bucket = Array.from({ length: bins }, () => ({ n: 0, sp: 0, sy: 0 }))
  for (const r of rows) { const i = Math.min(bins - 1, Math.floor(r.p * bins)); bucket[i].n++; bucket[i].sp += r.p; bucket[i].sy += r.y }
  let ece = 0
  const curve = bucket.map((b, i) => {
    if (b.n === 0) return { bin: `${(i / bins).toFixed(2)}-${((i + 1) / bins).toFixed(2)}`, n: 0, avgP: null, avgY: null }
    const avgP = b.sp / b.n, avgY = b.sy / b.n
    ece += (b.n / n) * Math.abs(avgP - avgY)
    return { bin: `${(i / bins).toFixed(2)}-${((i + 1) / bins).toFixed(2)}`, n: b.n, avgP: +avgP.toFixed(3), avgY: +avgY.toFixed(3) }
  })
  const round = (x) => (x == null ? null : +x.toFixed(4))
  return {
    n, positives: Math.round(yBar * n), usefulRate: round(yBar), wilsonLo: round(wilsonLo(yBar * n, n)),
    brier: round(brier), baselineBrier: round(baselineBrier), skillScore: round(skill),
    beatsBaseRate: skill != null ? skill > 0 : null, logLoss: round(logLoss), ece: round(ece),
    overconfident: curve.some((c) => c.n > 0 && c.avgP != null && c.avgP - c.avgY > 0.1),
    reliability: curve.filter((c) => c.n > 0)
  }
}

function main() {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  const bins = parseInt(args[args.indexOf('--bins') + 1]) || 10
  const asJson = args.includes('--json')
  if (!path) { console.error('usage: node score-calibration.mjs <ledger.jsonl> [--bins N] [--json]'); process.exit(2) }

  const raw = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  let parsed = 0, skipped = 0
  const rows = [], byDomain = new Map()
  for (const line of raw) {
    let o; try { o = JSON.parse(line) } catch { skipped++; continue }
    parsed++
    const p = toProb(first(o, ['prob', 'probability', 'confidence', 'p']))
    const y = toOutcome(o)
    if (p === undefined || y === undefined) { skipped++; continue }
    const domain = String(first(o, ['domain', 'kind', 'track']) ?? 'all')
    const row = { p, y, domain }
    rows.push(row)
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(row)
  }

  const report = {
    axis: 'transition(A)+self-correction(calibration)',
    ledger: path, rowsParsed: parsed, rowsScored: rows.length, rowsSkipped: skipped,
    overall: scoreGroup(rows, bins),
    perDomain: Object.fromEntries([...byDomain].sort((a, b) => b[1].length - a[1].length).map(([d, rs]) => [d, scoreGroup(rs, bins)]))
  }

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return }
  const o = report.overall
  console.log(`\nDUIN world-model benchmark — calibration scorer`)
  console.log(`ledger: ${path}`)
  console.log(`rows: ${report.rowsScored} scored / ${report.rowsSkipped} skipped (unresolved or unparseable)\n`)
  if (!o) { console.log('no scorable rows.'); return }
  const pct = (x) => (x == null ? 'n/a' : x)
  console.log(`OVERALL  n=${o.n}  usefulRate=${o.usefulRate} (wilson_lo ${o.wilsonLo})`)
  console.log(`  Brier ${o.brier}  vs base-rate ${o.baselineBrier}  → skill ${pct(o.skillScore)} ${o.beatsBaseRate === true ? '(beats base rate)' : o.beatsBaseRate === false ? '(WORSE than base rate)' : ''}`)
  console.log(`  ECE ${o.ece}  logLoss ${o.logLoss}  ${o.overconfident ? '⚠ overconfident' : ''}`)
  console.log(`  reliability: ${o.reliability.map((c) => `${c.bin}:p${c.avgP}/y${c.avgY}(${c.n})`).join('  ')}`)
  console.log(`\nPER DOMAIN`)
  for (const [d, s] of Object.entries(report.perDomain)) {
    if (!s) continue
    console.log(`  ${d.padEnd(18)} n=${String(s.n).padStart(4)}  useful=${s.usefulRate}  Brier=${s.brier}  skill=${pct(s.skillScore)}  ECE=${s.ece}`)
  }
  console.log('')
}
main()
