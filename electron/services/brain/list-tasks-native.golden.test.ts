// GOLDEN lock for the list_tasks port. Live-diff proved it byte-exact on the real
// vault (88 tasks); this pins parse_task_line's field extraction + the full 15-key
// card order + feeds/grounded on synthetic fixtures.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseTaskLineFull, listTasks } from './list-tasks-native'

describe('list-tasks-native — golden (parse_task_line + list_tasks parity)', () => {
  it('parses fields, strips tags/@/emoji/urls, derives project + id', () => {
    const t = parseTaskLineFull(
      '- [ ] Ship 📅 the build #urgent @alice https://x.io {{status:: Project.北澜}} {{priority:: 1}} {{dateDue:: 2026-07-10}} {{duinTaskId:: op7}}',
      '北澜/Tasks.md',
      3
    )
    expect(t).toEqual({
      id: 'op7', // duinTaskId wins over source#idx
      movable: true,
      text: 'Ship the build', // tags/@/emoji/url/{{..}} removed, collapsed, edge-stripped
      done: false,
      status: '北澜', // "Project." removed
      priority: '1',
      due: '2026-07-10',
      estimate: '',
      assignees: '',
      tags: ['urgent'],
      people: ['alice'],
      contexts: [],
      project: '北澜', // <arena>/Tasks.md → 北澜
      source: '北澜/Tasks.md',
      line: 3
    })
  })

  it('BACK-COMPAT: a legacy {{operonId:: ..}} line still parses its id (falls back from duinTaskId)', () => {
    const t = parseTaskLineFull('- [ ] legacy task {{operonId:: leg9}}', '北澜/Tasks.md', 1)!
    expect(t.id).toBe('leg9') // no duinTaskId → legacy operonId supplies the id
  })

  it('done box → status Done; id falls back to source#idx; contexts split on ;', () => {
    const t = parseTaskLineFull('- [x] wrap up {{contexts:: home; deep-work}}', '06 Tasks/b.md', 0)!
    expect(t.done).toBe(true)
    expect(t.status).toBe('Done')
    expect(t.id).toBe('06 Tasks/b.md#0')
    expect(t.project).toBe('b') // 06 Tasks/<name>.md → name
    expect(t.contexts).toEqual(['home', 'deep-work'])
  })

  it('returns null for a non-task line', () => {
    expect(parseTaskLineFull('## a heading', 'x.md', 0)).toBeNull()
  })

  it('list_tasks: columns ordered, counts, grounded from a bound future step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-lt-'))
    try {
      mkdirSync(join(dir, '06 Tasks'), { recursive: true })
      mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
      writeFileSync(
        join(dir, '06 Tasks', 'board.md'),
        ['- [ ] task one {{duinTaskId:: t1}}', '- [ ] task two {{status:: Soon}}', '- [x] task three'].join('\n'),
        'utf-8'
      )
      // a future stream whose step is bound to t1 → t1 is grounded
      writeFileSync(
        join(dir, '.duin', '_state', 'future-nodes.jsonl'),
        JSON.stringify({ id: 's1', title: 'Launch', track: '北澜', parent_label: 'G1', steps: [{ event: 'ship', task_id: 't1' }] }),
        'utf-8'
      )
      const out = listTasks(dir)
      expect(out.columns).toEqual(['Inbox', 'Soon', 'Done']) // TASK_COLUMNS order among present
      expect(out.counts).toEqual({ Inbox: 1, Soon: 1, Done: 1 })
      expect(out.open).toBe(2)
      expect(out.grounded).toBe(1)
      const t1 = out.tasks.find((t) => t.id === 't1')!
      expect(t1.grounded).toBe(true)
      expect(t1.feeds).toEqual([{ stream_id: 's1', title: 'Launch', track: '北澜', goal: 'G1', step: 'ship' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
