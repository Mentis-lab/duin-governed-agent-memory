// Provider quota / billing / rate-limit error classification — the retryable-on-a-DIFFERENT-provider
// class. When the routed model returns one of these (e.g. a keyed provider whose account ran dry:
// "402 Insufficient Balance"), the answer path should fall back to the next keyed model instead of
// hard-failing the turn. Provider-agnostic BY DESIGN — matches the common wording across the
// OpenAI-compatible gateways DUIN speaks to (DeepSeek / Zhipu / OpenAI / …), so no provider is
// special-cased and any user's key mix benefits.
//
// Pure + unit-tested. NOT a fallback for content/tool errors — only the "this provider can't serve
// the request at all right now" class, where retrying the SAME provider is pointless but another
// provider would succeed.

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
 * A bad key belongs in the failover class by this module's own definition — "this
 * provider can't serve the request at all right now, retrying the same target is
 * pointless, another provider would succeed". That describes a revoked key exactly. It
 * is arguably a better failover candidate than a rate limit, which at least clears on
 * its own.
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

/** Recoverable by re-routing the turn to another catalog model: a dry/rate-limited account
 *  (isQuotaError), a stale/unknown model id (isModelNotFoundError), or a credential this
 *  provider rejects (isCredentialError). All three are "this exact target cannot serve the
 *  request", where retrying the same target is pointless but another one succeeds. */
export function isProviderFailoverError(msg: string | null | undefined): boolean {
  return isQuotaError(msg) || isModelNotFoundError(msg) || isCredentialError(msg)
}

/** Which of the three classes fired — for the STEP line and the exhaustion summary, so an
 *  operator is told "no valid key" rather than a generic "quota" for a key problem. */
export function failoverReason(msg: string | null | undefined): 'no credit' | 'rate limit' | 'unknown model' | 'no valid key' | 'unavailable' {
  if (isCredentialError(msg)) return 'no valid key'
  if (isModelNotFoundError(msg)) return 'unknown model'
  if (isBalanceError(msg)) return 'no credit'
  if (isQuotaError(msg)) return 'rate limit'
  return 'unavailable'
}
