#!/usr/bin/env node
// DUIN World-Model Benchmark Loop — Stage 0 harness (run all axes, emit one baseline).
//
// This is the yardstick the build spec says to build FIRST: "you cannot claim a conversion without
// the number." It runs every offline-computable axis over the live ledgers and prints one baseline
// table, so a later stage can re-run it and show movement.
//
// Read-only and offline: it reads vault JSONL/markdown and does pure math. ZERO app imports, ZERO
// enactment, no live-app dependency, no network. Safe to run against a running instance.
//
// Coverage is deliberately explicit. Two axes CANNOT be baselined offline and are reported as
// `not-measurable-offline` with the reason and what unlocks them, rather than as a zero — a zero
// would imply the capability was measured and scored badly.
//
// Usage:
//   node run-bench.mjs [--vault <vaultDir>] [--out baseline.json] [--json]

import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLedger, properSet, signalSet, properScore, efficacyScore } from './lib/ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// The vault under measurement. Point DUIN_BENCH_VAULT at a real or synthetic vault; the
// fallback is a `sample-vault/` folder next to this script (not shipped — build your own).
const DEFAULT_VAULT = process.env.DUIN_BENCH_VAULT ?? join(HERE, 'sample-vault')

const runJson = (script, args) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(HERE, script), ...args, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  } catch (e) {
    return { error: e?.message ?? String(e) }
  }
}

function main() {
  const args = process.argv.slice(2)
  const vault = args.includes('--vault') ? args[args.indexOf('--vault') + 1] : DEFAULT_VAULT
  const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
  const asJson = args.includes('--json')

  const ledger = join(vault, '.duin', '_state', 'risk-predictions.jsonl')
  const decisions = join(vault, 'DUIN', 'Decisions')
  if (!existsSync(ledger)) {
    console.error(`ledger not found: ${ledger}`)
    process.exit(2)
  }

  const { rows, malformed } = loadLedger(ledger)
  const proper = properSet(rows)
  const signal = signalSet(rows)
  const properStats = properScore(proper)
  const signalStats = efficacyScore(signal)

  const axis3 = runJson('score-foresight.mjs', [ledger, decisions])
  const axis4b = runJson('score-trend.mjs', [ledger])

  const baseline = {
    generated: new Date().toISOString(),
    vault,
    ledger,
    ledgerRows: rows.length,
    malformedRows: malformed,

    axis1_state: {
      status: 'not-measurable-offline',
      reason:
        'LoCoMo-J-vault needs a gold Q/A set built from the vault edit timeline plus an LLM judge; neither is a pure-replay artifact.',
      unlockedBy: 'Stage 0 extension — build the gold set; Stage 1 adds the multi-hop as-of traversal API it queries',
      specBaselineEstimate: 'macro-J ~38-42 (estimated in the build spec, NOT measured here)'
    },

    axis2a_transition_outcome: {
      status: 'measured',
      note: 'App-parity population: signal-mode kinds excluded from proper scoring (see lib/ledger.mjs).',
      ...properStats
    },

    axis2b_transition_delta: {
      status: 'measured-in-app',
      reason:
        'BUILT (Stage 2): predictDelta replays runVerdicts as a counterfactual and diffs against what the metabolism actually retired. It stays out of this offline harness because runVerdicts is TypeScript — this .mjs imports nothing from the app by design.',
      readFrom: 'GET /state/transition-score  (micro + macro F1; ?decisionId= for one)'
    },

    axis3_foresight: axis3,

    axis4a_calibration_quality: {
      status: 'measured',
      ece: properStats.ece,
      brier: properStats.brier,
      baselineBrier: properStats.baselineBrier,
      skillScore: properStats.skillScore,
      skillGated: properStats.gated,
      distinctConfidences: properStats.distinctConfidences,
      honestNullDiscipline: properStats.gated
        ? 'PASS — skill withheld below minN rather than estimated'
        : 'n/a — sample is above minN',
      probabilityCalibrated:
        properStats.distinctConfidences != null && properStats.distinctConfidences <= 3
          ? 'NO — too few distinct confidence levels to be probability-calibrated'
          : 'see ECE'
    },

    axis4b_improvement_slope: axis4b,

    signalModeEfficacy: {
      note:
        'Reported SEPARATELY and never folded into the Brier above. This is the population behind the widely-quoted usefulRate; the code itself calls these "a deadline reminder, not a forecast".',
      ...signalStats
    }
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify(baseline, null, 2))
    console.error(`baseline written: ${outPath}`)
  }
  if (asJson) {
    console.log(JSON.stringify(baseline, null, 2))
    return
  }

  const a2 = baseline.axis2a_transition_outcome
  const a3 = baseline.axis3_foresight
  const a4b = baseline.axis4b_improvement_slope
  const yn = (v) => (v == null ? 'n/a' : v)
  console.log(`\n${'='.repeat(78)}`)
  console.log(`DUIN WORLD-MODEL BENCHMARK — Stage 0 baseline`)
  console.log(`${'='.repeat(78)}`)
  console.log(`vault  : ${vault}`)
  console.log(`ledger : ${rows.length} rows (${malformed} malformed)`)
  console.log(`\nAXIS 1 · State                  NOT MEASURABLE OFFLINE`)
  console.log(`   ${baseline.axis1_state.reason}`)
  console.log(`\nAXIS 2A · Transition (outcome)  MEASURED   n=${a2.n}`)
  console.log(`   Brier ${yn(a2.brier)}  vs base-rate ${yn(a2.baselineBrier)}  skill ${a2.gated ? 'GATED (n<minN)' : yn(a2.skillScore)}`)
  console.log(`   ECE ${yn(a2.ece)}   distinct confidence levels: ${yn(a2.distinctConfidences)}`)
  if (a2.skillUngated != null) console.log(`   (ungated skill would be ${a2.skillUngated} — reported only as a diagnostic)`)
  console.log(`\nAXIS 2B · Transition (delta)    BUILT — read via /state/transition-score`)
  console.log(`   ${baseline.axis2b_transition_delta.reason}`)
  console.log(`\nAXIS 3 · Foresight`)
  console.log(`   M1 ranking-agreement : AWAITING DATA (rankOptions exists; no logged rollout)`)
  console.log(`   M2 utility-lift      : AWAITING DATA (foresight arm exists; no logged rollout)`)
  console.log(`   M3 pre-commit catch  : ${yn(a3?.M3_preCommitCatchRate?.value)}  (one-way: ${yn(a3?.M3_preCommitCatchRate?.oneWayValue)})`)
  console.log(`\nAXIS 4A · Calibration quality   MEASURED`)
  console.log(`   ECE ${yn(baseline.axis4a_calibration_quality.ece)}  ·  ${baseline.axis4a_calibration_quality.honestNullDiscipline}`)
  console.log(`   probability-calibrated: ${baseline.axis4a_calibration_quality.probabilityCalibrated}`)
  console.log(`\nAXIS 4B · Improvement slope`)
  console.log(`   proper : ${a4b?.proper?.gated ? `GATED (${a4b.proper.gatedReason})` : yn(a4b?.proper?.slope)}`)
  console.log(`   signal : ${yn(a4b?.signal?.slope)} weighted  (improving: ${yn(a4b?.signal?.improving)})`)
  console.log(`\nSIGNAL-MODE EFFICACY (kept separate)  n=${baseline.signalModeEfficacy.n}  rate=${yn(baseline.signalModeEfficacy.rate)} (wilson_lo ${yn(baseline.signalModeEfficacy.wilsonLo)})`)
  console.log(`${'='.repeat(78)}\n`)
}

main()
