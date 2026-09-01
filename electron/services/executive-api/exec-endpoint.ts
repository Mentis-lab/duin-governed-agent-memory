import type { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  authenticate,
  claimPairing,
  hasPlane,
  requestPairing,
  chargeCall,
  settleUsage,
  pathInScope,
  ALL_PLANES,
  DEFAULT_PLANES,
  DEFAULT_QUOTA,
  DEFAULT_WRITE_SCOPE,
  type ExecutivePlane,
  type ExecutivePrincipal
} from './principal-store'
import { EXEC_HOOK_PATH, handleExecutorHook } from '../executor/executor-callbacks'
import {
  authorizeGoalWrite,
  claimGoalLease,
  getGoalLease,
  recordGoalCreation,
  releaseGoalLease
} from './goal-lease-store'

// Executive API — the mount. Foreign agents (Claude Code, Codex, bridges)
// reach DUIN's executive planes through MCP over streamable HTTP at
// POST /exec/mcp on the loopback brain server. Design artifact 32f42d4b;
// transport decision from the 2026-08-14 MCP research: in-process streamable
// HTTP is the primary mount (every target client speaks it natively and
// auto-reconnects across DUIN restarts, which stdio child servers do not),
// stateless per-request servers, toolset VARIES BY AUTHORIZATION — a caller
// with no/invalid bearer sees exactly the pairing tools, a paired principal
// sees the tools its granted planes allow. The spec explicitly sanctions
// per-authorization tool sets.
//
// Route family contract with server.ts: handleExecutiveRequest() returns true
// if the request was handled (any /exec/ path), false otherwise; server.ts
// calls it after its CSRF guard and before handleRequestNative. All organ
// calls happen in-process — this family never proxies to the unauthenticated
// /state routes, so per-principal redaction (promoted-only beliefs, external
// quarantine) is enforced at THIS seam.
//
// Hardening (membrane research): reject any request whose Host is not the
// loopback brain address, and any request carrying a non-loopback Origin —
// a browser page (DNS rebinding makes it same-origin with 127.0.0.1) must
// never reach the MCP handler even before auth. No CORS headers are ever
// emitted. There are NO unauthenticated data routes: the only thing an
// anonymous caller can do is ask to pair, and that surface is rate-limited
// in the principal store.

const EXEC_PREFIX = '/exec/'
const MCP_PATH = '/exec/mcp'
const BODY_CAP_BYTES = 1024 * 1024
/** Hard cap on any single tool result. Context-rot research says a bounded
 *  brief is a correctness feature; Claude Code warns at 10k tokens. */
const RESULT_CHAR_CAP = 24_000

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = String(req.headers.host ?? '').toLowerCase()
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host === '127.0.0.1' || host === 'localhost'
}

function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true // native clients send no Origin
  try {
    const u = new URL(String(origin))
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  } catch {
    return false
  }
}

function bearerOf(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return undefined
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return m ? m[1].trim() : undefined
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_CAP_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8')
      if (!text) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function capText(text: string): string {
  if (text.length <= RESULT_CHAR_CAP) return text
  return text.slice(0, RESULT_CHAR_CAP) + `\n[truncated at ${RESULT_CHAR_CAP} chars]`
}

function toolText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: capText(JSON.stringify(payload, null, 1)) }] }
}

/** A3 — what the principal has actually spent this window, expressed as BUDGET LEFT.
 *  A principal that has never called has no `usage` row; reporting that absence as `null`
 *  would make "how much do I have left?" unanswerable exactly when the answer is "all of
 *  it". Derives from the same effective quota `chargeCall` enforces, so the readout and
 *  the refusal can never disagree. */
function usageReadout(principal: ExecutivePrincipal): Record<string, unknown> {
  const quota = principal.quota ?? DEFAULT_QUOTA
  const used = principal.usage ?? { calls: 0, chars: 0, windowStartedAt: null }
  return {
    windowStartedAt: used.windowStartedAt,
    calls: used.calls,
    chars: used.chars,
    remainingCalls: Math.max(0, quota.callsPerHour - used.calls),
    remainingChars: Math.max(0, quota.charsPerHour - used.chars)
  }
}

/**
 * A3+A4 — the one place every authenticated tool passes through: charge the quota,
 * audit the call, run the work, charge the returned size.
 *
 * Wrapping rather than sprinkling checks per tool is deliberate: the `web_find` incident
 * in the chat gate showed what happens when one risk declaration feeds several gates and
 * a single site forgets one. Here a tool that is not wrapped is not authorized, because
 * `guard` is also where the plane's audit row is written.
 *
 * Never throws: a quota refusal and a handler failure both return structured tool errors,
 * because an agent that gets an exception instead of a reason retries blind.
 */
