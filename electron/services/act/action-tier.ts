// action-tier.ts — the CONSEQUENCE-TIER classifier for DUIN's OUTPUT/ACTUATION
// ("hands"). Every external action DUIN can take is placed on a three-step ladder
// of irreversibility, and that tier is what the safety gate keys off:
//
//   'read'             — no external side effect (get/list/search/fetch). NO gate:
//                        an inbound turn may freely read.
//   'write-reversible' — creates or drafts something that can be undone (create a
//                        draft, add a calendar event, upload a file, save a doc).
//                        SOFT gate: allowed on a privileged (exec-token) turn; a
//                        de-privileged inbound turn is denied at the exec-token rule.
//   'irreversible'     — a side effect that CANNOT be recalled (send an email,
//                        delete/overwrite a file, cancel/delete a calendar event,
//                        transfer money, publish). HARD gate: privileged turn AND
//                        explicit operator approval, ALWAYS.
//
// PURE — no I/O, no heavy imports. Safe to import from the deny-first verdict core
// (agui-approval) without dragging in electron / the DB / the tool registry.
//
// This module ALSO owns the small pure REGISTRY that maps a registered external
// action's tool name → its tier. The heavy `external-action.ts` substrate writes
// into it at registration time; the pure gate reads from it to decide whether a
// tool call is a gated external effect. Keeping the registry here (a leaf module)
// is what lets `agui-approval` stay pure while still recognizing ACT connectors.

export type ActionTier = 'read' | 'write-reversible' | 'irreversible'

/** Monotonic severity rank — higher is more consequential. Used to compare tiers
 *  (e.g. "at least write-reversible") without a switch. */
export const TIER_RANK: Record<ActionTier, number> = {
  read: 0,
  'write-reversible': 1,
  irreversible: 2
}

/** True when `a` is at least as consequential as `b`. */
export function isTierAtLeast(a: ActionTier, b: ActionTier): boolean {
  return TIER_RANK[a] >= TIER_RANK[b]
}

/** A non-read action has an external side effect → it must be earned (exec-token
 *  gate). Reads fail OPEN by design. */
export function tierNeedsGate(tier: ActionTier): boolean {
  return tier !== 'read'
}

/** Only irreversible actions ALWAYS require explicit operator approval — a
 *  write-reversible action is soft-gated (privileged turn is enough). */
export function tierRequiresApproval(tier: ActionTier): boolean {
  return tier === 'irreversible'
}

// ──────────────────── verb inference ────────────────────
// A connector normally DECLARES its tier explicitly. When it only gives a verb we
// infer conservatively: an unrecognized verb is treated as IRREVERSIBLE (the most
// restrictive tier) so an unclassified action can never slip past the hard gate.

const IRREVERSIBLE_VERBS = new Set([
  'send', 'delete', 'remove', 'destroy', 'overwrite', 'replace', 'purge', 'wipe',
  'transfer', 'pay', 'purchase', 'buy', 'charge', 'refund', 'publish', 'post',
  'submit', 'cancel', 'revoke', 'deactivate', 'disable', 'archive', 'merge',
  'deploy', 'release', 'broadcast', 'email', 'dispatch', 'fire', 'execute'
])

const WRITE_VERBS = new Set([
  'create', 'add', 'draft', 'new', 'insert', 'append', 'update', 'edit', 'modify',
  'patch', 'set', 'write', 'save', 'upload', 'put', 'schedule', 'reserve', 'book',
  'invite', 'rename', 'move', 'copy', 'duplicate', 'label', 'tag', 'comment',
  'annotate', 'star', 'pin', 'assign', 'register'
])

const READ_VERBS = new Set([
  'read', 'get', 'list', 'search', 'find', 'fetch', 'view', 'show', 'lookup',
  'query', 'describe', 'inspect', 'peek', 'check', 'status', 'download', 'export',
  'preview', 'count', 'suggest'
])

/** Infer a tier from a bare verb (case-insensitive). Returns null when the verb is
 *  not recognized so `classifyActionTier` can apply its fail-safe default. PURE. */
