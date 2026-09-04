// Provider error classification — ONE verdict shape (`ClassifiedProviderError`, roles.ts) read by the
// failover walk, the health probe, the transcript notice and the UI.
//
// Provider-agnostic BY DESIGN — matches the common wording across the OpenAI-compatible gateways
// DUIN speaks to (DeepSeek / Zhipu / OpenAI / Anthropic-compat / …), so no provider is special-cased
// and any user's key mix benefits.
//
// Pure + unit-tested. The legacy string predicates (`isQuotaError`, `isBalanceError`,
// `isModelNotFoundError`, `isCredentialError`) stay because ~20 call sites read them; the classifier
// below is built on top of them, so the two can never disagree about a string.
//
// LIMITS: classification is by HTTP status + wording. A gateway that returns 200 with an in-body
// error, or a 400 with no recognisable wording, classifies as `unknown` — which is NOT a failover
// class (another provider cannot be assumed to fix it) unless the status is 5xx.

import type { ClassifiedProviderError, ProviderHealthReason } from './roles'
import { providerFixHint } from './roles'
import type { ProviderId } from './registry'

export function isQuotaError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    /(^|[^0-9])(402|429)([^0-9]|$)/.test(m) || // HTTP status for payment-required / too-many-requests
    m.includes('insufficient balance') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient quota') ||
    m.includes('exceeded your current quota') ||
    m.includes('quota exceeded') ||
    m.includes('rate limit') ||
    m.includes('rate_limit') ||
    m.includes('ratelimit') ||
    m.includes('payment required') ||
    m.includes('billing') ||
    m.includes('arrears') || // some CN gateways word an empty balance this way
    // CN-worded balance/quota errors thrown status-less by OpenAI-compatible CN
    // gateways (Zhipu / OneAI / DeepSeek): "余额不足" / "账户余额不足" / "欠费" /
    // "额度不足" / "配额". These carry no 402/429 token and no English phrase, so
    // without them a dry CN key hard-fails the turn instead of failing over.
    // NOTE: this does NOT cover the HTTP-200/no-throw case (an SSE stream that
    // completes with an in-body error but never throws) — that must be handled
    // at the empty-onDone site, since isQuotaError is never called there.
    m.includes('余额不足') ||
    m.includes('账户余额') ||
    m.includes('欠费') ||
    m.includes('额度不足') ||
    m.includes('配额')
  )
}

/**
 * A quota error specifically about an EMPTY ACCOUNT rather than throughput.
 *
 * Deliberately NARROWER than `isQuotaError`, which also matches rate limits. The distinction is
 * about whether WAITING helps: a rate-limit 429 clears on its own and is correct to retry; a
 * "top up your balance" 429 will still be there in eight seconds, so retrying it just burns the
 * user's time. `chatStream` previously retried every 429 alike, which turned a dry key into ~14s
 * of silent backoff per call — the "the model isn't streaming anything" symptom, with no error
 * shown until every attempt had been spent.
 *
 * Must NOT match rate-limit / overloaded / too-many-requests wording, or legitimate transient
 * throttling would stop being retried.
 */
export function isBalanceError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  // Throughput wording wins: some gateways mention both, and retrying is the safer read.
  if (/rate.?limit|overload|too many requests|try again later|请稍后|频率|限流/.test(m)) return false
  return (
    m.includes('insufficient balance') ||
    m.includes('insufficient_quota') ||
    m.includes('insufficient quota') ||
    m.includes('exceeded your current quota') ||
    m.includes('quota exceeded') ||
    m.includes('payment required') ||
    m.includes('arrears') ||
    m.includes('billing') ||
    m.includes('credit balance') ||
    m.includes('no credits') ||
    // CN gateways (Zhipu / DeepSeek / OneAI) word a dry account this way. Observed verbatim:
    // "429 余额不足或无可用资源包,请充值。"
    m.includes('余额不足') ||
    m.includes('账户余额') ||
    m.includes('欠费') ||
    m.includes('额度不足') ||
    m.includes('充值')
  )
}

