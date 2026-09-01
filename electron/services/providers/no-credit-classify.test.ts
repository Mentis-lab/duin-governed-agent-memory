import { describe, it, expect } from 'vitest'
import { isNoCreditError, PROVIDERS } from './registry'

// "OUT OF CREDIT" IS NOT "BAD KEY", and the verifier used to say it was.
//
// Measured 2026-08-26 on one machine: all three paid providers were unfunded, and every
// health surface reported them fine or reported the key rejected. A freshly-pasted,
// provably valid Anthropic key — 200 against the native endpoint, authentication passed
// on the chat endpoint, both in the same minute — was rendered as "Provider rejected the
// key (HTTP 401)". The operator's next move on reading that is to rotate a working key,
// which fixes nothing and costs a credential.
//
// The strings below are the REAL vendor responses from that session, not invented ones.

/** The SDK throws Error subclasses; hand-rolled fetch paths and some adapters throw
 *  plain objects. The classifier must read both, so every case below is asserted
 *  against BOTH shapes — an earlier version relied on `messageOf`, which returns
 *  "[object Object]" for a non-Error and silently classified those by status alone. */
function bothShapes(status: number, message: string): unknown[] {
  const asError = Object.assign(new Error(message), { status })
  return [{ status, message }, asError, { status, error: { message } }]
}

describe('isNoCreditError — the three real vendor shapes', () => {
  it('classifies identically whether the throw is an Error or a plain object', () => {
    for (const shape of bothShapes(429, 'insufficient_quota')) {
      expect(isNoCreditError(shape)).toBe(true)
    }
  })

  it('zhipu: 429 in Chinese', () => {
    // The provider that produced the most failures on that machine answers in Chinese,
    // so an English-only matcher would have missed the single largest source.
    expect(isNoCreditError({ status: 429, message: '429 余额不足或无可用资源包,请充值。' })).toBe(true)
  })

  it('anthropic: 400, which OVERLAPS nothing in the auth branch and would have fallen to "error"', () => {
    expect(
      isNoCreditError({
        status: 400,
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
      })
    ).toBe(true)
  })

  it('openai: 429 insufficient_quota', () => {
    expect(
      isNoCreditError({
        status: 429,
        message:
          'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.'
      })
    ).toBe(true)
    expect(isNoCreditError({ status: 429, message: 'insufficient_quota' })).toBe(true)
  })

  it('402 Payment Required needs no message at all', () => {
    expect(isNoCreditError({ status: 402 })).toBe(true)
  })

  // The half that matters just as much: a real auth failure must NOT be softened into a
  // billing notice, or a revoked key sits there looking like an invoice problem.
  it('a genuine auth failure is NOT reclassified', () => {
    expect(isNoCreditError({ status: 401, message: 'Invalid bearer token' })).toBe(false)
    expect(isNoCreditError({ status: 403, message: 'Forbidden' })).toBe(false)
    expect(isNoCreditError({ status: 401, message: 'authentication_error' })).toBe(false)
  })

  // Caught by an external review of this very commit, and it was right. Providers put a
  // billing URL in the FOOTER of unrelated errors, so a bare `billing` substring match
  // read a transient throttle as an empty account — and that is the expensive direction:
  // a rate limit clears on its own, while the operator is sent to fund an account that
  // is already funded. isBalanceError already had this guard; this function did not.
  it('a rate limit that merely LINKS to the billing page is not a credit problem', () => {
    expect(
      isNoCreditError({
        status: 429,
        message:
          'Rate limit reached for gpt-4o. See https://platform.openai.com/settings/organization/billing/ for details.'
      })
    ).toBe(false)
    expect(isNoCreditError({ status: 429, message: 'Too many requests, try again later. billing' })).toBe(false)
    expect(isNoCreditError({ status: 503, message: 'Model overloaded. billing info at /billing' })).toBe(false)
    expect(isNoCreditError({ status: 429, message: '请稍后重试，限流中。billing' })).toBe(false)
  })

  it('but a REAL empty balance still classifies, billing URL and all', () => {
    expect(
      isNoCreditError({
        status: 429,
        message:
          'You have no credits remaining. Add credits at https://platform.openai.com/settings/organization/billing/.'
      })
    ).toBe(true)
  })

  it('an ordinary failure is NOT reclassified', () => {
    expect(isNoCreditError({ status: 500, message: 'Internal server error' })).toBe(false)
    expect(isNoCreditError({ status: 404, message: 'Not found' })).toBe(false)
    expect(isNoCreditError(new Error('Connection error.'))).toBe(false)
    expect(isNoCreditError(undefined)).toBe(false)
    expect(isNoCreditError(null)).toBe(false)
  })

  // A 403 that says model_not_found is an ENTITLEMENT problem, not a billing one — the
  // project simply cannot reach that model. Softening it to "no credit" would send the
  // operator to the billing page for something money does not fix.
  it('a 403 model_not_found stays out of the billing bucket', () => {
    expect(
      isNoCreditError({
        status: 403,
        message: 'Project `proj_x` does not have access to model `gpt-5.5`'
      })
    ).toBe(false)
  })
})

describe('providers that declare their catalog unverifiable', () => {
  // The declaration exists so the verifier does not probe an endpoint it cannot read.
  // anthropic is the live case: its OpenAI-compat layer covers /v1/chat/completions but
  // NOT /v1/models, whose native form wants x-api-key + anthropic-version rather than
  // the Bearer this client sends. Probing anyway earns a 401 on a perfectly good key.
  it('anthropic still declares kind: unsupported', () => {
    expect(PROVIDERS.anthropic.catalog?.kind).toBe('unsupported')
  })

  it('a provider without a catalog strategy is left probeable', () => {
    // deepseek/zhipu/openai expose a readable /v1/models — verification is real for
    // them, and this test fails loudly if someone blanket-disables probing.
    expect(PROVIDERS.openai.catalog?.kind).not.toBe('unsupported')
    expect(PROVIDERS.deepseek.catalog?.kind).not.toBe('unsupported')
  })
})
