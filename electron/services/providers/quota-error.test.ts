import { describe, it, expect } from 'vitest'
import {
  isQuotaError,
  isModelNotFoundError,
  isProviderFailoverError,
  isBalanceError,
  isCredentialError,
  failoverReason
} from './quota-error'

describe('isQuotaError', () => {
  it('matches real billing/quota failures', () => {
    expect(isQuotaError('402 Insufficient Balance')).toBe(true)
    expect(isQuotaError('Error: 429 Too Many Requests')).toBe(true)
    expect(isQuotaError('You exceeded your current quota, please check your plan')).toBe(true)
    expect(isQuotaError('insufficient_quota')).toBe(true)
    expect(isQuotaError('Rate limit reached for requests')).toBe(true)
    expect(isQuotaError('Payment Required')).toBe(true)
    expect(isQuotaError('account in arrears')).toBe(true)
  })
  it('does NOT match ordinary/content errors', () => {
    expect(isQuotaError('provider error')).toBe(false)
    expect(isQuotaError('turn produced no answer')).toBe(false)
    expect(isQuotaError('400 invalid request: messages malformed')).toBe(false)
    expect(isQuotaError('500 internal server error')).toBe(false)
    expect(isQuotaError('context length 40200 exceeds the maximum')).toBe(false) // "exceeds" but not quota
    expect(isQuotaError('')).toBe(false)
    expect(isQuotaError(null)).toBe(false)
    expect(isQuotaError(undefined)).toBe(false)
  })
  it('does not false-match a bare number like 4029 tokens', () => {
    expect(isQuotaError('used 4029 tokens')).toBe(false)
    expect(isQuotaError('note 1402 words')).toBe(false)
  })
})

describe('isModelNotFoundError', () => {
  it('matches stale/unknown model ids across providers', () => {
    expect(isModelNotFoundError('The model `deepseek-v4-pro` does not exist or you do not have access to it')).toBe(true)
    expect(isModelNotFoundError('Error: 404 Not Found')).toBe(true)
    expect(isModelNotFoundError('{"error":{"code":"model_not_found"}}')).toBe(true)
    expect(isModelNotFoundError('invalid model: glm-5.2')).toBe(true)
    expect(isModelNotFoundError('no such model')).toBe(true)
    expect(isModelNotFoundError('unknown model gpt-5.1')).toBe(true)
    expect(isModelNotFoundError('模型不存在')).toBe(true)
    expect(isModelNotFoundError('不支持的模型')).toBe(true)
  })
  it('does NOT match quota, content, or unrelated errors', () => {
    expect(isModelNotFoundError('402 Insufficient Balance')).toBe(false)
    expect(isModelNotFoundError('429 Too Many Requests')).toBe(false)
    expect(isModelNotFoundError('400 invalid request: messages malformed')).toBe(false)
    expect(isModelNotFoundError('500 internal server error')).toBe(false)
    expect(isModelNotFoundError('provider error')).toBe(false)
    expect(isModelNotFoundError('')).toBe(false)
    expect(isModelNotFoundError(null)).toBe(false)
    expect(isModelNotFoundError(undefined)).toBe(false)
  })
  it('does not false-match a bare number containing 404', () => {
    expect(isModelNotFoundError('used 40400 tokens')).toBe(false)
    expect(isModelNotFoundError('note 14049 words')).toBe(false)
  })
})

describe('isProviderFailoverError', () => {
  it('is the union of quota and model-not-found', () => {
    expect(isProviderFailoverError('402 Insufficient Balance')).toBe(true) // quota
    expect(isProviderFailoverError('404 model_not_found')).toBe(true) // stale id
    expect(isProviderFailoverError('400 malformed request')).toBe(false)
    expect(isProviderFailoverError('turn produced no answer')).toBe(false)
  })
})

// ── isBalanceError ────────────────────────────────────────────────────────────
// The split that matters for retries: a rate limit clears on its own and SHOULD be waited out;
// an empty balance will not, so retrying it just spends the user's time in silence. Getting this
// backwards in either direction is a real cost — under-matching wastes ~14s per call on a dry key,
// over-matching stops retrying legitimate throttling.
describe('isBalanceError', () => {
  it('matches the verbatim Zhipu dry-account 429 seen in the field', () => {
    expect(isBalanceError('429 余额不足或无可用资源包,请充值。')).toBe(true)
  })

  it.each([
    'Insufficient Balance',
    '402 insufficient_quota',
    'You exceeded your current quota',
    'payment required',
    'account is in arrears',
    '账户余额不足',
    '欠费停机',
    '额度不足'
  ])('matches %s', (msg) => {
    expect(isBalanceError(msg)).toBe(true)
  })

  it.each([
    '429 Too Many Requests',
    'Rate limit reached for gpt-4o',
    'rate_limit_exceeded',
    'The model is overloaded, please try again later',
    '请求过于频繁，请稍后重试',
    '触发限流'
  ])('does NOT match throughput throttling: %s', (msg) => {
    expect(isBalanceError(msg)).toBe(false)
  })

  it('prefers the throughput reading when a message mentions both', () => {
    // Retrying is the safe default when a gateway is ambiguous.
    expect(isBalanceError('429 rate limit exceeded (quota exceeded)')).toBe(false)
  })

  it('is null-safe', () => {
    expect(isBalanceError(null)).toBe(false)
    expect(isBalanceError(undefined)).toBe(false)
    expect(isBalanceError('')).toBe(false)
  })

  it('stays NARROWER than isQuotaError — a plain rate limit is a quota error but not a balance one', () => {
    expect(isQuotaError('rate limit')).toBe(true)
    expect(isBalanceError('rate limit')).toBe(false)
  })
})

