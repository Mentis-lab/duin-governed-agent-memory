// REGRESSION: scheduleAction used to destroy the entire loops registry via an action that
// reported it had done nothing.
//
// The defect: loadLoopsRaw collapsed "unreadable" into "empty" — a YAML throw was caught and
// returned [], and `doc?.loops ?? []` returned [] with no exception at all when the top-level
// key was absent or renamed. writeLoops then bare-writeFileSync'd LOOPS_HEADER + a dump of
// whatever it was handed. pause/resume/remove called it UNCONDITIONALLY, before returning
// "no loop named 'x'" — and returned ok:true, so even a caller checking the boolean saw
// success. The file's own header invites the hand-edit that triggers it ("managed via /loops
// or loop_runner.py"), and .duin/ is a dotfolder the notes-watcher ignores, so there was no
// .bak, no snapshot and no journal line: schedule, executor, target prompts and notes were
// simply gone.
//
// Pattern A: the correct guards already existed in this same directory — binding-store routes
// its ledger rewrite through atomicWriteFileSync, and vault-trash exports snapshotToTrash.
// writeLoops used neither. Pattern B: the TOTAL failure (no file at all) was harmless, the
// PARTIAL one (file present, one typo) was fatal.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scheduleAction, listSchedules } from './loop-artifacts-native'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from '../local-brain/vault-trash'

const LOOPS_REL = ['.duin', 'loops', 'loops.yaml']

describe('scheduleAction — never destroys a registry it could not read', () => {
  let dir: string
  const loopsFile = (): string => join(dir, ...LOOPS_REL)
  const write = (body: string): void => {
    mkdirSync(join(dir, '.duin', 'loops'), { recursive: true })
    writeFileSync(loopsFile(), body, 'utf-8')
  }
  const onDisk = (): string => readFileSync(loopsFile(), 'utf-8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-loops-preserve-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  // The exact live scenario: four authored loops, one hand-appended note containing an
  // unquoted colon, then a pause on a loop the user remembers by name.
  const MALFORMED = `# DUIN loops registry — managed via /loops or loop_runner.py.
loops:
  - name: daily-digest
    schedule: {daily_at: "21:30"}
    run: {executor: brain, target: "summarise the day"}
  - name: harness-pulse
    schedule: {every_hours: 6}
    run: {executor: brain, target: "check the machine"}
    note: reminder: keep this one hourly
  - name: pre-trip
    schedule: {weekly_on: fri, at: "18:00"}
    run: {executor: signal, target: "pack list"}
  - name: eod-snapshot
    schedule: {daily_at: "23:00"}
    run: {executor: script, target: "snapshot.py"}
`

  const VALID_YAML_WRONG_KEY = `# DUIN loops registry — managed via /loops or loop_runner.py.
schedules:
  - name: daily-digest
    schedule: {daily_at: "21:30"}
    run: {executor: brain, target: "summarise the day"}
  - name: harness-pulse
    schedule: {every_hours: 6}
    run: {executor: brain, target: "check the machine"}
`

  it('pause on a malformed registry aborts, reports failure, and leaves every byte intact', () => {
    write(MALFORMED)
    const before = onDisk()

    const r = scheduleAction(dir, { action: 'pause', name: 'daily-digest' })

    // Must NOT report success for an action that could not be performed.
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not valid YAML/)
    // The whole point: the four definitions are still on disk, byte for byte.
    expect(onDisk()).toBe(before)
    expect(onDisk()).toContain('harness-pulse')
    expect(onDisk()).toContain('summarise the day')
    expect(onDisk()).not.toContain('loops: []')
  })

  it('the SILENT variant — a renamed top-level key — also aborts instead of wiping', () => {
    // Deliberately WELL-FORMED YAML so nothing throws — only the top-level key differs.
    // js-yaml parses it happily; `doc?.loops ?? []` then returned [] with no signal at all,
    // so this variant destroyed the file without even an exception to notice.
    write(VALID_YAML_WRONG_KEY)
    const before = onDisk()

    const r = scheduleAction(dir, { action: 'pause', name: 'daily-digest' })

    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/no top-level 'loops:' key/)
    expect(onDisk()).toBe(before)
  })

  it("`add` on a malformed registry refuses rather than replacing it with the one new loop", () => {
    write(MALFORMED)
    const before = onDisk()

    const r = scheduleAction(dir, { action: 'add', name: 'newbie', schedule: 'daily@08:00', target: 't' })

    expect(r.ok).toBe(false)
    expect(onDisk()).toBe(before)
    // The old code reported ok:true here and left a one-entry registry.
    expect(onDisk()).not.toContain('newbie')
  })

  it('remove/pause/resume of an unknown loop in a VALID registry leave the file untouched', () => {
    scheduleAction(dir, { action: 'add', name: 'keeper', schedule: 'daily@09:00', target: 't' })
    const before = onDisk()

    for (const action of ['remove', 'pause', 'resume'] as const) {
      const r = scheduleAction(dir, { action, name: 'ghost' })
      expect(r.ok).toBe(false)
      expect(r.message).toBe("no loop named 'ghost'")
      expect(onDisk()).toBe(before)
    }
    expect(listSchedules(dir).schedules.map((s) => s.name)).toEqual(['keeper'])
  })

  it('a real rewrite preserves the prior copy in .trash with a journal line (traceable)', () => {
    scheduleAction(dir, { action: 'add', name: 'a', schedule: 'daily@09:00', target: 't', note: 'authored' })
    const before = onDisk()

    const r = scheduleAction(dir, { action: 'pause', name: 'a' })
    expect(r.ok).toBe(true)

    // The prior bytes survive the lossy yaml.dump round-trip somewhere recoverable.
    const trash = join(dir, TRASH_DIR_NAME)
    expect(existsSync(trash)).toBe(true)
    const copies = readdirSync(trash).filter((f) => f !== TOMBSTONE_JOURNAL)
    expect(copies.length).toBeGreaterThan(0)
    expect(readFileSync(join(trash, copies[0]), 'utf-8')).toBe(before)

    // ...and what changed, when, and why is recorded.
    const journal = readFileSync(join(trash, TOMBSTONE_JOURNAL), 'utf-8').trim().split('\n')
    const entry = JSON.parse(journal[journal.length - 1]) as Record<string, string>
    expect(entry.op).toBe('overwrite')
    expect(entry.from).toBe('.duin/loops/loops.yaml')
    expect(entry.reason).toMatch(/pause 'a'/)
    expect(Date.parse(entry.at)).not.toBeNaN()

    // The intended mutation still happened.
    expect(listSchedules(dir).schedules.find((s) => s.name === 'a')!.enabled).toBe(false)
  })

  it('a fresh vault with no loops.yaml still accepts add (empty ≠ unreadable)', () => {
    const r = scheduleAction(dir, { action: 'add', name: 'first', schedule: 'every:6h', target: 't' })
    expect(r.ok).toBe(true)
    expect(listSchedules(dir).schedules.map((s) => s.name)).toEqual(['first'])
    // A brand-new file has no prior content, so nothing should have been trashed.
    expect(existsSync(join(dir, TRASH_DIR_NAME))).toBe(false)
  })
})

