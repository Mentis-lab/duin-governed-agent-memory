import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  executeApplyPatch,
  parsePatch,
  resolvePathWithinWorkspace
} from './apply-patch-tool'

// Each test gets a private temp workspace so add/update/delete operations
// can't bleed across tests. Workspaces are removed in afterEach.
let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'apply-patch-test-'))
})

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

function patch(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

// ────────────────────────────── parser ─────────────────────────────────

describe('parsePatch', () => {
  it('rejects empty input', () => {
    expect(() => parsePatch('')).toThrow(/non-empty string/)
  })

  it('rejects missing Begin header', () => {
    expect(() => parsePatch('hello world')).toThrow(/expected "\*\*\* Begin Patch"/)
  })

  it('rejects missing End footer', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Add File: a\n+x\n')).toThrow(
      /\*\*\* End Patch/
    )
  })

  it('parses an Add directive', () => {
    const ops = parsePatch(patch('*** Add File: hi.txt', '+a', '+b'))
    expect(ops).toEqual([{ kind: 'add', path: 'hi.txt', lines: ['a', 'b'] }])
  })

  it('rejects unknown top-level directive', () => {
    expect(() => parsePatch(patch('*** Rename File: foo bar'))).toThrow(
      /unrecognized directive|unknown directive/i
    )
  })

  it('rejects Add body lines without "+" prefix', () => {
    expect(() => parsePatch(patch('*** Add File: a.txt', 'no plus'))).toThrow(
      /every content line must start with "\+"/
    )
  })

  it('parses an Update with a hunk', () => {
    const ops = parsePatch(
      patch('*** Update File: f.txt', '@@ ctx', ' keep1', '-old', '+new')
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]
    expect(op.kind).toBe('update')
    if (op.kind === 'update') {
      expect(op.path).toBe('f.txt')
      expect(op.hunks).toHaveLength(1)
      expect(op.hunks[0].body).toEqual([
        { tag: 'keep', text: 'keep1' },
        { tag: 'remove', text: 'old' },
        { tag: 'add', text: 'new' }
      ])
    }
  })

  it('parses a Delete directive', () => {
    const ops = parsePatch(patch('*** Delete File: gone.txt'))
    expect(ops).toEqual([{ kind: 'delete', path: 'gone.txt' }])
  })

  it('rejects Add directive with empty path', () => {
    expect(() => parsePatch(patch('*** Add File: '))).toThrow(/missing path/i)
  })
})

// ───────────────────────────── path guard ──────────────────────────────

describe('resolvePathWithinWorkspace', () => {
  it('accepts a relative path under the root', () => {
    const r = resolvePathWithinWorkspace(workspace, 'sub/file.txt')
    expect(r).not.toBeNull()
    expect(r!.startsWith(workspace)).toBe(true)
  })

  it('rejects empty path', () => {
    expect(resolvePathWithinWorkspace(workspace, '')).toBeNull()
  })

  it('rejects ".." traversal', () => {
    expect(resolvePathWithinWorkspace(workspace, '../escape.txt')).toBeNull()
    expect(resolvePathWithinWorkspace(workspace, 'sub/../../escape.txt')).toBeNull()
  })

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\boot.ini' : '/etc/passwd'
    expect(resolvePathWithinWorkspace(workspace, outside)).toBeNull()
  })

  it('rejects the root itself', () => {
    expect(resolvePathWithinWorkspace(workspace, '.')).toBeNull()
  })
})

// ────────────────────────────── execute ────────────────────────────────