// ── the credential class ────────────────────────────────────────────────────────
//
// REPORTED BY THE OPERATOR, 2026-08-26: running on Claude Fable 5, the Anthropic
// balance was empty, the turn correctly failed over to OpenAI — and then STOPPED, with
// "invalid OpenAI key", while other keyed providers sat untried.
//
// The cause was that this class did not exist. `isProviderFailoverError` was quota OR
// unknown-model; a 401 is neither, so the answer path took the hard-fail branch on the
// second provider and never reached the third. These tests exist so it cannot silently
// go back to stopping there.

describe('isCredentialError', () => {
  it('matches the real rejection strings from the providers in play', () => {
    // Verbatim, all observed on 2026-08-26.
    expect(isCredentialError('{"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}')).toBe(true)
    expect(isCredentialError('{"error":{"message":"Invalid Authentication","type":"invalid_authentication_error"}}')).toBe(true)
    expect(isCredentialError('401 Unauthorized')).toBe(true)
    expect(isCredentialError('Incorrect API key provided: sk-xxx')).toBe(true)
    expect(isCredentialError('invalid_api_key')).toBe(true)
  })

  it('matches a MISSING key, not just a wrong one — an unkeyed provider must be skipped, not fatal', () => {
    expect(isCredentialError('OpenAI API key not configured. Add one in Settings → API Keys.')).toBe(true)
    expect(isCredentialError('No API key')).toBe(true)
    expect(isCredentialError('Missing API key')).toBe(true)
  })

  it('matches CN gateway wording', () => {
    expect(isCredentialError('鉴权失败')).toBe(true)
    expect(isCredentialError('令牌无效')).toBe(true)
    expect(isCredentialError('认证失败')).toBe(true)
  })

  // The half that keeps the class honest. A content refusal is about the REQUEST, so
  // another provider would refuse it too — failing over spends a second call to be told
  // the same thing, and hides a refusal behind a "provider unavailable" story.
  it('does NOT match a content/policy refusal that happens to carry a 403', () => {
    expect(isCredentialError('403 request violates our content policy')).toBe(false)
    expect(isCredentialError('blocked by the safety filter')).toBe(false)
    expect(isCredentialError('flagged by moderation')).toBe(false)
  })

  it('does not match quota, unknown-model or ordinary failures', () => {
    expect(isCredentialError('402 Insufficient Balance')).toBe(false)
    expect(isCredentialError('model_not_found')).toBe(false)
    expect(isCredentialError('500 Internal Server Error')).toBe(false)
    expect(isCredentialError('')).toBe(false)
    expect(isCredentialError(null)).toBe(false)
  })
})

describe('isProviderFailoverError — the chain must not stop on a bad key', () => {
  it('THE REPORTED BUG: a rejected key is now recoverable on another provider', () => {
    expect(isProviderFailoverError('401 Invalid Authentication')).toBe(true)
    expect(isProviderFailoverError('Incorrect API key provided')).toBe(true)
  })

  it('still covers the two original classes', () => {
    expect(isProviderFailoverError('402 Insufficient Balance')).toBe(true)
    expect(isProviderFailoverError('model_not_found')).toBe(true)
  })

  it('still refuses to fail over on things another provider cannot fix', () => {
    // A content-policy refusal is about the REQUEST; every provider would say the same.
    expect(isProviderFailoverError('request violates our content policy')).toBe(false)
    // An unclassifiable failure with no status is not a reason to spend a second provider.
    expect(isProviderFailoverError('Unknown error')).toBe(false)
  })

  it('a 5xx IS recoverable on another provider (P0 classifier contract): the host is down, not the request', () => {
    expect(isProviderFailoverError('500 Internal Server Error')).toBe(true)
    expect(isProviderFailoverError('deepseek: unknown (502) — Bad Gateway')).toBe(true)
    expect(isProviderFailoverError('anthropic: unknown (529) — Overloaded')).toBe(true)
  })
})

describe('failoverReason — the operator is told which job to do', () => {
  // "quota" was printed for every failover cause, so a key problem read as a billing
  // problem. Topping up an account does not fix a revoked key.
  it('separates the four causes', () => {
    expect(failoverReason('401 Invalid Authentication')).toBe('no valid key')
    expect(failoverReason('402 Insufficient Balance')).toBe('no credit')
    expect(failoverReason('429 Rate limit reached')).toBe('rate limit')
    expect(failoverReason('model_not_found')).toBe('unknown model')
  })

  it('credential wins over a co-occurring 404, since the key is the blocker', () => {
    expect(failoverReason('401 Unauthorized: model not found')).toBe('no valid key')
  })

  it('falls back to a neutral word rather than guessing', () => {
    expect(failoverReason('500 Internal Server Error')).toBe('unavailable')
  })
})
