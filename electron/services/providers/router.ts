// router — the PURE resolution algebra behind every role (roles.ts contract, plan §2.1, decision D2).
//
// Nothing here reads the catalog, the keychain, settings or the health cache directly: the caller
// (registry.ts `resolveRole` / `resolveJury`) gathers those into a `RoleResolverInput` and this
// module only orders and filters. That split is what keeps it cycle-free (`import-x/no-cycle` is an
// error here and registry.ts must be able to import it) and hermetically testable.
//
// THE KEYS, in order (D2: user preference is priority; health filters; tier breaks ties):
//   1. an explicit pin that is callable and not observed-unhealthy wins            → source 'pin'
//   2. the policy: `roles[task]` override, else `order`, else every keyed provider in catalog
//      order; keyed providers the operator did not rank are appended after the ranked ones
//      (a preference list is not an allowlist — `localOnlyBackground` is the privacy switch)
//   3. health: providers observed unhealthy (probe failure, classified refusal, cooldown) go to
//      the END of the chain, never out of it, so a stale observation cannot strand a turn;
//      'unknown' (never observed) ranks with healthy — an unobserved provider is not doomed
//   4. inside a provider, the role's tier order picks the model (ROLE_TIER_ORDER); background
//      roles put the provider's designated extractor first (the binder does this in `candidates`)
//
// LIMITS: the chain holds ONE model per provider (the role's best); a stale model id on a provider
// is handled by the walker's within-provider hop (`routeWithinProvider`), not by this list. A pin
// that is not callable (unknown id, no key) is ignored — the turn resolves from policy and says so.
// `reviewer` skips the avoided provider only while another candidate exists; `jury` never
// includes an avoided or an unhealthy provider and returns fewer than asked, honestly.

import type { ProviderPolicy, RoleResolution, RouteTask, ProviderHealthReason, PolicySpeed } from './roles'
import { providerFixHint } from './roles'
import type { ProviderId, ModelDescriptor } from './registry'

/** The roles the router resolves. `reason` is the chat alias; `code` is a legacy alias kept
 *  for three brain callers that type their own task union (lane B may remove). */
export const ROUTE_TASKS: readonly RouteTask[] = [
  'chat',
  'agentic',
  'extraction',
  'reviewer',
  'jury',
  'title',
  'embed',
  'reason'
]

export type CanonicalTask = 'chat' | 'agentic' | 'extraction' | 'reviewer' | 'jury' | 'title' | 'embed'

/** Roles that `localOnlyBackground` confines to the local runtime. `reviewer` is deliberately
 *  not here: a reviewer verdict is about an ACTION the operator is about to take and follows the
 *  chat policy's egress choice. */
export const BACKGROUND_ROLES: ReadonlySet<CanonicalTask> = new Set<CanonicalTask>([
  'extraction',
  'jury',
  'title',
  'embed'
])

/** Within-provider tier preference per role at the 'balanced' speed. The structured roles favour
 *  a fast non-reasoning model (a thinking-on reasoner silently returns 0 JSON on batch
 *  construction — measured, see EXTRACTION_DEFAULT in registry.ts). Reasoner/coder trail the
 *  structured lists so a provider that only ships a reasoner still yields a candidate.
 *  chat/agentic vary with the policy's `speed` — see roleTierOrder. */
export const ROLE_TIER_ORDER: Record<CanonicalTask, ModelDescriptor['tier'][]> = {
  chat: ['pro', 'reasoner', 'flash', 'open', 'coder'],
  agentic: ['pro', 'reasoner', 'flash', 'open', 'coder'],
  extraction: ['flash', 'open', 'pro', 'coder', 'reasoner'],
  reviewer: ['flash', 'open', 'pro', 'coder', 'reasoner'],
  jury: ['flash', 'open', 'pro', 'coder', 'reasoner'],
  title: ['flash', 'open', 'pro', 'coder', 'reasoner'],
  embed: ['flash', 'open', 'pro', 'coder', 'reasoner']
}

/** The chat-side tier orders per speed (roles.ts PolicySpeed). `coder` trails every list. */
const CHAT_TIER_BY_SPEED: Record<PolicySpeed, ModelDescriptor['tier'][]> = {
  fast: ['flash', 'open', 'pro', 'reasoner', 'coder'],
  balanced: ['pro', 'reasoner', 'flash', 'open', 'coder'],
  strong: ['reasoner', 'pro', 'flash', 'open', 'coder']
}

export const POLICY_SPEEDS: readonly PolicySpeed[] = ['fast', 'balanced', 'strong']

/** The stored default and the reading of an absent `speed`: the evaluation's chat pick (L6 §4). */
export const DEFAULT_POLICY_SPEED: PolicySpeed = 'fast'

/** Tier order for a role under a speed. Only chat/agentic move with the speed; the structured
 *  roles keep the cheap-first order whatever the operator prefers for conversation. */
