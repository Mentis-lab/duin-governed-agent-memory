// BACKWARD-COMPAT GUARDRAIL — the one hard invariant.
//
// DUIN now WRITES the native `{{duinTaskId:: ..}}` field, but users' real Obsidian vaults still
// contain tasks written with the legacy external-plugin field `{{operonId:: ..}}`. DUIN MUST keep
// fully supporting those pre-existing lines: locate them, complete/move them by their legacy id, and
// parse their id through the list/causal parsers. This file locks that in so a future rename can't
// silently abandon the legacy field and corrupt existing tasks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { taskAction, moveTask, locateTask } from './task-write-native'
import { parseTaskLineFull } from './list-tasks-native'
import { LEGACY_TASK_ID_FIELD } from './task-fields'

describe('legacy {{operonId::}} back-compat (hard invariant)', () => {
  let vault: string
  let tasksMd: string
  const read = (): string => readFileSync(tasksMd, 'utf-8')

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-legacy-'))
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
    tasksMd = join(vault, '06 Tasks', 'Inbox.md')
    // A vault that predates the rename: tasks carry the LEGACY field only.
    writeFileSync(
      tasksMd,
      [
        '# Tasks',
        '- [ ] legacy open task {{operonId:: leg1}} {{status:: Project.Inbox}}',
        '- [ ] legacy movable task {{operonId:: leg2}} {{priority:: P2}}'
      ].join('\n') + '\n'
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('the legacy constant is still the external Operon field name', () => {
    expect(LEGACY_TASK_ID_FIELD).toBe('operonId')
  })

  it('locateTask resolves a legacy operonId task', () => {
    const loc = locateTask(vault, 'leg1')
    expect(loc).not.toBeNull()
    expect(loc!.idx).toBe(1)
  })

  it('taskAction complete works on a legacy operonId task', () => {
    const r = taskAction(vault, 'leg1', 'complete', '', new Date('2026-07-02T00:00:00Z'))
    expect(r.ok).toBe(true)
    const line = read().split('\n')[1]
    expect(line).toContain('- [x]')
    expect(line).toContain('✅ 2026-07-02')
    expect(line).toContain('{{status:: Project.Done}}')
    expect(line).toContain('{{operonId:: leg1}}') // legacy id field preserved, never rewritten
  })

  it('moveTask relocates a legacy operonId task by its legacy id', () => {
    expect(moveTask(vault, 'leg2', 'Doing')).toBe(true)
    const line = read().split('\n')[2]
    expect(line).toContain('{{status:: Project.Doing}}')
    expect(line).toContain('{{operonId:: leg2}}')
  })

  it('the list/causal parser reads a legacy operonId line’s id', () => {
    const t = parseTaskLineFull('- [ ] legacy line {{operonId:: legX}}', '06 Tasks/Inbox.md', 5)!
    expect(t.id).toBe('legX')
  })

  it('a mixed vault: new duinTaskId wins when both fields are present', () => {
    const t = parseTaskLineFull('- [ ] dual {{operonId:: old}} {{duinTaskId:: new}}', '06 Tasks/Inbox.md', 0)!
    expect(t.id).toBe('new')
  })
})