describe('executeApplyPatch', () => {
  it('adds a new file', async () => {
    const p = patch('*** Add File: greeting.txt', '+hello', '+world')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(join(workspace, 'greeting.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  it('adds a file in a nested directory', async () => {
    const p = patch('*** Add File: deep/nested/file.txt', '+ok')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(join(workspace, 'deep/nested/file.txt'), 'utf8')).toBe('ok\n')
  })

  it('refuses to add over an existing file', async () => {
    writeFileSync(join(workspace, 'x.txt'), 'old', 'utf8')
    const p = patch('*** Add File: x.txt', '+new')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*already exists/i)
    expect(readFileSync(join(workspace, 'x.txt'), 'utf8')).toBe('old')
  })

  it('updates a file via hunk match', async () => {
    writeFileSync(join(workspace, 'f.txt'), 'hello\nworld\n', 'utf8')
    const p = patch(
      '*** Update File: f.txt',
      '@@ first line',
      '-hello',
      '+greetings',
      ' world'
    )
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('greetings\nworld\n')
  })

  it('rejects update when hunk does not match', async () => {
    writeFileSync(join(workspace, 'f.txt'), 'alpha\nbeta\n', 'utf8')
    const p = patch('*** Update File: f.txt', '-not-present', '+x')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*patch did not apply at hunk/i)
    // File unchanged.
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('alpha\nbeta\n')
  })

  it('refuses to update a missing file', async () => {
    const p = patch('*** Update File: nope.txt', '-a', '+b')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*does not exist|not found/i)
  })

  it('deletes a file', async () => {
    writeFileSync(join(workspace, 'doomed.txt'), 'bye', 'utf8')
    const p = patch('*** Delete File: doomed.txt')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(existsSync(join(workspace, 'doomed.txt'))).toBe(false)
  })

  it('refuses to delete a missing file', async () => {
    const p = patch('*** Delete File: missing.txt')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*does not exist|not found/i)
  })

  it('rejects a path-traversal Add', async () => {
    const p = patch('*** Add File: ../escape.txt', '+x')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*escapes the workspace|invalid/i)
  })

  it('rejects an absolute-path Add outside the workspace', async () => {
    const outside =
      process.platform === 'win32' ? 'C:\\Windows\\hacked.txt' : '/tmp/hacked.txt'
    const p = patch(`*** Add File: ${outside}`, '+x')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:.*escapes the workspace|invalid/i)
  })

  it('rejects a malformed envelope before any disk writes', async () => {
    const p = '*** Begin Patch\n*** Add File: real.txt\n+a\n*** End Patch\nstray-trailing'
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:/)
    // Nothing should have been created.
    expect(existsSync(join(workspace, 'real.txt'))).toBe(false)
  })

  it('pre-validates all ops so an invalid op aborts the batch before writes', async () => {
    // Op 1: valid add. Op 2: invalid traversal. Expectation: neither applies.
    const p = patch(
      '*** Add File: ok.txt',
      '+content',
      '*** Add File: ../bad.txt',
      '+evil'
    )
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Error:/)
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(false)
  })

  it('preserves trailing-newline policy when updating', async () => {
    // File without trailing newline → updated file keeps no trailing newline.
    writeFileSync(join(workspace, 'noeol.txt'), 'one\ntwo', 'utf8')
    const p = patch('*** Update File: noeol.txt', '-one', '+ONE', ' two')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(join(workspace, 'noeol.txt'), 'utf8')).toBe('ONE\ntwo')
  })
})

// ───────────── blank separators after an Update block are not content ──────
//
// Regression guard: the Update branch of parsePatch treated EVERY unprefixed
// empty line as a `keep ""` context line, including the blank line a model
// leaves between one file's block and the next `*** ` directive (or before
// `*** End Patch`). The sibling Add and Delete branches already strip that
// separator; only Update turned it into content. The resulting phantom
// trailing context line is silent — it either makes a correct hunk
// unmatchable (and, because applyOps plans every hunk before any write,
// rejects the WHOLE patch while blaming "hunk 1"), or slides the match onto a
// later occurrence that happens to be followed by a blank line and edits the
// wrong place while reporting success.

