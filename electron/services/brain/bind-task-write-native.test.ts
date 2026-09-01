import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bindTask, unbindTask } from './bind-task-write-native'
import { loadTaskCorpus, openTaskTexts, findTaskText } from './task-corpus-native'

const seedTasks = (vault: string): void => {
  mkdirSync(join(vault, '06 Tasks'), { recursive: true })
  writeFileSync(
    join(vault, '06 Tasks', 'Inbox.md'),
    '---\ntype: tasks\n---\n\n' +
      '- [ ] Draft biweekly report {{duinTaskId:: t1}}\n' +
      '- [x] Old done task {{duinTaskId:: t2}}\n' +
      '- [ ] Submit TapTap build {{duinTaskId:: t3}}\n'
  )
}
const seedStream = (vault: string, node: Record<string, unknown>): void => {
  writeFileSync(join(vault, '.duin', '_state', 'future-nodes.jsonl'), JSON.stringify(node) + '\n')
}

describe('task-corpus-native', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-tc-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    seedTasks(vault)
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('loadTaskCorpus parses all task lines by duinTaskId', () => {
    expect(loadTaskCorpus(vault).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
  })

  it('openTaskTexts returns only non-done task texts', () => {
    expect(openTaskTexts(vault).sort()).toEqual(['Draft biweekly report', 'Submit TapTap build'])
  })

  it('findTaskText resolves a task by id', () => {
    expect(findTaskText(vault, 't3')).toBe('Submit TapTap build')
    expect(findTaskText(vault, 'missing')).toBeNull()
  })
})

describe('bind-task-write-native', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-bt-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    seedTasks(vault)
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects missing ids', () => {
    expect(bindTask(vault, '', 's1')).toEqual({ ok: false, error: 'task_id and stream_id required' })
    expect(unbindTask(vault, '')).toEqual({ ok: false, error: 'task_id required' })
  })

  it('binds a task-linked step using the task corpus title', () => {
    seedStream(vault, { id: 's1', title: 'Launch', track: '北澜', steps: [] })
    const out = bindTask(vault, 't3', 's1', '2026-08-01')
    expect(out).toMatchObject({ ok: true, stream_id: 's1', title: 'Launch', track: '北澜' })
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node.steps[0]).toEqual({ event: 'Submit TapTap build', when: '2026-08-01', task_id: 't3', gap: false, done: false })
  })

  it('falls back to the task_id as title when the task is unknown, and drops a bad due', () => {
    seedStream(vault, { id: 's1', title: 'Launch', steps: [] })
    bindTask(vault, 'unknown-id', 's1', 'not-a-date')
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node.steps[0]).toMatchObject({ event: 'unknown-id', when: '', task_id: 'unknown-id' })
  })

  it('is idempotent (already:true, no duplicate step)', () => {
    seedStream(vault, { id: 's1', title: 'Launch', steps: [{ event: 'x', task_id: 't3' }] })
    expect(bindTask(vault, 't3', 's1')).toEqual({ ok: true, already: true, stream_id: 's1' })
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node.steps).toHaveLength(1)
  })

  it('reports a missing stream', () => {
    seedStream(vault, { id: 'other', steps: [] })
    expect(bindTask(vault, 't3', 's1')).toEqual({ ok: false, error: 'stream not found' })
  })

  it('unbinds a task from one stream (or all) and counts removals', () => {
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [
        JSON.stringify({ id: 's1', steps: [{ task_id: 't3' }, { task_id: 'other' }] }),
        JSON.stringify({ id: 's2', steps: [{ task_id: 't3' }] })
      ].join('\n') + '\n'
    )
    expect(unbindTask(vault, 't3')).toEqual({ ok: true, removed: 2 }) // both streams
    const rows = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[0].steps).toEqual([{ task_id: 'other' }])
    expect(rows[1].steps).toEqual([])
  })

  it('unbind scoped to one stream leaves others', () => {
    writeFileSync(
      join(sd, 'future-nodes.jsonl'),
      [JSON.stringify({ id: 's1', steps: [{ task_id: 't3' }] }), JSON.stringify({ id: 's2', steps: [{ task_id: 't3' }] })].join('\n') + '\n'
    )
    expect(unbindTask(vault, 't3', 's1')).toEqual({ ok: true, removed: 1 })
    const rows = readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows[1].steps).toEqual([{ task_id: 't3' }]) // s2 untouched
  })
})
