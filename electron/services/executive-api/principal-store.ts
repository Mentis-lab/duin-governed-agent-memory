import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'

// Executive API — principal store (the membrane's ledger).
//
// One row per FOREIGN agent allowed to mount DUIN as its executive: a Claude
// Code session, Codex, a bridge, a teammate's dedicated agent. Replaces the
// single all-powerful exec-token file (server.ts writes userData/exec-token;
// whoever reads it is fully exec-privileged — the estate map's privilege
// inversion). Here every caller is an identified principal with an
// operator-approved plane grant, a revocable token, and an audit trail.
//
// Security decisions (2026-08-14 membrane research, folded into the design
// artifact 32f42d4b):
//  - Tokens are GitHub-style: greppable prefix + CSPRNG body + CRC32 checksum.
//    The checksum lets tooling reject typos/truncations offline and makes the
//    format secret-scanning friendly. `duin_ag_` = agent credential;
//    `duin_pair_` = pairing handle (NOT a credential).
//  - The store persists ONLY sha256(token). Plaintext exists exactly once, in
//    the one-time pairing claim response, and is scrubbed after delivery.
//    Verification hashes the presented token and compares constant-time.
//  - Scope grammar = the plane strings below and nothing else. Shell/exec,
//    provider keys, raw store export are NOT representable as scopes, so no
//    grant, bug, or injection can name them (deny-by-vocabulary, not by list).
//  - Revocation-first, not rotation: revoke/pause take effect on the next
//    request because every request is a registry lookup. No forced expiry —
//    instead lastSeenAt supports an idle flag in the UI.
//  - Pairing is RFC 8628-shaped: agent POSTs a request, the human approves in
//    the "Needs you" inbox (route layer bridges to notices — this module stays
//    pure), the agent polls and claims the token once. Requests expire; the
//    pairing surface is the ONE unauthenticated endpoint so it is rate-limited
//    here at the store level too (belt-and-braces with the route).
//
// This module owns no HTTP and imports no other DUIN service — the route
// layer composes it with notices/approvals and the agui gate.

export type ExecutivePlane =
  | 'context.read' // salience brief, grounded retrieval, world state
  | 'beliefs.read' // operator-model top-k (promoted only, provenance-carrying)
  | 'goals.read'
  | 'goals.write' // register / claim-lease / update / propose-transition (P1)
  | 'judgment.precheck' // forecast + precheck verdicts (advisory)
  | 'learning.submit' // outcome/correction intake, always external-quarantined (P3)
  | 'memory.write' // bounded note writes inside a per-principal write scope (C1)

export const ALL_PLANES: readonly ExecutivePlane[] = [
  'context.read',
  'beliefs.read',
  'goals.read',
  'goals.write',
  'judgment.precheck',
  'learning.submit',
  // C1 (2026-08-17) — bounded note writes into a per-principal write scope. Deliberately a
  // SEPARATE plane from learning.submit: teaching a belief and writing a file are different
  // powers with different blast radii, and folding them would mean approving one to get the
  // other. Not in DEFAULT_PLANES — writes are always asked for explicitly.
  'memory.write'
]

/** What a fresh pairing may request and what approval defaults to when the
 *  operator doesn't trim: the read planes + advisory judgment. Writes are
 *  requested explicitly and stand out in the approval card. */
export const DEFAULT_PLANES: readonly ExecutivePlane[] = [
  'context.read',
  'beliefs.read',
  'goals.read',
  'judgment.precheck'
]

export type PrincipalKind = 'cli-agent' | 'bridge' | 'team-agent' | 'device'
export type PrincipalStatus = 'active' | 'paused' | 'revoked'

