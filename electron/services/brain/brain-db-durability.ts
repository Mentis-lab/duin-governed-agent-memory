// Brain-table durability (portability audit A3/A4/A6 — DUIN_AUDIT_REMEDIATION.md).
//
// The decision-loop "made" side (brain_decisions), the calibration ledger
// (brain_predictions + brain_verdicts), and the Home-Digest insight AFFINITY
// (brain_insight_verdicts) live in userData/lamprey.db with NO vault copy — so a
// reinstall erases the user's actual decisions and their calibration track-record.
//
// Fix (mirrors moat-durability's file pattern, for SQLite rows): on the moat cadence,
// EXPORT the 4 tables to <vault>/.brain/_moat/brain-tables.json; on boot / vault-set,
// IMPORT rows back — but ONLY into a table that is currently EMPTY (a fresh install),
// so a live runtime table is never clobbered. `getDb()` lazy-inits the schema (brain
// tables land at db-migrations v18), so calling these any time after boot is safe.
// Cross-machine row MERGE is deferred (same limitation as the file stores).

import type { Database } from 'better-sqlite3'
import { existsSync, readFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { getDb, withWriteRetry } from '../database'
import { atomicWriteFileSync } from '../atomic-write'
import { canProjectToVault, recordSwitchOutcome } from '../moat-durability'
import { messageOf } from '../guarded'

const DURABLE_TABLES = [
  { name: 'brain_decisions', cols: ['node_id', 'title', 'choice', 'note', 'decided_at'] },
  { name: 'brain_predictions', cols: ['id', 'kind', 'title', 'due', 'confidence', 'track', 'created_at'] },
  { name: 'brain_verdicts', cols: ['prediction_id', 'outcome', 'note', 'recorded_at'] },
  { name: 'brain_insight_verdicts', cols: ['insight_id', 'feature', 'verdict', 'recorded_at'] }
] as const

/** Seam so the DELETE/verify path can execute for real under the node-env vitest (the Electron
 *  better-sqlite3 ABI does not load there, which makes a getDb()-driven suite skip SILENTLY —
 *  see conversation-compact-node.test.ts for the same reasoning). */
export interface BrainTablesDeps {
  db: Pick<Database, 'prepare'>
  /** Defaults to better-sqlite3's db.transaction(). The all-or-nothing DELETE+re-import is the
   *  whole point of the reload, so the seam lets it run for real against node:sqlite. */
  transactional?: <T>(fn: () => T) => T
}

function txOf(d: BrainTablesDeps | undefined, db: Pick<Database, 'prepare'>): <T>(fn: () => T) => T {
  if (d?.transactional) return d.transactional
  return <T,>(fn: () => T): T => (db as Database).transaction(fn)()
}

function vaultTablesPath(vaultDir: string): string {
  return join(vaultDir, '.brain', '_moat', 'brain-tables.json')
}

/** Canonical value form for comparison + serialisation: column order fixed by DURABLE_TABLES, so a
 *  live row and its vault projection compare on content alone (and BigInt from a SQLite driver does
 *  not explode JSON.stringify). */
function canonRow(cols: readonly string[], r: Record<string, unknown>): unknown[] {
  return cols.map((c) => {
    const v = r?.[c]
    if (v === undefined) return null
    return typeof v === 'bigint' ? Number(v) : v
  })
}

function readTable(
  db: Pick<Database, 'prepare'>,
  t: (typeof DURABLE_TABLES)[number]
): Record<string, unknown>[] {
  return db.prepare(`SELECT ${t.cols.join(', ')} FROM ${t.name}`).all() as Record<string, unknown>[]
}

/**
 * Would writing an EMPTY projection over `dest` destroy rows?
 *
 * Deliberately conservative: an unreadable or unparseable projection answers TRUE ("may hold rows").
 * This is only ever asked when the live DB has nothing to project, so a false "yes" costs nothing —
 * there is no content waiting to be written — while a false "no" overwrites the only durable copy of
 * the decisions + calibration ledger. Same posture as moat-durability's sameContents/sameBytes:
 * unreadable counts against the destructive direction.
 */
function projectionMayHoldRows(dest: string): boolean {
  let raw: string
  try {
    raw = readFileSync(dest, 'utf-8')
  } catch (e) {
    console.debug('[brain-db-durability] existing projection unreadable:', messageOf(e))
    return true
  }
  try {
    const prior = JSON.parse(raw) as Record<string, unknown>
    return DURABLE_TABLES.some((t) => {
      const rows = prior?.[t.name]
      return Array.isArray(rows) && rows.length > 0
    })
  } catch (e) {
    console.debug('[brain-db-durability] existing projection unparseable:', messageOf(e))
    return true
  }
}

export interface BrainTablesAudit {
  /** true when every non-empty table's rows are present, content-for-content, in the vault. */
  complete: boolean
  /** table names holding rows that are NOT durable in the vault. */
  pending: string[]
  /** rows confirmed durable in the vault. */
  verified: number
  /** rows currently live in the DB. */
  rows: number
  target: string | null
}

/**
 * Content-based durability audit for the 4 brain tables — the DB analogue of auditMoatProjection.
 *
 * exportBrainTablesToVault's row COUNT cannot answer "is it safe to delete these rows?": it returns
 * 0 for a refused projection (origin mismatch), 0 for a caught error (schema drift, locked DB,
 * unwritable/offline-synced vault) and 0 for the benign "already durable, unchanged" case. Only the
 * last is safe, and the number cannot tell them apart. This re-reads the vault and compares.
 */
export function auditBrainTablesProjection(
  vaultDir: string | null | undefined,
  deps?: BrainTablesDeps
): BrainTablesAudit {
  const audit: BrainTablesAudit = {
    complete: true,
    pending: [],
    verified: 0,
    rows: 0,
    target: vaultDir || null
  }
  let projected: Record<string, unknown[]> = {}
  if (vaultDir) {
    try {
      const src = vaultTablesPath(vaultDir)
      if (existsSync(src)) projected = JSON.parse(readFileSync(src, 'utf-8'))
    } catch (e) {
      console.warn('[brain-db-durability] vault projection unreadable:', messageOf(e))
    }
  }
  const db = deps?.db ?? getDb()
  for (const t of DURABLE_TABLES) {
    let live: Record<string, unknown>[]
    try {
      live = readTable(db, t)
    } catch (e) {
      // Cannot read the table => cannot prove its rows are durable. Treat as pending, never as clean.
      console.warn(`[brain-db-durability] audit read '${t.name}' failed:`, messageOf(e))
      audit.pending.push(t.name)
      audit.complete = false
      continue
    }
    audit.rows += live.length
    if (live.length === 0) continue // nothing to lose from this table
    const there = Array.isArray(projected[t.name]) ? (projected[t.name] as Record<string, unknown>[]) : []
    const have = new Set(there.map((r) => JSON.stringify(canonRow(t.cols, r))))
    const missing = live.filter((r) => !have.has(JSON.stringify(canonRow(t.cols, r)))).length
    audit.verified += live.length - missing
    if (missing > 0) {
      audit.pending.push(t.name)
      audit.complete = false
    }
  }
  return audit
}

/**
 * Preserve + record: dump the live brain tables to a timestamped rescue file under userData and
 * return its path. Used when a switch cannot be proven safe, so the rows are recoverable from
 * something better than a <=24h-stale full-DB backup whose restore rolls back everything else.
 */
export function writeBrainTablesRescue(userDataDir: string, deps?: BrainTablesDeps): string | null {
  try {
    const db = deps?.db ?? getDb()
    const out: Record<string, unknown> = { at: new Date().toISOString(), tables: {} }
    const tables = out.tables as Record<string, unknown[]>
    for (const t of DURABLE_TABLES) {
      tables[t.name] = readTable(db, t).map((r) => {
        const o: Record<string, unknown> = {}
        t.cols.forEach((c, i) => (o[c] = canonRow(t.cols, r)[i]))
        return o
      })
    }
    const dest = join(
      userDataDir,
      'brain-tables-rescue',
      `brain-tables-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    )
    mkdirSync(dirname(dest), { recursive: true })
    atomicWriteFileSync(dest, JSON.stringify(out), 0o644)
    return dest
  } catch (e) {
    console.warn('[brain-db-durability] rescue dump failed:', messageOf(e))
    return null
  }
}

/** Export the 4 durable brain tables to the vault projection. Best-effort, idempotent
 *  (skips unchanged). Returns the total row count written (0 if unchanged/failed). */
export function exportBrainTablesToVault(
  userDataDir: string,
  vaultDir: string | null | undefined,
  deps?: BrainTablesDeps
): number {
  if (!vaultDir) return 0
  // H1 — do not export this DB's rows into a vault whose moat userData doesn't belong to
  // (vault switch would clobber the new vault's brain-tables with the old vault's decisions).
  if (!canProjectToVault(userDataDir, vaultDir)) return 0
  try {
    const db = deps?.db ?? getDb()
    const out: Record<string, unknown[]> = {}
    let total = 0
    for (const t of DURABLE_TABLES) {
      const rows = readTable(db, t).map((r) => {
        const canon = canonRow(t.cols, r)
        const o: Record<string, unknown> = {}
        t.cols.forEach((c, i) => (o[c] = canon[i]))
        return o
      })
      out[t.name] = rows
      total += rows.length
    }
    const contents = JSON.stringify(out)
    const dest = vaultTablesPath(vaultDir)
    if (existsSync(dest)) {
      try {
        if (readFileSync(dest, 'utf-8') === contents) return 0
      } catch (e) { console.debug('[brain-db-durability] rewrite:', messageOf(e)) }
      // H1b — an EMPTY live DB means "nothing to project", never "project nothingness".
      //
      // Every other durability path here already refuses to propagate absence: projectMoatToVault
      // does `if (!existsSync(src)) continue` for a userData file it does not have, and
      // importBrainTablesFromVault does `if (count > 0) continue` so a populated table is never
      // clobbered. This half had no such guard, and the gap is only reachable when the live tables
      // are empty — which is exactly a FRESH INSTALL over an existing/synced vault, the case
      // importBrainTablesFromVault's docstring names.
      //
      // What made it invisible: the first vault pick runs the export with flushTarget = the vault
      // just picked (settings.ts's `beforeDir || afterDir`), canProjectToVault waves it through
      // because a fresh userData has no origin marker, and the boot-time import that would have
      // populated these tables never ran — readMoatVaultDir() is null when settings.json is absent.
      // Four empty tables then serialise to `[]` and land on the vault's populated record. The
      // reload that follows sees 0 live rows, so its verified-flush guard passes honestly and the
      // switch journals success. Every step reports OK; the ledger is gone.
      if (total === 0 && projectionMayHoldRows(dest)) {
        console.warn(
          `[brain-db-durability] REFUSING to write an empty projection over '${dest}': the live ` +
            `brain tables hold 0 rows but the vault copy does not. This is a fresh install (or a ` +
            `reset DB) over an existing vault — the vault's decisions and calibration ledger are ` +
            `the durable record and are kept. They load back into the DB on the next import/reload.`
        )
        return 0
      }
    }
    mkdirSync(dirname(dest), { recursive: true })
    atomicWriteFileSync(dest, contents, 0o644) // H2 — crash-safe durable record
    return total
  } catch (e) {
    // M5/M6 — a schema change (renamed/NOT-NULL column) or a DB error must be LOUD, not a silent
    // "nothing to project" that leaves the moat non-durable again.
    console.warn('[brain-db-durability] export failed (moat may be non-durable):', (e as Error)?.message)
    return 0
  }
}

