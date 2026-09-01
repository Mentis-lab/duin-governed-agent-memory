import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadCascadePending,
  stageCascade,
  listCascadePending,
  buildJudgePrompt,
  proposeThenJudge
} from './cascade-native'

describe('cascade-native — pending store (PURE deterministic)', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-casc-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('stageCascade appends pending rows with the Python schema + returns count', () => {
    const n = stageCascade(vault, 'project-track', 'ProjX', [{ label: 'T1' }, { label: 'T2' }], {
      now: () => new Date(2026, 6, 3, 9, 0, 0),
      uid: (() => {
        let i = 0
        return () => `id${i++}`
      })()
    })
    expect(n).toBe(2)
    const rows = loadCascadePending(vault)
    expect(rows).toEqual([
      { id: 'id0', kind: 'project-track', source: 'ProjX', proposal: { label: 'T1' }, status: 'pending', created: '2026-07-03T09:00:00' },
      { id: 'id1', kind: 'project-track', source: 'ProjX', proposal: { label: 'T2' }, status: 'pending', created: '2026-07-03T09:00:00' }
    ])
  })

  it('stageCascade appends to (does not overwrite) existing pending', () => {
    stageCascade(vault, 'k', 's', [{ label: 'A' }], { uid: () => 'a' })
    stageCascade(vault, 'k', 's', [{ label: 'B' }], { uid: () => 'b' })
    expect(loadCascadePending(vault).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('listCascadePending returns only status:pending', () => {
    stageCascade(vault, 'k', 's', [{ label: 'A' }, { label: 'B' }], {
      uid: (() => {
        let i = 0
        return () => `id${i++}`
      })()
    })
    // mark one resolved by rewriting via the store roundtrip
    const rows = loadCascadePending(vault)
    rows[0].status = 'approved'
    const path = join(sd, 'cascade-pending.jsonl')
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    expect(listCascadePending(vault).pending.map((r) => r.id)).toEqual(['id1'])
  })

  it('load tolerates malformed lines', () => {
    const path = join(sd, 'cascade-pending.jsonl')
    writeFileSync(path, '{"id":"a","status":"pending"}\nGARBAGE\n{"id":"b","status":"pending"}\n')
    expect(loadCascadePending(vault).map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('cascade-native — proposeThenJudge (2-pass, injected model)', () => {
  const genArray = (arr: unknown): (() => Promise<string>) => async () => JSON.stringify(arr)

  it('keeps only judge-approved candidates aligned by index', async () => {
    const calls: string[] = []
    const generate = async (prompt: string): Promise<string> => {
      calls.push(prompt)
      if (calls.length === 1) {
        // generator pass → 3 named candidates
        return JSON.stringify([{ title: 'A', objective: 'oa' }, { title: 'B' }, { title: 'C' }])
      }
      // judge pass → keep idx 0 and 2
      return JSON.stringify([{ idx: 0, keep: true }, { idx: 1, keep: false }, { idx: 2, keep: true }])
    }
    const surv = await proposeThenJudge('gen prompt', 'MOVES for X', { generate })
    expect(surv.map((c) => c.title)).toEqual(['A', 'C'])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('ADVERSARIAL JUDGE')
  })

  it('drops unnamed candidates and caps at 6 before judging', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}` }))
    many.push({ title: '' } as never) // unnamed → dropped
    let judged: unknown[] = []
    const generate = async (prompt: string): Promise<string> => {
      if (prompt === 'g') return JSON.stringify(many)
      // judge sees at most 6 → keep all it sees (candidates follow the 'CANDIDATES:\n' marker)
      judged = JSON.parse(prompt.slice(prompt.indexOf('CANDIDATES:\n') + 'CANDIDATES:\n'.length))
      return JSON.stringify(judged.map((_, i) => ({ idx: i, keep: true })))
    }
    const surv = await proposeThenJudge('g', 'X', { generate })
    expect(surv).toHaveLength(6)
    expect(judged).toHaveLength(6)
  })

  it('returns [] when the generator yields nothing usable', async () => {
    expect(await proposeThenJudge('g', 'X', { generate: genArray([]) })).toEqual([])
    expect(await proposeThenJudge('g', 'X', { generate: async () => 'no json' })).toEqual([])
  })

  it('keeps all candidates when the judge is unavailable (empty)', async () => {
    let n = 0
    const generate = async (): Promise<string> => {
      n++
      return n === 1 ? JSON.stringify([{ title: 'A' }, { title: 'B' }]) : 'judge died, no array'
    }
    const surv = await proposeThenJudge('g', 'X', { generate })
    expect(surv.map((c) => c.title)).toEqual(['A', 'B'])
  })

  it('buildJudgePrompt embeds indexed candidate rows', () => {
    const p = buildJudgePrompt('TRACKS', [{ label: 'L1', goal: 'g1' }])
    expect(p).toContain('proposed TRACKS')
    expect(p).toContain('"idx":0')
    expect(p).toContain('"title":"L1"')
    expect(p).toContain('"objective":"g1"')
  })
})
