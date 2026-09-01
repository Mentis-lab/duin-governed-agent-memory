// Import an EXISTING agent system into the `.brain/` harness root.
//
// DUIN's `.brain/` is a persistent identity + memory + behavior dir. A user who
// already runs another agent system (Codex, Cursor, …) has curated identity and
// memory sitting on disk. This importer ABSORBS that setup so DUIN is instantly
// grounded in who they are — no re-typing.
//
// EXTENSIBILITY — the adapter pattern. Every agent system plugs in as an
// `AgentSystemAdapter`:
//   - detect()  enumerates where the system lives on this machine + what each
//               install contains, so the UI can offer it.
//   - mapInto() maps that system's files into the `.brain/` contract, in one of
//               two modes:
//       'link' — write a config.json pointer; loadBrain reads identity/memory
//                from the original dir LIVE (edits there flow through, no
//                re-import). Nothing is copied.
//       'copy' — snapshot the files INTO `.brain/` (a frozen, portable brain).
//
// To add a new system (cursor, windsurf, …): implement an AgentSystemAdapter
// and push it into ADAPTERS below. detectAgentSystems() / importAgentSystem()
// fan out over the registry — no other call site changes. The codex adapter
// below is a deliberately-minimal STUB proving the seam works.

import { readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { atomicWriteFileSync } from '../atomic-write'
import { isDirSafe, isFileSafe, readSafe } from '../fs-tree'
import { snapshotToTrash } from '../local-brain/vault-trash'
import {
  ensureBrainRoot,
  brainRootPath,
  BRAIN_IDENTITY_FILE,
  BRAIN_CONFIG_FILE,
  type BrainConfig,
  type LinkedSource
} from './brain-root'
import { messageOf } from '../guarded'

export type ImportMode = 'link' | 'copy'

/** One on-disk install of an agent system, with a human label + a summary of
 *  what it contains, so the UI can present it before the user picks a mode. */
export interface DetectedSystem {
  /** Adapter id that found it (e.g. 'codex'). */
  adapter: string
  /** Human label for the picker (e.g. "Claude Code (global) at ~/.claude"). */
  label: string
  /** Absolute path to the source dir. Passed back to importAgentSystem. */
  dir: string
  /** What was found inside — drives the "contains: identity, 4 skills" hint. */
  contains: {
    identity: boolean
    memory: number
    skills: number
    agents: number
    hooks: number
  }
}

/** Outcome of a mapInto run. */
export interface ImportResult {
  ok: boolean
  adapter: string
  mode: ImportMode
  /** Absolute `.brain/` root the import targeted. */
  brainRoot: string
  /** Human-readable summary of what was mapped. */
  summary: {
    identity: boolean
    memory: number
    skills: number
    agents: number
    hooks: number
    linked: boolean
  }
  /** Trash-relative path (`.trash/identity.md`) where a PRE-EXISTING `.brain/identity.md`
   *  was preserved before a copy-mode import overwrote it. Absent when nothing was
   *  replaced. Surfaced in the import toast so the operator is told where their prior
   *  identity went — an alteration the user cannot see is not traceable. */
  replaced?: string
  /** Non-fatal alteration the operator must be told about even though the import SUCCEEDED —
   *  currently: an unparseable `.brain/config.json` was quarantined to a `.corrupt` sidecar and
   *  rebuilt from just this link, so previously-linked sources are no longer active. `ok` stays
   *  true (the import landed); a silent success would make that loss invisible. */
  warning?: string
  error?: string
}

/** The adapter contract. Implement + register to support a new agent system. */
export interface AgentSystemAdapter {
  id: string
  label: string
  /** Enumerate installs of this system on the current machine. `vaultRoot` is
   *  the notes-vault root (the `.brain/` parent) so adapters can also look for
   *  a project-local config (e.g. `<vault>/.claude/`). */
  detect(vaultRoot: string | null): DetectedSystem[]
  /** Map a detected source dir into the `.brain/` root, in link or copy mode. */
  mapInto(sourceDir: string, brainRoot: string, mode: ImportMode): ImportResult
}

// ──────────────────── shared helpers ────────────────────
// isDirSafe / isFileSafe / readSafe live in ../fs-tree (electron-free) so this
// importer and brain-root share ONE copy of the try-catch fs guards.

/** Outcome of a writeLinkPointer run. `quarantined` is the sidecar path the prior (unparseable)
 *  config bytes were moved to, so the caller can tell the operator where they went. */
type LinkPointerResult = { ok: true; quarantined?: string } | { ok: false; error: string }

/**
 * Move an unparseable `.brain/config.json` aside to `<name>.<ISO-stamp>.corrupt` so the
 * link-pointer write that follows cannot overwrite it. Never deletes; never overwrites in place.
 * Returns the sidecar path, or null when the rename itself failed.
 */
function quarantineCorruptConfig(cfgPath: string, cause: unknown): string | null {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sidecar = `${cfgPath}.${stamp}.corrupt`
  try {
    renameSync(cfgPath, sidecar)
    console.error(
      `[import-agent-system] UNPARSEABLE ${BRAIN_CONFIG_FILE} at ${cfgPath} (${messageOf(cause)}) — ` +
        `quarantined to ${sidecar}; a fresh config carrying ONLY the new link was written. Any ` +
        'previously linked sources (and any other persisted keys) are NOT restored automatically — ' +
        're-run the import wizard for them, or recover the sidecar by hand.'
    )
    return sidecar
  } catch (e) {
    console.error(
      `[import-agent-system] UNPARSEABLE ${BRAIN_CONFIG_FILE} at ${cfgPath} (${messageOf(cause)}) ` +
        `and quarantine FAILED (${messageOf(e)}) — refusing to write the link pointer rather than ` +
        'overwrite bytes we could not preserve.'
    )
    return null
  }
}

/**
 * Merge a linked-source pointer into `.brain/config.json` (dedup by adapter+dir).
 *
 * Why the corrupt branch is not a `cfg = {}` fallback: `linkedSources` is user-selected
 * configuration that NOTHING regenerates — it is not derived from anything, and config.json is
 * explicitly excluded from indexing (index-store.ts), so there is no second copy. Falling back to
 * `{}` and then writing that object back turned a *partial* read failure into a total, permanent
 * one: a user with two link-imported systems whose config.json had been truncated (by a crash, or
 * by this function's own pre-atomic `writeFileSync`) lost BOTH earlier grounding links plus every
 * other persisted key, silently, on the next import — while `ok: true` came back to the UI.
 *
 * Pattern B: the ABSENT-file case was already safe (fresh config, nothing to lose) and the HEALTHY
 * case merges correctly; only the PARTIAL/corrupt case destroyed. Pattern A: the exact guard
 * already existed in a sibling — capability-ledger's `quarantineCorruptStore`, at the identical
 * catch-an-unparseable-JSON-store site — and this call site was the one skipping it. So: preserve
 * (rename the bytes aside) + record (log at error, not `console.debug`) + stamp (ISO-stamped
 * sidecar), and surface a non-fatal `warning` on the ImportResult so the loss is visible instead of
 * announced only to a debug log the operator never reads.
 *
 * If the bytes CANNOT be preserved (read error, or the quarantine rename fails) we abstain
 * entirely — same rule as preservePriorIdentity below: proceeding blind over content we failed to
 * save is the one outcome that cannot be undone, and the import is retryable.
 *
 * The write itself is atomic (tmp → fsync → rename) like every other JSON store in this tree. The
 * old bare `writeFileSync` truncates in place, which made this function the most likely PRODUCER
 * of the very torn config.json it then mishandled.
 */
function writeLinkPointer(brainRoot: string, link: LinkedSource): LinkPointerResult {
  const cfgPath = join(brainRoot, BRAIN_CONFIG_FILE)
  let cfg: BrainConfig = {}
  let quarantined: string | undefined

  if (isFileSafe(cfgPath)) {
    let raw: string
    try {
      // readFileSync, not readSafe: readSafe collapses "unreadable" into '' , which is
      // indistinguishable from "empty" and would send us down the safe-to-clobber path over a
      // file whose contents we never actually saw.
      raw = readFileSync(cfgPath, 'utf-8')
    } catch (e) {
      return {
        ok: false,
        error: `the existing ${BRAIN_CONFIG_FILE} could not be read, so linking would overwrite it blind: ${messageOf(e)}`
      }
    }
    if (raw.trim()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (e) {
        parsed = undefined
        const sidecar = quarantineCorruptConfig(cfgPath, e)
        if (!sidecar) {
          return {
            ok: false,
            error: `the existing ${BRAIN_CONFIG_FILE} is unparseable and could not be quarantined, so linking would destroy it`
          }
        }
        quarantined = sidecar
      }
      if (parsed !== undefined) {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          cfg = parsed as BrainConfig
        } else {
          // Parsed, but not a config object (an array / scalar / null). Same reasoning as an
          // unparseable file: we cannot merge into it, so preserve it rather than clobber it.
          const sidecar = quarantineCorruptConfig(cfgPath, new Error(`not a JSON object: ${typeof parsed}`))
          if (!sidecar) {
            return {
              ok: false,
              error: `the existing ${BRAIN_CONFIG_FILE} is not a config object and could not be quarantined, so linking would destroy it`
            }
          }
          quarantined = sidecar
        }
      }
    }
    // An empty/whitespace-only config.json holds nothing to preserve, so it needs no sidecar —
    // same tolerance as brain-root's readConfig.
  }

  const existing = Array.isArray(cfg.linkedSources) ? cfg.linkedSources : []
  const deduped = existing.filter((l) => !(l.adapter === link.adapter && l.dir === link.dir))
  cfg.linkedSources = [...deduped, link]
  // 0o644, not atomic-write's 0o600 default: this lives in the user's synced notes vault next to
  // hand-editable files, not in the app's private dir.
  atomicWriteFileSync(cfgPath, JSON.stringify(cfg, null, 2), 0o644)
  return quarantined ? { ok: true, quarantined } : { ok: true }
}

