// memory-create-collision.test.ts — data-loss regression for the typed "create a new
// memory" path.
//
// The defect: MemoryEditor's create branch submits a FREE-TEXT name and writeMemoryFile
// derived the filename from memorySlug(name) with no collision check, then wrote at that
// path unconditionally. A new memory whose name slug-normalized onto an existing entry
// replaced that entry's entire contents — body, description and all — and the panel just
// showed the new draft where the old memory used to be.
//
// Two ways to land on a taken slug without noticing:
//   1. a punctuation/case variant of an existing name ("Feedback: no coauthor trailer!"
//      -> feedback_no_coauthor_trailer), and
//   2. SLUG_MAX=60 truncation in memory-frontmatter.ts, which maps ANY two names sharing
//      a 60-character prefix onto one file.
//
// This is the one call site that skipped a guard its own module already had: the legacy
// `memory:add` entrypoint has always run a uniqueness loop (pickAutoName) before writing,
// which is why that path never destroyed anything. The fix routes typed creates through
// the same loop, now shared as uniqueMemorySlug().
//
// The store is forced into its in-memory fallback so the suite does not need the
// Electron-ABI better-sqlite3 binding; the .md files on disk — what the defect destroys —
// are canonical either way.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let TEST_USER_DATA = join(tmpdir(), `lamprey-memcollide-test-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: { getPath: () => TEST_USER_DATA },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true }
}))

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      on() {
        return this
      },
      close: async () => undefined
    })
  }
}))

import * as memStore from './memory-store'
import { memorySlug } from './memory-frontmatter'

const ORIGINAL_NAME = 'feedback_no_coauthor_trailer'
const ORIGINAL_BODY =
  'Never append a Co-Authored-By trailer to commits. Theo signs his own work.'
const ORIGINAL_DESC = 'No co-author trailer on commits'

function memoryPath(name: string): string {
  return join(memStore.__memoryStoreTest.projectDir('__global__'), `${name}.md`)
}

function seedOriginal(): void {
  memStore.writeMemoryFile({
    name: ORIGINAL_NAME,
    description: ORIGINAL_DESC,
    type: 'feedback',
    body: ORIGINAL_BODY,
    projectSlug: '__global__'
  })
}

beforeEach(() => {
  TEST_USER_DATA = mkdtempSync(join(tmpdir(), `lamprey-memcollide-test-${process.pid}-`))
  mkdirSync(TEST_USER_DATA, { recursive: true })
  memStore.__memoryStoreTest.resetForTests()
  memStore.__memoryStoreTest.forceFallback()
  seedOriginal()
})

describe('memory create — a colliding name must not replace an existing entry', () => {
  it('preserves the original when a punctuation variant slugs onto its filename', () => {
    // Sanity: these two display names really do resolve to one file.
    expect(memorySlug('Feedback: no coauthor trailer!')).toBe(ORIGINAL_NAME)

    const created = memStore.writeMemoryFile({
      name: 'Feedback: no coauthor trailer!',
      description: 'A different note that happens to collide',
      type: 'feedback',
      body: 'Some unrelated draft the user just typed into the New-memory form.',
      projectSlug: '__global__',
      mode: 'create'
    })

    // The load-bearing assertion: the original memory still has its own body.
    const originalRaw = readFileSync(memoryPath(ORIGINAL_NAME), 'utf-8')
    expect(originalRaw).toContain(ORIGINAL_BODY)
    const original = memStore.readMemoryFile(ORIGINAL_NAME)
    expect(original?.body).toBe(ORIGINAL_BODY)
    expect(original?.description).toBe(ORIGINAL_DESC)

    // And the new entry landed somewhere of its own, rather than being refused.
    expect(created.name).not.toBe(ORIGINAL_NAME)
    expect(existsSync(memoryPath(created.name))).toBe(true)
    expect(created.body).toContain('unrelated draft')
    // The redirect is reported, not silent.
    expect(created.slugRedirectedFrom).toBe(ORIGINAL_NAME)
    expect(memStore.listMemoryFiles({ type: 'feedback' })).toHaveLength(2)
  })

  it('preserves the original when two long names share a 60-char slug prefix', () => {
    // Identical for exactly 60 slug characters, then they diverge — the shared prefix
    // ends at `…token_buffer`, which is where SLUG_MAX cuts.
    const first = 'Decision record: why we ripped out the streaming token buffer in the renderer'
    const second =
      'Decision record: why we ripped out the streaming token buffer in the main process'
    // SLUG_MAX truncation makes these one file.
    expect(memorySlug(first)).toBe(memorySlug(second))

    const a = memStore.writeMemoryFile({
      name: first,
      description: 'first record',
      type: 'project',
      body: 'The renderer buffer double-counted partial frames.',
      projectSlug: '__global__',
      mode: 'create'
    })
    const b = memStore.writeMemoryFile({
      name: second,
      description: 'second record',
      type: 'project',
      body: 'The main-process cache never evicted aborted runs.',
      projectSlug: '__global__',
      mode: 'create'
    })

    expect(b.name).not.toBe(a.name)
    expect(readFileSync(memoryPath(a.name), 'utf-8')).toContain('double-counted partial frames')
    expect(readFileSync(memoryPath(b.name), 'utf-8')).toContain('never evicted aborted runs')
    expect(memStore.listMemoryFiles({ type: 'project' })).toHaveLength(2)
  })

  it('still overwrites in place for an edit (the default mode is unchanged)', () => {
    // The editor locks the name field while editing precisely so the slug cannot move;
    // that path MUST keep landing on the same file, or every edit would fork a new entry.
    const edited = memStore.writeMemoryFile({
      name: ORIGINAL_NAME,
      description: ORIGINAL_DESC,
      type: 'feedback',
      body: `${ORIGINAL_BODY} Also: no emoji.`,
      projectSlug: '__global__'
    })

    expect(edited.name).toBe(ORIGINAL_NAME)
    expect(edited.slugRedirectedFrom).toBeUndefined()
    expect(memStore.readMemoryFile(ORIGINAL_NAME)?.body).toContain('Also: no emoji.')
    expect(memStore.listMemoryFiles({ type: 'feedback' })).toHaveLength(1)
  })

  it('does not suffix a create whose name is genuinely free', () => {
    const created = memStore.writeMemoryFile({
      name: 'Feedback: prefer text-mode pickers',
      description: 'AFK-friendly questions',
      type: 'feedback',
      body: 'Render pickers as numbered text so Discord shows them.',
      projectSlug: '__global__',
      mode: 'create'
    })
    expect(created.name).toBe('feedback_prefer_text_mode_pickers')
    expect(created.slugRedirectedFrom).toBeUndefined()
  })
})
