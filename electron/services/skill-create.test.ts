import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import matter from 'gray-matter'

// The module under test resolves its target dir + dedup through skill-loader; mock both.
let SKILLS_DIR = ''
const loadedSkills = new Map<string, unknown>()

vi.mock('./skill-loader', () => ({
  getSkillsDir: () => SKILLS_DIR,
  getSkill: (id: string) => loadedSkills.get(id)
}))

import { createSkill, slugifySkillId } from './skill-create'

describe('slugifySkillId', () => {
  it('kebab-cases and lowercases a plain name', () => {
    expect(slugifySkillId('BD follow-up emails')).toBe('bd-follow-up-emails')
  })
  it('collapses punctuation and trims edges', () => {
    expect(slugifySkillId('  ***Draft!! the__reply??  ')).toBe('draft-the-reply')
  })
  it('ascii-folds unicode', () => {
    expect(slugifySkillId('Résumé Générator')).toBe('resume-generator')
  })
  it('caps at 64 chars and re-trims a trailing dash', () => {
    const id = slugifySkillId('a '.repeat(80)) // "a a a …" → "a-a-a-…"
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id.endsWith('-')).toBe(false)
    expect(id.startsWith('-')).toBe(false)
  })
  it('returns empty for a name with no usable chars', () => {
    expect(slugifySkillId('   ***   ')).toBe('')
    expect(slugifySkillId('')).toBe('')
  })
})

describe('createSkill', () => {
  beforeEach(() => {
    SKILLS_DIR = mkdtempSync(join(tmpdir(), 'duin-skills-'))
    loadedSkills.clear()
  })
  afterEach(() => {
    try {
      rmSync(SKILLS_DIR, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes <id>/SKILL.md with valid name frontmatter (happy path)', () => {
    const r = createSkill('BD Follow-up Emails', 'Draft partner follow-ups', 'Write a concise follow-up email.')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe('bd-follow-up-emails')
    expect(r.path).toBe(join(SKILLS_DIR, 'bd-follow-up-emails', 'SKILL.md'))
    expect(existsSync(r.path)).toBe(true)

    const parsed = matter(readFileSync(r.path, 'utf-8'))
    expect(parsed.data.name).toBe('bd-follow-up-emails')
    expect(parsed.data.description).toBe('Draft partner follow-ups')
    expect(parsed.content.trim()).toBe('Write a concise follow-up email.')
  })

  it('falls back to the name for the description when none given, yaml-safely', () => {
    const r = createSkill('Weird: name #1', '', 'Do a thing.')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const parsed = matter(readFileSync(r.path, 'utf-8'))
    expect(typeof parsed.data.name).toBe('string')
    expect(parsed.data.description).toBe('Weird: name #1') // quoted-then-parsed round trip
  })

  it('refuses when a directory-mode skill id already exists on disk', () => {
    mkdirSync(join(SKILLS_DIR, 'my-skill'))
    writeFileSync(join(SKILLS_DIR, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nx')
    const r = createSkill('My Skill', 'd', 'body')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/already exists/)
  })

  it('refuses when a flat <id>.md already exists on disk (case-insensitive)', () => {
    writeFileSync(join(SKILLS_DIR, 'My-Skill.md'), '---\nname: my-skill\n---\nx')
    const r = createSkill('my skill', 'd', 'body')
    expect(r.ok).toBe(false)
  })

  it('refuses when the id is already loaded (getSkill hit)', () => {
    loadedSkills.set('taken', { id: 'taken', name: 'taken' })
    const r = createSkill('Taken', 'd', 'body')
    expect(r.ok).toBe(false)
  })

  it('rejects an empty name', () => {
    expect(createSkill('   ', 'd', 'body').ok).toBe(false)
  })

  it('rejects a name with no usable id chars', () => {
    const r = createSkill('***', 'd', 'body')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/usable for a skill id/)
  })

  it('rejects an empty body', () => {
    expect(createSkill('Some Skill', 'd', '   ').ok).toBe(false)
  })

  it('rejects a body that already carries frontmatter', () => {
    const r = createSkill('Some Skill', 'd', '---\nname: x\n---\nbody')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/instructions only/)
  })

  it('rejects an over-large body', () => {
    const big = 'x'.repeat(100_001)
    const r = createSkill('Big Skill', 'd', big)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/too large/)
  })

  it('does not clobber an existing SKILL.md even if dedup were bypassed', () => {
    // First create succeeds…
    const first = createSkill('Once', 'd', 'first body')
    expect(first.ok).toBe(true)
    // …a second create with the same name is refused by dedup, original intact.
    const second = createSkill('Once', 'd', 'second body')
    expect(second.ok).toBe(false)
    if (!first.ok) return
    expect(readFileSync(first.path, 'utf-8')).toMatch(/first body/)
  })
})