/**
 * Preserve a PRE-EXISTING `.brain/identity.md` in `<vault>/.trash` before a copy-mode
 * import overwrites it.
 *
 * Why this exists: `.brain/identity.md` is hand-authored BY CONSTRUCTION — nothing in DUIN
 * generates it (this module's writeFileSync is its only writer; ensureBrainRoot creates
 * directories only), and brain-root documents `.brain/` as "durable, hand-editable identity
 * … the user owns". Copy mode used to writeFileSync AGENTS.md straight over it from an
 * unconfirmed "Copy" button, so a user who wrote who they are and then absorbed their Codex
 * config lost that text with no snapshot, no diff and no tombstone. The `body.trim()` check
 * above only guards TOTAL failure (an empty AGENTS.md abstains); the destructive path fires
 * on the NORMAL case of a perfectly valid non-empty AGENTS.md.
 *
 * The guard already existed twice over and this call site skipped both: `write-identity.ts`
 * in this very directory refuses to clobber a hand-written identity, and vault-trash's
 * `snapshotToTrash` (used by memory-store's snapshotPriorVersion, agui-executors'
 * executeWriteNote and library-brain-bridge before their own overwrites) exists for exactly
 * "a rewrite that replaces a hand-authored body … leaves no tombstone to recover from".
 *
 * Preserve+record rather than refuse-to-write: absorbing an existing agent system into the
 * brain is a legitimate replacement — it just has to be recoverable and reported. Content-
 * addressed, so re-importing an unchanged AGENTS.md snapshots nothing and .trash gets one
 * entry per ACTUAL alteration. A first-time import (no identity.md yet) is untouched.
 *
 * If the snapshot FAILS the caller must NOT write: the live bytes are the thing at risk and
 * proceeding blind is the one outcome that cannot be undone.
 */
