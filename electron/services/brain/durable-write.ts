// durable-write — crash-safe atomic file write (Evidence Threshold Phase, A2 slice).
//
// The ~21 jsonl/atomic writers across the brain natives do writeFileSync(tmp)+renameSync
// with NO fsync. That is atomic in VISIBILITY (rename is atomic) but NOT durable: on a
// crash / power loss after the rename returns but before the page cache flushes, the file
// can be zero-length or torn — the canonical ALICE crash vulnerability the 2026-07-08 eval
// flagged (repo-wide `fsync` = 0). This primitive closes it: write tmp → fsync the tmp fd →
// rename → fsync the parent directory (so the rename metadata op is itself durable). Same
// atomic-visibility guarantee, now crash-safe.
//
// SCOPE: forecast-ledger.ts (logForecastsToLedger) now routes its append through durableAppend
// (as of the unify merge); the remaining ~20 jsonl/atomic writers stay deferred to the ongoing
// brain-unification consolidation rather than mass-editing cross-session-contended sites here.

import { openSync, writeSync, fsyncSync, closeSync, renameSync } from 'fs'
import { dirname } from 'path'
import { messageOf } from '../guarded'

/** fsync a directory so a rename into it is durable. Best-effort: Windows / some filesystems
 *  reject opening a directory for fsync — the file fsync in the caller is the load-bearing part. */
function fsyncDir(dir: string): void {
  let dfd: number
  try {
    dfd = openSync(dir, 'r')
  } catch {
    return
  }
  try {
    fsyncSync(dfd)
  } catch (e) { console.debug('[durable-write] EPERM/EISDIR on some platforms  tolerated:', messageOf(e)) } finally {
    closeSync(dfd)
  }
}

/**
 * writeSync is permitted to consume fewer bytes than it was given — a short write. Trusting a
 * single call here would fsync a truncated tmp file and then durably rename/append it over the
 * last-good file, which is exactly the torn-write crash this module exists to prevent (it just
 * arrives without a crash: the caller never sees an error, and the file is short from then on).
 * Mirrors the drain loop ../atomic-write.ts already uses for the same hazard on keys.json.
 */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf8')
  let written = 0
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written)
    if (n <= 0) throw new Error(`durable-write: write stalled at ${written}/${buf.length} bytes`)
    written += n
  }
}

/**
 * Atomically AND durably write `text` to `path`: tmp file → fsync(tmp) → rename → fsync(dir).
 * Crash-safe (survives power loss after return), unlike a bare writeFileSync + renameSync.
 * Drop-in replacement for the duplicated `atomicWrite(path, text)` helpers.
 */
export function atomicWriteDurable(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  const fd = openSync(tmp, 'w')
  try {
    writeAllSync(fd, text)
    fsyncSync(fd) // flush the tmp file's data to disk BEFORE the rename
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  fsyncDir(dirname(path))
}

/**
 * Durably append `text` to `path` (O_APPEND is atomic for a single complete-line write; this
 * adds the missing fsync). For the append-only ledgers (e.g. forecast-ledger's pre-act log).
 */
export function durableAppend(path: string, text: string): void {
  const fd = openSync(path, 'a')
  try {
    writeAllSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
