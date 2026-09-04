import { AUTO_ENGINE, type ModelInfo, type ProviderHealth, type ProviderHealthReason, type RoleResolution } from './types'

/**
 * Compact fallback label for a model id the catalog doesn't know (legacy
 * rows, removed custom models): 'deepseek-v4-pro' → 'Deepseek V4 Pro',
 * 'qwen3-coder-plus' → 'Qwen3 Coder Plus'.
 *
 * The MessageBubble model chip predates the multi-provider era and used to
 * hardcode `'deepseek-reasoner' ? 'R1' : 'V3'`, mislabeling every modern
 * model as "V3". The chip now prefers the catalog display name (model-store
 * `ModelInfo.name`, the same source the ModelSwitcher shows) and uses this
 * formatter only when the id is not in the catalog.
 */
export function formatModelIdFallback(modelId: string): string {
  return modelId
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) =>
      /^v?\d/.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)
    )
    .join(' ')
}

/** Short operator-facing label for a provider health reason (picker group suffix, Status chip). */
export function healthReasonLabel(reason: ProviderHealthReason | undefined): string {
  switch (reason) {
    case 'ok':
      return 'healthy'
    case 'no-key':
      return 'no key'
    case 'no-credit':
      return 'no credit'
    case 'unauthorized':
      return 'key rejected'
    case 'model-access':
      return 'no model access'
    case 'rate-limit':
      return 'rate-limited'
    case 'not-found':
      return 'model not found'
    case 'network':
      return 'unreachable'
    case 'unknown':
      return 'failing'
    default:
      return 'unchecked'
  }
}

/** Reason → operator hint. SOURCE-LOCK: mirror of roles.ts `providerFixHint` (the renderer
 *  cannot import that file — see types.ts); keep the two texts identical. */
export function providerFixHint(reason: ProviderHealthReason | undefined, providerLabel: string): string {
  switch (reason) {
    case 'ok':
      return ''
    case 'no-key':
      return `Add a ${providerLabel} key in Settings → API Keys, or move ${providerLabel} down the provider order.`
    case 'no-credit':
      return `${providerLabel} has no credit. Top up the account or move it down the provider order.`
    case 'unauthorized':
      return `${providerLabel} rejected the key. Re-enter it in Settings → API Keys.`
    case 'model-access':
      return `The ${providerLabel} key is valid but the project cannot use the probed model. Grant access or pick another provider.`
    case 'rate-limit':
      return `${providerLabel} is rate-limiting. DUIN will retry; lower the provider in the order if it persists.`
    case 'not-found':
      return `${providerLabel} no longer serves that model id. Refresh the catalog in Settings → Models.`
    case 'network':
      return `Could not reach ${providerLabel}. Check the network or proxy.`
    case undefined:
      return `${providerLabel} has not been probed yet.`
    default:
      return `${providerLabel} failed for an unclassified reason. See Status → Engine for the detail.`
  }
}

/**
 * ONE label for "which engine is this conversation on" — the composer chip and the status
 * line both render this, so they can never disagree (L5 F6 had three sources).
 *   pinned model, resolved   → "DeepSeek V4 Flash · pinned"
 *   AUTO_ENGINE, resolved    → "DeepSeek V4 Flash · auto"
 *   AUTO_ENGINE, nothing     → "No usable engine"  (no provider can answer right now)
 *   pin, not yet resolved    → "<pin name> · pinned"
 */
export function describeEngine(
  pin: string,
  resolution: RoleResolution | null,
  models: ModelInfo[]
): { label: string; modelId: string | null; mode: 'pinned' | 'auto' | 'none' } {
  const nameOf = (id: string): string => models.find((m) => m.id === id)?.name ?? formatModelIdFallback(id)
  if (resolution) {
    const mode = resolution.source === 'pin' ? 'pinned' : 'auto'
    return { label: `${nameOf(resolution.modelId)} · ${mode}`, modelId: resolution.modelId, mode }
  }
  if (pin && pin !== AUTO_ENGINE) return { label: `${nameOf(pin)} · pinned`, modelId: pin, mode: 'pinned' }
  return { label: 'No usable engine', modelId: null, mode: 'none' }
}

/** One provider group of the composer picker. `healthy` comes from a REAL probe row; a group
 *  with no row yet is `probed: false` (rendered plain, never as usable-because-keyed). */
export interface PickerGroup {
  id: string
  label: string
  models: ModelInfo[]
  probed: boolean
  healthy: boolean
  reason?: ProviderHealthReason
}

/**
 * Provider groups for the picker, PURE so the ordering + usability rules are testable:
 *   1. groups follow the operator's policy order (the primary key of every resolution),
 *   2. providers outside the policy follow `curatedOrder`, then the rest alphabetically,
 *   3. a group is usable iff its provider's latest health row says healthy — a key merely
 *      existing is not "usable" (L5 F2). Unhealthy groups keep their place, greyed, with the
 *      reason; the caller renders the fix hint from `reason`.
 */
export function groupModelsForPicker(input: {
  models: readonly ModelInfo[]
  policyOrder: readonly string[]
  curatedOrder: readonly string[]
  health: readonly ProviderHealth[]
  label: (providerId: string) => string
}): PickerGroup[] {
  const by = new Map<string, ModelInfo[]>()
  for (const m of input.models) {
    if (m.internal) continue
    const key = m.provider ?? 'custom'
    const arr = by.get(key)
    if (arr) arr.push(m)
    else by.set(key, [m])
  }
  const first = input.policyOrder.filter((p) => by.has(p))
  const curated = input.curatedOrder.filter((p) => by.has(p) && !first.includes(p))
  const rest = [...by.keys()].filter((p) => !first.includes(p) && !curated.includes(p)).sort()
  return [...first, ...curated, ...rest].map((pid) => {
    const h = input.health.find((x) => x.provider === pid)
    return {
      id: pid,
      label: input.label(pid),
      models: by.get(pid) as ModelInfo[],
      probed: !!h,
      healthy: h?.healthy === true,
      reason: h?.reason
    }
  })
}
