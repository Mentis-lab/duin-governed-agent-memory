// consolidate-memory-workflow.test.ts — data-loss regression for the "Consolidate"
// memory workflow.
//
// The defect: the abstain guard in resources/workflows/consolidate-memory.js read
//   if (writes.length === 0 && deleteNames.length === 0) return
// so a model reply that proposed deletions but no *usable* entries fell THROUGH the
// conjunction. The write loop then no-opped and the delete loop ran anyway, hard-
// unlinking hand-authored memory files with nothing written back. Total parse failure
// abstained; a partial/deviant-but-parseable reply destroyed — failure was strictly
// worse than success.
//
// These tests run the REAL workflow source through the REAL runWorkflow sandbox against
// the REAL memory-store on a temp userData dir, mirroring how electron/ipc/workflows.ts
// wires `deps.memory`. The store is forced into its in-memory fallback so the suite does
// not need the Electron-ABI better-sqlite3 binding; the .md files on disk (which is what
// the defect destroys) are canonical either way.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let TEST_USER_DATA = join(tmpdir(), `lamprey-consolidate-test-${process.pid}-${Date.now()}`)

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
import { runWorkflow, type WorkflowForkSeam } from './workflow-runner'
import { forkAgent } from './subagent-runner'
import { BUILT_IN_SUBAGENT_TYPES } from './subagent-types'

// The workflow under test, read from disk — not a copy. If the shipped script regresses,
// this suite fails.
const WORKFLOW_PATH = join(__dirname, '../../resources/workflows/consolidate-memory.js')
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, 'utf-8')

function makeSeam(reply: string): WorkflowForkSeam {
  return {
    forkAgent,
    forkDeps: {
      defaultModel: 'test-model',
      loadType: (name) =>
        Object.prototype.hasOwnProperty.call(BUILT_IN_SUBAGENT_TYPES, name)
          ? BUILT_IN_SUBAGENT_TYPES[name]
          : null,
      runner: async () => reply
    }
  }
}

/** Mirrors electron/ipc/workflows.ts — the real store behind the sandbox's memory API. */
function memoryDeps(): {
  list: (filter?: unknown) => unknown[]
  write: (input: unknown) => unknown
  delete: (name: string) => unknown
} {
  return {
    list: (filter?: unknown) =>
      memStore.listMemoryFiles(filter as Parameters<typeof memStore.listMemoryFiles>[0]),
    write: (input: unknown) =>
      memStore.writeMemoryFile(input as Parameters<typeof memStore.writeMemoryFile>[0]),
    delete: (name: string) => memStore.deleteMemoryFile(name)
  }
}

async function consolidate(reply: string): Promise<Record<string, unknown>> {
  const handle = runWorkflow(
    { script: WORKFLOW_SOURCE, args: { type: 'feedback' } },
    { forkSeam: makeSeam(reply), memory: memoryDeps() }
  )
  const result = await handle.promise
  return result.output as Record<string, unknown>
}

// Five hand-authored `feedback` memories, as the Memory panel editor would leave them.
const SEED = [
  { name: 'feedback_no_fake_polish', body: 'Do not add fake polish to drafts. Say the plain thing.' },
  { name: 'feedback_feishu_rich_format', body: 'Reply on Feishu with rich md-tag posts, never flattened markdown bullets.' },
  { name: 'feedback_obsidian_memory_bank', body: 'The Obsidian vault is the permanent memory bank. Read me.md at session start.' },
  { name: 'feedback_afk_defaults', body: 'When the user is AFK prefer text-mode pickers over clickable UI.' },
  { name: 'feedback_commit_style', body: 'Commit messages state the defect, the scenario, and the fix.' }
]

function seedMemories(): void {
  for (const entry of SEED) {
    memStore.writeMemoryFile({
      name: entry.name,
      description: entry.body.slice(0, 40),
      type: 'feedback',
      body: entry.body,
      projectSlug: '__global__'
    })
  }
}

function memoryPath(name: string): string {
  return join(memStore.__memoryStoreTest.projectDir('__global__'), `${name}.md`)
}

beforeEach(() => {
  TEST_USER_DATA = mkdtempSync(join(tmpdir(), `lamprey-consolidate-test-${process.pid}-`))
  mkdirSync(TEST_USER_DATA, { recursive: true })
  memStore.__memoryStoreTest.resetForTests()
  memStore.__memoryStoreTest.forceFallback()
  seedMemories()
})