describe('parsePatch blank separators between blocks', () => {
  it('does not append a phantom keep "" when a blank separates two file blocks', () => {
    const withBlank = parsePatch(
      patch(
        '*** Update File: notes.md',
        '@@',
        ' alpha',
        '-beta',
        '+gamma',
        '',
        '*** Update File: other.md',
        '@@',
        ' one',
        '-two',
        '+three'
      )
    )
    const withoutBlank = parsePatch(
      patch(
        '*** Update File: notes.md',
        '@@',
        ' alpha',
        '-beta',
        '+gamma',
        '*** Update File: other.md',
        '@@',
        ' one',
        '-two',
        '+three'
      )
    )
    expect(withBlank).toEqual(withoutBlank)
  })

  it('does not append a phantom keep "" for a blank before *** End Patch', () => {
    const ops = parsePatch(
      patch('*** Update File: notes.md', '@@', ' alpha', '-beta', '+gamma', '')
    )
    expect(ops).toHaveLength(1)
    const op = ops[0]
    expect(op.kind).toBe('update')
    if (op.kind === 'update') {
      expect(op.hunks[0].body).toEqual([
        { tag: 'keep', text: 'alpha' },
        { tag: 'remove', text: 'beta' },
        { tag: 'add', text: 'gamma' }
      ])
    }
  })

  it('still treats an interior empty line as a blank context line', () => {
    // The ambiguity the original arm existed to resolve: models emit a blank
    // source line unprefixed rather than as a lone " ". Inside the body it is
    // still content and must survive.
    const ops = parsePatch(
      patch('*** Update File: notes.md', '@@', ' alpha', '', '-beta', '+gamma')
    )
    const op = ops[0]
    expect(op.kind).toBe('update')
    if (op.kind === 'update') {
      expect(op.hunks[0].body).toEqual([
        { tag: 'keep', text: 'alpha' },
        { tag: 'keep', text: '' },
        { tag: 'remove', text: 'beta' },
        { tag: 'add', text: 'gamma' }
      ])
    }
  })
})

describe('executeApplyPatch blank separators between blocks', () => {
  it('applies a two-file patch whose blocks are separated by a blank line', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'alpha\nbeta\n', 'utf8')
    writeFileSync(join(workspace, 'other.md'), 'one\ntwo\n', 'utf8')

    const p = patch(
      '*** Update File: notes.md',
      '@@',
      ' alpha',
      '-beta',
      '+gamma',
      '',
      '*** Update File: other.md',
      '@@',
      ' one',
      '-two',
      '+three'
    )
    const { result } = await executeApplyPatch({ patch: p }, workspace)

    expect(result).toMatch(/Applied 2 change/)
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('alpha\ngamma\n')
    expect(readFileSync(join(workspace, 'other.md'), 'utf8')).toBe('one\nthree\n')
  })

  it('applies a single-file patch with a blank line before *** End Patch', async () => {
    writeFileSync(join(workspace, 'notes.md'), 'alpha\nbeta\n', 'utf8')
    const p = patch('*** Update File: notes.md', '@@', ' alpha', '-beta', '+gamma', '')
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('alpha\ngamma\n')
  })

  it('edits the FIRST matching occurrence, not a later one the phantom line found', async () => {
    // The silent half of the defect: with a trailing phantom keep "" the scan
    // skipped the correct first occurrence (followed by "z") and landed on the
    // second one (followed by a real blank line), reporting success either way.
    writeFileSync(join(workspace, 'dup.md'), 'x\ny\nz\nx\ny\n\nw\n', 'utf8')
    const p = patch(
      '*** Update File: dup.md',
      '@@',
      ' x',
      '-y',
      '+Y',
      '',
      '*** Update File: tail.md',
      '@@',
      '-old',
      '+new'
    )
    writeFileSync(join(workspace, 'tail.md'), 'old\n', 'utf8')

    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 2 change/)
    expect(readFileSync(join(workspace, 'dup.md'), 'utf8')).toBe('x\nY\nz\nx\ny\n\nw\n')
  })
})

// ──────────────────── destructive ops go through .trash ─────────────────
//
// Regression guard for the defect where `*** Delete File:` hard-unlinked a vault
// note while EVERY sibling vault writer routed the identical bytes through
// vault-trash. The workspace root defaults to the vault
// (workspace-state vaultWorkspaceFallback → settings.localBrainNotesDir), so
// "tidy up my project notes" + a saved always-allow policy destroyed
// hand-authored content with no tombstone, no journal line, and no backup
// anywhere (moat-backup never touches notes; index-store's pruneToKeep drops
// the notes_chunks rows on the reindex the unlink itself triggers).