function preservePriorIdentity(
  brainRoot: string,
  identityPath: string,
  nextBody: string
): { ok: true; replaced?: string } | { ok: false; error: string } {
  if (!isFileSafe(identityPath)) return { ok: true }
  // readSafe returns '' for an unreadable file, which then differs from a non-empty body —
  // unreadable prior content is exactly the case worth preserving, so that errs safe.
  if (readSafe(identityPath) === nextBody) return { ok: true }
  const result = snapshotToTrash(
    dirname(brainRoot), // `.brain/` lives at <vault>/.brain, so its parent is the vault root
    identityPath,
    'import-agent-system',
    'codex copy-mode import replaced .brain/identity.md with AGENTS.md'
  )
  if (!result.ok) {
    return { ok: false, error: `the existing identity could not be preserved: ${result.error}` }
  }
  return { ok: true, replaced: result.trashRel }
}

// ──────────────────── codex adapter (STUB) ────────────────────
//
// Deliberately minimal — proves the seam is extensible. Codex stores its
// project memory in `AGENTS.md` (project-local) + a `~/.codex/` config. We map
// only the identity (AGENTS.md → identity.md). A fuller adapter would also lift
// `~/.codex/` config + history; left as the obvious next increment.

export const codexAdapter: AgentSystemAdapter = {
  id: 'codex',
  label: 'Codex',
  detect(vaultRoot) {
    const found: DetectedSystem[] = []
    const codexHome = join(homedir(), '.codex')
    // Project AGENTS.md is the primary identity carrier; detect it under vault.
    const agentsMd = vaultRoot && vaultRoot.trim() ? join(vaultRoot, 'AGENTS.md') : null
    if (codexHome && isDirSafe(codexHome)) {
      found.push({
        adapter: 'codex',
        label: `Codex (config) at ${codexHome}`,
        dir: codexHome,
        contains: {
          // The config entry's dir is ~/.codex, which has no AGENTS.md — the vault's
          // identity is delivered by the separate AGENTS.md entry below, not this one.
          identity: false,
          memory: 0,
          skills: 0,
          agents: 0,
          hooks: 0
        }
      })
    }
    if (agentsMd && isFileSafe(agentsMd)) {
      // The AGENTS.md sits in the vault root; map by pointing the source at it.
      found.push({
        adapter: 'codex',
        label: `Codex AGENTS.md at ${agentsMd}`,
        dir: vaultRoot as string,
        contains: { identity: true, memory: 0, skills: 0, agents: 0, hooks: 0 }
      })
    }
    return found
  },
  mapInto(sourceDir, brainRoot, mode) {
    const base: ImportResult = {
      ok: true,
      adapter: 'codex',
      mode,
      brainRoot,
      summary: { identity: false, memory: 0, skills: 0, agents: 0, hooks: 0, linked: false }
    }
    try {
      const agentsMd = join(sourceDir, 'AGENTS.md')
      if (mode === 'link') {
        const linked = writeLinkPointer(brainRoot, { adapter: 'codex', dir: sourceDir })
        if (!linked.ok) return { ...base, ok: false, error: linked.error }
        return {
          ...base,
          summary: { ...base.summary, identity: isFileSafe(agentsMd), linked: true },
          // The import succeeded, but a corrupt config was rebuilt from just this link — say so,
          // and say where the prior bytes went. An alteration the user cannot see is not traceable.
          ...(linked.quarantined
            ? {
                warning:
                  `The existing ${BRAIN_CONFIG_FILE} was unreadable and was preserved at ` +
                  `${linked.quarantined}. Any previously linked sources are no longer active — ` +
                  're-import them, or recover that file by hand.'
              }
            : {})
        }
      }
      if (isFileSafe(agentsMd)) {
        const body = readSafe(agentsMd)
        if (body.trim()) {
          const identityPath = join(brainRoot, BRAIN_IDENTITY_FILE)
          const preserved = preservePriorIdentity(brainRoot, identityPath, body)
          if (!preserved.ok) return { ...base, ok: false, error: preserved.error }
          writeFileSync(identityPath, body, 'utf-8')
          return {
            ...base,
            summary: { ...base.summary, identity: true },
            ...(preserved.replaced ? { replaced: preserved.replaced } : {})
          }
        }
      }
      return base
    } catch (err) {
      return { ...base, ok: false, error: (err as Error)?.message ?? 'import failed' }
    }
  }
}

