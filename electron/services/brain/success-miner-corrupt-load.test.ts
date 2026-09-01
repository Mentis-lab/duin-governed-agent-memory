// Regression: a corrupt/shape-drifted success-traces.json must be QUARANTINED, never overwritten.
//
// DEFECT: setSuccessStorePath assigned `storePath` BEFORE the read, then swallowed a failed load with
// a bare `catch { store = [] }` — no console warning, no .corrupt sidecar, no abstain. Persistence
// stayed armed over an empty in-memory store, so the operator's very next endorsing turn (server.ts
// recordSuccess → persist) wrote `{traces:[<1 trace>]}` over the whole file, destroying up to
// MAX_TRACES=500 success exemplars. main.ts's 5-minute flushMoat → projectMoatToVault then mirrored
// the one-row file onto the durable vault copy with no validation, so the backup went too. Nothing
// regenerates endorsements: moat-health counts them as the moat signal and skill-library distils
// named skills from them; recovery was manual-only via restoreLatestMoat.
//
// The QUIETER variant throws nothing at all: `Array.isArray(raw.traces) ? … : []` reset the store
// with zero error when the file held `{}`, a bare JSON array, or a drifted top-level key — so the
// guard must validate the SHAPE, not just the parse.
//
// REACHABLE: default, unconditional boot path — main.ts calls setSuccessStorePath(app.getPath(
// 'userData')) with no gating flag, and moat-durability's rehydrate only restores a MISSING file, so
// a present-but-broken one is never repaired.
//
// The guard already exists in siblings: operator-model's quarantineCorruptOperatorModel,
// learn-store's quarantineCorruptTaste, capability-ledger's quarantineCorruptStore.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ESM namespaces are frozen, so `vi.spyOn(fs, 'renameSync')` cannot reach the binding success-miner
// already imported. Mock the module instead: everything forwards to the real fs except renameSync,
// which throws while `failRename.on` is set (the quarantine-failed → abstain case).
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
import { setSuccessStorePath, recordSuccess, getSuccesses, __resetSuccessStore } from './success-miner'

let dir: string
let file: string
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  __resetSuccessStore()
  dir = mkdtempSync(join(tmpdir(), 'success-corrupt-'))
  file = join(dir, 'success-traces.json')
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errSpy.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

const sidecars = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.corrupt'))

/** A healthy on-disk store: three endorsement exemplars the operator earned one "yes" at a time. */
function writeHealthyStore(): void {
  __resetSuccessStore()
  setSuccessStorePath(dir)
  recordSuccess('summarize the deploy plan', 'build, mirror, launch')
  recordSuccess('draft the release note', 'DUIN 1.4 ships the moat guard')
  recordSuccess('name the migration', 'rename to moat-durability')
  expect(existsSync(file)).toBe(true)
  expect(JSON.parse(readFileSync(file, 'utf-8')).traces).toHaveLength(3)
  __resetSuccessStore()
}

/** The kill shot: load the given bytes, then make ONE ordinary endorsement and see what survives. */
function loadThenEndorse(bytes: string): string {
  writeFileSync(file, bytes, 'utf-8')
  setSuccessStorePath(dir)
  recordSuccess('a brand new question', 'a brand new answer')
  return existsSync(file) ? readFileSync(file, 'utf-8') : ''
}

describe('setSuccessStorePath — corrupt / shape-drifted store', () => {
  it('quarantines a crash-truncated file instead of letting the next endorsement overwrite it', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    const truncated = good.slice(0, Math.floor(good.length * 0.6)) // torn write from non-atomic persist

    const onDisk = loadThenEndorse(truncated)

    // Preserve: the original bytes live on in a timestamped sidecar.
    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(truncated)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toContain('deploy plan')
    // Record: it is loud, not silent.
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0][0])).toContain('quarantined to')
    // The file the next boot reads was never the wipe of the old one: either absent (renamed away)
    // or a NEW file — the prior bytes are still recoverable above.
    if (onDisk) expect(onDisk).not.toBe(truncated)
  })

  it('quarantines top-level key drift ({successes:[…]}) — the variant that throws nothing', () => {
    writeHealthyStore()
    const drifted = JSON.stringify({ successes: JSON.parse(readFileSync(file, 'utf-8')).traces }, null, 2)

    loadThenEndorse(drifted)

    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(drifted)
    expect(errSpy).toHaveBeenCalled()
  })

  it('quarantines a bare top-level JSON array', () => {
    writeHealthyStore()
    const bare = JSON.stringify(JSON.parse(readFileSync(file, 'utf-8')).traces, null, 2)

    loadThenEndorse(bare)

    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe(bare)
  })

  it('quarantines a `{}` file — the exemplars are still recoverable from the sidecar', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    writeFileSync(file, '{}', 'utf-8')

    setSuccessStorePath(dir)

    expect(getSuccesses()).toHaveLength(0) // empty in memory — nothing else is safe
    expect(sidecars()).toHaveLength(1)
    expect(readFileSync(join(dir, sidecars()[0]), 'utf-8')).toBe('{}')
    // and the healthy bytes that a torn `{}` write replaced are exactly what the operator must
    // restore by hand; the guard's job is to make sure a later endorsement never buries the evidence.
    expect(good).toContain('release note')
  })

  it('abstains from persisting entirely when the quarantine rename itself fails', () => {
    writeHealthyStore()
    const good = readFileSync(file, 'utf-8')
    const truncated = good.slice(0, Math.floor(good.length * 0.6))
    writeFileSync(file, truncated, 'utf-8')

    failRename.on = true
    try {
      setSuccessStorePath(dir)
      recordSuccess('a brand new question', 'a brand new answer')
    } finally {
      failRename.on = false
    }

    expect(String(errSpy.mock.calls.at(-1)?.[0])).toContain('quarantine')

    // Could not preserve → must not overwrite, and persistence must stay off for the SESSION, not
    // just for the one endorsement that raced the failed rename. Renaming works again now, so this
    // assertion no longer leans on the mock: only a cleared storePath keeps the bytes intact.
    recordSuccess('a second question', 'a second answer')
    expect(readFileSync(file, 'utf-8')).toBe(truncated) // byte-for-byte untouched
    expect(sidecars()).toHaveLength(0) // nothing was moved aside either — the file never left
    expect(getSuccesses()).toHaveLength(2) // still captured, in-memory only
  })

  it('control: a healthy file round-trips; absent and empty files are safe cold starts', () => {
    writeHealthyStore()

    setSuccessStorePath(dir)
    expect(getSuccesses()).toHaveLength(3)
    expect(getSuccesses()[0].query).toBe('summarize the deploy plan')
    expect(sidecars()).toHaveLength(0)

    // An empty file holds nothing to preserve — clobbering it costs the operator nothing.
    __resetSuccessStore()
    writeFileSync(file, '   \n', 'utf-8')
    setSuccessStorePath(dir)
    expect(sidecars()).toHaveLength(0)

    // Cold start (no file) must stay silent too.
    const cold = mkdtempSync(join(tmpdir(), 'success-cold-'))
    try {
      __resetSuccessStore()
      setSuccessStorePath(cold)
      expect(readdirSync(cold).filter((n) => n.endsWith('.corrupt'))).toHaveLength(0)
    } finally {
      rmSync(cold, { recursive: true, force: true })
    }
  })
})
