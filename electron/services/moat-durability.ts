// Moat durability (portability audit A2/A5/A7 + A1 — PLANNING/DUIN_AUDIT_REMEDIATION.md).
// Hardened per PLANNING/DUIN_PORTABILITY_PASS_REVIEW.md:
//   H1 — vault-switch clobber guard (origin marker + clean switch)
//   H2 — atomic writes (a crash mid-write must not tear the durable record)
//   H3 — validate JSON on rehydrate (never copy a corrupt vault file into userData)
//   M6 — loud failures (log, don't swallow — a broken durability feature must not look idle)
//
// The learned/earned state that `moat-health` measures — operator facts, success exemplars, the
// earned-autonomy ledger — lives as JSON in `userData` for fast runtime access by many readers.
// But it is the MOAT: it must survive a reinstall and travel with the vault. We keep `userData`
// authoritative in-session and mirror these files to `<vault>/.brain/_moat/`; on boot, a file
// MISSING from userData but present in the vault is restored. The vault copy is the durable record.
//
// Limitation: this gives reinstall/new-machine durability, not live cross-machine MERGE.

import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, appendFileSync } from 'fs'
import { join, dirname, resolve, sep } from 'path'
import { atomicWriteFileSync } from './atomic-write'
import { messageOf } from './guarded'
// Imported rather than re-declared so the recovery-store name cannot drift away from the module
// that actually creates it (vault-trash mkdirs `<root>/.trash` and writes `_tombstones.jsonl`).
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './local-brain/vault-trash'

// The three userData JSON stores that are moat state (not rebuildable indexes).
const MOAT_FILES = ['operator-model.json', 'success-traces.json', 'ans-capabilities.json'] as const
const MEMORY_USERDATA_SUBDIR = 'lamprey-memory'
const MEMORY_VAULT_SUBDIR = join('.brain', '_memory-store')
// H1: which vault userData's moat belongs to. Projection must mirror ONLY to this vault —
// projecting vault A's moat (still in userData) into a freshly-switched vault B would silently
// clobber B's durable record. A plain marker file in userData.
const ORIGIN_MARKER = '.moat-vault-origin'

function vaultMoatPath(vaultDir: string, name: string): string {
  return join(vaultDir, '.brain', '_moat', name)
}

function isValidJson(s: string): boolean {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

export function readMoatOrigin(userDataDir: string): string | null {
  try {
    const p = join(userDataDir, ORIGIN_MARKER)
    if (!existsSync(p)) return null
    return readFileSync(p, 'utf-8').trim() || null
  } catch (e) {
    console.warn('[moat-durability] read origin failed:', (e as Error)?.message)
    return null
  }
}

export function writeMoatOrigin(userDataDir: string, vaultDir: string): void {
  try {
    atomicWriteFileSync(join(userDataDir, ORIGIN_MARKER), vaultDir, 0o644)
  } catch (e) {
    console.warn('[moat-durability] stamp origin failed:', (e as Error)?.message)
  }
}

/**
 * Compare two vault paths as LOCATIONS, not as strings.
 *
 * The origin marker is stamped from whatever spelling the caller happened to hold, while the live
 * comparand comes from `settings.localBrainNotesDir` — a value the folder-picker, onboarding and
 * hand-edited settings.json each spell differently. On Windows 'D:\\x\\my-vault' and
 * 'D:/x/my-vault' are the SAME directory, but a raw `===` calls them different, so H1 concludes
 * "userData belongs to another vault" and refuses to project its own vault forever. That failure is
 * silent and open-ended: every 5-minute flush and the before-quit flush warn and write nothing, the
 * vault projection freezes at whatever it held on the day the spelling changed, and (since the
 * verified-flush guard landed) every vault switch aborts as 'retained' with no way to succeed. The
 * anti-clobber guard ends up destroying the durability it exists to protect.
 *
 * `resolve` is the normaliser already used for path identity in this codebase (see
 * path-utils.ts: drive letter, separators, `..` flattening, trailing slash). Case folding is applied
 * only on win32, where the filesystem itself is case-insensitive — folding on POSIX would make two
 * genuinely distinct vaults compare equal and REINTRODUCE the cross-vault clobber H1 prevents.
 * Distinct directories still compare distinct on every platform, so the guard is unchanged in
 * strength; only spelling noise is removed.
 */
export function sameVaultPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  try {
    const norm = (p: string): string => {
      const r = resolve(p.trim())
      return process.platform === 'win32' ? r.toLowerCase() : r
    }
    return norm(a) === norm(b)
  } catch (e) {
    // Un-resolvable input: fall back to the strict comparison rather than guessing equal. Claiming
    // two vaults are the same is the clobbering direction, so ambiguity must resolve to "different".
    console.debug('[moat-durability] vault path compare failed:', messageOf(e))
    return a === b
  }
}

