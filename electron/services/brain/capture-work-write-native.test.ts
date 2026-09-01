import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { captureWork, buildCapturePrompt } from './capture-work-write-native'
import { listCascadePending } from './cascade-native'

describe('capture-work — captureWork', () => {
  let vault: string
  let sd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cw-'))
    sd = join(vault, '.duin', '_state')
    mkdirSync(sd, { recursive: true })
    mkdirSync(join(vault, '06 Tasks'), { recursive: true }) // tasks pillar exists
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects empty text', async () => {
    expect(await captureWork(vault, '  ', { generate: async () => '{}' })).toEqual({ ok: false, error: 'empty' })
  })

  it('writes a task line to the inbox with DUIN task-id + inline fields, validated priority/due', async () => {
    const out = await captureWork(vault, 'draft the biweekly report', {
      generate: async () => '{"title":"Draft orbis biweekly report","track":"orbis","priority":"P2","due":"2026-07-10","origin":"[[orbis biweekly]]"}'
    })
    expect(out.ok).toBe(true)
    expect(out.task).toMatchObject({ title: 'Draft orbis biweekly report', track: 'orbis', priority: 'P2', due: '2026-07-10' })
    expect(out.task!.id).toMatch(/^cap-[0-9a-f]{8}$/)
    const inbox = readFileSync(join(vault, '06 Tasks', 'Inbox.md'), 'utf-8')
    expect(inbox).toContain(`- [ ] Draft orbis biweekly report {{duinTaskId:: ${out.task!.id}}} {{status:: Project.Inbox}} {{priority:: P2}} {{dateDue:: 2026-07-10}}  关联：[[orbis biweekly]]`)
  })

  it('drops a fabricated/garbled due date and blank priority', async () => {
    const out = await captureWork(vault, 'think about strategy', {
      generate: async () => '{"title":"Think about strategy","track":"duin","priority":"urgent","due":"soon"}'
    })
    expect(out.task).toMatchObject({ priority: '', due: '' })
    const inbox = readFileSync(join(vault, '06 Tasks', 'Inbox.md'), 'utf-8')
    expect(inbox).not.toContain('dateDue')
    expect(inbox).not.toContain('priority')
  })

  it('keyless (no model output) still writes a task from the raw text', async () => {
    const out = await captureWork(vault, 'call the vendor', { generate: async () => '' })
    expect(out.ok).toBe(true)
    expect(out.task!.title).toBe('call the vendor')
  })

  it('binds a task-step to a matched active stream (dedup on task_id)', async () => {
    writeFileSync(join(sd, 'future-nodes.jsonl'), JSON.stringify({ id: 's1', status: 'open', title: 'Launch', track: '北澜', steps: [] }) + '\n')
    const out = await captureWork(vault, 'submit the TapTap build', {
      generate: async () => '{"title":"Submit TapTap build","track":"北澜","stream_id":"s1"}'
    })
    expect(out.bound_to).toMatchObject({ stream_id: 's1', title: 'Launch' })
    const node = JSON.parse(readFileSync(join(sd, 'future-nodes.jsonl'), 'utf-8').trim())
    expect(node.steps).toHaveLength(1)
    expect(node.steps[0]).toMatchObject({ event: 'Submit TapTap build', task_id: out.task!.id, done: false, gap: false })
  })

  it('stages a new-move cascade proposal when no move fits but work implies one', async () => {
    const out = await captureWork(vault, 'start exploring a partnership with X', {
      generate: async () => '{"title":"Explore X partnership","track":"orbis","stream_id":"","new_stream":"X partnership track"}',
      uid: () => 'cw0'
    })
    expect(out.proposed_stream).toBe('X partnership track')
    const pend = listCascadePending(vault).pending
    expect(pend[0]).toMatchObject({ kind: 'active-work', source: 'capture', proposal: { title: 'X partnership track', task_title: 'Explore X partnership' } })
  })

  it('prompt embeds lane enum, work text, and move menu', () => {
    const p = buildCapturePrompt('do a thing', '北澜|orbis', [{ id: 's1', title: 'M' }])
    expect(p).toContain("DUIN's capture router")
    expect(p).toContain('Pick the track lane from: 北澜|orbis.')
    expect(p).toContain('WORK (verbatim): "do a thing"')
    expect(p).toContain('MOVE MENU: [{"id":"s1","title":"M"}]')
  })
})
