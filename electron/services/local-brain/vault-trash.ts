// vault-trash.ts — THE single soft-delete primitive for vault notes.
//
// Why this module exists: the renderer's Delete button (POST /state/doc/delete in
// brain-native-routes-2.ts) already did the right thing — mkdir <vault>/.trash,
// disambiguate the basename against existing tombstones, renameSync in. But the
// model-driven delete_file tool (executeDeleteFile in agui-executors.ts) called a bare
// unlinkSync, so the ONE actor that is guessing — the LLM deciding which note is a
// "duplicate" — got the irreversible path while the human who knows what they are
// deleting got the recoverable one. Under the default posture (DUIN_AGUI_APPROVAL unset
// ⇒ 'trusted-afk') no human is in the loop, so a misjudged delete_file destroyed
// hand-authored content with no copy anywhere: moat-backup snapshots only the claim
// ledger and construction cache ("the notes … are never touched here"), and index-store's
// pruneToKeep drops the notes_chunks rows on the reindex that the unlink itself triggers.
//
// Both call sites now share this implementation, so the guard cannot drift apart again.
//
// Traceability (the vault SHOULD self-evolve, but every alteration must be recoverable):
// the tombstone is flattened into .trash, which loses the original folder — so we also
// append a JSONL journal line recording what was removed, from where, when, by whom, and
// where the bytes now live. Journal failure never fails the delete; the bytes are already
// safe by then.

import { existsSync, mkdirSync, renameSync, copyFileSync, appendFileSync, readFileSync, statSync, unlinkSync } from 'fs'
import { basename, join, relative, sep } from 'path'

export const TRASH_DIR_NAME = '.trash'
export const TOMBSTONE_JOURNAL = '_tombstones.jsonl'

/** Retention. `.trash` is append-only by design, so on a working vault it grows without bound — every
 *  overwrite snapshots a copy, and nothing ever removed one. That is a real cost on a personal vault
 *  (this one carries ~979 notes), but pruning is DELETION inside the one module whose entire job is
 *  preservation, so the policy is deliberately timid and layered:
 *
 *  - MIN_KEEP_DAYS is a HARD FLOOR. Nothing younger is ever removed, whatever the caps say. Without it
 *    a burst of edits could evict the very tombstone you are reaching for — the caps would turn a
 *    recovery surface into a shredder exactly when it is being used most.
 *  - The count and byte caps only ever act on entries ALREADY past that floor, oldest first.
 *  - The journal is never pruned. It is small, append-only, and it is the record of what the pruning
 *    itself did; deleting it would erase the audit of the audit.
 *  - A tombstone with no journal line is treated as PROTECTED, not as garbage. An unexplained file in
 *    .trash is exactly the thing least safe to delete on a guess.
 */
export const MIN_KEEP_DAYS = 30
export const MAX_TOMBSTONES = 1000
export const MAX_TRASH_BYTES = 512 * 1024 * 1024 // 512 MB

export interface TrashPolicy {
  minKeepDays?: number
  maxEntries?: number
  maxBytes?: number
  now?: number
}

export type TombstoneResult =
  | { ok: true; trashRel: string }
  | { ok: false; error: string }

/** Pick a not-yet-taken name inside trashDir for `base`, disambiguating collisions so
 *  re-deleting same-named notes from different folders can't clobber an earlier tombstone. */
function uniqueTombstonePath(trashDir: string, base: string): string {
  let target = join(trashDir, base)
  if (!existsSync(target)) return target
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  let n = 0
  do {
    target = join(trashDir, `${stem}.${Date.now()}${n ? `-${n}` : ''}${ext}`)
    n++
  } while (existsSync(target))
  return target
}

/**
 * Soft-delete `absFile` by moving it into `<vaultDir>/.trash` instead of unlinking it.
 * Returns the trash-relative tombstone name so callers can tell the operator (or the
 * model) where the prior content went.
 *
 * `actor` is recorded in the journal — 'agent' for the model-driven delete_file tool,
 * 'ui' for the renderer's Delete button — so a later recovery can tell who removed what.
 */
