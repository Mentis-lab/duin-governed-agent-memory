import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { proposeThenJudge, stageCascade, loadCascadePending, cascadeDecision, cascadeTrack, cascadeProject, type CascadeDeps } from './cascade-engine-native'

// generate mock that returns queued responses in order (gen call, then judge call, ...).
function queued(...responses: string[]): CascadeDeps {
  let i = 0
  return {
    generate: async () => responses[i++] ?? '',
    now: () => new Date('2026-07-02T09:00:00'),
    id: () => `casc${i}`
  }
}

describe('cascade-engine-native', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-casc-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))
  const pending = (): Array<Record<string, unknown>> => loadCascadePending(vault)

  describe('proposeThenJudge', () => {
    it('keeps only candidates the judge marks keep:true', async () => {
      const deps = queued(
        '[{"title":"A","change":"x"},{"title":"B","change":"y"},{"title":"C","change":"z"}]',
        '[{"idx":0,"keep":true},{"idx":1,"keep":false},{"idx":2,"keep":true}]'
      )
      const surv = await proposeThenJudge('gen', 'things', deps)
      expect(surv.map((c) => c.title)).toEqual(['A', 'C'])
    })
    it('no candidates → []', async () => {
      expect(await proposeThenJudge('gen', 'things', queued('not json'))).toEqual([])
    })
    it('judge unavailable → keep all (provisional)', async () => {
      const surv = await proposeThenJudge('gen', 'things', queued('[{"title":"A"}]', 'no verdicts'))
      expect(surv.map((c) => c.title)).toEqual(['A'])
    })
  })

  describe('stageCascade', () => {
    it('appends proposals to cascade-pending with the right shape', () => {
      const n = stageCascade(vault, 'decision-affected', 'My Decision', [{ stream_id: 's1', change: 'raised risk' }], queued())
      expect(n).toBe(1)
      const it0 = pending()[0]
      expect(it0).toMatchObject({ kind: 'decision-affected', source: 'My Decision', status: 'pending', created: '2026-07-02T09:00:00', proposal: { stream_id: 's1', change: 'raised risk' } })
      expect(typeof it0.id).toBe('string')
    })
  })

  describe('cascadeDecision', () => {
    beforeEach(() => {
      writeFileSync(join(sd, 'future-nodes.jsonl'), [JSON.stringify({ id: 's1', title: 'Stream One', track: '北澜', status: 'open' }), JSON.stringify({ id: 's2', title: 'Done one', status: 'declined' })].join('\n') + '\n')
    })
    it('stages the judged affected streams for an open decision', async () => {
      const deps = queued('[{"stream_id":"s1","title":"Stream One","change":"unblocked"}]', '[{"idx":0,"keep":true}]')
      const n = await cascadeDecision(vault, { title: 'Ship it', call: 'go', rationale: 'ready' }, deps)
      expect(n).toBe(1)
      expect(pending()[0]).toMatchObject({ kind: 'decision-affected', source: 'Ship it', proposal: { stream_id: 's1' } })
    })
    it('no open streams / null vault → 0, nothing staged', async () => {
      rmSync(join(sd, 'future-nodes.jsonl'))
      expect(await cascadeDecision(vault, { title: 'x' }, queued())).toBe(0)
      expect(await cascadeDecision(null, { title: 'x' }, queued())).toBe(0)
    })
  })

  describe('cascadeTrack', () => {
    it('auto-lands judged moves as provisional streams (source=cascade, track=lane, parent set)', async () => {
      const deps = queued('[{"title":"Move A","objective":"do a"},{"title":"Move B","objective":"do b"}]', '[{"idx":0,"keep":true},{"idx":1,"keep":false}]')
      const n = await cascadeTrack(vault, { id: 't-bw', label: 'BW Prep', lane: '北澜', goal: 'g' }, deps)
      expect(n).toBe(1)
      const nodes = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
      const landed = nodes.find((x) => x.title === 'Move A')
      expect(landed).toMatchObject({ source: 'cascade', track: '北澜', parent: 't-bw', parent_label: 'BW Prep', status: 'open' })
      expect(nodes.find((x) => x.title === 'Move B')).toBeUndefined() // judged out
    })
    it('no survivors → 0, nothing landed', async () => {
      expect(await cascadeTrack(vault, { id: 't', label: 'T', lane: 'x' }, queued('[]'))).toBe(0)
    })
  })

  describe('cascadeProject', () => {
    it('stages judged tracks for a new project (project-track kind)', async () => {
      const deps = queued('[{"label":"Ops","goal":"run ops","keywords":["ops"]},{"label":"Dup","goal":"x"}]', '[{"idx":0,"keep":true},{"idx":1,"keep":false}]')
      const n = await cascadeProject(vault, 'BW Activation', deps)
      expect(n).toBe(1)
      expect(pending()[0]).toMatchObject({ kind: 'project-track', source: 'BW Activation', proposal: { label: 'Ops' } })
    })
    it('null vault → 0', async () => {
      expect(await cascadeProject(null, 'x', queued())).toBe(0)
    })
  })
})
