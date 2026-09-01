import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import { existsSync, readFileSync } from 'fs'
// F3 (prefill-cache): Anthropic-via-OpenRouter needs EXPLICIT cache breakpoints; every other
// provider caches on a stable prefix automatically. No-op for non-Anthropic model ids.
import { withPrefillCacheMarkers } from './prefill-cache'
import {
  cacheSignalTracker,
  normalizeUsage,
  providerStreamsUsage,
  sortToolsStable,
  type NormalizedUsage
} from './usage-accounting'
import { isBalanceError, isQuotaError } from './quota-error'
import {
  availableProviders,
  isProviderCoolingDown,
  noteProviderRefusal,
  noteProviderSuccess
} from './provider-health'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getKey } from '../keychain'
import { readSettings } from '../settings-helper'
import { boundedJsonPreview, recordEvent } from '../event-log'
import { trace } from '../debug-trace'
import { messageOf } from '../guarded'
import { stripAnsi } from '../../shared/strip-ansi'

// T1 — SSE inactivity watchdog. Some providers (notably DeepSeek under load
// and OpenRouter when routing through a stalled upstream) silently leave the
// SSE socket half-open: no chunks, no FIN, no error. The `for await` loop
// below would otherwise wait forever. We race each chunk-await against a
// timer and abort the underlying HTTP request on expiry; the throw lands in
// the existing partial-persist + retry path so the user's on-screen content
// is preserved and a flaky provider gets the same retry treatment as a 429.
export class StreamInactivityError extends Error {
  constructor(public readonly inactivityMs: number) {
    super(`Stream stalled — provider sent no chunks for ${Math.round(inactivityMs / 1000)}s.`)
    this.name = 'StreamInactivityError'
  }
}

// A throw that originated in a CALLER callback (onChunk / onReasoning), not in
// the provider stream. It must be routed to a single terminal onError WITHOUT
// retrying: re-issuing the LLM request cannot fix a renderer-side bug and only
// duplicates billing + side effects. The `cause` carries the original error so
// the message is preserved for the user/audit.
class CallbackError extends Error {
  constructor(public readonly cause: unknown) {
    super(messageOf(cause) || 'Response streaming callback failed')
    this.name = 'CallbackError'
  }
}

const DEFAULT_STREAM_INACTIVITY_MS = 60_000
const MIN_STREAM_INACTIVITY_MS = 5_000

// R1 — output-runaway guards. 39/42 catalog models set no defaultMaxTokens, so
// chatStream used to send NO max_tokens and generation ran unbounded (observed
// 4600+ chunks); the inactivity watchdog re-arms on every chunk so a steady
// char-by-char stream never trips it. DEFAULT_OUTPUT_TOKENS is the always-sent
// output floor when neither caller nor catalog specifies one; MAX_OUTPUT_CHARS
// (~100k tokens) is the hard streaming backstop for a provider that ignores
// max_tokens or streams unbounded reasoning. Both env-tunable so the cap can be
// raised without a code change — never a silent hardcode.
const DEFAULT_OUTPUT_TOKENS = Number(process.env.DUIN_MAX_OUTPUT_TOKENS) || 8192 // signal-lint-ignore: a 0-token cap would make every completion empty
/** Explicit operator override. `undefined` when unset, so it can OUTRANK a catalog default
 *  without an unset env silently pinning every model to the 8192 floor. */
const ENV_OUTPUT_TOKENS: number | undefined = (() => {
  const raw = Number(process.env.DUIN_MAX_OUTPUT_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined
})()
const MAX_OUTPUT_CHARS = Number(process.env.DUIN_MAX_OUTPUT_CHARS) || 400_000 // signal-lint-ignore: a 0-char ceiling would truncate every response to nothing

// Test hook: setting this overrides the settings.json value for the duration
// of the test. Cleared by setting back to null.
let streamInactivityOverrideMs: number | null = null
export function __setStreamInactivityForTesting(ms: number | null): void {
  streamInactivityOverrideMs = ms
}

// Injected by main.ts during boot so we can read settings.json without an
// electron import in test contexts. Tests leave it null and use the override.
let userDataPathProvider: (() => string) | null = null
export function setUserDataPathProvider(fn: (() => string) | null): void {
  userDataPathProvider = fn
}

// ── Custom / imported models (settings.customModels) ──
// User-added models: hand-entered (model:addCustom) or bulk "Import live models"
// (model:importLive → buildLiveModelImports). resolveModel MUST consult these so
// an imported id for a UA provider (groq/mistral/moonshot/github-models/deepinfra)
// resolves to its REAL provider + wire id. Without this every imported id misses
// the catalog and falls through to the deepseek fallback below — chat is then
// routed to DeepSeek (wrong provider/key, or a model_not_found on api.deepseek.com).
export interface CustomModelRecord {
  id: string
  name?: string
  /** The provider chosen at add/import time. resolveModel routes on this. */
  provider?: ProviderId
  /** The verbatim wire id sent in the request `model` field. Falls back to `id`
   *  when absent (hand-added models use the id as the wire id; collision-namespaced
   *  imports persist a distinct apiModelId). */
  apiModelId?: string
  contextWindow?: number
  supportsTools?: boolean
  supportsVision?: boolean
}

// Test hook: overrides the settings.json read for the duration of a test, so
// resolveModel's custom-model routing can be exercised without touching disk.
// Cleared by passing null. Mirrors __setStreamInactivityForTesting.
let customModelsOverride: CustomModelRecord[] | null = null
export function __setCustomModelsForTesting(models: CustomModelRecord[] | null): void {
  customModelsOverride = models
}

/** The user's persisted custom/imported models from settings.json. Empty when
 *  no path provider is wired (test/stand-alone contexts) or on any read/parse
 *  error — resolveModel then keeps its prior behavior for that id. */
function readCustomModels(): CustomModelRecord[] {
  if (customModelsOverride !== null) return customModelsOverride
  if (!userDataPathProvider) return []
  try {
    const path = join(userDataPathProvider(), 'settings.json')
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { customModels?: unknown }
    if (!Array.isArray(raw.customModels)) return []
    return raw.customModels.filter(
      (m): m is CustomModelRecord =>
        !!m && typeof (m as { id?: unknown }).id === 'string'
    )
  } catch {
    return []
  }
}

export function readStreamInactivityMs(): number {
  if (streamInactivityOverrideMs !== null) return streamInactivityOverrideMs
  if (!userDataPathProvider) return DEFAULT_STREAM_INACTIVITY_MS
  try {
    const path = join(userDataPathProvider(), 'settings.json')
    if (!existsSync(path)) return DEFAULT_STREAM_INACTIVITY_MS
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { streamInactivityMs?: unknown }
    const ms = raw.streamInactivityMs
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_STREAM_INACTIVITY_MS
    if (ms <= 0) return 0 // 0 disables the watchdog entirely
    return Math.max(MIN_STREAM_INACTIVITY_MS, ms)
  } catch {
    return DEFAULT_STREAM_INACTIVITY_MS
  }
}

export type ProviderId =
  | 'deepseek'
  | 'google'
  | 'dashscope'
  | 'openrouter'
  | 'zhipu'
  | 'moonshot'
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'ollama'
  | 'oneai'
  // ── UA (provider-expansion) additions ──
  // OpenAI-compatible providers reachable through the shared client. Each ships
  // with ZERO pinned catalog models by design — their rosters move fast, so the
  // user pulls the live list via Settings → Models → "Import live models"
  // (listLiveModelIds) or hand-adds Custom Models. keyEnv === id for every one.
  | 'groq'
  | 'mistral'
  // NOTE: moonshot is deliberately NOT re-listed here — it is already a member
  // above, since DUIN shipped it natively before the UA port also declared it.
  // A duplicate union member is legal TS and invisible to tsc, but provider-parity
  // asserts this union is member-identical to the PROVIDERS table. Keep this
  // comment free of single-quoted tokens: that test scrapes the whole declaration
  // block for quoted identifiers, so a quoted name here would read as a member.
  | 'github-models'
  | 'deepinfra'

// ── Claude / Anthropic — first-class, via the official OpenAI-compat layer ──
// The paragraph that used to live here declared the direct path impossible
// without a dedicated Messages-API adapter. That was true when written and is
// FALSE now: Anthropic ships an official OpenAI SDK compatibility layer at
// https://api.anthropic.com/v1/ (verified against
// platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk on
// 2026-08-21) — streaming, tool calls, parallel tool calls, and image_url
// vision are all listed "Fully supported", with Claude model names passed
// straight through. So the anthropic provider flows through the shared
// getClientForProvider with zero adapter, like every other entry.
//
// Known limits of the compat layer, so nobody re-diagnoses them as bugs:
// temperature is capped at 1 server-side; reasoning_effort is ignored (Claude
// 5 models think adaptively by default and the compat layer does not stream
// the thinking channel back — answers arrive after an unlabelled pause);
// prompt caching and structured outputs need the native SDK. Anthropic frames
// the layer as an evaluation surface, so the upgrade path if we ever need
// caching or visible thinking is the adapter the old comment described:
// add the official SDK package, an anthropic-adapter.ts mapping Messages-API
// streaming onto ChatStreamCallbacks, and branch in getClientForProvider.

// How Settings → Models discovers a provider's CURRENT live chat catalog for
// the "import live models" affordance (buildLiveModelImports). Adapted from the
// upstream provider-expansion machinery:
//   - 'openai'      → the standard OpenAI SDK `GET /v1/models` shape ({data:[…]}).
//                     The default when a descriptor omits `catalog`.
//   - 'url'         → a non-SDK GET against an explicit URL. `format` selects the
//                     response shape: 'openai' ({data:[{id}]}), 'array' (a bare
//                     [{id}] array, e.g. GitHub Models' /catalog/models), or
//                     'deepinfra' (DeepInfra's /models/list, filtered to live
//                     text-generation ids on `model_name`). `auth` picks the
//                     header ('bearer' | 'x-api-key' | 'none').
//   - 'unsupported' → the provider exposes no machine-readable chat catalog;
//                     listLiveModelIds throws ModelCatalogUnsupportedError and the
//                     UI falls back to hand-added Custom Models.
export type ModelCatalogStrategy =
  | { kind: 'openai' }
  | {
      kind: 'url'
      url: string
      format: 'openai' | 'array' | 'deepinfra'
      auth: 'bearer' | 'x-api-key' | 'none'
    }
  | { kind: 'unsupported' }

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  baseURL: string
  keyEnv: string
  docsUrl: string
  /** No API key required (local runtimes such as Ollama). The OpenAI SDK rejects
   *  an empty key, so a placeholder is sent when none is stored; a stored key
   *  still wins for proxies that gate on a real bearer token. */
  keyOptional?: boolean
  /** Key-format hint rendered as the Settings → API Keys input placeholder
   *  (e.g. "sk-..."). Purely cosmetic. */
  keyHint?: string
  /** How Settings → Models discovers this provider's live chat catalog.
   *  Omitted ⇒ the normal OpenAI SDK `GET /v1/models` shape (kind 'openai'). */
  catalog?: ModelCatalogStrategy
  /** The provider is a local/self-hosted gateway whose base address should be
   *  editable in Settings without hand-editing settings.json. */
  baseUrlConfigurable?: boolean
  /** Kept in the table so its models still resolve, but never listed as a vendor the
   *  user could pick or key. For operator-only gateways that exist to serve benchmark
   *  tooling — listing them just asks the user to reason about infrastructure that
   *  isn't theirs. */
  hidden?: boolean
}

/** Neutral placeholder host for the OneAI gateway. Deliberately non-resolving: the real
 *  endpoint is operator infrastructure and must not ship inside the binary (see the
 *  operator-leak denylist). Override with DUIN_ONEAI_BASE_URL / DUIN_ONEAI_DOCS_URL. */
const ONEAI_PLACEHOLDER_HOST = 'https://oneai-gw-api.vendorco.com'
const ONEAI_BASE_URL = process.env.DUIN_ONEAI_BASE_URL || `${ONEAI_PLACEHOLDER_HOST}/v1`
const ONEAI_DOCS_URL = process.env.DUIN_ONEAI_DOCS_URL || ONEAI_PLACEHOLDER_HOST

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    keyEnv: 'deepseek',
    docsUrl: 'https://platform.deepseek.com/api_keys'
  },
  google: {
    id: 'google',
    label: 'Google AI (Gemini · Gemma)',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keyEnv: 'google',
    docsUrl: 'https://aistudio.google.com/app/apikey'
  },
  dashscope: {
    id: 'dashscope',
    label: 'Alibaba DashScope (Qwen)',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'dashscope',
    docsUrl: 'https://dashscope.console.aliyun.com/apiKey'
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter (multi-model)',
    baseURL: 'https://openrouter.ai/api/v1',
    keyEnv: 'openrouter',
    docsUrl: 'https://openrouter.ai/keys'
  },
  zhipu: {
    id: 'zhipu',
    label: 'Zhipu AI (GLM)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    keyEnv: 'zhipu',
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  // Moonshot AI (Kimi) — OpenAI-compatible endpoint, routes through the shared
  // OpenAI client with no adapter. Global endpoint (api.moonshot.ai); CN users
  // can paste api.moonshot.cn ids via Custom Models. Keys: platform.kimi.ai.
  // (Kimi rebrand 2026: console moved to platform.kimi.ai, API host stays
  // api.moonshot.ai.) keyHint comes from the UA provider-expansion port, which
  // re-declared an otherwise-identical moonshot entry further down the object.
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot AI (Kimi)',
    baseURL: 'https://api.moonshot.ai/v1',
    keyEnv: 'moonshot',
    docsUrl: 'https://platform.kimi.ai/console/api-keys',
    keyHint: 'sk-...'
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    keyEnv: 'openai',
    docsUrl: 'https://platform.openai.com/api-keys'
  },
  // Anthropic (Claude) — via the official OpenAI-compat layer (see the block
  // comment above the PROVIDERS table). The native models list needs the
  // anthropic-version header, which the live-import fetcher does not send, so
  // live import is marked unsupported — the pinned catalog + Custom Models
  // cover it.
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseURL: 'https://api.anthropic.com/v1/',
    keyEnv: 'anthropic',
    docsUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-...',
    catalog: { kind: 'unsupported' }
  },
  // xAI (Grok) is OpenAI-compatible — its /v1 endpoint speaks the same wire
  // protocol, so it flows through the shared OpenAI client in
  // getClientForProvider with NO adapter.
  xai: {
    id: 'xai',
    label: 'xAI (Grok)',
    baseURL: 'https://api.x.ai/v1',
    keyEnv: 'xai',
    docsUrl: 'https://console.x.ai/'
  },
  // Local Ollama — keyless. Auto-detected at :11434; its OpenAI-compatible
  // endpoint is /v1. No API key (a dummy is sent). Turnkey path so chat +
  // notes-extraction work with zero key / zero cost for anyone running Ollama.
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURL: 'http://127.0.0.1:11434/v1',
    keyEnv: 'ollama',
    docsUrl: 'https://ollama.com'
  },
  // OneAI gateway — an OpenAI-compatible (/chat/completions verified) gateway used for
  // benchmark harnesses that answer + adjudicate on the SAME base model.
  //
  // The host is OPERATOR INFRASTRUCTURE, not a public service, so it must not be baked into
  // a distributable binary: the shipped default is a neutral placeholder that deliberately
  // does not resolve, and the real endpoint comes from DUIN_ONEAI_BASE_URL. Hardcoding a
  // private host here would both leak whose it is (the operator-leak scan denylists it) and
  // ship a dead URL to everyone else. Set the env var and this provider works as before.
  oneai: {
    id: 'oneai',
    label: 'OneAI Gateway',
    baseURL: ONEAI_BASE_URL,
    keyEnv: 'oneai',
    docsUrl: ONEAI_DOCS_URL,
    hidden: true
  },
  // ── UA provider-expansion machinery: additive breadth ──
  // All OpenAI-compatible → they flow through the shared getClientForProvider
  // with no adapter. Each ships ZERO pinned MODEL_CATALOG entries on purpose
  // (fast-moving rosters); the user imports the live list via Settings → Models
  // (listLiveModelIds) or hand-adds Custom Models. keyEnv === id everywhere.
  groq: {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    keyEnv: 'groq',
    docsUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_...'
    // catalog omitted → standard OpenAI /v1/models (kind 'openai')
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    keyEnv: 'mistral',
    docsUrl: 'https://console.mistral.ai/api-keys'
  },
  // (moonshot is declared above with the DUIN-native providers — the UA port's
  // duplicate entry was folded into it, keyHint included.)
  // GitHub Models — chat inference is OpenAI-compatible at /inference, but the
  // live catalog lives at a SEPARATE, non-SDK endpoint returning a BARE array.
  'github-models': {
    id: 'github-models',
    label: 'GitHub Models',
    baseURL: 'https://models.github.ai/inference',
    keyEnv: 'github-models',
    docsUrl: 'https://github.com/settings/personal-access-tokens',
    keyHint: 'github_pat_...',
    catalog: {
      kind: 'url',
      url: 'https://models.github.ai/catalog/models',
      format: 'array',
      auth: 'bearer'
    }
  },
  // DeepInfra — OpenAI-compatible chat, but its live roster is a bare array at
  // /models/list keyed on `model_name`, filtered to live text-generation ids.
  deepinfra: {
    id: 'deepinfra',
    label: 'DeepInfra',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    keyEnv: 'deepinfra',
    docsUrl: 'https://deepinfra.com/dash/api_keys',
    catalog: {
      kind: 'url',
      url: 'https://api.deepinfra.com/models/list',
      format: 'deepinfra',
      auth: 'none'
    }
  }
}

