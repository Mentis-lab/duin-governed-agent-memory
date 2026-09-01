// Regression: the model-driven write_file tool blind-overwrote hand-authored vault notes.
//
// Failing scenario this locks down: DUIN_AGUI_APPROVAL is unset ⇒ readAguiPosture returns
// 'trusted-afk', and write_file is deliberately NOT in AGUI_GATED_TOOLS (aguiTier('write_file')
// is 'none', so decideAguiGate short-circuits to allow/ungated) — so no human confirms. The AFK
// operator says "tidy up my meeting notes in DUIN/00 Inbox". The model read_file's a 400-line
// hand-written kickoff.md, decides to rewrite it cleanly, and calls write_file on the SAME path
// with a 40-line condensed body. The old executor did a bare writeFileSync: the 360 lines were
// unrecoverable — no .trash tombstone and no journal line (those exist only on the delete/move
// paths), moat-backup never touches vault markdown, and index-store's pruneToKeep DELETEs the
// notes_chunks rows on the reindex the write itself schedules, so the indexed copy went too.
// Meanwhile the sibling executors in the very same file (executeDeleteFile, executeMoveFile) both
// route through vault-trash, and memory-store's snapshotPriorVersion already snapshots before its
// own overwrite. This call site was the one skipping the guard.
//
// Pattern B (partial failure) is the sharp edge: a rewrite whose generation is cut off at the token
// cap writes a TRUNCATED body and still reported plain success ("Wrote file to <path>"), so a
// partly-successful reply destroyed more than an outright refusal would.
//
// These tests fail against the pre-fix executor (bare writeFileSync ⇒ no .trash, prior body gone,
// unqualified success string). Pure fs, no better-sqlite3 / electron in the import graph, so the
// suite really executes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeWriteNote } from './agui-executors'
import { AGUI_TOOLS } from './agui-tools'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './vault-trash'

let vault: string

