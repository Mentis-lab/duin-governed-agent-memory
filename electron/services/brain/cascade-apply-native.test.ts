import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyCascade, resolveCascade } from './cascade-apply-native'
import { stageCascade, loadCascadePending } from './cascade-native'

const noGen = { generate: async () => '' }

describe('cascade-apply — applyCascade', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ca-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('project-track → adds the track to the registry', async () => {
    const msg = await applyCascade(vault, { kind: 'project-track', source: 'ProjX', proposal: { label: 'New Track', goal: 'g' } }, noGen)
    expect(msg).toContain('track added:')
    const reg = JSON.parse(readFileSync(join(sd, 'tracks.json'), 'utf-8'))
    expect(reg.some((t: { label: string }) => t.label === 'New Track')).toBe(true)
  })

  it('decision-affected → links the decision onto the stream', async () => {
    writeFileSync(join(sd, 'future-nodes.jsonl'), JSON.stringify({ id: 's1', status: 'open', title: 'Launch', log: [] }) + '\n')
    const msg = await applyCascade(vault, { kind: 'decision-affected', source: 'ship it', created: '2026-07-03T10:00:00', proposal: { stream_id: 's1', change: 'unblocked' } }, noGen)
    expect(msg).toBe('stream linked to the decision')
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node.decided_by).toBe('ship it')
    expect(node.log[0]).toEqual({ ts: '2026-07-03T10:00:00', note: '[decision] unblocked' })
  })

  it('decision-affected → reports when the stream is gone', async () => {
    writeFileSync(join(sd, 'future-nodes.jsonl'), JSON.stringify({ id: 'other', status: 'open' }) + '\n')
    const msg = await applyCascade(vault, { kind: 'decision-affected', source: 'x', proposal: { stream_id: 'missing' } }, noGen)
    expect(msg).toBe('affected stream no longer present')
  })

  it('active-work with a task_id → materializes a grounded cascade move', async () => {
    const msg = await applyCascade(vault, {
      kind: 'active-work', source: 'capture', proposal: { title: 'New Move', change: 'do it', track: '北澜', task_id: 'cap-abc', task_title: 'Do it', due: '2026-08-01' }
    }, { ...noGen, now: () => new Date(2026, 6, 3, 10, 0, 0), uid: () => 'mv0' })
    expect(msg).toContain('move created: New Move')
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node).toMatchObject({ id: 'mv0', title: 'New Move', track: '北澜', source: 'cascade', status: 'open' })
    expect(node.steps[0]).toMatchObject({ event: 'Do it', task_id: 'cap-abc', when: '2026-08-01', done: false })
  })

  it('active-work without a task_id → captures via captureWork', async () => {
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
    const msg = await applyCascade(vault, { kind: 'active-work', source: 'scout', proposal: { title: 'explore a thing' } }, {
      generate: async () => '{"title":"Explore a thing","track":"duin"}'
    })
    expect(msg).toContain('captured: Explore a thing')
    expect(readFileSync(join(vault, '06 Tasks', 'Inbox.md'), 'utf-8')).toContain('Explore a thing')
  })

  it('unknown kind → no-op', async () => {
    expect(await applyCascade(vault, { kind: 'mystery', proposal: {} }, noGen)).toBe('no-op')
  })
})

describe('cascade-apply — resolveCascade', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-rc-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects a bad action', async () => {
    expect(await resolveCascade(vault, 'x', 'frobnicate', noGen)).toEqual({ ok: false, error: 'action must be approve|dismiss' })
  })

  it('approve applies + flips status to approved', async () => {
    stageCascade(vault, 'project-track', 'ProjX', [{ label: 'T' }], { uid: () => 'p0' })
    const out = await resolveCascade(vault, 'p0', 'approve', noGen)
    expect(out.ok).toBe(true)
    expect(out.action).toBe('approved')
    expect(out.applied).toContain('track added:')
    expect(loadCascadePending(vault).find((i) => i.id === 'p0')!.status).toBe('approved')
  })

  it('dismiss flips status without applying', async () => {
    stageCascade(vault, 'project-track', 'ProjX', [{ label: 'T' }], { uid: () => 'p1' })
    const out = await resolveCascade(vault, 'p1', 'dismiss', noGen)
    expect(out).toMatchObject({ ok: true, action: 'dismissed', applied: '' })
    expect(loadCascadePending(vault).find((i) => i.id === 'p1')!.status).toBe('dismissed')
  })

  it('rejects an unknown or already-resolved id', async () => {
    expect(await resolveCascade(vault, 'nope', 'approve', noGen)).toEqual({ ok: false, error: 'not found' })
    stageCascade(vault, 'k', 's', [{ label: 'T' }], { uid: () => 'p2' })
    await resolveCascade(vault, 'p2', 'dismiss', noGen)
    expect(await resolveCascade(vault, 'p2', 'approve', noGen)).toEqual({ ok: false, error: 'already resolved' })
  })
})