export interface ExecutivePrincipal {
  id: string
  name: string
  kind: PrincipalKind
  planes: ExecutivePlane[]
  /** First 8 hex chars of the token hash — displayable, greppable in logs. */
  tokenId: string
  /** sha256 hex of the full token. Never the token itself. */
  tokenHash: string
  createdAt: string
  approvedAt: string
  lastSeenAt: string | null
  /** Best-effort peer exe path observed at pairing (audit-only, never enforcement). */
  observedExe: string | null
  callCount: number
  status: PrincipalStatus
  /** A2 — READ SCOPE, a property of the GRANT rather than of the call. Vault-relative
   *  path prefixes this principal may retrieve from; an EMPTY/absent list means the whole
   *  vault (the pre-2026-08-17 behaviour, now stated instead of assumed). The plane
   *  vocabulary governs verbs and could not express "read only this project", so
   *  `context.read` was all-or-nothing over a vault holding commercial and personnel
   *  material. Scope lives on the principal, not the tool call, so a caller can never
   *  widen it by asking differently. */
  scope?: string[]
  /** A3 — per-principal QUOTA. `k` bounded a single call at 20 hits, but nothing bounded
   *  the number of calls, so whole-vault exfiltration by iteration was unlimited (just
   *  slow). Rolling hourly window; absent = defaults. */
  quota?: PrincipalQuota
  /** A3 — rolling-window accounting. Reset when the window rolls over. */
  usage?: PrincipalUsage
  /** C1 — WRITE SCOPE for the memory.write plane. Vault-relative subtree an agent may
   *  write notes into. Absent means the default agent inbox; it is NEVER the vault root,
   *  and foundation files are refused by name regardless. */
  writeScope?: string
}

export interface PrincipalQuota {
  /** Max tool calls per rolling hour. */
  callsPerHour: number
  /** Max retrieved characters per rolling hour (bounds exfiltration by iteration). */
  charsPerHour: number
}

export interface PrincipalUsage {
  windowStartedAt: string
  calls: number
  chars: number
}

/** Generous enough that honest agent work never notices; tight enough that scraping the
 *  vault takes days rather than minutes. Both are grant properties — adjustable per
 *  principal when an agent genuinely needs more. */
export const DEFAULT_QUOTA: PrincipalQuota = { callsPerHour: 240, charsPerHour: 400_000 }

/** C1 — where memory.write lands when a grant names no subtree. Owned here so the tool,
 *  the identity readout, and the approval card cannot disagree about it; a second copy is
 *  how the write path and the UI would drift into describing different destinations. */
export const DEFAULT_WRITE_SCOPE = '.brain/agent-inbox'

const QUOTA_WINDOW_MS = 60 * 60 * 1000

export interface QuotaVerdict {
  ok: boolean
  /** Populated on refusal — names the limit that was hit, never a bare "denied". */
  reason?: string
  remainingCalls: number
  remainingChars: number
}

/**
 * A3 — charge one tool call against the principal's rolling window, BEFORE the work runs
 * (charging only afterwards would let a slow or failing call escape accounting). Refusal is
 * structured so the agent can back off intelligently instead of retrying blind.
 *
 * Deliberately does NOT persist. `authenticate` a few functions below persists every 20th
 * heartbeat precisely to avoid "a disk write per call", and the first draft of this function
 * broke that policy twice per call — two synchronous whole-store writeFileSync+rename round
 * trips, on the Electron MAIN thread, for every Brain API request. `settleUsage` is the one
 * write, at the end of the call. The window is still bounded in memory throughout, so a
 * refusal never waits on disk.
 */
export function chargeCall(principalId: string): QuotaVerdict {
  const store = load()
  const p = store.principals.find((x) => x.id === principalId)
  if (!p) return { ok: false, reason: 'unknown principal', remainingCalls: 0, remainingChars: 0 }
  const quota = p.quota ?? DEFAULT_QUOTA
  const now = Date.now()
  const prior = p.usage ? Date.parse(p.usage.windowStartedAt) : NaN
  if (!p.usage || Number.isNaN(prior) || now - prior >= QUOTA_WINDOW_MS) {
    p.usage = { windowStartedAt: new Date(now).toISOString(), calls: 0, chars: 0 }
  }
  // Read the window start back from usage AFTER any reset. Reading the pre-reset value
  // instead would be NaN on a fresh or corrupt window, and `new Date(NaN).toISOString()`
  // THROWS — turning a refusal (a normal, expected answer) into a 500. That path is
  // reachable: an operator quota-pinning a principal to 0 refuses on its very first call,
  // when the window has just been created.
  const windowStart = Date.parse(p.usage.windowStartedAt)
  const rollsAt = new Date(windowStart + QUOTA_WINDOW_MS).toISOString()
  if (p.usage.calls >= quota.callsPerHour) {
    return {
      ok: false,
      reason: `call quota exhausted (${quota.callsPerHour}/hour). The window rolls at ${rollsAt}.`,
      remainingCalls: 0,
      remainingChars: Math.max(0, quota.charsPerHour - p.usage.chars)
    }
  }
  if (p.usage.chars >= quota.charsPerHour) {
    return {
      ok: false,
      reason: `retrieved-character quota exhausted (${quota.charsPerHour}/hour). The window rolls at ${rollsAt}.`,
      remainingCalls: Math.max(0, quota.callsPerHour - p.usage.calls),
      remainingChars: 0
    }
  }
  p.usage.calls += 1
  return {
    ok: true,
    remainingCalls: Math.max(0, quota.callsPerHour - p.usage.calls),
    remainingChars: Math.max(0, quota.charsPerHour - p.usage.chars)
  }
}