// Stale / unknown model id — the shipped catalog carries a speculative model id the provider does
// NOT (yet) serve, or an id that was retired. Distinct from quota: retrying the SAME id never
// recovers, but a DIFFERENT id (same or another keyed provider) will. Fires pre-stream in the same
// answer-path fallback loop as isQuotaError.
//
// Deliberately LIBERAL: a positive here only triggers a re-route to another catalog model (a safe
// degradation), so a false positive costs at most one extra provider hop — never a wrong answer. A
// bare 404 from an OpenAI-compatible /chat/completions call is, in practice, an unrecognized model
// id (a wrong-endpoint 404 would surface earlier). `resilience.ts` already classes 404 as permanent
// (non-retryable on the same target), which is exactly why the loop must re-TARGET rather than retry.
export function isModelNotFoundError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  return (
    /(^|[^0-9])404([^0-9]|$)/.test(m) ||
    m.includes('model_not_found') ||
    m.includes('model not found') ||
    m.includes('does not exist') || // OpenAI: "The model `x` does not exist or you do not have access"
    m.includes('no such model') ||
    m.includes('unknown model') ||
    m.includes('invalid model') ||
    m.includes('is not a valid model') ||
    m.includes('not a valid model') ||
    m.includes('model is not supported') ||
    m.includes('unsupported model') ||
    m.includes('模型不存在') || // CN gateways (Zhipu / DeepSeek / OneAI)
    m.includes('无效的模型') ||
    m.includes('不支持的模型')
  )
}

/**
 * The provider will not accept our CREDENTIAL: absent, wrong, revoked, or wrong-region.
 *
 * MEASURED FAILURE, 2026-08-26. An operator on Claude Fable 5 hit an empty Anthropic
 * balance, the turn correctly failed over to OpenAI — and then stopped dead on "invalid
 * OpenAI key", with other working providers still untried. Cause: this class did not
 * exist. `isProviderFailoverError` was quota OR unknown-model, and a 401 is neither, so
 * the answer path took the hard-fail branch on the SECOND provider and never reached the
 * third.
 *
 * MEASURED AGAIN, 2026-09-02 (L6 F1 / S1). The class existed but did not match the app's OWN
 * synthesized string: registry.ts turned every 401/403 into `Invalid <Label> API key`, and
 * "invalid openai api key" contains none of the phrases below — so 24/24 non-DeepSeek turns
 * hard-failed one hop before the only funded provider. The synthesis is gone (see
 * `formatProviderError`), and the legacy shape is matched here anyway so an old journal line or
 * a third-party gateway echoing it still fails over.
 *
 * Wrong-region counts, and is not hypothetical: a Moonshot `.cn` key returns
 * "Invalid Authentication" against `api.moonshot.ai` while serving 200 against
 * `api.moonshot.cn` — same key, same account, different platform.
 *
 * Deliberately does NOT match content/policy refusals. Those are about the REQUEST, and
 * another provider would refuse it too — failing over would just spend a second call to
 * be told the same thing.
 */
export function isCredentialError(msg: string | null | undefined): boolean {
  if (!msg) return false
  const m = msg.toLowerCase()
  // A policy refusal can carry a 403; it is about the request, not the key.
  if (/content.?policy|content.?filter|safety|moderation|violat/.test(m)) return false
  return (
    /(^|[^0-9])401([^0-9]|$)/.test(m) ||
    /invalid .{0,40}api key/.test(m) || // the legacy synthesized "Invalid OpenAI API key" shape
    m.includes('invalid authentication') ||
    m.includes('invalid api key') ||
    m.includes('invalid_api_key') ||
    m.includes('incorrect api key') ||
    m.includes('invalid bearer token') ||
    m.includes('authentication_error') ||
    m.includes('authentication error') ||
    m.includes('authentication fails') ||
    m.includes('unauthorized') ||
    m.includes('no api key') ||
    m.includes('api key not configured') ||
    m.includes('missing api key') ||
    m.includes('api key is required') ||
    // CN gateways word a rejected credential this way.
    m.includes('令牌无效') ||
    m.includes('鉴权失败') ||
    m.includes('认证失败') ||
    m.includes('无效的令牌') ||
    m.includes('密钥无效') ||
    m.includes('api key 无效')
  )
}

// ── The classifier ──────────────────────────────────────────────────────────────────────────

/** Reasons another provider can be expected to fix. `unknown` is NOT one of them: only a 5xx
 *  status makes an unclassified failure eligible (see `isProviderFailoverError`). */
const FAILOVER_REASONS: ReadonlySet<ProviderHealthReason> = new Set<ProviderHealthReason>([
  'no-credit',
  'unauthorized',
  'model-access',
  'rate-limit',
  'not-found',
  'network'
])

const REASON_TOKENS: readonly ProviderHealthReason[] = [
  'ok',
  'no-key',
  'no-credit',
  'unauthorized',
  'model-access',
  'rate-limit',
  'not-found',
  'network',
  'unknown'
]

const NETWORK_CODES = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+|ERR_NETWORK|ABORT_ERR)$/
const NETWORK_WORDING =
  /fetch failed|connection error|network error|socket hang up|getaddrinfo|ECONN[A-Z]*|ETIMEDOUT|ENOTFOUND|timed? ?out|stalled|unreachable|dns/i
