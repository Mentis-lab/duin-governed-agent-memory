// Regression: the model-driven edit_file tool amputated hand-authored vault prose with no copy.
//
// Failing scenario this locks down: DUIN_AGUI_APPROVAL is unset ⇒ 'trusted-afk', and edit_file is
// not in AGUI_GATED_TOOLS, aguiTier('edit_file') is 'none' and requiresApproval is false — so no
// human confirms. The AFK operator says "trim the outdated Q2 section from my board brief". The
// model read_file's Outputs/board-brief.md, picks the 300-line span it judges outdated as
// old_string, and passes new_string = "". The span occurs exactly once, so the uniqueness check
// PASSES and the old executor did a bare writeFileSync of content.replace(oldS, '') — 300 lines of
// hand-authored markdown gone with no .trash copy, no _tombstones.jsonl line, and a tool card that
// said nothing but "Edited Outputs/board-brief.md". Meanwhile the three sibling executors in the
// SAME FILE all preserve (executeWriteNote snapshots, executeDeleteFile and executeMoveFile
// tombstone) and snapshotToTrash was already imported at the top of that module. Nothing else
// covers the loss: moat-backup never copies vault markdown and index-store's pruneToKeep drops the
// notes_chunks rows on the reindex this very write schedules.
//
// The sharp edge here is NOT a parse failure or a truncated generation — a perfectly correct reply
// doing exactly what the user asked is what destroys the content. edit_file's own description
// ("Prefer this over write_file … it never clobbers the rest") is what makes a well-behaved model
// reach for the one unprotected path, and write_file's safety stamp explicitly steers it here.
//
// These tests fail against the pre-fix executor (bare writeFileSync ⇒ no .trash, prior body gone,
// unqualified success string). Pure fs, no better-sqlite3 / electron in the import graph, so the
// suite really executes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeEditFile } from './agui-executors'
import { AGUI_TOOLS } from './agui-tools'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './vault-trash'

let vault: string

const Q2_SECTION =
  '## Q2 review\n' +
  Array.from({ length: 300 }, (_, i) => `line ${i + 1}: hand-authored Q2 analysis nobody can regenerate`).join('\n') +
  '\n'
const BRIEF = `# Board brief\n\nIntro paragraph.\n\n${Q2_SECTION}\n## Q3 outlook\n\nStill current.\n`

function seed(rel: string, body: string): string {
  const abs = join(vault, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, body, 'utf-8')
  return abs
}

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

