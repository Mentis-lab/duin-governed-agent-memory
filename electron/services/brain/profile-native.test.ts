import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProfile } from './profile-native'

describe('listProfile', () => {
  let vault: string
  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pf-'))
    writeFileSync(join(vault, 'me.md'), '---\ndescription: fallback bio\n---\n# Me — Theo\n\n## Quick Bio\nA builder.\n\n## How to Work With Me\n- **Be direct** — no fluff\n- **Ship** it\n')
    writeFileSync(join(vault, 'GOALS.md'), 'x')
    mkdirSync(join(vault, '.duin', 'agents'), { recursive: true })
    writeFileSync(join(vault, '.duin', 'agents', 'grader.md'), 'a')
  })
  afterAll(() => rmSync(vault, { recursive: true, force: true }))

  it('lists existing foundation files (skips missing)', () => {
    const p = listProfile(vault)
    expect(p.foundation.map((f) => f.path)).toEqual(['me.md', 'GOALS.md']) // MEMORY/BRAIN absent
  })

  it('lists .duin/agents markdown', () => {
    expect(listProfile(vault).agents).toContainEqual({ name: 'grader', path: '.duin/agents/grader.md' })
  })

  it('parses me.md: name (strips "Me —"), Quick Bio, work highlights', () => {
    const me = listProfile(vault).me
    expect(me.name).toBe('Theo')
    expect(me.bio).toBe('A builder.')
    expect(me.work).toEqual(['Be direct — no fluff', 'Ship it'])
  })

  it('null vault → empty', () => {
    expect(listProfile(null)).toEqual({ foundation: [], agents: [], me: {} })
  })
})
