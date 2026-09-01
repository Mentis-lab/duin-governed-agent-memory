// Backlog finding 8 (critical). drive_upload_file took any absolute local path and
// shipped it to the operator's real Google Drive, at `write-reversible` tier — which
// action-tier.ts only requires approval for when it is `irreversible`. One "Always
// allow" on any other network-risk prompt pre-approved this too, by the codebase's own
// documented risk-class fan-out, so a poisoned document could name a private key and
// exfiltrate it with no prompt anywhere.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/userData' } }))
vi.mock('./workspace-state', () => ({ getActiveWorkspace: () => 'C:/work' }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({ localBrainNotesDir: 'C:/vault' }) }))

import {
  isInsideRoot,
  isInsideAnyRoot,
  assertInsideRoots,
  permittedLocalRoots,
  assertNotOverwriting
} from './path-jail'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('isInsideRoot', () => {
  it('accepts a path strictly inside the root', () => {
    expect(isInsideRoot('C:/work', 'C:/work/notes/a.txt')).toBe(true)
    expect(isInsideRoot('C:/work', 'C:/work/a.txt')).toBe(true)
  })

  it('rejects the root itself — a jail is not satisfied by naming it', () => {
    expect(isInsideRoot('C:/work', 'C:/work')).toBe(false)
  })

  it('rejects a traversal escape', () => {
    expect(isInsideRoot('C:/work', 'C:/work/../secrets.txt')).toBe(false)
    expect(isInsideRoot('C:/work', 'C:/work/sub/../../secrets.txt')).toBe(false)
  })

  it('rejects a sibling whose name merely starts with the root', () => {
    // The classic prefix trap: a startsWith() check would admit this.
    expect(isInsideRoot('C:/work', 'C:/work-secrets/a.txt')).toBe(false)
  })

  it('rejects an unrelated absolute path', () => {
    expect(isInsideRoot('C:/work', 'C:/Users/theo/.ssh/id_rsa')).toBe(false)
  })

  it('an empty or missing root matches NOTHING, rather than everything', () => {
    // Fail-closed: a jail with no root must refuse, not admit.
    expect(isInsideRoot('', 'C:/anything')).toBe(false)
    expect(isInsideRoot(undefined, 'C:/anything')).toBe(false)
    expect(isInsideRoot(null, 'C:/anything')).toBe(false)
    expect(isInsideRoot('   ', 'C:/anything')).toBe(false)
  })

  it('an empty candidate is never inside anything', () => {
    expect(isInsideRoot('C:/work', '')).toBe(false)
  })
})

describe('isInsideAnyRoot', () => {
  it('passes when any single root contains it, ignoring blank roots', () => {
    expect(isInsideAnyRoot(['', undefined, 'C:/vault'], 'C:/vault/n.md')).toBe(true)
  })
  it('fails when none does', () => {
    expect(isInsideAnyRoot(['C:/work', 'C:/vault'], 'C:/elsewhere/x')).toBe(false)
  })
})

describe('assertInsideRoots', () => {
  it('returns the resolved path when permitted', () => {
    expect(assertInsideRoots(['C:/work'], 'C:/work/a.txt', 'tool')).toMatch(/a\.txt$/)
  })

  it('throws when the path escapes every root', () => {
    expect(() => assertInsideRoots(['C:/work'], 'C:/Users/x/.ssh/id_rsa', 'drive_upload_file')).toThrow(
      /drive_upload_file: refused/
    )
  })

  it('throws when no root is configured, rather than admitting everything', () => {
    expect(() => assertInsideRoots([undefined, ''], 'C:/anything', 'tool')).toThrow(
      /no permitted directory is configured/
    )
  })

  it('does not echo the refused path back into the error', () => {
    // The error can travel back to a model; the whole point is that this path was not
    // ours to read, so it should not be repeated in the reply either.
    let msg = ''
    try {
      assertInsideRoots(['C:/work'], 'C:/Users/x/.ssh/id_rsa', 'tool')
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).not.toMatch(/id_rsa/)
  })
})

describe('permittedLocalRoots', () => {
  it('is the workspace, the vault, and the artifacts folder — and nothing else', () => {
    const roots = permittedLocalRoots()
    expect(roots).toContain('C:/work')
    expect(roots).toContain('C:/vault')
    expect(roots.some((r) => r.includes('artifacts'))).toBe(true)
    expect(roots).toHaveLength(3)
  })
})

describe('assertNotOverwriting — finding 10', () => {
  it('allows a path with nothing at it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-jail-'))
    try {
      expect(() => assertNotOverwriting(join(dir, 'new.html'), 'export_artifact')).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when a file is already there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-jail-'))
    try {
      const f = join(dir, 'notes.docx')
      writeFileSync(f, 'the user file', 'utf-8')
      expect(() => assertNotOverwriting(f, 'generate_docx')).toThrow(/generate_docx: refused/)
      expect(() => assertNotOverwriting(f, 'generate_docx')).toThrow(/already exists/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