async function guard(
  principal: ExecutivePrincipal,
  tool: string,
  plane: string,
  detail: Record<string, unknown>,
  work: () => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
  const verdict = chargeCall(principal.id)
  // One durable write per call, on EVERY exit — refusal, throw, or success. Accounting that
  // lives only in memory until the happy path would hand an agent its budget back by
  // restarting its client, so the settle is a finally, not a success-path step.
  let chars = 0
  try {
    if (!verdict.ok) {
      auditExec(principal, tool, plane, { ...detail, refused: 'quota' }, 'warning')
      return toolError(
        `Refused: ${verdict.reason} This is a per-principal limit, not an error — back off and resume after the window rolls, or ask the operator to raise the quota for "${principal.name}".`
      )
    }
    let out: { content: Array<{ type: 'text'; text: string }>; isError?: true }
    try {
      out = await work()
    } catch (err) {
      auditExec(principal, tool, plane, { ...detail, failed: true }, 'warning')
      return toolError(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    chars = out.content.reduce((n, c) => n + (c.text?.length ?? 0), 0)
    auditExec(principal, tool, plane, { ...detail, chars, remainingCalls: verdict.remainingCalls })
    return out
  } finally {
    settleUsage(principal.id, chars)
  }
}

/** A4 — every Brain-API call lands on the event spine. Reads were previously invisible:
 *  `lastSeenAt` plus a counter could not answer "what did this agent read on Tuesday",
 *  while writes were visible because they parked a decision. Bodies are never logged —
 *  the query and the result SIZE are, which is what an exfiltration review actually needs.
 *  Best-effort: auditing must never break a call. */
function auditExec(
  principal: ExecutivePrincipal,
  tool: string,
  plane: string,
  detail: Record<string, unknown>,
  severity: 'info' | 'warning' = 'info'
): void {
  // Fire-and-forget dynamic import, the same shape act/external-action.ts uses: it keeps
  // this module free of the DB at import time (the server is constructed per request) and
  // it cannot reject into the caller. Auditing is upkeep; the call is the load-bearing
  // effect, so a broken spine must never turn a granted read into a failure.
  void import('../event-log')
    .then(({ recordEvent }) =>
      recordEvent({
        type: 'tool.call.approved',
        actorKind: 'system',
        severity,
        entityKind: 'tool',
        entityId: tool,
        payload: {
          toolId: tool,
          surface: 'brain-api',
          principalId: principal.id,
          principalName: principal.name,
          plane,
          ...detail
        }
      })
    )
    .catch(() => {})
}

function toolError(message: string): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ---------------------------------------------------------------------------
// Organ adapters. Dynamically imported so this module stays light at load
// (server-load safety) and tests can vi.mock each organ independently. Every
// adapter enforces the external-caller redaction rules AT THIS SEAM.
// ---------------------------------------------------------------------------

async function briefPayload(): Promise<unknown> {
  const { readSettings } = await import('../settings-helper')
  const { getHomeDigest } = await import('../brain/index')
  // Same key the renderer's brain:homeDigest handler uses — the vault dir
  // lives in settings as localBrainNotesDir (caught by live dogfood: the
  // wrong key silently serves the empty-brain fallback).
  const vaultDir = (readSettings().localBrainNotesDir as string | undefined) || null
  const digest = getHomeDigest(vaultDir)
  // The brief is a BRIEF: top slices only, score-ordered as the digest already is.
  const slice = <T>(items: T[] | undefined): T[] => (Array.isArray(items) ? items.slice(0, 8) : [])
  return {
    tracks: slice(digest.tracks),
    insights: slice(digest.insights),
    needs: slice(digest.needs),
    away: digest.away ?? null,
    returnReason: digest.returnReason ?? null
  }
}

async function retrievePayload(query: string, k: number, scope?: string[]): Promise<unknown> {
  const { search } = await import('../local-brain/index-store')
  // A2 — over-fetch before scope filtering, so a scoped principal still gets k results
  // when its subtree has them. Filtering the k-sized page would silently return fewer
  // hits the narrower the grant, which reads as "your vault has little on this" rather
  // than "you were shown only your slice".
  const scoped = Array.isArray(scope) && scope.length > 0
  const raw = await search(query, scoped ? Math.min(k * 5, 100) : k)
  const inScope = scoped
    ? raw.filter((h) => {
        const r = h as unknown as Record<string, unknown>
        return pathInScope(scope, (r.path ?? r.file) as string | null)
      })
    : raw
  const hits = inScope.slice(0, k)
  return {
    query,
    ...(scoped ? { scope, note: 'Results are limited to the paths this principal was granted.' } : {}),
    hits: hits.map((h) => {
      const r = h as unknown as Record<string, unknown>
      return {
        path: r.path ?? r.file ?? null,
        title: r.title ?? null,
        score: r.score ?? null,
        snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 700) : (r.text as string | undefined)?.slice(0, 700) ?? null
      }
    })
  }
}

async function beliefsPayload(topic: string, k: number): Promise<unknown> {
  const om = await import('../brain/operator-model')
  // External principals see PROMOTED beliefs only — never candidates,
  // provisionals, reverted or vetoed facts, and never external-quarantined
  // ones. Comprehension-as-a-service: relevance-ranked top-k with
  // provenance, not a store export.
  const live = om
    .getOperatorFacts()
    .filter(
      (f) => f.status === 'promoted' && !om.isQuarantinedExternal(f)
    )
  const needle = topic.trim().toLowerCase()
  const terms = needle.split(/\s+/).filter((t) => t.length > 1)
  const scored = live
    .map((f) => {
      const text = String(f.fact ?? '').toLowerCase()
      let score = 0
      for (const t of terms) if (text.includes(t)) score += 1
      return { f, score }
    })
    .filter((s) => (terms.length > 0 ? s.score > 0 : true))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
  return {
    topic,
    beliefs: scored.map(({ f }) => {
      const r = f as unknown as Record<string, unknown>
      return {
        fact: f.fact,
        kind: r.kind ?? null,
        status: f.status,
        source: r.source ?? 'operator',
        capturedAt: r.capturedAt ?? null
      }
    }),
    note:
      scored.length === 0
        ? 'No promoted beliefs matched this topic. Broaden the topic or ask duin_retrieve for grounded documents instead.'
        : undefined
  }
}

/** The ratified fork: ONE global fleet goal-state. All principal-registered
 *  goals live in this shared scope — distinct from '__global__' (internal
 *  conversationless tool runs) and never collidable with a chat conversation
 *  UUID, so chat deletion can never clear fleet goals. */
export const FLEET_SCOPE = 'fleet:shared'

async function goalsPayload(): Promise<unknown> {
  const { getAllPlanGoalState } = await import('../plan-goal-store')
  const all = getAllPlanGoalState()
  const goals: unknown[] = []
  for (const entry of all) {
    const e = entry as unknown as Record<string, unknown>
    const scope = (e.conversationId as string) ?? null
    const list = Array.isArray(e.goals) ? (e.goals as Record<string, unknown>[]) : []
    for (const g of list) {
      const row: Record<string, unknown> = {
        id: g.id,
        title: g.title ?? g.text ?? null,
        lifecycleStatus: g.lifecycleStatus ?? g.status ?? null,
        scope,
        lastActor: g.lastActor ?? null,
        updatedAt: g.updatedAt ?? null
      }
      if (scope === FLEET_SCOPE && typeof g.id === 'string') {
        const lease = getGoalLease(g.id)
        row.lease = lease.live
          ? { holder: lease.holderName ?? lease.holder, epoch: lease.epoch }
          : { holder: null, epoch: lease.epoch }
        row.createdBy = lease.createdBy
      }
      goals.push(row)
    }
  }
  return { goals: goals.slice(0, 100), total: goals.length }
}

/** transitionGoal's ANS gate throws this shape when the model actor lacks the
 *  earned rung — the marker the hold-conversion matches on. */
function isAuthorityDenial(err: unknown): boolean {
  return err instanceof Error && err.message.includes('model authority cannot')
}

/** Parse the actionId a parked fleet-goal proposal carries — the format is
 *  MINTED in duin_goal_propose_transition below (`exec-goal-<action>-<goalId>`)
 *  and consumed by the operator's executive:goals:decide IPC. Lives beside the
 *  minting so the two can never drift apart silently. */
export function parseGoalHoldActionId(
  actionId: string
): { action: 'complete' | 'abort'; goalId: string } | null {
  const m = /^exec-goal-(complete|abort)-(.+)$/.exec(actionId)
  if (!m) return null
  return { action: m[1] as 'complete' | 'abort', goalId: m[2] }
}

async function forecastPayload(): Promise<unknown> {
  const { readSettings } = await import('../settings-helper')
  const { forecastRecord } = await import('../brain/forecast-record-native')
  const vaultDir = (readSettings().localBrainNotesDir as string | undefined) || null
  const record = forecastRecord(vaultDir) as unknown as Record<string, unknown>
  return {
    forecast: record,
    note: 'Read-only projection of the decision-window forecast track record and calibration. Advisory: this is the same signal DUIN’s own loops calibrate against.'
  }
}

// ---------------------------------------------------------------------------
// Server construction — the toolset is a function of the caller's authority.
// ---------------------------------------------------------------------------

function buildServer(principal: ExecutivePrincipal | null): McpServer {
  const server = new McpServer({ name: 'duin-brain', version: '0.1.0' })

  if (!principal) {
    // Anonymous callers get exactly one capability: asking the operator for
    // access. Both tools work without auth; everything else needs a pairing.
    server.tool(
      'duin_pair',
      'Request access to DUIN Brain. Creates a pairing request the operator must approve inside DUIN ("Needs you"). Returns a pairingId to poll with duin_pair_claim. Pairing expires in 15 minutes; re-requesting is cheap.',
      {
        name: z.string().min(1).max(64).describe('Name shown to the operator, e.g. "claude-code"'),
        kind: z.enum(['cli-agent', 'bridge', 'team-agent', 'device']).optional(),
        // DERIVED from ALL_PLANES, never re-typed. This was a hand-written copy of the
        // vocabulary, which meant adding a plane in principal-store.ts and forgetting it here
        // produced a plane that could be granted but never REQUESTED — invisible, because
        // nothing compares the two lists. The store owns the vocabulary; this is a view of it.
        planes: z
          .array(z.enum(ALL_PLANES as unknown as [ExecutivePlane, ...ExecutivePlane[]]))
          .optional()
          .describe('Planes to request. Omit for the read defaults. The operator can trim, never widen.')
      },
      async ({ name, kind, planes }) => {
        const result = requestPairing({ name, kind, requestedPlanes: planes })
        if (!result.ok) return toolError(`Pairing request refused: ${result.reason}. Wait a moment and retry.`)
        try {
          const { recordNotice } = await import('../proactive/notices-store')
          recordNotice({
            kind: 'approval',
            severity: 'info',
            title: `DUIN Brain pairing: "${name}" requests access`,
            // The decision point must show WHAT is being granted — a
            // goals.write request approved sight-unseen is the exact failure
            // the plane vocabulary exists to prevent.
            // Do NOT name a screen here. This body used to say "approve in Connected Agents",
            // a surface that has never existed — the IPC (executive:pairings:approve) and its
            // preload binding are both live, but no renderer component calls them yet, so the
            // instruction sent the operator somewhere they could not go. Name the DECISION and
            // the id; the location belongs in the UI that eventually renders this.
            body: `A local agent named "${name}" (${kind ?? 'cli-agent'}) asked to mount DUIN Brain. Requested planes: ${(planes ?? DEFAULT_PLANES).join(', ')}${
              (planes ?? []).some((p) => p === 'goals.write' || p === 'memory.write' || p === 'learning.submit')
                ? ' — includes WRITE access'
                : ''
            }. It can read nothing until you approve. Expires in 15 minutes; re-requesting is cheap, so declining by ignoring it is safe. Pairing id: ${result.pairingId}`,
            needsDecision: true,
            actionId: result.pairingId,
            dedupKey: `exec-pair-${name}`
          })
        } catch {
          // The pairing still exists; the notice is best-effort.
        }
        return toolText({
          pairingId: result.pairingId,
          expiresAt: result.expiresAt,
          next: 'Ask the DUIN operator to approve this pairing, then call duin_pair_claim with the pairingId. The one-time token it returns must be configured as the Authorization: Bearer header for this MCP server.'
        })
      }
    )

    server.tool(
      'duin_pair_claim',
      'Poll a pairing request. Once the operator approves, returns the one-time bearer token for this agent — store it and configure it as the Authorization header; it will never be shown again.',
      { pairingId: z.string().min(1) },
      async ({ pairingId }) => {
        const result = claimPairing(pairingId)
        if (result.status === 'ready') {
          return toolText({
            token: result.token,
            planes: result.planes,
            configure:
              'Reconnect this MCP server with header "Authorization: Bearer <token>". Example: claude mcp add --transport http duin http://127.0.0.1:8799/exec/mcp --header "Authorization: Bearer <token>"'
          })
        }
        return toolText({ status: result.status })
      }
    )
    return server
  }

  // Paired principal — register exactly what the granted planes allow.
  server.tool(
    'duin_whoami',
    'Identity check: which principal this token belongs to, which planes are granted, and the read scope + quota the grant carries.',
    {},
    async () =>
      toolText({
        id: principal.id,
        name: principal.name,
        kind: principal.kind,
        planes: principal.planes,
        // A2/A3 — the grant's LIMITS are part of identity. An agent that cannot see its own
        // scope and quota cannot plan around them, and will read a scoped miss as an empty
        // vault or a quota refusal as a broken server.
        readScope: principal.scope?.length ? principal.scope : 'whole vault',
        // The DEFAULT write scope, stated — not `null`. A null here would read as "no write
        // scope" when the plane, if granted, actually writes to the agent inbox.
        writeScope: hasPlane(principal, 'memory.write')
          ? principal.writeScope || DEFAULT_WRITE_SCOPE
          : 'not granted',
        // EFFECTIVE quota, never the raw field. An absent override is not an absent limit:
        // reporting `null` would tell an agent it is unbounded moments before a refusal it
        // could not have predicted (property 8 — unset is not zero, and not infinity).
        quota: principal.quota ?? DEFAULT_QUOTA,
        usage: usageReadout(principal),
        lastSeenAt: principal.lastSeenAt
      })
  )

  if (hasPlane(principal, 'context.read')) {
    server.tool(
      'duin_brief',
      'DUIN’s salience brief: what matters right now across the operator’s tracks — scored digest items, open needs, and the away/return context. Bounded by design; drill down with duin_retrieve.',
      {},
      async () =>
        guard(principal, 'duin_brief', 'context.read', {}, async () => toolText(await briefPayload()))
    )
    server.tool(
      'duin_retrieve',
      'Grounded retrieval over the operator’s knowledge base (hybrid keyless search). Returns scored hits with snippets and paths. Results are limited to this principal’s granted read scope.',
      { query: z.string().min(1).max(500), k: z.number().int().min(1).max(20).optional() },
      async ({ query, k }) =>
        guard(principal, 'duin_retrieve', 'context.read', { query: query.slice(0, 120) }, async () =>
          toolText(await retrievePayload(query, k ?? 6, principal.scope))
        )
    )
  }

  // ── B1 · read parity — one call that returns what a CHAT TURN grounds on ───
  // Before this, a mounted agent had duin_brief + duin_retrieve + duin_beliefs and had to
  // hand-assemble a prompt from the parts — reliably a worse prompt than DUIN builds for
  // itself, because the layers that make a chat turn sound like it knows the operator
  // (identity, memory index, relevance-ranked recall) were not exposed at all.
  //
  // Composition mirrors buildGroundedMessages: identity first (character before rules —
  // the SOUL/BRAIN split is load-bearing), then the memory index, then relevance-ranked
  // recall, then scoped hits. What it does NOT do is hand back a finished system prompt:
  // the agent has its own harness and its own voice, so this returns the MATERIAL, labelled,
  // for the agent to assemble. Requires both context.read and beliefs.read because it
  // returns both kinds of material; each half is separately gated below.
  if (hasPlane(principal, 'context.read')) {
    server.tool(
      'duin_context',
      'Everything DUIN would ground on for this query, in one call: operator identity, the memory index, relevance-ranked beliefs/taste, and scoped retrieval hits. Use this INSTEAD of duin_brief + duin_retrieve + duin_beliefs when you are about to reason about the operator — it is the same material a DUIN chat turn is built from.',
      { query: z.string().min(1).max(500), k: z.number().int().min(1).max(20).optional() },
      async ({ query, k }) =>
        guard(principal, 'duin_context', 'context.read', { query: query.slice(0, 120) }, async () => {
          const payload: Record<string, unknown> = { query }
          // Identity — the always-on layer every chat turn opens with.
          try {
            const { readSettings } = await import('../settings-helper')
            const vaultDir = (readSettings().localBrainNotesDir as string | undefined) || null
            const { loadBrain } = await import('../brain/brain-root')
            // LoadedBrain is { identity, memory[], root, identityFiles[] } — `identity` is
            // the CONCATENATED SOUL/BRAIN/ME content in read order, not separate fields.
            const brain = vaultDir ? loadBrain(vaultDir) : null
            payload.identity = brain
              ? {
                  text: brain.identity || null,
                  // File names, not the vault root: the agent needs to know WHICH identity
                  // files spoke, and shipping absolute paths would leak the operator's
                  // directory layout for no benefit.
                  sources: (brain.identityFiles ?? []).map((p) => p.replace(/^.*[\\/]/, '')),
                  memoryIndex: brain.memory ?? []
                }
              : null
          } catch (e) {
            payload.identity = null
            payload.identityNote = `unavailable: ${e instanceof Error ? e.message : String(e)}`
          }
          // Beliefs — only if that plane was granted; the tool degrades rather than refusing,
          // and says which half is missing so the agent does not read absence as "no beliefs".
          if (hasPlane(principal, 'beliefs.read')) {
            try {
              payload.beliefs = await beliefsPayload(query, 8)
            } catch {
              payload.beliefs = null
            }
          } else {
            payload.beliefs = null
            payload.beliefsNote = 'beliefs.read not granted to this principal — this is a permission boundary, not an empty store.'
          }
          payload.retrieval = await retrievePayload(query, k ?? 6, principal.scope)
          return toolText(payload)
        })
    )
  }

  // ── C1 · memory.write — bounded note writes ────────────────────────────────
  // The agent gets a WRITE SCOPE (a grant property, default `.brain/agent-inbox/`), never
  // the vault root. Three independent refusals, because a single path check is one bug away
  // from writing anywhere: (1) the resolved path must stay inside the write scope after
  // normalization, which kills `..` traversal; (2) foundation files are refused BY NAME
  // wherever they appear — identity is the operator's and is not writable by a guest, and
  // that list is owned by foundation-files.ts rather than re-typed here; (3) the write is
  // stamped with the principal, so an agent-authored note can never be mistaken for one the
  // operator wrote.
  if (hasPlane(principal, 'memory.write')) {
    server.tool(
      'duin_memory_write',
      'Write a note into the operator’s vault, inside this principal’s granted write scope. The note is stamped with your principal id. This is NOT belief memory — it does not influence DUIN’s answers; use duin_teach for that.',
      {
        path: z.string().min(1).max(200).describe('Vault-relative path, e.g. "notes.md". Resolved inside your write scope.'),
        content: z.string().min(1).max(20_000),
        mode: z.enum(['create', 'append']).optional()
      },
      async ({ path: relPath, content, mode }) =>
        guard(principal, 'duin_memory_write', 'memory.write', { path: relPath.slice(0, 120), mode: mode ?? 'create' }, async () => {
          const nodePath = await import('path')
          const fs = await import('fs')
          const { readSettings } = await import('../settings-helper')
          const { FOUNDATION_FILES } = await import('../brain/foundation-files')
          const vaultDir = (readSettings().localBrainNotesDir as string | undefined) || null
          if (!vaultDir) return toolError('No vault is configured in DUIN, so there is nowhere to write.')

          const writeScope = principal.writeScope || DEFAULT_WRITE_SCOPE
          const scopeRoot = nodePath.resolve(vaultDir, writeScope)
          const target = nodePath.resolve(scopeRoot, relPath)
          // (1) containment — compare resolved paths, so `../../SOUL.md` cannot escape.
          const rel = nodePath.relative(scopeRoot, target)
          if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
            return toolError(
              `Refused: "${relPath}" resolves outside this principal's write scope ("${writeScope}"). Writes are confined to that subtree.`
            )
          }
          // (2) foundation files are never writable by a guest, at any depth.
          if (FOUNDATION_FILES.has(nodePath.basename(target))) {
            return toolError(
              `Refused: "${nodePath.basename(target)}" is an operator identity file. Those are never writable through the Brain API.`
            )
          }
          try {
            fs.mkdirSync(nodePath.dirname(target), { recursive: true })
            // (3) provenance stamp — an agent-written note is legible as such forever.
            const stamp = `<!-- written by DUIN Brain API principal ${principal.name} (${principal.id}) -->\n`
            // Why the default scope sits under `.brain/`, which index-store.ts skips wholesale
            // (SKIP_DIRS, with a carve-out only for `.brain/memory/*.md`): an indexed agent
            // write would be a BACK DOOR AROUND THE QUARANTINE. duin_teach is careful to land
            // an agent's claim as an unpromoted external candidate that isQuarantinedExternal
            // holds out of grounding — and all of that is worth nothing if the same agent can
            // write "the operator prefers X" into a retrievable note and have it grounded next turn.
            // So: teaching goes through promotion, documents stay out of retrieval. If a write
            // scope is ever pointed at an indexed folder, that decision reopens this hole and
            // has to be made deliberately, not by moving a default string.
            const exists = fs.existsSync(target)
            if (mode === 'append' && exists) {
              fs.appendFileSync(target, `\n${content}\n`, 'utf-8')
            } else if (exists && mode !== 'append') {
              return toolError(`Refused: "${relPath}" already exists. Use mode "append", or choose another path — the Brain API does not overwrite.`)
            } else {
              fs.writeFileSync(target, stamp + content + '\n', 'utf-8')
            }
            const vaultRel = nodePath.relative(vaultDir, target).replace(/\\/g, '/')
            // A drop nobody is told about is a drop nobody reads. Nothing in DUIN walks the
            // agent inbox, and it lives under a dot-directory Obsidian hides, so without this
            // the write is a provable dead letter. Deduped per principal: a busy agent leaves
            // one standing item, not one per note.
            try {
              const { recordNotice } = await import('../proactive/notices-store')
              recordNotice({
                kind: 'watch',
                severity: 'info',
                title: `Agent "${principal.name}" left you a note`,
                body: `${vaultRel} — written through the DUIN Brain API. Agent notes are kept OUT of retrieval on purpose, so this will not shape any answer until you move it into the vault yourself.`,
                needsDecision: false,
                dedupKey: `exec-note-${principal.id}`
              })
            } catch {
              // The note is on disk either way; the flag is upkeep.
            }
            return toolText({
              written: true,
              path: vaultRel,
              mode: mode ?? 'create',
              influencesAnswers: false,
              retrievable: false,
              note: 'Written, and flagged for the operator. This is a DROP FOR A HUMAN, not memory: the write scope is outside the retrieval index, so nothing you write here comes back through duin_retrieve or grounds a later answer — not yours, not anyone\'s. To offer something that can eventually shape DUIN\'s answers, use duin_teach and let the operator promote it.'
            })
          } catch (err) {
            return toolError(`write failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
    )
  }

  // ── A1 · learning.submit, implemented ──────────────────────────────────────
  // This plane was requestable and approvable with NO tool behind it: an operator could
  // approve "may submit learning" and be wrong about what they had granted. Grant and
  // capability are now the same thing.
  //
  // The trust design is the load-bearing part. An agent writes through the SAME path a
  // de-privileged inbound channel turn uses — recordFacts with source 'external' — so what
  // it teaches lands as an unpromoted candidate that `isQuarantinedExternal` holds out of
  // every grounding, recall and consolidation site until a HUMAN promotes it. Native
  // mechanism, non-native trust: the agent gets to teach, not to self-certify.
  //
  // Two things it deliberately cannot do:
  //   * write corrections.jsonl — `appendCorrection` throws on any row carrying `source`
  //     (operator-only contract). That stream stays operator-authored.
  //   * choose its own provenance — `source` is forced here, never taken from the caller.
  //     A caller-supplied provenance field would recreate precisely the back-guessed
  //     provenance property 3 forbids.
  if (hasPlane(principal, 'learning.submit')) {
    server.tool(
      'duin_teach',
      'Offer something you learned about the operator to DUIN. It is recorded as an UNPROMOTED external candidate: it does NOT influence answers, and it never will unless the operator promotes it in the Learning panel. Use for durable observations about how they work or decide — not for task notes.',
      {
        text: z.string().min(4).max(300).describe('One durable claim, stated plainly.'),
        kind: z.enum(['preference', 'context', 'correction', 'principle']).optional(),
        why: z.string().max(300).optional().describe('What you observed that supports it (audit only).')
      },
      async ({ text, kind, why }) =>
        guard(principal, 'duin_teach', 'learning.submit', { kind: kind ?? 'context', why: why?.slice(0, 120) }, async () => {
          const om = await import('../brain/operator-model')
          const added = om.recordFacts([{ fact: text, kind: kind ?? 'context', source: 'external' }])
          if (added === 0) {
            return toolText({
              recorded: false,
              reason:
                'Not added — DUIN already holds this claim, or it was previously vetoed (veto memory is deliberate: a rejected claim does not come back by being re-offered).',
              influencesAnswers: false
            })
          }
          return toolText({
            recorded: true,
            status: 'candidate',
            provenance: 'external',
            influencesAnswers: false,
            next: 'Quarantined until the operator promotes it in DUIN’s Learning panel. Do not re-submit; re-offering the same claim is a no-op.'
          })
        })
    )
  }

  if (hasPlane(principal, 'beliefs.read')) {
    server.tool(
      'duin_beliefs',
      'The operator’s PROMOTED beliefs relevant to a topic, with provenance. Top-k, relevance-filtered — never a raw export. Candidates, provisionals and quarantined external facts are never returned.',
      { topic: z.string().min(1).max(300), k: z.number().int().min(1).max(15).optional() },
      async ({ topic, k }) => {
        try {
          return toolText(await beliefsPayload(topic, k ?? 6))
        } catch (err) {
          return toolError(`beliefs unavailable: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )
  }

  if (hasPlane(principal, 'goals.read')) {
    server.tool(
      'duin_goals',
      'Fleet-wide goal state: every goal DUIN is maintaining, with lifecycle status and scope. Read-only in P0; claim/lease semantics arrive with the goal-write plane.',
      {},
      async () => {
        try {
          return toolText(await goalsPayload())
        } catch (err) {
          return toolError(`goals unavailable: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )
  }

  if (hasPlane(principal, 'goals.write')) {
    server.tool(
      'duin_goal_register',
      'Register a new goal in the fleet-wide goal-state and claim its write lease. Returns the goal plus {epoch, expiresAt} — every later write on this goal must present that epoch. Leases renew on every successful write; idle leases expire.',
      {
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        dueDate: z.string().max(40).optional()
      },
      async ({ title, description, dueDate }) => {
        try {
          const { createGoal } = await import('../plan-goal-store')
          const goal = createGoal(FLEET_SCOPE, { title, description, dueDate, actor: 'model' })
          recordGoalCreation(goal.id, principal.id)
          const lease = claimGoalLease(goal.id, principal.id, principal.name)
          return toolText({ goal: { id: goal.id, title: goal.title, lifecycleStatus: goal.lifecycleStatus }, lease })
        } catch (err) {
          return toolError(`register failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )

    server.tool(
      'duin_goal_claim',
      'Claim (or renew, if you already hold it) the write lease on a fleet goal. A lease held by another agent refuses with the holder’s name; an EXPIRED lease is taken over and the fencing epoch bumps, permanently invalidating the previous holder’s writes. Claiming an open goal also starts it.',
      { goalId: z.string().min(1), ttlMinutes: z.number().int().min(1).max(240).optional() },
      async ({ goalId, ttlMinutes }) => {
        // Existence first: claiming an id that has no fleet goal must not
        // mint a lease row and tell the agent "claimed" about nothing.
        try {
          const { getGoal } = await import('../plan-goal-store')
          if (!getGoal(FLEET_SCOPE, goalId)) {
            return toolError(`unknown goal "${goalId}" — list fleet goals with duin_goals, or create one with duin_goal_register.`)
          }
        } catch (err) {
          return toolError(`claim failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        const result = claimGoalLease(
          goalId,
          principal.id,
          principal.name,
          ttlMinutes ? ttlMinutes * 60_000 : undefined
        )
        if (!result.ok) {
          return toolText({
            status: 'held',
            holder: result.holderName ?? result.holder,
            expiresAt: new Date(result.expiresAt).toISOString(),
            hint: 'Another agent holds this goal. Work a different goal, or retry after the lease expires.'
          })
        }
        try {
          const { transitionGoal, getGoal } = await import('../plan-goal-store')
          const current = getGoal(FLEET_SCOPE, goalId)
          if (current?.lifecycleStatus === 'open') {
            transitionGoal(FLEET_SCOPE, { goalId, action: 'start', actor: 'model', reason: `claimed by ${principal.name}` })
          }
        } catch {
          // Lease is granted regardless; lifecycle start is a convenience.
        }
        return toolText({ status: result.renewed ? 'renewed' : result.tookOver ? 'taken-over' : 'claimed', epoch: result.epoch, expiresAt: new Date(result.expiresAt).toISOString() })
      }
    )

    server.tool(
      'duin_goal_update',
      'Write to a fleet goal you hold the lease on. Requires the epoch from your claim — a stale epoch means the goal changed hands and your authority is gone (re-claim to continue). action=edit updates fields; record_usage adds token/time spend; block marks it blocked with a reason.',
      {
        goalId: z.string().min(1),
        epoch: z.number().int().min(1),
        action: z.enum(['edit', 'record_usage', 'block']),
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        dueDate: z.string().max(40).optional(),
        reason: z.string().max(500).optional(),
        blocker: z.string().max(500).optional(),
        tokensUsed: z.number().int().min(0).optional(),
        elapsedMs: z.number().int().min(0).optional()
      },
      async ({ goalId, epoch, action, title, description, dueDate, reason, blocker, tokensUsed, elapsedMs }) => {
        const auth = authorizeGoalWrite(goalId, principal.id, epoch)
        if (!auth.ok) {
          return toolError(
            `write refused (${auth.reason}). ${auth.reason === 'stale-epoch' ? `The goal changed hands (current epoch ${auth.currentEpoch}).` : ''} Re-claim with duin_goal_claim to continue.`
          )
        }
        try {
          const { transitionGoal } = await import('../plan-goal-store')
          const goal = transitionGoal(FLEET_SCOPE, {
            goalId,
            action,
            actor: 'model',
            reason: reason ? `[${principal.name}] ${reason}` : undefined,
            title,
            description,
            dueDate,
            blocker,
            tokensUsed,
            elapsedMs
          })
          return toolText({ status: 'applied', goal: goal ? { id: goal.id, lifecycleStatus: goal.lifecycleStatus, updatedAt: goal.updatedAt } : null })
        } catch (err) {
          return toolError(`update failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )

    server.tool(
      'duin_goal_propose_transition',
      'Propose ENDING a fleet goal (complete or abort). Terminal transitions are governed: if this agent has not earned the autonomy rung, the proposal parks as a "Needs you" decision for the operator and returns status=hold — do NOT retry; check duin_goals later or continue other work.',
      {
        goalId: z.string().min(1),
        epoch: z.number().int().min(1),
        action: z.enum(['complete', 'abort']),
        completion: z.string().max(2000).optional(),
        reason: z.string().max(500).optional()
      },
      async ({ goalId, epoch, action, completion, reason }) => {
        const auth = authorizeGoalWrite(goalId, principal.id, epoch)
        if (!auth.ok) {
          return toolError(`write refused (${auth.reason}). Re-claim with duin_goal_claim to continue.`)
        }
        try {
          const { transitionGoal } = await import('../plan-goal-store')
          const goal = transitionGoal(FLEET_SCOPE, {
            goalId,
            action,
            actor: 'model',
            completion: action === 'complete' ? (completion ?? 'completed by fleet agent') : undefined,
            reason: reason ? `[${principal.name}] ${reason}` : undefined
          })
          return toolText({ status: 'applied', goal: goal ? { id: goal.id, lifecycleStatus: goal.lifecycleStatus } : null })
        } catch (err) {
          if (isAuthorityDenial(err)) {
            try {
              const { recordNotice } = await import('../proactive/notices-store')
              recordNotice({
                kind: 'approval',
                severity: 'info',
                title: `Fleet agent "${principal.name}" proposes: ${action} goal`,
                body: `Goal ${goalId}: ${action}${completion ? ` — "${completion.slice(0, 200)}"` : ''}${reason ? ` (${reason.slice(0, 200)})` : ''}. Apply it from the goal surface, or ignore to decline. The agent was told to continue other work.`,
                needsDecision: true,
                actionId: `exec-goal-${action}-${goalId}`,
                dedupKey: `exec-goal-${action}-${goalId}`
              })
            } catch {
              // hold still stands; the notice is best-effort
            }
            return toolText({
              status: 'hold',
              why: 'Terminal transitions require operator ratification until this autonomy is earned.',
              next: 'The operator has been notified. Continue other work; observe the goal via duin_goals.'
            })
          }
          return toolError(`propose failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )

    server.tool(
      'duin_goal_release',
      'Release your write lease on a fleet goal so other agents can claim it. The goal keeps its lifecycle state.',
      { goalId: z.string().min(1), epoch: z.number().int().min(1) },
      async ({ goalId, epoch }) => {
        const result = releaseGoalLease(goalId, principal.id, epoch)
        return toolText({ status: result.ok ? 'released' : 'not-held' })
      }
    )
  }

  if (hasPlane(principal, 'judgment.precheck')) {
    server.tool(
      'duin_forecast',
      'DUIN’s decision-window forecast track record and calibration — the signal behind its risk foresight. Advisory read; the full precheck verdict tool arrives with the judgment plane.',
      {},
      async () => {
        try {
          return toolText(await forecastPayload())
        } catch (err) {
          return toolError(`forecast unavailable: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    )
  }

  return server
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Handle /exec/* requests. Returns false iff the URL is outside the family
 *  (caller falls through to the native route chain). */
export async function handleExecutiveRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = (req.url ?? '').split('?')[0]
  if (!url.startsWith(EXEC_PREFIX)) return false

  if (!hostAllowed(req)) {
    json(res, 403, { error: 'forbidden host' })
    return true
  }
  if (!originAllowed(req)) {
    json(res, 403, { error: 'forbidden origin' })
    return true
  }

  if (url === EXEC_HOOK_PATH) {
    // The in-child gate of a delegated executor run (services/executor/). Same fence, same
    // bearer scheme; the per-run principal decides whether the caller may ask at all.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return true
    }
    let hookBody: unknown
    try {
      hookBody = await readJsonBody(req)
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : 'bad request' })
      return true
    }
    await handleExecutorHook(res, authenticate(bearerOf(req)), hookBody)
    return true
  }
  if (url !== MCP_PATH) {
    json(res, 404, { error: 'unknown DUIN Brain route', hint: 'the mount is POST /exec/mcp (POST /exec/hook for a delegated run)' })
    return true
  }
  if (req.method !== 'POST') {
    // Stateless mode: no SSE stream to GET, no session to DELETE.
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : 'bad request' })
    return true
  }

  // Taint note: the principal (or null) decides the toolset; nothing a caller
  // sends can widen it. authenticate() also stamps the audit heartbeat.
  const principal = authenticate(bearerOf(req))
  const server = buildServer(principal)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    if (!res.headersSent) {
      json(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
    } else {
      // Headers already flushed: nothing coherent to send, but the socket
      // must not hang until client timeout.
      res.end()
    }
  }
  return true
}

export const __execEndpointTest = { buildServer, hostAllowed, originAllowed, bearerOf }
