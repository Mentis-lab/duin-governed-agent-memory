// provider-health-state — the ONE in-memory record of what each provider account can do right now.
//
// Leaf module by design (imports nothing that imports `registry.ts`): `registry.ts` notes every
// classified refusal and success here from inside its own catch blocks, while `provider-health.ts`
// (the probe) and `router.ts` (resolution) READ it. `import-x/no-cycle` is an error in this repo, so
// the state has to sit below both of its writers.
//
// Two facts per provider, kept separately because they have different evidence and lifetimes:
//
//   COOLDOWN  — "a live request was refused for an account-level reason" (no credit, bad key,
//               rate limit, unreachable). Parks the provider for a bounded window so a 30-minute
//               background loop stops re-burning doomed calls. Cleared by ANY success. Bounded.
//   HEALTH    — the last completed observation (`ProviderHealth`): a probe completion, a served
//               request, or a classified failure. Carries the reason + a bounded detail + the
//               probe model id. TTL is enforced by the probe layer (10 min), not here.
//
// LIMITS (published, not implied): process-lifetime memory — a restart forgets everything and the
// boot probes rebuild it; a provider never probed and never called has NO entry (`getProviderHealth`
// → undefined), which resolution treats as "unknown, may be tried" — not as healthy; a cooldown is a
// timer, so a top-up is noticed within the window even without a success; `not-found` is a MODEL
// fact and never parks the provider account.

import type { ProviderHealth, ProviderHealthReason } from './roles'
import { providerFixHint } from './roles'
import type { ProviderId } from './registry'
import { classifyProviderError } from './quota-error'

/** Park window per classified reason. Rate limits clear on their own; an unreachable host is
 *  usually transient; a dry or rejected account is not. */
const COOLDOWN_BY_REASON: Partial<Record<ProviderHealthReason, number>> = {
  'rate-limit': 2 * 60_000,
  network: 5 * 60_000,
  'no-credit': 45 * 60_000,
  unauthorized: 45 * 60_000,
  'model-access': 45 * 60_000
}
/** Legacy default (the pre-classifier window): an unclassified refusal from a caller that
 *  already decided it was account-level. */
const COOLDOWN_LEGACY_MS = 45 * 60_000

interface Refusal {
  at: number
  reason: string
  classified: ProviderHealthReason
  cooldownMs: number
}

const refusals = new Map<string, Refusal>()
const health = new Map<string, ProviderHealth>()
const listeners = new Set<() => void>()

/** Bounded raw text for a status line. Only caps length; secrets never enter this module because
 *  the classifier is handed provider RESPONSE text, never request headers. */
export function boundDetail(text: string, max = 200): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function emit(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch (err) {
      console.error('[provider-health] listener failed:', err)
    }
  }
}

/** Subscribe to any health/cooldown change. Fires synchronously after the change; the payload is
 *  read back through `listProviderHealth()` (the probe layer) so a listener always sees the full
 *  picture, never a partial row. Returns the unsubscribe. */
export function onProviderHealthChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Record that `provider` refused a live request.
 *
 * `reason` is the raw provider text (kept verbatim for `coolingDownReason`, bounded in the health
 * row). `classified` is the classifier's verdict; when a caller passes none, the text is classified
 * here AND the provider is parked for the legacy 45-minute window regardless (the pre-classifier
 * contract: "callers decide it was account-level, this module trusts them"). When `classified` IS
 * given, the park window follows COOLDOWN_BY_REASON — and `not-found` / `unknown` / `ok` do not park
 * the account at all, because they say nothing about it.
 */
