import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// WHY THIS FILE EXISTS
//
// ac9c007 taught apply_patch to tombstone/snapshot instead of destroying, but the guard
// only fires when the executor is HANDED the vault path — `isInside(vaultDir, abs)` is
// false for `undefined`, so with no vaultDir the Update branch takes NO snapshot at all
// (apply-patch-tool.ts:434) and a delete tombstones into the workspace instead of the
// vault. Supplying that path is the job of ONE line in apply-patch-tool-pack.ts.
//
// Every test in apply-patch-tool.test.ts passes `vaultDir` explicitly, and no test file
// imported the pack at all — so that line could be deleted outright with a fully green
// suite. This is the audit's pattern A (the guard exists; exactly one call site wires it)
// applied to the wiring itself. These tests drive the REAL registered native tool.

const settings: { localBrainNotesDir?: unknown } = {}

// tool-registry pulls electron transitively in the node test env.
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-apply-patch-pack', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./settings-helper', () => ({
  readSettings: () => settings
}))

// Importing the pack registers apply_patch as a side effect.
import './apply-patch-tool-pack'
import { toolRegistry } from './tool-registry'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './local-brain/vault-trash'

function envelope(...lines: string[]): string {
  return ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
}

/** Tombstone/snapshot files in a .trash dir, excluding the journal. */
function trashEntries(root: string): string[] {
  const d = join(root, TRASH_DIR_NAME)
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL)
}

function trashBodies(root: string): string[] {
  return trashEntries(root).map((f) => readFileSync(join(root, TRASH_DIR_NAME, f), 'utf-8'))
}

async function runPatch(patch: string, workspacePath: string): Promise<string> {
  const r = await toolRegistry.executeNative('apply_patch', { patch }, { workspacePath })
  return typeof r === 'string' ? r : JSON.stringify(r)
}

const HAND_WRITTEN = [
  '# Kickoff notes',
  '',
  'Publisher terms: 70/30 after recoup, festival build due 2026-08.',
  'Do not lose this paragraph — it exists nowhere else.',
  ''
].join('\n')

describe('apply-patch pack — hands the executor the vault path (the call site, not the library)', () => {
  let vault: string
  // The workspace is a folder INSIDE the vault — the shape that makes this wiring matter,
  // and a real one: workspace-state's vaultWorkspaceFallback defaults the root to the vault.
  let workspace: string

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'app-patch-vault-'))
    workspace = join(vault, '01 Projects')
    mkdirSync(workspace, { recursive: true })
    settings.localBrainNotesDir = vault
  })

  afterEach(() => {
    delete settings.localBrainNotesDir
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('tombstones a deleted note into the VAULT .trash, not a per-workspace one', async () => {
    const note = join(workspace, 'kickoff-notes.md')
    writeFileSync(note, HAND_WRITTEN, 'utf8')

    const out = await runPatch(envelope('*** Delete File: kickoff-notes.md'), workspace)

    expect(out).toMatch(/Applied 1 change/)
    expect(existsSync(note)).toBe(false)
    // The bytes survive, in the ONE place recovery lives.
    expect(trashBodies(vault)).toContain(HAND_WRITTEN)
    // ...and recovery is not scattered into a second .trash under the subfolder.
    expect(trashEntries(workspace)).toEqual([])
  })

  it('snapshots the prior body before an Update overwrites a hand-authored note', async () => {
    // This is the case that fails SILENTLY without the wiring: no vaultDir means the
    // snapshot branch never runs, the update succeeds, and the prior paragraph is gone
    // with no tombstone and no journal line.
    const note = join(workspace, 'kickoff-notes.md')
    writeFileSync(note, HAND_WRITTEN, 'utf8')

    const out = await runPatch(
      envelope(
        '*** Update File: kickoff-notes.md',
        '@@ # Kickoff notes',
        '-Do not lose this paragraph — it exists nowhere else.',
        '+Rewritten by the model.'
      ),
      workspace
    )

    expect(out).toMatch(/Applied 1 change/)
    // The overwrite happened...
    expect(readFileSync(note, 'utf-8')).toContain('Rewritten by the model.')
    // ...and the destroyed paragraph is recoverable.
    const preserved = trashBodies(vault)
    expect(preserved.some((b) => b.includes('it exists nowhere else'))).toBe(true)
  })

  it('journals the removal so a later recovery can tell what was taken and by whom', async () => {
    writeFileSync(join(workspace, 'kickoff-notes.md'), HAND_WRITTEN, 'utf8')
    await runPatch(envelope('*** Delete File: kickoff-notes.md'), workspace)

    const journal = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
    expect(existsSync(journal)).toBe(true)
    const lines = readFileSync(journal, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(1)
    expect(String(lines[0].actor)).toBe('agent:apply_patch')
    expect(String(lines[0].from)).toContain('kickoff-notes.md')
  })

  // ── guard-strength: the wiring must not over-fire ──────────────────────────
  //
  // These pin the negative side so a future "just always snapshot everything" change
  // can't pass by making the assertions above trivially true.

  it('does NOT snapshot a workspace that is not the vault — a repo has version control', async () => {
    // Settings point at a DIFFERENT vault; the workspace is outside it.
    const elsewhere = mkdtempSync(join(tmpdir(), 'app-patch-repo-'))
    settings.localBrainNotesDir = vault
    try {
      writeFileSync(join(elsewhere, 'src.ts'), 'const a = 1\n', 'utf8')
      await runPatch(
        envelope('*** Update File: src.ts', '@@', '-const a = 1', '+const a = 2'),
        elsewhere
      )
      expect(readFileSync(join(elsewhere, 'src.ts'), 'utf-8')).toContain('const a = 2')
      // No snapshot in the vault for a file that was never in it.
      expect(trashEntries(vault)).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('still applies the patch when settings carry no vault at all (degrade, never crash)', async () => {
    delete settings.localBrainNotesDir
    const note = join(workspace, 'loose.md')
    writeFileSync(note, 'body\n', 'utf8')

    const out = await runPatch(envelope('*** Delete File: loose.md'), workspace)

    expect(out).toMatch(/Applied 1 change/)
    expect(existsSync(note)).toBe(false)
    // With no vault configured the executor falls back to the workspace root, so the
    // bytes are still recoverable — just not in the vault. This is exactly the state
    // the pack's one line exists to prevent, and asserting it here is what makes the
    // first two tests provably sensitive to that line rather than to the library.
    expect(trashBodies(workspace)).toContain('body\n')
    expect(trashEntries(vault)).toEqual([])
  })
})
