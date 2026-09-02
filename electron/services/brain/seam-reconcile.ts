// seam-reconcile — the AUTO-FIRE hardening for the seam projection.
//
// Before this module, the FULL projection (T1 relations + T2 entity edges + concept-index
// regen) ran only when a human POSTed /debug/materialize-backfill; the per-promote hook wrote
// a bare concept and the lane drifted until someone remembered. This module makes the
// projection self-maintaining:
//
//   1. EVENT-DRIVEN: every governed transition (promote / supersede / veto / revert) schedules
//      a DEBOUNCED full reconcile — a govern pass that flips five facts causes ONE reconcile,
//      shortly after the burst goes quiet. Since W4 (2026-09-02) the vault watcher's events for
//      `.brain/memory/concept-*.md` — a human edit or deletion — schedule the same reconcile. Our
//      own writes update the seam ledger first, so the pass they trigger finds nothing to do and
//      the loop closes after one no-op. (notes-watcher does watch `.brain`; see isMachineStatePath.)
//   2. BOOT SELF-HEAL: one pass after boot settles, which also repairs the transitions that
//      never fire the hook (evictToCap, flag-off periods, crashes mid-write).
//
// "Does not break" invariants:
//   - NEVER throws into a caller: every path is caught and recorded into an inspectable
//     status (surfaced at /debug/seam-status) instead of propagating.
//   - A failing entity catalog DEGRADES to a T1 reconcile (concepts still project).
//   - Reentrancy is structural: reconcileConcepts is fully synchronous, and fires run inside
//     single-threaded timer callbacks — two reconciles can never interleave.
//   - Flag discipline: auto-fire gates on DUIN_SEAM_MATERIALIZE (no seam → no writes) with a
//     kill-switch DUIN_SEAM_AUTO_RECONCILE=0; the manual backfill route keeps its deliberate
//     flag-override via { ignoreFlag: true }.
//   - The whitelist is NOT loaded at boot anywhere else (activeAliasGroups() starts empty and
//     only fills as a side effect of the first construction resolve), so the production
//     catalog builder loads it explicitly on every build — cheap, idempotent, and it also
//     picks up hand edits to entity-aliases.json.

import { resolve, sep, basename } from 'path'
import { onVaultFileEvent } from '../local-brain/notes-watcher'
import {
  reconcileConcepts,
  conceptMemoryDir,
  seamEnabled,
  seamEntityEdgesEnabled,
  assembleEntityCatalog,
  type EntityCatalogEntry,
  type HumanEditHooks
} from './concept-materialize'
import { loadAliasGroups, activeAliasGroups } from './entity-resolver'
import { liveNodes } from './entity-graph-store'
import {
  getOperatorFacts,
  getAllOperatorFacts,
  type OperatorFact,
  isFactLive,
  vetoFact,
  supersedeFact,
  promoteFact,
  confirmFact
} from './operator-model'

export interface SeamReconcileDeps {
  getNotesDir: () => string | null
  getPromoted: () => OperatorFact[]
  getAllFacts: () => OperatorFact[]
  /** Returns the entity catalog, or undefined to skip the entity phase (flag off / plane down). */
  buildCatalog: (notesDir: string) => EntityCatalogEntry[] | undefined
  /** Semantic-index refresh (scheduleReindex) — injected to keep this module out of the
   *  local-brain layer; already debounced internally by its owner. */
  reindex?: (notesDir: string) => void
  /** W4: what a human's edit or deletion of a concept file does to the store (see productionHumanEditHooks). */
  humanEdits?: HumanEditHooks
}

export interface SeamReconcileResult {
  ok: boolean
  skipped?: 'seam-disabled' | 'no-vault'
  result?: { written: number; skipped: number; retired: number; entitiesWritten: number; entitiesRetired: number }
  error?: string
}

/** Kill-switch — default ON (`!== '0'`), matching the entity-graph opt-out convention. */
export function seamAutoReconcileEnabled(): boolean {
  return process.env.DUIN_SEAM_AUTO_RECONCILE !== '0'
}

