import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveStepToTask, buildProjectionPrompt, runProjectFutures } from './project-futures-native'
import type { Task } from './causal-substrate'

const task = (over: Partial<Task>): Task => ({
  id: '', text: '', done: false, status: 'Inbox', priority: '', due: '', tags: [], people: [], contexts: [], project: '', source: '', line: 0, ...over
})
const NOW = new Date(2026, 6, 3, 12, 0, 0)

describe('project-futures — resolveStepToTask (PURE)', () => {
  it('grounds a step to a matching task (entity match + same month) → task_id, gap:false', () => {
    const tasks = [task({ id: 't1', text: 'submit taptap build', due: '2026-08-01' })]
    const s = resolveStepToTask({ event: 'submit taptap build to store', when: '2026-08' }, tasks)
    expect(s).toMatchObject({ task_id: 't1', gap: false })
  })
  it('flags gap:true when nothing matches', () => {
    const s = resolveStepToTask({ event: 'totally unrelated work' }, [task({ id: 't1', text: 'submit taptap build' })])
    expect(s).toMatchObject({ task_id: '', gap: true })
  })
  it('empty event → gap:true immediately', () => {
    expect(resolveStepToTask({ event: '' }, [])).toMatchObject({ task_id: '', gap: true })
  })
  it('rejects a task in a different month when the step is dated', () => {
    const tasks = [task({ id: 't1', text: 'submit taptap build', due: '2026-09-01' })]
    const s = resolveStepToTask({ event: 'submit taptap build', when: '2026-08' }, tasks)
    expect(s.gap).toBe(true) // month mismatch
  })
})

describe('project-futures — buildProjectionPrompt (PURE)', () => {
  it('embeds the significance/activity rules, lanes, today, and context blocks', () => {
    const p = buildProjectionPrompt('PROF', 'GOALS', 'STRAT', 'CTX', '- a1 · BW · 2026-07 · 北澜', '"北澜"|"orbis"', '2026-07-03')
    expect(p).toContain('You are the PROJECTION ENGINE')
    expect(p).toContain('ACTIVITY GATE')
    expect(p).toContain('"track": "北澜"|"orbis"')
    expect(p).toContain('Today is 2026-07-03.')
    expect(p).toContain('=== OPERATOR PROFILE')
    expect(p).toContain('=== CURRENT STATE: tracks, risks, decisions, recent updates ===\nCTX')
    expect(p).toContain('=== DECLARED ANCHORS (bind each stream to one by id via anchor_id) ===\n- a1 · BW · 2026-07 · 北澜')
  })
})

describe('project-futures — runProjectFutures', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pf-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    // a strategy-dense doc so the context isn't empty (engine proceeds)
    mkdirSync(join(vault, '03 Projects', '北澜'), { recursive: true })
    writeFileSync(join(vault, '03 Projects', '北澜', '发行计划.md'), '# 发行策略\nTapTap B站 Steam Xbox 国际发行 渠道 首发 定档 营收 用户')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('empty context (bare vault) → {empty:true}', () => {
    const bare = mkdtempSync(join(tmpdir(), 'duin-bare2-'))
    mkdirSync(join(bare, '.duin', '_state'), { recursive: true })
    return runProjectFutures(bare, { generate: async () => '[]', force: true, now: () => NOW }).then((r) => {
      expect(r).toMatchObject({ ok: true, empty: true })
      rmSync(bare, { recursive: true, force: true })
    })
  })

  it('generates + reconciles + persists futures + meta', async () => {
    const r = await runProjectFutures(vault, {
      generate: async () => '[{"title":"TapTap launch","objective":"launch on TapTap","track":"北澜"}]',
      force: true,
      now: () => NOW,
      uid: () => 'pf000001'
    })
    expect(r.ok).toBe(true)
    expect(r.generated).toBe(1)
    const nodes = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(nodes[0]).toMatchObject({ id: 'pf000001', title: 'TapTap launch', status: 'open' })
    const meta = JSON.parse(readFileSync(join(sd, 'future-meta.json'), 'utf-8'))
    expect(meta).toMatchObject({ count: 1, last: '2026-07-03T12:00:00' })
  })

  it('debounces within 60 min unless forced', async () => {
    writeFileSync(join(sd, 'future-meta.json'), JSON.stringify({ last: '2026-07-03T11:30:00', count: 0 }))
    const r = await runProjectFutures(vault, { generate: async () => '[]', now: () => NOW }) // 30 min later, no force
    expect(r).toMatchObject({ ok: true, skipped: 'recent' })
  })

  it('keeps existing streams when the model returns nothing parseable', async () => {
    writeFileSync(join(sd, 'future-nodes.jsonl'), JSON.stringify({ id: 'keep', status: 'engaged', title: 'Existing' }) + '\n')
    const r = await runProjectFutures(vault, { generate: async () => 'no json here', force: true, now: () => NOW })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no projection')
    expect(r.streams?.[0]).toMatchObject({ id: 'keep' })
    // file untouched
    expect(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})