/**
 * A3 — close out a charged call: add the returned payload size to the window and write the
 * whole accounting to disk ONCE. Every path that called `chargeCall` must reach here,
 * including refusals and thrown handlers — otherwise the call is counted in memory and
 * forgotten on restart, which is the unsafe direction (an agent that restarts its client
 * gets its budget back). `guard()` calls this in a finally block for exactly that reason.
 *
 * `chars` is optional because the refusal and failure paths have no payload to charge but
 * still need the call itself durably recorded.
 */
export function settleUsage(principalId: string, chars?: number): void {
  const store = load()
  const p = store.principals.find((x) => x.id === principalId)
  if (!p?.usage) return
  if (Number.isFinite(chars) && (chars as number) > 0) {
    p.usage.chars += Math.floor(chars as number)
  }
  persist()
}

/** A2 — is `path` inside this principal's read scope? Empty/absent scope = whole vault.
 *  PURE. Compares on normalized forward-slash prefixes so a Windows path cannot slip the
 *  check by separator, and requires a segment boundary so `03 Projects/DUIN` does not
 *  also grant `03 Projects/DUIN-secrets`. */
export function pathInScope(scope: string[] | undefined, path: string | null | undefined): boolean {
  if (!scope || scope.length === 0) return true
  const p = String(path ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase()
  if (!p) return false
  return scope.some((s) => {
    const prefix = String(s ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '').toLowerCase()
    if (!prefix) return true
    return p === prefix || p.startsWith(prefix + '/')
  })
}

export type PairingStatus = 'pending' | 'approved' | 'denied' | 'claimed' | 'expired'

export interface PairingRequest {
  pairingId: string
  name: string
  kind: PrincipalKind
  requestedPlanes: ExecutivePlane[]
  observedExe: string | null
  createdAt: string
  expiresAt: string
  status: PairingStatus
  principalId: string | null
  /** Held between approval and the one-time claim, then scrubbed. */
  oneTimeToken: string | null
}

const TOKEN_PREFIX = 'duin_ag_'
const PAIRING_PREFIX = 'duin_pair_'
const TOKEN_BODY_LEN = 32
const CHECKSUM_LEN = 6
/** Pending pairings expire after 15 minutes — long enough to walk to the
 *  machine, short enough that a forgotten request isn't a standing door.
 *  Re-requesting is free, so AFK approval just means the agent asks again. */
const PAIRING_TTL_MS = 15 * 60 * 1000
/** Approved-but-unclaimed pairings get the same short window, restarted at
 *  approval: the one-time token is plaintext on disk until claimed, so the
 *  handoff buffer must be minutes, not the 24h tail-cleanup. */
const CLAIM_TTL_MS = 15 * 60 * 1000
const MAX_PENDING_PAIRINGS = 5
const MIN_PAIRING_INTERVAL_MS = 2_000

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function randomBase62(len: number): string {
  // Rejection sampling so the alphabet stays uniform (256 % 62 !== 0).
  let out = ''
  while (out.length < len) {
    for (const byte of randomBytes(len * 2)) {
      if (byte < 248) {
        out += BASE62[byte % 62]
        if (out.length === len) break
      }
    }
  }
  return out
}

// Tiny CRC32 (IEEE) — a 30-line dependency beats a supply-chain edge for a
// 6-char typo check. Table built once, lazily.
let crcTable: Uint32Array | null = null
function crc32(text: string): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < text.length; i++) {
    crc = crcTable[(crc ^ text.charCodeAt(i)) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function checksumOf(body: string): string {
  let value = crc32(body)
  let out = ''
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    out = BASE62[value % 62] + out
    value = Math.floor(value / 62)
  }
  return out
}

export function mintToken(): string {
  const body = randomBase62(TOKEN_BODY_LEN)
  return `${TOKEN_PREFIX}${body}${checksumOf(body)}`
}

/** Offline shape/checksum check. A cheap pre-hash filter: malformed or typo'd
 *  tokens are rejected before any hashing or store lookup happens. */
export function tokenFormatOk(token: string): boolean {
  if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return false
  const rest = token.slice(TOKEN_PREFIX.length)
  if (rest.length !== TOKEN_BODY_LEN + CHECKSUM_LEN) return false
  const body = rest.slice(0, TOKEN_BODY_LEN)
  const checksum = rest.slice(TOKEN_BODY_LEN)
  if ([...rest].some((ch) => !BASE62.includes(ch))) return false
  return checksumOf(body) === checksum
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

interface StoreShape {
  version: 1
  principals: ExecutivePrincipal[]
  pairings: PairingRequest[]
}

let storePathOverride: string | null = null
let cache: StoreShape | null = null
let lastPairingRequestAt = 0

function storePath(): string {
  if (storePathOverride) return storePathOverride
  // Resolved lazily so importing this module never touches electron before
  // app-ready (mirrors the settings/mcp-servers.json pattern).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return join(app.getPath('userData'), 'executive-principals.json')
}

function load(): StoreShape {
  if (cache) return cache
  const path = storePath()
  if (!existsSync(path)) {
    cache = { version: 1, principals: [], pairings: [] }
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as StoreShape
    cache = {
      version: 1,
      principals: Array.isArray(raw.principals) ? raw.principals : [],
      pairings: Array.isArray(raw.pairings) ? raw.pairings : []
    }
  } catch {
    // A corrupt registry must fail CLOSED (no principals authenticate), never
    // open. Keep the corrupt file for forensics; start empty in memory.
    cache = { version: 1, principals: [], pairings: [] }
  }
  return cache
}

function persist(): void {
  const path = storePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Atomic-enough on one volume: write sibling tmp, rename over.
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(load(), null, 2), 'utf-8')
  renameSync(tmp, path)
}

function nowIso(): string {
  return new Date().toISOString()
}

function sweepExpiredPairings(store: StoreShape): void {
  const now = Date.now()
  for (const p of store.pairings) {
    if (p.status === 'pending' && Date.parse(p.expiresAt) < now) {
      p.status = 'expired'
      p.oneTimeToken = null
    }
    // Approved-but-never-claimed past its claim window: scrub the plaintext
    // token AND revoke the phantom principal minted at approval — nobody ever
    // held its credential, and leaving it 'active' shows a connected agent
    // that does not exist.
    if (p.status === 'approved' && Date.parse(p.expiresAt) < now) {
      p.status = 'expired'
      p.oneTimeToken = null
      const phantom = p.principalId
        ? store.principals.find((pr) => pr.id === p.principalId)
        : undefined
      if (phantom && phantom.status === 'active') phantom.status = 'revoked'
    }
  }
  // Keep the tail small: drop terminal records older than a day.
  const cutoff = now - 24 * 60 * 60 * 1000
  store.pairings = store.pairings.filter(
    (p) => p.status === 'pending' || Date.parse(p.createdAt) >= cutoff
  )
}

export interface RequestPairingInput {
  name: string
  kind?: PrincipalKind
  requestedPlanes?: ExecutivePlane[]
  observedExe?: string | null
}

export type RequestPairingResult =
  | { ok: true; pairingId: string; expiresAt: string }
  | { ok: false; reason: 'rate-limited' | 'too-many-pending' | 'invalid' }

export function requestPairing(input: RequestPairingInput): RequestPairingResult {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : ''
  if (!name) return { ok: false, reason: 'invalid' }
  const kind: PrincipalKind = (
    ['cli-agent', 'bridge', 'team-agent', 'device'] as PrincipalKind[]
  ).includes(input.kind as PrincipalKind)
    ? (input.kind as PrincipalKind)
    : 'cli-agent'
  const requested = (input.requestedPlanes ?? [...DEFAULT_PLANES]).filter((p): p is ExecutivePlane =>
    (ALL_PLANES as readonly string[]).includes(p)
  )
  if (requested.length === 0) return { ok: false, reason: 'invalid' }

  const now = Date.now()
  if (now - lastPairingRequestAt < MIN_PAIRING_INTERVAL_MS) {
    return { ok: false, reason: 'rate-limited' }
  }
  const store = load()
  sweepExpiredPairings(store)
  if (store.pairings.filter((p) => p.status === 'pending').length >= MAX_PENDING_PAIRINGS) {
    return { ok: false, reason: 'too-many-pending' }
  }
  lastPairingRequestAt = now

  const pairing: PairingRequest = {
    pairingId: `${PAIRING_PREFIX}${randomUUID()}`,
    name,
    kind,
    requestedPlanes: requested,
    observedExe: input.observedExe ?? null,
    createdAt: nowIso(),
    expiresAt: new Date(now + PAIRING_TTL_MS).toISOString(),
    status: 'pending',
    principalId: null,
    oneTimeToken: null
  }
  store.pairings.push(pairing)
  persist()
  return { ok: true, pairingId: pairing.pairingId, expiresAt: pairing.expiresAt }
}

export function listPendingPairings(): PairingRequest[] {
  const store = load()
  sweepExpiredPairings(store)
  return store.pairings.filter((p) => p.status === 'pending').map((p) => ({ ...p }))
}

export function getPairing(pairingId: string): PairingRequest | null {
  const store = load()
  sweepExpiredPairings(store)
  const hit = store.pairings.find((p) => p.pairingId === pairingId)
  // The plaintext one-time token has exactly ONE sanctioned exit: claimPairing.
  // This read surface never carries it, so future callers can't leak it.
  return hit ? { ...hit, oneTimeToken: null } : null
}

/** Operator approval. `grantPlanes` lets the human TRIM the request (never
 *  widen: granting a plane that wasn't requested would silently exceed what
 *  the agent asked the operator to review). Mints the principal + token; the
 *  token is delivered to the AGENT only via claimPairing, exactly once. */
export function approvePairing(
  pairingId: string,
  opts?: { grantPlanes?: ExecutivePlane[] }
): { ok: true; principal: ExecutivePrincipal } | { ok: false; reason: string } {
  const store = load()
  sweepExpiredPairings(store)
  const pairing = store.pairings.find((p) => p.pairingId === pairingId)
  if (!pairing) return { ok: false, reason: 'not-found' }
  if (pairing.status !== 'pending') return { ok: false, reason: `not-pending:${pairing.status}` }

  const granted = (opts?.grantPlanes ?? pairing.requestedPlanes).filter((p) =>
    pairing.requestedPlanes.includes(p)
  )
  if (granted.length === 0) return { ok: false, reason: 'no-planes-granted' }

  const token = mintToken()
  const tokenHash = hashToken(token)
  const principal: ExecutivePrincipal = {
    id: `prin-${randomUUID()}`,
    name: pairing.name,
    kind: pairing.kind,
    planes: granted,
    tokenId: tokenHash.slice(0, 8),
    tokenHash,
    createdAt: pairing.createdAt,
    approvedAt: nowIso(),
    lastSeenAt: null,
    observedExe: pairing.observedExe,
    callCount: 0,
    status: 'active'
  }
  store.principals.push(principal)
  pairing.status = 'approved'
  pairing.principalId = principal.id
  pairing.oneTimeToken = token
  // Restart the clock for the claim leg: the plaintext token's life on disk
  // is bounded by THIS stamp (sweep expires approved rows past it), not by
  // the 24h tail-cleanup.
  pairing.expiresAt = new Date(Date.now() + CLAIM_TTL_MS).toISOString()
  persist()
  return { ok: true, principal: { ...principal } }
}

/**
 * Operator-initiated admission: mint a principal and its token directly, with no pairing
 * request to approve.
 *
 * The pairing flow assumes the AGENT asks first, which is right when a foreign agent shows up
 * uninvited but backwards when the operator already knows which agent they want. It also left
 * the Agents pane a dead end: with nothing asking, there was no action on the screen at all.
 *
 * The security properties are unchanged, and one is stronger. Plaintext still exists exactly
 * once, in this return value — the store keeps only sha256. Planes are chosen by the operator
 * rather than trimmed from an agent's request, so nothing can be granted that was not picked
 * deliberately. What is lost is `observedExe`, an audit-only field with no peer to observe
 * here; it is recorded null rather than guessed.
 */
export function createPrincipal(input: {
  name: string
  kind?: PrincipalKind
  planes?: ExecutivePlane[]
}): { ok: true; principal: ExecutivePrincipal; token: string } | { ok: false; reason: string } {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 64) : ''
  if (!name) return { ok: false, reason: 'name required' }
  const kind: PrincipalKind = (['cli-agent', 'bridge', 'team-agent', 'device'] as PrincipalKind[]).includes(
    input.kind as PrincipalKind
  )
    ? (input.kind as PrincipalKind)
    : 'cli-agent'
  const planes = (input.planes ?? [...DEFAULT_PLANES]).filter((p): p is ExecutivePlane =>
    (ALL_PLANES as readonly string[]).includes(p)
  )
  if (planes.length === 0) return { ok: false, reason: 'grant at least one plane' }

  const store = load()
  const token = mintToken()
  const tokenHash = hashToken(token)
  const principal: ExecutivePrincipal = {
    id: `prin-${randomUUID()}`,
    name,
    kind,
    planes,
    tokenId: tokenHash.slice(0, 8),
    tokenHash,
    createdAt: nowIso(),
    approvedAt: nowIso(),
    lastSeenAt: null,
    observedExe: null,
    callCount: 0,
    status: 'active'
  }
  store.principals.push(principal)
  persist()
  return { ok: true, principal: { ...principal }, token }
}

