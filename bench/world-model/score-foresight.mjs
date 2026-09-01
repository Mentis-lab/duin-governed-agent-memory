#!/usr/bin/env node
// DUIN World-Model Benchmark Loop — Axis 3 (Foresight)
//
// Baselines the three foresight metrics from the build spec:
//   M1  policy-ranking agreement   — does foresight's #1 option beat a naive pick?
//   M2  downstream-utility lift    — do foresight-ranked decisions resolve better?
//   M3  pre-commit catch-rate      — did a forward signal fire BEFORE the decision was committed?
//
// M1 and M2 are AWAITING DATA, not unmeasurable. Stage 3 landed rankOptions, so a ranking surface
// and a foresight arm now exist -- what is missing is a persisted ranked rollout to score over.
// Reporting 0 would imply we ranked and scored badly; `awaiting-data` with a reason is the honest
// baseline. Read the in-app equivalent at GET /state/decision-utility.
//
// M3 IS measurable from the ledgers, with one correction that matters: the decision corpus predates
// the prediction ledger, so decisions dated before the ledger's first entry could never have been
// caught. Scoring those as misses would manufacture a low baseline. They are excluded and counted.
//
// Join: prediction.track <-> decision frontmatter tags (both carry the workstream), plus
// created < decision date. Coarse by construction — reported as coverage, not as semantic recall.
//
// Usage: node score-foresight.mjs <ledger.jsonl> <decisionsDir> [--json]

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadLedger, round } from './lib/ledger.mjs'

const FM = (txt, key) => {
  const m = txt.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function loadDecisions(dir) {
  const out = []
  const files = readdirSync(dir).filter((n) => n.endsWith('.md'))
  for (const f of files) {
    let txt
    try {
      txt = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    const head = txt.slice(0, 1200)
    const tagsRaw = head.match(/^tags:\s*\[(.*?)\]/m)
    out.push({
      file: f,
      date: FM(head, 'date'),
      status: FM(head, 'status'),
      reversibility: FM(head, 'reversibility'),
      domain: FM(head, 'domain'),
      tags: tagsRaw ? tagsRaw[1].split(',').map((t) => t.trim()).filter(Boolean) : []
    })
  }
  // A decision with no parseable `date` cannot be placed relative to the ledger window, so it is
  // dropped — but the count is surfaced rather than silently shrinking the denominator.
  return { decisions: out.filter((d) => d.date), filesScanned: files.length }
}

/** Does any prediction created strictly before the decision share its workstream? */
function caughtBy(decision, preds) {
  const tags = new Set(decision.tags.map((t) => t.toLowerCase()))
  return preds.filter((p) => {
    if (!p.created || p.created >= decision.date) return false
    const track = String(p.track ?? '').toLowerCase()
    return track && tags.has(track)
  })
}

function main() {
  const args = process.argv.slice(2)
  const positional = args.filter((a) => !a.startsWith('--'))
  const [ledgerPath, decisionsDir] = positional
  const asJson = args.includes('--json')
  if (!ledgerPath || !decisionsDir) {
    console.error('usage: node score-foresight.mjs <ledger.jsonl> <decisionsDir> [--json]')
    process.exit(2)
  }

  const { rows } = loadLedger(ledgerPath)
  const { decisions, filesScanned } = loadDecisions(decisionsDir)

  // Evidence for the awaiting-data verdict: no ranked rollout is persisted in the ledger yet.
  const RANK_FIELDS = ['ranking', 'rankedOptions', 'options', 'recommendation', 'chosen', 'alternatives']
  const rankingRows = rows.filter((r) => RANK_FIELDS.some((k) => r[k] !== undefined)).length

  const ledgerStart = rows.map((r) => r.created).filter(Boolean).sort()[0] ?? null
  const inWindow = decisions.filter((d) => ledgerStart && d.date >= ledgerStart)
  const outOfWindow = decisions.length - inWindow.length

  const scored = inWindow.map((d) => {
    const hits = caughtBy(d, rows)
    return { file: d.file, date: d.date, reversibility: d.reversibility, caught: hits.length > 0, priorSignals: hits.length }
  })
  const oneWay = scored.filter((s) => s.reversibility && s.reversibility !== 'reversible')
  const rate = (set) => (set.length ? round(set.filter((s) => s.caught).length / set.length) : null)

  const report = {
    axis: '3 · foresight',
    ledger: ledgerPath,
    decisionsDir,
    // Stage 3 landed rankOptions, so these are no longer blocked on CODE — they are blocked on
    // DATA. Nothing persists a ranked rollout yet, so there is still nothing to score over.
    // Reported as awaiting-data rather than 0: a 0 would claim we ranked and scored badly.
    M1_policyRankingAgreement: {
      value: null,
      status: 'awaiting-data',
      reason: `rankOptions exists (Stage 3) but no ranked rollout has been persisted; ${rankingRows} ledger rows carry any of [${RANK_FIELDS.join(', ')}]`,
      readFrom: 'GET /state/decision-utility'
    },
    M2_downstreamUtilityLift: {
      value: null,
      status: 'awaiting-data',
      reason: 'a foresight arm now exists (rankOptions); scoring lift needs logged rollouts on resolved decisions',
      readFrom: 'GET /state/decision-utility'
    },
    M3_preCommitCatchRate: {
      value: rate(scored),
      oneWayValue: rate(oneWay),
      status: scored.length ? 'measured' : 'no-eligible-decisions',
      decisionFilesScanned: filesScanned,
      decisionsWithParseableDate: decisions.length,
      decisionsDroppedNoDate: filesScanned - decisions.length,
      decisionsTotal: decisions.length,
      decisionsInWindow: scored.length,
      decisionsExcludedPreLedger: outOfWindow,
      ledgerStart,
      oneWayInWindow: oneWay.length,
      join: 'prediction.track == decision tag AND prediction.created < decision.date',
      caveat:
        'workstream-level coverage, not semantic recall: it shows a forward signal was active in the same workstream before the commit, not that it named this decision.',
      detail: scored
    }
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const m3 = report.M3_preCommitCatchRate
  console.log(`\nDUIN world-model benchmark — Axis 3 (foresight)`)
  console.log(`ledger: ${ledgerPath}\ndecisions: ${decisionsDir}\n`)
  console.log(`M1 policy-ranking agreement : AWAITING DATA`)
  console.log(`   ${report.M1_policyRankingAgreement.reason}`)
  console.log(`M2 downstream-utility lift  : AWAITING DATA`)
  console.log(`   ${report.M2_downstreamUtilityLift.reason}`)
  console.log(`M3 pre-commit catch-rate    : ${m3.value ?? 'n/a'}  (one-way only: ${m3.oneWayValue ?? 'n/a'}, n=${m3.oneWayInWindow})`)
  console.log(`   ${m3.decisionsInWindow}/${m3.decisionsTotal} decisions in ledger window (start ${m3.ledgerStart}); ${m3.decisionsExcludedPreLedger} excluded as pre-ledger`)
  console.log(`   corpus: ${m3.decisionFilesScanned} files scanned, ${m3.decisionsDroppedNoDate} dropped for no parseable date`)
  console.log(`   caveat: ${m3.caveat}\n`)
}

main()
