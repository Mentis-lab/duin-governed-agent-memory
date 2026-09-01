// note_date's PRECEDENCE, executed through the real reindex path.
//
// THE GAP THIS CLOSES. note-date.test.ts calls resolveNoteDate directly with unstripped text, so
// every rung passes there. The only production caller is reindexImpl, which reassigns
// `raw = stripFrontmatter(raw)` BEFORE resolving the date — and parseDateFromFrontmatter returns
// null unless the text starts with '---'. So the documented highest-precedence rung was
// unreachable in production while its unit suite stayed green: exactly the class of defect the
// unit test cannot see, because the property lives at the call site, not in the function.
//
// WHAT IS AT STAKE. note_date is persisted and then read by filesOutsideWindow, which is a
// DENYLIST over NON-NULL dates. A note dated only in frontmatter therefore did not fall back to
// "unknown" (which is admitted); it fell back to mtime, a confidently WRONG date, and was provably
// excluded from the very period it declares itself to be about. note-date.ts's own comment names
// this: "a wrong date is worse than no date".
//
// WHY node:sqlite. better-sqlite3 is built for Electron's ABI and throws under the node-env
// vitest, so a suite gated on nativeOk() would report PASS while executing nothing. Same thin
// shim as index-store-defer-stamp-node.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.hoisted(() => {
  process.env.DUIN_DISABLE_EMBEDDINGS = '1'
})

const opened = new Map<string, DatabaseSync>()
const VEC0_DDL = /CREATE VIRTUAL TABLE (IF NOT EXISTS )?notes_vec USING vec0\([^)]*\)/i

vi.mock('better-sqlite3', () => {
  class Shim {
    readonly raw: DatabaseSync
    private depth = 0

    constructor(path: string) {
      this.raw = new DatabaseSync(path)
      opened.set(path, this.raw)
    }

    pragma(source: string): unknown {
      this.raw.exec(`PRAGMA ${source}`)
      return []
    }

    exec(sql: string): void {
      this.raw.exec(
        sql.replace(VEC0_DDL, 'CREATE TABLE IF NOT EXISTS notes_vec (rowid INTEGER PRIMARY KEY, embedding BLOB)')
      )
    }

    prepare(sql: string): unknown {
      const stmt: StatementSync = this.raw.prepare(sql)
      return {
        run: (...args: unknown[]) => stmt.run(...(args as never[])),
        get: (...args: unknown[]) => stmt.get(...(args as never[])),
        all: (...args: unknown[]) => stmt.all(...(args as never[]))
      }
    }

    transaction<T>(fn: () => T): () => T {
      return (): T => {
        const nested = this.depth > 0
        const sp = `_tx${this.depth}`
        this.raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN')
        this.depth++
        try {
          const out = fn()
          this.raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
          return out
        } catch (e) {
          this.raw.exec(nested ? `ROLLBACK TO ${sp}` : 'ROLLBACK')
          throw e
        } finally {
          this.depth--
        }
      }
    }

    close(): void {
      this.raw.close()
    }
  }
  return { default: Shim }
})

vi.mock('../rag/vec-loader', () => ({
  isVecAvailable: (): boolean => false,
  loadSqliteVec: (): void => {}
}))

vi.mock('../rag/embeddings/service', () => ({
  getEmbeddingsService: (): never => {
    throw new Error('embeddings service must not be constructed in this suite')
  }
}))

vi.mock('../rag/loaders', () => ({
  loadDocument: async (file: string): Promise<{ kind: 'text'; text: string }> => ({
    kind: 'text',
    text: readFileSync(file, 'utf-8')
  }),
  isSupportedTextExtension: (name: string): boolean => name.toLowerCase().endsWith('.md'),
  isOfficeExtension: (): boolean => false,
  isIWorkExtension: (): boolean => false,
  isImageExtension: (): boolean => false,
  isAudioExtension: (): boolean => false,
  ocrEnabled: (): boolean => false,
  audioTranscribeEnabled: (): boolean => false
}))

vi.mock('./moat-backup', () => ({ backupMoatState: (): void => {} }))

import { reindex, setLocalBrainUserDataPath, __resetLocalBrainStoreForTest } from './index-store'

const utc = (s: string): number => Date.parse(`${s}T00:00:00Z`)
const MTIME = utc('2026-08-01') // a bulk edit long after the notes were written

let root: string
let userData: string
let vault: string

const handle = (): DatabaseSync => opened.get(join(userData, 'local-brain.db'))!

const dateRow = (file: string): { note_date: number | null; note_date_src: string | null } =>
  handle()
    .prepare('SELECT note_date, note_date_src FROM notes_files WHERE file = ?')
    .get(file) as { note_date: number | null; note_date_src: string | null }

/** Body long enough to survive chunking, with no date in it — the date must come from metadata. */
const body = (topic: string): string => `# ${topic}\n\n${`Prose about ${topic}. `.repeat(30)}`

function note(name: string, text: string): void {
  const p = join(vault, name)
  writeFileSync(p, text, 'utf-8')
  utimesSync(p, new Date(MTIME), new Date(MTIME))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'note-date-'))
  userData = join(root, 'userData')
  vault = join(root, 'vault')
  mkdirSync(userData, { recursive: true })
  mkdirSync(vault, { recursive: true })
  opened.clear()
  __resetLocalBrainStoreForTest()
  setLocalBrainUserDataPath(userData)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  __resetLocalBrainStoreForTest()
  rmSync(root, { recursive: true, force: true })
})

describe('reindex resolves note_date by the documented precedence', () => {
  it('reads the date from frontmatter, which stripFrontmatter removes before chunking', async () => {
    note('roadmap-review.md', `---\ndate: 2025-07-01\ntype: decision\n---\n\n${body('roadmap')}`)

    await reindex(vault)

    const row = dateRow('roadmap-review.md')
    expect(row.note_date_src).toBe('frontmatter')
    expect(row.note_date).toBe(utc('2025-07-01'))
  })

  it('lets frontmatter outrank a dated filename', async () => {
    note('2026-01-15-retro.md', `---\ndate: 2025-11-20\n---\n\n${body('retro')}`)

    await reindex(vault)

    const row = dateRow('2026-01-15-retro.md')
    expect(row.note_date_src).toBe('frontmatter')
    expect(row.note_date).toBe(utc('2025-11-20'))
  })

  it('accepts `created:` and quoted values', async () => {
    note('kickoff.md', `---\ncreated: '2025-03-09'\n---\n\n${body('kickoff')}`)

    await reindex(vault)

    expect(dateRow('kickoff.md').note_date).toBe(utc('2025-03-09'))
  })

  it('still falls back to the filename, then to mtime', async () => {
    note('2026-02-02-standup.md', body('standup'))
    note('undated.md', body('undated'))

    await reindex(vault)

    expect(dateRow('2026-02-02-standup.md').note_date_src).toBe('filename')
    expect(dateRow('2026-02-02-standup.md').note_date).toBe(utc('2026-02-02'))
    expect(dateRow('undated.md').note_date_src).toBe('mtime')
  })

  it('leaves the chunked text frontmatter-free', async () => {
    note('meeting.md', `---\ndate: 2025-07-01\nowner: rg\n---\n\n${body('meeting')}`)

    await reindex(vault)

    const texts = (
      handle().prepare('SELECT text FROM notes_chunks WHERE file = ?').all('meeting.md') as { text: string }[]
    ).map((r) => r.text)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.join('\n')).not.toContain('owner: rg')
  })
})