describe('consolidate-memory — deletions require something written in their place', () => {
  it('does NOT delete when the reply proposes deletions but zero usable entries', async () => {
    // A well-formed, parseable reply — the exact shape that slipped past `&&`.
    const result = await consolidate(
      JSON.stringify({
        entries: [],
        deleteNames: [
          'feedback_no_fake_polish',
          'feedback_feishu_rich_format',
          'feedback_obsidian_memory_bank'
        ]
      })
    )

    expect(result.written).toBe(0)
    expect(result.deleted).toBe(0)
    // The load-bearing assertion: the files are still on disk.
    for (const entry of SEED) {
      expect(existsSync(memoryPath(entry.name))).toBe(true)
    }
    expect(memStore.listMemoryFiles({ type: 'feedback' })).toHaveLength(5)
  })

  it('abstains when `entries` is null rather than an array', async () => {
    const result = await consolidate(
      JSON.stringify({ entries: null, deleteNames: ['feedback_afk_defaults'] })
    )
    expect(result.deleted).toBe(0)
    expect(existsSync(memoryPath('feedback_afk_defaults'))).toBe(true)
  })

  it('abstains when the model renames the `entries` key', async () => {
    // `parsed.entries` is undefined -> coerced to [] while deleteNames survives intact:
    // the reply is valid JSON and the model clearly meant to keep things, but every
    // keeper is invisible to us. Deleting here would be pure loss.
    const result = await consolidate(
      JSON.stringify({
        memories: [{ name: 'feedback_style', body: 'merged' }],
        deleteNames: ['feedback_commit_style', 'feedback_afk_defaults']
      })
    )
    expect(result.written).toBe(0)
    expect(result.deleted).toBe(0)
    expect(existsSync(memoryPath('feedback_commit_style'))).toBe(true)
    expect(existsSync(memoryPath('feedback_afk_defaults'))).toBe(true)
  })

  it('leaves a consolidation delete recoverable in .trash', async () => {
    // Deletion is NOT gated on textual overlap — a near-duplicate merge legitimately
    // paraphrases. What makes an over-reaching deleteNames survivable is recoverability:
    // here the merge keeps none of the deleted entry's wording, and the bytes still
    // survive in .trash with a journal line saying where they came from.
    const original = readFileSync(memoryPath('feedback_obsidian_memory_bank'), 'utf-8')
    const result = await consolidate(
      JSON.stringify({
        entries: [
          { name: 'feedback_style', projectSlug: '__global__', description: 'style', body: 'Merged house style.' }
        ],
        deleteNames: ['feedback_obsidian_memory_bank']
      })
    )

    expect(result.deleted).toBe(1)
    expect(existsSync(memoryPath('feedback_obsidian_memory_bank'))).toBe(false)

    const trashDir = memStore.__memoryStoreTest.memoryTrashDir()
    const tombstones = readdirSync(trashDir).filter((f) => f.endsWith('.md'))
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(trashDir, tombstones[0]), 'utf-8')).toBe(original)
  })

  it('still performs a genuine consolidation of near-duplicates', async () => {
    const merged = `${SEED[0].body}\n${SEED[1].body}`
    const result = await consolidate(
      JSON.stringify({
        entries: [
          { name: 'feedback_style', projectSlug: '__global__', description: 'style', body: merged }
        ],
        deleteNames: ['feedback_no_fake_polish', 'feedback_feishu_rich_format']
      })
    )

    expect(result.written).toBe(1)
    expect(result.deleted).toBe(2)
    expect(existsSync(memoryPath('feedback_style'))).toBe(true)
    expect(existsSync(memoryPath('feedback_no_fake_polish'))).toBe(false)
  })
})