const DEBOUNCE_MS_DEFAULT = 10_000
const BOOT_DELAY_MS_DEFAULT = 90_000

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// ──────────────────────────── module state ────────────────────────────
let stashedDeps: SeamReconcileDeps | null = null
let unsubscribeFiles: (() => void) | null = null
let debounceMs = DEBOUNCE_MS_DEFAULT
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let bootTimer: ReturnType<typeof setTimeout> | null = null
let pendingTrigger: string | null = null

const status = {
  runs: 0,
  lastAt: null as string | null,
  lastTrigger: null as string | null,
  lastSkipped: null as string | null,
  lastResult: null as SeamReconcileResult['result'] | null,
  lastError: null as string | null,
  pending: false,
  started: false
}

/** Snapshot for /debug/seam-status — copy, never the live object. */
export function seamReconcileStatus(): typeof status & { autoEnabled: boolean; debounceMs: number } {
  return { ...status, pending: debounceTimer !== null, autoEnabled: seamAutoReconcileEnabled(), debounceMs }
}

/** PRODUCTION catalog builder — explicit whitelist load first (see module header), then the
 *  T2.5 assembly over the curated planes. Flag-off ⇒ undefined ⇒ pure T1 reconcile. */
export function buildLiveSeamCatalog(notesDir: string): EntityCatalogEntry[] | undefined {
  if (!seamEntityEdgesEnabled()) return undefined
  loadAliasGroups(notesDir)
  return assembleEntityCatalog(
    activeAliasGroups(),
    liveNodes().filter((n) => n.source === 'construction' || n.source === 'operator')
  )
}

/** W4 production hooks: what a human does to a concept file is what they would have done in the UI.
 *  A deleted file is a veto (soft, un-vetoable from the Learning panel). A rewritten claim line is the
 *  operator's statement: it supersedes the old fact, lands under human authority (promoteFact), and
 *  keeps a confirmed rule confirmed (confirmFact) so the new text does not have to re-earn its standing. */
export function productionHumanEditHooks(): HumanEditHooks {
  return {
    onDeleted: (f) => {
      vetoFact(f.id, 'concept file deleted by hand')
    },
    onEdited: (f, claim) => {
      const wasPromoted = f.status === 'promoted'
      const r = supersedeFact(f.id, claim, f.kind, 'operator')
      if (!r.newId) return
      promoteFact(r.newId, 'edited the concept file by hand')
      if (wasPromoted) confirmFact(r.newId)
    }
  }
}

/** Bundle the production deps once — main.ts wires this with its settings closure. */
export function makeProductionSeamDeps(
  getNotesDir: () => string | null,
  reindex?: (notesDir: string) => void
): SeamReconcileDeps {
  return {
    getNotesDir,
    // W3: provisional facts project too — a keyless install parks every learned fact at 'ratify' and
    // would otherwise never get a single file. Retired rows (superseded/cascade) never project.
    getPromoted: () => getOperatorFacts().filter((f) => (f.status === 'promoted' || f.status === 'provisional') && isFactLive(f)),
    getAllFacts: () => getAllOperatorFacts(),
    buildCatalog: buildLiveSeamCatalog,
    reindex,
    humanEdits: productionHumanEditHooks()
  }
}

/** Run the full projection NOW, synchronously. NEVER throws — every failure lands in the
 *  returned result and the status surface. `ignoreFlag` preserves the manual backfill
 *  route's deliberate ability to run with the seam flag unset. */
