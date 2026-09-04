// provider-health — health is a COMPLETION, not a key check (plan §2.1 W2, constitution property 6).
//
// `isUsableModel` answers "is there a key for this provider", and a drained account keeps its key
// forever. Measured 2026-09-02 (L5 F1/F2, L6 F2–F4): of ~40 picker ids, 2 answered; the key tester
// said every provider was fine because it validated the key, not the account. So a provider is
// healthy only when a real 1-token chat completion against its cheapest catalog model came back
// 200, or a live request was served — and unhealthy for the classified reason the completion
// (or the live request) actually returned.
//
// This module is the PROBE layer over `provider-health-state.ts` (the record every writer shares;
// re-exported below so existing callers keep one import path). It reads the catalog, so it sits
// above registry.ts and registry.ts must never import it — registry notes refusals through the
// state module directly.
//
// LIMITS (published): one completion per provider per HEALTH_TTL_MS (10 min) at most, plus one on
// key save and one at boot (staggered) — R6's cap; a probe costs one token of output; the probe
// model is the provider's cheapest non-hidden catalog model (tier flash → open → pro → coder →
// reasoner), so a key that lacks access to THAT model reads `model-access` even if another model
// would work; a provider with no catalog or custom model cannot be probed and stays `unknown`;
// results live in process memory (a restart starts unknown, the boot probes fill it in ~30s).

import {
  PROVIDERS,
  MODEL_CATALOG,
  getOllamaModels,
  listCustomModels,
  resolveModel,
  type ProviderId
} from './registry'
import { getKey } from '../keychain'
import type { ProviderHealth } from './roles'
import { providerFixHint } from './roles'
import { classifyProviderError } from './quota-error'
import {
  getProviderHealth,
  recordProviderHealth,
  isProviderCoolingDown,
  coolingDownClass,
  coolingDownReason,
  boundDetail
} from './provider-health-state'

export {
  noteProviderRefusal,
  noteProviderSuccess,
  isProviderCoolingDown,
  coolingDownReason,
  coolingDownClass,
  availableProviders,
  anyCoolingDown,
  onProviderHealthChanged,
  getProviderHealth,
  providerHealthState,
  healthSnapshot,
  __resetProviderHealth
} from './provider-health-state'

/** A completed probe is trusted this long before the next resolve-time read re-probes lazily. */
export const HEALTH_TTL_MS = 10 * 60_000
/** Hard ceiling on one probe round-trip. Long enough for a slow CN gateway, short enough that a
 *  boot sweep across a dozen providers finishes in well under a minute. */
export const PROBE_TIMEOUT_MS = 12_000
/** Boot probes start after this delay and are spaced by PROBE_STAGGER_MS so they never pile onto
 *  the reindex/embedder warm-up or hit every gateway in the same second. */
export const PROBE_BOOT_DELAY_MS = 2_500
export const PROBE_STAGGER_MS = 1_500

const PROBE_TIER_ORDER = ['flash', 'open', 'pro', 'coder', 'reasoner'] as const

/** Providers the operator can key or pick. Hidden gateways are operator infrastructure and are
 *  probed only when explicitly asked for by id. */
export function visibleProviders(): ProviderId[] {
  return (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => !PROVIDERS[p].hidden)
}

/** "Keyed" = a key is stored; for the local runtime, a model was detected. */
export function providerIsKeyed(provider: ProviderId): boolean {
  if (provider === 'ollama') return getOllamaModels().length > 0
  return !!getKey(PROVIDERS[provider].keyEnv)
}

/** The model a probe uses: the provider's cheapest non-hidden catalog model, else its first custom
 *  model, else (ollama) its first detected model. Null when the provider has nothing callable. */
export function probeTargetFor(provider: ProviderId): { modelId: string; apiModelId: string } | null {
  if (provider === 'ollama') {
    const name = getOllamaModels()[0]
    return name ? { modelId: `ollama:${name}`, apiModelId: name } : null
  }
  for (const tier of PROBE_TIER_ORDER) {
    const m = MODEL_CATALOG.find((x) => x.provider === provider && x.tier === tier && !x.hidden && !x.internal)
    if (m) return { modelId: m.id, apiModelId: m.apiModelId }
  }
  const custom = listCustomModels().find((c) => c.provider === provider)
  if (custom) {
    const d = resolveModel(custom.id)
    return { modelId: d.id, apiModelId: d.apiModelId }
  }
  return null
}

const inflight = new Map<ProviderId, Promise<ProviderHealth>>()

/** One 1-token chat completion. Direct fetch rather than the SDK client so the call carries no
 *  SDK retries, honours one timeout, and can be stubbed with `vi.stubGlobal('fetch', …)`. */
