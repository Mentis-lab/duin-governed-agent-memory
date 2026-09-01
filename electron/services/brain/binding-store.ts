// binding-store — the I/O half of the binding-ledger (pure logic in binding-ledger.ts), mirroring
// learn-store / calibration-store (coherent-ownership: pure logic testable without touching disk).
// Owns .duin/_state/binding-ledger.jsonl — append-only bind rows; a full atomic rewrite only for
// in-place updates (a recurrence-failure or a revert). Null-safe.
//
// DATA-LOSS RULE (same class as graph-history-store.ts, and fixed the same way): a bind row is
// minted ONLY by a human confirm — POST /state/bind-candidate 400s unless the caller supplies an
// explicit `rule` and `candidate.theme[]`, and nothing auto-binds (see coherence-map.ts:158). So a
// lost row can never be regenerated. binding-ledger.jsonl is also absent from moat-backup's
// SOURCES allowlist, so there is no snapshot and no .trash tombstone behind it.
//
// That makes the read-modify-rewrite path lethal: loadBindings used to DROP any line it could not
// parse (console.debug only), and writeBindings then rewrote the whole file from the survivors —
// permanently erasing the unparseable line's bytes. The trigger is a healthy operator correction
// (brain-state-routes.ts:521-524), not a failure: a routine POST /learn/correction that happens to
// fail an open binding rewrites the ledger and takes the torn line with it.
//
// So: unparseable lines are carried through the rewrite VERBATIM, at their original position, and
// the append path fsyncs so a crash stops manufacturing torn lines in the first place.
import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'fs'
import { atomicWriteFileSync } from '../atomic-write'
import { join } from 'path'
import type { BindingRow } from './binding-ledger'
import { messageOf } from '../guarded'

const ledgerPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'binding-ledger.jsonl')

/** A ledger line paired with its interpretation. `parsed === null` marks a line we do NOT
 *  understand — it is salvageable residue, never something to delete. */
export interface BindingEntry {
  raw: string
  parsed: BindingRow | null
}

/** Read every non-blank line with its interpretation. Nothing is discarded here — the caller
 *  decides what to render, but the RAW text is what gets re-emitted on a rewrite. */
export function loadBindingEntries(vaultDir: string | null): BindingEntry[] {
  if (!vaultDir) return []
  let txt: string
  try {
    txt = readFileSync(ledgerPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const entries: BindingEntry[] = []
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: BindingRow | null = null
    try {
      const v = JSON.parse(line) as unknown
      parsed = v && typeof v === 'object' && !Array.isArray(v) ? (v as BindingRow) : null
    } catch (e) {
      console.debug('[binding-store] unparseable row retained verbatim for the next rewrite:', messageOf(e))
    }
    entries.push({ raw: line, parsed })
  }
  return entries
}

/** Load the binding rows callers can interpret (blank / corrupt lines are not returned — but they
 *  are NOT lost either: writeBindings re-emits them from disk. See loadBindingEntries). */
export function loadBindings(vaultDir: string | null): BindingRow[] {
  return loadBindingEntries(vaultDir)
    .map((e) => e.parsed)
    .filter((r): r is BindingRow => r !== null)
}

/** Append a new binding row (O_APPEND: an atomic complete-line write), then fsync.
 *
 *  The fsync is the other half of the preservation rule above: appendFileSync alone leaves the
 *  bytes in the page cache, so a crash / power-loss mid-append is exactly what tears a line in
 *  half — manufacturing the corrupt row the rewrite path then has to carry. Durably committing
 *  each human-confirmed row stops producing the hazard instead of only surviving it. */
export function appendBinding(vaultDir: string | null, row: BindingRow): boolean {
  if (!vaultDir) return false
  const path = ledgerPath(vaultDir)
  const line = JSON.stringify(row) + '\n'
  let fd: number | null = null
  let written = false
  try {
    fd = openSync(path, 'a')
    writeSync(fd, line)
    // The bytes are in the file from here on. An fsync failure past this point must NOT retry the
    // append — that would duplicate the row, which for a human-confirmed bind is its own corruption.
    written = true
    fsyncSync(fd)
  } catch (e) {
    // Never lose the append because the durability upgrade failed (e.g. an fsync-hostile
    // filesystem). Fall back to the original best-effort path rather than dropping the row.
    console.debug('[binding-store] durable append failed, falling back to appendFileSync:', messageOf(e))
    if (!written) appendFileSync(path, line, 'utf-8')
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed / never opened */
      }
    }
  }
  return true
}

/**
 * Rewrite the whole ledger atomically — for in-place updates (recurrence-failure, revert).
 *
 * `rows` is the caller's in-memory view, which by construction only ever contains lines that
 * PARSED. Rewriting straight from it would delete every line that did not. So we re-read the file
 * and splice the unparseable lines back in at their original position: the caller's rows carry the
 * intended mutation, the residue is carried through byte-for-byte, and nothing on disk is lost.
 */
export function writeBindings(vaultDir: string | null, rows: BindingRow[]): boolean {
  if (!vaultDir) return false
  const path = ledgerPath(vaultDir)

  // Where each unparseable line sat, expressed as "after N parseable lines", so it lands back in
  // the same relative slot even though the parseable rows around it were rewritten.
  const preserved: { raw: string; afterParsed: number }[] = []
  let seenParsed = 0
  for (const entry of loadBindingEntries(vaultDir)) {
    if (entry.parsed === null) preserved.push({ raw: entry.raw, afterParsed: seenParsed })
    else seenParsed++
  }

  const out: string[] = []
  let next = 0
  const flushPreserved = (upTo: number): void => {
    while (next < preserved.length && preserved[next].afterParsed <= upTo) out.push(preserved[next++].raw)
  }
  for (let i = 0; i < rows.length; i++) {
    // A line recorded as "after i parseable lines" belongs immediately BEFORE the i-th row.
    flushPreserved(i)
    out.push(JSON.stringify(rows[i]))
  }
  // Anything anchored past the end of the caller's rows (including a trailing torn line).
  while (next < preserved.length) out.push(preserved[next++].raw)

  if (preserved.length) {
    // Traceable: say what was carried and where it went, rather than dropping it in silence.
    console.warn(
      `[binding-store] rewrote ${path} preserving ${preserved.length} unparseable line(s) verbatim ` +
        `alongside ${rows.length} parsed row(s) — corrupt bytes were retained, not deleted.`
    )
  }

  atomicWriteFileSync(path, out.length ? out.join('\n') + '\n' : '', 0o644)
  return true
}
