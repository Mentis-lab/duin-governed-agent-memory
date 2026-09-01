import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildCascadeProjectPrompt,
  buildCascadeDecisionPrompt,
  runCascadeProject,
  runCascadeDecision
} from './cascade-creators-native'
import { listCascadePending } from './cascade-native'

const twoPass = (cands: unknown[], keepIdxs: number[]): (() => Promise<string>) => {
  let pass = 0
  return async () => {
    pass++
    if (pass === 1) return JSON.stringify(cands)
    return JSON.stringify(cands.map((_, i) => ({ idx: i, keep: keepIdxs.includes(i) })))
  }
}

describe('cascade-creators — prompts (PURE)', () => {
  it('project prompt embeds the (JSON-quoted) name + existing tracks', () => {
    const p = buildCascadeProjectPrompt('北澜 GTM', ['DUIN', 'orbis'])
    expect(p).toContain('A new PROJECT was just created')
    expect(p).toContain('PROJECT: "北澜 GTM"')
    expect(p).toContain('EXISTING TRACKS (do NOT duplicate):\n["DUIN","orbis"]')
  })

  it('decision prompt embeds the decision json + streams', () => {
    const p = buildCascadeDecisionPrompt('{"title":"go"}', [{ id: 's1', title: 'T', track: '北澜' }])
    expect(p).toContain('A DECISION was just made')
    expect(p).toContain('DECISION: {"title":"go"}')
    expect(p).toContain('STREAMS:\n[{"id":"s1","title":"T","track":"北澜"}]')
  })
})

describe('cascade-creators — runCascadeProject', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cp-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('stages judged track proposals for review', async () => {
    const n = await runCascadeProject(vault, 'ProjX', {
      generate: twoPass([{ label: 'Track A', goal: 'g' }, { label: 'Track B' }], [0]),
      uid: (() => {
        let i = 0
        return () => `c${i++}`
      })()
    })
    expect(n).toBe(1)
    const pend = listCascadePending(vault).pending
    expect(pend).toHaveLength(1)
    expect(pend[0]).toMatchObject({ kind: 'project-track', source: 'ProjX', proposal: { label: 'Track A', goal: 'g' } })
  })

  it('never throws on a model failure', async () => {
    expect(await runCascadeProject(vault, 'X', { generate: async () => { throw new Error('down') } })).toBe(0)
  })
})

describe('cascade-creators — runCascadeDecision', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cd-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns 0 (no model call) when there are no active streams', async () => {
    let called = false
    const n = await runCascadeDecision(vault, { title: 'go' }, { generate: async () => { called = true; return '[]' } })
    expect(n).toBe(0)
    expect(called).toBe(false)
  })

  it('stages affected-stream edits from the active stream set', async () => {
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', status: 'open', title: 'Launch', track: '北澜' }),
        JSON.stringify({ id: 's2', status: 'declined', title: 'Dead', track: 'orbis' })
      ].join('\n') + '\n'
    )
    const n = await runCascadeDecision(vault, { title: 'ship it', call: 'go', rationale: 'ready' }, {
      generate: twoPass([{ stream_id: 's1', title: 'Launch', change: 'unblocked' }], [0]),
      uid: () => 'd0'
    })
    expect(n).toBe(1)
    const pend = listCascadePending(vault).pending
    expect(pend[0]).toMatchObject({ kind: 'decision-affected', source: 'ship it', proposal: { stream_id: 's1', change: 'unblocked' } })
  })
})
