// background-work-gate — one answer to "may an automatic, token-spending pass run right now?"
//
// THE OPERATOR RULE (2026-08-25): automatic work that costs money must not run unless the app is
// actually being USED and knowledge is actually being UPDATED. Not on a wall clock, not on any
// file event, and never as a consequence of DUIN's own writes.
//
// WHAT WENT WRONG WITHOUT IT. Construction (a full LLM pass over the vault) was armed by any
// watched file change. DUIN materializes promoted memory as .md files INSIDE the watched vault,
// so its own output re-armed the trigger that produced it: materialize -> watcher -> extract ->
// materialize, every CONSTRUCT_MIN_GAP_MS, forever, with no human in the loop. Measured on the
// operator's live vault while they were away: 57 machine files rewritten in three days,
// ~1,000-1,700 new entity nodes PER DAY (23,387 total), and a matching share of the extraction
// quota burn - 21 of 32 batches refused for billing on every one of those runs.
//
// TWO CONDITIONS, both required:
//   PRESENCE  - the operator has used the app recently. Recorded at real interaction points
//               (a completed chat turn), never by a timer, so "in use" cannot be self-asserted
//               by background work.
//   MATERIAL  - operator CONTENT changed since the last pass: a note created, or an existing
//               note edited substantively. DUIN's own state files never qualify, and neither
//               does a trivial touch (see MIN_MATERIAL_DELTA_BYTES).
//
// WHAT THIS DOES NOT GATE. Explicit operator intent - a Rebuild click, onboarding adoption, an
// /reindex - is not "automatic" and must never be blocked; those paths call the work directly.
// Structural indexing is also untouched: a machine-written note still gets INDEXED (a promoted
// concept must be retrievable), it just no longer buys a full LLM re-extraction.

/** How long after an interaction the operator still counts as present. Deliberately generous:
 *  the goal is "not while they are away for days", not "only in the same minute" - a pass that
 *  fires shortly after a working session is still serving that session. */
const PRESENCE_WINDOW_MS = 2 * 60 * 60_000

/** A content edit smaller than this is a touch, not an update - a timestamp bump, a lint fix, a
 *  one-character typo. Significant enough to re-index, never enough to buy an LLM pass. */
const MIN_MATERIAL_DELTA_BYTES = 200

export interface MaterialChange {
  /** Vault-relative or absolute path of the note that changed. */
  path: string
  /** 'created' always qualifies; 'updated' must clear the byte threshold. */
  kind: 'created' | 'updated'
  /** Size delta in bytes when known. Absent = unknown, which counts as material: a change we
   *  could not measure must not be silently discarded. */
  deltaBytes?: number
}

let lastPresenceAt = 0
let pendingMaterial: MaterialChange[] = []

/** Record a REAL operator interaction. Called from interaction sites only. */
export function notePresence(now: number = Date.now()): void {
  lastPresenceAt = now
}

export function isOperatorPresent(now: number = Date.now()): boolean {
  return lastPresenceAt > 0 && now - lastPresenceAt <= PRESENCE_WINDOW_MS
}

/** Record that operator content moved. Machine-state paths must be filtered by the CALLER
 *  (notes-watcher.isMachineStatePath) - this module stays free of path policy. */
export function noteMaterialChange(change: MaterialChange): void {
  const qualifies =
    change.kind === 'created' ||
    change.deltaBytes === undefined ||
    Math.abs(change.deltaBytes) >= MIN_MATERIAL_DELTA_BYTES
  if (qualifies) pendingMaterial.push(change)
}

export function hasMaterialChange(): boolean {
  return pendingMaterial.length > 0
}

/** What is pending, for logging/telemetry. Does not clear. */
export function pendingMaterialChanges(): readonly MaterialChange[] {
  return pendingMaterial
}

export interface GateVerdict {
  ok: boolean
  /** Machine reason when declined, for one honest log line. */
  reason?: 'operator-away' | 'no-material-change'
  detail?: string
}

/**
 * May `label`'s automatic, token-spending pass run now?
 *
 * Declines are LOGGED by the caller, not swallowed: a loop that silently stops is the same
 * failure class as a loop that silently runs - both leave the operator unable to tell whether
 * the machine is working.
 */
export function mayRunAutomaticWork(now: number = Date.now()): GateVerdict {
  if (!isOperatorPresent(now)) {
    const hours = lastPresenceAt ? Math.round((now - lastPresenceAt) / 3_600_000) : null
    return {
      ok: false,
      reason: 'operator-away',
      detail: hours === null ? 'no interaction recorded this session' : `last interaction ${hours}h ago`
    }
  }
  if (!hasMaterialChange()) {
    return { ok: false, reason: 'no-material-change', detail: 'no note created or substantively edited since the last pass' }
  }
  return { ok: true }
}

/** Consume the pending set — call when a pass actually STARTS, so a declined pass keeps its
 *  reason to run later and a completed one does not re-run on the same input. */
export function consumeMaterialChanges(): MaterialChange[] {
  const taken = pendingMaterial
  pendingMaterial = []
  return taken
}

/** Test seam. */
export function __resetBackgroundGate(): void {
  lastPresenceAt = 0
  pendingMaterial = []
}
