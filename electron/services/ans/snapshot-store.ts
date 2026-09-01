// snapshot-store — content snapshots for the safe-undo stack (item 23). Captures prior file content
// (or null = "the file did not exist", so a revert deletes it) under userData/ans-undo/snapshots,
// crash-safe via atomicWriteDurable. Pure IO — the action-ledger owns lifecycle + the demote signal.
import { mkdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteDurable } from '../brain/durable-write'
import { messageOf } from '../guarded'

let dir: string | null = null

export function setSnapshotDir(userData: string): void {
  dir = join(userData, 'ans-undo', 'snapshots')
}

export function captureSnapshot(content: string | null): string {
  if (!dir) throw new Error('snapshot dir not set')
  const ref = `${Date.now()}-${randomUUID()}`
  mkdirSync(dir, { recursive: true })
  atomicWriteDurable(join(dir, `${ref}.json`), JSON.stringify({ content }))
  return ref
}

export function readSnapshot(ref: string): { content: string | null } {
  if (!dir) throw new Error('snapshot dir not set')
  return JSON.parse(readFileSync(join(dir, `${ref}.json`), 'utf-8'))
}

/** Delete a consumed snapshot (called after a SUCCESSFUL revert — item 23, growth-cap). Best-effort:
 *  a missing file is fine, and we never throw so the revert's ok:true result stays authoritative. */
export function deleteSnapshot(ref: string): void {
  if (!dir || !ref) return
  try {
    unlinkSync(join(dir, `${ref}.json`))
  } catch (e) { console.debug('[snapshot-store] already gone / never written:', messageOf(e)) }
}
