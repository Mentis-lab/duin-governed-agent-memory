import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  collectNoteFiles,
  createFolder,
  createNote,
  moveNote,
  renameFolder,
  renameNote,
  resolveVaultPath,
  rewriteLinks,
  sanitizeName
} from './vault-organize'

let vault = ''
const actor = 'test'

function write(rel: string, text: string): void {
  const abs = join(vault, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, text, 'utf8')
}
const read = (rel: string): string => readFileSync(join(vault, ...rel.split('/')), 'utf8')
const journal = (): string[] => {
  const p = join(vault, '.duin', '_state', 'organize-journal.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n') : []
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-organize-'))
})
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* Windows handle race; tmp cleanup takes the rest */
  }
})

describe('sanitizeName', () => {
  it('accepts ordinary names, including spaces, hyphens and CJK', () => {
    for (const n of ['Q3 planning', 'meeting-notes', '云雀 发行', 'a.b']) expect(sanitizeName(n)).toEqual({ ok: true, name: n })
  })
  it('refuses separators, reserved characters, dot-names and empty', () => {
    for (const n of ['', '   ', 'a/b', 'a\\b', 'a:b', '.hidden', 'trailing.', 'con', 'x*y']) expect(sanitizeName(n).ok).toBe(false)
  })
})

describe('resolveVaultPath', () => {
  it('confines to the vault and refuses the machine subtrees and traversal', () => {
    expect(resolveVaultPath(vault, 'Notes/a.md', 'file').ok).toBe(true)
    expect(resolveVaultPath(vault, '../a.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, 'Notes/../../a.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, '.brain/memory/x.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, '.duin/_state/x.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, '.trash/x.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, 'Notes/.hidden/x.md', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, 'Notes/a.exe', 'file').ok).toBe(false)
    expect(resolveVaultPath(vault, '', 'dir')).toMatchObject({ ok: true, rel: '' })
    expect(resolveVaultPath(vault, 'vault:Notes\\Sub', 'dir')).toMatchObject({ ok: true, rel: 'Notes/Sub' })
  })
})

describe('rewriteLinks', () => {
  it('rewrites every wikilink form on the basename, case-insensitively, keeping alias and section', () => {
    const r = rewriteLinks('See [[Old Name]], [[old name|the old]], [[Old Name#Plan]], [[Old Name#Plan|x]] and [[Older Name]] and [[Old Name 2]].', 'Notes/Old Name.md', 'Notes/New Name.md')
    expect(r.text).toBe('See [[New Name]], [[New Name|the old]], [[New Name#Plan]], [[New Name#Plan|x]] and [[Older Name]] and [[Old Name 2]].')
    expect(r.count).toBe(4)
  })
  it('rewrites path-form wikilinks and markdown links, and leaves basename links alone on a move', () => {
    const r = rewriteLinks('[[Notes/Old Name]] [[Notes/Old Name.md|a]] [t](Notes/Old%20Name.md) [u](./Notes/Old%20Name.md) [[Old Name]]', 'Notes/Old Name.md', 'Archive/Old Name.md')
    // A percent-encoded target is written back encoded, as Obsidian writes it.
    expect(r.text).toBe('[[Archive/Old Name]] [[Archive/Old Name.md|a]] [t](Archive/Old%20Name.md) [u](Archive/Old%20Name.md) [[Old Name]]')
    expect(r.count).toBe(4)
  })
  it('rewrites a plain markdown link on the basename when the note is renamed', () => {
    const r = rewriteLinks('[a](Old.md) [b](Other.md) [c](sub/Old.md)', 'Old.md', 'New.md')
    expect(r.text).toBe('[a](New.md) [b](Other.md) [c](sub/Old.md)')
    expect(r.count).toBe(1)
  })
})

describe('renameNote', () => {
  it('renames the file, rewrites links across the vault, preserves rewritten notes, journals the act', () => {
    write('Notes/Old.md', '# Old\nSelf [[Old]].')
    write('Projects/P.md', 'Depends on [[Old|the old note]] and [[Old#Plan]].')
    write('Other/Q.md', 'Unrelated [[Older]] text.')
    const r = renameNote(vault, 'Notes/Old.md', 'New', { actor })
    expect(r).toMatchObject({ ok: true, path: 'Notes/New.md', linksUpdated: 3, notesTouched: 2 })
    expect(existsSync(join(vault, 'Notes', 'New.md'))).toBe(true)
    expect(existsSync(join(vault, 'Notes', 'Old.md'))).toBe(false)
    expect(read('Projects/P.md')).toBe('Depends on [[New|the old note]] and [[New#Plan]].')
    expect(read('Notes/New.md')).toBe('# Old\nSelf [[New]].')
    expect(read('Other/Q.md')).toBe('Unrelated [[Older]] text.')
    // Prior bytes of every rewritten note are preserved in .trash (one snapshot per touched note),
    // and .trash is never part of the note tree a rewrite walks.
    expect(readdirSync(join(vault, '.trash')).filter((f) => f.endsWith('.md'))).toHaveLength(2)
    expect(collectNoteFiles(vault).some((p) => p.includes('.trash'))).toBe(false)
    const lines = journal().map((l) => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ op: 'rename', from: 'Notes/Old.md', to: 'Notes/New.md', linksUpdated: 3, notesTouched: 2, actor })
  })

  it('keeps the extension, refuses a clobber, and can skip the link rewrite', () => {
    write('a.md', 'x')
    write('b.md', 'y [[a]]')
    expect(renameNote(vault, 'a.md', 'b', { actor })).toEqual({ ok: false, error: 'a note with that name already exists here' })
    const r = renameNote(vault, 'a.md', 'c.md', { actor, updateLinks: false })
    expect(r).toMatchObject({ ok: true, path: 'c.md', linksUpdated: 0 })
    expect(read('b.md')).toBe('y [[a]]')
  })

  it('refuses a note outside the vault or in the machine subtrees', () => {
    expect(renameNote(vault, '../x.md', 'y', { actor }).ok).toBe(false)
    expect(renameNote(vault, '.brain/memory/x.md', 'y', { actor }).ok).toBe(false)
    expect(renameNote(vault, 'missing.md', 'y', { actor })).toEqual({ ok: false, error: 'note not found' })
  })
})

describe('moveNote', () => {
  it('moves into a folder it creates, rewrites path links only, journals', () => {
    write('Inbox/Idea.md', '# Idea')
    write('Notes/Ref.md', 'See [[Idea]] and [[Inbox/Idea]] and [x](Inbox/Idea.md).')
    const r = moveNote(vault, 'Inbox/Idea.md', 'Projects/Alpha', { actor })
    expect(r).toMatchObject({ ok: true, path: 'Projects/Alpha/Idea.md', linksUpdated: 2, notesTouched: 1 })
    expect(existsSync(join(vault, 'Projects', 'Alpha', 'Idea.md'))).toBe(true)
    expect(read('Notes/Ref.md')).toBe('See [[Idea]] and [[Projects/Alpha/Idea]] and [x](Projects/Alpha/Idea.md).')
    expect(JSON.parse(journal()[0])).toMatchObject({ op: 'move', from: 'Inbox/Idea.md', to: 'Projects/Alpha/Idea.md' })
  })
  it('moves to the root, refuses a clobber and the machine subtrees', () => {
    write('Inbox/Idea.md', '# Idea')
    write('Idea.md', 'taken')
    expect(moveNote(vault, 'Inbox/Idea.md', '', { actor })).toEqual({ ok: false, error: 'a note with that name already exists in that folder' })
    expect(moveNote(vault, 'Inbox/Idea.md', '.brain', { actor }).ok).toBe(false)
    rmSync(join(vault, 'Idea.md'))
    expect(moveNote(vault, 'Inbox/Idea.md', '', { actor })).toMatchObject({ ok: true, path: 'Idea.md' })
  })
})

describe('renameFolder', () => {
  it('renames the folder and rewrites the path forms, counting the notes moved', () => {
    write('Old Folder/A.md', '# A')
    write('Old Folder/Sub/B.md', '# B')
    write('Notes/Ref.md', '[[Old Folder/A]] [[old folder/Sub/B|b]] [l](Old%20Folder/A.md) [[A]]')
    const r = renameFolder(vault, 'Old Folder', 'New Folder', { actor })
    expect(r).toMatchObject({ ok: true, path: 'New Folder', notesMoved: 2, linksUpdated: 3, notesTouched: 1 })
    expect(existsSync(join(vault, 'New Folder', 'Sub', 'B.md'))).toBe(true)
    expect(read('Notes/Ref.md')).toBe('[[New Folder/A]] [[New Folder/Sub/B|b]] [l](New%20Folder/A.md) [[A]]')
  })
  it('refuses the root, a missing folder, a clobber and the machine subtrees', () => {
    mkdirSync(join(vault, 'X'))
    mkdirSync(join(vault, 'Y'))
    expect(renameFolder(vault, '', 'Z', { actor })).toEqual({ ok: false, error: 'the vault root cannot be renamed' })
    expect(renameFolder(vault, 'Missing', 'Z', { actor })).toEqual({ ok: false, error: 'folder not found' })
    expect(renameFolder(vault, 'X', 'Y', { actor })).toEqual({ ok: false, error: 'a folder with that name already exists here' })
    expect(renameFolder(vault, '.duin', 'Z', { actor }).ok).toBe(false)
  })
})

describe('createFolder / createNote', () => {
  it('creates nested folders idempotently and notes with a frontmatter stub, never overwriting', () => {
    expect(createFolder(vault, 'Projects/Beta', { actor })).toEqual({ ok: true, path: 'Projects/Beta', created: true })
    expect(createFolder(vault, 'Projects/Beta', { actor })).toEqual({ ok: true, path: 'Projects/Beta', created: false })
    expect(createFolder(vault, '', { actor }).ok).toBe(false)
    expect(createFolder(vault, '.brain/x', { actor }).ok).toBe(false)
    const n = createNote(vault, 'Projects/Beta', 'Kickoff', { actor, now: new Date('2026-09-03T00:00:00Z') })
    expect(n).toEqual({ ok: true, path: 'Projects/Beta/Kickoff.md' })
    expect(read('Projects/Beta/Kickoff.md')).toBe('---\ncreated: 2026-09-03\n---\n\n# Kickoff\n\n')
    expect(createNote(vault, 'Projects/Beta', 'Kickoff', { actor })).toEqual({ ok: false, error: 'a note with that name already exists here' })
    expect(createNote(vault, 'Fresh', 'Root note.md', { actor })).toMatchObject({ ok: true, path: 'Fresh/Root note.md' })
  })
})
