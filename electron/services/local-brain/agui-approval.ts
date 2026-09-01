// agui-approval — DENY-FIRST, TIERED, PER-ACTION approval decision core for the
// /agui brain loop.
//
// Historically the brain's agentic loop authorized side-effecting tools with a
// SINGLE per-launch exec token (agui-guard.ts): once the trusted renderer proved
// itself, the whole turn could run host-exec + irreversible ops unchecked. That
// is coarse — the operator (or a saved policy) has no say over an INDIVIDUAL
// dangerous call. This module upgrades the gate to per-action granularity while
// preserving the token as the outer authentication:
//
//   1. exec-token        — no token → deny (unchanged; a plain curl POST can
//                          never reach host-exec).
//   2. catastrophic floor — a matched destroy-the-host command is refused even on
//                          an authorized turn (command-screen.ts), before policy.
//   3. persisted DENY     — a saved "deny this tool" policy wins over everything
//                          below (deny precedence). A policy LOOKUP FAILURE reports
//                          as 'unknown', never silently folded into "no policy" —
//                          'unknown' forfeits every posture's auto-allow (rules 4,
//                          4.5) and falls to the ask-or-deny floor (rules 5-6).
//   4. session posture    — `trusted-afk` (default): the operator explicitly
//                          launched an autonomous trusted session, so past the
//                          floor with no deny, auto-allow — but AUDITED per call.
//                          `interactive`: a saved ALLOW short-circuits; otherwise
//                          route to the approval modal; no window → fail-closed.
//
// PURE core: `decideAguiGate(input) → verdict`. Every I/O (policy lookup, modal,
// audit-event emit) lives at the server.ts seam so this stays unit-testable
// across the full matrix. Honesty-by-construction: the gate can only ever be as
// permissive as its LEAST-permissive applicable rule — it can deny, never
// escalate privilege.

import { isGatedTool, deniedResult } from './agui-guard'
import { externalActionTier } from '../act/action-tier'

/** Session approval posture for the /agui surface, chosen once per turn.
 *  - `trusted-afk`: the exec-token turn is treated as an authorized autonomous
 *    session (the AFK operator can't answer a modal); gated calls auto-allow past
 *    the catastrophic floor + persisted-deny, each one audited. DEFAULT.
 *  - `review`: a genuine middle rung — auto-allow the REVERSIBLE tiers, but route
 *    the irreversible / host-exec / send / spawn / arbitrary-external tiers to the
 *    approval modal (fail-closed with no window). Drives the composer's Auto-review.
 *  - `interactive`: a human is at the desk; every gated call routes to the approval
 *    modal (allow-once/always/deny, persisted), fail-closed with no window. */
export type AguiPosture = 'interactive' | 'review' | 'trusted-afk'

/** Irreversibility tier of a gated tool — drives the audit trail (and, later, a
 *  per-tier UI badge). Coarser than governance/action-class on purpose: the /agui
 *  gated set is small and fixed. `mcp-external` covers ANY mounted MCP tool
 *  (namespaced `serverId__tool`): these run arbitrary external effects (node-repl
 *  = JS eval, chrome = browser control, feishu = account writes), so they earn
 *  the same deny-first gate as native host-exec. */
export type AguiTier =
  | 'host-exec'
  | 'irreversible-file'
  | 'irreversible-send'
  | 'spawn-recursive'
  // Writes a PERSISTENT EXECUTABLE CAPABILITY (create_skill → a live-loaded SKILL.md outside the
  // vault jail). Deliberately NOT 'irreversible-file': the full-computer-access override in
  // agui-gate.ts authorizes the local-computer surface (host-exec + irreversible-file) for every
  // turn INCLUDING inbound channels, and a capability grant is not a local file op. Filed under
  // its own tier so it stays with spawn_agent/send_email on the far side of that override — which
  // is exactly what AGUI_GATED_TOOLS' own comment says create_skill is gated FOR.
  | 'capability-write'
  | 'mcp-external'
  // ACT external effectors (registered via act/external-action.ts). A registered
  // external action maps to one of these two GATED tiers so the deny-first gate
  // recognizes it; a registered READ action stays 'none' (ungated).
  | 'external-write'
  | 'external-irreversible'
  | 'none'

/** An MCP tool is named `serverId__toolName` (double-underscore namespace). */
export function isMcpToolName(name: unknown): name is string {
  return typeof name === 'string' && name.includes('__')
}

