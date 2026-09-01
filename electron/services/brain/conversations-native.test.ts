import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listConversations } from './conversations-native'
import { parseTaskFull } from './causal-substrate'

describe('parseTaskFull', () => {
  it('returns the FULL Python-shaped dict incl. movable/estimate/assignees', () => {
    const t = parseTaskFull('- [ ] ship it {{priority:: 1}} {{dateDue:: 2026-08-01}} {{estimate:: 90}} {{assignees:: Theo; 小K}} @Ann', 'Tasks.md', 3)!
    expect(Object.keys(t)).toEqual(['id', 'movable', 'text', 'done', 'status', 'priority', 'due', 'estimate', 'assignees', 'tags', 'people', 'contexts', 'project', 'source', 'line'])
    expect(t).toMatchObject({ movable: true, priority: '1', due: '2026-08-01', estimate: '90', assignees: 'Theo; 小K', people: ['Ann'], done: false })
  })
})

describe('listConversations', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-conv-'))
    mkdirSync(join(vault, 'People'), { recursive: true })
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('links a person to tasks referencing them; sorts most-owed first', () => {
    writeFileSync(join(vault, 'People', 'Ann (Acme).md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, 'People', 'Bob.md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, '06 Tasks', 'Tasks.md'), '- [ ] follow up with Ann {{priority:: 1}}\n- [x] done thing @Ann\n')
    const { conversations } = listConversations(vault)
    const ann = conversations.find((c) => c.person === 'Ann')!
    expect(ann.open).toBe(1)
    expect(ann.total).toBe(2) // one open (text match) + one done (@Ann)
    expect(ann.org).toBe('Acme')
    expect(conversations[0].person).toBe('Ann') // Ann (open=1) sorts before Bob (open=0)
  })

  it('null vault → empty', () => {
    expect(listConversations(null)).toEqual({ conversations: [] })
  })
})
