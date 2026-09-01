// Dataset preparation for the ml retrieval baselines: converts the raw sampled
// MuSiQue / 2Wiki lines via the repo's OWN converters, tags each with its stratum, and
// writes deterministic stratified TUNE/TEST splits.
//
// A GENERATOR, not a regression test -- it asserts nothing and WRITES to the corpus
// directory. It shipped as `_mlgen.test.ts` with that directory hardcoded to one
// session's scratchpad, which put a machine-dependent, filesystem-writing file in the
// default suite. Now it lives under vitest.eval.config.ts and takes the directory from
// an env var:
//
//   DUIN_ML_EVAL_DATA=/path/to/data npx vitest run --config vitest.eval.config.ts \
//     electron/services/brain/_eval/mlgen.eval.ts
//
// The directory must already hold ml_musique_sample.jsonl and ml_2wiki_sample.jsonl;
// it writes ml_tune.jsonl and ml_test.jsonl next to them. Unset or absent, it skips --
// a generator that silently writes to a guessed path is worse than one that does not run.
import { describe, it } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { musiqueToInstance, twoWikiToInstance, type MultiHopInstance } from './fixtures'

const DATA = process.env.DUIN_ML_EVAL_DATA ?? ''
const HAS_DATA = DATA !== '' && existsSync(`${DATA}/ml_musique_sample.jsonl`)

function readJsonl<T>(p: string): T[] {
  return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as T)
}

interface Tagged extends MultiHopInstance {
  _dataset: string
  _stratum: string
}

describe.skipIf(!HAS_DATA)('ml dataset generation', () => {
  it('convert + split', () => {
    const tagged: Tagged[] = []

    // MuSiQue — stratum = hop label from id prefix (2hop/3hop/4hop)
    for (const raw of readJsonl<any>(`${DATA}/ml_musique_sample.jsonl`)) {
      const inst = musiqueToInstance(raw)
      const hop = String(raw.id).split('hop')[0] + 'hop'
      tagged.push({ ...inst, _dataset: 'musique', _stratum: hop })
    }
    // 2Wiki — stratum = 'twowiki' (single bucket; secondary set)
    for (const raw of readJsonl<any>(`${DATA}/ml_2wiki_sample.jsonl`)) {
      const inst = twoWikiToInstance(raw)
      tagged.push({ ...inst, _dataset: 'twowiki', _stratum: 'twowiki' })
    }

    // Deterministic stratified split: within each stratum sort by id; every orbis → TUNE.
    const byStratum = new Map<string, Tagged[]>()
    for (const t of tagged) {
      const arr = byStratum.get(t._stratum) ?? []
      arr.push(t)
      byStratum.set(t._stratum, arr)
    }
    const tune: Tagged[] = []
    const test: Tagged[] = []
    for (const [, arr] of [...byStratum.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      arr.forEach((inst, i) => (i % 3 === 0 ? tune : test).push(inst))
    }

    mkdirSync(DATA, { recursive: true })
    const dump = (p: string, xs: Tagged[]): void =>
      writeFileSync(p, xs.map((x) => JSON.stringify(x)).join('\n') + '\n')
    dump(`${DATA}/ml_tune.jsonl`, tune)
    dump(`${DATA}/ml_test.jsonl`, test)

    // Report counts as a JSON blob to stdout for the harness to read.
    const bucket = (xs: Tagged[]): Record<string, number> => {
      const c: Record<string, number> = {}
      for (const x of xs) c[x._stratum] = (c[x._stratum] ?? 0) + 1
      return c
    }
    // eslint-disable-next-line no-console
    console.log('ML_SPLIT_COUNTS ' + JSON.stringify({
      total: tagged.length,
      tune: { n: tune.length, byStratum: bucket(tune) },
      test: { n: test.length, byStratum: bucket(test) }
    }))
  })
})
