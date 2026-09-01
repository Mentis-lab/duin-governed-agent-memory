import { createHash, createHmac, createDecipheriv, timingSafeEqual } from 'crypto'
import { messageOf } from '../guarded'

// Webhook ingress (Wave-3 — DESIGN STUB). A loopback HTTP receiver for platform
// webhooks (Feishu event subscriptions, Slack Events API) that reuses the
// mcp.ts loopback shape (127.0.0.1 http.createServer) and the oauth-state CSRF
// discipline (single-use, constant-time verification) — here re-purposed as
// per-platform SIGNATURE verification.
//
// SCOPE / SAFETY (this stage):
//   - NO TUNNEL, NO HOSTING. A webhook needs a public HTTPS URL; standing up a
//     tunnel (ngrok/cloudflared) or a hosted endpoint is HUMAN INFRA and is
//     intentionally NOT wired here. `startWebhookServer()` is GATED OFF
//     (`DUIN_WEBHOOK_INGRESS`, default off) and binds ONLY to loopback even when
//     enabled — it is a local test harness, not an internet-facing listener.
//   - The load-bearing, testable core is the PURE signature-verification helpers
//     (`verifySlackSignature`, `verifyFeishuToken`, `decryptFeishuEncrypt`). Those
//     are the security boundary and are fully unit-tested; the server that calls
//     them is a thin, gated scaffold.
//   - DENY-FIRST: an inbound event that fails verification is rejected (401). A
//     verified event is handed to an injected `onEvent` sink — this module does
//     NOT itself run a privileged turn. (A remote turn must run de-privileged;
//     see duin-bridge exec-token discipline.)
//
// HUMAN-VERIFY: real webhook delivery (public URL, tunnel, live platform secrets,
// Feishu URL-verification challenge round-trip) cannot be exercised here.

// ──────────────────── Slack (signing secret, HMAC-SHA256) ────────────────────

export interface SlackVerifyInput {
  /** Slack app "Signing Secret". */
  signingSecret: string
  /** `X-Slack-Request-Timestamp` header (unix seconds, as a string). */
  timestamp: string
  /** RAW request body (exact bytes Slack sent — do not re-serialize). */
  rawBody: string
  /** `X-Slack-Signature` header, e.g. `v0=<hex>`. */
  signature: string
  /** Reject timestamps older than this (replay window). Default 300s. */
  toleranceSeconds?: number
  /** Injectable clock (unix seconds) for deterministic tests. */
  nowSeconds?: number
}

/**
 * Verify a Slack Events API request signature.
 *   basestring = `v0:${timestamp}:${rawBody}`
 *   expected   = `v0=` + HMAC_SHA256(signingSecret, basestring) (hex)
 * Constant-time compared to the `X-Slack-Signature` header. Also rejects stale
 * timestamps (replay protection). PURE — no I/O.
 */
export function verifySlackSignature(input: SlackVerifyInput): boolean {
  try {
    const tolerance = input.toleranceSeconds ?? 300
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
    const ts = Number(input.timestamp)
    if (!Number.isFinite(ts)) return false
    if (Math.abs(now - ts) > tolerance) return false
    if (!input.signingSecret || !input.signature) return false
    const base = `v0:${input.timestamp}:${input.rawBody}`
    const digest = createHmac('sha256', input.signingSecret).update(base).digest('hex')
    const expected = `v0=${digest}`
    return safeStrEqual(expected, input.signature)
  } catch {
    return false
  }
}

// ──────────────────── Feishu (verification token + AES encrypt key) ────────────────────

export interface FeishuVerifyInput {
  /** The app's "Verification Token" (Event Subscriptions). */
  verificationToken: string
  /** The `token` field from the decoded event body. */
  receivedToken: string
}

/**
 * Verify a Feishu event's plaintext `token` against the app's Verification
 * Token (constant-time). This is Feishu's baseline authenticity check for
 * unencrypted event mode. PURE.
 */
export function verifyFeishuToken(input: FeishuVerifyInput): boolean {
  if (!input.verificationToken || !input.receivedToken) return false
  return safeStrEqual(input.verificationToken, input.receivedToken)
}

/**
 * Decrypt a Feishu `encrypt` payload (Encrypt Key mode). Feishu encrypts the
 * event JSON with AES-256-CBC where:
 *   key = SHA256(encryptKey)                      (32 bytes)
 *   iv  = first 16 bytes of base64-decoded blob
 *   ciphertext = the remaining bytes
 * Returns the decrypted UTF-8 JSON string, or null on any failure. PURE.
 */
export function decryptFeishuEncrypt(encryptKey: string, encrypt: string): string | null {
  try {
    if (!encryptKey || !encrypt) return null
    const key = createHash('sha256').update(encryptKey).digest()
    const blob = Buffer.from(encrypt, 'base64')
    if (blob.length <= 16) return null
    const iv = blob.subarray(0, 16)
    const ciphertext = blob.subarray(16)
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf-8')
  } catch {
    return null
  }
}

/** Constant-time string compare (length-independent early-out is unavoidable,
 *  but content comparison is timing-safe). */
function safeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// ──────────────────── URL-verification challenge (Feishu / Slack) ────────────────────

export type ChallengeOutcome =
  | { kind: 'challenge'; response: Record<string, string> }
  | { kind: 'event' }
  | { kind: 'unauthorized' }
  | { kind: 'ignore' }

/**
 * Classify a decoded webhook body for the URL-verification handshake both
 * platforms use when you register an endpoint:
 *   - Slack:  `{ type: 'url_verification', challenge, token }` → echo `challenge`.
 *   - Feishu: `{ type: 'url_verification', challenge, token }` → echo `challenge`
 *             (after token/encrypt has already been verified by the caller).
 * Anything else with a verified token is a real `event`. PURE — the caller has
 * ALREADY verified signature/token before calling this.
 */
