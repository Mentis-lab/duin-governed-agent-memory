import { describe, it, expect } from 'vitest'
import {
  MIGRATIONS,
  LATEST_VERSION,
  gapStraddledVersions,
  seedLedgerVersions,
  pendingMigrationVersions
} from './db-migrations'

// Gate finding F3 — the one-way migration trap.
//
// `runMigrations` used to answer "has vN already run?" with the ordering test
// `N <= user_version`. That is only sound while the registry is contiguous, and
// `MIGRATIONS` is not: it has a 28 -> 32 numbering gap because a concurrent
// workstream reserved 28-31. Commit 49ee04eb was a REAL shipped build carrying
// v32-v36 WITHOUT v28. A DB migrated by it stamps 36; the merged build then
// evaluated `28 <= 36` and skipped v28 forever, stranding
// `conversations.closed_at` with no error at all.
//
// These tests pin the pure skip/apply logic, so they run under PLAIN node — no
// better-sqlite3, no Electron ABI. The end-to-end repair (a real DB driven to
// 36 by the intermediate registry, then healed) lives in db-migrations.test.ts
// behind HAS_NATIVE_SQLITE.

/** The registry commit 49ee04eb actually shipped: v32-v36 but no v28. */
const INTERMEDIATE_REGISTRY = MIGRATIONS.filter(
  (m) => m.version !== 28 && m.version <= 36
).map((m) => ({ version: m.version }))

describe('gapStraddledVersions', () => {
  it('flags the entry immediately below each numbering gap the stamp crosses', () => {
    // 1,2,3 then a gap, then 7,8.
    const registry = [1, 2, 3, 7, 8].map((version) => ({ version }))
    expect(gapStraddledVersions(registry, 8)).toEqual([3])
  })

  it('flags nothing in a fully contiguous registry', () => {
    const registry = [1, 2, 3, 4].map((version) => ({ version }))
    expect(gapStraddledVersions(registry, 4)).toEqual([])
  })

  it('ignores gaps the stamp has not reached yet', () => {
    const registry = [1, 2, 3, 7, 8].map((version) => ({ version }))
    // Stamped at 3: the 3 -> 7 gap is above the stamp, so nothing is suspect.
    expect(gapStraddledVersions(registry, 3)).toEqual([])
  })

  it('flags v28 in the REAL registry at any stamp past the 28 -> 32 gap', () => {
    expect(gapStraddledVersions(MIGRATIONS, 36)).toContain(28)
    expect(gapStraddledVersions(MIGRATIONS, LATEST_VERSION)).toContain(28)
  })

  it('does not flag v28 for a DB stamped at 28 (the gap is still ahead)', () => {
    expect(gapStraddledVersions(MIGRATIONS, 28)).not.toContain(28)
  })

  it('never flags a version above the stamp', () => {
    for (const v of gapStraddledVersions(MIGRATIONS, 36)) {
      expect(v).toBeLessThanOrEqual(36)
    }
  })
})

describe('seedLedgerVersions', () => {
  it('trusts everything the stamp proves and withholds the gap-straddled entries', () => {
    const seeded = seedLedgerVersions(MIGRATIONS, 36)
    const straddled = gapStraddledVersions(MIGRATIONS, 36)
    // Every registry version at-or-below the stamp is either seeded or suspect.
    for (const m of MIGRATIONS) {
      if (m.version > 36) {
        expect(seeded).not.toContain(m.version)
        continue
      }
      expect(seeded.includes(m.version) !== straddled.includes(m.version)).toBe(true)
    }
    expect(seeded).not.toContain(28)
  })

  it('seeds nothing for a fresh DB', () => {
    expect(seedLedgerVersions(MIGRATIONS, 0)).toEqual([])
  })

  it('withholds only a handful — this is a surgical repair, not a full replay', () => {
    const below = MIGRATIONS.filter((m) => m.version <= LATEST_VERSION).length
    const straddled = gapStraddledVersions(MIGRATIONS, LATEST_VERSION).length
    expect(straddled).toBeLessThan(below / 4)
  })
})

describe('pendingMigrationVersions', () => {
  it('runs everything on a fresh DB with an empty ledger', () => {
    expect(pendingMigrationVersions(MIGRATIONS, 0, new Set())).toEqual(
      MIGRATIONS.map((m) => m.version)
    )
  })

  it('runs nothing when the ledger accounts for every version', () => {
    const full = new Set(MIGRATIONS.map((m) => m.version))
    expect(pendingMigrationVersions(MIGRATIONS, LATEST_VERSION, full)).toEqual([])
  })

  it('THE BUG: v28 is stranded by a 49ee04eb-shaped DB and must be re-applied', () => {
    // The intermediate build ran everything it had, landing the DB at 36.
    const stampedBy49ee04eb = INTERMEDIATE_REGISTRY.reduce(
      (acc, m) => Math.max(acc, m.version),
      0
    )
    expect(stampedBy49ee04eb).toBe(36)

    // The merged build opens that DB. Its ledger is seeded from the stamp.
    const ledger = new Set(seedLedgerVersions(MIGRATIONS, 36))
    const pending = pendingMigrationVersions(MIGRATIONS, 36, ledger)

    // v43 was always going to run (it is above the stamp). v28 is the fix:
    // under the old `version <= start` rule it was skipped, silently, forever.
    expect(pending).toContain(28)
    expect(pending).toContain(43)
  })

  it('still runs a migration above the stamp even when the ledger claims it', () => {
    // Hand-lowering user_version must behave exactly as it always did — the
    // ledger may only ADD work, never remove it.
    const full = new Set(MIGRATIONS.map((m) => m.version))
    expect(pendingMigrationVersions(MIGRATIONS, 27, full)).toContain(28)
  })

  it('keeps registry order so migrations still apply ascending', () => {
    const pending = pendingMigrationVersions(MIGRATIONS, 36, new Set(seedLedgerVersions(MIGRATIONS, 36)))
    expect([...pending].sort((a, b) => a - b)).toEqual(pending)
  })
})