export function noteProviderRefusal(
  provider: string,
  reason: string,
  now: number = Date.now(),
  classified?: ProviderHealthReason
): void {
  if (!provider) return
  const verdict = classified ?? classifyProviderError({ message: reason }, provider as ProviderId).reason
  const cooldownMs = classified ? (COOLDOWN_BY_REASON[classified] ?? 0) : COOLDOWN_LEGACY_MS
  if (cooldownMs > 0) refusals.set(provider, { at: now, reason, classified: verdict, cooldownMs })
  // A parked account is a completed observation about the account; a non-parking verdict
  // (not-found, unknown) is not, so it leaves the last observation alone.
  if (cooldownMs > 0) {
    health.set(provider, {
      provider: provider as ProviderHealth['provider'],
      healthy: false,
      reason: verdict,
      detail: boundDetail(reason),
      // The leaf knows no labels; the probe layer re-labels this with the catalog name on read.
      hint: providerFixHint(verdict, provider),
      checkedAt: now
    })
  }
  emit()
}

/** Clear a provider the moment it serves a request successfully — a single success is better
 *  evidence than a timer, and it makes a top-up visible immediately. Also records the success as
 *  the provider's current health (a served request IS a completion). */
export function noteProviderSuccess(provider: string, now: number = Date.now()): void {
  if (!provider) return
  const hadRefusal = refusals.delete(provider)
  const prev = health.get(provider)
  if (hadRefusal || !prev || prev.healthy !== true || prev.reason !== 'ok') {
    health.set(provider, {
      provider: provider as ProviderHealth['provider'],
      healthy: true,
      reason: 'ok',
      hint: '',
      probedModelId: prev?.probedModelId,
      checkedAt: now
    })
    emit()
  }
}

export function isProviderCoolingDown(provider: string, now: number = Date.now()): boolean {
  const hit = refusals.get(provider)
  if (!hit) return false
  if (now - hit.at >= hit.cooldownMs) {
    refusals.delete(provider) // expired — let it be tried again
    return false
  }
  return true
}

/** Why a provider is parked, for an honest log line (raw text). */
export function coolingDownReason(provider: string): string | null {
  return refusals.get(provider)?.reason ?? null
}

/** The classified reason a provider is parked for, or null when it is not parked. */
export function coolingDownClass(provider: string, now: number = Date.now()): ProviderHealthReason | null {
  if (!isProviderCoolingDown(provider, now)) return null
  return refusals.get(provider)?.classified ?? null
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

/** Store a completed probe observation. A healthy probe also lifts a cooldown: the probe is a
 *  real completion against the same account, which is exactly the evidence the park was waiting
 *  for. Never stores a key. */
export function recordProviderHealth(h: ProviderHealth): void {
  health.set(h.provider, { ...h, detail: h.detail ? boundDetail(h.detail) : undefined })
  if (h.healthy) refusals.delete(h.provider)
  emit()
}

/** The last completed observation for `provider`, or undefined when there is none yet. Readers
 *  must treat undefined as UNKNOWN (may be tried), never as healthy. */
export function getProviderHealth(provider: string): ProviderHealth | undefined {
  return health.get(provider)
}

/** Every observation on record (no-key rows and unprobed providers are absent; the probe layer
 *  fills those in for the UI). */
export function healthSnapshot(): ProviderHealth[] {
  return [...health.values()]
}

/**
 * Three-valued usability for routing — the collapse this avoids (property 8): "no observation yet"
 * and "observed healthy" must not read the same, and neither may read as "observed failing".
 *   'unhealthy' — parked (cooldown) or last observation healthy:false
 *   'healthy'   — last observation healthy:true with reason 'ok'
 *   'unknown'   — no observation (never probed, never called) or a no-key row
 */
export function providerHealthState(
  provider: string,
  now: number = Date.now()
): 'healthy' | 'unhealthy' | 'unknown' {
  if (isProviderCoolingDown(provider, now)) return 'unhealthy'
  const h = health.get(provider)
  if (!h) return 'unknown'
  if (h.healthy === false && h.reason !== 'no-key') return 'unhealthy'
  if (h.healthy === true && h.reason === 'ok') return 'healthy'
  return 'unknown'
}

/** Test seam. */
export function __resetProviderHealth(): void {
  refusals.clear()
  health.clear()
}