export function tombstoneToTrash(
  vaultDir: string,
  absFile: string,
  actor: string,
  reason?: string
): TombstoneResult {
  return stageToTrash(vaultDir, absFile, actor, 'delete', reason)
}

/**
 * Preserve the CURRENT bytes of `absFile` in `<vaultDir>/.trash` and leave the original
 * in place, so the caller can then overwrite it. Same trash dir, same journal, same
 * disambiguation as `tombstoneToTrash` — recovery stays in one place regardless of
 * whether the prior content was removed by a delete or replaced by a rewrite.
 *
 * Why an overwrite needs this at all: a soft-delete makes a *removal* reversible, but a
 * rewrite that replaces a hand-authored body with a model-merged one destroys the prior
 * content just as permanently, and leaves no tombstone to recover from. `copyFileSync`
 * rather than `renameSync` because the file must survive the call: the original inode's
 * birthtime is the memory entry's createdAt, and a rename would reset it on every edit.
 *
 * Never throws: a failed snapshot is reported so the caller can decide, and the caller's
 * safe side is to skip the destructive write rather than proceed blind.
 */
export function snapshotToTrash(
  vaultDir: string,
  absFile: string,
  actor: string,
  reason?: string
): TombstoneResult {
  return stageToTrash(vaultDir, absFile, actor, 'overwrite', reason)
}

/** Store-relative, forward-slashed form of `absFile` for the journal's `from`/`to` fields, so the
 *  record reads identically on every platform. Falls back to the absolute path when the file is not
 *  under `vaultDir` — the journal must still say honestly where the bytes came from. */
function originRel(vaultDir: string, absFile: string): string {
  try {
    const rel = relative(vaultDir, absFile)
    if (rel && !rel.startsWith('..')) return rel.split(sep).join('/')
  } catch {
    /* keep the absolute path */
  }
  return absFile
}

/**
 * Journal that `absFile` has just been CREATED. Writes no bytes into `.trash`; it appends the one
 * line saying that a path which may once have been deleted is live again.
 *
 * Why a creation needs a journal line at all: this journal is the only durable record of which live
 * paths are currently deleted, and moat-durability's boot rehydrate reads it to decide which
 * vault-projected memories the user has thrown away. Without a create line a delete would stay the
 * last word about that path forever, so re-creating a memory under a previously-deleted name (an
 * accidental delete typed back in, or `clearAllMemories` followed by `importMemories` restoring a
 * backup) would leave it permanently un-restorable — turning a resurrection bug into a
 * disappearance bug. Keyed like `restore`: the live path goes in `to`.
 *
 * No-op when `.trash` does not exist. With no journal there is no delete line to supersede, so a
 * profile that has never deleted anything stays free of bookkeeping it does not need.
 * Never throws — a creation must not fail because its audit line could not be written.
 */
export function recordCreation(vaultDir: string, absFile: string, actor: string): void {
  try {
    if (!vaultDir) return
    const trashDir = join(vaultDir, TRASH_DIR_NAME)
    if (!existsSync(trashDir)) return
    appendFileSync(
      join(trashDir, TOMBSTONE_JOURNAL),
      JSON.stringify({ at: new Date().toISOString(), actor, to: originRel(vaultDir, absFile), op: 'create' }) + '\n',
      'utf-8'
    )
  } catch {
    // The file is already written; a journal failure must not fail the creation.
  }
}

