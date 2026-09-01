// action-ledger — the safe-undo ledger (item 23, the Rubrik point-in-time frontier). Single-writer
// JSON v1 (MAIN PROCESS ONLY — a future sidecar writer would race). Records reversible Tier-B
// actions with an inverse spec + a prior-content snapshot; revertAction dispatches the inverse and
// fires the governor-demote signal EXACTLY ONCE on the applied→reverted transition (the load-bearing
// correctness invariant — a human undo tightens future autonomy). Scope-guarded to the Tier-B
// reversible set: recordAction refuses anything classifyAction doesn't rate B/grad.
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'fs'
import { join, resolve, dirname, basename, sep } from 'path'
import { randomUUID } from 'crypto'
import { atomicWriteDurable } from '../brain/durable-write'
import { recordFeedback, getCapability, RSI_APPLY_CAP_ID } from './capability-ledger'
import { classifyAction } from '../governance/action-class'
import { captureSnapshot, readSnapshot, deleteSnapshot, setSnapshotDir } from './snapshot-store'
import { readSettings } from '../settings-helper'
import { messageOf } from '../guarded'

export type InverseSpec = { kind: 'restore-file'; path: string } | { kind: 'delete-file'; path: string }

export interface ActionRecord {
  id: string
  ts: number
  actionKind: string
  capabilityId: string
  inverseSpec: InverseSpec
  priorSnapshotRef: string | null
  /** 'reverted' means a HUMAN undid it, and carries the governor-demote signal. 'closed' means the
   *  machine that applied it took it back on its own (the RSI's automatic rollback) — a genuinely
   *  different situation that must NOT demote, since nobody objected. Kept distinct rather than
   *  reusing 'reverted' because the applied→reverted transition is the exact edge the
   *  demote-fires-exactly-once invariant hangs on. */
  status: 'applied' | 'reverted' | 'closed'
  revertedAt?: number
  closedAt?: number
  closedBy?: 'auto-rollback'
}

// Cap the in-memory ring so a long-running install can't grow the ledger unboundedly (C3). Mirrors
// capability-ledger's MAX_CAPS: on overflow we rotate out the OLDEST records (they're the least
// likely to still be revert-worthy). A dropped record simply loses its undo affordance — safe.
export const MAX_ACTIONS = 500

let ledgerPath: string | null = null
// P1 — the fallback confinement root for revert paths (the app userData dir given here). The primary
// allowed root is the vault (localBrainNotesDir from settings, where the undoable notes actually
// live); this base covers unit tests + any userData-local target. See isPathConfined below.
let ledgerBaseRoot: string | null = null
let store: { version: number; actions: ActionRecord[] } = { version: 1, actions: [] }

/** A loaded record is only usable if it carries an inverse-spec PATH (P1 — a path-less record can't
 *  be safely confined or dispatched, so drop it on load rather than trust it later). */
function isValidRecord(r: unknown): r is ActionRecord {
  const rec = r as ActionRecord | null
  return (
    !!rec &&
    typeof rec.id === 'string' &&
    (rec.status === 'applied' || rec.status === 'reverted') &&
    !!rec.inverseSpec &&
    typeof rec.inverseSpec.path === 'string' &&
    rec.inverseSpec.path.length > 0
  )
}

export function setActionLedgerPath(userData: string): void {
  ledgerPath = join(userData, 'ans-undo', 'action-ledger.json')
  ledgerBaseRoot = userData
  setSnapshotDir(userData)
  try {
    if (existsSync(ledgerPath)) {
      const raw = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { actions?: ActionRecord[] }
      // Validate on load (P1): keep only records with a usable inverse path, and cap to MAX_ACTIONS.
      if (raw && Array.isArray(raw.actions)) {
        const valid = raw.actions.filter(isValidRecord)
        // C3: evicting the head drops those records forever — delete their orphaned snapshots.
        for (const d of valid.slice(0, Math.max(0, valid.length - MAX_ACTIONS)))
          if (d.priorSnapshotRef) deleteSnapshot(d.priorSnapshotRef)
        store = { version: 1, actions: valid.slice(-MAX_ACTIONS) }
      }
    }
  } catch {
    store = { version: 1, actions: [] }
  }
}

