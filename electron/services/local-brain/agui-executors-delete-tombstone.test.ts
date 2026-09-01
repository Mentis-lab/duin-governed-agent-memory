// Regression: the model-driven delete_file tool hard-unlinked hand-authored vault notes.
//
// Failing scenario this locks down: DUIN_AGUI_APPROVAL is unset ⇒ readAguiPosture returns
// 'trusted-afk' ⇒ decideAguiGate auto-allows tier 'irreversible-file' with only an audit
// event. The operator asks the brain to "clean up duplicate notes in 00 Inbox"; the model
// misjudges a hand-written note and emits delete_file. The old executor called
// unlinkSync(r.abs) — no backup covers vault notes (moat-backup snapshots only the claim
// ledger + construction cache) and index-store's pruneToKeep drops the notes_chunks rows on
// the reindex the unlink itself triggers, so the content was gone with no record of what
// changed or where it went. Meanwhile POST /state/doc/delete — the SAME logical operation,
// driven by a human who knows what they're deleting — soft-deleted to <vault>/.trash.
//
// These tests fail against the pre-fix executor (unlinkSync ⇒ no .trash, content gone).
// Pure fs, no better-sqlite3 / electron in the import graph, so the suite really executes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeDeleteFile, executeMoveFile } from './agui-executors'
import { AGUI_TOOLS } from './agui-tools'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './vault-trash'

let vault: string

const NOTE_BODY = '# 2026-03 strategy draft\n\nHand-written. Not a duplicate.\n'

