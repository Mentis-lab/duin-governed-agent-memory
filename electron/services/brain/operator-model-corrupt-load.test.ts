// Regression: a corrupt/shape-drifted operator-model.json must be QUARANTINED, never overwritten.
//
// DEFECT: setOperatorModelPath assigned `storePath` BEFORE the read, then swallowed a failed load
// with a bare `catch { store = [] }` — no console.warn, no .corrupt sidecar, no abstain. Persistence
// stayed armed over an empty in-memory store, so the FIRST mutation of the session (recordFacts /
// setFact / seedFacts → persist) atomicWriteFileSync'd `{facts:[<1 new candidate>]}` over the whole
// file. Every promoted/provisional fact was destroyed, and so was the `vetoed` veto-memory — whose
// loss also removes the dedup entry (recordFacts rebuilds its `seen` set from the store), letting a
// fact the human explicitly rejected be re-added and re-grounded.
//
// The QUIETER variant throws nothing at all: `Array.isArray(raw.facts) ? raw.facts : []` yields an
// empty store with zero error when the top-level key drifted (`{operatorFacts:[…]}`) or the file is
// a bare JSON array — so the guard must validate the SHAPE, not just the parse.
//
// REACHABLE: default, unconditional load path — main.ts calls setOperatorModelPath at boot with no
// gating flag. moat-durability's rehydrateMoatFromVault only restores when the file is MISSING, and
// projectMoatToVault mirrors userData → vault every 5 min with no shrink guard, so the durable vault
// copy is clobbered too.
//
// The guard already exists in four siblings: learn-store's quarantineCorruptTaste (incl. the
// parsed-but-not-an-object case), import-agent-system's quarantineCorruptConfig, settings-file's
// quarantineCorruptSettings, capability-ledger's quarantineCorruptStore.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ESM namespaces are frozen, so `vi.spyOn(fs, 'renameSync')` cannot reach the binding
// operator-model already imported. Mock the module instead: everything forwards to the real fs
// except renameSync, which throws while `failRename.on` is set (the quarantine-failed → abstain case).
const failRename = vi.hoisted(() => ({ on: false }))
vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (failRename.on) throw new Error('EPERM: sidecar rename blocked')
      return actual.renameSync(...args)
    }
  }
})

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setOperatorModelPath,
  recordFacts,
  promoteFact,
  vetoFact,
  getAllOperatorFacts,
  __resetOperatorModel
} from './operator-model'

let dir: string
let file: string
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetOperatorModel()
  dir = mkdtempSync(join(tmpdir(), 'opmodel-corrupt-'))
  file = join(dir, 'operator-model.json')
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

const sidecars = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.corrupt'))

/** A healthy on-disk store: one human-promoted rule (→ provisional), one plain candidate,
 *  one vetoed (the veto-memory whose loss lets a rejected fact be re-added). */
function writeHealthyStore(): void {
  __resetOperatorModel()
  setOperatorModelPath(dir)
  expect(
    recordFacts([
      { fact: 'Operator ships on Fridays after the review gate' },
      { fact: 'Operator prefers terse commit messages' },
      { fact: 'Operator wants every meeting auto-summarised' }
    ])
  ).toBe(3)
  const all = getAllOperatorFacts()
  const byText = (t: string): string => all.find((f) => f.fact.includes(t))!.id
  expect(promoteFact(byText('Fridays'))).toBe(true)
  expect(vetoFact(byText('auto-summarised'), 'never do this')).toBe(true)
  expect(existsSync(file)).toBe(true)
  __resetOperatorModel()
}

/** The kill shot: load the given bytes, then make ONE ordinary mutation and see what survives. */
function loadThenMutate(bytes: string): { onDisk: string; added: number } {
  writeFileSync(file, bytes, 'utf-8')
  setOperatorModelPath(dir)
  const added = recordFacts([{ fact: 'Operator drinks coffee before standup' }])
  return { onDisk: existsSync(file) ? readFileSync(file, 'utf-8') : '', added }
}