/** Classify a gated tool by its irreversibility tier. Non-gated → 'none'. */
export function aguiTier(toolName: unknown): AguiTier {
  switch (toolName) {
    case 'run_command':
    case 'start_command':
      return 'host-exec'
    case 'delete_file':
    case 'move_file':
      return 'irreversible-file'
    case 'send_email':
      return 'irreversible-send'
    case 'create_skill':
      return 'capability-write'
    case 'spawn_agent':
    case 'delegate_task': // an external executor child is a recursive spawn with shell access
      return 'spawn-recursive'
    default:
      break
  }
  if (isMcpToolName(toolName)) return 'mcp-external'
  // Registered ACT external effector? Map its consequence tier onto the gate's tier.
  const ext = externalActionTier(toolName)
  if (ext === 'irreversible') return 'external-irreversible'
  if (ext === 'write-reversible') return 'external-write'
  return 'none'
}

/** Under the `review` posture, which tiers are auto-allowed (reversible / low
 *  consequence) vs routed to the approval modal (irreversible / high consequence)?
 *  Start CONSERVATIVE: only registered write-reversible external effectors
 *  (`external-write`) auto-allow. Everything else — host-exec, irreversible-file,
 *  irreversible-send, spawn-recursive, external-irreversible, and `mcp-external`
 *  (arbitrary external effect) — prompts. Widen only with a written rationale
 *  (R2: `mcp-external` must stay in the prompt set — it is arbitrary external I/O). */
export function isReviewAutoAllowTier(tier: AguiTier): boolean {
  return tier === 'external-write'
}

export type AguiVerdict =
  | { kind: 'allow'; source: string; tier: AguiTier }
  | { kind: 'deny'; source: string; reason: string; tier: AguiTier }
  /** The seam must resolve this interactively (persisted policy → approval modal
   *  → fail-closed). Reachable under `interactive` (any gated tier), or `review`
   *  (the irreversible / host-exec / arbitrary-external tiers), with a window. */
  | { kind: 'prompt'; tier: AguiTier }

export interface AguiGateInput {
  toolName: string
  /** Does THIS turn carry a valid per-launch exec token? (agui-guard) */
  execOk: boolean
  /** Catastrophic-command screen result for host-exec tools; `null` when the tool
   *  has no shell command to screen (delete/move/spawn). */
  screen: { ok: true } | { ok: false; reason: string } | null
  posture: AguiPosture
  /** Persisted per-action policy decision for this tool, or `null` if none.
   *  `'deny'` has precedence over posture; `'allow'` short-circuits the modal.
   *  `'unknown'` means the LOOKUP ITSELF failed (the seam's store call threw —
   *  see agui-gate.ts) and is deliberately NOT the same as `null`: a `null` here
   *  is a confirmed "nothing saved", while `'unknown'` might be hiding a saved
   *  deny the gate simply couldn't read at this instant. Treating "couldn't
   *  check" as "no policy" is exactly how a saved deny silently stopped being
   *  enforced during a transient policy-store outage, so `'unknown'` forfeits
   *  every posture's auto-allow rule and falls through to the interactive
   *  prompt / no-window-deny floor instead (see rules 4, 4.5 below). */
  policy: 'allow' | 'deny' | null | 'unknown'
  /** Is there an interactive window able to answer an approval modal? */
  hasWindow: boolean
  /** Does THIS host provide a real kernel sandbox for host-exec (darwin sandbox-exec
   *  / linux bwrap present)? `false` on Windows (tier 'none') or when the tool is
   *  missing. Defaults to `true` (no escalation) when omitted, so existing callers
   *  are unaffected. */
  sandboxed?: boolean
  /** Is this a HIGH-RISK command shape (remote payload piped to a shell/interpreter)
   *  per `classifyCommandRisk`? Only meaningful for host-exec tools. Defaults to
   *  `false` when omitted. */
  elevatedRisk?: boolean
  /** For `write_file` ONLY: does the target path ESCAPE the vault into another permitted
   *  root (the active workspace, or an operator-granted sandbox path such as the Desktop)?
   *  write_file is ungated for in-vault note writes — its historical, low-harm blast radius
   *  — but a write that lands in the operator's real filesystem is a genuine side effect and
   *  must be EARNED, so an escaping write is gated here at tier 'irreversible-file', taking
   *  the same exec-token + posture + approval path as delete_file/move_file. Defaults false,
   *  so every other tool (and every in-vault write) is unaffected. The seam computes this via
   *  the SAME resolveInVault the executor writes through, so gate and executor never disagree
   *  about where the bytes land. */
  pathEscapesVault?: boolean
  /** For the file tools (write_file / edit_file / delete_file / move_file / create_dir): does the
   *  target land in a PROTECTED vault subtree — `.duin/agents`, `.duin/skills`, `.duin/hooks`, or
   *  `.brain/` (agui-executors.isProtectedVaultPath)? Those hold live-loaded capability
   *  definitions and the memory substrate, so a write there is a capability grant, not a note.
   *  Classed at tier 'capability-write' and EXCLUDED from the trusted-afk blanket auto-allow:
   *  it needs the exec token AND either a saved allow policy or the operator's answer to the
   *  modal — never a silent yes, whatever the posture or the full-access setting (the seam
   *  keeps full access away from it too). Defaults false, so nothing else moves. */
  pathProtected?: boolean
}

