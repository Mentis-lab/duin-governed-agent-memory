// Factorized multi-hop retrieval self-eval bench (L6).
//
// Drives the REAL retrieveContext() loop over a small, self-contained fixture with
// a scripted graph-aware planner (opts.runTurnFn) — no live model, no download —
// and reports the THREE factors SEPARATELY, never blended:
//   (1) supporting-fact recall@k   (did retrieval surface the gold notes/sentences)
//   (2) answer EM / F1             (via an injected mock reader)
//   (3) ALCE citation recall/precision (via an injected mock support scorer)
// plus the FRAMES-style turn ablation (sp-recall must climb, or at least not fall,
// as maxTurns rises — a plateau flags "the loop isn't recovering bridge facts").
//
// The mock support scorer and mock reader mean NO NLI model / answer model is
// needed to pass. The full MuSiQue / 2WikiMultiHopQA run is an ATTENDED step,
// guarded by it.runIf(existsSync(...)) exactly like the sample-vault bench.
//
// Run:  npx vitest run electron/services/brain/_eval/multihop.bench.test.ts
//       add --disableConsoleIntercept to see the printed factor table.

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import {
  SYNTHETIC_INSTANCES,
  loadMuSiQue,
  load2Wiki,
  type MultiHopInstance
} from './fixtures'
import { runInstance, mockReaderFor, tokenSubsetScorer, type FactorScores } from './harness'

const HERE = dirname(fileURLToPath(import.meta.url))
const MUSIQUE_MINI = join(HERE, 'datasets', 'musique-mini.jsonl')
const TWOWIKI_MINI = join(HERE, 'datasets', '2wiki-mini.jsonl')

// The offline corpus the suite always runs on: hand-authored synthetic instances
// PLUS the mini datasets exercised THROUGH the real MuSiQue / 2Wiki converters.
const OFFLINE: MultiHopInstance[] = [
  ...SYNTHETIC_INSTANCES,
  ...loadMuSiQue(MUSIQUE_MINI),
  ...load2Wiki(TWOWIKI_MINI)
]

function printTable(rows: FactorScores[]): void {
  /* eslint-disable no-console */
  console.log('\n=== Factorized multi-hop retrieval eval (offline fixture) ===\n')
  console.log(
    'instance'.padEnd(24),
    'sp@gold'.padEnd(9),
    'sent'.padEnd(6),
    'EM'.padEnd(4),
    'F1'.padEnd(6),
    'cite-R'.padEnd(8),
    'cite-P'
  )
  for (const r of rows) {
    console.log(
      r.id.slice(0, 23).padEnd(24),
      `${(r.supportNoteRecall.atGold * 100).toFixed(0)}%`.padEnd(9),
      `${(r.supportSentenceRecall * 100).toFixed(0)}%`.padEnd(6),
      r.answerEM.toFixed(0).padEnd(4),
      r.answerF1.toFixed(2).padEnd(6),
      r.citationRecall.toFixed(2).padEnd(8),
      r.citationPrecision.toFixed(2)
    )
  }
  const mean = (f: (r: FactorScores) => number): number => rows.reduce((s, r) => s + f(r), 0) / rows.length
  console.log(
    `\nmeans — sp@gold ${(mean((r) => r.supportNoteRecall.atGold) * 100).toFixed(0)}%  ` +
      `sent ${(mean((r) => r.supportSentenceRecall) * 100).toFixed(0)}%  ` +
      `EM ${mean((r) => r.answerEM).toFixed(2)}  F1 ${mean((r) => r.answerF1).toFixed(2)}  ` +
      `cite-R ${mean((r) => r.citationRecall).toFixed(2)}  cite-P ${mean((r) => r.citationPrecision).toFixed(2)}\n`
  )
  /* eslint-enable no-console */
}