function seed(rel: string, body = NOTE_BODY): string {
  const abs = join(vault, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf-8')
  return abs
}

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('executeDeleteFile — soft-delete, never unlink', () => {
  it('preserves the note content in <vault>/.trash instead of destroying it', () => {
    const abs = seed('00 Inbox/2026-03 strategy draft.md')

    const res = executeDeleteFile(vault, '00 Inbox/2026-03 strategy draft.md')

    expect(res.ok).toBe(true)
    // Removed from its original location…
    expect(existsSync(abs)).toBe(false)
    // …but the bytes still exist, recoverable, byte-identical.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe(NOTE_BODY)
    // And the caller is told where the prior content went.
    expect(res.ok && res.trashed).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('does not clobber an earlier tombstone when same-named notes are deleted', () => {
    seed('00 Inbox/notes.md', 'FIRST\n')
    executeDeleteFile(vault, '00 Inbox/notes.md')
    seed('01 Projects/notes.md', 'SECOND\n')
    executeDeleteFile(vault, '01 Projects/notes.md')

    const bodies = trashFiles().map((f) => readFileSync(join(vault, TRASH_DIR_NAME, f), 'utf-8')).sort()
    expect(bodies).toEqual(['FIRST\n', 'SECOND\n'])
  })

  it('journals what was removed, from where, by whom — the tombstone name loses the folder', () => {
    seed('00 Inbox/2026-03 strategy draft.md')
    executeDeleteFile(vault, '00 Inbox/2026-03 strategy draft.md')

    const journal = readFileSync(join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, string>)
    expect(journal).toHaveLength(1)
    expect(journal[0].from).toBe('00 Inbox/2026-03 strategy draft.md')
    expect(journal[0].actor).toBe('agent:delete_file')
    expect(journal[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(Number.isNaN(Date.parse(journal[0].at))).toBe(false)
  })

  it('still refuses directories and missing paths (no behaviour regression)', () => {
    mkdirSync(join(vault, '00 Inbox'), { recursive: true })
    expect(executeDeleteFile(vault, '00 Inbox')).toMatchObject({ ok: false })
    expect(executeDeleteFile(vault, 'nope.md')).toMatchObject({ ok: false })
    expect(trashFiles()).toEqual([])
  })
})

describe('executeMoveFile — same fix family: renameSync must not silently clobber', () => {
  it('tombstones the file already at the destination instead of overwriting it', () => {
    seed('00 Inbox/a.md', 'SOURCE\n')
    seed('01 Projects/a.md', 'PRE-EXISTING DESTINATION\n')

    const res = executeMoveFile(vault, '00 Inbox/a.md', '01 Projects/a.md')

    expect(res.ok).toBe(true)
    expect(readFileSync(join(vault, '01 Projects', 'a.md'), 'utf-8')).toBe('SOURCE\n')
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe('PRE-EXISTING DESTINATION\n')
    expect(res.ok && res.displaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('leaves no tombstone for the ordinary non-colliding move', () => {
    seed('00 Inbox/a.md', 'SOURCE\n')
    const res = executeMoveFile(vault, '00 Inbox/a.md', '01 Projects/a.md')
    expect(res.ok).toBe(true)
    expect(readFileSync(join(vault, '01 Projects', 'a.md'), 'utf-8')).toBe('SOURCE\n')
    expect(trashFiles()).toEqual([])
  })
})

// The executor preserving the bystander is only worth something if somebody is TOLD. The
// `displaced` field existed but had zero non-test consumers: agui-tools rendered
// `Moved {from} → {to}` for a collision and for a clean move alike, so the operator watching the
// tool card and the model deciding what to say next both saw an unqualified success. The
// tombstone name is stamped with Date.now() and flattened into .trash, so an operator who is never
// told has no reason to look and no way to guess the name. This drives the REAL executor through
// the REAL dispatch registry — the path the brain loop actually takes.
describe('move_file end-to-end — the displacement reaches the model and the operator', () => {
  const moveOut = (from: string, to: string): string => {
    const r = AGUI_TOOLS.move_file.execute({ notesDir: vault, threadId: '' }, { from, to })
    return AGUI_TOOLS.move_file.out(r as never)
  }
  const moveEnd = (from: string, to: string): string => {
    const r = AGUI_TOOLS.move_file.execute({ notesDir: vault, threadId: '' }, { from, to })
    return AGUI_TOOLS.move_file.end(r as never)
  }

  it('reports the displaced bystander, naming the real tombstone the operator can recover from', () => {
    seed('00 Inbox/meeting-notes.md', 'TODAY\n')
    seed('01 Projects/Acme/meeting-notes.md', 'THREE MONTHS OF HAND-WRITTEN HISTORY\n')

    const modelFacing = moveOut('00 Inbox/meeting-notes.md', '01 Projects/Acme/meeting-notes.md')

    // The bystander's bytes survived…
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe(
      'THREE MONTHS OF HAND-WRITTEN HISTORY\n'
    )
    // …and the result actually NAMES that tombstone, so the recovery path is reachable without
    // guessing a Date.now() filename.
    expect(modelFacing).toContain(`${TRASH_DIR_NAME}/${tombstones[0]}`)
    // The decisive assertion: a collision must not render as a clean move.
    expect(modelFacing).not.toBe('Moved 00 Inbox/meeting-notes.md → 01 Projects/Acme/meeting-notes.md')
  })

  it('the operator tool card also shows the displacement, not just the model', () => {
    seed('00 Inbox/README.md', 'NEW\n')
    seed('01 Projects/README.md', 'OLD HAND-WRITTEN\n')

    const card = moveEnd('00 Inbox/README.md', '01 Projects/README.md')

    expect(card).toContain('displaced')
    expect(card).toContain(TRASH_DIR_NAME)
    expect(card).not.toBe('Moved 00 Inbox/README.md → 01 Projects/README.md')
  })

  it('an ordinary move still renders byte-identically to before (no false alarm)', () => {
    seed('00 Inbox/a.md', 'SOURCE\n')
    expect(moveOut('00 Inbox/a.md', '01 Projects/a.md')).toBe('Moved 00 Inbox/a.md → 01 Projects/a.md')
    seed('00 Inbox/b.md', 'SOURCE\n')
    expect(moveEnd('00 Inbox/b.md', '01 Projects/b.md')).toBe('Moved 00 Inbox/b.md → 01 Projects/b.md')
  })
})
