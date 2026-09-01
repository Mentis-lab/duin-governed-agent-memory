import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeApplyPatch } from './apply-patch-tool'

// Atomic (all-or-nothing) mode of executeApplyPatch. The proposed-edit accept
// path sets `atomic: true` so a non-coder's Apply either lands whole or leaves
// the workspace byte-identical to before.
//
// Default (non-atomic) behavior is unchanged and proven by contrast: the same
// mid-patch write failure leaves the earlier op on disk and reports a partial.

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'apply-patch-atomic-'))
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

// A patch whose FIRST op writes `a.txt`, then a SECOND op tries to add
// `a.txt/b.txt`. Both pass the pre-write plan pass (path resolution + planned
// existence), but at write time op2's mkdir of the parent directory `a.txt`
// fails because `a.txt` is now a regular file — a deterministic write-phase
// failure that lands AFTER op1 already hit disk.
function midWriteFailurePatch(): string {
  return patch(
    '*** Add File: a.txt',
    '+hello',
    '*** Add File: a.txt/b.txt',
    '+nested'
  )
}

describe('executeApplyPatch atomic mode', () => {
  it('rolls back the earlier op when a later op fails at write time', async () => {
    const res = await executeApplyPatch(
      { patch: midWriteFailurePatch() },
      workspace,
      { atomic: true }
    )
    expect(res.result.startsWith('Error:')).toBe(true)
    // The whole thing is unwound: a.txt (written by op1) is gone again.
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    // And it must NOT masquerade as a partial — nothing remains applied.
    expect(res.result).not.toContain('PARTIALLY applied')
  })

  it('restores prior bytes of an updated file on a later failure', async () => {
    const target = join(workspace, 'note.md')
    writeFileSync(target, 'original\n', 'utf8')
    const p = patch(
      '*** Update File: note.md',
      '@@',
      '-original',
      '+changed',
      '*** Add File: note.md/child.txt',
      '+nested'
    )
    const res = await executeApplyPatch({ patch: p }, workspace, { atomic: true })
    expect(res.result.startsWith('Error:')).toBe(true)
    // note.md is back to its exact original bytes.
    expect(readFileSync(target, 'utf8')).toBe('original\n')
  })

  it('default (non-atomic) mode leaves the earlier op on disk (contrast)', async () => {
    const res = await executeApplyPatch({ patch: midWriteFailurePatch() }, workspace)
    expect(res.result.startsWith('Error:')).toBe(true)
    // Without atomic, op1's a.txt stays written and the report warns partial.
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
    expect(res.result).toContain('PARTIALLY applied')
  })

  it('a fully successful atomic apply writes every file', async () => {
    const p = patch('*** Add File: x.txt', '+one', '*** Add File: y.txt', '+two')
    const res = await executeApplyPatch({ patch: p }, workspace, { atomic: true })
    expect(res.result.startsWith('Error:')).toBe(false)
    expect(readFileSync(join(workspace, 'x.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(workspace, 'y.txt'), 'utf8')).toBe('two\n')
  })
})