const MODEL_ACCESS_WORDING =
  /does not have access|do not have access|no access|not (?:have )?access|model|permission|not allowed|scope|entitle|unsupported_country|region|organization must be verified/i
const POLICY_WORDING = /content.?policy|content.?filter|safety|moderation|violat/i
const SERVER_WORDING = /internal server error|bad gateway|service unavailable|gateway time.?out|overloaded|server error/i

function bounded(text: string, max = 200): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null
  for (const v of [e?.status, e?.statusCode, e?.response?.status]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 100 && v <= 599) return v
  }
  return undefined
}

function codeOf(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown }; name?: unknown } | null
  const c = typeof e?.code === 'string' ? e.code : typeof e?.cause?.code === 'string' ? e.cause.code : ''
  return c
}

function nameOf(err: unknown): string {
  const e = err as { name?: unknown; cause?: { name?: unknown } } | null
  return typeof e?.name === 'string' ? e.name : typeof e?.cause?.name === 'string' ? e.cause.name : ''
}

/** Every piece of text a provider error can carry, joined. Reads plain objects as well as Error
 *  subclasses (some adapters throw `{status, error:{message}}`), and never `String(obj)`, which is
 *  "[object Object]" and classifies nothing. */
function textOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (!err || typeof err !== 'object') return ''
  const e = err as { message?: unknown; error?: unknown; body?: unknown; cause?: { message?: unknown } }
  const parts: string[] = []
  if (typeof e.message === 'string') parts.push(e.message)
  if (typeof e.cause?.message === 'string') parts.push(e.cause.message)
  if (e.error !== undefined) {
    const inner = e.error as { message?: unknown; code?: unknown; type?: unknown } | string
    if (typeof inner === 'string') parts.push(inner)
    else if (inner && typeof inner === 'object') {
      if (typeof inner.message === 'string') parts.push(inner.message)
      if (typeof inner.code === 'string') parts.push(inner.code)
      if (typeof inner.type === 'string') parts.push(inner.type)
    }
  }
  if (typeof e.body === 'string') parts.push(e.body)
  else if (e.body && typeof e.body === 'object') {
    try {
      parts.push(JSON.stringify(e.body))
    } catch {
      /* unserializable body — the other parts still classify */
    }
  }
  return parts.join(' ')
}

/** The most specific human line for the notice: the provider's own `error.message` when it has
 *  one, else the top-level message, else the body. */
function detailOf(err: unknown, fallback: string): string {
  if (typeof err === 'string') return err
  const e = err as { message?: unknown; error?: { message?: unknown } | string; body?: unknown } | null
  if (e && typeof e === 'object') {
    const inner = e.error
    if (inner && typeof inner === 'object' && typeof inner.message === 'string' && inner.message) return inner.message
    if (typeof inner === 'string' && inner) return inner
    if (typeof e.message === 'string' && e.message) return e.message
    if (typeof e.body === 'string' && e.body) return e.body
  }
  return fallback
}

/** Reason from status + wording. Order is the whole design: the account-level classes that name a
 *  different job for the operator come before the generic ones, and a co-occurring token never
 *  outranks a definite status. */
function reasonOf(status: number | undefined, text: string, code: string, name: string): ProviderHealthReason {
  const t = text.toLowerCase()
  if (status === undefined) {
    if (NETWORK_CODES.test(code) || /APIConnection|Timeout|AbortError/i.test(name) || NETWORK_WORDING.test(text)) {
      return 'network'
    }
  }
  if (status === 402 || isBalanceError(t)) return 'no-credit'
  if (status === 401) return 'unauthorized'
  if (status === 403) {
    if (POLICY_WORDING.test(t)) return 'unknown'
    return MODEL_ACCESS_WORDING.test(t) ? 'model-access' : 'unauthorized'
  }
  if (status === 404) return 'not-found'
  if (status === 429) return 'rate-limit'
  if (status !== undefined && status >= 500) return 'unknown'
  // Status-less: wording only. Credential before not-found — a "401 … 404" string names the key
  // as the blocker (the existing failoverReason contract).
  if (isCredentialError(t)) return 'unauthorized'
  if (isModelNotFoundError(t)) return 'not-found'
  if (isQuotaError(t)) return 'rate-limit'
  return 'unknown'
}

/** Our own message shape, so classifying a message we produced is exact rather than a re-guess:
 *  `<provider>: <reason> (<status>) — <detail>`; status and detail are optional. */
const FORMATTED_RE = /^([a-z0-9-]+): (ok|no-key|no-credit|unauthorized|model-access|rate-limit|not-found|network|unknown)(?: \((\d{3})\))?(?: — (.*))?$/s