export function tierForVerb(verb: unknown): ActionTier | null {
  if (typeof verb !== 'string') return null
  const v = verb.trim().toLowerCase().split(/[^a-z]+/).filter(Boolean)[0] ?? ''
  if (!v) return null
  if (IRREVERSIBLE_VERBS.has(v)) return 'irreversible'
  if (WRITE_VERBS.has(v)) return 'write-reversible'
  if (READ_VERBS.has(v)) return 'read'
  return null
}

/** Shape a classifier accepts: an explicit `tier` (wins) or a `verb` to infer from. */
export interface TierClassifiable {
  tier?: ActionTier
  verb?: string
}

/**
 * Resolve the consequence tier of an action spec. An explicit `tier` always wins;
 * otherwise infer from `verb`; otherwise fall back to the most restrictive tier
 * ('irreversible') so an unclassified external action is never under-gated. PURE.
 */
export function classifyActionTier(spec: TierClassifiable): ActionTier {
  if (spec.tier === 'read' || spec.tier === 'write-reversible' || spec.tier === 'irreversible') {
    return spec.tier
  }
  const inferred = tierForVerb(spec.verb)
  if (inferred) return inferred
  return 'irreversible'
}

// ──────────────────── external-action tier registry (pure) ────────────────────
// name → tier for every action registered through `registerExternalAction`. The
// gate consults this to know a tool call is a gated external effect and at which
// tier. Deliberately a plain module map: registrations are startup side effects
// (like tool-pack registration) and there is one registry per process.

const EXTERNAL_ACTION_TIERS = new Map<string, ActionTier>()

/** Declared-vs-actual integrity check (BIV-lite, SIA activation). A permissive `read` declaration
 *  on an action whose NAME infers a stricter consequence (send_/delete_/write_/…) is almost
 *  certainly an under-gate — a connector claiming `tier:'read'` whose handler sends email. Fail
 *  closed: escalate to the name-inferred tier. Only escalates FROM `read` — a connector that already
 *  declares write/irreversible opted into gating and is respected as-is (so a legitimately-reversible
 *  `delete_temp` declared `write-reversible` is NOT over-gated to irreversible). PURE. */
export function reconcileExternalTier(name: string, declared: ActionTier): { tier: ActionTier; escalatedFrom: ActionTier | null } {
  if (declared !== 'read') return { tier: declared, escalatedFrom: null }
  const inferred = tierForVerb(name)
  if (inferred && TIER_RANK[inferred] > TIER_RANK.read) return { tier: inferred, escalatedFrom: 'read' }
  return { tier: declared, escalatedFrom: null }
}

/** Record (or overwrite) the tier for a registered external action, after the declared-vs-actual
 *  integrity check — a name that betrays a stricter consequence than its declared tier is escalated
 *  (fail-closed) and flagged, so a mis-declared connector can never be under-gated at dispatch. */
export function registerExternalActionTier(name: string, tier: ActionTier): void {
  if (typeof name !== 'string' || !name) return
  const r = reconcileExternalTier(name, tier)
  if (r.escalatedFrom) {
    console.warn(`[action-tier] integrity: external action '${name}' declared '${r.escalatedFrom}' but its name infers '${r.tier}' — escalating (fail-closed).`)
  }
  EXTERNAL_ACTION_TIERS.set(name, r.tier)
}

/** The tier of a registered external action, or null if the name isn't one. */
export function externalActionTier(name: unknown): ActionTier | null {
  if (typeof name !== 'string') return null
  return EXTERNAL_ACTION_TIERS.get(name) ?? null
}

/** True when `name` is a registered external action whose tier is gated (non-read).
 *  This is the predicate the dispatch gate uses to route ACT connectors through the
 *  deny-first exec-token rule. */
export function isRegisteredExternalActionGated(name: unknown): boolean {
  const tier = externalActionTier(name)
  return tier !== null && tierNeedsGate(tier)
}

/** Test-only: forget all registered external actions. */
export function __clearExternalActionRegistry(): void {
  EXTERNAL_ACTION_TIERS.clear()
}
