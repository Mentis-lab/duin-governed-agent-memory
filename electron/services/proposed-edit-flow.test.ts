import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { computeAnchors, validateProposedEditPaths } from './proposed-edit-flow'

// Unit coverage for the DB-free half of the proposed-edit flow: patch
// parsing + workspace-confinement + disk content-hash anchoring. The DB-bound
// propose/accept/reject/conflict paths are exercised by the store schema test
// (schema) and the integration suite; here we prove the freshness anchor
// captures the exact pre-image the accept-time drift check compares against.

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'proposed-edit-flow-'))
})

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

describe('validateProposedEditPaths', () => {
  it('resolves in-workspace paths', () => {
    const targets = validateProposedEditPaths(
      patch('*** Add File: a/b.txt', '+x'),
      workspace
    )
    expect(targets).toHaveLength(1)
    expect(targets[0].path).toBe('a/b.txt')
    expect(targets[0].abs.startsWith(workspace)).toBe(true)
  })

  it('rejects a path that escapes the workspace root', () => {
    expect(() =>
      validateProposedEditPaths(patch('*** Add File: ../evil.txt', '+x'), workspace)
    ).toThrow(/escapes|invalid/)
  })

  it('throws on a malformed envelope (parse error surfaces at propose)', () => {
    expect(() => validateProposedEditPaths('not a patch', workspace)).toThrow()
  })
})

describe('computeAnchors', () => {
  it('records existed:false + null hash for a file that is not on disk', () => {
    const anchors = computeAnchors(patch('*** Add File: new.txt', '+hi'), workspace)
    expect(anchors).toEqual([{ path: 'new.txt', existed: false, sha256: null }])
  })

  it('captures a stable content hash for an existing file', () => {
    writeFileSync(join(workspace, 'note.md'), 'original\n', 'utf8')
    const anchors = computeAnchors(
      patch('*** Update File: note.md', '@@', '-original', '+changed'),
      workspace
    )
    expect(anchors[0].existed).toBe(true)
    expect(anchors[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    // Deterministic: re-hashing the same bytes yields the same anchor.
    const again = computeAnchors(
      patch('*** Update File: note.md', '@@', '-original', '+changed'),
      workspace
    )
    expect(again[0].sha256).toBe(anchors[0].sha256)
  })

  it('the hash changes when the file bytes change (drift is detectable)', () => {
    const target = join(workspace, 'note.md')
    writeFileSync(target, 'v1\n', 'utf8')
    const before = computeAnchors(
      patch('*** Update File: note.md', '@@', '-v1', '+v2'),
      workspace
    )[0].sha256
    writeFileSync(target, 'v1-edited\n', 'utf8')
    const after = computeAnchors(
      patch('*** Update File: note.md', '@@', '-v1', '+v2'),
      workspace
    )[0].sha256
    expect(after).not.toBe(before)
  })
})