export function denyPairing(pairingId: string): boolean {
  const store = load()
  const pairing = store.pairings.find((p) => p.pairingId === pairingId)
  if (!pairing || pairing.status !== 'pending') return false
  pairing.status = 'denied'
  pairing.oneTimeToken = null
  persist()
  return true
}

export type ClaimResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'already-claimed' }
  | { status: 'ready'; token: string; principalId: string; planes: ExecutivePlane[] }

/** The agent's poll. Delivers the plaintext token exactly once, then scrubs it
 *  from the store — a second claim (or a disk read later) yields nothing. */
export function claimPairing(pairingId: string): ClaimResult {
  const store = load()
  sweepExpiredPairings(store)
  const pairing = store.pairings.find((p) => p.pairingId === pairingId)
  if (!pairing || pairing.status === 'expired') return { status: 'expired' }
  if (pairing.status === 'pending') return { status: 'pending' }
  if (pairing.status === 'denied') return { status: 'denied' }
  if (pairing.status === 'claimed' || !pairing.oneTimeToken || !pairing.principalId) {
    return { status: 'already-claimed' }
  }
  const token = pairing.oneTimeToken
  const principal = store.principals.find((p) => p.id === pairing.principalId)
  pairing.status = 'claimed'
  pairing.oneTimeToken = null
  persist()
  return {
    status: 'ready',
    token,
    principalId: pairing.principalId,
    planes: principal ? [...principal.planes] : []
  }
}

