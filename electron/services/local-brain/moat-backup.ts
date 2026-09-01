// Moat backup — a data-safety net for the brain's derived-but-precious state.
//
// The 2026-07-13 incident wiped the claim ledger 309→28 when a boot reindex's
// clear→re-embed window overlapped a build. The construct/metabolize guards now
// block the KNOWN clobber paths, but a backup makes ANY future clobber (known or
// not) recoverable by a non-operator user who has no way to reconstruct it by hand.
//
// What we snapshot: the claim ledger (the moat — human pins/verdicts live only
// here) and the construction cache (regenerable but expensive: ~24 LLM calls).
// NOT the vector index (userData/local-brain.db) — that rebuilds losslessly from
// the notes, which are the source of truth and are never touched here.
//
// Hooked at the TOP of reindexImpl (before the destructive prune opens the
// clobber window). Best-effort BY DESIGN: a backup failure must NEVER break a
// reindex. Pure fs/crypto so it's unit-testable without the Electron runtime.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

/** How many backups to retain PER source (ledger / construction). Env-tunable; read
 *  at call-time so a test / runtime override takes effect without a reload. */
function maxBackups(): number {
  const n = Number(process.env.DUIN_MOAT_BACKUPS)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10
}

/**
 * A source file to protect, addressed relative to a base dir. `base` picks WHICH
 * base the `rel` is joined onto:
 *   - 'vault'    → `<vault>/…`   (ledgers + construction cache live in the vault)
 *   - 'userData' → `<userData>/…` (the moat JSON stores live in Electron userData)
 * All snapshots land in ONE place (`<vault>/.duin/_backups/`) regardless of base, so
 * the whole recoverable set travels with the vault.
 */
interface MoatSource {
  label: string
  base: 'vault' | 'userData'
  rel: string
  ext: string
}

const D = (...p: string[]): string => join('.duin', '_state', ...p)

const SOURCES: MoatSource[] = [
  // ── vault `.duin/_state` ledgers (the 2026-07-13 wipe motivated this net) ──
  { label: 'ledger', base: 'vault', rel: D('claim-ledger.jsonl'), ext: 'jsonl' },
  { label: 'risk-predictions', base: 'vault', rel: D('risk-predictions.jsonl'), ext: 'jsonl' },
  { label: 'forecast-track-record', base: 'vault', rel: D('forecast-track-record.json'), ext: 'json' },
  { label: 'corrections', base: 'vault', rel: D('corrections.jsonl'), ext: 'jsonl' },
  { label: 'taste-engine', base: 'vault', rel: D('taste-engine.json'), ext: 'json' },
  // ── HUMAN-CONFIRMED IDENTITY DECISIONS — the least reproducible artifacts here ──
  // Everything else in this manifest is either derivable from the notes or regenerable by an LLM
  // pass. These two are not: each alias group is a judgement a person made about who/what is the
  // same entity, and nothing can recompute them. They were unprotected until 2026-07-28 — and
  // `runEntityAutoMergeTick` APPENDS to entity-aliases.json unattended, so the file changes without
  // anyone watching. Losing it silently un-merges the identity spine.
  { label: 'entity-aliases', base: 'vault', rel: D('entity-aliases.json'), ext: 'json' },
  { label: 'operator-aliases', base: 'vault', rel: D('operator-aliases.jsonl'), ext: 'jsonl' },
  // ── construction cache (regenerable but ~24 LLM calls) ──
  { label: 'construction', base: 'vault', rel: join('.brain', 'state', 'brain-construction.json'), ext: 'json' },
  // ── the MOAT: per-operator calibration JSON in userData (product moat). Its only prior
  //    "backup" was a vault mirror that goes stale — snapshot the AUTHORITATIVE userData copy. ──
  { label: 'operator-model', base: 'userData', rel: 'operator-model.json', ext: 'json' },
  { label: 'success-traces', base: 'userData', rel: 'success-traces.json', ext: 'json' },
  { label: 'ans-capabilities', base: 'userData', rel: 'ans-capabilities.json', ext: 'json' }
]

function backupDir(vaultDir: string): string {
  return join(vaultDir, '.duin', '_backups')
}

/** Resolve a source's live path against its base. Returns null when the base dir for
 *  this source wasn't supplied (e.g. a userData source when no userDataDir was passed) —
 *  the caller then skips it rather than joining onto an empty string. */
function sourcePath(src: MoatSource, vaultDir: string, userDataDir: string | null): string | null {
  const baseDir = src.base === 'userData' ? userDataDir : vaultDir
  if (!baseDir || typeof baseDir !== 'string' || baseDir.trim() === '') return null
  return join(baseDir, src.rel)
}

interface BackupEntry {
  name: string
  path: string
  hash: string
  size: number
  mtimeMs: number
}