export function runSeamReconcileNow(
  trigger: string,
  deps: SeamReconcileDeps,
  opts?: { ignoreFlag?: boolean }
): SeamReconcileResult {
  status.lastAt = new Date().toISOString()
  status.lastTrigger = trigger
  try {
    if (!opts?.ignoreFlag && !seamEnabled()) {
      status.lastSkipped = 'seam-disabled'
      return { ok: false, skipped: 'seam-disabled' }
    }
    const notesDir = deps.getNotesDir()
    const memoryDir = conceptMemoryDir(notesDir)
    if (!notesDir || !memoryDir) {
      status.lastSkipped = 'no-vault'
      return { ok: false, skipped: 'no-vault' }
    }
    // A broken entity plane must not stop concept projection — degrade to T1.
    let catalog: EntityCatalogEntry[] | undefined
    try {
      catalog = deps.buildCatalog(notesDir)
    } catch {
      catalog = undefined
    }
    const result = reconcileConcepts(deps.getPromoted(), memoryDir, deps.getAllFacts(), catalog, deps.humanEdits)
    try {
      deps.reindex?.(notesDir)
    } catch {
      /* semantic index refresh is best-effort */
    }
    status.runs++
    status.lastSkipped = null
    status.lastResult = result
    status.lastError = null
    return { ok: true, result }
  } catch (e) {
    status.lastError = String((e as Error)?.message ?? e)
    return { ok: false, error: status.lastError }
  }
}

/** Debounced trigger — called by the seam hook on every governed transition. Trailing-edge:
 *  the timer resets on each event, so a govern burst yields one reconcile after quiet.
 *  Safe no-op before start (the hook can fire while main is still wiring). */
export function scheduleSeamReconcile(trigger: string): void {
  if (!stashedDeps || !seamAutoReconcileEnabled()) return
  pendingTrigger = trigger
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const t = pendingTrigger ?? 'event'
    pendingTrigger = null
    if (stashedDeps) runSeamReconcileNow(t, stashedDeps)
  }, debounceMs)
  debounceTimer.unref?.()
}

/** Start the auto-fire: stash deps for event scheduling + arm the ONE-SHOT boot self-heal.
 *  bootDelayMs 0 disables the boot pass (event scheduling still arms). */
export function startSeamAutoReconcile(
  deps: SeamReconcileDeps,
  opts?: { bootDelayMs?: number; debounceMs?: number }
): void {
  if (!seamAutoReconcileEnabled()) return
  if (status.started) return
  status.started = true
  stashedDeps = deps
  // W4: a human's edit or deletion of a concept file reaches us through the vault watcher. Only
  // `.brain/memory/concept-*.md` change/unlink events count; everything else is the notes tree.
  unsubscribeFiles?.()
  unsubscribeFiles = onVaultFileEvent((ev) => {
    if (ev.type === 'add') return
    const memoryDir = conceptMemoryDir(stashedDeps?.getNotesDir() ?? null)
    if (!memoryDir) return
    const p = resolve(ev.path)
    if (!p.startsWith(resolve(memoryDir) + sep)) return
    const base = basename(p)
    if (!base.startsWith('concept-') || !base.endsWith('.md')) return
    scheduleSeamReconcile(`file-${ev.type}`)
  })
  debounceMs = opts?.debounceMs ?? envInt('DUIN_SEAM_RECONCILE_DEBOUNCE_MS', DEBOUNCE_MS_DEFAULT)
  const bootDelay = opts?.bootDelayMs ?? envInt('DUIN_SEAM_BOOT_RECONCILE_MS', BOOT_DELAY_MS_DEFAULT)
  if (bootDelay > 0) {
    bootTimer = setTimeout(() => {
      bootTimer = null
      if (stashedDeps) runSeamReconcileNow('boot', stashedDeps)
    }, bootDelay)
    bootTimer.unref?.()
  }
}

/** Stop everything — wired into BOTH quit paths (will-quit handler and the headless-CLI
 *  finally block), per the measure-tick lifecycle contract. */
export function stopSeamAutoReconcile(): void {
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  unsubscribeFiles?.()
  unsubscribeFiles = null
  stashedDeps = null
  status.started = false
}

/** Test hook — full state reset so fake-timer suites start clean. */
export function __resetSeamReconcileForTests(): void {
  stopSeamAutoReconcile()
  status.runs = 0
  status.lastAt = null
  status.lastTrigger = null
  status.lastSkipped = null
  status.lastResult = null
  status.lastError = null
  pendingTrigger = null
  debounceMs = DEBOUNCE_MS_DEFAULT
}