export interface ModelDescriptor {
  id: string
  name: string
  provider: ProviderId
  apiModelId: string
  contextWindow: number
  supportsTools: boolean
  supportsVision: boolean
  isReasoner?: boolean
  /** When set, sent as `max_tokens` when the caller doesn't provide one.
   *  Prevents reasoning models from exhausting their output budget on
   *  chain-of-thought before emitting tool-call parameters. */
  defaultMaxTokens?: number
  /** When true AND tools are offered in the request, send
   *  `reasoning_effort: 'low'` to cap chain-of-thought token consumption
   *  so the content/tool-call portion of the output has room. */
  reasoningCapOnToolUse?: boolean
  /** When true, send Zhipu's `thinking: {type: 'disabled'}` so a hybrid GLM (4.5/4.6)
   *  emits the answer directly instead of "thinking" first. Required for batch-JSON
   *  extraction: with thinking ON these models fill `reasoning_content` and leave
   *  `content` empty/truncated (finish_reason:'length'). Zhipu-only. */
  disableThinking?: boolean
  tier: 'pro' | 'flash' | 'open' | 'coder' | 'reasoner'
  description: string
  /** Internal routing target, not a user-pickable "model". The DUIN brain is a
   *  layer (grounding/tools/governance over an LLM), not an LLM choice — it stays
   *  the default but the model picker should hide entries with this set. */
  internal?: boolean
  /** Resolvable by id but never offered in a picker. For entries that exist to serve
   *  operator tooling (benchmark harnesses pinning a specific base model) rather than
   *  to be chosen: the id keeps working, the name stops being noise in the UI.
   *  Distinct from `internal`, which renders as the "Auto" brain entry. */
  hidden?: boolean
}

// Each `apiModelId` is sent verbatim in the `model` field of the request to
// that provider's published API. These IDs come from each provider's docs
// and the OpenRouter live /v1/models response captured during development;
// they are NOT guaranteed to still be live. Use Settings -> Models ->
// "Verify against providers" to check every entry against the provider's
// current /v1/models list with your stored key.
export const MODEL_CATALOG: ModelDescriptor[] = [
  {
    // Routes to the configured external agent/DUIN brain (an AG-UI server, default
    // @ :8765/agui) via the duin-bridge adapter; chat:send branches on this id BEFORE
    // any provider dispatch, so the `provider` field is cosmetic (never used to call an
    // API). The brain owns grounding/tools/governance.
    id: 'duin-brain',
    name: 'DUIN brain',
    internal: true,
    provider: 'deepseek',
    apiModelId: 'duin-brain',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: false,
    tier: 'pro',
    description:
      'DUIN\'s own brain — grounded in your knowledge and governed. Uses the built-in local brain, or a connected brain (AG-UI endpoint) when configured.'
  },

  // ── Anthropic (Claude) — 2026-08-21 catalog redo ──
  // First-class provider via the official OpenAI-compat layer (see the block comment
  // above the PROVIDERS table). Model ids verified against the claude-api reference
  // 2026-08-21; ids are complete as-is — NEVER append date suffixes. No effort flags:
  // the compat layer ignores reasoning_effort (Claude 5 thinks adaptively by default),
  // so offering an effort toggle here would be a control wired to nothing.
  {
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    provider: 'anthropic',
    apiModelId: 'claude-fable-5',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'reasoner',
    description:
      'Anthropic\'s most capable generally available model — deepest reasoning and long-horizon agentic work. 1M context, 128K max output. Requires an org on 30-day data retention.'
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'anthropic',
    apiModelId: 'claude-opus-5',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Anthropic flagship — top-tier reasoning with adaptive thinking, tools + vision, 1M context.'
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    apiModelId: 'claude-sonnet-5',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Balanced Claude — near-flagship quality at lower cost, tools + vision, 1M context.'
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    apiModelId: 'claude-haiku-4-5',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'Fast, low-cost Claude — high-volume and latency-sensitive work, tools + vision, 200K context.'
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    apiModelId: 'claude-opus-4-8',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Previous-generation Opus — still fully supported; same 1M context and price tier as Opus 5.'
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModelId: 'claude-sonnet-4-6',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'Previous-generation Sonnet — proven workhorse, tools + vision, 1M context.'
  },

  // ── OpenAI — 2026-08-21 catalog redo ──
  // Current family is GPT-5.6 (Sol > Terra > Luna) + GPT-5.5; verified against
  // developers.openai.com model pages 2026-08-21. Everything older (gpt-4o, gpt-4.1,
  // o-series, gpt-5.0/5.1/5.2) is deprecated or already retired — see RETIRED_MODEL_MAP.
  // gpt-5.5-pro and gpt-5.3-codex are deliberately ABSENT: their model pages state
  // Chat Completions "Not supported" (Responses API only), and this app streams via
  // chat.completions. NO effort flags on the 5.6 family: function tools combined with
  // reasoning_effort are rejected on gpt-5.6-sol via /v1/chat/completions (community-
  // verified error string, consistent with OpenAI steering reasoning+tools to the
  // Responses API) — so we never send reasoning_effort to these models.
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'openai',
    apiModelId: 'gpt-5.6-sol',
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsVision: true,
    tier: 'pro',
    description:
      'OpenAI frontier flagship — top of the GPT-5.6 family (Sol > Terra > Luna). ~1.05M context, 128K max output, tools + vision. The `gpt-5.6` alias routes here.'
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'openai',
    apiModelId: 'gpt-5.6-terra',
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsVision: true,
    tier: 'flash',
    description: 'Balanced GPT-5.6 tier (mini-class) — strong intelligence at 40% of Sol\'s price, tools + vision.'
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'openai',
    apiModelId: 'gpt-5.6-luna',
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsVision: true,
    tier: 'flash',
    description: 'Fast/cheap GPT-5.6 tier (nano-class) — high-volume work at ~4% of Sol\'s price, tools + vision.'
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai',
    apiModelId: 'gpt-5.5',
    contextWindow: 1_050_000,
    supportsTools: true,
    supportsVision: true,
    tier: 'pro',
    description: 'Previous OpenAI flagship — still active and streaming-confirmed on Chat Completions.'
  },

  // ── DeepSeek — verified current 2026-08-21 (serving V4-Pro-0813 / V4-Flash-0731) ──
  // The V4 ids auto-track the latest serving version. deepseek-chat/-reasoner were
  // fully retired 2026-07-24. Thinking is ON by default on both; the flash entry
  // disables it for clean extraction JSON (see disableThinking).
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    apiModelId: 'deepseek-v4-pro',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    reasoningCapOnToolUse: true,
    tier: 'pro',
    description: 'Flagship DeepSeek V4 — high-performance reasoning + agentic tool use, 1M context, 384K max output.'
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    apiModelId: 'deepseek-v4-flash',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    reasoningCapOnToolUse: true,
    disableThinking: true, // hybrid V4: thinks by default → send thinking:{type:'disabled'} for clean extraction JSON
    tier: 'flash',
    description: 'Fast DeepSeek V4 — a third of Pro\'s price, same 1M context; thinking and non-thinking modes.'
  },

  // ── Moonshot AI (Kimi) — 2026-08-21 catalog redo ──
  // Verified against platform.kimi.ai 2026-08-21. The entire kimi-k2-*/kimi-latest/
  // moonshot-v1-* estate is discontinued (moonshot-v1 + k2.5 sunset 2026-08-31) — see
  // RETIRED_MODEL_MAP. K3 pins its own sampling (temperature locked server-side).
  {
    id: 'kimi-k3',
    name: 'Kimi K3',
    provider: 'moonshot',
    apiModelId: 'kimi-k3',
    contextWindow: 1_048_576,
    supportsTools: true,
    supportsVision: true,
    isReasoner: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description:
      'Moonshot flagship — thinking always on (reasoning_effort low/high/max, default max), 1M context, tools + vision + video.'
  },
  {
    id: 'kimi-k2.6',
    name: 'Kimi K2.6',
    provider: 'moonshot',
    apiModelId: 'kimi-k2.6',
    contextWindow: 262_144,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'Balanced Kimi daily driver — toggleable thinking, 256K context, tools + vision.'
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code',
    provider: 'moonshot',
    apiModelId: 'kimi-k2.7-code',
    contextWindow: 262_144,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'coder',
    description: 'Dedicated Kimi coding model — mandatory thinking, 256K context, tools + vision.'
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    name: 'Kimi K2.7 Code High-Speed',
    provider: 'moonshot',
    apiModelId: 'kimi-k2.7-code-highspeed',
    contextWindow: 262_144,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'coder',
    description: 'Same K2.7 Code weights served at ~180 tok/s (up to 260) — double the price, for latency-critical coding.'
  },

  // ── Zhipu AI (GLM) — 2026-08-21 catalog redo ──
  // Verified against docs.bigmodel.cn + docs.z.ai 2026-08-21. Flagship is GLM-5.3
  // (thinking cannot be disabled); glm-4.5*/glm-4.6/glm-4v are legacy — see
  // RETIRED_MODEL_MAP. Same ids serve on both the CN endpoint (configured here)
  // and intl api.z.ai.
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    provider: 'zhipu',
    apiModelId: 'glm-5.3',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false,
    isReasoner: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description:
      'Zhipu flagship — SOTA agentic/SWE performance, thinking always on (effort low/high/max), 1M context.'
  },
  {
    // GLM-5.3-Flash — the open-weight (MIT, 320B-A18B) sibling of the flagship, natively
    // multimodal, 1M context. This is the model OpenRouter previewed as the stealth
    // 'ox-alpha' slot (Z.ai's launch note says so); that pin is retired onto this id in
    // RETIRED_MODEL_MAP. Verified 2026-08-26 against docs.bigmodel.cn (the CN endpoint
    // configured here) and docs.z.ai: same id on both, and "thinking.type only supports
    // enabled" — thinking cannot be disabled, so no disableThinking flag, and the output
    // cap exists for the same reason as glm-5.3's.
    //
    // Tier 'pro', not 'flash', on purpose: tier drives AUTOMATIC routing, and a
    // thinking-mandatory model must not become the cheap/extraction pick (glm-5-turbo
    // and glm-4.7-flashx keep that role). Listed after glm-5.3 so every existing
    // automatic pick — chat/pro → glm-5.3, extraction → glm-4.7-flashx — is unchanged;
    // this entry is reachable from the picker, which is what was asked for.
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    provider: 'zhipu',
    apiModelId: 'glm-5.3-flash',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    isReasoner: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description:
      'Open-weight GLM-5.3 sibling (320B-A18B, MIT) — near-flagship quality at a lower price, natively multimodal (text/image/video), thinking always on, 1M context. Previewed on OpenRouter as Ox Alpha.'
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    provider: 'zhipu',
    apiModelId: 'glm-5-turbo',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'High-throughput GLM-5 agent workhorse — 200K context, near-flagship quality.'
  },
  {
    id: 'glm-4.7',
    name: 'GLM-4.7',
    provider: 'zhipu',
    apiModelId: 'glm-4.7',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    tier: 'coder',
    description: 'Value GLM tier tuned for agentic coding — interleaved/preserved thinking modes, 200K context.'
  },
  {
    id: 'glm-4.7-flashx',
    name: 'GLM-4.7-FlashX',
    provider: 'zhipu',
    apiModelId: 'glm-4.7-flashx',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    disableThinking: true, // hybrid: send thinking:{type:'disabled'} so extraction gets the answer, not reasoning_content
    tier: 'flash',
    description: 'Fast/cheap GLM — the extraction and high-volume tier (glm-4.7-flash is its free sibling).'
  },
  {
    id: 'glm-5v-turbo',
    name: 'GLM-5V-Turbo',
    provider: 'zhipu',
    apiModelId: 'glm-5v-turbo',
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Multimodal GLM flagship — image/video/file understanding with agentic tool use.'
  },

  // ── Alibaba Qwen (DashScope) — 2026-08-21 catalog redo ──
  // Verified against help.aliyun.com Model Studio 2026-08-21. Current top set is
  // qwen3.8-max + qwen3.8-flash (added 2026-08-27, the day after its release) +
  // the qwen3.7 line (natively multimodal) + the coder line; the
  // qwen3.5/qwen3-max entries this catalog used to pin are still sold but
  // superseded — see RETIRED_MODEL_MAP. Ids serve on both CN and intl
  // compatible-mode endpoints.
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8-Max',
    provider: 'dashscope',
    apiModelId: 'qwen3.8-max',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Alibaba flagship — natively multimodal (image+video), toggleable thinking, 1M context, 128K max output.'
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus',
    provider: 'dashscope',
    apiModelId: 'qwen3.7-plus',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Balanced Qwen — multimodal, 1M context at a sixth of Max\'s price.'
  },
  {
    id: 'qwen3.7-flash',
    name: 'Qwen3.7-Flash',
    provider: 'dashscope',
    apiModelId: 'qwen3.7-flash',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    disableThinking: true, // qwen3.7 thinks by default → enable_thinking:false for clean extraction JSON
    tier: 'flash',
    description: 'Fast/cheap Qwen — multimodal agent tier with 1M context; the extraction workhorse.'
  },
  {
    // Qwen3.8-Flash — released 2026-08-26 evening, added 2026-08-27 on operator order.
    // Verified 2026-08-27 against the qianwenai.com (CN) and qwencloud.com (intl) model
    // cards, the two faces of the DashScope compatible-mode endpoint configured here:
    // wire id qwen3.8-flash on both, 1M context (991K max input, 131K max output),
    // text/image/video input, function calling, ¥1/¥3 per M CN ($0.16/$0.47 intl).
    // Thinking is OFF by default on this model — the reverse of the qwen3.7 line —
    // and toggled by the same `enable_thinking` flag. disableThinking pins it off on
    // the wire anyway: the qwen3→qwen3.5 generation flipped that default ON upstream
    // (and 3.8-max still ships ON), and a repeat must not silently turn the flash tier
    // into a reasoner that returns 0 JSON on batch extraction.
    //
    // Listed after qwen3.7-flash so every existing automatic pick is unchanged:
    // extraction stays qwen3.7-flash (EXTRACTION_DEFAULT, and cheaper below 32K input
    // at ¥0.2/¥0.8), chat/pro stays qwen3.8-max. This entry is reachable from the
    // picker, which is what was asked for.
    id: 'qwen3.8-flash',
    name: 'Qwen3.8-Flash',
    provider: 'dashscope',
    apiModelId: 'qwen3.8-flash',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    disableThinking: true, // off by default upstream; pinned so a provider-side default flip cannot make the flash tier think
    tier: 'flash',
    description:
      'Newest fast Qwen — multimodal MoE (text/image/video) at flash price, 1M context, 131K max output, thinking off by default.'
  },
  {
    id: 'qwen3-coder-next',
    name: 'Qwen3-Coder-Next',
    provider: 'dashscope',
    apiModelId: 'qwen3-coder-next',
    contextWindow: 262_144,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    tier: 'coder',
    description:
      'Newest Qwen coder — near Coder-Plus quality at a fraction of the price, 256K context. (Docs conflict on tool support; the coder guide demos tool calls — verify live.)'
  },
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3-Coder-Plus',
    provider: 'dashscope',
    apiModelId: 'qwen3-coder-plus',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: false,
    defaultMaxTokens: 16_384,
    tier: 'coder',
    description: 'Big-context Qwen coder — 1M context for whole-repo work.'
  },
  {
    id: 'qwen-long',
    name: 'Qwen-Long',
    provider: 'dashscope',
    apiModelId: 'qwen-long',
    contextWindow: 10_000_000,
    supportsTools: false,
    supportsVision: false,
    tier: 'open',
    description: 'Extreme-context document QA (10M tokens) — no function calling; for reading, not agency.'
  },

  // ── Google (Gemini + Gemma) — Gemini added 2026-08-21 on operator request ──
  // Same AI Studio OpenAI-compat endpoint and key as the Gemma entries. Lineup
  // verified against ai.google.dev/gemini-api/docs/models 2026-08-21: the
  // Gemini 3 family is current (1M context, 64K output cap); 3.1 Pro's id
  // still carries the -preview suffix upstream; 2.5 Pro is the proven
  // prior-gen fallback. Every entry thinks by default → same 16_384 output
  // headroom as the other thinking-by-default families.
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    provider: 'google',
    apiModelId: 'gemini-3.1-pro-preview',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description:
      'Google flagship — deepest Gemini reasoning, tools + vision, 1M context. The upstream id is still preview-suffixed; swap to the stable id when Google promotes it.'
  },
  {
    id: 'gemini-3.7-flash',
    name: 'Gemini 3.7 Flash',
    provider: 'google',
    apiModelId: 'gemini-3.7-flash',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'Newest Gemini Flash (launched 2026-08-13) — fast, balanced, tools + vision, 1M context.'
  },
  {
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    provider: 'google',
    apiModelId: 'gemini-3.5-flash-lite',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'flash',
    description: 'Cheapest Gemini tier — high-volume work, tools + vision, 1M context.'
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    apiModelId: 'gemini-2.5-pro',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsVision: true,
    defaultMaxTokens: 16_384,
    tier: 'pro',
    description: 'Prior-generation Gemini flagship — proven and cheaper, tools + vision, 1M context.'
  },
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma 3 27B',
    provider: 'google',
    apiModelId: 'gemma-3-27b-it',
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    tier: 'open',
    description: 'Google open-weight 27B multimodal model via AI Studio.'
  },
  {
    id: 'gemma-3-12b-it',
    name: 'Gemma 3 12B',
    provider: 'google',
    apiModelId: 'gemma-3-12b-it',
    contextWindow: 131072,
    supportsTools: true,
    supportsVision: true,
    tier: 'open',
    description: 'Smaller Gemma 3 variant — faster, lower cost.'
  },

  // ── xAI (Grok) ──
  // OpenAI-compatible endpoint (https://api.x.ai/v1) — routes through the shared
  // OpenAI client, no adapter. Model ids move fast; confirm against the live
  // /v1/models list with your key via Settings → Models → "Verify".
  {
    id: 'grok-4',
    name: 'Grok 4',
    provider: 'xai',
    apiModelId: 'grok-4',
    contextWindow: 256_000,
    supportsTools: true,
    supportsVision: true,
    tier: 'pro',
    description:
      'xAI Grok 4 flagship — reasoning, tools + vision. Verify the exact live id via Settings → Models → "Verify against providers".'
  },
  {
    id: 'grok-4-fast',
    name: 'Grok 4 Fast',
    provider: 'xai',
    apiModelId: 'grok-4-fast',
    contextWindow: 2_000_000,
    supportsTools: true,
    supportsVision: false,
    tier: 'flash',
    description:
      'xAI Grok 4 Fast — high-throughput, large context, tools. Verify the exact live id via Settings → Models → "Verify against providers".'
  },
  {
    // Benchmark engine — lets a harness answer AND adjudicate on the SAME base model
    // (memory-isolation experiments). Routes through the OneAI gateway.
    id: 'gpt-5.5-oneai',
    name: 'GPT-5.5 (OneAI gateway)',
    hidden: true,
    provider: 'oneai',
    apiModelId: 'gpt-5.5',
    contextWindow: 256_000,
    supportsTools: true,
    supportsVision: false,
    isReasoner: true,
    defaultMaxTokens: 8_192,
    tier: 'pro',
    description:
      'GPT-5.5 via the OneAI gateway. For benchmark harnesses (e.g. LongMemEval) that answer + grade on one base model.'
  },
  {
    // Benchmark engine — GPT-5.6 Sol via the OneAI gateway. Same OneAI path as
    // gpt-5.5-oneai (answer + grade on ONE base model), on the 5.6 Sol base. OneAI only —
    // the OpenAI 5.6 Sol is the separate 'gpt-5.6-sol' entry above.
    id: 'gpt-5.6-sol-oneai',
    name: 'GPT-5.6 Sol (OneAI gateway)',
    hidden: true,
    provider: 'oneai',
    apiModelId: 'gpt-5.6-sol',
    contextWindow: 256_000,
    supportsTools: true,
    supportsVision: false,
    isReasoner: true,
    defaultMaxTokens: 8_192,
    tier: 'pro',
    description:
      'GPT-5.6 Sol via the OneAI gateway — same OneAI path as gpt-5.5-oneai, on the 5.6 Sol base. For benchmark harnesses that answer + grade on one base model. Verify the exact apiModelId via Settings → Models → "Verify against providers".'
  }
]

