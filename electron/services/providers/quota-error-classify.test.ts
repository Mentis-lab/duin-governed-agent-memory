// classifyProviderError — the classifier matrix (P0 model plane, plan §2.1 "classifier truth").
//
// S1 (2026-09-02): 24/24 non-DeepSeek turns hard-failed one hop before the only funded provider
// because the app synthesized `Invalid OpenAI API key` and then did not recognise its own string.
// Every row below is a shape a real gateway produced or the app itself formats; the legacy strings
// are pinned verbatim so the regression cannot come back through a journal, a bridge or a proxy.

import { describe, it, expect } from 'vitest'
import {
  classifyProviderError,
  formatProviderError,
  parseFormattedProviderError,
  isProviderFailoverError,
  isCredentialError,
  isFailoverClass,
  failoverReason,
  classifyMessageReason
} from './quota-error'
import type { ProviderHealthReason } from './roles'

const sdkError = (status: number, message: string, extra: Record<string, unknown> = {}): unknown =>
  Object.assign(new Error(message), { status, ...extra })

describe('classifyProviderError — status + wording → one reason', () => {
  const rows: Array<[string, unknown, ProviderHealthReason]> = [
    ['401 → unauthorized', sdkError(401, 'Incorrect API key provided: sk-…'), 'unauthorized'],
    ['403 + "does not have access" → model-access', sdkError(403, 'Project does not have access to model gpt-5.5'), 'model-access'],
    ['403 + model wording → model-access', { status: 403, error: { message: 'The model is not available for your organization' } }, 'model-access'],
    ['bare 403 → unauthorized', sdkError(403, 'Forbidden'), 'unauthorized'],
    ['403 + content policy → unknown (about the request, not the key)', sdkError(403, 'request violates our content policy'), 'unknown'],
    ['402 → no-credit, no message needed', { status: 402 }, 'no-credit'],
    ['429 + 余额不足 → no-credit (Zhipu verbatim)', sdkError(429, '429 余额不足或无可用资源包,请充值。'), 'no-credit'],
    ['429 + insufficient_quota → no-credit (OpenAI)', sdkError(429, 'You exceeded your current quota, please check your plan and billing details.'), 'no-credit'],
    ['429 + rate limit → rate-limit', sdkError(429, 'Rate limit reached for gpt-5.5 … see https://platform.openai.com/account/billing/'), 'rate-limit'],
    ['404 → not-found', sdkError(404, 'The model `ox-alpha` does not exist or you do not have access to it.'), 'not-found'],
    ['status-less model_not_found wording → not-found', { message: 'model_not_found' }, 'not-found'],
    ['ECONNREFUSED → network', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }), 'network'],
    ['fetch failed → network', new Error('fetch failed'), 'network'],
    ['SDK APIConnectionError → network', Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }), 'network'],
    ['cause.code ENOTFOUND → network', Object.assign(new Error('request failed'), { cause: { code: 'ENOTFOUND' } }), 'network'],
    ['500 → unknown', sdkError(500, 'Internal Server Error'), 'unknown'],
    ['400 with no recognisable wording → unknown', sdkError(400, 'invalid request'), 'unknown'],
    ['status-less credential wording → unauthorized', { message: 'Invalid Authentication' }, 'unauthorized'],
    ['status-less 429 token in text → rate-limit', 'HTTP 429 Too Many Requests', 'rate-limit'],
    ['nested error.message classifies (plain object, not an Error)', { status: 401, error: { message: 'invalid x-api-key' } }, 'unauthorized'],
    ['nothing → unknown', {}, 'unknown']
  ]
  for (const [name, err, reason] of rows) {
    it(name, () => {
      expect(classifyProviderError(err, 'openai', 'OpenAI').reason).toBe(reason)
    })
  }

  it('carries provider, status, a bounded detail and a hint naming the provider', () => {
    const c = classifyProviderError(sdkError(401, 'Incorrect API key provided'), 'openai', 'OpenAI')
    expect(c).toMatchObject({ provider: 'openai', status: 401, reason: 'unauthorized', detail: 'Incorrect API key provided' })
    expect(c.hint).toContain('OpenAI')
    expect(c.hint.length).toBeGreaterThan(10)
  })

  it('prefers the provider’s own error.message for the detail, and bounds it', () => {
    const long = 'x'.repeat(500)
    const c = classifyProviderError({ status: 402, message: 'Payment Required', error: { message: long } }, 'zhipu')
    expect(c.detail.length).toBeLessThanOrEqual(200)
    expect(c.detail.startsWith('xxxx')).toBe(true)
  })

  it('never reads "[object Object]" — a plain object without message still classifies by status', () => {
    const c = classifyProviderError({ status: 404, body: { error: 'no such model' } }, 'deepseek')
    expect(c.reason).toBe('not-found')
    expect(c.detail).not.toContain('[object Object]')
  })
})