const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file', 'create_dir'])

/**
 * Resolve one gated /agui tool call to a verdict. Deny-first: the FIRST rule that
 * refuses wins, and a permissive rule never overrides a restrictive one above it.
 * Pure — no I/O, no throwing.
 */
export function decideAguiGate(input: AguiGateInput): AguiVerdict {
  // A write_file whose target ESCAPES the vault into a permitted root (Desktop / active
  // workspace) is classed as a gated reversible-file op: it earns the exec-token + posture
  // path instead of the ungated fail-open that in-vault note writes get. In-vault writes
  // (pathEscapesVault falsy) keep tier 'none' and pass through as before. See AguiGateInput.
  const escapingWrite = input.toolName === 'write_file' && input.pathEscapesVault === true
  // A file mutation inside a PROTECTED vault subtree (agents/skills/hooks/.brain) is a capability
  // grant or a memory edit — classed with create_skill, and never auto-allowed (rule 4 below).
  const protectedWrite = input.pathProtected === true && FILE_MUTATION_TOOLS.has(input.toolName)
  const tier: AguiTier = protectedWrite
    ? 'capability-write'
    : escapingWrite
      ? 'irreversible-file'
      : aguiTier(input.toolName)

  // 0) Not a gated tool → not this gate's concern. The gated set is the native
  //    host-exec/irreversible tools PLUS every mounted MCP tool (arbitrary
  //    external effect) PLUS a vault-escaping write_file. Non-gated (reads, in-vault
  //    writes) fail OPEN by design.
  const gated =
    isGatedTool(input.toolName) ||
    escapingWrite ||
    protectedWrite ||
    tier === 'mcp-external' ||
    tier === 'external-write' ||
    tier === 'external-irreversible'
  if (!gated) return { kind: 'allow', source: 'ungated', tier }

  // 1) Outer authentication (unchanged from agui-guard): no exec token → deny.
  if (!input.execOk) {
    return { kind: 'deny', source: 'exec-token', reason: deniedResult(input.toolName), tier }
  }

  // 2) Catastrophic floor (defense-in-depth): refuse destroy-the-host commands
  //    even on an authorized turn, before any policy/posture can permit them.
  if (input.screen && !input.screen.ok) {
    return {
      kind: 'deny',
      source: 'command-screen',
      reason: `Error: '${input.toolName}' refused — ${input.screen.reason} (blocked by the catastrophic-command safety screen).`,
      tier
    }
  }

  // 3) A persisted DENY policy has precedence over everything below.
  if (input.policy === 'deny') {
    return {
      kind: 'deny',
      source: 'policy',
      reason: `Error: '${input.toolName}' is denied by a saved permission policy. Continue by answering directly or using a read/search tool.`,
      tier
    }
  }

  // 4) Trusted-AFK: the exec-token turn IS the authorization. Past the floor and
  //    with no saved deny, auto-allow — the seam still records an audit event.
  //    EXCEPTION (tier-aware floor): on a host with NO kernel sandbox, a HIGH-RISK
  //    command shape (remote payload piped to a shell/interpreter) does NOT get the
  //    blanket AFK auto-allow — it's refused unattended (a modal can't be answered
  //    AFK), so an unsandboxed-RCE shape can't silently run. Everything else is
  //    unchanged: normal commands still auto-allow. Sandboxed hosts are unaffected.
  //    EXCEPTION (policy unknown): a policy LOOKUP FAILURE (`policy === 'unknown'`)
  //    is not a confirmed absence of one, so it forfeits BOTH halves of the AFK
  //    blanket — the normal auto-allow AND its no-window immunity — and falls to
  //    rules 5-6 below, which ask a human when a window exists and fail-closed deny
  //    when one doesn't. Without this, an unresolved lookup reads identically to a
  //    genuine `null` and a saved deny that simply couldn't be read at this instant
  //    silently stops being enforced (the defect this rule exists to close).
  //    EXCEPTION (protected vault write): a write into `.duin/agents|skills|hooks` or `.brain/`
  //    is a capability grant / memory edit and forfeits the blanket — it falls to rules 5-6,
  //    so only a saved allow policy or the operator's modal answer lets it through (and no
  //    window means deny). Otherwise an instruction smuggled into a note could install an
  //    agent definition while the operator was away.
  if (input.posture === 'trusted-afk' && input.policy !== 'unknown' && !protectedWrite) {
    if (input.elevatedRisk === true && input.sandboxed === false) {
      return {
        kind: 'deny',
        source: 'unsandboxed-elevated',
        reason: `Error: '${input.toolName}' refused under trusted-afk — a high-risk command (remote payload piped into a shell/interpreter) won't auto-run unattended on a host with no kernel sandbox. Re-run with DUIN_AGUI_APPROVAL=interactive to approve it, or fetch and inspect the payload before executing it.`,
        tier
      }
    }
    return { kind: 'allow', source: 'posture:trusted-afk', tier }
  }

  // 4.5) Review (the honest middle): auto-allow the reversible tiers; everything
  //      irreversible / host-exec / send / spawn / arbitrary-external falls through
  //      to the interactive prompt logic (rules 5–6), so a persisted ALLOW still
  //      short-circuits and a missing window still fails closed. Same policy-unknown
  //      exception as rule 4: an unresolved lookup must not let a reversible tier
  //      skip straight to auto-allow either — it falls through with everything else.
  if (input.posture === 'review' && input.policy !== 'unknown' && isReviewAutoAllowTier(tier)) {
    return { kind: 'allow', source: 'posture:review', tier }
  }

  // 5) Interactive (or review's prompt set): an explicit saved ALLOW short-circuits the modal.
  if (input.policy === 'allow') {
    return { kind: 'allow', source: 'policy', tier }
  }

  // 6) Interactive with a human present → ask. No window → fail-closed deny.
  if (input.hasWindow) return { kind: 'prompt', tier }
  return {
    kind: 'deny',
    source: 'no-window',
    reason: `Error: '${input.toolName}' requires approval but no interactive window is available to grant it.`,
    tier
  }
}