export function roleTierOrder(task: CanonicalTask, speed: PolicySpeed = DEFAULT_POLICY_SPEED): ModelDescriptor['tier'][] {
  if (task === 'chat' || task === 'agentic') return CHAT_TIER_BY_SPEED[speed] ?? CHAT_TIER_BY_SPEED[DEFAULT_POLICY_SPEED]
  return ROLE_TIER_ORDER[task]
}

export function canonicalTask(task: RouteTask | 'code'): CanonicalTask {
  if (task === 'reason') return 'chat'
  if (task === 'code') return 'agentic'
  return task
}

export type ProviderHealthState = 'healthy' | 'unhealthy' | 'unknown'

/** Everything resolution needs, gathered by the binder (registry.ts). Every field is required so
 *  a forgotten seam is a type error, not a silently-empty estate. */
export interface RoleResolverInput {
  policy: ProviderPolicy
  /** Every provider that may be auto-selected, in catalog (PROVIDERS table) order. Hidden
   *  gateways are excluded here and reachable only through a pin. */
  catalogOrder: readonly ProviderId[]
  /** A key is stored (or, for the local runtime, a model is detected). */
  isKeyed: (provider: ProviderId) => boolean
  healthOf: (provider: ProviderId) => ProviderHealthState
  /** Model ids of `provider` for `task` under the policy's speed, best first; [] when it has
   *  none it can call. */
  candidates: (provider: ProviderId, task: CanonicalTask, speed: PolicySpeed) => string[]
  /** Where a pinned model id lives and whether it can be called at all (key present, id known). */
  pinInfo: (modelId: string) => { provider: ProviderId; callable: boolean } | null
}

export interface ResolveRoleOpts {
  /** Explicit per-conversation model id. Wins when callable and not observed-unhealthy. */
  pin?: string
  /** Providers to skip (reviewer: the acting engine's family; jury: the extractor's). */
  avoidProviders?: ReadonlySet<ProviderId>
}

function dedupe<T>(xs: readonly T[]): T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/** Coerce whatever settings.json holds into a valid policy: unknown providers dropped, duplicates
 *  removed, role keys restricted to ROUTE_TASKS, the switch a real boolean, an unknown or absent
 *  speed read as DEFAULT_POLICY_SPEED. Never throws. */
export function normalizeProviderPolicy(raw: unknown, known: readonly ProviderId[]): ProviderPolicy {
  const knownSet = new Set<string>(known)
  const list = (v: unknown): ProviderId[] =>
    Array.isArray(v) ? dedupe(v.filter((p): p is ProviderId => typeof p === 'string' && knownSet.has(p))) : []
  const r = (raw && typeof raw === 'object' ? raw : {}) as {
    order?: unknown
    roles?: unknown
    localOnlyBackground?: unknown
    speed?: unknown
  }
  const roles: Partial<Record<RouteTask, ProviderId[]>> = {}
  if (r.roles && typeof r.roles === 'object') {
    for (const [k, v] of Object.entries(r.roles as Record<string, unknown>)) {
      if ((ROUTE_TASKS as readonly string[]).includes(k)) {
        const ps = list(v)
        if (ps.length) roles[k as RouteTask] = ps
      }
    }
  }
  const speed = (POLICY_SPEEDS as readonly unknown[]).includes(r.speed) ? (r.speed as PolicySpeed) : DEFAULT_POLICY_SPEED
  return { order: list(r.order), roles, localOnlyBackground: r.localOnlyBackground === true, speed }
}

/**
 * The provider walk for a role, BEFORE health: ranked providers first (role override, then the
 * general order), then every other keyed provider in catalog order. `localOnlyBackground`
 * collapses background roles to the local runtime. Unkeyed providers never appear.
 */
export function providerOrderFor(task: CanonicalTask, input: RoleResolverInput): ProviderId[] {
  const { policy } = input
  if (policy.localOnlyBackground && BACKGROUND_ROLES.has(task)) {
    return input.catalogOrder.filter((p) => p === 'ollama' && input.isKeyed(p))
  }
  const override = policy.roles?.[task] ?? (task === 'chat' ? policy.roles?.reason : undefined) ?? []
  const ranked = dedupe([...override, ...policy.order])
  const rest = input.catalogOrder.filter((p) => !ranked.includes(p))
  return dedupe([...ranked, ...rest]).filter((p) => input.isKeyed(p))
}

/** Healthy/unknown providers in order, then the unhealthy ones in order. */
function byHealth(providers: readonly ProviderId[], input: RoleResolverInput): ProviderId[] {
  const open: ProviderId[] = []
  const parked: ProviderId[] = []
  for (const p of providers) (input.healthOf(p) === 'unhealthy' ? parked : open).push(p)
  return [...open, ...parked]
}

/** One model per provider: the role's best candidate. Providers with nothing callable drop out. */
function chainFor(task: CanonicalTask, providers: readonly ProviderId[], input: RoleResolverInput): string[] {
  const out: string[] = []
  const speed = input.policy.speed ?? DEFAULT_POLICY_SPEED
  for (const p of providers) {
    const best = input.candidates(p, task, speed)[0]
    if (best) out.push(best)
  }
  return out
}