export interface ReloadBrainTablesOpts {
  /** userData dir — where the rescue dump is written when the switch cannot be proven safe. */
  userDataDir?: string
  /** The vault the caller final-flushed the CURRENT rows to. The DELETE below only runs once the
   *  rows are verified present there. Omit/null => unproven => nothing is deleted. */
  flushedTo?: string | null
  /** For the journal entry only. */
  from?: string | null
  deps?: BrainTablesDeps
}

export type BrainTablesReloadResult =
  | {
      ok: true
      outcome: 'reloaded'
      imported: number
      priorRows: number
    }
  | {
      ok: false
      outcome: 'retained'
      imported: 0
      priorRows: number
      pending: string[]
      rescueFile: string | null
      reason: string
    }
  | {
      ok: false
      outcome: 'failed'
      imported: 0
      priorRows: number
      error: string
    }

/**
 * H1 vault switch — REPLACE the install's brain tables with the target vault's projection
 * (DELETE + re-import). Unlike importBrainTablesFromVault (empty-guarded), this is used only on an
 * explicit vault switch so the shared DB reflects the vault we're switching TO, and a later flush
 * exports the right rows. A restart is still recommended to reload in-memory decision-loop state.
 * Returns a discriminated result so a legitimate zero-row reload is distinguishable from a
 * retained or failed switch.
 *
 * The DELETE is GUARDED, not unconditional. brain_decisions is the decision-loop "made" side and
 * brain_predictions/brain_verdicts are the calibration ledger: user-authored judgments and an
 * accrued track record that cannot be recomputed from any source, with no vault copy of their own.
 * Deleting them is only survivable if the rows are provably durable in the vault they were flushed
 * to, so this verifies that with auditBrainTablesProjection instead of trusting the caller's
 * (previously discarded) export row-count — which reports 0 identically for "unchanged, already
 * durable", "refused by canProjectToVault", and "threw". Two live paths made that fatal: an
 * unwritable/offline-synced <oldVault>/.brain/_moat, and a FIRST-EVER vault pick where the caller's
 * `if (beforeDir)` skipped the flush entirely yet still ran this reload — a full wipe with no error
 * at all. Mirrors switchMoatVault's verified-flush guard, which does exactly this for the file half
 * of the same switch (moat-durability.ts step 2).
 */
