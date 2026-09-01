// Reference retrieval baselines on the HELD-OUT TEST split, using the repo's OWN
// bm25Rank + supportingFactRecallAtK so the numbers are comparable to production.
//   Arm A: BM25 top-K (recall@gold, full-support).
//   Ceiling: BM25 top-3 seeds + ONE hop over the cached text-derived entity graph.
//
// This is a MEASUREMENT, not a regression test: it asserts nothing, it prints a report,
// and it needs a multi-GB MuSiQue / 2Wiki corpus that is not in the repo. It shipped as
// `_mlbaseline.test.ts` with its corpus path hardcoded to one session's scratchpad, which
// put a machine-dependent file in the default suite -- green on the author's box, red
// everywhere else, and red on the author's box too the moment %TEMP% was cleaned.
//
// So it lives under vitest.eval.config.ts (`*.eval.ts`) alongside the other measurement
// arms, and takes its corpus from an env var:
//
//   DUIN_ML_EVAL_DATA=/path/to/data npx vitest run --config vitest.eval.config.ts \
//     electron/services/brain/_eval/mlbaseline.eval.ts
//
// The directory must hold ml_test.jsonl and graphs/ (both produced by mlgen.eval.ts).
// Unset or absent, the suite skips -- it is out of the regression suite entirely, so this
// skip cannot mask a regression.
import { describe, it } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { bm25Rank, type WNNote } from '../wholenote-ground'
import { supportingFactRecallAtK } from './metrics'

const DATA = process.env.DUIN_ML_EVAL_DATA ?? ''
const HAS_DATA = DATA !== '' && existsSync(`${DATA}/ml_test.jsonl`)
const GRAPHS = `${DATA}/graphs`

interface Inst {
  id: string
  question: string
  goldNotes: string[]
  corpus: { file: string; text: string }[]
  _stratum: string
  _dataset: string
}
interface Graph {
  nodes: { note: string; entities: string[] }[]
  entityIndex: Record<string, string[]>
}

const norm = (e: string): string => e.toLowerCase().replace(/\s+/g, ' ').trim()

function readJsonl<T>(p: string): T[] {
  return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as T)
}

function loadGraph(id: string): Graph | null {
  const p = `${GRAPHS}/${id.replace(/\//g, '_')}.json`
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as Graph) : null
}

/** Full-support indicator: every gold note present in the retrieved set. */
function fullSupport(retrieved: string[], gold: string[]): number {
  if (gold.length === 0) return 1
  const s = new Set(retrieved)
  return gold.every((g) => s.has(g)) ? 1 : 0
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

interface Row {
  recallAtGold: number
  recallAt10: number
  fullSupportAtGold: number
  fullSupportAt10: number
}

describe.skipIf(!HAS_DATA)('ml reference baselines (TEST split)', () => {
  it('bm25 arm + entity-graph 1-hop ceiling', () => {
    const test = readJsonl<Inst>(`${DATA}/ml_test.jsonl`)

    const strata = ['2hop', '3hop', '4hop', 'twowiki']
    const bm25: Record<string, Row[]> = {}
    const ceil: Record<string, { recallAtGold: number; fullSupport: number; setSize: number }[]> = {}
    for (const s of [...strata, 'ALL']) {
      bm25[s] = []
      ceil[s] = []
    }
    let missingGraphs = 0

    for (const inst of test) {
      const notes: WNNote[] = inst.corpus.map((c) => ({ id: c.file, text: c.text }))
      const gold = inst.goldNotes
      const kGold = Math.max(1, gold.length)

      // ── Arm A: BM25 ──
      const ranked = bm25Rank(inst.question, notes).map((r) => r.id)
      const row: Row = {
        recallAtGold: supportingFactRecallAtK(ranked, gold, kGold),
        recallAt10: supportingFactRecallAtK(ranked, gold, 10),
        fullSupportAtGold: fullSupport(ranked.slice(0, kGold), gold),
        fullSupportAt10: fullSupport(ranked.slice(0, 10), gold)
      }
      bm25[inst._stratum].push(row)
      bm25.ALL.push(row)

      // ── Ceiling: BM25 top-3 seeds + one hop over the cached entity graph ──
      const g = loadGraph(inst.id)
      if (!g) {
        missingGraphs++
      } else {
        const seeds = ranked.slice(0, 3)
        const entsBySeed = new Map(g.nodes.map((n) => [n.note, n.entities.map(norm)]))
        const set = new Set<string>(seeds)
        for (const seed of seeds) {
          for (const e of entsBySeed.get(seed) ?? []) {
            for (const nb of g.entityIndex[e] ?? []) set.add(nb)
          }
        }
        const retrieved = [...set]
        const crow = {
          recallAtGold: supportingFactRecallAtK(retrieved, gold, retrieved.length),
          fullSupport: fullSupport(retrieved, gold),
          setSize: retrieved.length
        }
        ceil[inst._stratum].push(crow)
        ceil.ALL.push(crow)
      }
    }

    const report: any = { n: test.length, missingGraphs, bm25: {}, ceiling: {} }
    for (const s of [...strata, 'ALL']) {
      if (bm25[s].length) {
        report.bm25[s] = {
          n: bm25[s].length,
          recallAtGold: +mean(bm25[s].map((r) => r.recallAtGold)).toFixed(4),
          recallAt10: +mean(bm25[s].map((r) => r.recallAt10)).toFixed(4),
          fullSupportAtGold: +mean(bm25[s].map((r) => r.fullSupportAtGold)).toFixed(4),
          fullSupportAt10: +mean(bm25[s].map((r) => r.fullSupportAt10)).toFixed(4)
        }
      }
      if (ceil[s].length) {
        report.ceiling[s] = {
          n: ceil[s].length,
          recallAtGold: +mean(ceil[s].map((r) => r.recallAtGold)).toFixed(4),
          fullSupport: +mean(ceil[s].map((r) => r.fullSupport)).toFixed(4),
          avgSetSize: +mean(ceil[s].map((r) => r.setSize)).toFixed(2)
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('ML_BASELINE ' + JSON.stringify(report))
  })
})