/**
 * H1: may userData's moat be projected to this vault? True when origin is unset (first run / single
 * vault) or names the same directory. A mismatch means the vault was switched but userData still
 * holds the OLD vault's moat, so projecting would clobber the NEW vault → skip until a clean reload
 * (see switchMoatVault).
 */
export function canProjectToVault(userDataDir: string, vaultDir: string): boolean {
  const origin = readMoatOrigin(userDataDir)
  return !origin || sameVaultPath(origin, vaultDir)
}

/**
 * On boot: restore any moat file that userData lacks but the vault has. Runtime authority stays
 * with userData — an existing file is not overwritten. H2 atomic write; H3 validates JSON first.
 */
export function rehydrateMoatFromVault(userDataDir: string, vaultDir: string | null | undefined): string[] {
  if (!vaultDir) return []
  const restored: string[] = []
  // Moat files userData ALREADY held. Their provenance is unknown to this function — after an
  // aborted vault switch they are the OLD vault's — so they are precisely the files that must not
  // be relabelled as belonging to `vaultDir`. Tracked separately because `restored` cannot see them.
  const preexisting: string[] = []
  for (const name of MOAT_FILES) {
    try {
      const dest = join(userDataDir, name)
      if (existsSync(dest)) {
        preexisting.push(name)
        continue // runtime copy wins in-session
      }
      const src = vaultMoatPath(vaultDir, name)
      if (!existsSync(src)) continue
      const data = readFileSync(src, 'utf-8')
      if (!isValidJson(data)) {
        // H3 — never copy a corrupt vault JSON into userData (the store would throw on parse).
        console.warn(`[moat-durability] vault moat '${name}' is corrupt JSON — skipping restore`)
        continue
      }
      atomicWriteFileSync(dest, data, 0o644) // H2
      restored.push(name)
    } catch (e) {
      console.warn(`[moat-durability] rehydrate '${name}' failed:`, (e as Error)?.message) // M6
    }
  }
  if (restored.length) {
    console.log(`[moat-durability] rehydrated from vault: ${restored.join(', ')}`)
  }
  // H1 — stamp origin so projection knows which vault userData belongs to. Only when unset (first
  // run) or when userData's moat came ENTIRELY from this vault; do NOT relabel a set-but-different
  // origin — that is switchMoatVault's job.
  //
  // Why the old `restored.length > 0` read as correct and was not: the loop SKIPS every file
  // userData already has, so a non-empty `restored` proves only that AT LEAST ONE of MOAT_FILES came
  // from `vaultDir` — never that all three did. A PARTIAL restore is the normal state after a vault
  // switch hit the verified-flush abort below, which deliberately leaves the marker naming the OLD
  // vault A: settings already say B, userData still holds A's operator model and capability ledger,
  // and established vault B supplies the one file A never had. Restamping on that single restore
  // disarmed the very guard the abort depends on, and the next flush wrote A's moat — and A's
  // lamprey-memory notes, which share this predicate via canProjectToVault — over B's durable
  // record. Requiring an empty skip list makes the claim the marker asserts actually true.
  const prior = readMoatOrigin(userDataDir)
  if (!prior || (restored.length > 0 && preexisting.length === 0)) {
    writeMoatOrigin(userDataDir, vaultDir)
  } else if (preexisting.length > 0 && !sameVaultPath(prior, vaultDir)) {
    // M6 — refusing is the correct outcome until switchMoatVault completes cleanly, but a silently
    // frozen projection is the failure mode this module exists to avoid. Name the retained files.
    console.warn(
      `[moat-durability] moat origin stays '${prior}': userData still holds moat file(s) from it ` +
        `(${preexisting.join(', ')}), so projection to '${vaultDir}' remains refused until a clean vault switch`
    )
  }
  return restored
}