describe('executeApplyPatch destructive ops preserve prior content', () => {
  // The production-default shape: the workspace root IS the vault.
  it('tombstones a deleted vault note into <vault>/.trash instead of unlinking it', async () => {
    const note = join(workspace, '01 Projects', 'kickoff-notes.md')
    mkdirSync(join(workspace, '01 Projects'), { recursive: true })
    writeFileSync(note, '# Kickoff\n\nhand-authored, irreplaceable\n', 'utf8')

    const p = patch('*** Delete File: 01 Projects/kickoff-notes.md')
    const { result } = await executeApplyPatch({ patch: p }, workspace, {
      vaultDir: workspace
    })

    expect(result).toMatch(/Applied 1 change/)
    // The note is gone from its original path — the delete really happened...
    expect(existsSync(note)).toBe(false)
    // ...but the bytes survive in the vault's ONE recovery surface.
    const trashDir = join(workspace, '.trash')
    const tombstones = readdirSync(trashDir).filter((f) => f.endsWith('.md'))
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(trashDir, tombstones[0]), 'utf8')).toBe(
      '# Kickoff\n\nhand-authored, irreplaceable\n'
    )

    // The delete is traceable: journal records what/when/who/where-it-went.
    const journal = readFileSync(join(trashDir, '_tombstones.jsonl'), 'utf8').trim()
    const entry = JSON.parse(journal.split('\n')[0])
    expect(entry.from).toBe('01 Projects/kickoff-notes.md')
    expect(entry.actor).toBe('agent:apply_patch')
    expect(typeof entry.at).toBe('string')
    expect(entry.to).toBe(`.trash/${tombstones[0]}`)

    // The model/operator is TOLD where the bytes went, not just that they vanished.
    expect(result).toContain(entry.to)
  })

  // The workspace may be a subfolder of the vault; recovery must still land in
  // the vault's single .trash rather than a second one under the subfolder.
  it('tombstones into the vault root when the workspace is a vault subfolder', async () => {
    const sub = join(workspace, '01 Projects')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'note.md'), 'body\n', 'utf8')

    const { result } = await executeApplyPatch(
      { patch: patch('*** Delete File: note.md') },
      sub,
      { vaultDir: workspace }
    )

    expect(result).toMatch(/Applied 1 change/)
    expect(existsSync(join(sub, 'note.md'))).toBe(false)
    expect(existsSync(join(sub, '.trash'))).toBe(false)
    expect(readdirSync(join(workspace, '.trash')).filter((f) => f.endsWith('.md'))).toHaveLength(1)
  })

  // No vault configured: a delete is unrecoverable wherever it happens and the
  // actor is still a model that is guessing, so it is preserved regardless.
  it('tombstones into the workspace root when no vault is configured', async () => {
    writeFileSync(join(workspace, 'doomed.txt'), 'bye', 'utf8')
    const { result } = await executeApplyPatch(
      { patch: patch('*** Delete File: doomed.txt') },
      workspace
    )
    expect(result).toMatch(/Applied 1 change/)
    expect(existsSync(join(workspace, 'doomed.txt'))).toBe(false)
    const tombstones = readdirSync(join(workspace, '.trash')).filter((f) =>
      f.endsWith('.txt')
    )
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(workspace, '.trash', tombstones[0]), 'utf8')).toBe('bye')
  })

  // Same missing-guard shape as the delete, lower severity: an Update rewrites a
  // hand-authored body. Siblings (doc-save.ts, executeEditFile) snapshot first.
  it('snapshots the prior body before updating a vault note', async () => {
    const note = join(workspace, 'daily.md')
    writeFileSync(note, 'hello\nworld\n', 'utf8')

    const p = patch('*** Update File: daily.md', '-hello', '+greetings', ' world')
    const { result } = await executeApplyPatch({ patch: p }, workspace, {
      vaultDir: workspace
    })

    expect(result).toMatch(/Applied 1 change/)
    expect(readFileSync(note, 'utf8')).toBe('greetings\nworld\n')
    const snaps = readdirSync(join(workspace, '.trash')).filter((f) => f.endsWith('.md'))
    expect(snaps).toHaveLength(1)
    // The PRIOR content is what got preserved.
    expect(readFileSync(join(workspace, '.trash', snaps[0]), 'utf8')).toBe('hello\nworld\n')
    expect(result).toContain(`.trash/${snaps[0]}`)
  })

  // ─────────────── multi-op patches must not half-apply silently ───────────────
  //
  // Regression guard for the defect where applyOps committed each op in
  // sequence with no transaction and no rollback, while executeApplyPatch's
  // catch discarded the local `summary` and returned a bare `Error: <reason>`.
  // The single most common apply_patch failure — a correct-LOOKING reply whose
  // Update context lines were paraphrased — therefore deleted the first file,
  // threw on the second, and reported "Error: patch did not apply at hunk 1".
  // The model and the operator both read that as "nothing happened"; the model
  // re-sent a corrected patch whose Delete then failed with "file does not
  // exist", masking that the note was already gone.
  //
  // Total failure was guarded (pre-validation aborts before any write); PARTIAL
  // failure was not.

  it('aborts a delete-then-failing-update patch before the delete touches disk', async () => {
    const doomed = join(workspace, '00 Inbox', 'old-draft.md')
    const plan = join(workspace, '01 Projects', 'plan.md')
    mkdirSync(join(workspace, '00 Inbox'), { recursive: true })
    mkdirSync(join(workspace, '01 Projects'), { recursive: true })
    writeFileSync(doomed, 'hand-authored draft\n', 'utf8')
    writeFileSync(plan, 'the real first line\nsecond\n', 'utf8')

    // Op 2's context line is PARAPHRASED — it does not match the file.
    const p = patch(
      '*** Delete File: 00 Inbox/old-draft.md',
      '*** Update File: 01 Projects/plan.md',
      '-the actual first line',
      '+rewritten'
    )
    const { result } = await executeApplyPatch({ patch: p }, workspace, {
      vaultDir: workspace
    })

    expect(result).toMatch(/Error:.*patch did not apply at hunk/i)
    // The whole patch is a genuine no-op: the delete never ran, so the report
    // ("nothing happened") is now TRUE.
    expect(existsSync(doomed)).toBe(true)
    expect(readFileSync(doomed, 'utf8')).toBe('hand-authored draft\n')
    expect(readFileSync(plan, 'utf8')).toBe('the real first line\nsecond\n')
    expect(existsSync(join(workspace, '.trash'))).toBe(false)
  })

  it('plans hunks against earlier ops in the same patch (add then update)', async () => {
    const p = patch(
      '*** Add File: notes.md',
      '+alpha',
      '+beta',
      '*** Update File: notes.md',
      '-alpha',
      '+ALPHA',
      ' beta'
    )
    const { result } = await executeApplyPatch({ patch: p }, workspace)
    expect(result).toMatch(/Applied 2 change/)
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('ALPHA\nbeta\n')
  })

  it('reports what was already written when a later op fails mid-write', async () => {
    // A failure that pre-validation cannot predict: op 1 is a clean delete,
    // op 2 is an Add whose parent directory cannot be created because a FILE
    // already occupies that name. The point is the REPORT, not the cause:
    // whatever makes a write fail after an earlier one landed (EPERM, ENOSPC,
    // an unstageable tombstone), the caller must be told it half-applied.
    const first = join(workspace, 'first.md')
    writeFileSync(first, 'first body\n', 'utf8')
    writeFileSync(join(workspace, 'blocked'), 'i am a file, not a directory', 'utf8')

    const p = patch('*** Delete File: first.md', '*** Add File: blocked/child.md', '+x')
    const { result } = await executeApplyPatch({ patch: p }, workspace, {
      vaultDir: workspace
    })

    expect(result).toMatch(/^Error:/)
    // The first delete DID happen — say so, name the file, and point at the
    // recovery surface. Without this the model re-sends and the note's
    // disappearance is masked by "file does not exist".
    expect(result).toMatch(/PARTIALLY applied/i)
    expect(result).toContain('- first.md')
    expect(result).toMatch(/\.trash\//)
    expect(existsSync(first)).toBe(false)
    const tombstones = readdirSync(join(workspace, '.trash')).filter((f) =>
      f.endsWith('.md')
    )
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(workspace, '.trash', tombstones[0]), 'utf8')).toBe('first body\n')
  })

  it('does not leave a snapshot behind when a hunk fails to match', async () => {
    writeFileSync(join(workspace, 'daily.md'), 'alpha\nbeta\n', 'utf8')
    const p = patch('*** Update File: daily.md', '-not-present', '+x')
    const { result } = await executeApplyPatch({ patch: p }, workspace, {
      vaultDir: workspace
    })
    expect(result).toMatch(/Error:.*patch did not apply at hunk/i)
    expect(readFileSync(join(workspace, 'daily.md'), 'utf8')).toBe('alpha\nbeta\n')
    expect(existsSync(join(workspace, '.trash'))).toBe(false)
  })
})