export function parseFormattedProviderError(
  msg: string | null | undefined
): { provider: string; reason: ProviderHealthReason; status?: number; detail: string } | null {
  if (!msg) return null
  const m = FORMATTED_RE.exec(msg.trim())
  if (!m) return null
  return {
    provider: m[1],
    reason: m[2] as ProviderHealthReason,
    status: m[3] ? Number(m[3]) : undefined,
    detail: m[4] ?? ''
  }
}

/** The ONE string every failure surfaces as: provider, reason token, status, bounded detail.
 *  Example: `openai: unauthorized (401) — Incorrect API key provided`. Parseable back by
 *  `parseFormattedProviderError`, so the failover walk never has to guess at its own wording. */
export function formatProviderError(c: ClassifiedProviderError): string {
  const status = c.status ? ` (${c.status})` : ''
  const detail = c.detail ? ` — ${c.detail}` : ''
  return `${c.provider}: ${c.reason}${status}${detail}`
}

/**
 * Classify one provider failure (an SDK error, a plain `{status, body, message}`, a raw string).
 *
 * `providerLabel` is the human name used in the fix hint; it defaults to the id, and registry.ts
 * passes the catalog label. Classifying a message this module formatted earlier is exact (the
 * reason/status are parsed back), so the verdict survives a round trip through a string.
 */
export function classifyProviderError(
  err: unknown,
  provider: ProviderId,
  providerLabel?: string
): ClassifiedProviderError {
  const label = providerLabel || provider
  const text = textOf(err)
  const own = parseFormattedProviderError(typeof err === 'string' ? err : (err as { message?: string } | null)?.message)
  if (own) {
    return {
      reason: own.reason,
      provider,
      status: own.status,
      detail: bounded(own.detail || own.reason),
      hint: providerFixHint(own.reason, label)
    }
  }
  const status = statusOf(err)
  const reason = reasonOf(status, text, codeOf(err), nameOf(err))
  const detail = bounded(detailOf(err, text || (status ? `HTTP ${status}` : 'no detail')))
  return { reason, provider, status, detail, hint: providerFixHint(reason, label) }
}

/** True for every reason the failover walk should act on. `unknown` is only eligible on a 5xx. */
export function isFailoverClass(reason: ProviderHealthReason, status?: number): boolean {
  return FAILOVER_REASONS.has(reason) || (status !== undefined && status >= 500)
}

/** Recoverable by re-routing the turn to another catalog model: a dry/rate-limited account, a
 *  stale/unknown model id, a credential this provider rejects, a key without access to the model,
 *  an unreachable host, or a 5xx. Accepts a classified error or the message string the answer
 *  path holds (our own formatted shape parses exactly; legacy wording classifies by phrase). */
export function isProviderFailoverError(
  input: string | ClassifiedProviderError | null | undefined
): boolean {
  if (!input) return false
  if (typeof input !== 'string') return isFailoverClass(input.reason, input.status)
  const own = parseFormattedProviderError(input)
  if (own) return isFailoverClass(own.reason, own.status)
  const reason = reasonOf(undefined, input, '', '')
  if (isFailoverClass(reason)) return true
  // A 5xx named in the text ("HTTP 502", "(503)") or worded as one.
  return /\b(?:http |status |\()5\d\d\b/i.test(input) || SERVER_WORDING.test(input)
}

/** Reason token for a message string — the failover walk's STEP line and the exhaustion summary
 *  read this so the operator is told which JOB to do. */
export function classifyMessageReason(msg: string | null | undefined): ProviderHealthReason {
  if (!msg) return 'unknown'
  const own = parseFormattedProviderError(msg)
  if (own) return own.reason
  return reasonOf(undefined, msg, '', '')
}

/** Legacy operator wording for a reason (kept for the callers that print it). */
export function failoverReason(
  msg: string | null | undefined
): 'no credit' | 'rate limit' | 'unknown model' | 'no valid key' | 'no model access' | 'unreachable' | 'unavailable' {
  switch (classifyMessageReason(msg)) {
    case 'no-credit':
      return 'no credit'
    case 'rate-limit':
      return 'rate limit'
    case 'not-found':
      return 'unknown model'
    case 'unauthorized':
      return 'no valid key'
    case 'model-access':
      return 'no model access'
    case 'network':
      return 'unreachable'
    default:
      return 'unavailable'
  }
}

/** Every reason token, for validation at the IPC edge. */
export function isProviderHealthReason(v: unknown): v is ProviderHealthReason {
  return typeof v === 'string' && (REASON_TOKENS as readonly string[]).includes(v)
}