export function reloadBrainTablesFromVault(
  vaultDir: string | null | undefined,
  opts: ReloadBrainTablesOpts = {}
): BrainTablesReloadResult {
  if (!vaultDir) {
    return {
      ok: false,
      outcome: 'failed',
      imported: 0,
      priorRows: 0,
      error: 'vaultDir is required to reload brain tables'
    }
  }
  let priorRows = 0
  try {
    const db = opts.deps?.db ?? getDb()
    // Audit before reading the target projection so failures still report how many live rows were
    // preserved. This is read-only and retains the existing delete guard.
    const audit = auditBrainTablesProjection(opts.flushedTo ?? null, opts.deps)
    priorRows = audit.rows
    const src = vaultTablesPath(vaultDir)
    const data = existsSync(src)
      ? (JSON.parse(readFileSync(src, 'utf-8')) as Record<string, Record<string, unknown>[]>)
      : {}

    // Preserve + record + stamp. Do not clear rows we cannot prove are recoverable.
    if (audit.rows > 0 && !audit.complete) {
      const rescue = opts.userDataDir ? writeBrainTablesRescue(opts.userDataDir, opts.deps) : null
      const reason = opts.flushedTo
        ? 'final flush of the brain tables could not be verified in the vault'
        : 'no vault was final-flushed, so the live rows have no durable copy'
      if (opts.userDataDir) {
        recordSwitchOutcome(opts.userDataDir, {
          scope: 'brain-tables',
          outcome: 'retained',
          from: opts.from ?? null,
          to: vaultDir,
          flushTarget: opts.flushedTo ?? null,
          reason,
          pending: audit.pending,
          verified: audit.verified,
          rows: audit.rows,
          rescueFile: rescue
        })
      }
      console.warn(
        `[brain-db-durability] vault switch -> ${vaultDir} did NOT reload the brain tables: ` +
          `${audit.rows} row(s) across ${audit.pending.join(', ')} are not durable in ` +
          `'${opts.flushedTo ?? '(nothing flushed)'}' (verified ${audit.verified}). The tables were ` +
          `left INTACT rather than cleared${rescue ? `; a rescue copy is at ${rescue}` : ''}. ` +
          `Fix vault write access (or the moat origin mismatch) and re-pick the folder.`
      )
      return {
        ok: false,
        outcome: 'retained',
        imported: 0,
        priorRows: audit.rows,
        pending: audit.pending,
        rescueFile: rescue,
        reason
      }
    }

    let imported = 0
    const transactional = txOf(opts.deps, db)
    withWriteRetry(
      () => {
        transactional(() => {
          for (const t of DURABLE_TABLES) {
            db.prepare(`DELETE FROM ${t.name}`).run()
            const rows = data[t.name]
            if (!Array.isArray(rows) || rows.length === 0) continue
            const stmt = db.prepare(
              `INSERT OR IGNORE INTO ${t.name} (${t.cols.join(', ')}) VALUES (${t.cols
                .map(() => '?')
                .join(', ')})`
            )
            for (const r of rows) {
              stmt.run(...t.cols.map((c) => (r[c] === undefined ? null : r[c])))
              imported++
            }
          }
        })
      },
      { label: 'reload brain tables (vault switch)' }
    )
    if (opts.userDataDir) {
      recordSwitchOutcome(opts.userDataDir, {
        scope: 'brain-tables',
        outcome: 'reloaded',
        from: opts.from ?? null,
        to: vaultDir,
        flushTarget: opts.flushedTo ?? null,
        reason:
          audit.rows === 0
            ? 'no brain rows to lose'
            : 'prior rows verified durable in the flushed vault before clearing',
        // Where the prior content went, so it can be found again.
        priorRowsDurableIn: audit.rows > 0 ? (opts.flushedTo ?? null) : null,
        priorRows: audit.rows,
        imported
      })
    }
    console.log(`[brain-db-durability] reloaded brain tables for vault switch (${imported} row(s))`)
    return { ok: true, outcome: 'reloaded', imported, priorRows: audit.rows }
  } catch (e) {
    const error = messageOf(e)
    console.warn('[brain-db-durability] vault-switch reload failed:', error)
    return { ok: false, outcome: 'failed', imported: 0, priorRows, error }
  }
}