export function classifyWebhookBody(body: unknown): ChallengeOutcome {
  if (!body || typeof body !== 'object') return { kind: 'ignore' }
  const b = body as Record<string, unknown>
  if (b.type === 'url_verification') {
    const challenge = typeof b.challenge === 'string' ? b.challenge : ''
    if (!challenge) return { kind: 'unauthorized' }
    return { kind: 'challenge', response: { challenge } }
  }
  return { kind: 'event' }
}

// ──────────────────── Gated loopback server (scaffold) ────────────────────

export interface WebhookServerConfig {
  /** Loopback port to bind (default 9377). Loopback ONLY — never 0.0.0.0. */
  port?: number
  /** Slack signing secret (for /slack). Absent → Slack route rejects all. */
  slackSigningSecret?: string
  /** Feishu verification token (for /feishu). */
  feishuVerificationToken?: string
  /** Feishu encrypt key (for /feishu Encrypt-Key mode). */
  feishuEncryptKey?: string
  /** Sink for verified events. Receives (platform, decoded body). MUST run any
   *  resulting turn DE-PRIVILEGED — a webhook has no exec token. */
  onEvent?: (platform: 'slack' | 'feishu', body: unknown) => void
}

export interface WebhookServerHandle {
  port: number
  close: () => Promise<void>
}

/** Feature flag for the webhook ingress server. Default OFF. */
export function webhookIngressEnabled(): boolean {
  const raw = process.env.DUIN_WEBHOOK_INGRESS
  if (raw == null || raw.trim() === '') return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/**
 * Start the loopback webhook receiver. GATED OFF by default — returns null unless
 * `DUIN_WEBHOOK_INGRESS` is truthy. Even enabled, it binds ONLY to 127.0.0.1 and
 * is a LOCAL TEST HARNESS: standing up a public HTTPS tunnel to reach it is the
 * human infra step and is deliberately out of scope.
 *
 * HUMAN-VERIFY: this end-to-end path (tunnel + live platform delivery) can't be
 * exercised in CI. The verification helpers above are the tested boundary.
 */
export async function startWebhookServer(
  config: WebhookServerConfig = {}
): Promise<WebhookServerHandle | null> {
  if (!webhookIngressEnabled()) {
    console.info(
      '[webhook] ingress disabled (set DUIN_WEBHOOK_INGRESS=1 to enable the ' +
        'loopback receiver). A public HTTPS tunnel is a separate human infra step.'
    )
    return null
  }
  const port = config.port ?? 9377
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createServer } = require('http') as typeof import('http')
  const server = createServer((req, res) => {
    handleRequest(req, res, config).catch((e) => {
      console.debug('[webhook] handler error:', messageOf(e))
      try {
        res.writeHead(500)
        res.end('error')
      } catch {
        /* response already sent */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    // Loopback bind ONLY — never expose this listener beyond the host.
    server.listen(port, '127.0.0.1', () => resolve())
  })
  console.warn(
    `[webhook] loopback receiver on http://127.0.0.1:${port} — NOT internet-facing. ` +
      'Front it with your own tunnel/HTTPS termination to receive real webhooks.'
  )
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}

// Thin request handler — reads the raw body, verifies per platform, handles the
// URL-verification challenge, and forwards verified events to the sink. Kept
// intentionally small; the security logic lives in the pure helpers.
async function handleRequest(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  config: WebhookServerConfig
): Promise<void> {
  const url = req.url ?? '/'
  const platform: 'slack' | 'feishu' | null = url.startsWith('/slack')
    ? 'slack'
    : url.startsWith('/feishu')
      ? 'feishu'
      : null
  if (!platform || req.method !== 'POST') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const rawBody = await readBody(req)

  if (platform === 'slack') {
    const ok = verifySlackSignature({
      signingSecret: config.slackSigningSecret ?? '',
      timestamp: String(req.headers['x-slack-request-timestamp'] ?? ''),
      rawBody,
      signature: String(req.headers['x-slack-signature'] ?? '')
    })
    if (!ok) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    const body = safeJson(rawBody)
    finish(res, body, (b) => config.onEvent?.('slack', b))
    return
  }

  // Feishu: body may be encrypted (Encrypt-Key mode) or carry a plaintext token.
  let parsed = safeJson(rawBody) as Record<string, unknown> | null
  if (parsed && typeof parsed.encrypt === 'string' && config.feishuEncryptKey) {
    const decoded = decryptFeishuEncrypt(config.feishuEncryptKey, parsed.encrypt)
    parsed = decoded ? (safeJson(decoded) as Record<string, unknown> | null) : null
  }
  const token = parsed && typeof parsed.token === 'string' ? parsed.token : ''
  if (!verifyFeishuToken({ verificationToken: config.feishuVerificationToken ?? '', receivedToken: token })) {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }
  finish(res, parsed, (b) => config.onEvent?.('feishu', b))
}

function finish(
  res: import('http').ServerResponse,
  body: unknown,
  onEvent: (b: unknown) => void
): void {
  const outcome = classifyWebhookBody(body)
  if (outcome.kind === 'challenge') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(outcome.response))
    return
  }
  if (outcome.kind === 'unauthorized') {
    res.writeHead(401)
    res.end('unauthorized')
    return
  }
  if (outcome.kind === 'event') onEvent(body)
  res.writeHead(200)
  res.end('ok')
}

function readBody(req: import('http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', () => resolve(''))
  })
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