async function completeOnce(provider: ProviderId, apiModelId: string, now: number): Promise<ProviderHealth> {
  const desc = PROVIDERS[provider]
  const key = provider === 'ollama' ? 'ollama' : getKey(desc.keyEnv) || ''
  const url = `${desc.baseURL.replace(/\/+$/, '')}/chat/completions`
  const cap = provider === 'openai' || provider === 'moonshot' ? { max_completion_tokens: 1 } : { max_tokens: 1 }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
  const startedAt = Date.now()
  // `checkedAt` is the caller's clock (the TTL compares against it); latency is wall-clock.
  const base = { provider, probedModelId: apiModelId, checkedAt: now }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: apiModelId,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        ...cap
      }),
      signal: ctrl.signal
    })
    const latencyMs = Date.now() - startedAt
    if (res.ok) return { ...base, healthy: true, reason: 'ok', hint: '', latencyMs }
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* the status alone still classifies */
    }
    // Gateways put the useful line in `error.message`; hand the parsed shape to the classifier so
    // the detail is that line, not the whole JSON envelope.
    let parsed: { error?: unknown } | null = null
    try {
      parsed = body ? (JSON.parse(body) as { error?: unknown }) : null
    } catch {
      parsed = null
    }
    const c = classifyProviderError(
      { status: res.status, message: body || res.statusText, error: parsed?.error },
      provider,
      desc.label
    )
    return { ...base, healthy: false, reason: c.reason, detail: c.detail, hint: c.hint, latencyMs }
  } catch (err) {
    const c = classifyProviderError(
      ctrl.signal.aborted ? { name: 'AbortError', message: `probe timed out after ${PROBE_TIMEOUT_MS}ms` } : err,
      provider,
      desc.label
    )
    return { ...base, healthy: false, reason: c.reason, detail: c.detail, hint: c.hint, latencyMs: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe one provider and record the result. Cached: a completed observation younger than
 * HEALTH_TTL_MS is returned without a call unless `force`. A provider with no key answers
 * `no-key` without a call; one with nothing callable answers `unknown` without a call. Concurrent
 * probes of the same provider share one in-flight request. Never throws; never logs a key.
 */
export function probeProvider(provider: ProviderId, force = false, now: number = Date.now()): Promise<ProviderHealth> {
  if (!providerIsKeyed(provider)) {
    const h: ProviderHealth = {
      provider,
      healthy: false,
      reason: 'no-key',
      hint: providerFixHint('no-key', PROVIDERS[provider].label),
      checkedAt: now
    }
    recordProviderHealth(h)
    return Promise.resolve(h)
  }
  const cached = getProviderHealth(provider)
  if (!force && cached && cached.reason !== 'no-key' && now - cached.checkedAt < HEALTH_TTL_MS) {
    return Promise.resolve(cached)
  }
  const running = inflight.get(provider)
  if (running) return running
  const target = probeTargetFor(provider)
  if (!target) {
    const h: ProviderHealth = {
      provider,
      healthy: false,
      reason: 'unknown',
      detail: 'no model to probe with — add one under Custom models on the Models page',
      hint: `${PROVIDERS[provider].label} has no model to call. Add one under Custom models on the Models page.`,
      checkedAt: now
    }
    recordProviderHealth(h)
    return Promise.resolve(h)
  }
  const p = completeOnce(provider, target.apiModelId, now)
    .then((h) => {
      const row = { ...h, probedModelId: target.modelId }
      recordProviderHealth(row)
      return row
    })
    .finally(() => {
      inflight.delete(provider)
    })
  inflight.set(provider, p)
  return p
}

/**
 * Every visible provider's current health, from what is on record — no calls. Rows are
 * computed, never typed: `no-key` from the keychain; a parked provider from its classified
 * refusal; an unobserved keyed provider as `reason: 'unknown', checkedAt: 0` (healthy:true is
 * the ROUTING default for "not observed", and `checkedAt === 0` is how a reader tells it from an
 * observed 'ok'). May be stale by up to HEALTH_TTL_MS; `refreshProviderHealth` is the fresh path.
 */
export function listProviderHealth(now: number = Date.now()): ProviderHealth[] {
  return visibleProviders().map((provider): ProviderHealth => {
    const label = PROVIDERS[provider].label
    if (!providerIsKeyed(provider)) {
      return { provider, healthy: false, reason: 'no-key', hint: providerFixHint('no-key', label), checkedAt: now }
    }
    if (isProviderCoolingDown(provider, now)) {
      const h = getProviderHealth(provider)
      const reason = coolingDownClass(provider, now) ?? h?.reason ?? 'unknown'
      return {
        provider,
        healthy: false,
        reason,
        detail: boundDetail(coolingDownReason(provider) ?? h?.detail ?? ''),
        hint: providerFixHint(reason, label),
        probedModelId: h?.probedModelId,
        checkedAt: h?.checkedAt ?? now
      }
    }
    const h = getProviderHealth(provider)
    // Rows written by the leaf carry the provider ID as their label; re-label with the catalog name.
    if (h && h.reason !== 'no-key') return { ...h, hint: h.healthy ? '' : providerFixHint(h.reason, label) }
    return { provider, healthy: true, reason: 'unknown', detail: 'not probed yet', hint: '', checkedAt: 0 }
  })
}

/** Fresh: probe `target` (or every keyed visible provider) now, ignoring the TTL, then return the
 *  full list. 'all' runs the probes in parallel — at most one call per provider. */
export async function refreshProviderHealth(target: ProviderId | 'all'): Promise<ProviderHealth[]> {
  const targets = target === 'all' ? visibleProviders() : [target]
  await Promise.all(targets.map((p) => probeProvider(p, true)))
  return listProviderHealth()
}

/**
 * Boot sweep: probe each keyed visible provider once, staggered, off the boot path. Timers are
 * unref'd so they can never hold the process open. Returns the number scheduled (tests). The
 * local runtime is probed too — it is free and its answer is the only evidence Ollama is up.
 */
export function scheduleBootProbes(): number {
  const keyed = visibleProviders().filter(providerIsKeyed)
  keyed.forEach((provider, i) => {
    const t = setTimeout(() => {
      void probeProvider(provider).catch(() => {
        /* probeProvider never throws; belt and braces */
      })
    }, PROBE_BOOT_DELAY_MS + i * PROBE_STAGGER_MS)
    ;(t as { unref?: () => void }).unref?.()
  })
  return keyed.length
}