describe('multi-hop retrieval — factorized offline bench', () => {
  it('reports the three factors per instance and asserts each factor holds', async () => {
    const reader = (inst: MultiHopInstance): ReturnType<typeof mockReaderFor> => mockReaderFor(inst)
    const rows: FactorScores[] = []
    for (const inst of OFFLINE) {
      rows.push(await runInstance(inst, { reader: reader(inst), scorer: tokenSubsetScorer, maxTurns: 4 }))
    }
    printTable(rows)

    for (const r of rows) {
      // factor 1: the scripted multi-hop planner surfaces EVERY gold support note.
      expect.soft(r.supportNoteRecall.atGold, `${r.id} sp-recall@gold`).toBe(1)
      // sentence-level recall (2Wiki-style gold); MuSiQue has none → trivially 1.
      expect.soft(r.supportSentenceRecall, `${r.id} sentence recall`).toBe(1)
      // factor 2: the mock reader answers once all gold is surfaced → EM/F1 = 1.
      expect.soft(r.answerEM, `${r.id} EM`).toBe(1)
      expect.soft(r.answerF1, `${r.id} F1`).toBe(1)
      // factor 3 (ALCE): the union of citations entails the answer (recall 1), but
      // only the answer-BEARING note supports it — the bridge note is a redundant
      // citation for the answer claim → precision 0.5. This is the id-existence ≠
      // support gap made measurable.
      expect.soft(r.citationRecall, `${r.id} citation recall`).toBe(1)
      expect.soft(r.citationPrecision, `${r.id} citation precision`).toBe(0.5)
    }

    // No distractor leaks into the citations (clean-precision sanity on factor 1).
    const beacon = rows.find((r) => r.id === 'syn-bridge-beacon')!
    expect(beacon.citedNotes).not.toContain('p2-atlas.md')
    const atlas = rows.find((r) => r.id === 'syn-bridge-atlas')!
    expect(atlas.citedNotes).not.toContain('p0-beacon.md')
  })

  it('turn ablation: sp-recall@k climbs (does not fall) with maxTurns; bridge fact needs the later hop', async () => {
    const bridge = SYNTHETIC_INSTANCES.find((i) => i.id === 'syn-bridge-beacon')!
    const at = async (maxTurns: number): Promise<number> =>
      (await runInstance(bridge, { maxTurns })).supportNoteRecall.atGold

    const r1 = await at(1)
    const r2 = await at(2)
    const r4 = await at(4)

    /* eslint-disable no-console */
    console.log(`\n[ablation] syn-bridge-beacon sp-recall@gold — 1 turn: ${r1}  2 turns: ${r2}  4 turns: ${r4}`)
    if (r4 === r2 && r2 < 1) console.log('[ablation] WARNING: turn-2 plateau below 1 — loop is not recovering bridge facts')
    /* eslint-enable no-console */

    // Monotonic non-decreasing, and the multi-hop path must strictly beat 1 turn.
    expect(r2).toBeGreaterThanOrEqual(r1)
    expect(r4).toBeGreaterThanOrEqual(r2)
    expect(r4).toBeGreaterThan(r1)
    expect(r4).toBe(1) // all bridge facts recovered by turn 4
  })

  // ── ATTENDED full run (skipped offline): point these env vars at real dumps ──
  const FULL_MUSIQUE = process.env.MUSIQUE_JSONL ?? ''
  const FULL_2WIKI = process.env.TWOWIKI_JSONL ?? ''
  const fullMusique = FULL_MUSIQUE ? loadMuSiQue(FULL_MUSIQUE, 50) : []
  const full2Wiki = FULL_2WIKI ? load2Wiki(FULL_2WIKI, 50) : []
  const full = [...fullMusique, ...full2Wiki]

  it.runIf(full.length)('attended: scores a slice of the real MuSiQue/2Wiki dumps', async () => {
    const rows: FactorScores[] = []
    for (const inst of full) {
      rows.push(await runInstance(inst, { reader: mockReaderFor(inst), scorer: tokenSubsetScorer, maxTurns: 4 }))
    }
    printTable(rows)
    // Informational on real data — assert only that the harness ran end-to-end.
    expect(rows.length).toBe(full.length)
  })
})
