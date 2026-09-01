import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listVaultEntities, vaultEntities, listEntities } from './entities-native'

describe('entities-native', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-ent-'))
    mkdirSync(join(vault, 'People'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('classifies person (type:person) + org (公司档案), skips _ files + templates', () => {
    writeFileSync(join(vault, 'People', 'Alex (Bilibili).md'), '---\ntype: person\n---\nnote')
    writeFileSync(join(vault, 'People', 'Bilibili.md'), '---\n公司档案\n---\norg note')
    writeFileSync(join(vault, 'People', '_scratch.md'), '---\ntype: person\n---\nskip me')
    writeFileSync(join(vault, 'People', 'template-person.md'), '---\ntype: person\n---\nskip')
    const { people, orgs } = listVaultEntities(vault)
    expect(people.map((p) => p.name)).toEqual(['Alex'])
    expect(people[0].org).toBe('Bilibili') // from filename parenthetical
    expect(orgs.map((o) => o.name)).toEqual(['Bilibili'])
  })

  it('vaultEntities links members + derives org role count; people alpha then orgs by -members', () => {
    writeFileSync(join(vault, 'People', 'Ann (Acme).md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, 'People', 'Bob (Acme).md'), '---\ntype: person\n---\n')
    const rows = vaultEntities(vault)
    const acme = rows.find((r) => r.kind === 'org' && r.name === 'Acme')!
    expect(acme.source).toBe('derived')
    expect(acme.id).toBe('org:acme')
    expect(acme.role).toBe('2 people')
    expect(acme.members).toEqual(['Ann', 'Bob'])
    expect(rows.filter((r) => r.kind === 'person').map((p) => p.name)).toEqual(['Ann', 'Bob']) // alpha
  })

  it('null vault → empty', () => {
    expect(listEntities(null)).toEqual({ entities: [] })
  })
})
