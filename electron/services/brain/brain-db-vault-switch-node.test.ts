// Regression: reloadBrainTablesFromVault must never clear the durable brain tables on an
// UNVERIFIED flush.
//
// The defect: the function ran `DELETE FROM <table>` for all four DURABLE_TABLES inside one
// transaction BEFORE checking whether the target vault had anything to re-insert, and its only
// caller (electron/ipc/settings.ts, on a settings:set that changes localBrainNotesDir) discarded
// the return value of the exportBrainTablesToVault final flush that was supposed to make that
// delete safe. exportBrainTablesToVault returns 0 for FOUR different situations the caller could
// not tell apart — no vaultDir, refused by canProjectToVault (origin mismatch), a caught error
// (schema drift / locked DB / unwritable, offline-synced <vault>/.brain/_moat), and the benign
// "contents unchanged, already durable". Only the last is safe. Two ways that wiped live data:
//   1. The flush fails or is refused. The delete still runs; the new vault has no brain-tables.json,
//      so `data` is {} and zero rows are re-inserted. The transaction COMMITS — atomic, and
//      atomically destructive.
//   2. beforeDir is empty (the first-ever vault pick after the app has been used without one).
//      settings.ts's `if (beforeDir)` skipped the flush entirely, yet still ran the reload. A full
//      wipe with no error injected at all.
// Nothing else holds these rows: brain_decisions is the decision-loop "made" side and
// brain_predictions + brain_verdicts are the calibration/forecast ledger — user-authored judgments
// and an accrued track record, with NO vault copy (this file's own header says so). The only
// fallback was a nightly full-DB createBackup, up to 24h stale, whose restore rolls back everything
// else in lamprey.db.
//
// The correct guard already existed twice over: importBrainTablesFromVault (five lines below the
// defect) refuses to clobber a populated table, and switchMoatVault does verified-flush-then-clear
// for the FILE half of the very same vault switch. The fix reuses that shape.
//
// EXECUTING coverage against Node's built-in node:sqlite through the BrainTablesDeps seam, because
// a suite driving the real getDb() cannot load the Electron better-sqlite3 ABI under the node-env
// vitest and would SKIP silently — certifying the exact property it never checked. See
// conversation-compact-node.test.ts for the same reasoning.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { Database } from 'better-sqlite3'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  exportBrainTablesToVault,
  reloadBrainTablesFromVault,
  auditBrainTablesProjection,
  type BrainTablesDeps
} from './brain-db-durability'
import { writeMoatOrigin, switchMoatVault, SWITCH_JOURNAL } from '../moat-durability'

const SCHEMA = `
  CREATE TABLE brain_decisions (node_id TEXT, title TEXT, choice TEXT, note TEXT, decided_at INTEGER);
  CREATE TABLE brain_predictions (id TEXT PRIMARY KEY, kind TEXT, title TEXT, due INTEGER, confidence REAL, track TEXT, created_at INTEGER);
  CREATE TABLE brain_verdicts (prediction_id TEXT, outcome TEXT, note TEXT, recorded_at INTEGER);
  CREATE TABLE brain_insight_verdicts (insight_id TEXT, feature TEXT, verdict TEXT, recorded_at INTEGER);
`

let db: DatabaseSync
let root: string
let userData: string
let oldVault: string
let newVault: string

/** A real transaction over node:sqlite — mirrors better-sqlite3's db.transaction(fn)(). */
const realTx = <T,>(fn: () => T): T => {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const deps = (): BrainTablesDeps => ({
  db: db as unknown as Pick<Database, 'prepare'>,
  transactional: realTx
})

const count = (table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint }).c)

const totalRows = (): number =>
  count('brain_decisions') + count('brain_predictions') + count('brain_verdicts') + count('brain_insight_verdicts')