/** Newest-first list of existing backups for one label, parsed from the filename
 *  `<label>.<iso>.<reason>.<hash8>.bak.<ext>` (hash carried in the name for O(1)
 *  dedup without re-reading every backup). Falsy dir → []. */
function listForLabel(dir: string, label: string): BackupEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: BackupEntry[] = []
  for (const name of names) {
    // <label>.<iso>.<reason>.<hash8>.bak.<ext>
    if (!name.startsWith(label + '.') || !name.includes('.bak.')) continue
    const parts = name.split('.')
    // hash is the token immediately before "bak"
    const bakIdx = parts.lastIndexOf('bak')
    const hash = bakIdx > 0 ? parts[bakIdx - 1] : ''
    const path = join(dir, name)
    let size: number
    let mtimeMs: number
    try {
      const st = statSync(path)
      size = st.size
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }
    out.push({ name, path, hash, size, mtimeMs })
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Snapshot the moat state (ledger + construction) into `<vault>/.duin/_backups/`.
 * Best-effort and silent. Guards:
 *  - skips a source that is missing or empty (never lets a 0-byte state become a "backup"),
 *  - dedups by content hash against the newest backup of that label (file-watch reindexes
 *    that didn't change the ledger create nothing),
 *  - shrink-guard: refuses to snapshot a source that is <50% the size of its newest existing
 *    backup — a clobbered/shrunken state must not rotate the good backups out,
 *  - rotates to the newest MAX_BACKUPS per label.
 *
 * `userDataDir` (optional) enables the userData-based moat sources (operator-model.json etc.).
 * When omitted (e.g. the pre-reindex hook, which only has the vault dir), those sources are
 * silently skipped and only the vault sources are snapshotted. The daily scheduled run passes
 * both dirs so the full set is covered. `vaultDir` is always required — it is where snapshots land.
 */
export function backupMoatState(
  vaultDir: string | null | undefined,
  reason: string,
  userDataDir?: string | null
): void {
  try {
    if (!vaultDir || typeof vaultDir !== 'string' || vaultDir.trim() === '') return
    const safeReason = (reason || 'auto').replace(/[^a-z0-9-]/gi, '-')
    const dir = backupDir(vaultDir)
    const udd = typeof userDataDir === 'string' && userDataDir.trim() !== '' ? userDataDir : null
    for (const src of SOURCES) {
      const full = sourcePath(src, vaultDir, udd)
      if (!full || !existsSync(full)) continue
      let content: Buffer
      try {
        content = readFileSync(full)
      } catch {
        continue
      }
      if (content.length === 0) continue // never snapshot an already-empty state

      const existing = listForLabel(dir, src.label)
      const newest = existing[0]
      const fullHash = createHash('sha256').update(content).digest('hex')
      const hash8 = fullHash.slice(0, 12)
      if (existing.some((e) => e.hash === hash8)) continue // this exact state already backed up
      // Shrink-guard: a clobbered ledger (e.g. 309→28) must not overwrite/rotate out
      // the healthy backups. If the current state is <50% the newest good backup, skip.
      if (newest && newest.size > 0 && content.length < newest.size * 0.5) continue

      mkdirSync(dir, { recursive: true })
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const name = `${src.label}.${ts}.${safeReason}.${hash8}.bak.${src.ext}`
      // atomic: temp write + rename so a crash mid-write can't leave a truncated backup
      const target = join(dir, name)
      const tmp = target + '.tmp'
      writeFileSync(tmp, content)
      renameSync(tmp, target)

      // rotate: keep the newest maxBackups() (the just-written one is newest)
      const after = listForLabel(dir, src.label)
      for (const old of after.slice(maxBackups())) {
        try {
          unlinkSync(old.path)
        } catch {
          /* rotation is best-effort */
        }
      }
    }
  } catch {
    /* best-effort: a backup failure must NEVER break the reindex it guards */
  }
}

/** Metadata for a stored backup (for a restore UI / support). Newest-first per label. */
export interface MoatBackupInfo {
  label: string
  name: string
  path: string
  size: number
  mtimeMs: number
}

export function listMoatBackups(vaultDir: string | null | undefined): MoatBackupInfo[] {
  if (!vaultDir || typeof vaultDir !== 'string') return []
  const dir = backupDir(vaultDir)
  const out: MoatBackupInfo[] = []
  for (const src of SOURCES) {
    for (const e of listForLabel(dir, src.label)) {
      out.push({ label: src.label, name: e.name, path: e.path, size: e.size, mtimeMs: e.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Outcome of a restore. `skipped` names every label that HAS a backup on disk but
 * whose live state was NOT written back — the case that used to be invisible: the
 * caller saw a non-empty `restored` and reported an unqualified success while the
 * userData moat stores (operator-model / success-traces / ans-capabilities) were
 * silently dropped because no userDataDir was threaded through. A partial restore
 * must never render as a full one, so the skipped labels are returned, named and
 * reasoned rather than swallowed.
 */
export interface MoatRestoreReport {
  restored: string[]
  skipped: Array<{ label: string; reason: string }>
  /** Where the pre-restore copies of the overwritten live state were preserved. */
  preservedDir: string | null
}

/** Backups live in `<vault>/.duin/_backups/`; the copies of the live state we take
 *  immediately BEFORE overwriting it go one level down, in `_pre-restore/`. They are
 *  deliberately kept out of the backup dir proper (and never named `*.bak.*`) so a
 *  restored-over clobbered state can NEVER be picked up by listForLabel as a
 *  restore candidate or rotate a healthy backup out. */
function preRestoreDir(vaultDir: string): string {
  return join(backupDir(vaultDir), '_pre-restore')
}

/** Preserve+record: copy the live file we are about to overwrite into `_pre-restore/`
 *  and append one line to `_pre-restore/restore-log.jsonl` saying what changed, when,
 *  which backup replaced it, and where the prior content went. Best-effort — a
 *  deliberate recovery action must not be blocked by a failure to archive, but the
 *  archive is attempted BEFORE the overwrite so an ill-judged restore is undoable. */
function preserveBeforeOverwrite(
  vaultDir: string,
  src: MoatSource,
  dest: string,
  fromBackup: string,
  newSize: number
): void {
  try {
    if (!existsSync(dest)) return // nothing to preserve — the live file is absent
    const prior = readFileSync(dest)
    const dir = preRestoreDir(vaultDir)
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const hash8 = createHash('sha256').update(prior).digest('hex').slice(0, 12)
    // NOTE the `.pre.` infix (never `.bak.`) — see preRestoreDir.
    const name = `${src.label}.${ts}.pre-restore.${hash8}.pre.${src.ext}`
    writeFileSync(join(dir, name), prior)
    const entry = {
      at: new Date().toISOString(),
      label: src.label,
      action: 'restore',
      dest,
      fromBackup,
      priorBytes: prior.length,
      priorHash: hash8,
      restoredBytes: newSize,
      priorSavedAs: name
    }
    writeFileSync(join(dir, 'restore-log.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' })
  } catch {
    /* archiving is best-effort; never block the recovery it protects */
  }
}

/**
 * Restore the newest backup of each source (or one label) over the live state.
 * Deliberate recovery action — copies the chosen backup back atomically, after
 * preserving the content it replaces under `_pre-restore/` with a log line.
 *
 * `userDataDir` MUST be supplied for the userData-based moat sources to be
 * restorable at all — without it `sourcePath` returns null and those labels are
 * reported in `skipped`, never in `restored`.
 */
export function restoreLatestMoatDetailed(
  vaultDir: string | null | undefined,
  onlyLabel?: string,
  userDataDir?: string | null
): MoatRestoreReport {
  const restored: string[] = []
  const skipped: MoatRestoreReport['skipped'] = []
  if (!vaultDir || typeof vaultDir !== 'string' || vaultDir.trim() === '') {
    return { restored, skipped, preservedDir: null }
  }
  const dir = backupDir(vaultDir)
  const udd = typeof userDataDir === 'string' && userDataDir.trim() !== '' ? userDataDir : null
  for (const src of SOURCES) {
    if (onlyLabel && src.label !== onlyLabel) continue
    const newest = listForLabel(dir, src.label)[0]
    if (!newest) continue // no backup at all for this label — nothing was lost by not restoring it
    const dest = sourcePath(src, vaultDir, udd)
    if (!dest) {
      // A backup EXISTS but its base dir wasn't supplied. Previously a bare `continue`,
      // which made the caller report success for a restore that never touched these files.
      skipped.push({
        label: src.label,
        reason: `no ${src.base} directory supplied — cannot write ${src.rel} back`
      })
      continue
    }
    try {
      const content = readFileSync(newest.path)
      preserveBeforeOverwrite(vaultDir, src, dest, newest.name, content.length)
      mkdirSync(join(dest, '..'), { recursive: true })
      const tmp = dest + '.restore.tmp'
      writeFileSync(tmp, content)
      renameSync(tmp, dest)
      restored.push(src.label)
    } catch (err) {
      skipped.push({ label: src.label, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { restored, skipped, preservedDir: preRestoreDir(vaultDir) }
}

/** Back-compat thin wrapper: the labels actually restored. Prefer
 *  `restoreLatestMoatDetailed` at any call site that reports the outcome to a user —
 *  this shape cannot distinguish a full restore from a partial one. */
export function restoreLatestMoat(
  vaultDir: string | null | undefined,
  onlyLabel?: string,
  userDataDir?: string | null
): string[] {
  return restoreLatestMoatDetailed(vaultDir, onlyLabel, userDataDir).restored
}