/** Bearer verification: format check → hash → registry lookup → status gate.
 *  Touches lastSeen/callCount on success (the audit heartbeat). */
export function authenticate(bearer: string | undefined): ExecutivePrincipal | null {
  if (!bearer || !tokenFormatOk(bearer)) return null
  const presented = hashToken(bearer)
  const store = load()
  const principal = store.principals.find((p) => hashesEqual(p.tokenHash, presented))
  if (!principal || principal.status !== 'active') return null
  principal.lastSeenAt = nowIso()
  principal.callCount += 1
  // Heartbeats persist lazily-but-eventually: every write here is cheap JSON,
  // but avoid a disk write per call — persist every 20th touch.
  if (principal.callCount % 20 === 1) persist()
  return { ...principal }
}

export function hasPlane(principal: ExecutivePrincipal, plane: ExecutivePlane): boolean {
  return principal.planes.includes(plane)
}

export function listPrincipals(): ExecutivePrincipal[] {
  return load().principals.map((p) => ({ ...p }))
}

export function setPrincipalStatus(
  principalId: string,
  status: PrincipalStatus
): boolean {
  const store = load()
  const principal = store.principals.find((p) => p.id === principalId)
  if (!principal) return false
  // Revocation is permanent by policy: the old plaintext token is still in the
  // agent's config, so flipping revoked→active would resurrect a credential
  // the operator already declared dead. The path back is a fresh pairing (or
  // reissueToken for non-revoked principals).
  if (principal.status === 'revoked') return false
  principal.status = status
  persist()
  return true
}