const HAND_WRITTEN = Array.from({ length: 400 }, (_, i) => `line ${i + 1}: hand-written kickoff detail`).join('\n') + '\n'
const CONDENSED = Array.from({ length: 40 }, (_, i) => `tidy line ${i + 1}`).join('\n') + '\n'

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
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-write-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('executeWriteNote — preserve before overwrite', () => {
  it('snapshots the hand-authored body to .trash before the condensing rewrite lands', () => {
    const abs = seed('00 Inbox/kickoff.md', HAND_WRITTEN)

    const res = executeWriteNote(vault, '00 Inbox/kickoff.md', CONDENSED)

    expect(res.ok).toBe(true)
    // The rewrite really happened — this is not a refuse-to-write fix.
    expect(readFileSync(abs, 'utf-8')).toBe(CONDENSED)
    // …and the 400 hand-written lines are still recoverable, byte-identical.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe(HAND_WRITTEN)
    // The caller is told where the prior content went.
    expect(res.ok && res.replaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('journals what was replaced, from where, when and by whom', () => {
    seed('00 Inbox/kickoff.md', HAND_WRITTEN)
    executeWriteNote(vault, '00 Inbox/kickoff.md', CONDENSED)

    const j = journal()
    expect(j).toHaveLength(1)
    expect(j[0].from).toBe('00 Inbox/kickoff.md')
    expect(j[0].actor).toBe('agent:write_file')
    expect(j[0].op).toBe('overwrite')
    expect(j[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(Number.isNaN(Date.parse(j[0].at))).toBe(false)
  })

  it('pattern B — a TRUNCATED rewrite is exactly the case that must stay recoverable', () => {
    const abs = seed('00 Inbox/kickoff.md', HAND_WRITTEN)
    // Generation hit the token cap mid-sentence.
    const truncated = '# Kickoff\n\n- attendees: Theo, Dana\n- decisions: we agreed to sh'

    const res = executeWriteNote(vault, '00 Inbox/kickoff.md', truncated)

    expect(res.ok).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toBe(truncated)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, trashFiles()[0]), 'utf-8')).toBe(HAND_WRITTEN)
  })

  it('creating a NEW file leaves no tombstone (no false alarm, no .trash churn)', () => {
    const res = executeWriteNote(vault, '00 Inbox/brand-new.md', CONDENSED)
    expect(res.ok).toBe(true)
    expect(res.ok && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('an IDENTICAL rewrite snapshots nothing — one entry per actual alteration, not per save', () => {
    seed('00 Inbox/kickoff.md', HAND_WRITTEN)
    const res = executeWriteNote(vault, '00 Inbox/kickoff.md', HAND_WRITTEN)
    expect(res.ok).toBe(true)
    expect(res.ok && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('does not clobber an earlier snapshot when same-named notes are rewritten', () => {
    seed('00 Inbox/notes.md', 'FIRST\n')
    executeWriteNote(vault, '00 Inbox/notes.md', 'X\n')
    seed('01 Projects/notes.md', 'SECOND\n')
    executeWriteNote(vault, '01 Projects/notes.md', 'Y\n')

    const bodies = trashFiles().map((f) => readFileSync(join(vault, TRASH_DIR_NAME, f), 'utf-8')).sort()
    expect(bodies).toEqual(['FIRST\n', 'SECOND\n'])
  })

  it('still rejects vault escapes and bad extensions, and writes nothing when it does', () => {
    expect(executeWriteNote(vault, '../escape.md', 'x')).toMatchObject({ ok: false })
    expect(executeWriteNote(vault, 'note.exe', 'x')).toMatchObject({ ok: false })
    expect(executeWriteNote(vault, '', 'x')).toMatchObject({ ok: false })
    expect(trashFiles()).toEqual([])
  })

  it('refuses the destructive write when the prior bytes cannot be preserved', () => {
    const abs = seed('00 Inbox/kickoff.md', HAND_WRITTEN)
    // Make .trash un-creatable by planting a FILE where the trash DIRECTORY must go.
    writeFileSync(join(vault, TRASH_DIR_NAME), 'not a directory', 'utf-8')

    const res = executeWriteNote(vault, '00 Inbox/kickoff.md', CONDENSED)

    expect(res.ok).toBe(false)
    // The decisive part: proceeding blind is the one outcome that cannot be undone.
    expect(readFileSync(abs, 'utf-8')).toBe(HAND_WRITTEN)
    rmSync(join(vault, TRASH_DIR_NAME), { force: true })
  })
})

// Preserving the prior body is only worth something if somebody is TOLD. `replaced` would otherwise
// have zero non-test consumers: agui-tools rendered `Wrote file to {path}` for a fresh create and for
// a 400-line obliteration alike, so the operator watching the tool card and the model deciding what
// to say next both saw an unqualified success. This drives the REAL executor through the REAL
// dispatch registry — the path the brain loop actually takes.
describe('write_file end-to-end — the replacement reaches the model and the operator', () => {
  const run = (path: string, content: string): unknown =>
    AGUI_TOOLS.write_file.execute({ notesDir: vault, threadId: '' } as never, { path, content })

  it('reports the replacement, naming the real tombstone the operator can recover from', () => {
    seed('00 Inbox/kickoff.md', HAND_WRITTEN)

    const modelFacing = AGUI_TOOLS.write_file.out(run('00 Inbox/kickoff.md', CONDENSED) as never)

    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(modelFacing).toContain(`${TRASH_DIR_NAME}/${tombstones[0]}`)
    // An overwrite must not render as a clean create.
    expect(modelFacing).not.toBe('Wrote file to 00 Inbox/kickoff.md')
  })

  it('the operator tool card also shows the replacement, not just the model', () => {
    seed('00 Inbox/kickoff.md', HAND_WRITTEN)

    const card = AGUI_TOOLS.write_file.end(run('00 Inbox/kickoff.md', CONDENSED) as never)

    expect(card).toContain('replaced')
    expect(card).toContain(TRASH_DIR_NAME)
    expect(card).not.toBe('Wrote file to 00 Inbox/kickoff.md')
  })

  it('an ordinary create still renders byte-identically to before (no false alarm)', () => {
    expect(AGUI_TOOLS.write_file.out(run('00 Inbox/fresh.md', CONDENSED) as never)).toBe(
      'Wrote file to 00 Inbox/fresh.md'
    )
    expect(AGUI_TOOLS.write_file.end(run('00 Inbox/fresh2.md', CONDENSED) as never)).toBe(
      'Wrote file to 00 Inbox/fresh2.md'
    )
  })
})
