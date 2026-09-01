import { describe, expect, it } from 'vitest'
import { createHash, createHmac, createCipheriv, randomBytes } from 'crypto'
import {
  verifySlackSignature,
  verifyFeishuToken,
  decryptFeishuEncrypt,
  classifyWebhookBody,
  webhookIngressEnabled
} from './webhook-server'

// Pure signature-verification helpers — the security boundary of the webhook
// ingress scaffold. No server is booted here; the loopback listener is a gated,
// human-infra-dependent scaffold tested separately (integration-only).

// ──────────────────── Slack signing secret (HMAC-SHA256) ────────────────────

function slackSign(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`
}

describe('verifySlackSignature', () => {
  const secret = '8f742231b10e8888abcd99yyyzzz85a5'
  const body = 'token=xyz&team_id=T1&command=/x'
  const now = 1_700_000_000

  it('accepts a correctly signed, fresh request', () => {
    const ts = String(now)
    const sig = slackSign(secret, ts, body)
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, rawBody: body, signature: sig, nowSeconds: now })
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const ts = String(now)
    const sig = slackSign(secret, ts, body)
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        rawBody: body + 'TAMPER',
        signature: sig,
        nowSeconds: now
      })
    ).toBe(false)
  })

  it('rejects a wrong signing secret', () => {
    const ts = String(now)
    const sig = slackSign('the-wrong-secret', ts, body)
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, rawBody: body, signature: sig, nowSeconds: now })
    ).toBe(false)
  })

  it('rejects a stale timestamp (replay window)', () => {
    const staleTs = String(now - 600) // 10 min old, tolerance 300s
    const sig = slackSign(secret, staleTs, body)
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: staleTs, rawBody: body, signature: sig, nowSeconds: now })
    ).toBe(false)
  })

  it('accepts within the replay tolerance', () => {
    const ts = String(now - 200)
    const sig = slackSign(secret, ts, body)
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, rawBody: body, signature: sig, nowSeconds: now })
    ).toBe(true)
  })

  it('rejects a non-numeric timestamp, empty secret, or empty signature', () => {
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: 'nope', rawBody: body, signature: 'v0=x', nowSeconds: now })
    ).toBe(false)
    expect(
      verifySlackSignature({ signingSecret: '', timestamp: String(now), rawBody: body, signature: 'v0=x', nowSeconds: now })
    ).toBe(false)
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: String(now), rawBody: body, signature: '', nowSeconds: now })
    ).toBe(false)
  })
})

// ──────────────────── Feishu verification token ────────────────────

describe('verifyFeishuToken', () => {
  it('accepts a matching token', () => {
    expect(verifyFeishuToken({ verificationToken: 'v-tok-abc', receivedToken: 'v-tok-abc' })).toBe(true)
  })
  it('rejects a mismatched token', () => {
    expect(verifyFeishuToken({ verificationToken: 'v-tok-abc', receivedToken: 'v-tok-xyz' })).toBe(false)
  })
  it('rejects empty configured or received token', () => {
    expect(verifyFeishuToken({ verificationToken: '', receivedToken: 'x' })).toBe(false)
    expect(verifyFeishuToken({ verificationToken: 'x', receivedToken: '' })).toBe(false)
  })
})

// ──────────────────── Feishu AES encrypt-key decryption ────────────────────

/** Encrypt exactly the way Feishu does so the decryptor can be verified:
 *  key=SHA256(encryptKey), iv=random 16 bytes prepended, AES-256-CBC. */
function feishuEncrypt(encryptKey: string, plaintext: string): string {
  const key = createHash('sha256').update(encryptKey).digest()
  const iv = randomBytes(16)
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return Buffer.concat([iv, enc]).toString('base64')
}

describe('decryptFeishuEncrypt', () => {
  const encryptKey = 'my-super-encrypt-key'

  it('round-trips an encrypted event body', () => {
    const payload = JSON.stringify({ token: 'v-tok', type: 'event_callback', event: { hi: 1 } })
    const encrypt = feishuEncrypt(encryptKey, payload)
    expect(decryptFeishuEncrypt(encryptKey, encrypt)).toBe(payload)
  })

  it('returns null on a wrong key', () => {
    const encrypt = feishuEncrypt(encryptKey, '{"token":"x"}')
    expect(decryptFeishuEncrypt('wrong-key', encrypt)).toBeNull()
  })

  it('returns null on garbage / too-short input', () => {
    expect(decryptFeishuEncrypt(encryptKey, 'not-base64-!!!')).toBeNull()
    expect(decryptFeishuEncrypt(encryptKey, Buffer.from('short').toString('base64'))).toBeNull()
    expect(decryptFeishuEncrypt('', 'anything')).toBeNull()
    expect(decryptFeishuEncrypt(encryptKey, '')).toBeNull()
  })
})

// ──────────────────── URL-verification challenge classification ────────────────────

describe('classifyWebhookBody', () => {
  it('echoes a url_verification challenge', () => {
    const outcome = classifyWebhookBody({ type: 'url_verification', challenge: 'c-123', token: 't' })
    expect(outcome).toEqual({ kind: 'challenge', response: { challenge: 'c-123' } })
  })
  it('flags a challenge with no challenge value as unauthorized', () => {
    expect(classifyWebhookBody({ type: 'url_verification' }).kind).toBe('unauthorized')
  })
  it('classifies a normal event', () => {
    expect(classifyWebhookBody({ type: 'event_callback', event: {} }).kind).toBe('event')
  })
  it('ignores non-object bodies', () => {
    expect(classifyWebhookBody(null).kind).toBe('ignore')
    expect(classifyWebhookBody('str').kind).toBe('ignore')
  })
})

// ──────────────────── ingress flag (default OFF) ────────────────────

describe('webhookIngressEnabled (default OFF)', () => {
  const ORIGINAL = process.env.DUIN_WEBHOOK_INGRESS
  const restore = (): void => {
    if (ORIGINAL === undefined) delete process.env.DUIN_WEBHOOK_INGRESS
    else process.env.DUIN_WEBHOOK_INGRESS = ORIGINAL
  }

  it('is OFF when unset', () => {
    delete process.env.DUIN_WEBHOOK_INGRESS
    expect(webhookIngressEnabled()).toBe(false)
    restore()
  })
  it('is ON for truthy values', () => {
    for (const v of ['1', 'true', 'on', 'YES']) {
      process.env.DUIN_WEBHOOK_INGRESS = v
      expect(webhookIngressEnabled()).toBe(true)
    }
    restore()
  })
  it('is OFF for other values', () => {
    for (const v of ['0', 'false', 'off', '']) {
      process.env.DUIN_WEBHOOK_INGRESS = v
      expect(webhookIngressEnabled()).toBe(false)
    }
    restore()
  })
})
