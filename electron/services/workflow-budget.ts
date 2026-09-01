// B5: per-tier token budget tracker. Workflows tag each agent call with a
// symbolic tier ('cheap' / 'pro' / 'unknown') via the `model` option (which
// can either be a tier name like 'cheap' or a concrete model ID); the
// tracker accumulates tokensUsedEstimate per tier so the renderer can
// surface a cheap-vs-expensive cost breakdown.
//
// The runner injects this tracker into the sandbox as `budget` and the
// workflow can call `budget.byTier()` directly. The runner also fires a
// `workflow:tokens` event after every agent finish so the panel can render
// tier-coloured chips live.

export type Tier = 'cheap' | 'pro' | 'unknown'

export const TIER_MODEL_MAP: Record<string, string> = {
  // Workflow scripts say `model: 'cheap'` or `model: 'pro'` — these symbolic
  // names resolve to concrete provider model IDs at runtime. Production wiring
  // overrides this via setTierModelResolver() so user-selected models drive the
  // mapping; the defaults below are sensible across the three Lamprey providers.
  cheap: 'deepseek-v4-flash',
  pro: 'deepseek-v4-pro'
}

const tierByModel = new Map<string, Tier>()

export function setTierModelMap(map: Partial<Record<Tier, string>>): void {
  for (const [tier, modelId] of Object.entries(map)) {
    if (typeof modelId === 'string' && modelId) {
      TIER_MODEL_MAP[tier] = modelId
    }
  }
}

/** Resolves a symbolic budget tier to a concrete model id against LIVE state
 *  (stored provider keys + detected Ollama models). Returns null for "nothing
 *  usable right now" — which is a different answer from "no preference", so the
 *  caller keeps its static default rather than substituting an unusable id. */
export type TierModelResolver = (tier: 'cheap' | 'pro') => string | null

let tierModelResolver: TierModelResolver | null = null

/**
 * Register the production tier resolver (main.ts wires registry's
 * resolveWorkflowTierModel). Pass null to unregister.
 *
 * WHY a resolver and not setTierModelMap(): main.ts used to SNAPSHOT both tiers
 * once, synchronously, inside app.whenReady. That snapshot is taken before any
 * of the live state it reads exists — `ollamaModels` is only ever filled by the
 * async detectOllama() probe that startLocalBrain fires ~300 lines later, so on
 * a keyless local-Ollama install both tiers resolved null on EVERY launch and
 * the map stayed pinned to the hardcoded DeepSeek ids forever. A key pasted
 * after onboarding was ignored for the rest of the session for the same reason.
 * The staleness was invisible because it only shows up as "workflows demand a
 * DeepSeek key" while every other consumer (routeModel, chatOnce) reads getKey()
 * live and looks correct.
 */
export function setTierModelResolver(resolve: TierModelResolver | null): void {
  tierModelResolver = resolve
}

export function registerTier(modelId: string, tier: Tier): void {
  tierByModel.set(modelId, tier)
}

/** Resolve a model ID OR a symbolic tier name to a concrete model ID. Symbolic
 *  tiers are re-resolved against live state on EVERY call, so a key added mid-
 *  session (or an Ollama probe that finishes after boot) takes effect without a
 *  restart; TIER_MODEL_MAP is the last-resort default when nothing resolves. */
export function resolveModelId(idOrTier: string | undefined, defaultModel: string): string {
  if (!idOrTier) return defaultModel
  if (idOrTier === 'cheap' || idOrTier === 'pro') {
    // Fail soft: this seam now runs on the workflow agent() path, where a
    // resolver throw would abort the agent call. It used to run once at boot
    // under main.ts's try/catch, so degrading to the static map preserves the
    // old behaviour instead of turning a keychain hiccup into a workflow crash.
    try {
      const live = tierModelResolver?.(idOrTier)
      if (live) return live
    } catch (e) {
      console.debug('[workflow-budget] tier resolver failed:', (e as Error)?.message)
    }
  }
  if (idOrTier in TIER_MODEL_MAP) return TIER_MODEL_MAP[idOrTier]
  return idOrTier
}

/** Classify a model ID by tier. Falls back to substring heuristics so a
 *  concrete provider-specific ID still ends up in the right bucket without
 *  per-model registration. */
export function tierOfModel(modelId: string | undefined): Tier {
  if (!modelId) return 'unknown'
  const explicit = tierByModel.get(modelId)
  if (explicit) return explicit
  const lower = modelId.toLowerCase()
  if (
    lower.includes('flash') ||
    lower.includes('haiku') ||
    lower.includes('mini') ||
    lower.includes('gemma') ||
    lower.includes('-v3-') ||
    lower === 'cheap'
  ) {
    return 'cheap'
  }
  if (
    lower.includes('pro') ||
    lower.includes('opus') ||
    lower.includes('sonnet') ||
    lower.includes('reasoning') ||
    lower === 'pro'
  ) {
    return 'pro'
  }
  return 'unknown'
}

export interface BudgetTracker {
  total: number | null
  spent(): number
  remaining(): number
  byTier(): Record<Tier, number>
  record(modelId: string | undefined, tokens: number): void
}

export function makeBudgetTracker(total: number | null = null): BudgetTracker {
  const perTier: Record<Tier, number> = { cheap: 0, pro: 0, unknown: 0 }
  let spent = 0
  return {
    get total(): number | null {
      return total
    },
    spent: () => spent,
    remaining: () => (total === null ? Infinity : Math.max(0, total - spent)),
    byTier: () => ({ ...perTier }),
    record: (modelId, tokens) => {
      const t = tokens > 0 ? tokens : 0
      spent += t
      perTier[tierOfModel(modelId)] += t
    }
  }
}