// ──────────────────── registry + public API ────────────────────
//
// Register a new adapter here (and ONLY here) to support a new system. Future
// adapters — cursor (`~/.cursor/`), windsurf, etc. — slot in alongside these.

export const ADAPTERS: AgentSystemAdapter[] = [codexAdapter]

function adapterById(id: string): AgentSystemAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id)
}

/** Run every adapter's detect() and flatten the results. `vaultRoot` is the
 *  notes-vault root so adapters can find project-local configs. */
export function detectAgentSystems(vaultRoot: string | null): DetectedSystem[] {
  const out: DetectedSystem[] = []
  for (const adapter of ADAPTERS) {
    try {
      out.push(...adapter.detect(vaultRoot))
    } catch (err) {
      console.warn(`[import-agent-system] ${adapter.id} detect failed:`, (err as Error)?.message)
    }
  }
  return out
}

/**
 * Import an agent system into the `.brain/` root for `vaultRoot`. Ensures the
 * `.brain/` scaffolding exists, then runs the adapter's mapInto. Returns an
 * error result (not a throw) when the vault/adapter is missing.
 */
export function importAgentSystem(
  adapterId: string,
  sourceDir: string,
  mode: ImportMode,
  vaultRoot: string | null
): ImportResult {
  const adapter = adapterById(adapterId)
  const failBase = {
    ok: false as const,
    adapter: adapterId,
    mode,
    brainRoot: '',
    summary: { identity: false, memory: 0, skills: 0, agents: 0, hooks: 0, linked: false }
  }
  if (!adapter) return { ...failBase, error: `Unknown agent system: ${adapterId}` }
  const brainRoot = ensureBrainRoot(vaultRoot)
  if (!brainRoot) {
    return { ...failBase, error: 'No notes vault configured — set a notes folder first.' }
  }
  return adapter.mapInto(sourceDir, brainRoot, mode)
}

// Test-only seam for the pure helpers that don't have a public export.
export const __importAgentSystemTest = {
  writeLinkPointer,
  brainRootPath
}