/** Reasoning effort for reasoning models. Maps to the OpenAI-style
 *  `reasoning_effort` wire param. 'low' is the default (keeps grounded chat
 *  responsive); the user can raise it per conversation via the composer. */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max'

export interface ChatStreamParams {
  temperature?: number
  topP?: number
  maxTokens?: number | null
  /** Reasoning effort for this request. Defaults to 'low' when omitted. */
  reasoningEffort?: ReasoningEffort
}

/** A model exposes a reasoning-effort control iff it's a reasoning model. We
 *  reuse the existing catalog flags rather than add a parallel one. */
export function modelSupportsReasoningEffort(desc: ModelDescriptor): boolean {
  return !!(desc.reasoningCapOnToolUse || desc.isReasoner)
}

/** The provider-specific request param that turns a hybrid reasoner's "thinking" OFF, so it emits
 *  the answer (e.g. batch-extraction JSON) directly instead of filling reasoning_content and
 *  truncating. Only applied to descriptors flagged `disableThinking`. Verified wire params:
 *  - zhipu / deepseek: `thinking: {type: 'disabled'}` (GLM-4.5, DeepSeek-V4 share it)
 *  - dashscope (Qwen3): `enable_thinking: false` (Alibaba's non-standard top-level flag)
 *  Non-reasoning providers never set the flag, so they never hit this. The SDK forwards these
 *  top-level extras verbatim (confirmed live: glm-4.5-airx returns clean JSON, no reasoning_content). */
export function thinkingDisableParams(provider: ProviderId): Record<string, unknown> {
  switch (provider) {
    case 'zhipu':
    case 'deepseek':
      return { thinking: { type: 'disabled' } }
    case 'dashscope':
      return { enable_thinking: false }
    default:
      return {}
  }
}

/**
 * Audit context optionally passed by the orchestrator (chat:send, agent
 * pipeline, automations) so chatStream / chatOnce can emit `model.request.*`
 * events linked to the right correlation id. When omitted, the provider
 * helpers run silent — same behavior as before Prompt 3 — so tests and
 * stand-alone callers don't need to plumb anything.
 */
export interface ModelRequestAudit {
  correlationId?: string
  conversationId?: string
  /** Optional label for the role making the call (planner/coder/reviewer/
   *  composer/title-gen). Goes in the event payload, not the actor field. */
  role?: string
  /** Distinguish completion turns from incidental composer/title helpers in
   *  the timeline. Default 'main'. */
  purpose?: 'main' | 'composer' | 'title' | 'pipeline' | 'sub-agent' | 'other'
}

export interface StreamingVitals {
  lastChunkAt: number
  msSinceLastChunk: number
  chunkCount: number
  tokenEstimate: number
  attemptElapsedMs: number
}

export interface ChatStreamCallbacks {
  /** Content deltas. May return a promise; the provider stream loop AWAITS it,
   *  so a caller can apply socket backpressure (await drain) here to bound its
   *  own write buffer instead of forwarding faster than the client can read. */
  onChunk: (content: string) => void | Promise<void>
  /** Reasoning-channel deltas. DeepSeek's reasoner / V4-Flash thinking mode
   *  streams chain-of-thought on `delta.reasoning_content` (some providers
   *  alias it to `delta.reasoning`). When omitted, reasoning is dropped. May
   *  return a promise (awaited) for the same backpressure reason as onChunk. */
  onReasoning?: (content: string) => void | Promise<void>
  /** T4 — heartbeat the provider fires ~every 2s during a streaming attempt
   *  so the caller can broadcast a `chat:streaming-vitals` event. Lets the
   *  renderer show "last chunk Ns ago / N tokens" so the user can tell a
   *  slow think from a dead socket without canceling. */
  onVitals?: (vitals: StreamingVitals) => void
  /** May return a promise: the real caller's onDone is async and does heavy
   *  work (persist tool results to SQLite, spill to disk, recurse). chatStream
   *  AWAITS it and routes any rejection to onError so a throw here can't become
   *  an unhandled rejection that leaves the caller's turn promise unsettled. */
  onDone: (
    fullContent: string,
    toolCalls?: ToolCallAccumulator[],
    fullReasoning?: string,
    /** Terminal-chunk completion info. `finishReason: 'length'` signals the
     *  provider truncated the response (hit max_tokens) — callers doing
     *  structured extraction can treat that as a failed/partial batch instead
     *  of a complete answer. Optional + 4th arg → existing callers are
     *  unaffected.
     *
     *  `usage` carries the provider's own token counts for THIS request, already
     *  normalized. It was computed here and handed only to telemetry
     *  (emitModelRequestCompleted) and the cache-regression tracker, so the
     *  caller driving the turn — the one place that can meter a turn's spend or
     *  refuse the next call on budget — could not see it. Undefined when the
     *  provider returned no usage chunk (not every provider is asked for one). */
    completion?: { finishReason?: string | null; usage?: NormalizedUsage }
  ) => void | Promise<void>
  /** Called when the stream gives up. `partial` carries whatever body +
   *  reasoning had already arrived before the failure, so the caller can
   *  persist it as a partial assistant message instead of letting the user's
   *  on-screen content evaporate. Partial in-flight tool calls are NOT
   *  exposed because their args may be incomplete and would break the next
   *  tool round. */
  onError: (
    error: string,
    partial?: { content: string; reasoning?: string }
  ) => void
}

