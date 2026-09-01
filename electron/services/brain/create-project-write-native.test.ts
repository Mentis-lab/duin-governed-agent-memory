import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject } from './create-project-write-native'

const deps = { generate: async () => '[]' }

describe('create-project — createProject', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-cp-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects an empty or path-unsafe name', () => {
    expect(createProject(vault, '   ', deps)).toEqual({ ok: false, error: 'invalid name' })
    expect(createProject(vault, 'a/b', deps)).toEqual({ ok: false, error: 'invalid name' })
    expect(createProject(vault, 'bad:name', deps)).toEqual({ ok: false, error: 'invalid name' })
  })

  it('creates a top-level arena project + BRAIN.md when there is no 03 Projects root', () => {
    const r = createProject(vault, '北澜 GTM', deps)
    expect(r).toEqual({ ok: true, name: '北澜 GTM' })
    const brain = readFileSync(join(vault, '北澜 GTM', 'BRAIN.md'), 'utf-8')
    expect(brain).toBe('---\ntype: project-hub\ncreated-by: duin\n---\n\n# 北澜 GTM — Project Hub\n')
  })

  it('creates under 03 Projects when that root exists (legacy vault)', () => {
    mkdirSync(join(vault, '03 Projects'), { recursive: true })
    const r = createProject(vault, 'NewProj', deps)
    expect(r.ok).toBe(true)
    expect(existsSync(join(vault, '03 Projects', 'NewProj', 'BRAIN.md'))).toBe(true)
    expect(existsSync(join(vault, 'NewProj'))).toBe(false)
  })

  it('rejects a duplicate project', () => {
    createProject(vault, 'Dup', deps)
    expect(createProject(vault, 'Dup', deps)).toEqual({ ok: false, error: 'a project with that name already exists' })
  })

  it('strips surrounding slashes from the name', () => {
    const r = createProject(vault, '/Sales/', deps)
    expect(r).toEqual({ ok: true, name: 'Sales' })
    expect(existsSync(join(vault, 'Sales', 'BRAIN.md'))).toBe(true)
  })
})