/** 4 recorded decisions + a 5-entry calibration ledger — the irreplaceable content. */
function seedJudgments(): void {
  for (let i = 0; i < 4; i++) {
    db.prepare('INSERT INTO brain_decisions (node_id, title, choice, note, decided_at) VALUES (?,?,?,?,?)').run(
      `node-${i}`,
      `Decision ${i}`,
      i % 2 === 0 ? 'ship' : 'hold',
      `Reasoning I wrote by hand for decision ${i}`,
      1700000000 + i
    )
  }
  for (let i = 0; i < 5; i++) {
    db.prepare(
      'INSERT INTO brain_predictions (id, kind, title, due, confidence, track, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(`pred-${i}`, 'forecast', `Prediction ${i}`, 1800000000 + i, 0.6 + i / 100, 'work', 1700000000 + i)
    db.prepare('INSERT INTO brain_verdicts (prediction_id, outcome, note, recorded_at) VALUES (?,?,?,?)').run(
      `pred-${i}`,
      i % 3 === 0 ? 'right' : 'wrong',
      `How it actually turned out ${i}`,
      1900000000 + i
    )
  }
  db.prepare('INSERT INTO brain_insight_verdicts (insight_id, feature, verdict, recorded_at) VALUES (?,?,?,?)').run(
    'insight-1',
    'home-digest',
    'useful',
    1900000000
  )
}

const vaultProjection = (vault: string): string => join(vault, '.brain', '_moat', 'brain-tables.json')

function journal(): Record<string, unknown>[] {
  const p = join(userData, SWITCH_JOURNAL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function rescueFiles(): string[] {
  const dir = join(userData, 'brain-tables-rescue')
  return existsSync(dir) ? readdirSync(dir) : []
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  root = mkdtempSync(join(tmpdir(), 'brain-switch-'))
  userData = join(root, 'userData')
  oldVault = join(root, 'oldVault')
  newVault = join(root, 'newVault')
  for (const d of [userData, oldVault, newVault]) mkdirSync(d, { recursive: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// ─────────────── the seam really executes (guards against a silently-skipping suite) ───────────────

describe('test harness', () => {
  it('runs real SQL through the injected handle', () => {
    seedJudgments()
    expect(totalRows()).toBe(15)
    // And a bare DELETE really does destroy them — the operation under test is genuinely destructive.
    db.prepare('DELETE FROM brain_decisions').run()
    expect(count('brain_decisions')).toBe(0)
  })
})

// ─────────────── SCENARIO 2: first-ever vault pick, no flush attempted at all ───────────────

describe('reloadBrainTablesFromVault — nothing was flushed anywhere', () => {
  it('does not wipe the decisions + calibration ledger when no vault holds a copy', () => {
    seedJudgments()

    // Exactly what settings.ts did when beforeDir was empty: `if (beforeDir)` skipped the export,
    // then the reload ran anyway against a brand-new vault with no projection.
    const result = reloadBrainTablesFromVault(newVault, {
      userDataDir: userData,
      flushedTo: null,
      deps: deps()
    })

    expect(result).toMatchObject({ ok: false, outcome: 'retained', imported: 0, priorRows: 15 })
    expect(count('brain_decisions'), 'recorded decisions were destroyed').toBe(4)
    expect(count('brain_predictions'), 'forecast ledger was destroyed').toBe(5)
    expect(count('brain_verdicts'), 'calibration track record was destroyed').toBe(5)
    expect(count('brain_insight_verdicts')).toBe(1)
  })

  it('records what was retained, why, and where the rescue copy went', () => {
    seedJudgments()

    reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: null, deps: deps() })

    const entries = journal().filter((e) => e.scope === 'brain-tables')
    expect(entries).toHaveLength(1)
    expect(entries[0].outcome).toBe('retained')
    expect(entries[0].to).toBe(newVault)
    expect(entries[0].rows).toBe(15)
    expect(entries[0].verified).toBe(0)
    expect(entries[0].pending).toEqual([
      'brain_decisions',
      'brain_predictions',
      'brain_verdicts',
      'brain_insight_verdicts'
    ])
    expect(typeof entries[0].at).toBe('string')

    // Preserve + record: the rows are readable outside the DB too.
    const files = rescueFiles()
    expect(files).toHaveLength(1)
    expect(entries[0].rescueFile).toBe(join(userData, 'brain-tables-rescue', files[0]))
    const dump = JSON.parse(readFileSync(entries[0].rescueFile as string, 'utf-8'))
    expect(dump.tables.brain_decisions).toHaveLength(4)
    expect(dump.tables.brain_verdicts).toHaveLength(5)
    expect(dump.tables.brain_decisions[0].note).toBe('Reasoning I wrote by hand for decision 0')
  })
})

// ─────────────── SCENARIO 1: the flush was attempted but did not land ───────────────

describe('reloadBrainTablesFromVault — the final flush failed or was refused', () => {
  it('survives an unwritable <oldVault>/.brain/_moat (the offline-synced-drive case)', () => {
    seedJudgments()
    // Block the projection: a non-empty DIRECTORY where brain-tables.json must land, so the write
    // throws and exportBrainTablesToVault's catch-all returns its indistinguishable 0.
    const dest = vaultProjection(oldVault)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'occupied.txt'), 'x', 'utf-8')

    expect(exportBrainTablesToVault(userData, oldVault, deps())).toBe(0) // looks just like "unchanged"

    reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: oldVault, from: oldVault, deps: deps() })

    expect(totalRows(), 'rows deleted despite the flush never landing').toBe(15)
    expect(journal().filter((e) => e.scope === 'brain-tables')[0].outcome).toBe('retained')
  })

  it('survives a canProjectToVault refusal (moat origin names a third vault)', () => {
    seedJudgments()
    writeMoatOrigin(userData, join(root, 'someOtherVault'))

    expect(exportBrainTablesToVault(userData, oldVault, deps())).toBe(0) // refused, wrote nothing

    reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: oldVault, from: oldVault, deps: deps() })

    expect(totalRows(), 'rows deleted despite the projection being refused').toBe(15)
    expect(rescueFiles()).toHaveLength(1)
  })

  it('survives a PARTIAL flush — a stale vault projection missing the newest decisions', () => {
    seedJudgments()
    expect(exportBrainTablesToVault(userData, oldVault, deps())).toBe(15)
    // A decision recorded after that flush. The vault copy is now stale: total failure was already
    // survivable, partial failure is the case that fires on an otherwise-correct switch.
    db.prepare('INSERT INTO brain_decisions (node_id, title, choice, note, decided_at) VALUES (?,?,?,?,?)').run(
      'node-late',
      'Decided after the last flush',
      'ship',
      'This one exists only in the DB',
      1700009999
    )

    const audit = auditBrainTablesProjection(oldVault, deps())
    expect(audit.complete).toBe(false)
    expect(audit.pending).toEqual(['brain_decisions'])
    expect(audit.verified).toBe(15) // precise, not all-or-nothing
    expect(audit.rows).toBe(16)

    reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: oldVault, from: oldVault, deps: deps() })

    expect(count('brain_decisions')).toBe(5)
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM brain_decisions WHERE node_id = 'node-late'").get() as { c: number }
    ).toEqual({ c: 1 })
  })
})