function journal(): Record<string, string>[] {
  const p = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-edit-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('executeEditFile — preserve before editing in place', () => {
  it('snapshots the pre-edit body before a 300-line section is trimmed away', () => {
    const abs = seed('Outputs/board-brief.md', BRIEF)

    const res = executeEditFile(vault, 'Outputs/board-brief.md', Q2_SECTION, '')

    expect(res.ok).toBe(true)
    // The trim really happened — this is not a refuse-to-write fix.
    expect(readFileSync(abs, 'utf-8')).not.toContain('hand-authored Q2 analysis')
    expect(readFileSync(abs, 'utf-8')).toContain('## Q3 outlook')
    // …and the destroyed prose is still recoverable, byte-identical to the whole prior file.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe(BRIEF)
    // The caller is told where the prior content went.
    expect(res.ok && res.replaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('journals what was edited, from where, when and by whom', () => {
    seed('Outputs/board-brief.md', BRIEF)
    executeEditFile(vault, 'Outputs/board-brief.md', Q2_SECTION, '')

    const j = journal()
    expect(j).toHaveLength(1)
    expect(j[0].from).toBe('Outputs/board-brief.md')
    expect(j[0].actor).toBe('agent:edit_file')
    expect(j[0].op).toBe('overwrite')
    expect(j[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(j[0].reason).toContain('edit_file')
    expect(Number.isNaN(Date.parse(j[0].at))).toBe(false)
  })

  it('a SMALL surgical edit is preserved too — the replaced span is just as unrecoverable', () => {
    const abs = seed('Outputs/board-brief.md', BRIEF)

    const res = executeEditFile(vault, 'Outputs/board-brief.md', 'Still current.', 'Superseded.')

    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toContain('Superseded.')
    expect(readFileSync(join(vault, TRASH_DIR_NAME, trashFiles()[0]), 'utf-8')).toBe(BRIEF)
  })

  it('a no-op edit (new_string === old_string) snapshots nothing — one entry per actual alteration', () => {
    seed('Outputs/board-brief.md', BRIEF)
    const res = executeEditFile(vault, 'Outputs/board-brief.md', 'Still current.', 'Still current.')
    expect(res.ok).toBe(true)
    expect(res.ok && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('rejected edits write nothing and leave no tombstone', () => {
    seed('Outputs/board-brief.md', BRIEF)
    // not found / ambiguous / missing args / vault escape — all must abstain BEFORE snapshotting.
    expect(executeEditFile(vault, 'Outputs/board-brief.md', 'nowhere in the file', 'x')).toMatchObject({ ok: false })
    expect(executeEditFile(vault, 'Outputs/board-brief.md', 'Intro', '')).toMatchObject({ ok: true }) // unique
    seed('Outputs/dupes.md', 'same\nsame\n')
    expect(executeEditFile(vault, 'Outputs/dupes.md', 'same', 'x')).toMatchObject({ ok: false })
    expect(executeEditFile(vault, '../escape.md', 'a', 'b')).toMatchObject({ ok: false })
    expect(executeEditFile(vault, 'Outputs/board-brief.md', '', 'x')).toMatchObject({ ok: false })
    expect(readFileSync(join(vault, 'Outputs', 'dupes.md'), 'utf-8')).toBe('same\nsame\n')
    // Exactly the one legitimate edit above snapshotted.
    expect(trashFiles()).toHaveLength(1)
  })

  it('does not clobber an earlier snapshot when same-named notes are edited', () => {
    seed('00 Inbox/notes.md', 'FIRST\n')
    executeEditFile(vault, '00 Inbox/notes.md', 'FIRST', 'X')
    seed('01 Projects/notes.md', 'SECOND\n')
    executeEditFile(vault, '01 Projects/notes.md', 'SECOND', 'Y')

    const bodies = trashFiles().map((f) => readFileSync(join(vault, TRASH_DIR_NAME, f), 'utf-8')).sort()
    expect(bodies).toEqual(['FIRST\n', 'SECOND\n'])
  })

  it('refuses the destructive edit when the prior bytes cannot be preserved', () => {
    const abs = seed('Outputs/board-brief.md', BRIEF)
    // Make .trash un-creatable by planting a FILE where the trash DIRECTORY must go.
    writeFileSync(join(vault, TRASH_DIR_NAME), 'not a directory', 'utf-8')

    const res = executeEditFile(vault, 'Outputs/board-brief.md', Q2_SECTION, '')

    expect(res.ok).toBe(false)
    // The decisive part: proceeding blind is the one outcome that cannot be undone.
    expect(readFileSync(abs, 'utf-8')).toBe(BRIEF)
    rmSync(join(vault, TRASH_DIR_NAME), { force: true })
  })
})

// Preserving the prior body is only worth something if somebody is TOLD. The tombstone name is
// Date.now()-stamped and flattened into .trash, so an operator who is not told cannot guess it.
// This drives the REAL executor through the REAL dispatch registry — the path the brain loop takes.
describe('edit_file end-to-end — the preserved body reaches the model and the operator', () => {
  const run = (path: string, old_string: string, new_string: string): unknown =>
    AGUI_TOOLS.edit_file.execute({ notesDir: vault, threadId: '' } as never, { path, old_string, new_string })

  it('reports the snapshot, naming the real tombstone the operator can recover from', () => {
    seed('Outputs/board-brief.md', BRIEF)

    const modelFacing = AGUI_TOOLS.edit_file.out(run('Outputs/board-brief.md', Q2_SECTION, '') as never)

    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(modelFacing).toContain(`${TRASH_DIR_NAME}/${tombstones[0]}`)
    // A 300-line amputation must not render as a bare success.
    expect(modelFacing).not.toBe('Edited Outputs/board-brief.md')
  })

  it('the operator tool card also shows where the prior contents went', () => {
    seed('Outputs/board-brief.md', BRIEF)

    const card = AGUI_TOOLS.edit_file.end(run('Outputs/board-brief.md', Q2_SECTION, '') as never)

    expect(card).toContain(TRASH_DIR_NAME)
    expect(card).not.toBe('Edited Outputs/board-brief.md')
  })

  it('a no-op edit still renders byte-identically to before (no false alarm)', () => {
    seed('Outputs/board-brief.md', BRIEF)
    const noop = run('Outputs/board-brief.md', 'Intro paragraph.', 'Intro paragraph.')
    expect(AGUI_TOOLS.edit_file.out(noop as never)).toBe('Edited Outputs/board-brief.md')
    expect(AGUI_TOOLS.edit_file.end(noop as never)).toBe('Edited Outputs/board-brief.md')
  })
})
