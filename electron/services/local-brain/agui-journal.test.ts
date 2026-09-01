import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The journal writes under app.getPath('userData'), so the electron stub owns the temp dir.
let USER_DATA = ''
vi.mock('electron', () => ({ app: { getPath: () => USER_DATA } }))

const { openTurnJournal, shouldJournalFrame, journalEnabled, pruneTurnJournals } = await import('./agui-journal')

const JOURNAL_DIR = (): string => join(USER_DATA, 'agui-journal')
const readJournal = (runId: string): Record<string, unknown>[] =>
  readFileSync(join(JOURNAL_DIR(), `${runId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

beforeEach(() => {
  USER_DATA = mkdtempSync(join(tmpdir(), 'duin-journal-'))
  delete process.env.DUIN_TURN_JOURNAL
})
afterEach(() => {
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* best-effort */ }
  delete process.env.DUIN_TURN_JOURNAL
})

describe('shouldJournalFrame — the hot-path filter', () => {
  // sseFrame runs on the Electron MAIN thread for EVERY content delta. Journalling those
  // individually is what would re-create the page-open freezes the perf work removed.
  it('excludes the high-volume delta frames', () => {
    expect(shouldJournalFrame('TEXT_MESSAGE_CONTENT')).toBe(false)
    expect(shouldJournalFrame('REASONING')).toBe(false)
  })
  it('includes the semantic frames', () => {
    for (const t of ['TOOL_CALL_START', 'TOOL_CALL_END', 'STEP', 'RUN_ERROR', 'RUN_FINISHED', 'ARTIFACT']) {
      expect(shouldJournalFrame(t)).toBe(true)
    }
  })
  it('ignores a frame with no usable type', () => {
    expect(shouldJournalFrame(undefined)).toBe(false)
    expect(shouldJournalFrame('')).toBe(false)
    expect(shouldJournalFrame(42)).toBe(false)
  })
})

describe('journalEnabled', () => {
  it('is on by default and off only for an explicit 0', () => {
    expect(journalEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(journalEnabled({ DUIN_TURN_JOURNAL: '0' } as never)).toBe(false)
    expect(journalEnabled({ DUIN_TURN_JOURNAL: '1' } as never)).toBe(true)
  })
})

describe('openTurnJournal — the durable record', () => {
  it('writes TURN_START, the semantic frames, and TURN_END, in order', async () => {
    const j = openTurnJournal('run-a', { threadId: 't1' })
    j.note({ type: 'TOOL_CALL_START', toolName: 'read_file' })
    j.note({ type: 'TEXT_MESSAGE_CONTENT', delta: 'hello' }) // must not appear
    j.note({ type: 'TOOL_CALL_END', result: 'ok' })
    await j.close({ aborted: false, answerChars: 5 })

    const rows = readJournal('run-a')
    expect(rows.map((r) => r.type)).toEqual(['TURN_START', 'TOOL_CALL_START', 'TOOL_CALL_END', 'TURN_END'])
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]) // monotonic, no gaps for filtered frames
    expect(rows[0].threadId).toBe('t1')
    expect(rows[3].answerChars).toBe(5)
  })

  // The hole this whole file exists to close.
  it('records the turn even when it was ABORTED', async () => {
    const j = openTurnJournal('run-abort')
    j.note({ type: 'TOOL_CALL_START', toolName: 'run_command' })
    await j.close({ aborted: true, answerChars: 0 })
    const rows = readJournal('run-abort')
    expect(rows.at(-1)).toMatchObject({ type: 'TURN_END', aborted: true })
    expect(rows.some((r) => r.type === 'TOOL_CALL_START')).toBe(true)
  })

  it('flushes incrementally on a long turn rather than holding everything to the end', async () => {
    const j = openTurnJournal('run-long')
    for (let i = 0; i < 30; i++) j.note({ type: 'STEP', label: `s${i}` })
    // The buffer threshold (25) has been crossed, so a flush is already in flight before close().
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(JOURNAL_DIR(), 'run-long.jsonl'))).toBe(true)
    await j.close({ aborted: false })
    expect(readJournal('run-long').length).toBe(32) // START + 30 steps + END
  })

  it('is a no-op when disabled', async () => {
    process.env.DUIN_TURN_JOURNAL = '0'
    const j = openTurnJournal('run-off')
    j.note({ type: 'STEP' })
    await j.close({ aborted: false })
    expect(existsSync(join(JOURNAL_DIR(), 'run-off.jsonl'))).toBe(false)
  })

  // A journal failure must never surface into the turn — it is diagnostics, not the product.
  it('survives an unserializable frame without throwing', async () => {
    const j = openTurnJournal('run-circular')
    const circular: Record<string, unknown> = { type: 'STEP' }
    circular.self = circular
    expect(() => j.note(circular)).not.toThrow()
    await expect(j.close({ aborted: false })).resolves.toBeUndefined()
    expect(readJournal('run-circular').some((r) => r.type === 'unserializable')).toBe(true)
  })
})

describe('readRecentTurns — the read path', () => {
  it('summarizes turns newest-first and flags an incomplete one', async () => {
    const { readRecentTurns } = await import('./agui-journal')
    const done = openTurnJournal('run-done', { threadId: 't-done' })
    done.note({ type: 'STEP' })
    await done.close({ aborted: false, answerChars: 42 })

    // A turn the app died in the middle of: TURN_START + frames, no TURN_END.
    const killed = openTurnJournal('run-killed', { threadId: 't-killed' })
    for (let i = 0; i < 30; i++) killed.note({ type: 'TOOL_CALL_START', toolName: 't' })
    await new Promise((r) => setTimeout(r, 60)) // let the threshold flush land

    const turns = await readRecentTurns()
    const byId = Object.fromEntries(turns.map((t) => [t.runId, t]))
    expect(byId['run-done'].incomplete).toBe(false)
    expect(byId['run-done'].end).toMatchObject({ answerChars: 42 })
    expect(byId['run-done'].threadId).toBe('t-done')
    expect(byId['run-killed'].incomplete).toBe(true)
    expect(byId['run-killed'].frames).toBeGreaterThan(1)
  })

  it('tolerates a torn tail rather than failing the whole read', async () => {
    const { readRecentTurns } = await import('./agui-journal')
    mkdirSync(JOURNAL_DIR(), { recursive: true })
    writeFileSync(join(JOURNAL_DIR(), 'torn.jsonl'), '{"seq":1,"type":"TURN_START"}\n{"seq":2,"ty')
    const turns = await readRecentTurns()
    expect(turns.find((t) => t.runId === 'torn')?.frames).toBe(1)
  })

  it('is empty and quiet with no directory', async () => {
    const { readRecentTurns } = await import('./agui-journal')
    await expect(readRecentTurns()).resolves.toEqual([])
  })
})

describe('pruneTurnJournals — retention', () => {
  it('removes journals past the window and keeps fresh ones', async () => {
    mkdirSync(JOURNAL_DIR(), { recursive: true })
    const old = join(JOURNAL_DIR(), 'old.jsonl')
    const fresh = join(JOURNAL_DIR(), 'fresh.jsonl')
    writeFileSync(old, '{}\n')
    writeFileSync(fresh, '{}\n')
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(old, longAgo, longAgo)

    expect(await pruneTurnJournals()).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('is quiet when the directory does not exist', async () => {
    await expect(pruneTurnJournals()).resolves.toBe(0)
  })
})
