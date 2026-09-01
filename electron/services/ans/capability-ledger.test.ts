// Regression: capability-ledger persistence must be crash-safe AND a corrupt ledger must be
// quarantined before seedCapabilities() overwrites it.
//
// Defect: persist() used a bare writeFileSync (open 'w' = truncate in place, no fsync) while both
// siblings in this directory route through atomicWriteDurable. A torn ans-capabilities.json makes
// the next boot's JSON.parse throw into `catch { store = [] }`, and boot's very next call —
// seedCapabilities() — persists three defaults over the file. Every earned rung, ratify history,
// revert count and non-seed capability id is gone, silently.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setCapabilityLedgerPath,
  registerCapability,
  recordFeedback,
  getCapability,
  seedCapabilities,
  __resetCapabilityLedger
} from './capability-ledger'
import { atomicWriteDurable } from '../brain/durable-write'

// Spy that DELEGATES to the real crash-safe primitive — we assert it is on the write path
// without changing behaviour for the rest of the suite.
vi.mock('../brain/durable-write', async (importOriginal) => {
  const real = await importOriginal<typeof import('../brain/durable-write')>()
  return { ...real, atomicWriteDurable: vi.fn(real.atomicWriteDurable) }
})

let ud: string
beforeEach(() => {
  ud = mkdtempSync(join(tmpdir(), 'duin-caps-'))
  __resetCapabilityLedger()
})
afterEach(() => rmSync(ud, { recursive: true, force: true }))

const LEDGER = 'ans-capabilities.json'

describe('capability-ledger durability (data-loss regression)', () => {
  it('persist() routes through atomicWriteDurable, not a truncate-in-place writeFileSync', () => {
    vi.mocked(atomicWriteDurable).mockClear()
    setCapabilityLedgerPath(ud)
    registerCapability({ id: 'earned-cap', title: 'Consolidate a closed topic', rung: 'reflexive' })
    recordFeedback('earned-cap', 'ratify')

    // Every persist (register + feedback) went through the crash-safe primitive.
    const calls = vi.mocked(atomicWriteDurable).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every(([p]) => p === join(ud, LEDGER))).toBe(true)

    // ...and it really wrote: no stray tmp left behind, file parses, state is there.
    const files = readdirSync(ud)
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([])
    const parsed = JSON.parse(readFileSync(join(ud, LEDGER), 'utf-8'))
    expect(parsed.capabilities.map((c: { id: string }) => c.id)).toContain('earned-cap')
  })

  it('a torn ledger is QUARANTINED, not silently overwritten by the boot reseed', () => {
    // Boot 1: real earned state — a non-seed capability plus human-derived ratify/revert history.
    setCapabilityLedgerPath(ud)
    registerCapability({ id: 'skill-distill:weekly-digest', title: 'Consolidate a closed topic', rung: 'reflexive' })
    recordFeedback('skill-distill:weekly-digest', 'ratify')
    recordFeedback('skill-distill:weekly-digest', 'ratify')
    recordFeedback('skill-distill:weekly-digest', 'revert')
    const before = readFileSync(join(ud, LEDGER), 'utf-8')
    expect(getCapability('skill-distill:weekly-digest')!.ratifyN).toBe(2)

    // Simulate the crash: a truncated (torn) file, exactly what a non-atomic write leaves behind.
    writeFileSync(join(ud, LEDGER), before.slice(0, Math.floor(before.length / 2)), 'utf-8')

    // Boot 2: the real boot sequence — setCapabilityLedgerPath then seedCapabilities (main.ts:978-979).
    __resetCapabilityLedger()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setCapabilityLedgerPath(ud)
    seedCapabilities()
    const logged = err.mock.calls.map((c) => String(c[0])).join('\n')
    err.mockRestore()

    // The torn bytes MUST still exist somewhere — the reseed may not be their grave.
    const sidecars = readdirSync(ud).filter((f) => f.endsWith('.corrupt'))
    expect(sidecars).toHaveLength(1)
    expect(readFileSync(join(ud, sidecars[0]), 'utf-8')).toBe(
      before.slice(0, Math.floor(before.length / 2))
    )
    // ...and the loss must be traceable, not silent.
    expect(logged).toMatch(/capability-ledger/)
    expect(logged).toMatch(/quarantined/i)

    // The sidecar name carries a timestamp stamp so repeat corruptions don't clobber each other.
    expect(sidecars[0]).toMatch(/ans-capabilities\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.corrupt$/)

    // Sanity: the live file is the reseeded default set (fail-safe direction), and boot completed.
    expect(existsSync(join(ud, LEDGER))).toBe(true)
    expect(getCapability('memory-consolidation')).toBeTruthy()
  })
})