/**
 * Mirror the current userData moat files into the vault projection. Idempotent (skips unchanged),
 * atomic (H2), loud on failure (M6). H1 — refuses to project if userData's moat belongs to a
 * different vault (prevents cross-vault clobber). Returns the count actually written.
 */
export function projectMoatToVault(userDataDir: string, vaultDir: string | null | undefined): number {
  if (!vaultDir) return 0
  if (!canProjectToVault(userDataDir, vaultDir)) {
    console.warn(
      `[moat-durability] skip moat projection: userData belongs to vault '${readMoatOrigin(userDataDir)}', not '${vaultDir}' — refusing to clobber`
    )
    return 0
  }
  let written = 0
  for (const name of MOAT_FILES) {
    try {
      const src = join(userDataDir, name)
      if (!existsSync(src)) continue
      const contents = readFileSync(src, 'utf-8')
      const dest = vaultMoatPath(vaultDir, name)
      if (existsSync(dest)) {
        try {
          if (readFileSync(dest, 'utf-8') === contents) continue // unchanged — skip
        } catch (e) { console.debug('[moat-durability] fall through and rewrite:', messageOf(e)) }
      }
      atomicWriteFileSync(dest, contents, 0o644) // H2
      written++
    } catch (e) {
      console.warn(`[moat-durability] project '${name}' failed:`, (e as Error)?.message) // M6
    }
  }
  return written
}

// ─── Memory-store durability (audit A1) ──────────────────────────────────────
// "Remember this" (memory:add) writes durable user knowledge to userData/lamprey-memory/ —
// off-vault. Mirror to <vault>/.brain/_memory-store/ (NOT .brain/memory, which loadBrain body-dumps
// into grounding) so this portability fix creates no grounding double-injection.

/**
 * Enumerate EVERY file in the memory store, relative to `root`.
 *
 * This was `collectMdRel`: `.md` files only, and `if (e.name.startsWith('.')) continue` for
 * directories. Both filters were silently wrong for the one job this collector actually has —
 * telling switchMoatVault what it is about to `rmSync(..., {recursive:true})`.
 *
 * `<userData>/lamprey-memory/.trash` is the memory store's RECOVERY layer: softDeleteMemoryFile
 * tombstones deleted memories into it, snapshotPriorVersion copies the prior body of a memory in
 * before an overwrite replaces it, and `_tombstones.jsonl` (not a `.md` file) is the journal saying
 * what went where and when. Skipping dot-directories hid that whole subtree from BOTH
 * projectMemoryToVault and auditMoatProjection, so the audit reported `complete: true` while the
 * recovery layer had never been projected anywhere — and step 3 of the switch then deleted it. The
 * live notes survived; every undo of a hand-authored memory did not, and nothing else holds them
 * (moat-backup does not cover lamprey-memory, and the SQLite mirror holds live rows only).
 *
 * So the collector now matches the delete: whatever the switch will destroy, the switch must first
 * project and verify. `node_modules` stays excluded (never ours, and never written here), and
 * symlinks are still skipped — a dirent that is neither a file nor a directory is not followed.
 */
function collectMemoryRel(root: string, rel: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const childRel = rel ? join(rel, e.name) : e.name
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      collectMemoryRel(root, childRel, out)
    } else if (e.isFile()) {
      out.push(childRel)
    }
  }
}

/** Is this memory-store-relative path part of the `.trash` recovery layer? */
function isRecoveryRel(rel: string): boolean {
  return rel === TRASH_DIR_NAME || rel.startsWith(TRASH_DIR_NAME + sep)
}

/**
 * Byte-for-byte comparison for memory files. The `.md` notes are UTF-8, but the collector now also
 * carries `_tombstones.jsonl` and arbitrary tombstoned bodies, and a utf-8 round-trip turns invalid
 * bytes into U+FFFD identically on both sides — which would make a CORRUPTED copy compare equal and
 * hand the delete a false "verified". Buffers cannot lie about that.
 */
function sameBytes(src: string, dest: string): boolean {
  try {
    if (!existsSync(dest)) return false
    return readFileSync(src).equals(readFileSync(dest))
  } catch (e) {
    // Unreadable counts as NOT projected — the whole point is to be conservative before deleting.
    console.debug('[moat-durability] verify bytes failed:', messageOf(e))
    return false
  }
}