/**
 * Resolve one role. Returns null only when NOTHING is callable for it — no keyed provider with a
 * candidate model and no callable pin. A pin that lost to health still rides at the end of the
 * chain, so the failover walk reaches it last rather than never.
 */
export function resolveRoleCore(
  task: RouteTask | 'code',
  input: RoleResolverInput,
  opts: ResolveRoleOpts = {}
): RoleResolution | null {
  const canonical = canonicalTask(task)
  const role: RouteTask = task === 'code' ? 'agentic' : task
  const avoid = opts.avoidProviders ?? new Set<ProviderId>()
  let providers = byHealth(providerOrderFor(canonical, input), input)
  if (avoid.size) {
    const kept = providers.filter((p) => !avoid.has(p))
    // reviewer: skip the acting family only while another candidate exists; jury: strict.
    providers = kept.length || canonical === 'jury' ? kept : providers
  }
  let chain = chainFor(canonical, providers, input)

  const pin = opts.pin?.trim()
  const pinInfo = pin ? input.pinInfo(pin) : null
  if (pin && pinInfo?.callable && !avoid.has(pinInfo.provider)) {
    const rest = chain.filter((id) => id !== pin)
    if (input.healthOf(pinInfo.provider) !== 'unhealthy') {
      return { task: role, modelId: pin, provider: pinInfo.provider, chain: [pin, ...rest], source: 'pin' }
    }
    chain = [...rest, pin]
  }
  if (chain.length === 0) return null
  const head = chain[0]
  const provider = input.pinInfo(head)?.provider ?? providers[0]
  return { task: role, modelId: head, provider, chain, source: 'policy' }
}

/**
 * Up to `n` resolutions from DISTINCT providers that are keyed and NOT observed-unhealthy — the
 * jury never places a doomed call. Fewer than `n` is the honest answer when the estate is thin;
 * the caller records `jury: none` rather than one model wearing three hats.
 */
export function resolveJuryCore(
  n: number,
  input: RoleResolverInput,
  opts: ResolveRoleOpts = {}
): RoleResolution[] {
  const out: RoleResolution[] = []
  if (n <= 0) return out
  const avoid = opts.avoidProviders ?? new Set<ProviderId>()
  for (const p of providerOrderFor('jury', input)) {
    if (out.length >= n) break
    if (avoid.has(p) || input.healthOf(p) === 'unhealthy') continue
    const best = input.candidates(p, 'jury', input.policy.speed ?? DEFAULT_POLICY_SPEED)[0]
    if (!best) continue
    out.push({ task: 'jury', modelId: best, provider: p, chain: [best], source: 'policy' })
  }
  return out
}

// ── The failover WALK (server.ts round loop) — pure hop selection + the exhaustion message ──

export interface FailoverHopInput {
  /** The role's ordered chain (RoleResolution.chain). */
  chain: readonly string[]
  /** Every model id already tried this round. */
  triedModels: ReadonlySet<string>
  providerOf: (modelId: string) => ProviderId
  /** Classified reason the last attempt failed with. */
  reason: ProviderHealthReason
  failedModelId: string
  /** Same-provider alternative for a stale id (registry.routeWithinProvider), or null. */
  withinProvider: () => string | null
}

/**
 * The next engine to try after a classified failure, or null when the chain is exhausted.
 * A stale id (`not-found`) first tries the SAME provider's next catalog id — a single-key operator
 * has no other provider to fail over to. Every account-level reason (no credit, bad key, no
 * access, rate limit, unreachable, 5xx) walks the chain instead, skipping every model already
 * tried and every PROVIDER already tried this round: an account that refused once is not asked
 * again with a different id. Never returns a tried id.
 */
export function nextFailoverHop(input: FailoverHopInput): string | null {
  const triedProviders = new Set<ProviderId>([input.providerOf(input.failedModelId)])
  for (const m of input.triedModels) triedProviders.add(input.providerOf(m))
  const within = input.reason === 'not-found' ? input.withinProvider() : null
  if (within && !input.triedModels.has(within)) return within
  const next = input.chain.find((id) => !input.triedModels.has(id) && !triedProviders.has(input.providerOf(id)))
  return next ?? null
}

export interface FailoverAttempt {
  modelId: string
  reason: ProviderHealthReason
}

/**
 * The RUN_ERROR text when every engine failed: every attempt named with the reason IT failed for
 * (a Claude that ran dry and an OpenAI key without access are two different jobs), then the ONE
 * fix hint for the operator's first preference (fixing that restores the preferred path), then
 * the raw provider text last. Front-loaded on purpose: the renderer truncates this to ~157 chars.
 */
export function exhaustionMessage(attempts: readonly FailoverAttempt[], headProviderLabel: string, lastError: string): string {
  const walk = attempts.map((a) => `${a.modelId} (${a.reason})`).join(' → ')
  const hint = providerFixHint(attempts[0]?.reason ?? 'unknown', headProviderLabel)
  return `No engine could answer (${attempts.length} tried: ${walk}). ${hint} Last error: ${lastError}`
}
