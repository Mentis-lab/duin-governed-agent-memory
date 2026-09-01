import { closeSync, fdatasyncSync, mkdirSync, openSync, renameSync, writeSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Crash-safe synchronous file write: write to a temp file, fsync the data to
 * disk, then atomically rename it over the target.
 *
 * This closes the "rename landed but the data pages didn't" torn-write window:
 * a plain writeFileSync (or a temp+rename without fsync) can leave a
 * zero-length / half-written file after a crash or power loss. For a small
 * high-value file — keys.json (the DB-encryption passphrase + provider API
 * keys), settings.json, the MCP config — that torn write is catastrophic
 * (e.g. an unrecoverable encrypted database). Use this instead of writeFileSync
 * for those files.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer, mode = 0o600): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.atomic-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
  // Normalised to a Buffer so the write loop below can count bytes; writeSync's string overload
  // takes a character position, which is not the same unit once the payload is non-ASCII.
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
  const fd = openSync(tmp, 'wx', mode)
  try {
    // writeSync is permitted to consume fewer bytes than it was given. Trusting one call would
    // fsync a truncated payload and rename it over the last good file — for keys.json that is
    // the unrecoverable loss this module exists to prevent — so drain the buffer.
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error(`atomicWriteFileSync: write stalled at ${written}/${buf.length} bytes for ${target}`)
      written += n
    }
    // Flush the data to disk BEFORE the rename metadata commits, so a crash
    // between the two can only leave the old file intact — never a torn new one.
    fdatasyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
}