/** Import rows from the vault projection into any brain table that is currently EMPTY
 *  (a fresh install over an existing/synced vault). Never clobbers a populated table.
 *  Returns the number of rows imported. */
export function importBrainTablesFromVault(vaultDir: string | null | undefined): number {
  if (!vaultDir) return 0
  try {
    const src = vaultTablesPath(vaultDir)
    if (!existsSync(src)) return 0
    const data = JSON.parse(readFileSync(src, 'utf-8')) as Record<string, Record<string, unknown>[]>
    const db = getDb()
    let imported = 0
    for (const t of DURABLE_TABLES) {
      const rows = data[t.name]
      if (!Array.isArray(rows) || rows.length === 0) continue
      const count = (db.prepare(`SELECT COUNT(*) AS c FROM ${t.name}`).get() as { c: number }).c
      if (count > 0) continue // runtime table already populated — do not clobber
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${t.name} (${t.cols.join(', ')}) VALUES (${t.cols
          .map(() => '?')
          .join(', ')})`
      )
      withWriteRetry(
        () => {
          const tx = db.transaction((rs: Record<string, unknown>[]) => {
            for (const r of rs) {
              stmt.run(...t.cols.map((c) => (r[c] === undefined ? null : r[c])))
              imported++
            }
          })
          tx(rows)
        },
        { label: `import ${t.name}` }
      )
    }
    if (imported) console.log(`[brain-db-durability] imported ${imported} row(s) from vault`)
    return imported
  } catch (e) {
    console.warn('[brain-db-durability] import failed:', (e as Error)?.message) // M6
    return 0
  }
}