/** The set of roots a revert path may live under (P1). Primary = the vault (where undoable notes
 *  are), sourced from settings the same way the rest of the brain reads it; fallback = the ledger's
 *  own userData base (covers tests + userData-local targets). Empty ⇒ nothing is confined ⇒ refuse. */
function allowedRoots(): string[] {
  const roots: string[] = []
  try {
    const nd = readSettings().localBrainNotesDir
    if (typeof nd === 'string' && nd.trim()) roots.push(nd.trim())
  } catch (e) { console.debug('[action-ledger] settings unavailable (e.g. outside the main process)  fall through to the base r:', messageOf(e)) }
  if (ledgerBaseRoot) roots.push(ledgerBaseRoot)
  return roots
}

/** Resolve to a real absolute path, defeating symlink traversal. Tolerates a not-yet-existing target
 *  (delete-file / restore-to-null) by resolving the realpath of its nearest existing ancestor. */
function realResolve(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs))
    } catch {
      return abs
    }
  }
}

/** P1 — confine a revert target to an approved root. Refuses anything that resolves outside the
 *  vault/base roots (path traversal, absolute escapes, symlinked-out records). */
function isPathConfined(p: string | undefined | null): boolean {
  if (!p || typeof p !== 'string') return false
  const roots = allowedRoots()
  if (roots.length === 0) return false
  const target = realResolve(p)
  return roots.some((root) => {
    const r = realResolve(root)
    if (target === r) return true
    return target.startsWith(r.endsWith(sep) ? r : r + sep)
  })
}

function persist(): void {
  if (!ledgerPath) return
  atomicWriteDurable(ledgerPath, JSON.stringify(store))
}

/** Record a reversible Tier-B action + snapshot its prior content. Throws on a non-Tier-B action
 *  (the scope guard — only reversible writes get an undo record). */
export function recordAction(input: {
  actionKind: string
  capabilityId: string
  inverseSpec: InverseSpec
  priorContent: string | null
}): ActionRecord {
  const cls = classifyAction(input.actionKind)
  if (!(cls.tier === 'B' && cls.disposition === 'grad')) {
    throw new Error(`action-ledger: refuse non-Tier-B action '${input.actionKind}' (${cls.tier}/${cls.disposition})`)
  }
  const rec: ActionRecord = {
    id: randomUUID(),
    ts: Date.now(),
    actionKind: input.actionKind,
    capabilityId: input.capabilityId,
    inverseSpec: input.inverseSpec,
    priorSnapshotRef: captureSnapshot(input.priorContent),
    status: 'applied'
  }
  store.actions.push(rec)
  // C3 — bound the ring; rotate out the oldest on overflow.
  if (store.actions.length > MAX_ACTIONS) {
    // C3: delete the evicted records' snapshots so the snapshot dir stays bounded too.
    const evicted = store.actions.splice(0, store.actions.length - MAX_ACTIONS)
    for (const e of evicted) if (e.priorSnapshotRef) deleteSnapshot(e.priorSnapshotRef)
  }
  persist()
  return rec
}

export function listActions(filter?: { status?: 'applied' | 'reverted' | 'closed' }): ActionRecord[] {
  return store.actions.filter((a) => !filter?.status || a.status === filter.status)
}

/** The record a BARE undo — `POST /state/undo` with no actionId, and the `duin_undo` MCP tool whose
 *  schema takes an empty object — should target.
 *
 *  "Undo" from an operator means "take back the last thing that was done to me". That is NOT the
 *  same as objecting to something the brain did autonomously, and the difference matters because
 *  revertAction fires recordFeedback('revert'), which TIGHTENS autonomy. Letting a bare undo land on
 *  a machine-originated RSI record turns "undo my last thing" into a demote the operator never
 *  asked for. So the implicit target skips them; an EXPLICIT actionId still reaches an RSI record,
 *  which keeps every record reachable and changes only the default.
 *
 *  Lives here rather than inline in the route so it is testable — there is no HTTP route harness. */
export function implicitUndoTarget(): string | undefined {
  return listActions({ status: 'applied' })
    .filter((a) => a.capabilityId !== RSI_APPLY_CAP_ID)
    .at(-1)?.id
}