export interface ToolCallAccumulator {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

const clientCache = new Map<ProviderId, OpenAI>()

export function resetProviderClients(): void {
  clientCache.clear()
}

export function resetProviderClient(provider: ProviderId): void {
  clientCache.delete(provider)
}

function getClientForProvider(provider: ProviderId): OpenAI {
  const cached = clientCache.get(provider)
  if (cached) return cached
  const desc = PROVIDERS[provider]
  // Ollama is keyless and local — it accepts (and ignores) any API key.
  if (provider === 'ollama') {
    const client = new OpenAI({ apiKey: 'ollama', baseURL: desc.baseURL })
    clientCache.set(provider, client)
    return client
  }
  const apiKey = getKey(desc.keyEnv)
  if (!apiKey) {
    throw new Error(`${desc.label} API key not configured. Add one in Settings → API Keys.`)
  }
  const client = new OpenAI({ apiKey, baseURL: desc.baseURL })
  clientCache.set(provider, client)
  return client
}

const RETIRED_MODEL_MAP: Record<string, string> = {
  // DeepSeek legacy aliases (retired upstream 2026-07-24)
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v3': 'deepseek-v4-flash',
  'deepseek-r1': 'deepseek-v4-pro',
  // 2026-08-21 catalog redo — every id the redo removed maps to its nearest
  // current successor, so a conversation saved on an old pick keeps resolving.
  'gpt-4o': 'gpt-5.6-terra',
  'gpt-4o-mini': 'gpt-5.6-luna',
  'gpt-4.1': 'gpt-5.5',
  'o3': 'gpt-5.6-sol',
  'gpt-5.1': 'gpt-5.5',
  'gpt-5.1-mini': 'gpt-5.6-terra',
  'kimi-k2.5': 'kimi-k2.6',
  'moonshot-v1-128k': 'kimi-k2.6',
  'glm-5.2': 'glm-5.3',
  'glm-5.2-1m': 'glm-5.3',
  'glm-4-flash': 'glm-4.7-flashx',
  'glm-4.5-airx': 'glm-4.7-flashx',
  'qwen3-max': 'qwen3.8-max',
  'qwen3.5-plus': 'qwen3.7-plus',
  'qwen3.5-flash': 'qwen3.7-flash',
  'qwen3-coder-flash': 'qwen3-coder-next',
  // Claude-via-OpenRouter proxies, superseded by the first-class anthropic provider
  'claude-opus-4-openrouter': 'claude-opus-5',
  'claude-sonnet-4-openrouter': 'claude-sonnet-5',
  'claude-haiku-4-openrouter': 'claude-haiku-4-5',
  // OpenRouter's stealth-slot pin (2026-08-26, one morning's worth). Z.ai's launch note
  // names GLM-5.3-Flash as the model previewed as Ox Alpha, so the pin retires onto its
  // real id — a cross-provider hop (openrouter → zhipu), exactly like the Claude proxies
  // above. OpenRouter is zero-pinned again; its models arrive via live-import or Custom
  // Models.
  'ox-alpha': 'glm-5.3-flash',
  // OpenRouter Gemma-4 pins, dropped in the 2026-08-21 redo.
  'gemma-4-31b-it-free': 'gemma-3-27b-it',
  'gemma-4-31b-it': 'gemma-3-27b-it',
  'gemma-4-26b-a4b-it-free': 'gemma-3-12b-it',
  'gemma-4-26b-a4b-it': 'gemma-3-12b-it'
}

export function resolveModel(modelId: string): ModelDescriptor {
  // Local Ollama models carry an `ollama:<name>` id; the suffix is the exact
  // model name sent to Ollama's API (e.g. 'ollama:llama3.2:latest').
  if (modelId.startsWith('ollama:')) {
    const name = modelId.slice('ollama:'.length)
    return {
      id: modelId,
      name,
      provider: 'ollama',
      apiModelId: name,
      contextWindow: 8192,
      supportsTools: false,
      supportsVision: false,
      tier: 'open',
      description: 'Local Ollama model (keyless).'
    }
  }
  // Models added via the OpenRouter browser carry an `openrouter:<vendor/model>` id; the
  // suffix is the exact OpenRouter model string sent in the `model` field. The prefix is what
  // lets a custom OpenRouter model route to the OpenRouter provider instead of the generic
  // deepseek fallback below. Metadata (context/tools/vision) is best-effort here; the accurate
  // per-model values live in the stored custom entry surfaced by model:list.
  if (modelId.startsWith('openrouter:')) {
    const apiModelId = modelId.slice('openrouter:'.length)
    return {
      id: modelId,
      name: apiModelId,
      provider: 'openrouter',
      apiModelId,
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      tier: 'pro',
      description: 'OpenRouter model (added via the OpenRouter browser).'
    }
  }
  const found = MODEL_CATALOG.find((m) => m.id === modelId)
  if (found) return found

  const replacement = RETIRED_MODEL_MAP[modelId]
  if (replacement) {
    const mapped = MODEL_CATALOG.find((m) => m.id === replacement)
    if (mapped) return mapped
  }

  // Custom / imported model — route on the stored provider + wire id. This is
  // what makes an imported id for a UA provider (groq/mistral/moonshot/
  // github-models/deepinfra) call the RIGHT provider instead of silently
  // falling through to the deepseek fallback below. apiModelId falls back to the
  // id (hand-added models use the id as the wire id); the provider is honored
  // only when it's a real ProviderId, else it degrades to the deepseek fallback.
  const custom = readCustomModels().find((m) => m.id === modelId)
  if (custom && custom.provider && custom.provider in PROVIDERS) {
    return {
      id: modelId,
      name: custom.name || modelId,
      provider: custom.provider,
      apiModelId:
        typeof custom.apiModelId === 'string' && custom.apiModelId ? custom.apiModelId : modelId,
      contextWindow:
        typeof custom.contextWindow === 'number' && custom.contextWindow > 0
          ? custom.contextWindow
          : 65536,
      supportsTools: !!custom.supportsTools,
      supportsVision: !!custom.supportsVision,
      tier: 'pro',
      description: 'Custom model.'
    }
  }

  // Unknown model id — assume DeepSeek, OpenAI-compatible.
  return {
    id: modelId,
    name: modelId,
    provider: 'deepseek',
    apiModelId: modelId,
    contextWindow: 65536,
    supportsTools: true,
    supportsVision: false,
    tier: 'pro',
    description: 'Custom model.'
  }
}

// ── P8 · private-grounding locality ──
/**
 * True when `modelId` resolves to a LOCAL, on-device, KEYLESS model — one that
 * runs on the operator's machine and egresses nothing off-box. Today that is
 * only Ollama (id prefix `ollama:`, provider 'ollama', baseURL 127.0.0.1:11434);
 * every cloud provider (DeepSeek, Zhipu/GLM, Moonshot/Kimi, DashScope/Qwen, OpenAI,
 * OpenRouter, xAI, Google, OneAI) returns false. The whole-note grounding guard uses this to
 * decide whether full vault-note bodies may be handed to the answer model. If a
 * new on-device / keyless provider is ever added, treat it as local here too.
 */
export function isLocalModel(modelId: string): boolean {
  if (!modelId) return false
  if (modelId.startsWith('ollama:')) return true
  return resolveModel(modelId).provider === 'ollama'
}

/**
 * P8 — may whole-note grounding send FULL note bodies to `answerModelId` this
 * turn? Allowed only when the answer model is LOCAL (no egress), OR the operator
 * has explicitly accepted cloud egress via DUIN_WHOLENOTE_ALLOW_CLOUD=1 (the
 * escape hatch for non-sensitive work). Default: fail CLOSED — a cloud answer
 * model without the opt-in is NOT allowed, so a dropped Ollama that silently
 * falls back to a cloud key disables whole-note grounding instead of egressing
 * the operator's sensitive vault.
 */
export function wholeNoteEgressAllowed(answerModelId: string): boolean {
  return isLocalModel(answerModelId) || process.env.DUIN_WHOLENOTE_ALLOW_CLOUD === '1'
}

// ── Ollama auto-detection (local, keyless turnkey path) ──
let ollamaModels: string[] = []

/** Probe a local Ollama (:11434) and cache its installed model list. Fast-fails
 *  on a short timeout so it never blocks when Ollama isn't running. */
export async function detectOllama(): Promise<{ available: boolean; models: string[] }> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 800)
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal })
    clearTimeout(t)
    if (!res.ok) {
      ollamaModels = []
      return { available: false, models: [] }
    }
    const data = (await res.json()) as { models?: { name?: string }[] }
    ollamaModels = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean)
    return { available: ollamaModels.length > 0, models: ollamaModels }
  } catch {
    ollamaModels = []
    return { available: false, models: [] }
  }
}

/** Installed local Ollama model names (from the last detectOllama()). */
export function getOllamaModels(): string[] {
  return ollamaModels
}

/**
 * The best model to run a completion with (chat grounding, notes-extraction),
 * in priority order:
 *   1. `preferred` if usable (a BYO-key catalog model, or a detected Ollama
 *      model) — the 'duin-brain' sentinel is skipped (it's the connector, not an API).
 *   2. the first catalog model whose provider has a stored key (bring-your-own).
 *   3. the first detected local Ollama model (keyless, zero-cost turnkey).
 *   4. null — nothing callable is configured.
 */
/** A model id is usable when it's a real, callable model: a BYO-key catalog
 *  model, or a detected local Ollama model. Never the 'duin-brain' connector. */
export function isUsableModel(id: string): boolean {
  if (!id || id === 'duin-brain') return false
  if (id.startsWith('ollama:')) return ollamaModels.includes(id.slice('ollama:'.length))
  const d = MODEL_CATALOG.find((m) => m.id === id)
  return !!d && !!getKey(PROVIDERS[d.provider].keyEnv)
}

export function resolveCompletionModel(preferred?: string): string | null {
  if (preferred && isUsableModel(preferred)) return preferred
  for (const m of MODEL_CATALOG) {
    if (m.id === 'duin-brain') continue
    if (getKey(PROVIDERS[m.provider].keyEnv)) return m.id
  }
  if (ollamaModels.length) return `ollama:${ollamaModels[0]}`
  return null
}

// ── Native task-aware model routing ──
// Match the model to the task for better performance: cheap/fast models for
// structured or trivial work (extraction, titles), strong models for grounded
// reasoning, a coder model for code. Deterministic + LOCAL — no remote router
// (fugu et al. are hosted; this adds zero latency and respects keyless/Ollama).
// Picks the first BYO-key catalog model in the task's preferred tier order,
// falling back to a local Ollama model, then any usable model.
export type RouteTask = 'chat' | 'extraction' | 'title' | 'code' | 'reason'

const TIER_POLICY: Record<RouteTask, ModelDescriptor['tier'][]> = {
  extraction: ['flash', 'open', 'coder', 'pro', 'reasoner'], // structured JSON — cheap/fast is plenty
  title: ['open', 'flash', 'coder', 'pro', 'reasoner'], // tiny classifications — cheapest wins
  chat: ['pro', 'reasoner', 'flash', 'open'], // grounded answers — favour strong models
  code: ['coder', 'pro', 'reasoner', 'flash'],
  reason: ['reasoner', 'pro', 'flash']
}

/** Per-provider designated model for structured extraction / titles: a non-reasoning model where the
 *  provider has one, else its cheapest reasoner with thinking disabled (see `disableThinking`). This is
 *  what a fresh operator should get for whatever API they configured — it bypasses the generic tier
 *  loop, which would otherwise grab e.g. Zhipu's THROTTLED free glm-4-flash or a thinking-on reasoner
 *  that silently returns 0 JSON on batch construction. Covers every keyed provider (Claude
 *  first-class via `anthropic`, Qwen via DashScope). Ollama is handled by the keyless fallback +
 *  construct.ts `/no_think`. */
const EXTRACTION_DEFAULT: Partial<Record<ProviderId, string>> = {
  // Every id here MUST be a live MODEL_CATALOG id — isUsableModel() only matches live
  // ids, so a retired id makes the designated pick silently unreachable and drops the
  // provider back onto the generic tier loop this map exists to bypass. After the
  // 2026-08-21 catalog redo, 5 of 9 rows named retired ids and were dead. Locked by
  // extraction-default parity assertions in registry.test.ts.
  zhipu: 'glm-4.7-flashx', // paid, not throttled; thinking disabled (was retired glm-4.5-airx)
  deepseek: 'deepseek-v4-flash', // hybrid; thinking disabled
  moonshot: 'kimi-k2.6', // non-code Kimi; clean extraction JSON (was retired moonshot-v1-128k)
  dashscope: 'qwen3.7-flash', // thinking disabled (was retired qwen3.5-flash)
  anthropic: 'claude-haiku-4-5', // Claude Haiku — fast, cheapest Claude (was openrouter-pinned; openrouter ships zero catalog models — no openrouter row here on purpose)
  openai: 'gpt-5.5', // cheapest OpenAI catalog entry (was retired gpt-4o-mini)
  xai: 'grok-4-fast', // non-reasoning
  google: 'gemma-3-27b-it', // non-reasoning
  oneai: 'gpt-5.5-oneai' // reasoner gateway; reasoning_effort capped low by modelSupportsReasoningEffort
}

/** Provider priority for extraction routing: the configured/default model's provider first (so a
 *  Claude user extracts with Claude, a GLM user with GLM), then the rest in a stable order. Only
 *  providers with a stored key yield a usable model, so single-provider operators always resolve
 *  to their own family regardless of the base order. */
/** Is this model's account currently refusing? Keyed but drained is NOT usable for an automatic
 *  choice — that distinction is the whole point of provider-health. */
function isParked(modelId: string): boolean {
  const prov = MODEL_CATALOG.find((m) => m.id === modelId)?.provider
  return prov ? isProviderCoolingDown(prov) : false
}

function extractionProviderOrder(preferred?: string): ProviderId[] {
  const base: ProviderId[] = ['zhipu', 'deepseek', 'moonshot', 'dashscope', 'openrouter', 'openai', 'xai', 'google', 'oneai']
  const prefProv = preferred ? MODEL_CATALOG.find((m) => m.id === preferred)?.provider : undefined
  const ordered = prefProv ? [prefProv, ...base.filter((p) => p !== prefProv)] : base
  // This array IS the priority order; provider-health only removes the ones that are currently
  // refusing, and returns the full list unchanged if that would leave nothing.
  return availableProviders(ordered)
}

// ── Operator pins over automatic routing ──
// Two ways an operator overrides the tier policy without naming a model per call: the
// Background-model setting (Settings → Models) and the per-task DUIN_ROUTE_<TASK> env pin.
// Both are PREFERENCES, not promises the account has money or the id still exists: a retired
// id, a key-less provider, or a refusing account all fall through to the automatic pick rather
// than hard-failing every background extraction. (deploy.cmd arms DUIN_ROUTE_EXTRACTION=
// glm-4.7-flashx on the author's machine, and an empty Zhipu balance used to hard-pin every
// background extraction onto a provider that refused 21 of 32 batches per build — stepping over
// a refusing account while its cooldown runs is what fixed it.)

/** Settings key for the operator's Background-model choice (Settings → Models). Read on every
 *  background route, so a change in Settings applies to the next extraction batch or title
 *  without a restart. */
export const BACKGROUND_MODEL_SETTING = 'backgroundModel'
/** The stored value that means "let DUIN decide" — same as '' or an absent key. */
export const AUTO_BACKGROUND_MODEL = 'auto'
/** The tasks the setting governs: DUIN's OWN structured work. Chat stays with the picker;
 *  code/reason are routed by callers that name what they need. */
export const BACKGROUND_TASKS: ReadonlySet<RouteTask> = new Set<RouteTask>(['extraction', 'title'])

/** The stored Background-model id, or null for Auto ('' / 'auto' / absent / non-string). A
 *  retired id follows RETIRED_MODEL_MAP to its successor — the same courtesy a saved
 *  conversation and the persisted default get. Never throws: a settings read on a hot path
 *  degrades to Auto. */
export function backgroundModelSetting(): string | null {
  let raw: unknown
  try {
    raw = readSettings()[BACKGROUND_MODEL_SETTING]
  } catch {
    return null
  }
  if (typeof raw !== 'string') return null
  const id = raw.trim()
  if (!id || id === AUTO_BACKGROUND_MODEL) return null
  return RETIRED_MODEL_MAP[id] ?? id
}

export type RoutePinSource = 'setting' | 'env'

function envRoutePin(task: RouteTask): string | null {
  const envPin = process.env[`DUIN_ROUTE_${task.toUpperCase()}`]
  return envPin && isUsableModel(envPin) && !isParked(envPin) ? envPin : null
}

/** The operator pin that beats the tier policy for `task`, if a usable one is in force: the
 *  stored Background-model choice (background tasks only), else the env pin. The setting sits
 *  ABOVE the env pin on purpose — the pin is deploy-time ops config, and a choice the operator
 *  made in the product must not be silently beaten by it. */
export function operatorRoutePin(task: RouteTask): { id: string; source: RoutePinSource } | null {
  if (BACKGROUND_TASKS.has(task)) {
    const chosen = backgroundModelSetting()
    if (chosen && isUsableModel(chosen) && !isParked(chosen)) return { id: chosen, source: 'setting' }
  }
  const env = envRoutePin(task)
  return env ? { id: env, source: 'env' } : null
}

/** Route to the best model for a task. Precedence: an explicit usable `preferred`
 *  (a caller/user naming a model) first; then the operator pins — the Background-model
 *  setting for background tasks, then the per-task env pin — which override only the
 *  AUTOMATIC selection; then the tier policy, then Ollama, then any. */
export function routeModel(task: RouteTask, preferred?: string): string | null {
  // 1. An explicit, usable `preferred` wins — honouring the caller's named model is the whole point
  //    of the argument. This MUST sit above the pins: a pin overrides AUTOMATIC selection, not an
  //    explicit request. (Historically the env pin was checked first and silently beat an explicit
  //    preferred — an unintended precedence, since the pin was only ever meant to beat the tier policy.)
  if (preferred && isUsableModel(preferred)) return preferred
  // 2. The operator's pins: Settings → Models → Background model, then DUIN_ROUTE_<TASK>. Either is
  //    the deterministic way to force extraction onto a non-reasoning flash model when multiple
  //    flash-tier keys exist (a reasoning/large-output model silently produces 0 JSON on batch
  //    construction). Fall-through rules live in operatorRoutePin.
  const pin = operatorRoutePin(task)
  if (pin) return pin.id
  return automaticRoute(task, preferred)
}