function stageToTrash(
  vaultDir: string,
  absFile: string,
  actor: string,
  op: 'delete' | 'overwrite',
  reason?: string
): TombstoneResult {
  try {
    if (!vaultDir) return { ok: false, error: 'vault dir is not configured' }
    if (!existsSync(absFile)) return { ok: false, error: 'file not found' }
    const trashDir = join(vaultDir, TRASH_DIR_NAME)
    mkdirSync(trashDir, { recursive: true })
    const target = uniqueTombstonePath(trashDir, basename(absFile))
    // Capture the origin BEFORE the rename — afterwards absFile no longer exists.
    const origin = originRel(vaultDir, absFile)
    if (op === 'overwrite') copyFileSync(absFile, target)
    else renameSync(absFile, target)
    const trashRel = `${TRASH_DIR_NAME}/${basename(target)}`
    try {
      appendFileSync(
        join(trashDir, TOMBSTONE_JOURNAL),
        JSON.stringify({
          at: new Date().toISOString(),
          actor,
          from: origin,
          to: trashRel,
          ...(op === 'overwrite' ? { op } : {}),
          ...(reason ? { reason } : {})
        }) + '\n',
        'utf-8'
      )
    } catch {
      // The bytes are already preserved; a journal failure must not fail the delete.
    }
    return { ok: true, trashRel }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'soft-delete failed' }
  }
}

/** One recoverable entry: a journal line joined to the bytes still on disk. */
export interface Tombstone {
  at: string
  actor: string
  /** vault-relative path the content came FROM (where a restore puts it back) */
  from: string
  /** `.trash/<name>` — where the bytes live now */
  to: string
  /** `restore`, `create` and `prune` lines are bookkeeping, not recoverable content — they are listed
   *  so the history reads honestly, but pruning skips them. */
  op: 'delete' | 'overwrite' | 'restore' | 'create' | 'prune'
  reason?: string
  bytes: number
  /** false when the journal names a tombstone whose file is gone (pruned or removed by hand) */
  present: boolean
}

/** Read the recovery surface. Until now the ONLY route to a tombstone was reading the raw JSONL by
 *  hand, or catching the path in whatever string a tool happened to print — which meant the
 *  preservation work of this whole audit was, in practice, hard to actually use. This joins the journal
 *  to what is really on disk so a caller can list, show, and restore.
 *
 *  Unparseable journal lines are SKIPPED, never rewritten: this function must not be able to damage the
 *  record it reads (that exact "rewrite drops what it could not parse" pattern was one of the defects
 *  this audit fixed elsewhere). Newest first. */
export function listTombstones(vaultDir: string): Tombstone[] {
  const trashDir = join(vaultDir, TRASH_DIR_NAME)
  const journal = join(trashDir, TOMBSTONE_JOURNAL)
  if (!vaultDir || !existsSync(journal)) return []
  let raw: string
  try {
    raw = readFileSync(journal, 'utf-8')
  } catch {
    return []
  }
  const out: Tombstone[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const to = typeof j.to === 'string' ? j.to : ''
      if (!to) continue
      const abs = join(vaultDir, to)
      let bytes = 0
      let present = false
      try {
        bytes = statSync(abs).size
        present = true
      } catch {
        /* pruned or removed by hand — reported, not hidden */
      }
      out.push({
        at: String(j.at ?? ''),
        actor: String(j.actor ?? 'unknown'),
        from: String(j.from ?? ''),
        to,
        // A missing `op` IS a delete (stageToTrash omits the field for that case), which is why every
        // other op must be listed here: an unrecognised op falls through to 'delete', and a 'create'
        // read as a delete would put a LIVE file's path in front of pruneTrash's unlink.
        op:
          j.op === 'overwrite' || j.op === 'restore' || j.op === 'create' || j.op === 'prune'
            ? (j.op as 'overwrite' | 'restore' | 'create' | 'prune')
            : 'delete',
        ...(typeof j.reason === 'string' ? { reason: j.reason } : {}),
        bytes,
        present
      })
    } catch {
      // Malformed line — skip it. Never rewrite the journal from a read path.
    }
  }
  return out.reverse()
}

/** Put a tombstone's bytes back where they came from.
 *
 *  Refuses rather than overwrites when something already occupies the origin: a restore is a recovery,
 *  and silently clobbering whatever is there now would be the very failure this module exists to
 *  prevent. The caller can snapshot the occupant first and retry. Copies rather than moves, so a failed
 *  or unwanted restore still leaves the tombstone intact. */