describe('setOperatorModelPath — corrupt / shape-drifted store', () => {
  it('quarantines a crash-truncated file instead of letting the next persist overwrite it', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    const truncated = good.slice(0, Math.floor(good.length * 0.6)) // torn write

    const { onDisk } = loadThenMutate(truncated)

    // Preserve: the original bytes live on in a timestamped sidecar.
    expect(sidecars()).toHaveLength(1)
    const preserved = readFileSync(join(dir, sidecars()[0]), 'utf-8')
    expect(preserved).toBe(truncated)
    // Record: it is loud, not silent.
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0][0])).toContain('quarantined to')
    // The file the next boot reads was never the wipe: either absent (renamed away) or, if
    // persist rewrote it, it is a NEW file — the prior bytes are still recoverable above.
    if (onDisk) expect(onDisk).not.toBe(truncated)
  })

  it('quarantines top-level key drift ({operatorFacts:[…]}) — the variant that throws nothing', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    const drifted = JSON.stringify({ operatorFacts: JSON.parse(good).facts }, null, 2)

    loadThenMutate(drifted)

    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(drifted)
    expect(errSpy).toHaveBeenCalled()
  })

  it('quarantines a bare top-level JSON array', () => {
    writeHealthyStore()
    const bare = JSON.stringify(JSON.parse(readFileSync(file, 'utf-8')).facts, null, 2)

    loadThenMutate(bare)

    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(bare)
  })

  it('preserves the vetoed rows, so a human-rejected fact cannot be silently re-added', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    writeFileSync(file, good.slice(0, Math.floor(good.length * 0.6)), 'utf-8')
    setOperatorModelPath(dir)

    // The store is empty in memory (nothing else is safe), but the veto-memory is RECOVERABLE:
    // it is in the sidecar, not annihilated by an overwrite.
    const preserved = readFileSync(join(dir, sidecars()[0]), 'utf-8')
    expect(preserved).toContain('auto-summarised')
    expect(preserved).toContain('vetoed')
  })

  it('abstains from persisting entirely when the quarantine rename itself fails', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    const truncated = good.slice(0, Math.floor(good.length * 0.6))
    writeFileSync(file, truncated, 'utf-8')

    failRename.on = true
    try {
      setOperatorModelPath(dir)
      expect(recordFacts([{ fact: 'Operator drinks coffee before standup' }])).toBe(1)
    } finally {
      failRename.on = false
    }

    expect(String(errSpy.mock.calls.at(-1)?.[0])).toContain('quarantine')

    // Could not preserve → must not overwrite, and persistence must stay off for the SESSION,
    // not just for the one mutation that raced the failed rename. Renaming works again now, so
    // this assertion no longer leans on the mock: only a cleared storePath keeps the bytes intact.
    expect(recordFacts([{ fact: 'Operator reviews PRs before lunch each day' }])).toBe(1)
    expect(readFileSync(file, 'utf-8')).toBe(truncated) // byte-for-byte untouched
    expect(sidecars()).toHaveLength(0) // nothing was moved aside either — the file never left
  })

  it('control: a healthy file still round-trips and an absent file is not quarantined', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')

    setOperatorModelPath(dir)
    expect(getAllOperatorFacts()).toHaveLength(3)
    expect(getAllOperatorFacts().some((f) => f.status === 'provisional')).toBe(true) // promoteFact → provisional
    expect(getAllOperatorFacts().some((f) => f.status === 'vetoed')).toBe(true)
    expect(sidecars()).toHaveLength(0)
    expect(JSON.parse(good).facts).toHaveLength(3)

    // Cold start (no file) must stay silent — absent is safe, nothing to preserve.
    const cold = mkdtempSync(join(tmpdir(), 'opmodel-cold-'))
    try {
      __resetOperatorModel()
      setOperatorModelPath(cold)
      expect(readdirSync(cold).filter((n) => n.endsWith('.corrupt'))).toHaveLength(0)
    } finally {
      rmSync(cold, { recursive: true, force: true })
    }
  })
})