/** Steps 3–6 of routeModel, the automatic pick: each configured provider's designated extraction
 *  model, then the tier policy (serving providers first, then ignoring cooldowns), then local
 *  Ollama, then any usable model. Split out so Settings → Models can show what Auto WOULD pick
 *  while a pin is in force. */
function automaticRoute(task: RouteTask, preferred?: string): string | null {
  // Structured tasks (extraction/titles) want a fast NON-reasoning (or thinking-off) model. Prefer each
  // configured provider's designated extraction model — so any operator gets a working extractor for
  // whatever API they added, instead of the tier loop grabbing a throttled free model or a thinking-on
  // reasoner. Falls through to the tier policy if no provider has a designated model with a key.
  if (task === 'extraction' || task === 'title') {
    for (const prov of extractionProviderOrder(preferred)) {
      const id = EXTRACTION_DEFAULT[prov]
      if (id && isUsableModel(id)) return id
    }
  }
  for (const tier of TIER_POLICY[task]) {
    for (const m of MODEL_CATALOG) {
      if (m.id === 'duin-brain' || m.tier !== tier) continue
      if (getKey(PROVIDERS[m.provider].keyEnv) && !isProviderCoolingDown(m.provider)) return m.id
    }
  }
  // Nothing open — fall through the SAME order ignoring cooldowns rather than returning null. A
  // degraded estate must still route somewhere; the caller's own error handling reports the refusal.
  for (const tier of TIER_POLICY[task]) {
    for (const m of MODEL_CATALOG) {
      if (m.id === 'duin-brain' || m.tier !== tier) continue
      if (getKey(PROVIDERS[m.provider].keyEnv)) return m.id
    }
  }
  if (ollamaModels.length) return `ollama:${ollamaModels[0]}`
  return resolveCompletionModel(preferred)
}

export interface BackgroundModelStatus {
  /** What Settings holds (after retired-id migration): a model id, or null for Auto. */
  chosen: string | null
  /** What background work resolves to right now, or null when nothing is routable. */
  effective: string | null
  /** What Auto resolves to — the env pin if one is in force, else the automatic pick. */
  automatic: string | null
  /** Why `effective` is what it is. */
  source: RoutePinSource | 'auto' | 'none'
}

/** For Settings → Models: what the Background model IS right now and why — so a pinned model
 *  whose key is missing, or whose account is refusing, reads as "falling back to Auto → X"
 *  instead of silently doing something other than what the operator picked. */
export function describeBackgroundModel(): BackgroundModelStatus {
  const chosen = backgroundModelSetting()
  const pin = operatorRoutePin('extraction')
  const automatic = envRoutePin('extraction') ?? automaticRoute('extraction')
  const effective = pin?.id ?? automatic
  return { chosen, effective, automatic, source: pin?.source ?? (effective ? 'auto' : 'none') }
}

// ── Workflow symbolic tier ('cheap'/'pro') routing ──
// Built-in workflows (resources/workflows/*.js) tag agent() calls with a symbolic
// budget tier via `model: 'cheap' | 'pro'` — see workflow-budget.ts's TIER_MODEL_MAP,
// which ships those two names hardcoded to literal DeepSeek ids as a last-resort
// default (its own comment already documented setTierModelMap() as the production
// override; nothing ever called it). main.ts calls setTierModelMap() at boot with the
// ids resolved here, using the SAME key-gated MODEL_CATALOG walk as routeModel above,
// so a workflow's tier call lands on a provider the operator actually configured
// instead of silently requiring a DeepSeek key no matter what they set up.
const WORKFLOW_TIER_ORDER: Record<'cheap' | 'pro', ModelDescriptor['tier'][]> = {
  cheap: ['flash', 'open', 'coder', 'pro', 'reasoner'],
  pro: ['pro', 'reasoner', 'coder', 'flash', 'open']
}

/** Best catalog model for a workflow's symbolic 'cheap'/'pro' budget tier: the first
 *  model (in that tier's preference order) whose provider has a stored key, falling
 *  back to a detected local Ollama model. Never the duin-brain connector or a
 *  picker-hidden entry (operator-only benchmark models). Returns null when nothing at
 *  all resolves — callers should leave their prior default in place in that case,
 *  since null is "no usable model", not "no preference". */
export function resolveWorkflowTierModel(tier: 'cheap' | 'pro'): string | null {
  for (const t of WORKFLOW_TIER_ORDER[tier]) {
    for (const m of MODEL_CATALOG) {
      if (m.id === 'duin-brain' || m.hidden || m.tier !== t) continue
      if (getKey(PROVIDERS[m.provider].keyEnv)) return m.id
    }
  }
  if (ollamaModels.length) return `ollama:${ollamaModels[0]}`
  return null
}

/** Like routeModel but SKIPS any model on `avoidProvider` — for a genuinely cross-FAMILY second
 *  opinion (govern jury / measure grader) instead of one model wearing two hats. Returns null when
 *  no distinct-provider model is available; the caller decides (abstain, or fall back to routeModel).
 *  Ollama counts as a distinct family unless the avoided model is itself Ollama-backed. */
/**
 * Up to `limit` keyed models, each from a DISTINCT provider family, skipping every provider in
 * `avoid`. Ordered by the task's tier policy, so the cheapest suitable model of each family comes
 * first.
 *
 * `routeDistinctModel` (singular, below) answers "give me somewhere else to retry" and returns one
 * id. A JURY needs something different: a panel. One model voting alone is a single point of
 * failure dressed as a verdict — on the live brain a single flaky call decided a whole probation
 * pool, and because an omitted fact means REVERT, its flakiness spent real facts.
 */
export function routeDistinctModels(
  avoid: ReadonlySet<ProviderId>,
  task: RouteTask,
  limit: number
): string[] {
  const out: string[] = []
  const used = new Set<ProviderId>(avoid)
  if (limit <= 0) return out
  for (const tier of TIER_POLICY[task]) {
    for (const m of MODEL_CATALOG) {
      if (out.length >= limit) return out
      if (m.id === 'duin-brain' || m.tier !== tier || used.has(m.provider)) continue
      if (!getKey(PROVIDERS[m.provider].keyEnv)) continue
      used.add(m.provider)
      out.push(m.id)
    }
  }
  if (out.length < limit && ollamaModels.length && !used.has('ollama')) out.push(`ollama:${ollamaModels[0]}`)
  return out
}

export function routeDistinctModel(avoidProvider: ProviderId, task: RouteTask): string | null {
  for (const tier of TIER_POLICY[task]) {
    for (const m of MODEL_CATALOG) {
      if (m.id === 'duin-brain' || m.tier !== tier || m.provider === avoidProvider) continue
      if (getKey(PROVIDERS[m.provider].keyEnv)) return m.id
    }
  }
  if (ollamaModels.length && avoidProvider !== 'ollama') return `ollama:${ollamaModels[0]}`
  return null
}

/** Next keyed catalog model on the SAME provider, skipping any id in `avoid`. For the answer-path
 *  fallback when a routed id is stale/unknown (model_not_found): a single-key operator has no OTHER
 *  provider to fail over to, so we must try that provider's next catalog id (e.g. the shipped default
 *  `deepseek-v4-pro` 404s → try `deepseek-v4-flash`) before giving up. Returns null when the provider
 *  has no untried catalog model with a key. Never returns duin-brain (internal) or an avoided id. */
export function routeWithinProvider(
  provider: ProviderId,
  task: RouteTask,
  avoid: ReadonlySet<string> = new Set()
): string | null {
  if (!getKey(PROVIDERS[provider].keyEnv)) return null
  // Prefer the task's tier order so a chat failover still lands a chat-appropriate tier first,
  // then sweep any remaining same-provider models so we exhaust the provider before failing.
  for (const tier of TIER_POLICY[task]) {
    for (const m of MODEL_CATALOG) {
      if (m.id === 'duin-brain' || m.provider !== provider || m.tier !== tier) continue
      if (!avoid.has(m.id)) return m.id
    }
  }
  for (const m of MODEL_CATALOG) {
    if (m.id === 'duin-brain' || m.provider !== provider) continue
    if (!avoid.has(m.id)) return m.id
  }
  return null
}

export function getProviderForModel(modelId: string): ProviderId {
  return resolveModel(modelId).provider
}

export function getApiModelId(modelId: string): string {
  return resolveModel(modelId).apiModelId
}

export interface KeyValidationResult {
  ok: boolean
  reason?: string
  modelCount?: number
}

export async function validateProviderKeyDetailed(provider: ProviderId): Promise<KeyValidationResult> {
  let client: OpenAI
  try {
    client = getClientForProvider(provider)
  } catch (err) {
    return { ok: false, reason: messageOf(err) || 'No API key stored for this provider.' }
  }

  // Primary check: GET /v1/models. Costs nothing, requires only auth, and
  // works on every OpenAI-compatible provider we route to. A 401/403 here
  // is the only thing that proves the key itself is bad.
  try {
    const response = await client.models.list()
    const count = Array.isArray(response.data) ? response.data.length : 0
    return { ok: true, modelCount: count }
  } catch (err) {
    if ((err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 403) {
      return { ok: false, reason: `Provider rejected the key (HTTP ${(err as { status?: number }).status}).` }
    }
    // Fall through to a chat-completion fallback for providers that don't
    // expose /v1/models — DashScope's compatible-mode endpoint, for instance.
    return validateViaChatProbe(provider, client, err)
  }
}

async function validateViaChatProbe(
  provider: ProviderId,
  client: OpenAI,
  originalError: any
): Promise<KeyValidationResult> {
  // Pick the cheapest catalog model we know about for this provider. This is
  // a fallback only — if the call fails for any non-auth reason we report it
  // verbatim rather than claiming the key is invalid.
  const probe = MODEL_CATALOG.find((m) => m.provider === provider)
  if (!probe) {
    return {
      ok: false,
      reason: originalError?.message || `No catalog model available to probe ${provider}.`
    }
  }
  try {
    const response = await client.chat.completions.create({
      model: probe.apiModelId,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1
    })
    return { ok: !!response.choices[0]?.message }
  } catch (err) {
    if ((err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 403) {
      return { ok: false, reason: `Provider rejected the key (HTTP ${(err as { status?: number }).status}).` }
    }
    return {
      ok: false,
      reason:
        messageOf(err) ||
        originalError?.message ||
        'Provider returned an unexpected error during validation.'
    }
  }
}

// Boolean wrapper retained for the legacy single-key path
// (settings:testApiKey -> DeepSeekClient.validateKey).
export async function validateProviderKey(provider: ProviderId): Promise<boolean> {
  const result = await validateProviderKeyDetailed(provider)
  return result.ok
}

// 'no-credit' is NOT 'auth-failed', and the difference is the whole reason it exists.
// A provider that answers "your balance is empty" has ACCEPTED the key — the credential
// is good and the only thing wrong is billing. Reporting that as "the provider rejected
// your key" sends the operator to rotate a key that was never the problem, and it is
// what this verifier did on 2026-08-26 for a freshly-pasted, provably valid Anthropic
// key. Measured the same day: all three of this machine's paid providers were out of
// credit (zhipu `余额不足`, anthropic "credit balance too low", openai
// `credit_balance_exhausted`) while every health check reported them healthy.
export type CatalogStatus =
  | 'verified'
  | 'missing'
  | 'no-key'
  | 'unsupported-endpoint'
  | 'auth-failed'
  | 'no-credit'
  | 'error'

export interface ProviderCatalogReport {
  provider: ProviderId
  status: 'ok' | 'no-key' | 'unsupported-endpoint' | 'auth-failed' | 'no-credit' | 'error'
  reason?: string
  // Sample of live ids returned by /v1/models (capped for size).
  liveIds?: string[]
  liveCount?: number
}

export interface CatalogVerificationReport {
  generatedAt: number
  providers: ProviderCatalogReport[]
  models: Array<{
    modelId: string
    name: string
    provider: ProviderId
    apiModelId: string
    status: CatalogStatus
    reason?: string
  }>
}

// ──────────────────── live catalog discovery (UA machinery) ────────────────────
// Powers Settings → Models → "Import live models": pull a provider's CURRENT
// chat roster so the user can browse-and-add instead of hand-typing ids. Adapted
// from the upstream provider-expansion machinery to DUIN's ProviderId-typed
// PROVIDERS + getClientForProvider (no custom-provider / base-URL-override layer).

/** listLiveModelIds throws this when the provider advertises no machine-readable
 *  chat catalog (descriptor `catalog: {kind:'unsupported'}`); the caller surfaces
 *  the message verbatim and the UI falls back to hand-added Custom Models. */
export class ModelCatalogUnsupportedError extends Error {
  constructor(providerLabel: string) {
    super(`${providerLabel} does not expose a compatible chat model catalog.`)
    this.name = 'ModelCatalogUnsupportedError'
  }
}

/** The key to authenticate a catalog fetch with: the stored key, or the literal
 *  'local' placeholder for keyless (keyOptional) local runtimes. Throws when a
 *  key-required provider has none stored. */
function providerApiKey(desc: ProviderDescriptor): string {
  const key = getKey(desc.keyEnv) ?? (desc.keyOptional ? 'local' : null)
  if (!key) {
    throw new Error(`${desc.label} API key not configured. Add one in Settings → API Keys.`)
  }
  return key
}

function httpCatalogError(status: number, statusText: string): Error & { status: number } {
  const error = new Error(
    `Model catalog request failed (HTTP ${status} ${statusText}).`
  ) as Error & { status: number }
  error.status = status
  return error
}

/** Normalize a provider catalog payload into a sorted, de-duplicated list of
 *  live model ids. Handles the three URL response shapes DUIN supports:
 *    - 'openai'   → {data:[{id}]}          (OpenAI SDK / SiliconFlow shape)
 *    - 'array'    → [{id}]                 (bare array, e.g. GitHub Models)
 *    - 'deepinfra'→ [{model_name,type,…}]  (filtered to live text-generation ids)
 *  Rows that aren't objects or lack a usable id string are dropped, never guessed. */
export function normalizeCatalogPayload(
  payload: unknown,
  format: Extract<ModelCatalogStrategy, { kind: 'url' }>['format']
): string[] {
  let rows: unknown[] = []
  if (format === 'openai') {
    const data = (payload as { data?: unknown } | null)?.data
    rows = Array.isArray(data) ? data : []
  } else if (Array.isArray(payload)) {
    rows = payload
  }

  const ids = rows
    .filter((row) => {
      if (format !== 'deepinfra') return true
      const item = row as { type?: unknown; reported_type?: unknown; deprecated?: unknown }
      return (
        item.deprecated == null &&
        (item.reported_type === 'text-generation' || item.type === 'text-generation')
      )
    })
    .map((row) => {
      if (!row || typeof row !== 'object') return null
      const item = row as { id?: unknown; model_name?: unknown }
      const candidate = format === 'deepinfra' ? item.model_name : item.id
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null
    })
    .filter((id): id is string => !!id)

  return [...new Set(ids)].sort()
}

/** Live model ids from ONE provider's current catalog, per its descriptor's
 *  `catalog` strategy (defaults to the OpenAI SDK `GET /v1/models`). Throws on
 *  unknown provider / missing key / unsupported catalog / endpoint errors so the
 *  caller can surface the message verbatim. Never mutates the pinned catalog. */
export async function listLiveModelIds(provider: ProviderId): Promise<string[]> {
  const desc = PROVIDERS[provider]
  if (!desc) throw new Error(`Unknown provider: ${provider}`)
  const strategy: ModelCatalogStrategy = desc.catalog ?? { kind: 'openai' }
  if (strategy.kind === 'unsupported') throw new ModelCatalogUnsupportedError(desc.label)

  if (strategy.kind === 'openai') {
    // Reuse the shared OpenAI client (handles Ollama's keyless special-case and
    // the stored-key path uniformly).
    const client = getClientForProvider(provider)
    const response = await client.models.list()
    return normalizeCatalogPayload(response, 'openai')
  }

  // kind === 'url' — a non-SDK GET against an explicit catalog endpoint.
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (strategy.auth !== 'none') {
    const key = providerApiKey(desc)
    if (strategy.auth === 'bearer') headers.Authorization = `Bearer ${key}`
    if (strategy.auth === 'x-api-key') headers['X-Api-Key'] = key
  }
  // AbortController + timer (mirrors detectOllama) rather than AbortSignal.timeout,
  // to avoid depending on a newer lib.dom typing for the 30s catalog fetch bound.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const response = await fetch(strategy.url, { headers, signal: ctrl.signal })
    if (!response.ok) throw httpCatalogError(response.status, response.statusText)
    return normalizeCatalogPayload(await response.json(), strategy.format)
  } finally {
    clearTimeout(timer)
  }
}

// Calls each provider's /v1/models endpoint with the stored key and confirms
// that every catalog apiModelId is present in the live response. Returns a
// structured report so the UI can show per-model status — no inferences, no
// fabricated "verified" claims.
/**
 * Does this failure mean "the account is out of money" rather than "the key is bad"?
 *
 * Matched on the MESSAGE, not the status code, because the codes disagree across
 * providers and overlap the auth codes — all three of these were observed on 2026-08-26
 * from three different vendors, each with a valid key:
 *
 *   zhipu      429  余额不足或无可用资源包,请充值。
 *   anthropic  400  "Your credit balance is too low to access the Anthropic API."
 *   openai     429  insufficient_quota / credit_balance_exhausted
 *
 * A 400 and a 429 landing in the same bucket as a 401 is exactly how "top up your
 * account" became "your key was rejected". Chinese is matched too: the provider that
 * produced the most failures on this machine answers in it.
 *
 * Exported for test.
 */
export function isNoCreditError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  // Read the message WITHOUT depending on the throw being an Error subclass.
  // `messageOf` returns String(err) for a non-Error, which is "[object Object]" for the
  // plain shapes some adapters and every hand-rolled fetch path produce — so relying on
  // it alone would classify those by status code only, and the Anthropic case (a 400)
  // has no distinguishing code at all. Providers also nest the useful text one level
  // down in `error.message` / `error.code`, so collect all of it.
  const e = (err ?? {}) as { message?: unknown; error?: unknown }
  const parts = [
    typeof e.message === 'string' ? e.message : '',
    messageOf(err),
    JSON.stringify(e.error ?? '')
  ]
  const text = parts.join(' ')
  // THROUGHPUT WORDING WINS — the same rule isBalanceError already applies, and this
  // function was missing it. Providers put a billing URL in the footer of unrelated
  // errors ("Rate limit reached … see .../organization/billing/"), so a bare `billing`
  // substring match reads a transient throttle as an empty account. That is the
  // expensive direction to be wrong in: a rate limit clears on its own, and telling the
  // operator to go fund an account that is already funded sends them to fix nothing.
  if (/rate.?limit|overload|too many requests|try again later|请稍后|频率|限流/i.test(text)) {
    return false
  }
  const billing =
    /insufficient[_ ]quota|credit[_ ]balance|balance is too low|no credits remaining|exceeded your current quota|billing|arrearage|余额不足|请充值|无可用资源包/i.test(
      text
    )
  if (billing) return true
  // 402 Payment Required is unambiguous on its own; no message needed.
  return status === 402
}

