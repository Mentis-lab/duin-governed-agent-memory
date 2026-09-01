import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type { Database } from 'better-sqlite3'
import { getDb, withWriteRetry } from './database'
import type { ToolRisk } from './tool-registry'
import { friendly, messageOf } from './guarded'

// Persistent approval policies. The Codex Agent Contract sprint moved permission
// answers from per-launch in-memory maps to this table so a user's "Always allow"
// survives restarts. The in-memory layer in permissions-store.ts is now a
// fallback that activates when disk persistence fails — never the primary store.
//
// Resolution order (most-specific → broadest):
//   1. conversation + tool
//   2. conversation + risk
//   3. workspace + tool
//   4. workspace + risk
//   5. global + tool
//   6. global + risk
//   7. → modal
//
// Denies are authoritative across all matching levels. We choose the
// most-specific matching deny first, then the most-specific matching allow.
//
// Risk policies match against the descriptor's risks array: a policy on the
// 'destructive' risk matches any tool whose risks include 'destructive', so a
// single "deny destructive globally" silences apply_patch and Chrome
// destructive MCP tools at once.
//
// That "matches against the risks array" rule is safe for DENY (a narrower
// grant must never survive a broader refusal) but is NOT safe for ALLOW as
// written: a call routinely carries several risks at once (apply_patch is
// write+destructive; browser_click is destructive+write+network), and an
// allow on just one of them must not stand in for the others. So a
// risk-subject ALLOW only resolves the call once every GATING risk
// (network/destructive/secret/sandboxBypass) the call carries has its own
// allow somewhere — see RESOLUTION_GATING_RISKS below. A tool-subject ALLOW
// is exempt: naming the exact tool id is already full, precise consent.

export type PolicyScope = 'conversation' | 'workspace' | 'global'
export type PolicySubjectKind = 'tool' | 'risk'
export type PolicyDecision = 'allow' | 'deny'

export interface PermissionPolicy {
  id: string
  scope: PolicyScope
  subjectKind: PolicySubjectKind
  subject: string
  decision: PolicyDecision
  conversationId?: string
  workspacePath?: string
  createdAt: number
  updatedAt: number
}

export interface ResolveContext {
  toolId: string
  risks: ToolRisk[]
  conversationId?: string
  workspacePath?: string
}

export interface ResolveResult {
  decision: PolicyDecision
  /** Matched policy id — chat.ts records this on the audit row. */
  policyId: string
}

/**
 * Canonicalize a workspace path for equality matching. On Windows the resolved
 * form normalizes slashes, but case is also significant — comparison is folded
 * to lowercase so `C:\Foo` and `c:\foo` match. POSIX paths are case-sensitive
 * so we leave the case alone there.
 */
export function canonicalWorkspacePath(p: string | undefined): string | undefined {
  if (!p || typeof p !== 'string' || p.trim() === '') return undefined
  const absolute = resolve(p)
  if (process.platform === 'win32') return absolute.toLowerCase()
  return absolute
}

interface PolicyRow {
  id: string
  scope: PolicyScope
  subject_kind: PolicySubjectKind
  subject: string
  decision: PolicyDecision
  conversation_id: string | null
  workspace_path: string | null
  created_at: number
  updated_at: number
}