/** What the operator can change about a live grant WITHOUT re-pairing. Planes are absent on
 *  purpose: they are chosen once, at approval, against what the agent actually asked for, and
 *  widening them later would grant authority the agent never requested and the operator never
 *  reviewed side-by-side. Narrowing is what `paused` and `revoked` are for.
 *
 *  `null` means RESET TO DEFAULT, and is distinct from an empty value: `quota: null` restores
 *  DEFAULT_QUOTA, while `{callsPerHour: 0}` pins the principal to zero. Collapsing those two
 *  would make "I cleared the field" silently mean "I banned it" (property 8). */
export interface GrantPatch {
  scope?: string[] | null
  writeScope?: string | null
  quota?: PrincipalQuota | null
}

/** Operator edit of a live grant's bounds. Returns false for unknown or revoked principals —
 *  revocation is permanent by policy, so re-scoping a dead credential must not appear to work. */
export function updatePrincipalGrant(principalId: string, patch: GrantPatch): boolean {
  const store = load()
  const principal = store.principals.find((p) => p.id === principalId)
  if (!principal || principal.status === 'revoked') return false

  if (patch.scope !== undefined) {
    const cleaned = (patch.scope ?? [])
      .map((s) => String(s ?? '').trim())
      .filter((s) => s.length > 0)
    // An empty list is the WIDEST grant (whole vault), so store the absence rather than an
    // empty array — one representation for "unscoped", not two that read differently.
    if (cleaned.length === 0) delete principal.scope
    else principal.scope = cleaned
  }

  if (patch.writeScope !== undefined) {
    const trimmed = String(patch.writeScope ?? '').trim()
    if (!trimmed) delete principal.writeScope
    else principal.writeScope = trimmed
  }

  if (patch.quota !== undefined) {
    if (patch.quota === null) {
      delete principal.quota
    } else {
      // A NaN or negative ceiling would poison chargeCall's comparisons — it would compare
      // against NaN, which is false for every operator, so the bound would silently vanish.
      const calls = Math.floor(Number(patch.quota.callsPerHour))
      const chars = Math.floor(Number(patch.quota.charsPerHour))
      if (!Number.isFinite(calls) || !Number.isFinite(chars) || calls < 0 || chars < 0) return false
      principal.quota = { callsPerHour: calls, charsPerHour: chars }
    }
  }

  persist()
  return true
}

/** New token for an existing principal (suspicion / scope change). The old
 *  token dies immediately — a grace overlap would mean two live credentials
 *  and this is a single-machine hop, so re-pairing friction is seconds. */
export function reissueToken(
  principalId: string
): { ok: true; token: string } | { ok: false } {
  const store = load()
  const principal = store.principals.find((p) => p.id === principalId)
  if (!principal || principal.status === 'revoked') return { ok: false }
  const token = mintToken()
  principal.tokenHash = hashToken(token)
  principal.tokenId = principal.tokenHash.slice(0, 8)
  persist()
  return { ok: true, token }
}

// Test seam — point the store at a temp file and drop caches.
export const __principalStoreTest = {
  setPath(path: string | null): void {
    storePathOverride = path
    cache = null
    lastPairingRequestAt = 0
  },
  reset(): void {
    cache = null
    lastPairingRequestAt = 0
  },
  checksumOf,
  crc32
}
