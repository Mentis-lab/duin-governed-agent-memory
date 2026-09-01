// provider-health — short-lived memory of which provider accounts are currently refusing.
//
// THE GAP THIS CLOSES. `isUsableModel` answers "is there a key for this provider", and a drained
// account keeps its key forever. So every routing decision — chat, extraction, titles, workflows —
// kept selecting a provider that had been refusing every request for weeks. The operator's own
// words for the requirement: it "should detect and use whatever llm account is priority and then
// whatever is available". Priority is already expressed by the routing order; what was missing was
// AVAILABILITY.
//
// Measured on the live install before this existed: 21 of 32 extraction batches refused for quota
// on every build, 740 ledgered occurrences over five weeks, while a funded DeepSeek key sat
// unused because routing never reconsidered.
//
// DESIGN NOTES:
//  • In-memory and short-lived BY DESIGN. A balance top-up must not require an app restart to be
//    noticed, so a cooldown expires on its own and the provider is retried.
//  • Records only the "this account cannot serve ANY request right now" class (quota/billing/rate),
//    classified by the existing provider-agnostic isQuotaError. A content or tool error says
//    nothing about the account and must never park a provider.
//  • Never let the last provider be silenced: if every keyed provider is cooling down, the caller
//    is told to ignore the cooldown entirely. Refusing to route at all would turn a degraded state
//    into a dead one.

/** How long a provider stays parked after refusing. Long enough to stop a ~30-minute background
 *  loop from re-burning the same doomed calls, short enough that a top-up is picked up promptly
 *  without a restart. */
const COOLDOWN_MS = 45 * 60_000

interface Refusal {
  at: number
  reason: string
}

const refusals = new Map<string, Refusal>()

/** Record that `provider` refused for a quota/billing/rate reason. Callers should classify with
 *  isQuotaError first — this module trusts them and does not re-parse. */
export function noteProviderRefusal(provider: string, reason: string, now: number = Date.now()): void {
  if (!provider) return
  refusals.set(provider, { at: now, reason })
}

/** Clear a provider the moment it serves a request successfully — a single success is better
 *  evidence than a timer, and it makes a top-up visible immediately. */
export function noteProviderSuccess(provider: string): void {
  if (provider) refusals.delete(provider)
}

export function isProviderCoolingDown(provider: string, now: number = Date.now()): boolean {
  const hit = refusals.get(provider)
  if (!hit) return false
  if (now - hit.at >= COOLDOWN_MS) {
    refusals.delete(provider) // expired — let it be tried again
    return false
  }
  return true
}

/** Why a provider is parked, for an honest log line. */
export function coolingDownReason(provider: string): string | null {
  return refusals.get(provider)?.reason ?? null
}

/**
 * Filter a candidate provider list down to the ones worth trying, preserving ORDER (which is
 * where priority lives). Returns the original list when every candidate is cooling down, so a
 * fully-degraded estate still routes somewhere instead of failing closed.
 */
export function availableProviders<T extends string>(candidates: readonly T[], now: number = Date.now()): T[] {
  const open = candidates.filter((p) => !isProviderCoolingDown(p, now))
  return open.length > 0 ? open : [...candidates]
}

/** True when at least one candidate is parked — lets a caller say so once instead of silently
 *  routing elsewhere, which would look like the model changed for no reason. */
export function anyCoolingDown<T extends string>(candidates: readonly T[], now: number = Date.now()): boolean {
  return candidates.some((p) => isProviderCoolingDown(p, now))
}

/** Test seam. */
export function __resetProviderHealth(): void {
  refusals.clear()
}