function rowToPolicy(row: PolicyRow): PermissionPolicy {
  return {
    id: row.id,
    scope: row.scope,
    subjectKind: row.subject_kind,
    subject: row.subject,
    decision: row.decision,
    conversationId: row.conversation_id ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

// Approval-gating risk categories, mirrored from permissions-store.ts's
// GATING_RISKS rather than imported from it: permissions-store.ts already
// imports THIS module for policy CRUD (see resolvePersistedDecision below),
// and it pulls in Electron's BrowserWindow at module scope, so importing it
// back here would both create a two-file cycle and drag Electron into a
// store whose pure resolver is deliberately tested without booting it (see
// the docstring below). Keep this set in sync by hand with permissions-store.
const RESOLUTION_GATING_RISKS: ReadonlySet<ToolRisk> = new Set([
  'network',
  'destructive',
  'secret',
  'sandboxBypass'
])

/**
 * Pure resolution: scan an ordered policy set against the resolve context.
 * Exported so tests can verify precedence without booting the database.
 *
 * Matching denies are safety stops: collect matching policies from every
 * specificity level, return the most-specific deny if any deny matches, then
 * return the most-specific allow. That means a broad risk deny cannot be
 * silently bypassed by a narrower tool allow.
 *
 * Allow is asymmetric with deny on purpose. A tool-subject allow names one
 * exact tool id, so it is already complete, unambiguous consent for that
 * call — it resolves immediately. A risk-subject allow only certifies the
 * ONE risk it names, and a call's `risks` array routinely holds several at
 * once, so a risk-level match resolves the call only when every GATING risk
 * the call carries (not just the one this particular policy happens to name)
 * has an allow somewhere across all levels. Without that check, a narrow
 * grant for one risk (e.g. a "write_workspace" request_permissions answer,
 * which persists only a 'write' policy — see native-aux-tools.ts
 * SCOPE_RISKS) would silently authorize any co-occurring, never-granted risk
 * a multi-risk tool also carries (apply_patch's 'destructive', browser_click's
 * 'network') — a grant the user was never shown and never answered.
 */
export function resolveDecisionFromPolicies(
  policies: PermissionPolicy[],
  ctx: ResolveContext
): ResolveResult | null {
  const workspaceCanon = canonicalWorkspacePath(ctx.workspacePath)
  const conversationId = ctx.conversationId

  type LevelFilter = (p: PermissionPolicy) => boolean
  const levels: Array<{ filter: LevelFilter }> = [
    {
      filter: (p) =>
        p.scope === 'conversation' &&
        p.subjectKind === 'tool' &&
        p.subject === ctx.toolId &&
        !!conversationId &&
        p.conversationId === conversationId
    },
    {
      filter: (p) =>
        p.scope === 'conversation' &&
        p.subjectKind === 'risk' &&
        ctx.risks.includes(p.subject as ToolRisk) &&
        !!conversationId &&
        p.conversationId === conversationId
    },
    {
      filter: (p) =>
        p.scope === 'workspace' &&
        p.subjectKind === 'tool' &&
        p.subject === ctx.toolId &&
        !!workspaceCanon &&
        canonicalWorkspacePath(p.workspacePath) === workspaceCanon
    },
    {
      filter: (p) =>
        p.scope === 'workspace' &&
        p.subjectKind === 'risk' &&
        ctx.risks.includes(p.subject as ToolRisk) &&
        !!workspaceCanon &&
        canonicalWorkspacePath(p.workspacePath) === workspaceCanon
    },
    {
      filter: (p) =>
        p.scope === 'global' && p.subjectKind === 'tool' && p.subject === ctx.toolId
    },
    {
      filter: (p) =>
        p.scope === 'global' &&
        p.subjectKind === 'risk' &&
        ctx.risks.includes(p.subject as ToolRisk)
    }
  ]

  const matchedByLevel = levels.map((level) => policies.filter(level.filter))
  for (const matches of matchedByLevel) {
    const denial = matches.find((m) => m.decision === 'deny')
    if (denial) return { decision: 'deny', policyId: denial.id }
  }

  // No deny matched anywhere above, so nothing in ctx.risks is refused. Now
  // gather every GATING risk this call carries that some level (any of
  // them, not necessarily the one about to match below) already allows, so
  // a risk-level match can be required to have full coverage rather than
  // riding on a single co-occurring risk's grant.
  const allowedGatingRisks = new Set<ToolRisk>()
  for (const matches of matchedByLevel) {
    for (const m of matches) {
      if (
        m.decision === 'allow' &&
        m.subjectKind === 'risk' &&
        RESOLUTION_GATING_RISKS.has(m.subject as ToolRisk)
      ) {
        allowedGatingRisks.add(m.subject as ToolRisk)
      }
    }
  }
  const uncoveredGatingRisk = ctx.risks.find(
    (r) => RESOLUTION_GATING_RISKS.has(r) && !allowedGatingRisks.has(r)
  )

  for (const matches of matchedByLevel) {
    const allow = matches.find((m) => m.decision === 'allow')
    if (!allow) continue
    // Tool-subject allow: naming the exact tool id is already complete
    // consent for this call, whatever its risk list — resolve immediately.
    if (allow.subjectKind === 'tool') return { decision: 'allow', policyId: allow.id }
    // Risk-subject allow: only resolves the call once every gating risk it
    // carries is covered — otherwise fall through (to a broader level, or
    // ultimately to the modal) instead of letting this one risk's grant
    // silently speak for a different, ungranted risk.
    if (!uncoveredGatingRisk) return { decision: 'allow', policyId: allow.id }
  }
  return null
}

// In-memory fallback. Activated when a getDb() call throws (e.g. headless
// tests that don't mock the DB). Mirrors the persistence API at the same
// granularity so resolveDecision can read from one or the other transparently.
const memoryFallback: PermissionPolicy[] = []
let useFallback = false

/**
 * Engage the process-local memory store.
 *
 * SCOPE — exactly ONE condition, the one the comment above describes:
 * `getDb()` itself is unavailable (headless tests, no Electron `app`, no
 * database file at all). That is a TOTAL failure — there is no persistence to
 * lose, so serving process-local arrays beats throwing.
 *
 * It is deliberately NOT reachable from a failure *inside* a SQL call. That is
 * a PARTIAL failure: the database is open and every saved policy is still on
 * disk. Latching here used to make `listPolicies()` return the empty
 * `memoryFallback` for the rest of the process — and an empty policy set is
 * indistinguishable from "the user never saved a deny". `resolveDecision`
 * returned null, `resolveAguiGate` read that as no policy, and
 * `decideAguiGate` fell past its `policy === 'deny'` branch to the
 * trusted-afk auto-allow: a saved DENY on a host-exec tool silently stopped
 * being enforced, with no error on that path. The write side degraded the same
 * way — new "Always allow"/"Always deny" answers reported success into a
 * volatile array and vanished at quit.
 *
 * What made it invisible: the latch is *quiet and permanent*. One transient
 * SQLITE_BUSY (the headless CLI is exempt from the single-instance lock, and
 * the periodic TRUNCATE checkpoint can outrun busy_timeout) flipped it, the
 * single console.warn scrolled past, and every later call took the fast
 * `if (useFallback)` return without ever touching the DB again — so nothing
 * retried, and nothing ever re-checked whether the database had recovered.
 *
 * Transient SQL failures are now retried by `withWriteRetry` (the same PS3
 * guard conversation-store, brain-db and entity-graph-store use) and anything
 * surviving the retries propagates to the caller. This mirrors the identical
 * fix already made in rag/store.ts.
 */
function activateFallback(reason: string): void {
  if (!useFallback) {
    useFallback = true
    console.warn(
      `[permission-policies-store] persistence unavailable, falling back to memory: ${reason}`
    )
  }
}

/**
 * Acquire the DB handle for one store call.
 *
 * Returns `null` when the caller should use the memory fallback — i.e. the
 * fallback is already latched, or `getDb()` threw (no database in this
 * process). A handle means the DB is present: the caller runs its statements
 * inside {@link runDb} and lets anything that survives the retries propagate.
 */
function acquireDb(op: string): Database | null {
  if (useFallback) return null
  try {
    return getDb()
  } catch (err) {
    activateFallback(`${op}: ${friendly(err, 'unknown')}`)
    return null
  }
}

/**
 * Run one statement group against a live DB, retrying a transient SQLITE_BUSY.
 * Anything still failing after the retries is rethrown — the policies are on
 * disk, and a caller must learn that this operation did not happen rather than
 * be handed a fake-empty policy set that reads as "no deny exists".
 */
function runDb<T>(op: string, fn: () => T): T {
  try {
    return withWriteRetry(fn, { label: `permission-policies.${op}` })
  } catch (err) {
    console.error(
      `[permission-policies-store] ${op} failed against the database: ${friendly(
        err,
        'unknown'
      )} — surfacing to the caller (persistence is NOT being downgraded to memory)`
    )
    throw err
  }
}

export function isUsingMemoryFallback(): boolean {
  return useFallback
}

export function listPolicies(): PermissionPolicy[] {
  const db = acquireDb('listPolicies')
  if (db) {
    return runDb('listPolicies', () => {
      const rows = db
        .prepare(`SELECT * FROM permission_policies ORDER BY created_at ASC`)
        .all() as PolicyRow[]
      return rows.map(rowToPolicy)
    })
  }
  return [...memoryFallback]
}

export function getPolicy(id: string): PermissionPolicy | null {
  const db = acquireDb('getPolicy')
  if (db) {
    return runDb('getPolicy', () => {
      const row = db
        .prepare(`SELECT * FROM permission_policies WHERE id = ?`)
        .get(id) as PolicyRow | undefined
      return row ? rowToPolicy(row) : null
    })
  }
  return memoryFallback.find((p) => p.id === id) ?? null
}

export interface UpsertPolicyInput {
  scope: PolicyScope
  subjectKind: PolicySubjectKind
  subject: string
  decision: PolicyDecision
  conversationId?: string
  workspacePath?: string
}

/**
 * Upsert a policy. A second call with the same (scope, subjectKind, subject,
 * conversationId, workspacePath) tuple updates the existing row's decision +
 * updated_at instead of inserting a duplicate. Returns the resolved policy.
 */
export function upsertPolicy(input: UpsertPolicyInput): PermissionPolicy {
  if (input.scope === 'conversation' && !input.conversationId) {
    throw new Error('upsertPolicy: conversation-scoped policies require conversationId')
  }
  if (input.scope === 'workspace') {
    const canon = canonicalWorkspacePath(input.workspacePath)
    if (!canon) {
      throw new Error('upsertPolicy: workspace-scoped policies require workspacePath')
    }
    input = { ...input, workspacePath: canon }
  }

  const now = Date.now()

  const db = acquireDb('upsertPolicy')
  if (db) {
    return runDb('upsertPolicy', () => {
      const existing = db
        .prepare(
          `SELECT * FROM permission_policies
           WHERE scope = ? AND subject_kind = ? AND subject = ?
             AND COALESCE(conversation_id, '') = COALESCE(?, '')
             AND COALESCE(workspace_path, '') = COALESCE(?, '')`
        )
        .get(
          input.scope,
          input.subjectKind,
          input.subject,
          input.conversationId ?? null,
          input.workspacePath ?? null
        ) as PolicyRow | undefined
      if (existing) {
        db.prepare(
          `UPDATE permission_policies SET decision = ?, updated_at = ? WHERE id = ?`
        ).run(input.decision, now, existing.id)
        return rowToPolicy({ ...existing, decision: input.decision, updated_at: now })
      }
      const id = randomUUID()
      db.prepare(
        `INSERT INTO permission_policies
           (id, scope, subject_kind, subject, decision,
            conversation_id, workspace_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.scope,
        input.subjectKind,
        input.subject,
        input.decision,
        input.conversationId ?? null,
        input.workspacePath ?? null,
        now,
        now
      )
      return {
        id,
        scope: input.scope,
        subjectKind: input.subjectKind,
        subject: input.subject,
        decision: input.decision,
        conversationId: input.conversationId,
        workspacePath: input.workspacePath,
        createdAt: now,
        updatedAt: now
      }
    })
  }

  const existing = memoryFallback.find(
    (p) =>
      p.scope === input.scope &&
      p.subjectKind === input.subjectKind &&
      p.subject === input.subject &&
      (p.conversationId ?? '') === (input.conversationId ?? '') &&
      (p.workspacePath ?? '') === (input.workspacePath ?? '')
  )
  if (existing) {
    existing.decision = input.decision
    existing.updatedAt = now
    return { ...existing }
  }
  const policy: PermissionPolicy = {
    id: randomUUID(),
    scope: input.scope,
    subjectKind: input.subjectKind,
    subject: input.subject,
    decision: input.decision,
    conversationId: input.conversationId,
    workspacePath: input.workspacePath,
    createdAt: now,
    updatedAt: now
  }
  memoryFallback.push(policy)
  return { ...policy }
}

export function deletePolicy(id: string): boolean {
  const db = acquireDb('deletePolicy')
  if (db) {
    return runDb('deletePolicy', () => {
      const result = db.prepare(`DELETE FROM permission_policies WHERE id = ?`).run(id)
      return result.changes > 0
    })
  }
  const idx = memoryFallback.findIndex((p) => p.id === id)
  if (idx < 0) return false
  memoryFallback.splice(idx, 1)
  return true
}

export function clearPoliciesForConversation(conversationId: string): number {
  const db = acquireDb('clearPoliciesForConversation')
  if (db) {
    return runDb('clearPoliciesForConversation', () => {
      const result = db
        .prepare(
          `DELETE FROM permission_policies
           WHERE scope = 'conversation' AND conversation_id = ?`
        )
        .run(conversationId)
      return result.changes
    })
  }
  let count = 0
  for (let i = memoryFallback.length - 1; i >= 0; i--) {
    const p = memoryFallback[i]
    if (p.scope === 'conversation' && p.conversationId === conversationId) {
      memoryFallback.splice(i, 1)
      count++
    }
  }
  return count
}

export function clearPoliciesForScope(scope: PolicyScope): number {
  const db = acquireDb('clearPoliciesForScope')
  if (db) {
    return runDb('clearPoliciesForScope', () => {
      const result = db
        .prepare(`DELETE FROM permission_policies WHERE scope = ?`)
        .run(scope)
      return result.changes
    })
  }
  let count = 0
  for (let i = memoryFallback.length - 1; i >= 0; i--) {
    if (memoryFallback[i].scope === scope) {
      memoryFallback.splice(i, 1)
      count++
    }
  }
  return count
}

export function resolveDecision(ctx: ResolveContext): ResolveResult | null {
  return resolveDecisionFromPolicies(listPolicies(), ctx)
}

/** Test-only: drop the in-memory fallback so tests start from a clean slate. */
export function __resetPolicyStore(): void {
  memoryFallback.length = 0
  useFallback = false
}

/**
 * Test-only: force the store to use its in-memory fallback path. Useful when
 * the test environment cannot reach a real database (mocked electron, no
 * userData dir) but still wants to exercise the public CRUD API.
 */
export function __forceMemoryFallback(): void {
  useFallback = true
}
