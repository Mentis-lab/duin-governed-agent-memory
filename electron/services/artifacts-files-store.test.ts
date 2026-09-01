import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  listArtifactFiles,
  readArtifactFile,
  persistArtifactFile,
  extForArtifactType
} from './artifacts-files-store'

let base: string

function write(rel: string, content: string, mtimeSec?: number): string {
  const full = join(base, rel)
  mkdirSync(full.slice(0, full.lastIndexOf('\\') !== -1 ? full.lastIndexOf('\\') : full.lastIndexOf('/')), {
    recursive: true
  })
  writeFileSync(full, content, 'utf-8')
  if (mtimeSec) utimesSync(full, mtimeSec, mtimeSec)
  return full
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'artifacts-store-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('artifacts-files-store', () => {
  it('scans html + md recursively, ignores other extensions', () => {
    write('generated/a.html', '<h1>A</h1>')
    write('research/b.md', '# B')
    write('generated/c.svg', '<svg/>')
    write('generated/d.txt', 'nope')
    const files = listArtifactFiles(base)
    const names = files.map((f) => f.name).sort()
    expect(names).toEqual(['a.html', 'b.md'])
    expect(files.every((f) => f.ext === 'html' || f.ext === 'md')).toBe(true)
  })

  it('sorts newest-first and reports relDir', () => {
    write('generated/old.html', '<p>old</p>', 1000)
    write('research/new.md', '# new', 2000)
    const files = listArtifactFiles(base)
    expect(files[0].name).toBe('new.md')
    expect(files[0].relDir).toBe('research')
    expect(files[1].name).toBe('old.html')
    expect(files[1].relDir).toBe('generated')
  })

  it('returns [] when the artifacts root does not exist', () => {
    expect(listArtifactFiles(join(base, 'missing'))).toEqual([])
  })

  it('reads a file inside the root', () => {
    const p = write('generated/x.md', '# hello')
    const r = readArtifactFile(p, base)
    expect(r?.content).toBe('# hello')
    expect(r?.ext).toBe('md')
  })

  it('refuses a path outside the artifacts root (traversal guard)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    const evil = join(outside, 'secret.md')
    writeFileSync(evil, 'secret')
    expect(readArtifactFile(evil, base)).toBeNull()
    rmSync(outside, { recursive: true, force: true })
  })

  it('returns null reading a non-html/md file even inside the root', () => {
    const p = write('generated/x.txt', 'text')
    expect(readArtifactFile(p, base)).toBeNull()
  })

  it('persists html/md and is idempotent per content', () => {
    const p1 = persistArtifactFile('html', '<title>Deck</title><h1>Deck</h1>', base)
    expect(p1).toBeTruthy()
    expect(existsSync(p1 as string)).toBe(true)
    // same content → same path, no duplicate file
    const p2 = persistArtifactFile('html', '<title>Deck</title><h1>Deck</h1>', base)
    expect(p2).toBe(p1)
    expect(readdirSync(join(base, 'generated')).length).toBe(1)
    // it appears in the listing as an AI-created artifact
    expect(listArtifactFiles(base).some((f) => f.path === p1)).toBe(true)
  })

  it('skips non-html/md artifact types on persist', () => {
    expect(persistArtifactFile('svg', '<svg/>', base)).toBeNull()
    expect(persistArtifactFile('mermaid', 'graph TD', base)).toBeNull()
    expect(existsSync(join(base, 'generated'))).toBe(false)
  })

  it('maps artifact types to extensions', () => {
    expect(extForArtifactType('html')).toBe('html')
    expect(extForArtifactType('markdown')).toBe('md')
    expect(extForArtifactType('md')).toBe('md')
    expect(extForArtifactType('svg')).toBeNull()
  })
})