/**
 * H1b — did the projection actually LAND? `projectMoatToVault`/`projectMemoryToVault` return the
 * count they WROTE, which conflates three very different outcomes: written, skipped-because-already-
 * identical (fine), and skipped-because-it-failed (not fine — the per-file catch at M6 warns and
 * continues, and canProjectToVault returns 0 for the whole call). Counting writes therefore cannot
 * tell a complete flush from a partial one, so anything that DELETES the userData originals must
 * verify the durable copy instead of trusting a count.
 *
 * This re-reads every userData source and requires a byte-identical counterpart in the vault. It is
 * deliberately content-based, not count-based: a file skipped as "unchanged" verifies, a file whose
 * atomicWriteFileSync threw EACCES/ENOSPC mid-loop does not.
 */
export type MoatProjectionAudit = {
  /** True only when EVERY userData moat file and memory note has a byte-identical vault copy. */
  complete: boolean
  /** Moat JSONs present in userData with no verified vault copy. */
  moatPending: string[]
  /** Memory-store files (store-relative) present in userData with no verified vault copy.
   *  Includes the `.trash` recovery layer — it is inside the subtree the switch deletes. */
  memoryPending: string[]
  moatVerified: number
  memoryVerified: number
  /** Of `memoryVerified`, how many are `.trash` recovery entries (tombstones, pre-overwrite
   *  snapshots, `_tombstones.jsonl`). Journalled so "the undo history travelled too" is provable
   *  after the fact, not merely assumed. */
  trashVerified: number
}

function sameContents(src: string, dest: string): boolean {
  try {
    if (!existsSync(dest)) return false
    return readFileSync(src, 'utf-8') === readFileSync(dest, 'utf-8')
  } catch (e) {
    // Unreadable counts as NOT projected — the whole point is to be conservative before deleting.
    console.debug('[moat-durability] verify read failed:', messageOf(e))
    return false
  }
}

export function auditMoatProjection(
  userDataDir: string,
  vaultDir: string | null | undefined
): MoatProjectionAudit {
  const moatPending: string[] = []
  const memoryPending: string[] = []
  let moatVerified = 0
  let memoryVerified = 0
  let trashVerified = 0

  const memRoot = join(userDataDir, MEMORY_USERDATA_SUBDIR)
  const memFiles: string[] = []
  if (existsSync(memRoot)) collectMemoryRel(memRoot, '', memFiles)

  if (!vaultDir) {
    // No target at all: every source file is unprojected by definition.
    for (const name of MOAT_FILES) if (existsSync(join(userDataDir, name))) moatPending.push(name)
    memoryPending.push(...memFiles)
  } else {
    for (const name of MOAT_FILES) {
      const src = join(userDataDir, name)
      if (!existsSync(src)) continue
      if (sameContents(src, vaultMoatPath(vaultDir, name))) moatVerified++
      else moatPending.push(name)
    }
    for (const rel of memFiles) {
      if (sameBytes(join(memRoot, rel), join(vaultDir, MEMORY_VAULT_SUBDIR, rel))) {
        memoryVerified++
        if (isRecoveryRel(rel)) trashVerified++
      } else memoryPending.push(rel)
    }
  }
  return {
    complete: moatPending.length === 0 && memoryPending.length === 0,
    moatPending,
    memoryPending,
    moatVerified,
    memoryVerified,
    trashVerified
  }
}

/** Mirror the userData memory store — live notes AND the `.trash` recovery layer — into the vault
 *  projection. Atomic, loud, H1-guarded. */
export function projectMemoryToVault(userDataDir: string, vaultDir: string | null | undefined): number {
  if (!vaultDir) return 0
  if (!canProjectToVault(userDataDir, vaultDir)) return 0 // H1 (moat projection already logged the reason)
  const srcRoot = join(userDataDir, MEMORY_USERDATA_SUBDIR)
  if (!existsSync(srcRoot)) return 0
  const destRoot = join(vaultDir, MEMORY_VAULT_SUBDIR)
  const files: string[] = []
  collectMemoryRel(srcRoot, '', files)
  let written = 0
  for (const rel of files) {
    try {
      const src = join(srcRoot, rel)
      const dest = join(destRoot, rel)
      if (sameBytes(src, dest)) continue // unchanged — skip
      atomicWriteFileSync(dest, readFileSync(src), 0o644) // H2
      written++
    } catch (e) {
      console.warn(`[moat-durability] project memory '${rel}' failed:`, (e as Error)?.message) // M6
    }
  }
  return written
}

