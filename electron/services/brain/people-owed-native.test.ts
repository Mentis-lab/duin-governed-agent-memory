import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { peopleOwed } from './people-owed-native'

describe('people-owed-native', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-owed-'))
    mkdirSync(join(vault, 'People'), { recursive: true })
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('surfaces people with open follow-ups, most-owed first; done tasks excluded', () => {
    writeFileSync(join(vault, 'People', 'Alex (Bilibili).md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, 'People', 'Bob.md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, 'People', 'Carol.md'), '---\ntype: person\n---\n')
    writeFileSync(
      join(vault, '06 Tasks', 'Inbox.md'),
      [
        '- [ ] Send Alex the deck', // text mention → Alex
        '- [ ] Reply to Alex about pricing', // text mention → Alex
        '- [ ] Ping @Bob for signoff', // @assignee → Bob
        '- [x] Old thing with Carol' // done → excluded, Carol drops out
      ].join('\n')
    )
    const owed = peopleOwed(vault)
    expect(owed.map((o) => o.name)).toEqual(['Alex', 'Bob'])
    expect(owed[0]).toMatchObject({ name: 'Alex', open: 2, org: 'Bilibili' })
    expect(owed[1]).toMatchObject({ name: 'Bob', open: 1 })
    expect(owed[0].top.length).toBeGreaterThan(0)
  })

  it('null vault → []', () => {
    expect(peopleOwed(null)).toEqual([])
  })

  it('vault with people but no open tasks → []', () => {
    writeFileSync(join(vault, 'People', 'Dana.md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, '06 Tasks', 'Inbox.md'), '- [x] Done thing with Dana')
    expect(peopleOwed(vault)).toEqual([])
  })
})
