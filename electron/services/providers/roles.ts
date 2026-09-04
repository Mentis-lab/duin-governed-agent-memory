// roles.ts — the P0 model-plane CONTRACT (PLANNING/DUIN_COHESION_BUILD_PLAN_2026-09.md §2.1).
//
// DUIN is model-agnostic by construction: there is no default model. Every place that needs a
// language model asks for a ROLE, and the router resolves the role at call time from the
// operator's provider policy (preference order first, per D2) filtered by live provider HEALTH
// (a real completion, not a key check). The only stored model id is an explicit per-conversation
// pin. This file holds the shared types and channel names so four lanes (router core, callers,
// observability, live-eval) build against one definition. Types only — no runtime imports beyond
// the ProviderId union, so any module may import it without creating a cycle.

import type { ProviderId } from './registry'

/** Every reason a model is asked for. `reason` stays as a chat alias (two legacy callers). */
export type RouteTask =
  | 'chat' // grounded answers to the operator (favour strong models)
  | 'agentic' // tool-heavy turns; may equal chat when no override exists
  | 'extraction' // background comprehension: entity/claim extraction, construction, measure
  | 'reviewer' // action reviewer — prefer a DIFFERENT family from the acting engine
  | 'jury' // govern jury — N DISTINCT healthy families, or honestly none
  | 'title' // cheapest healthy model
  | 'embed' // local embedder; never cloud unless policy allows
  | 'reason' // legacy alias of chat

/** Speed preference for the CHAT-side roles (chat/agentic/reason): which tier of a provider
 *  answers first. 'fast' = flash → open → pro → reasoner (the 2026-09-02 evaluation's pick:
 *  deepseek-v4-flash won on cost and speed with task success tied); 'balanced' = pro → reasoner →
 *  flash → open; 'strong' = reasoner → pro → flash → open. The structured roles
 *  (extraction/title/jury/embed) always take the cheap tier first and ignore this. */
export type PolicySpeed = 'fast' | 'balanced' | 'strong'

/** Operator-authored provider policy. Replaces `defaultModel`, `backgroundModel`, `brainEngine`. */
export interface ProviderPolicy {
  /** Preference order. The primary key of every resolution (D2: user preference is priority). */
  order: ProviderId[]
  /** Optional per-role override of the order (e.g. extraction → ['ollama', 'deepseek']). */
  roles?: Partial<Record<RouteTask, ProviderId[]>>
  /** When true, background roles (extraction/jury/title/embed) never leave the machine. */
  localOnlyBackground?: boolean
  /** Within-provider tier order for chat/agentic. Absent reads as 'fast' (the stored default). */
  speed?: PolicySpeed
}

/** Why a provider is or is not usable right now. Computed from a real completion attempt. */
export type ProviderHealthReason =
  | 'ok'
  | 'no-key'
  | 'no-credit' // balance / quota exhausted (402, 余额不足, credit balance too low …)
  | 'unauthorized' // 401 / invalid key
  | 'model-access' // key valid, project lacks access to the probed model (403 does not have access)
  | 'rate-limit' // 429
  | 'not-found' // model id unknown at the provider
  | 'network' // connect / DNS / timeout
  | 'unknown'

export interface ProviderHealth {
  provider: ProviderId
  healthy: boolean
  reason: ProviderHealthReason
  /** Raw provider text, bounded, for the notice/status detail line. Never a secret. */
  detail?: string
  /** Operator-facing fix hint (`providerFixHint(reason, label)`), computed when the row is made so
   *  the renderer — which cannot import this file (tsconfig.web lists shared files one by one)
   *  — shows it verbatim. '' when healthy. */
  hint: string
  /** The model id the probe used (cheapest catalog model of the provider). */
  probedModelId?: string
  checkedAt: number
  /** ms the probe took; informational. */
  latencyMs?: number
}

/** The router's answer for one role. `chain` is the ordered fallback list it will walk. */
export interface RoleResolution {
  task: RouteTask
  modelId: string
  provider: ProviderId
  /** Full ordered candidate list (model ids) for failover; index 0 === modelId. */
  chain: string[]
  /** 'pin' when an explicit per-conversation pin won; 'policy' otherwise. */
  source: 'pin' | 'policy'
}

/** Classified provider error — the ONE shape the failover branch, the notices and the UI read. */
export interface ClassifiedProviderError {
  reason: ProviderHealthReason
  provider: ProviderId
  modelId?: string
  status?: number
  /** Bounded raw message for the transcript notice. */
  detail: string
  /** Operator-facing fix hint, e.g. "Top up DeepSeek credit" / "Grant the key access to gpt-5.5". */
  hint: string
}

/**
 * Bench / evaluation traffic marker (D3). A `/agui` turn carrying this header — accepted ONLY when
 * the exec token is also present — runs with learning, taste capture and turn-beats OFF and is
 * tagged `bench: true` in its journal. The live-eval suite sends it on every turn so an evaluation
 * can never teach the operator model again (2026-09-02 S7).
 */
export const BENCH_HEADER = 'x-duin-bench'

/** Is this `/agui` request bench traffic? True only when the header is exactly '1' AND the caller
 *  already passed the exec-token gate — an unauthenticated caller cannot mark its turn exempt from
 *  learning (that would be a way to talk to the operator's DUIN without teaching it, which is not
 *  the operator's choice to hand out). Header lookup is by the lowercase name Node exposes. */
export function isBenchRequest(headers: Record<string, unknown>, execOk: boolean): boolean {
  if (!execOk) return false
  const v = headers[BENCH_HEADER]
  return v === '1' || (Array.isArray(v) && v[0] === '1')
}

/** IPC channel names (main ↔ renderer). Lane A implements, lanes B/C consume. */
export const MODEL_IPC = {
  policyGet: 'model:policy:get', // () → ProviderPolicy
  policySet: 'model:policy:set', // (Partial<ProviderPolicy>) → ProviderPolicy
  healthList: 'model:health:list', // () → ProviderHealth[] (cached, may be stale)
  healthProbe: 'model:health:probe', // (providerId | 'all') → ProviderHealth[] (fresh)
  resolve: 'model:resolve', // (task: RouteTask, pin?: string) → RoleResolution | null
  healthChanged: 'model:health-changed' // push event, payload ProviderHealth[]
} as const

/** Event-spine payload for a classified failure on any role (emitted by the router; consumed by the
 *  failure → notice watcher). Type name on the spine stays `model.request.failed`. */
export interface ModelFailurePayload {
  role: RouteTask
  provider: ProviderId
  modelId: string
  reason: ProviderHealthReason
  detail?: string
  /** true when the failover walked to another candidate; false when the turn hard-failed. */
  recovered: boolean
  nextModelId?: string
}

/** Settings key that replaces defaultModel/backgroundModel/brainEngine. */
export const PROVIDER_POLICY_SETTING = 'providerPolicy' as const

/** Sentinel written into `conversations.model` (and accepted by `/agui` `model`) meaning "no pin —
 *  resolve the chat role from policy". Kept as the existing `duin-brain` connector id so old rows
 *  keep their meaning. */
export const AUTO_ENGINE = 'duin-brain' as const

/** Reason → operator hint. One place, used by the transcript notice, Needs-you and Status. */
export function providerFixHint(reason: ProviderHealthReason, providerLabel: string): string {
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
    default:
      return `${providerLabel} failed for an unclassified reason. See Status → Engine for the detail.`
  }
}