/** Store-relative paths for comparison. The tombstone journal records `from`/`to` forward-slashed
 *  (vault-trash's originRel), while collectMemoryRel yields platform separators. */
function normStoreRel(rel: string): string {
  return rel.split(/[\\/]+/).filter(Boolean).join('/')
}

/** One journal line reduced to "which live path did this touch, and does it still exist after it?" */
type MemoryLifecycleEvent = { at: string; rel: string; deleted: boolean }

function readMemoryLifecycle(storeRoot: string, out: MemoryLifecycleEvent[]): void {
  const journal = join(storeRoot, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
  if (!existsSync(journal)) return
  let raw: string
  try {
    raw = readFileSync(journal, 'utf-8')
  } catch (e) {
    console.debug('[moat-durability] read tombstone journal failed:', messageOf(e))
    return
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const op = typeof j.op === 'string' ? j.op : 'delete' // stageToTrash omits `op` on a delete
      if (op === 'prune') continue // retention bookkeeping — names no live path
      // delete/overwrite record the live path in `from`; restore/create record it in `to`.
      const live = op === 'restore' || op === 'create' ? j.to : j.from
      if (typeof live !== 'string' || !live.trim()) continue
      out.push({ at: typeof j.at === 'string' ? j.at : '', rel: normStoreRel(live), deleted: op === 'delete' })
    } catch {
      // Malformed line — skip it. A read path must never fail on, or rewrite, the record it reads.
    }
  }
}

/**
 * Which memories has the user DELETED and not brought back?
 *
 * Why this is needed: the vault projection is additive — projectMemoryToVault only ever writes, and
 * nothing in this module ever prunes the projected tree — so a memory deleted from userData keeps
 * its vault copy forever. rehydrate restores exactly "present in the vault, absent from userData",
 * and a deleted memory satisfies that predicate every bit as well as a reinstalled one does. With no
 * way to tell the two apart, every launch resurrected every memory the user had ever deleted,
 * scanAndSync re-indexed it, and regenerateMemoryIndex put it back into the `<memory_index>` block
 * injected on every chat turn. What made it invisible is that the delete genuinely works: the file
 * really is gone from userData and from MEMORY.md — until the NEXT boot.
 *
 * `.trash/_tombstones.jsonl` is the record that distinguishes them. Its lines are keyed on the LIVE
 * store-relative path (delete and overwrite-snapshot name it in `from`, restore and create name it
 * in `to`), so the last line mentioning a path says whether it is currently deleted. Both journals
 * are read: userData's, which is authoritative and holds a delete that has not been flushed to the
 * vault yet, and the vault's projected copy, which is all that survives a reinstall or the clear
 * half of a vault switch. Neither is a superset of the other in every case, so the merged lines are
 * ordered by their own ISO timestamps.
 */
function deletedMemoryRels(userDataDir: string, vaultDir: string): Set<string> {
  const events: MemoryLifecycleEvent[] = []
  readMemoryLifecycle(join(vaultDir, MEMORY_VAULT_SUBDIR), events)
  readMemoryLifecycle(join(userDataDir, MEMORY_USERDATA_SUBDIR), events)
  // ISO-8601 sorts lexicographically, and Array#sort is stable, so lines sharing a timestamp keep
  // journal order (the vault copy, then the live journal it was projected from).
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  const deleted = new Set<string>()
  for (const e of events) {
    if (e.deleted) deleted.add(e.rel)
    else deleted.delete(e.rel)
  }
  return deleted
}

/** Restore memory-store files MISSING from userData from the vault projection (reinstall, or the
 *  reload half of a vault switch), EXCEPT the ones the user deleted — see deletedMemoryRels for why
 *  "missing from userData" alone cannot mean "restore me". Covers the `.trash` recovery layer, so a
 *  switch that cleared userData brings the undo history back with the notes. Atomic, loud. */