/** Close an action the MACHINE already took back itself, without firing the demote signal.
 *
 *  The RSI's automatic rollback restores the prior bytes and marks its own InflightChange
 *  'rolled-back', but never touched this ledger — so the ActionRecord stayed 'applied' forever and
 *  remained a live `/state/undo` target. A later bare undo then re-restored bytes that were already
 *  restored (a near-no-op) AND fired recordFeedback('revert'), tightening autonomy on the strength
 *  of a human objection that never happened.
 *
 *  This is deliberately NOT revertAction: the inverse has already been dispatched by the caller, and
 *  no demote is owed. It is also deliberately not `status='reverted'` — see the ActionRecord
 *  docblock. Idempotent, and it drops the snapshot for the same C3 reason revertAction does.
 *
 *  Note it does NOT refuse on a missing capability the way revertAction does; that guard exists to
 *  protect the demote signal, and there is no demote here to lose. */
export function closeAction(id: string, closedBy: 'auto-rollback'): { ok: boolean; error?: string } {
  const rec = store.actions.find((a) => a.id === id)
  if (!rec) return { ok: false, error: 'action not found' }
  if (rec.status !== 'applied') return { ok: true } // idempotent — already terminal
  rec.status = 'closed'
  rec.closedAt = Date.now()
  rec.closedBy = closedBy
  if (rec.priorSnapshotRef) {
    deleteSnapshot(rec.priorSnapshotRef)
    rec.priorSnapshotRef = null
  }
  persist()
  return { ok: true }
}

/** Revert an action: apply the inverse, fire recordFeedback('revert') EXACTLY ONCE (guarded by the
 *  applied→reverted transition), and flip status. Ordering is load-bearing (C2/P3): the demote signal
 *  is the "a human undo tightens future autonomy" invariant, so we (1) refuse if the target escapes
 *  the vault (P1), (2) refuse if the capability that must receive the demote is GONE — leaving status
 *  'applied' so a retry/reconcile catches it instead of silently losing the signal, (3) dispatch the
 *  inverse, (4) record feedback and CHECK its boolean (a TOCTOU safety net), and only then flip to
 *  'reverted' + drop the consumed snapshot (C3). */
export function revertAction(id: string): { ok: boolean; error?: string } {
  const rec = store.actions.find((a) => a.id === id)
  if (!rec) return { ok: false, error: 'action not found' }
  if (rec.status !== 'applied') return { ok: true } // idempotent no-op — already reverted

  const spec = rec.inverseSpec
  // P1 — refuse a target that resolves outside the approved root(s). Keep status 'applied'.
  if (!isPathConfined(spec?.path)) {
    return { ok: false, error: `revert path outside the vault root — refused: ${spec?.path ?? '<none>'}` }
  }

  // C2/P3 — the demote signal MUST land. If the capability row is gone, recordFeedback would no-op,
  // so refuse BEFORE touching disk or flipping status: the revert stays un-applied and a later pass
  // (once the capability exists) can complete it, instead of a silent {ok:true} that loses the demote.
  if (!getCapability(rec.capabilityId)) {
    return { ok: false, error: `capability '${rec.capabilityId}' missing — demote signal cannot fire; revert refused` }
  }

  try {
    if (spec.kind === 'restore-file') {
      const snap = rec.priorSnapshotRef ? readSnapshot(rec.priorSnapshotRef) : { content: null }
      if (snap.content === null) {
        try {
          unlinkSync(spec.path)
        } catch (e) { console.debug('[action-ledger] file already gone:', messageOf(e)) }
      } else {
        atomicWriteDurable(spec.path, snap.content)
      }
    } else {
      try {
        unlinkSync(spec.path)
      } catch (e) { console.debug('[action-ledger] file already gone:', messageOf(e)) }
    }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? 'revert failed' }
  }

  // Fire the demote signal and CHECK it (TOCTOU: the capability could vanish between the guard above
  // and here). On failure keep status 'applied' so the un-handled revert is retryable — the inverse
  // dispatch above is idempotent, so a retry is safe.
  if (!recordFeedback(rec.capabilityId, 'revert')) {
    return { ok: false, error: 'demote signal failed after inverse — left applied for retry' }
  }

  rec.status = 'reverted'
  rec.revertedAt = Date.now()
  // C3 — the snapshot is consumed; delete it so snapshots don't accumulate forever.
  if (rec.priorSnapshotRef) {
    deleteSnapshot(rec.priorSnapshotRef)
    rec.priorSnapshotRef = null
  }
  persist()
  return { ok: true }
}

export function __resetActionLedger(): void {
  store = { version: 1, actions: [] }
}