export async function verifyCatalog(): Promise<CatalogVerificationReport> {
  const providerIds = Object.keys(PROVIDERS) as ProviderId[]

  const providerReports = await Promise.all(
    providerIds.map(async (pid): Promise<ProviderCatalogReport> => {
      // HONOUR THE PROVIDER'S OWN DECLARATION, before spending a request on it.
      //
      // A provider whose descriptor says `catalog: { kind: 'unsupported' }` has already
      // stated that its roster cannot be read this way. Anthropic is the live example:
      // its OpenAI-compat layer covers /v1/chat/completions but NOT /v1/models, whose
      // native form needs `x-api-key` + `anthropic-version` rather than the Bearer this
      // client sends. Probing it anyway earns a 401, which the catch below then reported
      // as "Provider rejected the key" — a valid, working key declared dead on a screen
      // whose entire job is telling the operator what works. Verified 2026-08-26: the
      // same key returned 200 against the native endpoint and passed authentication on
      // the chat endpoint in the same minute.
      //
      // The declaration is not a hint. Read it first and skip the call.
      const declared = PROVIDERS[pid]?.catalog
      if (declared?.kind === 'unsupported') {
        return {
          provider: pid,
          status: 'unsupported-endpoint',
          reason:
            `${PROVIDERS[pid].label} does not expose a readable /v1/models for this client, ` +
            `so its catalog entries cannot be auto-verified. This says nothing about the key.`
        }
      }
      let client: OpenAI
      try {
        client = getClientForProvider(pid)
      } catch (err) {
        return { provider: pid, status: 'no-key', reason: messageOf(err) || 'No API key stored.' }
      }
      try {
        const response = await client.models.list()
        const ids = (Array.isArray(response.data) ? response.data : [])
          .map((m: any) => (typeof m?.id === 'string' ? m.id : null))
          .filter((id): id is string => !!id)
        return {
          provider: pid,
          status: 'ok',
          liveIds: ids.slice(0, 500),
          liveCount: ids.length
        }
      } catch (err) {
        // BILLING BEFORE AUTH. A provider out of credit answers with a mix of 402, 429
        // and even 400/403 depending on whose API it is, so the status code alone cannot
        // separate "bad key" from "empty wallet" — the message can, and every one of
        // them says so in plain words. Checked FIRST because several of these codes
        // overlap the auth branch below, and calling an empty balance an auth failure is
        // the more expensive mistake: it sends the operator to rotate a working key.
        if (isNoCreditError(err)) {
          return {
            provider: pid,
            status: 'no-credit',
            reason:
              `${PROVIDERS[pid].label} accepted the key and refused the request for BILLING: ` +
              `${messageOf(err) || 'no credit remaining'}. The key is fine; the account needs funding.`
          }
        }
        if ((err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 403) {
          return {
            provider: pid,
            status: 'auth-failed',
            reason: `Provider rejected the key (HTTP ${(err as { status?: number }).status}).`
          }
        }
        if ((err as { status?: number })?.status === 404 || (err as { status?: number })?.status === 405) {
          // Provider's compatible-mode endpoint doesn't expose /v1/models;
          // we can't confirm or refute the catalog without spending tokens.
          return {
            provider: pid,
            status: 'unsupported-endpoint',
            reason: `Provider does not expose /v1/models (HTTP ${(err as { status?: number }).status}). Catalog entries for this provider cannot be auto-verified.`
          }
        }
        return {
          provider: pid,
          status: 'error',
          reason: messageOf(err) || 'Unknown error contacting provider.'
        }
      }
    })
  )

  const providerReportByProvider = new Map<ProviderId, ProviderCatalogReport>(
    providerReports.map((r) => [r.provider, r])
  )

  const models = MODEL_CATALOG.map((m) => {
    const report = providerReportByProvider.get(m.provider)
    let status: CatalogStatus
    let reason: string | undefined
    if (!report || report.status === 'no-key') {
      status = 'no-key'
      reason = `Add a ${PROVIDERS[m.provider].label} key in Settings → API Keys to verify.`
    } else if (report.status === 'auth-failed') {
      status = 'auth-failed'
      reason = report.reason
    } else if (report.status === 'no-credit') {
      status = 'no-credit'
      reason = report.reason
    } else if (report.status === 'unsupported-endpoint') {
      status = 'unsupported-endpoint'
      reason = report.reason
    } else if (report.status === 'error') {
      status = 'error'
      reason = report.reason
    } else if (report.liveIds && report.liveIds.includes(m.apiModelId)) {
      status = 'verified'
    } else {
      status = 'missing'
      reason = `Provider's /v1/models response did not include "${m.apiModelId}".`
    }
    return {
      modelId: m.id,
      name: m.name,
      provider: m.provider,
      apiModelId: m.apiModelId,
      status,
      reason
    }
  })

  return {
    generatedAt: Date.now(),
    providers: providerReports,
    models
  }
}

/** Reasoning Audit Phase R2 — chatOnce now returns BOTH the visible body
 *  and any chain-of-thought the provider emitted alongside it. Reads the
 *  two field names different OpenAI-compatible APIs use:
 *    - `message.reasoning`         (OpenRouter, some DeepSeek variants)
 *    - `message.reasoning_content` (DashScope qwen, deepseek-reasoner on
 *                                   non-streamed responses)
 *  Both are stripped + trimmed; if both are populated, `reasoning` wins.
 *  Undefined when neither is set or both are empty. Callers that only
 *  care about the body destructure `{ content }`. */
export interface ChatOnceResult {
  content: string
  reasoning?: string
}

export async function chatOnce(
  messages: ChatCompletionMessageParam[],
  modelId: string,
  signal?: AbortSignal,
  audit?: ModelRequestAudit,
  opts?: {
    /** Tools to serialize into the request WITHOUT running a tool loop —
     *  needed when a one-shot must extend a tool-carrying request's prefix
     *  byte-for-byte (model compaction). tool_choice stays 'none' so the
     *  reply is text. */
    tools?: ChatCompletionTool[]
  }
): Promise<ChatOnceResult> {
  const desc = resolveModel(modelId)
  const client = getClientForProvider(desc.provider)
  const startedAt = Date.now()
  const traceId = randomUUID().slice(0, 8)
  const prefixTools = opts?.tools && opts.tools.length > 0 ? opts.tools : undefined
  trace('chatOnce.enter', {
    traceId,
    model: desc.id,
    apiModelId: desc.apiModelId,
    provider: desc.provider,
    purpose: audit?.purpose,
    role: audit?.role,
    conversationId: audit?.conversationId,
    parentSignalAborted: signal?.aborted ?? null,
    messageCount: messages.length,
    toolCount: prefixTools?.length ?? 0
  })
  emitModelRequestStarted(desc, audit, { streaming: false, toolCount: prefixTools?.length ?? 0 })
  try {
    const response = await client.chat.completions.create(
      {
        model: desc.apiModelId,
        messages: withPrefillCacheMarkers(messages, desc.apiModelId),
        ...(prefixTools && { tools: prefixTools, tool_choice: 'none' as const }),
        // OpenAI/Kimi reasoning models take max_completion_tokens, not max_tokens (same 400 as the
        // streaming path — this non-streaming path is title-gen / extraction).
        ...(desc.defaultMaxTokens != null &&
          (desc.provider === 'openai' || desc.provider === 'moonshot'
            ? { max_completion_tokens: desc.defaultMaxTokens }
            : { max_tokens: desc.defaultMaxTokens }))
      } as any,
      signal ? { signal } : undefined
    )
    const message = response.choices[0]?.message as
      | { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
      | undefined
    const content = message?.content || ''
    // Provider field-name variance — see ChatOnceResult docstring. Take
    // the first populated value; trim whitespace; treat empty as absent.
    const rawReasoning =
      (typeof message?.reasoning === 'string' && message.reasoning.length > 0
        ? message.reasoning
        : typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0
          ? message.reasoning_content
          : '') ?? ''
    const reasoning = rawReasoning.trim().length > 0 ? rawReasoning.trim() : undefined
    const finishReason = response.choices[0]?.finish_reason ?? undefined
    trace('chatOnce.complete', {
      traceId,
      durationMs: Date.now() - startedAt,
      contentLen: content.length,
      reasoningLen: reasoning?.length ?? 0,
      finishReason
    })
    emitModelRequestCompleted(desc, audit, {
      streaming: false,
      toolCount: 0,
      retryCount: 0,
      durationMs: Date.now() - startedAt,
      finishReason,
      cancelled: signal?.aborted ?? false,
      usage: normalizeUsage((response as { usage?: unknown }).usage) ?? undefined
    })
    // A served request is stronger evidence than any timer that this account is healthy again.
    noteProviderSuccess(desc.provider)
    return { content, reasoning }
  } catch (err) {
    // Non-streaming is where the CN gateways actually return their 402 JSON, so this is the most
    // reliable place a background pass (extraction, titles) learns an account is dry.
    if (isQuotaError(messageOf(err))) noteProviderRefusal(desc.provider, messageOf(err) || 'quota')
    trace('chatOnce.error', {
      traceId,
      durationMs: Date.now() - startedAt,
      errName: (err as { name?: string })?.name,
      errStatus: (err as { status?: number })?.status,
      errMessage: String(messageOf(err) ?? err).slice(0, 200),
      parentSignalAborted: signal?.aborted ?? null
    })
    emitModelRequestFailed(desc, audit, {
      streaming: false,
      toolCount: 0,
      retryCount: 0,
      durationMs: Date.now() - startedAt,
      cancelled: signal?.aborted ?? false,
      error: err
    })
    throw err
  }
}

export async function chatStream(
  messages: ChatCompletionMessageParam[],
  modelId: string,
  tools: ChatCompletionTool[] | undefined,
  callbacks: ChatStreamCallbacks,
  signal?: AbortSignal,
  params?: ChatStreamParams,
  audit?: ModelRequestAudit
): Promise<void> {
  // R2 — settle-once terminal dispatch. chatStream has many terminal sites
  // (clean done, cancelled, inactivity-exhausted, auth/other errors) plus a
  // setup phase that used to reject with NO terminal callback. Funnel every one
  // through these helpers so EXACTLY ONE terminal callback fires, and an async
  // onDone that throws becomes a single onError instead of an unhandled
  // rejection that leaves the caller's turn promise unsettled (chat hangs dead).
  let settled = false
  const settleDone = async (
    content: string,
    toolCalls: ToolCallAccumulator[] | undefined,
    reasoning: string | undefined,
    completion?: { finishReason?: string | null; usage?: NormalizedUsage }
  ): Promise<void> => {
    if (settled) return
    settled = true
    try {
      await callbacks.onDone(content, toolCalls, reasoning, completion)
    } catch (doneErr) {
      // onDone's own async work failed (e.g. SQLite persist / disk spill /
      // recursion threw). Its rejection would otherwise be unhandled and the
      // caller's turn promise would never settle. Route to onError exactly once
      // — `settled` is already true, so no other terminal site can fire.
      try {
        callbacks.onError(messageOf(doneErr) || 'Response handling failed', {
          content,
          reasoning
        })
      } catch (errErr) {
        console.error('[providers] onError threw handling onDone failure:', errErr)
      }
    }
  }
  const settleError = (
    message: string,
    partial?: { content: string; reasoning?: string }
  ): void => {
    if (settled) return
    settled = true
    // Symmetric with settleDone: a renderer onError can itself throw
    // (serialization, disposed webContents, a bug in the error toast). If that
    // throw escaped, it would propagate out of chatStream, reject the returned
    // promise, and — being unhandled — leave the caller's turn promise unsettled
    // (chat hangs dead), the exact failure this terminal dispatch prevents.
    try {
      callbacks.onError(message, partial)
    } catch (errErr) {
      console.error('[providers] onError threw in settleError:', errErr)
    }
  }

  let desc: ModelDescriptor
  let client: OpenAI
  let usableTools: ChatCompletionTool[] | undefined
  let offeredToolCount: number
  let startedAt: number
  let inactivityMs: number
  try {
    desc = resolveModel(modelId)
    client = getClientForProvider(desc.provider)
    // A2b: byte-stable tool ordering — the serialized list is request-prefix
    // content; a reshuffle (MCP reconnect order, pack registration order)
    // would bust the provider cache for every conversation at once.
    usableTools =
      desc.supportsTools && tools && tools.length > 0 ? sortToolsStable(tools) : undefined
    offeredToolCount = usableTools?.length ?? 0
    startedAt = Date.now()
    emitModelRequestStarted(desc, audit, {
      streaming: true,
      toolCount: offeredToolCount
    })
    inactivityMs = readStreamInactivityMs()
  } catch (setupErr) {
    // A setup-phase throw (unknown provider, missing API key, event-log wiring)
    // used to escape as a bare rejected promise with no terminal callback — the
    // caller's turn hung with no error. Route it to onError exactly once.
    settleError(messageOf(setupErr) || 'Failed to start model request', undefined)
    return
  }

  let fullContent = ''
  let fullReasoning = ''
  // Terminal-chunk finish_reason, retained across the chunk loop so the success
  // onDone can report truncation ('length') to structured-extraction callers.
  let lastFinishReason: string | null = null
  // A1 cache accounting: the final stream chunk's usage block (DeepSeek sends
  // one; OpenAI-compat providers send it when stream_options requests it).
  // Last write wins; normalized once at the terminal sites.
  let lastRawUsage: unknown = null
  const toolCallsAccumulator: Map<number, ToolCallAccumulator> = new Map()
  // R1 backstop also counts streamed tool-call ARGUMENT bytes. They accumulate
  // into toolCallsAccumulator (a separate structure from fullContent/
  // fullReasoning), so without this running tally a runaway tool-argument
  // stream would bypass the char cap entirely.
  let toolCallArgChars = 0
  let retries = 0
  const maxRetries = 3

  // DBG2 — per-call trace id so we can correlate every line in
  // lamprey-debug.log back to the same stream invocation.
  const traceId = randomUUID().slice(0, 8)
  trace('chatStream.enter', {
    traceId,
    model: desc.id,
    apiModelId: desc.apiModelId,
    provider: desc.provider,
    inactivityMs,
    toolCount: offeredToolCount,
    purpose: audit?.purpose,
    conversationId: audit?.conversationId
  })

  // T4 — vitals heartbeat. Fires every 2s while the attempt streams. Counters
  // reset on each retry so the renderer's "Ns since last chunk" reflects the
  // CURRENT attempt, not the cumulative attempt history.
  const VITALS_HEARTBEAT_MS = 2_000
  let vitalsTimer: ReturnType<typeof setInterval> | null = null
  let lastChunkAt = 0
  let chunkCount = 0
  let attemptStartedAt = Date.now()
  const startVitalsHeartbeat = (): void => {
    if (!callbacks.onVitals) return
    if (vitalsTimer) clearInterval(vitalsTimer)
    vitalsTimer = setInterval(() => {
      try {
        const now = Date.now()
        const tokenEstimate = Math.round(
          (fullContent.length + fullReasoning.length) / 4
        )
        callbacks.onVitals?.({
          lastChunkAt,
          msSinceLastChunk: lastChunkAt === 0 ? now - attemptStartedAt : now - lastChunkAt,
          chunkCount,
          tokenEstimate,
          attemptElapsedMs: now - attemptStartedAt
        })
      } catch (err) {
        console.warn('[providers] vitals heartbeat threw:', err)
      }
    }, VITALS_HEARTBEAT_MS)
  }
  const stopVitalsHeartbeat = (): void => {
    if (vitalsTimer) {
      clearInterval(vitalsTimer)
      vitalsTimer = null
    }
  }

  while (retries <= maxRetries) {
    // RETRY CORRECTNESS: reset the per-attempt accumulators before a retry so the
    // regenerated response replaces the previous attempt instead of appending a
    // second full copy onto its partial (and concatenating tool-call JSON args
    // into invalid arguments that break the next tool round).
    if (retries > 0) {
      fullContent = ''
      fullReasoning = ''
      toolCallsAccumulator.clear()
      toolCallArgChars = 0
      // A stale usage chunk from the failed attempt must not be attributed
      // to this attempt's completion (or fed to the regression signal).
      lastRawUsage = null
    }
    // T1 — Per-attempt controller. User-signal aborts route through this;
    // the inactivity timer also fires it. We use the `inactivityFired` flag
    // to disambiguate inactivity-abort from user-cancel in the catch.
    const attemptController = new AbortController()
    let inactivityFired = false
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null

    const clearInactivityTimer = (): void => {
      if (inactivityTimer) {
        clearTimeout(inactivityTimer)
        inactivityTimer = null
      }
    }
    const armInactivityTimer = (): void => {
      if (inactivityMs <= 0) {
        trace('chatStream.watchdog.disabled', { traceId, retries, reason: 'inactivityMs<=0' })
        return
      }
      clearInactivityTimer()
      const armedAt = Date.now()
      inactivityTimer = setTimeout(() => {
        const elapsed = Date.now() - armedAt
        trace('chatStream.watchdog.fired', {
          traceId,
          retries,
          inactivityMs,
          actualElapsedMs: elapsed,
          chunkCount,
          fullContentLen: fullContent.length,
          fullReasoningLen: fullReasoning.length
        })
        inactivityFired = true
        attemptController.abort()
        trace('chatStream.watchdog.abort-called', {
          traceId,
          attemptControllerAborted: attemptController.signal.aborted
        })
      }, inactivityMs)
    }

    const onUserAbort = (): void => attemptController.abort()
    if (signal) {
      if (signal.aborted) attemptController.abort()
      else signal.addEventListener('abort', onUserAbort, { once: true })
    }

    try {
      attemptStartedAt = Date.now()
      lastChunkAt = 0
      chunkCount = 0
      startVitalsHeartbeat()
      armInactivityTimer()
      trace('chatStream.attempt.start', { traceId, retries, attemptStartedAt })
      // R1 — max_tokens is ALWAYS sent. Caller override wins; else the model's
      // catalog default; else the module floor DEFAULT_OUTPUT_TOKENS. Without
      // this, the 39/42 models with no defaultMaxTokens sent no cap at all and
      // generation ran unbounded. (Models that already set defaultMaxTokens are
      // unchanged.) `?? ` treats an explicit `maxTokens: null` as "use default".
      // DUIN_MAX_OUTPUT_TOKENS, when set, OUTRANKS the catalog default. It used to sit last in
      // the `??` chain, so it only reached the models that set no default — i.e. it did nothing
      // for the ones whose cap an operator would actually want to raise, including the shipped
      // default chat model. There was then no env or settings knob that could raise the
      // per-response cap on the default path at all; it took a code edit. The catalog value
      // remains the researched per-model default when the env is unset.
      const effectiveMaxTokens =
        params?.maxTokens ?? ENV_OUTPUT_TOKENS ?? desc.defaultMaxTokens ?? DEFAULT_OUTPUT_TOKENS

      // Fix B — cap reasoning effort for reasoning models on EVERY turn (not
      // just tool-use). Extended chain-of-thought is the dominant chat latency:
      // we've logged 20-33k reasoning chars on a single turn, so the model
      // "thinks" for 30s-2min before the first answer token. reasoning_effort:
      // 'low' keeps grounded chat responsive. (Only applies to catalog reasoning
      // models — Ollama is untouched, so local chat can't be broken by this.)
      // The default stays 'low' (preserves the responsive-chat behavior above);
      // the caller can raise it per request via params.reasoningEffort.
      // The OpenAI-compatible `reasoning_effort` enum tops out at 'high'. 'max' is
      // a DUIN-internal tier meaning "the provider's ceiling", so it maps to 'high'
      // here — sending a literal 'max' would 400 on strict providers (o-series etc.).
      // Two provider families deviate from the generic OpenAI-compat body:
      //  - The REAL OpenAI reasoning API (gpt-5.x/o-series) AND Moonshot's Kimi require
      //    `max_completion_tokens` and 400 on `max_tokens`, and reject non-default sampling on a
      //    reasoning model. That unconditional `max_tokens` + a user temperature is a 400 before
      //    any token streams (the reported Kimi break; latent for OpenAI until a key is added).
      //  - Kimi additionally has a wider reasoning_effort set {low,high,max}: it ACCEPTS 'max'
      //    (unlike the o-series ceiling of 'high') and rejects the app-only 'medium'.
      // All confirmed against each provider's docs 2026-08-21. The OpenAI-COMPAT providers
      // (deepseek/zhipu/dashscope/xai/google/anthropic-compat/…) keep the classic max_tokens.
      const isMoonshot = desc.provider === 'moonshot'
      const usesCompletionTokenParam = desc.provider === 'openai' || isMoonshot
      const requested = params?.reasoningEffort ?? 'low'
      // Non-moonshot: 'max' is a DUIN-internal "provider ceiling" that o-series reject → map to
      // 'high'. Moonshot: pass low/high/max through, but coerce the app-only 'medium' (not in
      // Kimi's set) to 'high'.
      const wireEffort = isMoonshot
        ? requested === 'medium'
          ? 'high'
          : requested
        : requested === 'max'
          ? 'high'
          : requested
      const reasoningCap = modelSupportsReasoningEffort(desc)
        ? { reasoning_effort: wireEffort }
        : {}

      // Hybrid reasoners (GLM-4.5, DeepSeek-V4, Qwen3) "think" by default — reasoning_content fills up
      // and `content` comes back empty/truncated on batch JSON. Descriptors flagged disableThinking get
      // their provider's thinking-OFF wire param so extraction gets the answer directly.
      const thinkingParam = desc.disableThinking ? thinkingDisableParams(desc.provider) : {}

      const stream = await client.chat.completions.create(
        {
          model: desc.apiModelId,
          messages: withPrefillCacheMarkers(messages, desc.apiModelId),
          stream: true,
          // A1 cache accounting: ask for the terminal usage chunk where the
          // provider is verified to accept the option; others may 400 on
          // unknown params and still get opportunistic chunk.usage capture.
          ...(providerStreamsUsage(desc.provider) && {
            stream_options: { include_usage: true }
          }),
          tools: usableTools,
          // OpenAI/Kimi reasoning models reject non-default sampling — sending a temperature/top_p
          // they don't accept 400s the turn. Omit both for that family; every other provider keeps
          // the user's configured values.
          ...(!usesCompletionTokenParam && params?.temperature !== undefined && { temperature: params.temperature }),
          ...(!usesCompletionTokenParam && params?.topP !== undefined && { top_p: params.topP }),
          // R1 (Phase-1): always send an explicit output-token cap — effectiveMaxTokens is
          // guaranteed non-null (…?? DEFAULT_OUTPUT_TOKENS), so keep it unconditional; do NOT
          // weaken to a `!= null` guard (runaway backstop). The OpenAI/Kimi reasoning family needs
          // `max_completion_tokens`; `max_tokens` 400s it (the Kimi break, latent for OpenAI).
          ...(usesCompletionTokenParam
            ? { max_completion_tokens: effectiveMaxTokens }
            : { max_tokens: effectiveMaxTokens }),
          ...reasoningCap,
          ...thinkingParam
        } as any,
        { signal: attemptController.signal }
      )
      trace('chatStream.sdk.stream-resolved', {
        traceId,
        retries,
        delayMs: Date.now() - attemptStartedAt
      })

      // DBG2 — manual iteration so we can log each .next() lifecycle and
      // see whether the hang lives at iterator.next or at chunk-process.
      const iter = (stream as unknown as AsyncIterable<any>)[Symbol.asyncIterator]()
      let iterIndex = 0
      while (true) {
        const nextStartedAt = Date.now()
        trace('chatStream.iter.next.await', {
          traceId,
          retries,
          iterIndex,
          msSinceLastChunk: lastChunkAt === 0 ? null : nextStartedAt - lastChunkAt,
          inactivityFired,
          attemptControllerAborted: attemptController.signal.aborted,
          parentSignalAborted: signal?.aborted ?? null
        })
        let iterResult: IteratorResult<any>
        try {
          iterResult = await iter.next()
        } catch (iterErr) {
          trace('chatStream.iter.next.throw', {
            traceId,
            retries,
            iterIndex,
            waitMs: Date.now() - nextStartedAt,
            errName: (iterErr as { name?: string })?.name,
            errMessage: String(messageOf(iterErr) ?? iterErr).slice(0, 200),
            inactivityFired,
            attemptControllerAborted: attemptController.signal.aborted,
            parentSignalAborted: signal?.aborted ?? null
          })
          throw iterErr
        }
        trace('chatStream.iter.next.resolved', {
          traceId,
          retries,
          iterIndex,
          waitMs: Date.now() - nextStartedAt,
          done: iterResult.done,
          hasValue: iterResult.value !== undefined
        })
        if (iterResult.done) break
        const chunk = iterResult.value
        if (chunk?.usage) lastRawUsage = chunk.usage
        iterIndex++
        clearInactivityTimer()
        lastChunkAt = Date.now()
        chunkCount++
        if (signal?.aborted) {
          stopVitalsHeartbeat()
          await settleDone(
            fullContent + ' [cancelled]',
            undefined,
            fullReasoning || undefined
          )
          emitModelRequestCompleted(desc, audit, {
            streaming: true,
            toolCount: offeredToolCount,
            retryCount: retries,
            durationMs: Date.now() - startedAt,
            cancelled: true,
            emittedToolCallCount: toolCallsAccumulator.size
          })
          return
        }

        const delta = chunk.choices[0]?.delta as
          | (typeof chunk.choices[0]['delta'] & {
              reasoning_content?: string | null
              reasoning?: string | null
            })
          | undefined

        let chunkKind: string = 'empty'
        if (delta?.content) {
          chunkKind = 'content'
          fullContent += delta.content
          // Awaited so a caller can backpressure (await socket drain) here; a
          // sync `void`-returning callback resolves immediately (no change).
          // A throw here is a CALLER bug, not a provider fault — tag it so the
          // outer catch routes it to a single terminal onError without retrying
          // (re-issuing the request can't fix a renderer bug, only duplicates it).
          try {
            await callbacks.onChunk(delta.content)
          } catch (cbErr) {
            throw new CallbackError(cbErr)
          }
        }

        // DeepSeek reasoners + V4-Flash thinking-mode emit chain-of-thought
        // on `delta.reasoning_content`. OpenRouter normalizes the same channel
        // to `delta.reasoning`. Forward whichever the provider sends so the
        // renderer can show a live "thinking…" block.
        // Stripped at ingest: the reasoning card renders markdown, not a
        // terminal, so an escape reaching it shows up as literal text (an
        // unstripped `ESC[1m` rendered as "1m"). This is also the value
        // accumulated into fullReasoning and persisted, so stripping here keeps
        // escapes out of SQLite as well as out of the DOM.
        const reasoningDelta = stripAnsi(
          (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) ||
            (typeof delta?.reasoning === 'string' && delta.reasoning) ||
            ''
        )
        if (reasoningDelta) {
          chunkKind = chunkKind === 'content' ? 'content+reasoning' : 'reasoning'
          fullReasoning += reasoningDelta
          // Same as onChunk: a throw is a caller bug — tag it as non-retryable.
          try {
            await callbacks.onReasoning?.(reasoningDelta)
          } catch (cbErr) {
            throw new CallbackError(cbErr)
          }
        }

        if (delta?.tool_calls) {
          chunkKind = chunkKind === 'empty' ? 'tool_call' : chunkKind + '+tool_call'
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsAccumulator.has(idx)) {
              toolCallsAccumulator.set(idx, {
                id: tc.id || '',
                type: 'function',
                function: { name: '', arguments: '' }
              })
            }
            const acc = toolCallsAccumulator.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.function.name = tc.function.name
            if (tc.function?.arguments) {
              acc.function.arguments += tc.function.arguments
              toolCallArgChars += tc.function.arguments.length
            }
          }
        }
        const chunkFinishReason = chunk.choices?.[0]?.finish_reason ?? null
        if (chunkFinishReason) lastFinishReason = chunkFinishReason

        // R1 hard backstop — protect against a provider that ignores max_tokens
        // or streams unbounded reasoning/tool-call arguments. The inactivity
        // watchdog re-arms on every chunk, so a steady char-by-char stream never
        // trips it; this char cap is the terminal guard. Tool-call arguments
        // accumulate in a separate structure, so they are tallied into
        // toolCallArgChars and summed here too — otherwise a runaway tool-call
        // argument stream would bypass the cap entirely. Runs AFTER tool-call
        // accumulation so this chunk's arg bytes are already counted. Abort the
        // attempt, mark the finish reason truncated, and break to the normal
        // onDone dispatch below with whatever had accumulated.
        if (
          fullContent.length + fullReasoning.length + toolCallArgChars >
          MAX_OUTPUT_CHARS
        ) {
          trace('chatStream.output-char-backstop', {
            traceId,
            retries,
            chunkCount,
            fullContentLen: fullContent.length,
            fullReasoningLen: fullReasoning.length,
            toolCallArgChars,
            maxOutputChars: MAX_OUTPUT_CHARS
          })
          lastFinishReason = 'length'
          attemptController.abort()
          break
        }
        trace('chatStream.chunk.processed', {
          traceId,
          retries,
          iterIndex,
          chunkKind,
          chunkCount,
          contentDeltaLen: delta?.content?.length ?? 0,
          reasoningDeltaLen: reasoningDelta.length,
          finishReason: chunkFinishReason
        })
        armInactivityTimer()
      }

      trace('chatStream.iter.done', {
        traceId,
        retries,
        chunkCount,
        contentLen: fullContent.length,
        reasoningLen: fullReasoning.length,
        toolCalls: toolCallsAccumulator.size
      })
      clearInactivityTimer()
      stopVitalsHeartbeat()
      if (signal) signal.removeEventListener('abort', onUserAbort)

      const toolCalls = toolCallsAccumulator.size > 0
        ? Array.from(toolCallsAccumulator.values())
        : undefined

      // A1 cache accounting: normalize + observe BEFORE settleDone —
      // settleDone's onDone recurses into the NEXT tool round, so anything
      // after it runs innermost-round-first and the regression signal would
      // see a multi-round turn in reverse order (leaving round 0's small
      // prompt as `prev` → false alarms right after a legitimate
      // compaction shrink). Keyed observations only: conversationless
      // one-shot callers (title-gen, extract agents) share no layout, so
      // feeding them to one per-model key would turn the signal to noise.
      const streamUsage = normalizeUsage(lastRawUsage)
      if (streamUsage && audit?.conversationId) {
        const cacheSignal = cacheSignalTracker.observe(audit.conversationId, streamUsage)
        if (cacheSignal.regressed) {
          console.warn('[providers] prefix-cache regression: ' + cacheSignal.reason)
        }
      }
      await settleDone(fullContent, toolCalls, fullReasoning || undefined, {
        finishReason: lastFinishReason,
        usage: streamUsage ?? undefined
      })
      emitModelRequestCompleted(desc, audit, {
        streaming: true,
        toolCount: offeredToolCount,
        retryCount: retries,
        durationMs: Date.now() - startedAt,
        cancelled: false,
        finishReason: lastFinishReason ?? undefined,
        emittedToolCallCount: toolCalls?.length ?? 0,
        usage: streamUsage ?? undefined
      })
      return
    } catch (err) {
      clearInactivityTimer()
      stopVitalsHeartbeat()
      if (signal) signal.removeEventListener('abort', onUserAbort)

      trace('chatStream.catch.entered', {
        traceId,
        retries,
        errName: (err as { name?: string })?.name,
        errStatus: (err as { status?: number })?.status,
        errMessage: String(messageOf(err) ?? err).slice(0, 200),
        inactivityFired,
        parentSignalAborted: signal?.aborted ?? null,
        attemptControllerAborted: attemptController.signal.aborted,
        chunkCount,
        fullContentLen: fullContent.length,
        fullReasoningLen: fullReasoning.length
      })

      // User-cancelled — the attempt controller was fired by the user signal,
      // not the watchdog. Treat as a clean cancellation regardless of which
      // error the SDK threw on the way out.
      if (signal?.aborted) {
        await settleDone(
          fullContent + ' [cancelled]',
          undefined,
          fullReasoning || undefined
        )
        emitModelRequestCompleted(desc, audit, {
          streaming: true,
          toolCount: offeredToolCount,
          retryCount: retries,
          durationMs: Date.now() - startedAt,
          cancelled: true,
          emittedToolCallCount: toolCallsAccumulator.size
        })
        return
      }

      // Caller-callback bug (onChunk / onReasoning threw). This is NOT a
      // provider fault: retrying re-issues the identical LLM request (duplicate
      // billing + duplicate side effects) and cannot fix a renderer-side bug.
      // Route to a single terminal onError and stop — no retry, no misdiagnosis
      // as a provider "Unknown error".
      if (err instanceof CallbackError) {
        trace('chatStream.exit.callback-error', {
          traceId,
          retries,
          errMessage: String(messageOf(err.cause) ?? err.cause).slice(0, 200)
        })
        settleError(messageOf(err.cause) || 'Response streaming callback failed', {
          content: fullContent,
          reasoning: fullReasoning || undefined
        })
        emitModelRequestFailed(desc, audit, {
          streaming: true,
          toolCount: offeredToolCount,
          retryCount: retries,
          durationMs: Date.now() - startedAt,
          cancelled: false,
          error: err.cause
        })
        return
      }

      // Inactivity watchdog fired. Treat like a transient network error:
      // retry up to maxRetries with the same back-off, then emit a clearly
      // labeled error so the user knows the provider stalled (not bad code).
      if (inactivityFired) {
        if (retries < maxRetries) {
          retries++
          const delay = Math.pow(2, retries) * 1000
          trace('chatStream.retry.inactivity', { traceId, retries, backoffMs: delay })
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        const stallErr = new StreamInactivityError(inactivityMs)
        trace('chatStream.exit.inactivity-exhausted', {
          traceId,
          retries,
          inactivityMs,
          contentLen: fullContent.length,
          reasoningLen: fullReasoning.length
        })
        settleError(stallErr.message, {
          content: fullContent,
          reasoning: fullReasoning || undefined
        })
        emitModelRequestFailed(desc, audit, {
          streaming: true,
          toolCount: offeredToolCount,
          retryCount: retries,
          durationMs: Date.now() - startedAt,
          cancelled: false,
          error: stallErr
        })
        return
      }

      if ((err as { status?: number })?.status === 401 || (err as { status?: number })?.status === 403) {
        settleError(
          `Invalid ${PROVIDERS[desc.provider].label} API key`,
          { content: fullContent, reasoning: fullReasoning || undefined }
        )
        emitModelRequestFailed(desc, audit, {
          streaming: true,
          toolCount: offeredToolCount,
          retryCount: retries,
          durationMs: Date.now() - startedAt,
          cancelled: false,
          error: err,
          httpStatus: (err as { status?: number })?.status
        })
        return
      }

      // 429 covers two unrelated conditions and only one of them is worth waiting out.
      // A rate limit clears on its own, so back off and retry. An EMPTY BALANCE does not —
      // it will still be empty in eight seconds — so retrying it only spends the user's
      // time in silence before surfacing the same error. Observed cost: a dry Zhipu key
      // burned ~14s per call across four attempts while the UI showed nothing streaming.
      if (
        (err as { status?: number })?.status === 429 &&
        retries < maxRetries &&
        !isBalanceError(messageOf(err))
      ) {
        retries++
        const delay = Math.pow(2, retries) * 1000
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      // Same reasoning as the 429 branch above, and it has to be repeated here because this is
      // the branch the empty-balance case actually TAKES. CN gateways report arrears in the body
      // of a status-less throw (see quota-error.ts) — no 429, no 402 — so the guard one branch up
      // never sees them, and a dry key burned the full 2+4+8s of backoff in silence before
      // surfacing an error that was never going to clear.
      if (
        retries < maxRetries &&
        !(err as { status?: number })?.status &&
        !isBalanceError(messageOf(err))
      ) {
        retries++
        const delay = Math.pow(2, retries) * 1000
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      // A status-less error that exhausted its retries before any content streamed is USUALLY a
      // real network problem — but some gateways (observed live: DeepSeek on an empty account,
      // 2026-08-24) RESET the STREAMING endpoint instead of returning the 402 JSON their
      // non-stream endpoint serves. The SDK then surfaces only its generic "Connection error.",
      // which (a) reads as a network bug and hides the one condition the operator can actually
      // fix, and (b) never matches isProviderFailoverError, so the answer path's cross-provider
      // fallback — and its "top up or add another key" exhaustion message — never fire. Before
      // surfacing the generic error, ask the SAME provider for a 1-token non-stream completion:
      // if THAT throws a quota/billing error, surface the real error instead. Any other probe
      // outcome (success, timeout, another connection error) keeps the original message.
      let finalErrMsg = messageOf(err) || 'Unknown error'
      if (!(err as { status?: number })?.status && !fullContent && !isQuotaError(finalErrMsg)) {
        try {
          await client.chat.completions.create(
            {
              model: desc.apiModelId,
              messages: [{ role: 'user', content: 'ping' }],
              stream: false,
              ...(desc.provider === 'openai' || desc.provider === 'moonshot'
                ? { max_completion_tokens: 1 }
                : { max_tokens: 1 })
            } as never,
            { maxRetries: 0, timeout: 8000 }
          )
        } catch (probeErr) {
          const probeMsg = messageOf(probeErr) || ''
          if (isQuotaError(probeMsg)) finalErrMsg = probeMsg
        }
      }
      // Park the ACCOUNT, not the model: a quota/billing refusal says nothing about which model
      // was asked, and everything about whether this provider can serve anything right now. Every
      // later automatic route (extraction, titles, workflows) steps over it until it recovers.
      if (isQuotaError(finalErrMsg)) noteProviderRefusal(desc.provider, finalErrMsg)
      settleError(
        finalErrMsg,
        { content: fullContent, reasoning: fullReasoning || undefined }
      )
      emitModelRequestFailed(desc, audit, {
        streaming: true,
        toolCount: offeredToolCount,
        retryCount: retries,
        durationMs: Date.now() - startedAt,
        cancelled: false,
        error: err,
        httpStatus: (err as { status?: number })?.status
      })
      return
    }
  }
}

// ──────────────────── model-request audit helpers ────────────────────

// Producers for `model.request.*` events. The handlers above call these at
// every terminal point — clean completion, signal-cancelled mid-stream,
// non-retryable error, retries-exhausted error. The wrapper try/catches keep
// the chat path resilient: any event-log failure must not poison the
// response we hand back to chat.ts.

interface ModelRequestStartedOptions {
  streaming: boolean
  toolCount: number
}

function emitModelRequestStarted(
  desc: ModelDescriptor,
  audit: ModelRequestAudit | undefined,
  opts: ModelRequestStartedOptions
): void {
  if (!audit) return
  try {
    recordEvent({
      type: 'model.request.started',
      actorKind: 'system',
      conversationId: audit.conversationId,
      correlationId: audit.correlationId,
      entityKind: 'model',
      entityId: desc.id,
      payload: {
        provider: desc.provider,
        model: desc.id,
        apiModelId: desc.apiModelId,
        streaming: opts.streaming,
        toolCount: opts.toolCount,
        role: audit.role,
        purpose: audit.purpose ?? 'main'
      }
    })
  } catch (err) {
    console.error('[providers] model.request.started event failed:', err)
  }
}

interface ModelRequestCompletedOptions {
  streaming: boolean
  toolCount: number
  retryCount: number
  durationMs: number
  cancelled: boolean
  finishReason?: string
  emittedToolCallCount?: number
  /** A1 cache accounting — disjoint token buckets from usage-accounting.ts. */
  usage?: NormalizedUsage
}

function emitModelRequestCompleted(
  desc: ModelDescriptor,
  audit: ModelRequestAudit | undefined,
  opts: ModelRequestCompletedOptions
): void {
  if (!audit) return
  try {
    recordEvent({
      type: 'model.request.completed',
      actorKind: 'model',
      severity: opts.cancelled ? 'warning' : 'info',
      conversationId: audit.conversationId,
      correlationId: audit.correlationId,
      entityKind: 'model',
      entityId: desc.id,
      payload: {
        provider: desc.provider,
        model: desc.id,
        apiModelId: desc.apiModelId,
        streaming: opts.streaming,
        toolCount: opts.toolCount,
        emittedToolCallCount: opts.emittedToolCallCount ?? 0,
        retryCount: opts.retryCount,
        durationMs: opts.durationMs,
        cancelled: opts.cancelled,
        finishReason: opts.finishReason,
        role: audit.role,
        purpose: audit.purpose ?? 'main',
        // Disjoint buckets: uncached input + cacheRead (+cacheWrite) = billed
        // prompt. Absent when the provider returned no usage.
        ...(opts.usage && { usage: opts.usage })
      }
    })
  } catch (err) {
    console.error('[providers] model.request.completed event failed:', err)
  }
}

interface ModelRequestFailedOptions {
  streaming: boolean
  toolCount: number
  retryCount: number
  durationMs: number
  cancelled: boolean
  error: unknown
  httpStatus?: number
}

function emitModelRequestFailed(
  desc: ModelDescriptor,
  audit: ModelRequestAudit | undefined,
  opts: ModelRequestFailedOptions
): void {
  if (!audit) return
  try {
    const err = opts.error as { message?: string; name?: string } | undefined
    recordEvent({
      type: 'model.request.failed',
      actorKind: 'model',
      severity: 'error',
      conversationId: audit.conversationId,
      correlationId: audit.correlationId,
      entityKind: 'model',
      entityId: desc.id,
      payload: {
        provider: desc.provider,
        model: desc.id,
        apiModelId: desc.apiModelId,
        streaming: opts.streaming,
        toolCount: opts.toolCount,
        retryCount: opts.retryCount,
        durationMs: opts.durationMs,
        httpStatus: opts.httpStatus,
        cancelled: opts.cancelled,
        errorClass: (err as { name?: string })?.name,
        errorPreview: boundedJsonPreview(messageOf(err)),
        role: audit.role,
        purpose: audit.purpose ?? 'main'
      }
    })
  } catch (e) {
    console.error('[providers] model.request.failed event failed:', e)
  }
}