/** Map a gated tool's tier to the descriptor risks used for the persisted-policy
 *  lookup and the approval-modal render. Native host/irreversible tiers carry
 *  `'destructive'`; MCP tools carry `'network'` (external I/O). Both are in
 *  GATING_RISKS, so either way the call gates through the permission service by
 *  construction (see permissions-store). PURE. */
export function tierRisks(tier: AguiTier): Array<'destructive' | 'network'> {
  // An MCP tool is arbitrary third-party effect. Returning ONLY 'network' meant a
  // persisted "ask before destructive actions" policy could never match ANY MCP call,
  // no matter what that tool actually did — the risk vocabulary the policy is written
  // in simply did not include it. Deny-first: we cannot know a third-party tool is
  // harmless, so it carries both and the operator's destructive policy applies.
  if (tier === 'mcp-external') return ['network', 'destructive']
  // external-write is a REGISTERED ACT effector with a declared, reversible tier — its
  // effect is known, so it keeps the narrower risk.
  if (tier === 'external-write') return ['network']
  return ['destructive']
}

/** Read the /agui approval posture from the environment. `trusted-afk` is the
 *  default so the live autonomous app keeps working; set DUIN_AGUI_APPROVAL=
 *  interactive to route gated calls through the approval modal. PURE given env. */
export function readAguiPosture(env: NodeJS.ProcessEnv): AguiPosture {
  return env.DUIN_AGUI_APPROVAL === 'interactive' ? 'interactive' : 'trusted-afk'
}

/** Restrictiveness order (higher = MORE restrictive). The `meet` in
 *  `resolveTurnPosture` picks the max of (env, pill) on this scale. */
const POSTURE_RANK: Record<AguiPosture, number> = {
  'trusted-afk': 0,
  review: 1,
  interactive: 2
}

/** Map the composer's permissions pill to a gate posture.
 *  `full` → `trusted-afk` (today's permissive default), `auto-review` → `review`,
 *  `default` → `interactive` (ask on each gated call). Unknown / absent → `null`,
 *  so the caller falls back to the env posture (byte-for-byte today's behaviour).
 *  PURE. */
export function pillToPosture(mode: unknown): AguiPosture | null {
  switch (mode) {
    case 'full':
      return 'trusted-afk'
    case 'auto-review':
      return 'review'
    case 'default':
      return 'interactive'
    default:
      return null
  }
}

/** Effective posture for a turn. The pill may only TIGHTEN below the env floor,
 *  never loosen it — the result is the MEET (most-restrictive) of the env posture
 *  and the pill posture. A missing / garbled pill value falls back to the env
 *  posture exactly (today's behaviour), so a bug that garbles the field fails safe
 *  and can never accidentally loosen the gate. PURE given env. */
export function resolveTurnPosture(pillMode: unknown, env: NodeJS.ProcessEnv): AguiPosture {
  const envPosture = readAguiPosture(env)
  const pill = pillToPosture(pillMode)
  if (!pill) return envPosture
  return POSTURE_RANK[pill] >= POSTURE_RANK[envPosture] ? pill : envPosture
}