export function restoreTombstone(vaultDir: string, trashRel: string, opts: { overwrite?: boolean } = {}): TombstoneResult {
  try {
    if (!vaultDir) return { ok: false, error: 'vault dir is not configured' }
    const entry = listTombstones(vaultDir).find((t) => t.to === trashRel)
    if (!entry) return { ok: false, error: 'no journal entry for that tombstone' }
    if (!entry.present) return { ok: false, error: 'tombstone bytes are no longer on disk' }
    if (!entry.from || entry.from.startsWith('..')) return { ok: false, error: 'unsafe origin path' }
    const dest = join(vaultDir, entry.from)
    if (existsSync(dest) && !opts.overwrite) {
      return { ok: false, error: `refusing to overwrite existing ${entry.from} — snapshot it first or pass overwrite` }
    }
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(join(vaultDir, trashRel), dest)
    try {
      appendFileSync(
        join(vaultDir, TRASH_DIR_NAME, TOMBSTONE_JOURNAL),
        JSON.stringify({ at: new Date().toISOString(), actor: 'restore', from: trashRel, to: entry.from, op: 'restore' }) + '\n',
        'utf-8'
      )
    } catch {
      /* bytes are restored; journal failure must not fail the restore */
    }
    return { ok: true, trashRel: entry.from }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'restore failed' }
  }
}

/** Enforce retention. Returns what it removed. See the policy constants above for why this is timid.
 *  Deliberately NOT called automatically on every stage — a delete path should not also be a delete
 *  path for OTHER people's data. Callers invoke it on a maintenance tick, so pruning is a decision
 *  rather than a side effect of an unrelated write. */
export function pruneTrash(vaultDir: string, policy: TrashPolicy = {}): { removed: string[]; freedBytes: number; kept: number } {
  const minKeepDays = policy.minKeepDays ?? MIN_KEEP_DAYS
  const maxEntries = policy.maxEntries ?? MAX_TOMBSTONES
  const maxBytes = policy.maxBytes ?? MAX_TRASH_BYTES
  const now = policy.now ?? Date.now()
  const removed: string[] = []
  let freedBytes = 0
  const trashDir = join(vaultDir, TRASH_DIR_NAME)
  if (!vaultDir || !existsSync(trashDir)) return { removed, freedBytes, kept: 0 }

  // Only journalled entries are candidates. A file in .trash with no journal line is unexplained, and
  // an unexplained file is the LAST thing to delete on a guess — it stays.
  const entries = listTombstones(vaultDir).filter((t) => t.present && (t.op === 'delete' || t.op === 'overwrite'))
  const floor = now - minKeepDays * 24 * 60 * 60 * 1000
  const agedOut = entries.filter((t) => {
    const ts = Date.parse(t.at)
    return Number.isFinite(ts) && ts < floor // an unparseable date is treated as young ⇒ protected
  })
  // Oldest first among those already past the hard floor.
  agedOut.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

  let total = entries.reduce((n, t) => n + t.bytes, 0)
  let count = entries.length
  for (const t of agedOut) {
    if (count <= maxEntries && total <= maxBytes) break
    try {
      unlinkSync(join(vaultDir, t.to))
      removed.push(t.to)
      freedBytes += t.bytes
      total -= t.bytes
      count--
    } catch {
      /* already gone or locked — skip, never abort the sweep */
    }
  }
  if (removed.length) {
    try {
      appendFileSync(
        join(trashDir, TOMBSTONE_JOURNAL),
        JSON.stringify({ at: new Date().toISOString(), actor: 'prune', op: 'prune', removed: removed.length, freedBytes }) + '\n',
        'utf-8'
      )
    } catch {
      /* best-effort */
    }
  }
  return { removed, freedBytes, kept: count }
}
