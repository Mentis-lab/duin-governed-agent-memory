import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  codexAdapter,
  importAgentSystem,
  detectAgentSystems,
  type DetectedSystem
} from './import-agent-system'
import { ensureBrainRoot, BRAIN_DIRNAME, BRAIN_IDENTITY_FILE, BRAIN_CONFIG_FILE } from './brain-root'

let vault: string
let source: string

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'vault-'))
  source = mkdtempSync(join(tmpdir(), 'agent-source-'))
})
afterEach(() => {
  for (const d of [vault, source]) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

describe('codex adapter', () => {
  it('detects AGENTS.md in the vault and maps it to identity (copy)', () => {
    writeFileSync(join(vault, 'AGENTS.md'), '# Codex AGENTS\nproject rules', 'utf-8')
    const found = codexAdapter.detect(vault)
    const agentsEntry = found.find((f) => f.label.includes('AGENTS.md'))
    expect(agentsEntry).toBeTruthy()
    expect(agentsEntry?.contains.identity).toBe(true)

    const root = ensureBrainRoot(vault) as string
    const result = codexAdapter.mapInto(vault, root, 'copy')
    expect(result.ok).toBe(true)
    expect(result.summary.identity).toBe(true)
    expect(readFileSync(join(root, BRAIN_IDENTITY_FILE), 'utf-8')).toContain('project rules')
  })
})

// REGRESSION — copy-mode import used to blind-overwrite a HAND-WRITTEN
// `.brain/identity.md` with AGENTS.md. Nothing else in DUIN ever writes that file
// (import-agent-system is its only writer; ensureBrainRoot makes directories only), so its
// content is hand-authored by construction and nothing regenerates it. One unconfirmed
// "Copy" click destroyed it with no snapshot, no diff, no tombstone.
//
// Pattern B: the TOTAL-failure case was already guarded (an empty AGENTS.md abstains via
// `body.trim()`), but the destructive path fired on the NORMAL case — a valid, non-empty
// AGENTS.md. Pattern A: the right guard already existed nearby (vault-trash's
// snapshotToTrash, which memory-store, agui-executors and library-brain-bridge all call
// before their own overwrites); this call site was the one skipping it.
//
// The pre-existing suite only ever imported into an EMPTY .brain/, which is why it survived.
describe('copy-mode import preserves a pre-existing identity', () => {
  const HAND_WRITTEN = '# Who I am\nRick. Runs DUIN. Hand-written, never generated.'

  it('snapshots the prior identity into .trash and reports where it went', () => {
    writeFileSync(join(vault, 'AGENTS.md'), '# Codex AGENTS\nproject rules', 'utf-8')
    const root = ensureBrainRoot(vault) as string
    writeFileSync(join(root, BRAIN_IDENTITY_FILE), HAND_WRITTEN, 'utf-8')

    const result = codexAdapter.mapInto(vault, root, 'copy')
    expect(result.ok).toBe(true)
    expect(result.summary.identity).toBe(true)

    // The import is allowed to land (preserve+record, not refuse-to-write) …
    expect(readFileSync(join(root, BRAIN_IDENTITY_FILE), 'utf-8')).toContain('project rules')

    // … but the prior bytes must still exist somewhere, and the result must say where.
    expect(result.replaced).toBeTruthy()
    const tombstone = join(vault, result.replaced as string)
    expect(existsSync(tombstone)).toBe(true)
    expect(readFileSync(tombstone, 'utf-8')).toBe(HAND_WRITTEN)

    // …and the alteration is journaled: what moved, from where, when, by whom, why.
    const journal = readFileSync(join(vault, '.trash', '_tombstones.jsonl'), 'utf-8')
    const entry = JSON.parse(journal.trim().split('\n').pop() as string)
    expect(entry.actor).toBe('import-agent-system')
    expect(entry.op).toBe('overwrite')
    expect(entry.from).toContain(BRAIN_IDENTITY_FILE)
    expect(typeof entry.at).toBe('string')
  })

  it('snapshots nothing on a first-time import or an unchanged re-import', () => {
    writeFileSync(join(vault, 'AGENTS.md'), '# Codex AGENTS\nproject rules', 'utf-8')
    const root = ensureBrainRoot(vault) as string

    // First import: no identity.md existed, so there is nothing to preserve.
    const first = codexAdapter.mapInto(vault, root, 'copy')
    expect(first.ok).toBe(true)
    expect(first.replaced).toBeUndefined()
    expect(existsSync(join(vault, '.trash'))).toBe(false)

    // Content-addressed: re-importing identical bytes alters nothing, so .trash gets no
    // entry — one tombstone per ACTUAL alteration, not per click.
    const second = codexAdapter.mapInto(vault, root, 'copy')
    expect(second.ok).toBe(true)
    expect(second.replaced).toBeUndefined()
    expect(existsSync(join(vault, '.trash'))).toBe(false)
  })

  it('does not write when the prior identity cannot be preserved', () => {
    writeFileSync(join(vault, 'AGENTS.md'), '# Codex AGENTS\nproject rules', 'utf-8')
    const root = ensureBrainRoot(vault) as string
    writeFileSync(join(root, BRAIN_IDENTITY_FILE), HAND_WRITTEN, 'utf-8')
    // Occupy <vault>/.trash with a FILE so mkdirSync of the trash dir fails — the live
    // bytes are what's at risk, so proceeding blind is the one unacceptable outcome.
    writeFileSync(join(vault, '.trash'), 'not a directory', 'utf-8')

    const result = codexAdapter.mapInto(vault, root, 'copy')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('could not be preserved')
    expect(readFileSync(join(root, BRAIN_IDENTITY_FILE), 'utf-8')).toBe(HAND_WRITTEN)
  })
})

// REGRESSION — link-mode import used to fall back to an EMPTY config object whenever
// `.brain/config.json` failed to parse, then write that object back. A user who had
// link-imported two agent systems, whose config.json was later truncated (by a crash — or by
// this very function's own pre-atomic bare writeFileSync), lost BOTH earlier grounding links
// and every other persisted key on the next import. `linkedSources` is user-selected config
// that nothing regenerates, and config.json is excluded from indexing, so there was no second
// copy. `ok: true` came back to the UI; the only trace was a console.debug line.
//
// Pattern B: TOTAL failure was already safe (an ABSENT config creates a fresh one, losing
// nothing) and the HEALTHY case merged correctly — only the PARTIAL/corrupt case destroyed,
// which is the case that fires on otherwise-normal use. Pattern A: the exact guard already
// existed in a sibling module — capability-ledger's quarantineCorruptStore, at the identical
// catch-an-unparseable-JSON-store site — and this call site was the one skipping it.
//
// The pre-existing suite never exercised link mode against a non-empty config, which is why
// it survived.
describe('link-mode import preserves a corrupt config instead of clobbering it', () => {
  const linkOf = (root: string): { adapter: string; dir: string }[] =>
    (JSON.parse(readFileSync(join(root, BRAIN_CONFIG_FILE), 'utf-8')).linkedSources ?? []) as {
      adapter: string
      dir: string
    }[]
  const sidecarsIn = (root: string): string[] =>
    readdirSync(root).filter((f) => f.startsWith(BRAIN_CONFIG_FILE) && f.endsWith('.corrupt'))

  it('merges into a healthy config, preserving prior links and unrelated keys', () => {
    const root = ensureBrainRoot(vault) as string
    writeFileSync(
      join(root, BRAIN_CONFIG_FILE),
      JSON.stringify({ linkedSources: [{ adapter: 'codex', dir: '/prior/one' }], theme: 'dark' }),
      'utf-8'
    )

    const result = codexAdapter.mapInto(source, root, 'link')
    expect(result.ok).toBe(true)
    expect(result.warning).toBeUndefined()

    const cfg = JSON.parse(readFileSync(join(root, BRAIN_CONFIG_FILE), 'utf-8'))
    expect(cfg.linkedSources.map((l: { dir: string }) => l.dir)).toEqual(['/prior/one', source])
    expect(cfg.theme).toBe('dark')
    expect(sidecarsIn(root)).toEqual([])
  })

  it('quarantines a TRUNCATED config rather than overwriting the prior links away', () => {
    const root = ensureBrainRoot(vault) as string
    const healthy = JSON.stringify(
      {
        linkedSources: [
          { adapter: 'codex', dir: '/prior/one' },
          { adapter: 'codex', dir: '/prior/two' }
        ],
        theme: 'dark'
      },
      null,
      2
    )
    // Exactly what a crash mid-writeFileSync leaves behind: valid JSON prefix, no closing brace.
    const truncated = healthy.slice(0, Math.floor(healthy.length * 0.6))
    expect(() => JSON.parse(truncated)).toThrow()
    writeFileSync(join(root, BRAIN_CONFIG_FILE), truncated, 'utf-8')

    const result = codexAdapter.mapInto(source, root, 'link')

    // The import is allowed to land (preserve+record, not refuse-to-write) …
    expect(result.ok).toBe(true)
    expect(linkOf(root).map((l) => l.dir)).toEqual([source])

    // … but the prior bytes must still exist, byte-for-byte, under a stamped sidecar …
    const sidecars = sidecarsIn(root)
    expect(sidecars).toHaveLength(1)
    expect(readFileSync(join(root, sidecars[0] as string), 'utf-8')).toBe(truncated)
    // …stamped with WHEN, so successive corruptions can't collide or overwrite each other.
    expect(sidecars[0]).toMatch(/\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.corrupt$/)

    // … and the loss must be SURFACED, not just logged: ok:true with no warning is exactly the
    // silent-destruction shape this regression is about.
    expect(result.warning).toBeTruthy()
    expect(result.warning).toContain(sidecars[0] as string)
  })

  it('refuses to write when the corrupt config cannot be quarantined', () => {
    const root = ensureBrainRoot(vault) as string
    const bytes = '{"linkedSources": [{"adapter": "codex", "dir": "/prior/one"}'
    writeFileSync(join(root, BRAIN_CONFIG_FILE), bytes, 'utf-8')
    // Freeze the clock so the sidecar name is deterministic, then occupy it with a DIRECTORY so
    // renameSync fails: bytes we could not preserve must not be overwritten, and the import is
    // retryable.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-07-20T11:22:33.444Z'))
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      mkdirSync(join(root, `${BRAIN_CONFIG_FILE}.${stamp}.corrupt`), { recursive: true })

      const result = codexAdapter.mapInto(source, root, 'link')
      expect(result.ok).toBe(false)
      expect(result.error).toContain('could not be quarantined')
      // The live bytes are untouched — recoverable by hand.
      expect(readFileSync(join(root, BRAIN_CONFIG_FILE), 'utf-8')).toBe(bytes)
    } finally {
      vi.useRealTimers()
    }
  })

  it('creates a fresh config when none exists, with no sidecar', () => {
    const root = ensureBrainRoot(vault) as string
    const result = codexAdapter.mapInto(source, root, 'link')
    expect(result.ok).toBe(true)
    expect(result.warning).toBeUndefined()
    expect(linkOf(root).map((l) => l.dir)).toEqual([source])
    expect(sidecarsIn(root)).toEqual([])
  })
})

describe('importAgentSystem orchestration', () => {
  it('ensures the brain root then runs the adapter', () => {
    writeFileSync(join(vault, 'AGENTS.md'), '# Codex AGENTS\nproject rules', 'utf-8')
    // No .brain/ yet — importAgentSystem must scaffold it.
    expect(existsSync(join(vault, BRAIN_DIRNAME))).toBe(false)
    const result = importAgentSystem('codex', vault, 'copy', vault)
    expect(result.ok).toBe(true)
    expect(existsSync(join(vault, BRAIN_DIRNAME))).toBe(true)
    expect(result.summary.identity).toBe(true)
  })

  it('errors clearly on an unknown adapter', () => {
    const result = importAgentSystem('nope', source, 'copy', vault)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown agent system')
  })

  it('errors clearly when no vault is configured', () => {
    const result = importAgentSystem('codex', source, 'copy', null)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('No notes vault')
  })
})

describe('detectAgentSystems', () => {
  it('fans out over all adapters and returns a flat list of the right shape', () => {
    writeFileSync(join(vault, 'AGENTS.md'), 'codex rules', 'utf-8')

    const systems: DetectedSystem[] = detectAgentSystems(vault)
    expect(systems.some((s) => s.adapter === 'codex')).toBe(true)
    for (const s of systems) {
      expect(typeof s.label).toBe('string')
      expect(typeof s.dir).toBe('string')
      expect(s.contains).toHaveProperty('identity')
      expect(s.contains).toHaveProperty('skills')
    }
  })
})