describe('the formatted shape — one string every reader parses', () => {
  it('formats provider: reason (status) — detail, and parses back exactly', () => {
    const c = classifyProviderError(sdkError(401, 'Incorrect API key provided'), 'openai', 'OpenAI')
    const s = formatProviderError(c)
    expect(s).toBe('openai: unauthorized (401) — Incorrect API key provided')
    expect(parseFormattedProviderError(s)).toEqual({ provider: 'openai', reason: 'unauthorized', status: 401, detail: 'Incorrect API key provided' })
  })

  it('omits an absent status and detail without leaving punctuation behind', () => {
    expect(formatProviderError({ reason: 'network', provider: 'deepseek', detail: '', hint: '' })).toBe('deepseek: network')
    expect(parseFormattedProviderError('deepseek: network')).toEqual({ provider: 'deepseek', reason: 'network', status: undefined, detail: '' })
  })

  it('classifying our own formatted message is exact (idempotent through a string round trip)', () => {
    const first = classifyProviderError(sdkError(403, 'Project does not have access to model gpt-5.5'), 'openai', 'OpenAI')
    const again = classifyProviderError(formatProviderError(first), 'openai', 'OpenAI')
    expect(again.reason).toBe('model-access')
    expect(again.status).toBe(403)
    expect(again.detail).toBe(first.detail)
  })

  it('is not fooled by ordinary prose that happens to contain a colon', () => {
    expect(parseFormattedProviderError('Error: something went wrong')).toBeNull()
    expect(parseFormattedProviderError('openai: sky is blue')).toBeNull()
  })
})

describe('isCredentialError — the legacy synthesized strings (S1 regression, exact text)', () => {
  it('matches "Invalid OpenAI API key" and "Invalid Zhipu AI (GLM) API key" verbatim', () => {
    expect(isCredentialError('Invalid OpenAI API key')).toBe(true)
    expect(isCredentialError('Invalid Zhipu AI (GLM) API key')).toBe(true)
    expect(isCredentialError('Invalid Anthropic (Claude) API key')).toBe(true)
  })

  it('and the failover walk acts on them', () => {
    expect(isProviderFailoverError('Invalid OpenAI API key')).toBe(true)
    expect(isProviderFailoverError('Invalid Zhipu AI (GLM) API key')).toBe(true)
    expect(failoverReason('Invalid OpenAI API key')).toBe('no valid key')
    expect(classifyMessageReason('Invalid Zhipu AI (GLM) API key')).toBe('unauthorized')
  })
})

describe('isProviderFailoverError — the class the walker acts on', () => {
  it('is exactly {no-credit, unauthorized, model-access, rate-limit, not-found, network} or a 5xx', () => {
    const yes: ProviderHealthReason[] = ['no-credit', 'unauthorized', 'model-access', 'rate-limit', 'not-found', 'network']
    for (const r of yes) expect(isFailoverClass(r)).toBe(true)
    for (const r of ['ok', 'no-key', 'unknown'] as ProviderHealthReason[]) expect(isFailoverClass(r)).toBe(false)
    expect(isFailoverClass('unknown', 500)).toBe(true)
    expect(isFailoverClass('unknown', 400)).toBe(false)
  })

  it('accepts a classified error, a formatted string, or legacy wording', () => {
    expect(isProviderFailoverError(classifyProviderError(sdkError(402, 'Insufficient Balance'), 'deepseek'))).toBe(true)
    expect(isProviderFailoverError('openai: model-access (403) — no access')).toBe(true)
    expect(isProviderFailoverError('openai: unknown (400) — bad request')).toBe(false)
    expect(isProviderFailoverError('deepseek: unknown (503) — Service Unavailable')).toBe(true)
    expect(isProviderFailoverError('402 Insufficient Balance')).toBe(true)
    expect(isProviderFailoverError('fetch failed')).toBe(true)
    expect(isProviderFailoverError(null)).toBe(false)
  })

  it('failoverReason names the JOB, with the two new classes', () => {
    expect(failoverReason('openai: model-access (403) — x')).toBe('no model access')
    expect(failoverReason('deepseek: network — fetch failed')).toBe('unreachable')
    expect(failoverReason('deepseek: no-credit (402) — x')).toBe('no credit')
    expect(failoverReason('deepseek: rate-limit (429) — x')).toBe('rate limit')
    expect(failoverReason('deepseek: not-found (404) — x')).toBe('unknown model')
    expect(failoverReason('deepseek: unknown (502) — x')).toBe('unavailable')
  })
})