describe('consolidate-memory — the merge target survives a non-canonical proposed name', () => {
  // Two identity spaces meet in the delete loop and used not to be reconciled: the model's
  // RAW proposed name, and the canonical slug `memory.write` normalises it onto. Title-casing
  // is the common LLM slip (the prompt only *prefers* existing names), and it made the guard
  // miss, so the workflow deleted the entry it had just merged everything into.

  it('does not delete the entry it just wrote when the model title-cases the merge target', async () => {
    const merged = `${SEED[0].body}\n${SEED[1].body}`
    const result = await consolidate(
      JSON.stringify({
        entries: [
          {
            // memorySlug('Feedback No Fake Polish') === 'feedback_no_fake_polish' — this
            // write OVERWRITES the seeded entry rather than creating a new file.
            name: 'Feedback No Fake Polish',
            projectSlug: '__global__',
            description: 'style',
            body: merged
          }
        ],
        deleteNames: ['feedback_no_fake_polish', 'feedback_feishu_rich_format']
      })
    )

    // The load-bearing assertion: the merged entry is still on disk, holding the merge.
    expect(existsSync(memoryPath('feedback_no_fake_polish'))).toBe(true)
    expect(readFileSync(memoryPath('feedback_no_fake_polish'), 'utf-8')).toContain(SEED[1].body)

    // Only the entry that was genuinely folded away is gone.
    expect(result.written).toBe(1)
    expect(result.deleted).toBe(1)
    expect(existsSync(memoryPath('feedback_feishu_rich_format'))).toBe(false)

    // ...and it is still visible to the memory panel, under the name the caller is told.
    const names = memStore.listMemoryFiles({ type: 'feedback' }).map((f) => f.name)
    expect(names).toContain('feedback_no_fake_polish')
    expect(names).toHaveLength(4)
    expect(result.keptNames).toEqual(['feedback_no_fake_polish'])
  })

  it('reconciles the other shapes memorySlug collapses — hyphens and stray whitespace', async () => {
    // `deleteNames` is trimmed on the way in but the proposal is not, so a trailing space
    // alone was enough to split the two spaces.
    const result = await consolidate(
      JSON.stringify({
        entries: [
          {
            name: ' feedback-commit-style ',
            projectSlug: '__global__',
            description: 'commits',
            body: 'Merged commit + AFK conventions.'
          }
        ],
        deleteNames: ['feedback_commit_style', 'feedback_afk_defaults']
      })
    )

    expect(existsSync(memoryPath('feedback_commit_style'))).toBe(true)
    expect(readFileSync(memoryPath('feedback_commit_style'), 'utf-8')).toContain(
      'Merged commit + AFK conventions.'
    )
    expect(result.deleted).toBe(1)
    expect(existsSync(memoryPath('feedback_afk_defaults'))).toBe(false)
    expect(result.keptNames).toEqual(['feedback_commit_style'])
  })
})