// ─────────────── the verified path still switches (the guard must not freeze the feature) ───────────────

describe('reloadBrainTablesFromVault — verified flush still reloads', () => {
  it('clears and re-imports once the rows are provably durable in the flushed vault', () => {
    seedJudgments()
    expect(exportBrainTablesToVault(userData, oldVault, deps())).toBe(15)
    expect(auditBrainTablesProjection(oldVault, deps()).complete).toBe(true)

    // The new vault has its own record to switch TO.
    const proj = vaultProjection(newVault)
    mkdirSync(join(proj, '..'), { recursive: true })
    writeFileSync(
      proj,
      JSON.stringify({
        brain_decisions: [
          { node_id: 'other-1', title: 'From the new vault', choice: 'hold', note: 'n', decided_at: 1710000000 }
        ]
      }),
      'utf-8'
    )

    const result = reloadBrainTablesFromVault(newVault, {
      userDataDir: userData,
      flushedTo: oldVault,
      from: oldVault,
      deps: deps()
    })

    expect(result).toEqual({ ok: true, outcome: 'reloaded', imported: 1, priorRows: 15 })
    expect(count('brain_decisions')).toBe(1)
    expect(count('brain_verdicts')).toBe(0)
    // The prior content is durable in the old vault — and the journal says exactly where it went.
    const entry = journal().filter((e) => e.scope === 'brain-tables')[0]
    expect(entry.outcome).toBe('reloaded')
    expect(entry.priorRowsDurableIn).toBe(oldVault)
    expect(entry.priorRows).toBe(15)
    const durable = JSON.parse(readFileSync(vaultProjection(oldVault), 'utf-8'))
    expect(durable.brain_decisions).toHaveLength(4)
    expect(durable.brain_verdicts).toHaveLength(5)
  })

  it('is a plain reload when there were no rows to lose', () => {
    const proj = vaultProjection(newVault)
    mkdirSync(join(proj, '..'), { recursive: true })
    writeFileSync(
      proj,
      JSON.stringify({
        brain_predictions: [
          { id: 'p1', kind: 'forecast', title: 'T', due: 1, confidence: 0.5, track: 'w', created_at: 2 }
        ]
      }),
      'utf-8'
    )

    expect(
      reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: null, deps: deps() })
    ).toEqual({ ok: true, outcome: 'reloaded', imported: 1, priorRows: 0 })
    expect(count('brain_predictions')).toBe(1)
    expect(rescueFiles()).toHaveLength(0)
  })

  it('distinguishes a legitimate empty reload from retention or failure', () => {
    expect(
      reloadBrainTablesFromVault(newVault, { userDataDir: userData, flushedTo: null, deps: deps() })
    ).toEqual({ ok: true, outcome: 'reloaded', imported: 0, priorRows: 0 })
    expect(totalRows()).toBe(0)
  })

  it('reports a transactional failure and leaves the prior rows intact', () => {
    seedJudgments()
    expect(exportBrainTablesToVault(userData, oldVault, deps())).toBe(15)
    const failingDeps: BrainTablesDeps = {
      db: db as unknown as Pick<Database, 'prepare'>,
      transactional: () => {
        throw new Error('injected transaction failure')
      }
    }

    const result = reloadBrainTablesFromVault(newVault, {
      userDataDir: userData,
      flushedTo: oldVault,
      from: oldVault,
      deps: failingDeps
    })

    expect(result).toEqual({
      ok: false,
      outcome: 'failed',
      imported: 0,
      priorRows: 15,
      error: 'injected transaction failure'
    })
    expect(totalRows()).toBe(15)
  })
})