export function rehydrateMemoryFromVault(userDataDir: string, vaultDir: string | null | undefined): number {
  if (!vaultDir) return 0
  const srcRoot = join(vaultDir, MEMORY_VAULT_SUBDIR)
  if (!existsSync(srcRoot)) return 0
  const destRoot = join(userDataDir, MEMORY_USERDATA_SUBDIR)
  const files: string[] = []
  collectMemoryRel(srcRoot, '', files)
  const deleted = deletedMemoryRels(userDataDir, vaultDir)
  let restored = 0
  let withheld = 0
  for (const rel of files) {
    try {
      const dest = join(destRoot, rel)
      if (existsSync(dest)) continue // runtime copy wins in-session
      // The `.trash` layer is the record of the deletes themselves and must always come back; only
      // LIVE paths can be withheld, and only because the journal says the user threw them away.
      if (!isRecoveryRel(rel) && deleted.has(normStoreRel(rel))) {
        withheld++
        continue
      }
      atomicWriteFileSync(dest, readFileSync(join(srcRoot, rel)), 0o644) // H2
      restored++
    } catch (e) {
      console.warn(`[moat-durability] rehydrate memory '${rel}' failed:`, (e as Error)?.message) // M6
    }
  }
  if (restored) console.log(`[moat-durability] rehydrated ${restored} memory file(s) from vault`)
  // M6 — the bytes are still in the vault, so a wrong withholding must be visible rather than read
  // as "the vault never had it".
  if (withheld) {
    console.log(`[moat-durability] left ${withheld} deleted memory file(s) in the vault, unrestored`)
  }
  return restored
}

/**
 * Every vault switch appends one line here: what was flushed where, whether userData was cleared or
 * retained, and exactly which files were not durable. A switch that silently clears the moat is
 * indistinguishable from one that worked; this makes the difference recoverable after the fact.
 */
export const SWITCH_JOURNAL = '_moat-switch.jsonl'

/** Append one line to the vault-switch journal. Exported so the DB-table half of a vault switch
 *  (brain-db-durability) records its retain/reload decision in the SAME journal as the file half —
 *  one place to read "what happened to my data on the switch, and where did it go". */
export function recordSwitchOutcome(userDataDir: string, entry: Record<string, unknown>): void {
  try {
    appendFileSync(
      join(userDataDir, SWITCH_JOURNAL),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      'utf-8'
    )
  } catch (e) {
    // Journalling must never fail the switch — by this point the data decision is already made.
    console.debug('[moat-durability] switch journal failed:', messageOf(e))
  }
}

/** Verify that every durable file in the target vault was restored into userData.
 * This is the inverse of auditMoatProjection: both are required after a switch,
 * because one rejects leftover old-vault bytes while the other rejects missing
 * target-vault bytes. */
export function auditMoatRehydration(
  userDataDir: string,
  vaultDir: string
): { complete: boolean; moatPending: string[]; memoryPending: string[] } {
  const moatPending: string[] = []
  const memoryPending: string[] = []
  for (const name of MOAT_FILES) {
    const src = vaultMoatPath(vaultDir, name)
    if (existsSync(src) && !sameContents(src, join(userDataDir, name))) moatPending.push(name)
  }
  const vaultMemory = join(vaultDir, MEMORY_VAULT_SUBDIR)
  const expectedMemory: string[] = []
  if (existsSync(vaultMemory)) collectMemoryRel(vaultMemory, '', expectedMemory)
  const deleted = deletedMemoryRels(userDataDir, vaultDir)
  for (const rel of expectedMemory) {
    // The projection is additive, so a deleted live note remains in the vault.
    // Its tombstone is the durable instruction to withhold it; requiring that
    // stale live copy here would contradict rehydrateMemoryFromVault.
    if (!isRecoveryRel(rel) && deleted.has(normStoreRel(rel))) continue
    if (!sameBytes(join(vaultMemory, rel), join(userDataDir, MEMORY_USERDATA_SUBDIR, rel))) {
      memoryPending.push(rel)
    }
  }
  return {
    complete: moatPending.length === 0 && memoryPending.length === 0,
    moatPending,
    memoryPending
  }
}

export type MoatVaultSwitchResult =
  | {
      ok: true
      outcome: 'switched'
      from: string | null
      to: string
      flushTarget: string
      moatVerified: number
      memoryVerified: number
      trashVerified: number
    }
  | {
      ok: false
      outcome: 'retained'
      from: string | null
      to: string
      flushTarget: string
      reason: string
      moatPending: string[]
      memoryPending: string[]
    }
  | {
      ok: false
      outcome: 'failed'
      from: string | null
      to: string
      flushTarget: string
      error: string
      /** True when a destructive step had started but the prior vault snapshot
       * was verified back in userData before this failure was returned. */
      restored: boolean
    }

