// transfer-ab-tick.ts — the SCHEDULED whole-brain A/B litmus, so the pilot's headline moat-fit
// number ("does the accumulated brain fit the operator better than the same model cold?") populates
// on a clock instead of only when someone remembers to POST /debug/transfer-ab. The 2026-07-25
// evaluation tagged the grader SHADOW for exactly that reason: fully built, never exercised by
// anything that runs on its own, and the RSI bench left its slot null as a result.
//
// Structured after measure-tick.ts. Cost stance, stated honestly rather than flatteringly:
//   • runTransferAB makes 3 model calls per query (grounded answer + cold answer + blind judge —
//     transfer-ab.ts:220-230, all three via chatOnce), and DEFAULT_TRANSFER_QUERIES has 24 entries,
//     so one pass is 72 model calls (≈500/week at the daily cadence). The earlier header said
//     "~24 calls"; the release audit (R1 C4) counted 48 from the two answer calls alone.
//   • It is NOT local-first. measure-tick routes through localFirstMeasureDeps (a detected Ollama
//     model, zero billable cost, cloud only as fallback); makeTransferDeps routes through
//     routeModel('extraction'), which resolves the operator's configured provider — usually cloud.
//     Making the litmus local-first would change what the shared /debug route measures too, so it is
//     left alone and the cost is bounded by cadence AND by the gate below.
//   • GATED ON backgroundAutonomy (release M11): a pass runs only while the operator's master
//     switch for unattended billable work is ON — read fresh at pass time (like measure-tick),
//     so flipping it takes effect on the next pass without a restart. A stranger who pastes a
//     key and never opens Settings → Loops pays nothing here. DUIN_TRANSFER_AB_TICK=0 still
//     hard-disables the scheduler.
//   • DUE-CHECKED against the recorded history, not just the interval. A timer alone measures once
//     per LAUNCH — restart the app eight times in a day and you have paid for eight passes while
//     the header claims "daily". A pass is skipped when the last recorded run is younger than the
//     cadence, which also makes the tick idempotent across restarts.
//   • MEASUREMENT-ONLY by construction — runTransferAB mutates no moat state, so a pass can never
//     change what the brain believes. The only write is the history record this tick appends.
//   • Degrades honestly: with no engine available makeTransferDeps returns '' / 'inconclusive'
//     WITHOUT attempting a call, which lands below the sample floor, which records fitLift null. No
//     lift is ever fabricated and a keyless install pays nothing.
//   • FIRE-AND-FORGET + failure-isolated — a failed pass is swallowed; it never breaks the app.
//
// SCHEDULER gated by DUIN_TRANSFER_AB_TICK (default ON; '0'/'false' disables → start/stop are
// no-ops). Cadence via DUIN_TRANSFER_AB_TICK_MS (0 disables). Each PASS is additionally gated on
// the backgroundAutonomy setting (transferAbPassAllowed).
import { runTransferAB, makeTransferDeps, DEFAULT_TRANSFER_QUERIES, type TransferDeps } from './transfer-ab'
import { recordTransferRun, latestTransferRun } from './transfer-ab-store'
import { readSettings } from '../settings-helper'

const TICK_MS = (() => {
  const raw = Number(process.env.DUIN_TRANSFER_AB_TICK_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 24 * 60 * 60_000
})()
const INITIAL_MS = 120_000 // let boot settle well past calibration/metabolism/measure before measuring

/** Scheduler enabled unless DUIN_TRANSFER_AB_TICK is explicitly '0' or 'false'. */
export function transferAbTickEnabled(): boolean {
  const raw = process.env.DUIN_TRANSFER_AB_TICK
  return raw !== '0' && raw !== 'false'
}

/** May a PASS spend model calls right now? Only under backgroundAutonomy === true (missing /
 *  unreadable settings ⇒ OFF = gated). Mirrors measure-tick.backgroundAutonomyOn; resolved fresh
 *  per pass so toggling autonomy takes effect on the next pass, not the next launch. */
export function transferAbPassAllowed(): boolean {
  try {
    return readSettings().backgroundAutonomy === true
  } catch {
    return false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null

/** Is a pass DUE — i.e. is the last recorded run older than the cadence? True when nothing has ever
 *  been recorded. PURE apart from the history read, and exported so the due rule is testable. */
export function transferAbPassDue(vaultDir: string, nowMs: number, cadenceMs: number = TICK_MS): boolean {
  const last = latestTransferRun(vaultDir)
  if (!last) return true
  const lastMs = Date.parse(last.ts)
  // An unreadable timestamp means we cannot show a pass is recent — but re-measuring on every
  // launch is the expensive failure, so treat it as due only once the interval could have elapsed.
  if (!Number.isFinite(lastMs)) return true
  return nowMs - lastMs >= cadenceMs
}

/** One measurement pass over the default query set, recorded to the transfer-A/B history. Skips when
 *  a recent run already answers the question. Awaitable for tests; the scheduler calls it
 *  fire-and-forget. Never rejects. */
export async function transferAbTick(
  getVaultDir: () => string | null,
  deps?: TransferDeps,
  queries: string[] = DEFAULT_TRANSFER_QUERIES
): Promise<void> {
  try {
    const vault = getVaultDir()
    if (!vault) return
    if (!transferAbPassAllowed()) {
      console.log('[transfer-ab-tick] skipping pass — backgroundAutonomy is off (72 cloud calls per pass need the operator\'s opt-in)')
      return
    }
    if (!transferAbPassDue(vault, Date.now())) return
    const result = await runTransferAB(queries, deps ?? makeTransferDeps(vault))
    recordTransferRun(vault, result, new Date().toISOString())
  } catch (e) {
    console.warn('[transfer-ab-tick] pass failed (non-fatal):', (e as Error)?.message)
  }
}

/** Start the periodic litmus: one settle-delayed pass, then every TICK_MS. No-op if already running,
 *  the cadence is 0, or the tick is disabled. */
export function startTransferAbTick(getVaultDir: () => string | null): void {
  if (timer || TICK_MS === 0 || !transferAbTickEnabled()) return
  initial = setTimeout(() => void transferAbTick(getVaultDir), INITIAL_MS)
  timer = setInterval(() => void transferAbTick(getVaultDir), TICK_MS)
}

export function stopTransferAbTick(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