// The abort branch: vault-trash's documented caller contract is that a FAILED snapshot
// means the caller must not write. writeLoops honours it (loop-artifacts-native.ts:289),
// but nothing exercised it — the string "could not preserve the prior copy" appeared only
// in the source, in zero test files, so that `if (!snap.ok)` was deletable with a green
// suite and the registry would go back to being rewritten over an unpreserved original.
//
// This is the harder half of the guard to get right, and the one worth pinning: the
// snapshot failing is a PARTIAL failure on an otherwise perfectly VALID registry, so it
// fires on the healthy path — the same shape as every other defect in this audit.
describe('scheduleAction — refuses the rewrite when the prior copy cannot be preserved', () => {
  let dir: string
  const loopsFile = (): string => join(dir, '.duin', 'loops', 'loops.yaml')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-loops-nosnap-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  /** Block the recovery surface: a FILE where the .trash directory must go, so
   *  vault-trash's mkdir fails and the snapshot cannot be taken. Earlier setup
   *  writes may already have created the real directory, so clear it first. */
  const blockTrash = (): void => {
    rmSync(join(dir, TRASH_DIR_NAME), { recursive: true, force: true })
    writeFileSync(join(dir, TRASH_DIR_NAME), 'not a directory', 'utf-8')
  }

  it('leaves a VALID registry byte-identical when .trash cannot be created', () => {
    scheduleAction(dir, { action: 'add', name: 'daily-digest', schedule: 'daily@21:30', target: 'summarise the day' })
    scheduleAction(dir, { action: 'add', name: 'harness-pulse', schedule: 'every:6h', target: 'check the machine' })
    const before = readFileSync(loopsFile(), 'utf-8')

    blockTrash()
    const r = scheduleAction(dir, { action: 'pause', name: 'daily-digest' })

    // Refused, and said why — not a silent no-op, and not a success.
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/could not preserve the prior copy/i)
    // The registry is untouched: both loops, and the one we tried to pause still enabled.
    expect(readFileSync(loopsFile(), 'utf-8')).toBe(before)
    const names = listSchedules(dir).schedules
    expect(names.map((s) => s.name).sort()).toEqual(['daily-digest', 'harness-pulse'])
    expect(names.find((s) => s.name === 'daily-digest')!.enabled).toBe(true)
  })

  it('refuses remove too — the destructive action must not bypass the same gate', () => {
    scheduleAction(dir, { action: 'add', name: 'pre-trip', schedule: 'weekly:fri@18:00', target: 'pack list' })
    const before = readFileSync(loopsFile(), 'utf-8')

    blockTrash()
    const r = scheduleAction(dir, { action: 'remove', name: 'pre-trip' })

    expect(r.ok).toBe(false)
    expect(readFileSync(loopsFile(), 'utf-8')).toBe(before)
    expect(listSchedules(dir).schedules.map((s) => s.name)).toEqual(['pre-trip'])
  })

  // Guard-strength: the refusal must be caused by the blocked snapshot, not by the
  // action being rejected for some unrelated reason. Same calls, working .trash.
  it('performs the very same rewrite once .trash is available again', () => {
    scheduleAction(dir, { action: 'add', name: 'daily-digest', schedule: 'daily@21:30', target: 'summarise the day' })

    blockTrash()
    expect(scheduleAction(dir, { action: 'pause', name: 'daily-digest' }).ok).toBe(false)

    rmSync(join(dir, TRASH_DIR_NAME), { force: true })
    const r = scheduleAction(dir, { action: 'pause', name: 'daily-digest' })

    expect(r.ok).toBe(true)
    expect(listSchedules(dir).schedules.find((s) => s.name === 'daily-digest')!.enabled).toBe(false)
    expect(existsSync(join(dir, TRASH_DIR_NAME))).toBe(true)
  })
})