describe('writeMemoryFile — an overwrite preserves the content it replaces', () => {
  it('snapshots the prior body when consolidation rewrites an EXISTING entry', async () => {
    // The delete half of a consolidation was already recoverable. The write half was not:
    // the workflow prompt explicitly says "Prefer existing names when keeping entries", so
    // the merge target is normally an existing hand-authored file, and `writeMemoryFile`
    // blind-`writeFileSync`'d straight over it. The entry the model KEEPS was the one whose
    // prior wording could not be recovered — worse than the ones it deleted.
    const original = readFileSync(memoryPath('feedback_no_fake_polish'), 'utf-8')
    expect(original).toContain('Do not add fake polish')

    const result = await consolidate(
      JSON.stringify({
        entries: [
          {
            name: 'feedback_no_fake_polish',
            projectSlug: '__global__',
            description: 'house style',
            // An aggressive-but-plausible merge that keeps none of the original wording.
            body: 'Write plainly and format Feishu replies richly.'
          }
        ],
        deleteNames: ['feedback_feishu_rich_format']
      })
    )
    expect(result.written).toBe(1)

    // The live file really was replaced — this is a rewrite, not a refusal to write.
    const live = readFileSync(memoryPath('feedback_no_fake_polish'), 'utf-8')
    expect(live).toContain('Write plainly and format Feishu replies richly.')
    expect(live).not.toContain('Do not add fake polish')

    // ...and the replaced bytes survive in the same .trash the deletes go to.
    const trashDir = memStore.__memoryStoreTest.memoryTrashDir()
    const bodies = readdirSync(trashDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(trashDir, f), 'utf-8'))
    expect(bodies).toContain(original)

    // The journal distinguishes a replacement from a removal, so a recovery can tell
    // which tombstone is a prior VERSION of a live file and which is a deleted entry.
    const journal = readFileSync(join(trashDir, '_tombstones.jsonl'), 'utf-8').trim()
    const records = journal.split('\n').map((line) => JSON.parse(line))
    const overwrite = records.find((r) => r.op === 'overwrite')
    expect(overwrite).toBeDefined()
    expect(overwrite.from).toContain('feedback_no_fake_polish')
    expect(overwrite.actor).toBe('memory-store')
    expect(overwrite.reason).toContain('feedback_no_fake_polish')
    expect(typeof overwrite.at).toBe('string')
  })

  it('does not churn .trash when a rewrite is byte-identical', () => {
    // Idempotent re-writes (an editor save with no edits, a re-run of the same workflow)
    // alter nothing, so they must not manufacture tombstones.
    const entry = SEED[0]
    memStore.writeMemoryFile({
      name: entry.name,
      description: entry.body.slice(0, 40),
      type: 'feedback',
      body: entry.body,
      projectSlug: '__global__'
    })

    const trashDir = memStore.__memoryStoreTest.memoryTrashDir()
    const tombstones = existsSync(trashDir)
      ? readdirSync(trashDir).filter((f) => f.endsWith('.md'))
      : []
    expect(tombstones).toHaveLength(0)
  })

  it('preserves the prior version on a plain editor edit too, not just consolidation', () => {
    // The seam is in the store, so every overwrite path inherits it — the panel editor,
    // the memory IPC handler, and any future writer.
    const original = readFileSync(memoryPath('feedback_commit_style'), 'utf-8')
    memStore.writeMemoryFile({
      name: 'feedback_commit_style',
      description: 'commits',
      type: 'feedback',
      body: 'Rewritten by hand.',
      projectSlug: '__global__'
    })

    const trashDir = memStore.__memoryStoreTest.memoryTrashDir()
    const bodies = readdirSync(trashDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(trashDir, f), 'utf-8'))
    expect(bodies).toContain(original)
    expect(readFileSync(memoryPath('feedback_commit_style'), 'utf-8')).toContain('Rewritten by hand.')
  })

  it('keeps createdAt stable across an overwrite', () => {
    // Guards the reason the snapshot COPIES rather than renames: the original inode's
    // birthtime is the entry's createdAt, and a rename-based snapshot would reset it on
    // every edit, making every edited memory look brand new.
    const before = memStore.readMemoryFile('feedback_afk_defaults')
    expect(before).not.toBeNull()

    memStore.writeMemoryFile({
      name: 'feedback_afk_defaults',
      description: 'afk',
      type: 'feedback',
      body: 'Changed body so the snapshot actually fires.',
      projectSlug: '__global__'
    })

    const after = memStore.readMemoryFile('feedback_afk_defaults')
    expect(after?.createdAt).toBe(before?.createdAt)
  })
})

describe('deleteMemoryFile — soft-deletes into <lamprey-memory>/.trash', () => {
  it('preserves the bytes and journals the removal instead of unlinking', () => {
    const original = readFileSync(memoryPath('feedback_afk_defaults'), 'utf-8')

    expect(memStore.deleteMemoryFile('feedback_afk_defaults')).toBe(true)
    expect(existsSync(memoryPath('feedback_afk_defaults'))).toBe(false)

    const trashDir = memStore.__memoryStoreTest.memoryTrashDir()
    const tombstones = readdirSync(trashDir).filter((f) => f.endsWith('.md'))
    expect(tombstones).toHaveLength(1)
    // The prior content survives byte-for-byte.
    expect(readFileSync(join(trashDir, tombstones[0]), 'utf-8')).toBe(original)

    // ...and the journal records what changed, when, and from where.
    const journal = readFileSync(join(trashDir, '_tombstones.jsonl'), 'utf-8').trim()
    const record = JSON.parse(journal.split('\n').pop() as string)
    expect(record.from).toContain('feedback_afk_defaults')
    expect(record.actor).toBe('memory-store')
    expect(typeof record.at).toBe('string')
  })

  it('does not resurrect tombstoned memories on the next scan', () => {
    memStore.deleteMemoryFile('feedback_afk_defaults')
    memStore.__memoryStoreTest.scanAndSync()

    const names = memStore.listMemoryFiles({ type: 'feedback' }).map((f) => f.name)
    expect(names).not.toContain('feedback_afk_defaults')
    expect(names).toHaveLength(4)
    // .trash must never be indexed as a project slug.
    expect(readdirSync(memStore.__memoryStoreTest.memoryBaseDir())).toContain('.trash')
  })
})