export interface MoatVaultSwitchDeps {
  /** Test seam for failure-injecting cleanup. Production uses fs.rmSync. */
  remove?: typeof rmSync
}

/**
 * H1 — clean vault switch. Final-flush the OLD vault, clear userData's moat + memory (now safely
 * projected to the old vault), reload the NEW vault, and restamp origin. The in-memory stores
 * (operator-model etc.) re-read from userData on next boot, so a RESTART is recommended after a
 * switch to fully reload the learned state; until then the origin marker prevents any clobber.
 */
export function switchMoatVault(
  userDataDir: string,
  oldVault: string | null | undefined,
  newVault: string,
  deps: MoatVaultSwitchDeps = {}
): MoatVaultSwitchResult {
  const from = oldVault ?? null
  const flushTarget = oldVault || newVault
  const remove = deps.remove ?? rmSync
  let destructiveStarted = false
  try {
    // 1. Final flush. With a previous vault, that vault is the durable home. On a FIRST vault pick
    //    (oldVault null — the folder-picker's ordinary onboarding path) userData's moat and the
    //    'Remember this' notes written by memory:add have NO durable home yet: the old code skipped
    //    step 1 entirely here and then still ran step 2, clearing content that had never been
    //    written anywhere. Adopt it forward into the new vault instead — H1 permits this because
    //    the origin marker is unset, and it is exactly what the next scheduled flush would do.
    projectMoatToVault(userDataDir, flushTarget)
    projectMemoryToVault(userDataDir, flushTarget)

    // 2. Clear userData — but ONLY once the flush is VERIFIED byte-for-byte in the vault.
    //    The projections above report how many files they WROTE, which cannot distinguish a
    //    complete flush from a partial one: canProjectToVault returns 0 for the whole call on an
    //    origin mismatch (after logging 'refusing to clobber'), and a per-file EACCES/ENOSPC is
    //    warn-and-continue. Deleting on an unverified flush destroys the very data the projection
    //    just refused, or failed, to copy — and nothing else holds these notes (the SQLite mirror
    //    drops rows whose file is gone, and moat-backup does not snapshot lamprey-memory).
    const audit = auditMoatProjection(userDataDir, flushTarget)
    if (!audit.complete) {
      const reason = oldVault
        ? 'final flush to the previous vault could not be verified'
        : 'first-time adoption into the new vault could not be verified'
      // Preserve + record + stamp: keep the originals exactly where they are, journal what did and
      // did not reach the vault, and abandon the switch loudly. The origin marker is left UNTOUCHED
      // on purpose — it still names the old vault, so canProjectToVault keeps refusing to project
      // this userData into the new vault. The existing H1 guard, not a new mechanism, protects the
      // new vault's record while the retained content waits for a retry.
      recordSwitchOutcome(userDataDir, {
        outcome: 'retained',
        from,
        to: newVault,
        flushTarget,
        reason,
        moatPending: audit.moatPending,
        memoryPending: audit.memoryPending,
        moatVerified: audit.moatVerified,
        memoryVerified: audit.memoryVerified,
        trashVerified: audit.trashVerified,
        retainedIn: [MEMORY_USERDATA_SUBDIR, ...MOAT_FILES]
      })
      console.warn(
        `[moat-durability] vault switch ${oldVault ?? '(none)'} -> ${newVault} ABORTED: ` +
          `${audit.moatPending.length} moat file(s) and ${audit.memoryPending.length} memory note(s) ` +
          `are not durable in '${flushTarget}' (verified ${audit.moatVerified} + ${audit.memoryVerified}). ` +
          `userData was left INTACT rather than cleared — see ${SWITCH_JOURNAL}. ` +
          `Fix vault write access (or the moat origin mismatch) and re-pick the folder.`
      )
      return {
        ok: false,
        outcome: 'retained',
        from,
        to: newVault,
        flushTarget,
        reason,
        moatPending: audit.moatPending,
        memoryPending: audit.memoryPending
      }
    }
    // 3. Clear userData's moat + memory + origin (they belong to the old vault, now durable there).
    destructiveStarted = true
    const cleanupErrors: string[] = []
    for (const name of MOAT_FILES) {
      try {
        remove(join(userDataDir, name), { force: true })
      } catch (e) { cleanupErrors.push(`${name}: ${messageOf(e)}`) }
    }
    try {
      // Recursive: this takes the `.trash` recovery layer too. That is only safe because the audit
      // above enumerates the SAME set the delete does (collectMemoryRel), so every tombstone and
      // pre-overwrite snapshot has a verified vault copy by the time we get here — and step 4
      // rehydrates them back. Any future narrowing of that collector re-opens the silent loss.
      remove(join(userDataDir, MEMORY_USERDATA_SUBDIR), { recursive: true, force: true })
    } catch (e) { cleanupErrors.push(`${MEMORY_USERDATA_SUBDIR}: ${messageOf(e)}`) }
    try {
      remove(join(userDataDir, ORIGIN_MARKER), { force: true })
    } catch (e) { cleanupErrors.push(`${ORIGIN_MARKER}: ${messageOf(e)}`) }
    if (cleanupErrors.length) {
      throw new Error(`vault switch cleanup failed: ${cleanupErrors.join('; ')}`)
    }
    // 4. Reload the NEW vault into the now-empty userData + stamp origin.
    rehydrateMoatFromVault(userDataDir, newVault)
    rehydrateMemoryFromVault(userDataDir, newVault)
    writeMoatOrigin(userDataDir, newVault)
    const noOldBytes = auditMoatProjection(userDataDir, newVault)
    const targetRestored = auditMoatRehydration(userDataDir, newVault)
    const origin = readMoatOrigin(userDataDir)
    if (!noOldBytes.complete || !targetRestored.complete || !sameVaultPath(origin, newVault)) {
      throw new Error(
        'vault switch postcondition failed: ' +
          `old moat=${noOldBytes.moatPending.join(',') || 'none'}, ` +
          `old memory=${noOldBytes.memoryPending.join(',') || 'none'}, ` +
          `missing moat=${targetRestored.moatPending.join(',') || 'none'}, ` +
          `missing memory=${targetRestored.memoryPending.join(',') || 'none'}, ` +
          `origin=${origin ?? 'missing'}`
      )
    }
    recordSwitchOutcome(userDataDir, {
      outcome: 'cleared',
      from,
      to: newVault,
      flushTarget,
      reason: 'flush verified byte-for-byte in the vault before clearing userData',
      moatVerified: audit.moatVerified,
      memoryVerified: audit.memoryVerified,
      // Recorded explicitly because this is the number that used to be structurally zero: the
      // `.trash` recovery layer was invisible to the audit, so 'cleared' claimed a byte-for-byte
      // flush while rmSync took every tombstone and pre-overwrite snapshot with it.
      trashVerified: audit.trashVerified
    })
    console.log(
      `[moat-durability] moat vault switched ${oldVault ?? '(none)'} -> ${newVault}; restart recommended to reload in-memory stores`
    )
    return {
      ok: true,
      outcome: 'switched',
      from,
      to: newVault,
      flushTarget,
      moatVerified: audit.moatVerified,
      memoryVerified: audit.memoryVerified,
      trashVerified: audit.trashVerified
    }
  } catch (e) {
    let restored = false
    let error = messageOf(e)
    if (destructiveStarted && oldVault) {
      // The pre-switch audit proved flushTarget is a complete durable snapshot.
      // Reconstruct userData from it before reporting failure. If cleanup itself
      // remains unavailable, `restored` stays false and the coordinator records
      // a pending recovery instead of publishing the target vault.
      try {
        for (const name of MOAT_FILES) remove(join(userDataDir, name), { force: true })
        remove(join(userDataDir, MEMORY_USERDATA_SUBDIR), { recursive: true, force: true })
        remove(join(userDataDir, ORIGIN_MARKER), { force: true })
        rehydrateMoatFromVault(userDataDir, oldVault)
        rehydrateMemoryFromVault(userDataDir, oldVault)
        writeMoatOrigin(userDataDir, oldVault)
        const noForeignBytes = auditMoatProjection(userDataDir, oldVault)
        const priorRestored = auditMoatRehydration(userDataDir, oldVault)
        restored =
          noForeignBytes.complete &&
          priorRestored.complete &&
          sameVaultPath(readMoatOrigin(userDataDir), oldVault)
      } catch (rollbackError) {
        error += `; prior-vault restore failed: ${messageOf(rollbackError)}`
      }
    }
    console.warn('[moat-durability] vault switch failed:', error)
    return { ok: false, outcome: 'failed', from, to: newVault, flushTarget, error, restored }
  }
}