// ─────────────── SCENARIO 3: fresh install over a synced vault — the EXPORT is the destroyer ───────────────
//
// The mirror image of the two scenarios above, and the one the verified-flush guard cannot catch.
// There, live rows existed and the question was whether it was safe to DELETE them. Here the live
// tables are legitimately EMPTY (a new machine's lamprey.db) and the vault holds the only copy — so
// the export serialises four `[]` and atomicWriteFileSync lands them on the durable record. Nothing
// downstream objects: the reload's audit sees 0 live rows, agrees there is nothing to lose, and
// journals `outcome:'reloaded', reason:'no brain rows to lose'` over an already-destroyed vault.
//
// Reachable from the ordinary first vault pick: settings.ts's `settings:set` computes
// `flushTarget = beforeDir || afterDir`, which on a first pick IS the vault being adopted, and
// canProjectToVault permits it because a fresh userData has no origin marker. The boot-time
// importBrainTablesFromVault that would have populated the tables first cannot help — it reads
// localBrainNotesDir, which is still '' at that point.

describe('exportBrainTablesToVault — an empty live DB must not erase the vault record', () => {
  /** Record the judgments into the vault, then hand that vault to a machine whose lamprey.db is
   *  brand new: a reinstall, or a second machine on a Dropbox/iCloud/Syncthing-synced vault. */
  function vaultRecordedElsewhere(vault: string): void {
    seedJudgments()
    expect(exportBrainTablesToVault(userData, vault, deps())).toBe(15)
    // The fresh install's DB: schema present (getDb lazy-inits to db-migrations v18), zero rows.
    db.exec(
      'DELETE FROM brain_decisions; DELETE FROM brain_predictions; DELETE FROM brain_verdicts; DELETE FROM brain_insight_verdicts;'
    )
    expect(totalRows()).toBe(0)
  }

  it('refuses the zero-row overwrite and leaves the projection byte-for-byte', () => {
    vaultRecordedElsewhere(newVault)
    const before = readFileSync(vaultProjection(newVault), 'utf-8')

    expect(exportBrainTablesToVault(userData, newVault, deps())).toBe(0)

    expect(readFileSync(vaultProjection(newVault), 'utf-8'), 'the durable record was overwritten').toBe(before)
    const durable = JSON.parse(before)
    expect(durable.brain_decisions).toHaveLength(4)
    expect(durable.brain_predictions).toHaveLength(5)
    expect(durable.brain_verdicts).toHaveLength(5)
    expect(durable.brain_insight_verdicts).toHaveLength(1)
  })

  it('first-ever vault pick over a synced vault ADOPTS the ledger instead of destroying it', () => {
    vaultRecordedElsewhere(newVault)

    // Exactly settings.ts's `settings:set` block when localBrainNotesDir goes '' -> newVault.
    const beforeDir: string = ''
    const flushTarget = beforeDir || newVault
    exportBrainTablesToVault(userData, flushTarget, deps())
    switchMoatVault(userData, beforeDir || null, newVault)
    const result = reloadBrainTablesFromVault(newVault, {
      userDataDir: userData,
      flushedTo: flushTarget,
      from: beforeDir || null,
      deps: deps()
    })

    // The rows the user actually wrote come back, not an empty ledger reported as success.
    expect(result).toEqual({ ok: true, outcome: 'reloaded', imported: 15, priorRows: 0 })
    expect(count('brain_decisions')).toBe(4)
    expect(count('brain_predictions')).toBe(5)
    expect(count('brain_verdicts')).toBe(5)
    expect(
      (db.prepare("SELECT note FROM brain_decisions WHERE node_id = 'node-0'").get() as { note: string }).note
    ).toBe('Reasoning I wrote by hand for decision 0')
    // ...and the vault still holds the durable copy afterwards.
    expect(JSON.parse(readFileSync(vaultProjection(newVault), 'utf-8')).brain_decisions).toHaveLength(4)
  })

  it('treats an unparseable projection as "may hold rows" rather than flattening it', () => {
    // Half-written / corrupt JSON may still be recoverable by hand; an empty projection is not.
    const proj = vaultProjection(newVault)
    mkdirSync(join(proj, '..'), { recursive: true })
    writeFileSync(proj, '{"brain_decisions":[{"node_id":"node-0","title":"Deci', 'utf-8')

    expect(exportBrainTablesToVault(userData, newVault, deps())).toBe(0)

    expect(readFileSync(proj, 'utf-8')).toBe('{"brain_decisions":[{"node_id":"node-0","title":"Deci')
  })

  // ── the guard must stay narrow: it blocks EMPTINESS, not ordinary projection ──

  it('still projects when the live DB has rows, so real deletions still propagate', () => {
    seedJudgments()
    expect(exportBrainTablesToVault(userData, newVault, deps())).toBe(15)
    db.prepare("DELETE FROM brain_decisions WHERE node_id = 'node-3'").run()

    expect(exportBrainTablesToVault(userData, newVault, deps())).toBe(14)
    expect(JSON.parse(readFileSync(vaultProjection(newVault), 'utf-8')).brain_decisions).toHaveLength(3)
  })

  it('still creates the first projection for an install that genuinely has no rows', () => {
    expect(exportBrainTablesToVault(userData, newVault, deps())).toBe(0)

    expect(existsSync(vaultProjection(newVault))).toBe(true)
    expect(JSON.parse(readFileSync(vaultProjection(newVault), 'utf-8')).brain_decisions).toEqual([])
  })
})

// ─────────────── the audit itself ───────────────

describe('auditBrainTablesProjection', () => {
  it('reports a null target as fully unprojected rather than clean', () => {
    seedJudgments()
    const audit = auditBrainTablesProjection(null, deps())
    expect(audit.complete).toBe(false)
    expect(audit.rows).toBe(15)
    expect(audit.verified).toBe(0)
  })

  it('is content-based: a same-path projection with different rows does not count as durable', () => {
    seedJudgments()
    const proj = vaultProjection(oldVault)
    mkdirSync(join(proj, '..'), { recursive: true })
    writeFileSync(proj, JSON.stringify({ brain_decisions: [{ node_id: 'nope' }] }), 'utf-8')

    expect(auditBrainTablesProjection(oldVault, deps()).complete).toBe(false)
  })

  it('is complete when there is nothing to project', () => {
    expect(auditBrainTablesProjection(null, deps()).complete).toBe(true)
  })
})
