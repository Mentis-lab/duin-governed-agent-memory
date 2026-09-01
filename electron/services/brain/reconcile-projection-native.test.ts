import { describe, it, expect } from 'vitest'
import { reconcileProjection } from './reconcile-projection-native'

const NOW = new Date(2026, 6, 3, 12, 0, 0)
const seqUid = (): (() => string) => {
  let i = 0
  return () => `new${i++}`
}

describe('reconcile-projection — reconcileProjection', () => {
  it('assigns fresh ids/status to brand-new streams', () => {
    const out = reconcileProjection([], [{ title: 'Alpha launch', objective: 'ship alpha' }], { now: () => NOW, uid: seqUid() })!
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'new0', status: 'open', created: '2026-07-03T12:00:00', title: 'Alpha launch' })
  })

  it('drops a generated stream that overlaps a DECLINED one (the operator passed on it)', () => {
    const existing = [{ id: 'd1', status: 'declined', title: 'Alpha launch', objective: 'ship alpha' }]
    const out = reconcileProjection(existing, [{ title: 'Alpha launch plan', objective: 'ship alpha now' }], { now: () => NOW, uid: seqUid() })
    // nothing fresh survived → null (keep existing)
    expect(out).toBeNull()
  })

  it('drops a generated stream that overlaps a SYNCED one (do not clobber operator-authored)', () => {
    const existing = [{ id: 's1', source: 'synced', status: 'open', title: 'Beta rollout', objective: 'beta to users' }]
    const out = reconcileProjection(existing, [{ title: 'Beta rollout', objective: 'beta to users soon' }], { now: () => NOW, uid: seqUid() })
    expect(out).toBeNull()
  })

  it('inherits a matching active prior id/status/created/log + preserves levels and step links', () => {
    const existing = [{
      id: 'p1', status: 'engaged', source: 'inferred', title: 'Alpha launch', objective: 'ship alpha',
      created: '2026-01-01T00:00:00', log: [{ ts: 't', note: 'n' }], levels: { risk: 0.9, progress: 0.5, confidence: 0.8 },
      steps: [{ event: 'submit alpha build', done: true, task_id: 't1' }]
    }]
    const gen = [{ title: 'Alpha launch', objective: 'ship alpha', steps: [{ event: 'submit alpha build to store' }, { event: 'press release' }] }]
    const out = reconcileProjection(existing, gen, { now: () => NOW, uid: seqUid() })!
    const s = out.find((n) => n.title === 'Alpha launch')!
    expect(s.id).toBe('p1') // inherited
    expect(s.status).toBe('engaged')
    expect(s.created).toBe('2026-01-01T00:00:00')
    expect(s.log).toEqual([{ ts: 't', note: 'n' }])
    expect(s.levels).toEqual({ risk: 0.9, progress: 0.5, confidence: 0.8 }) // prior levels preserved
    const steps = s.steps as { event: string; done?: boolean; task_id?: string }[]
    expect(steps[0]).toMatchObject({ event: 'submit alpha build to store', done: true, task_id: 't1' }) // carried
    expect(steps[1].done).toBeFalsy() // press release — no prior match
  })

  it('claim-once: two fresh streams matching the SAME prior — only one inherits its id', () => {
    const existing = [{ id: 'p1', status: 'open', source: 'inferred', title: 'Beilan launch', objective: 'beilan global' }]
    const gen = [
      { title: 'Beilan launch', objective: 'beilan global rollout' },
      { title: 'Beilan launch', objective: 'beilan global timing' }
    ]
    const out = reconcileProjection(existing, gen, { now: () => NOW, uid: seqUid() })!
    const ids = out.map((n) => n.id)
    expect(ids).toContain('p1') // exactly one inherited
    expect(ids.filter((x) => x === 'p1')).toHaveLength(1)
    expect(ids).toContain('new0') // the other got a fresh id
  })

  it('pins an engaged active stream that was not regenerated this round', () => {
    const existing = [{ id: 'e1', status: 'engaged', source: 'inferred', title: 'Gamma ops', objective: 'run gamma' }]
    const gen = [{ title: 'Delta push', objective: 'ship delta' }] // unrelated
    const out = reconcileProjection(existing, gen, { now: () => NOW, uid: seqUid() })!
    expect(out.some((n) => n.id === 'e1' && n.title === 'Gamma ops')).toBe(true) // pinned
    expect(out.some((n) => n.title === 'Delta push')).toBe(true) // fresh also present
  })

  it('returns null (keep existing) when no fresh stream survives', () => {
    expect(reconcileProjection([], [{ title: '' }], { now: () => NOW, uid: seqUid() })).toBeNull()
  })

  it('heals a pre-existing id collision so every final id is unique', () => {
    const existing = [
      { id: 'dup', source: 'synced', status: 'open', title: 'Synced one', objective: 'a' },
      { id: 'dup', status: 'declined', title: 'Declined one', objective: 'b' }
    ]
    const out = reconcileProjection(existing, [{ title: 'Fresh thing', objective: 'new work' }], { now: () => NOW, uid: seqUid() })!
    const ids = out.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })

  it('invokes the injected groundSteps on each fresh stream', () => {
    let calls = 0
    reconcileProjection([], [{ title: 'A launch', objective: 'x' }], {
      now: () => NOW, uid: seqUid(), groundSteps: () => { calls++ }
    })
    expect(calls).toBe(1)
  })
})
