// scorecard.mjs — PURE lane aggregation and the Markdown summary.
//
// A probe result: { id, lane, pass: true|false|null, evidence, ms, unverified?, skipped? }.
//   · skipped     — could not run here (no engine key, feature absent); excluded from the total.
//   · unverified  — the contract it measures has not landed yet (lanes A/C); the observed value is
//                   recorded but excluded from the score, and counted under `unverified`.
// Lane score = 10 × passed / total over the remaining probes, rounded to 0.1; null when none ran.

export const LANES = {
  L1: 'brain',
  L2: 'memory',
  L3: 'agentic',
  L4: 'governance',
  L5: 'renderer',
  L6: 'engines',
  L7: 'background'
}

export function aggregateLanes(probes) {
  const lanes = {}
  for (const id of Object.keys(LANES)) lanes[id] = { name: LANES[id], score: null, passed: 0, total: 0, unverified: 0, skipped: 0, failed: [] }
  for (const p of probes) {
    const lane = lanes[p.lane]
    if (!lane) continue
    if (p.skipped) {
      lane.skipped += 1
      continue
    }
    if (p.unverified) {
      lane.unverified += 1
      continue
    }
    if (typeof p.pass !== 'boolean') {
      lane.skipped += 1
      continue
    }
    lane.total += 1
    if (p.pass) lane.passed += 1
    else lane.failed.push(p.id)
  }
  for (const lane of Object.values(lanes)) lane.score = lane.total ? Math.round((lane.passed / lane.total) * 100) / 10 : null
  return lanes
}

export function lanesBelow(lanes, threshold) {
  return Object.entries(lanes)
    .filter(([, l]) => l.score !== null && l.score < threshold)
    .map(([id]) => id)
}

const fmtEvidence = (e) => {
  const s = typeof e === 'string' ? e : JSON.stringify(e)
  return (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 220)
}

export function renderSummary(card) {
  const lines = []
  lines.push(`# live-eval scorecard — ${card.at}`)
  lines.push('')
  lines.push(`build \`${card.build}\` · exe \`${card.exe}\` · engines: ${card.engines.length ? card.engines.join(', ') : 'none (keyless run)'} · threshold ${card.threshold}`)
  lines.push(`bench exemption (x-duin-bench): ${card.bench.exemption}`)
  lines.push('')
  lines.push('| Lane | Score | Passed | Unverified | Skipped | Failed |')
  lines.push('|---|---|---|---|---|---|')
  for (const [id, l] of Object.entries(card.lanes)) {
    lines.push(`| ${id} ${l.name} | ${l.score === null ? '—' : l.score.toFixed(1)} | ${l.passed}/${l.total} | ${l.unverified} | ${l.skipped} | ${l.failed.join(', ')} |`)
  }
  lines.push('')
  lines.push(card.lanesBelow.length ? `**Below threshold:** ${card.lanesBelow.join(', ')}` : '**All measured lanes at or above threshold.**')
  lines.push('')
  lines.push('| Probe | Lane | Result | ms | Evidence |')
  lines.push('|---|---|---|---|---|')
  for (const p of card.probes) {
    const res = p.skipped ? 'skipped' : p.unverified ? `unverified (observed ${p.pass === null ? '—' : p.pass ? 'pass' : 'fail'})` : p.pass ? 'pass' : 'FAIL'
    lines.push(`| ${p.id} | ${p.lane} | ${res} | ${p.ms ?? ''} | ${fmtEvidence(p.evidence)} |`)
  }
  lines.push('')
  return lines.join('\n')
}
