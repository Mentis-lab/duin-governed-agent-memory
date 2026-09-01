// Per-action AG-UI tool gate — relocated verbatim from server.ts (pure move).
// resolveAguiGate + its turn-scoped AguiGateCtx. handleAgui imports resolveAguiGate
// back (its mainPolicy.gate call site).
import { randomUUID } from 'crypto'
import { normalize } from 'path'
import { BrowserWindow } from 'electron'
import { decideAguiGate, aguiTier, tierRisks, isMcpToolName, type AguiPosture } from './agui-approval'
import { isGatedTool, deniedResult } from './agui-guard'
import { resolveInVault, isProtectedVaultPath } from './agui-executors'
import { fullComputerAccess } from '../sandbox/operator-write-paths'
import { isRegisteredExternalActionGated } from '../act/action-tier'
import { tierWeight, accrueConsequence, resetConsequence, shouldEscalateCumulative } from '../act/cumulative-consequence'
import { getCapability } from '../ans/capability-ledger'
import { composeTierRung } from '../ans/gate-compose'
import { setActExecContext, gateDispatchOnChannelEnabled } from '../act/external-action'
import { screenCommand, classifyCommandRisk } from './command-screen'
import { ruleOfTwoCheck, ruleOfTwoProfile } from '../governance/rule-of-two'
import { reviewAction } from '../governance/action-reviewer'
import { hasKernelSandbox } from '../sandbox'
import { permissionsService } from '../permissions-store'
import { getActiveWorkspace } from '../workspace-state'
import { resolveDecision as resolvePersistedDecision } from '../permission-policies-store'
import { recordEvent } from '../event-log'
import { messageOf } from '../guarded'
import { channelDispatch } from '../channel-dispatch'
import {
  shouldRouteToChannelApproval,
  requestOperatorApproval,
  readApprovalConfig
} from '../proactive/approval-roundtrip'

/** Turn-scoped context for the per-action gate. */
interface AguiGateCtx {
  execOk: boolean
  posture: AguiPosture
  /** Continuity id (threadId) — scopes conversation-level persisted policies. */
  conversationId: string
  /** Vault root. Audit metadata only — NOT the workspace-policy scope key.
   *  Callers pass the notes dir here; workspace-scoped policies are keyed by
   *  `getActiveWorkspace()`, which this gate resolves itself (see below). */
  workspacePath: string
}

/**
 * Resolve ONE tool call through the deny-first, tiered, per-action gate before
 * the dispatch loop executes it. Non-gated tools pass through instantly. Gated
 * tools are screened (catastrophic floor), checked against persisted policy, and
 * — per posture — auto-allowed under the trusted session (AFK) or routed to the
 * approval modal. Every decision is written to the audit spine.
 *
 * Never throws: any lookup/emit failure degrades toward the pure verdict, which
 * is itself fail-safe. Returns the model-facing denial string on a refusal.
 */
export async function resolveAguiGate(
  tc: any,
  ctx: AguiGateCtx
): Promise<{ allow: boolean; reason?: string; source: string; tier: string }> {
  const name = tc?.function?.name
  // Publish this turn's exec privilege for the ACT handler-level re-check
  // (external-action.runExternalAction) so its defense-in-depth sees the same
  // execOk this gate decides on. Set for EVERY call (before the ungated early-out)
  // so a subsequent handler in the turn can't read a stale value.
  setActExecContext(ctx.execOk)

  // Parse args up front: needed both for the write_file vault-escape check just below and for
  // command screening further down. Pure (no side effects), so it is safe before the early-out.
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(tc?.function?.arguments || '{}')
  } catch (e) { console.debug('[agui-gate] malformed args  the executor will report the missing field if we allow:', messageOf(e)) }

  // write_file is ungated for in-vault note writes, but a write that ESCAPES the vault into a
  // permitted root (the active workspace, or an operator-granted path like the Desktop) is a
  // real filesystem side effect — gate it like delete/move. Computed with the SAME
  // resolveInVault the executor writes through, against the vault notes dir the caller passes
  // as workspacePath, so the gate and the executor never disagree about where the bytes land.
  let writeEscapesVault = false
  if (name === 'write_file') {
    try {
      const rv = resolveInVault(ctx.workspacePath, (args as { path?: unknown }).path)
      writeEscapesVault = rv.ok && normalize(rv.root) !== normalize(ctx.workspacePath)
    } catch (e) { console.debug('[agui-gate] write_file path resolve failed  treating as in-vault (executor re-checks):', messageOf(e)) }
  }

  // A file mutation whose target lands in a PROTECTED vault subtree — `.duin/agents`,
  // `.duin/skills`, `.duin/hooks`, `.brain/` — is a capability grant or a memory edit, not a
  // note (release M11, A4 F9). Gated at tier 'capability-write': needs the exec token and an
  // explicit operator approval (saved allow policy or the modal), never the trusted-afk
  // blanket and never the full-access override below. Resolved with the SAME resolveInVault the
  // executors write through; a resolve failure is treated as protected (deny-first — the
  // executor re-checks the path and reports its own error if the call is allowed).
  let writeTargetsProtected = false
  const mutationTargets: unknown[] =
    name === 'move_file'
      ? [(args as { from?: unknown }).from, (args as { to?: unknown }).to]
      : name === 'write_file' || name === 'edit_file' || name === 'delete_file' || name === 'create_dir'
        ? [(args as { path?: unknown }).path]
        : []
  for (const target of mutationTargets) {
    try {
      const rv = resolveInVault(ctx.workspacePath, target)
      if (rv.ok && isProtectedVaultPath(ctx.workspacePath, rv.abs)) writeTargetsProtected = true
    } catch (e) {
      writeTargetsProtected = true
      console.debug('[agui-gate] file-tool path resolve failed  treating as protected (deny-first):', messageOf(e))
    }
  }

  // Gated set = native host-exec/irreversible tools PLUS every mounted MCP tool (arbitrary
  // external effect) PLUS every registered ACT external effector (act/external-action.ts)
  // PLUS a vault-escaping write_file PLUS a protected-subtree file mutation. Non-gated (reads,
  // ordinary in-vault writes) pass through.
  if (!isGatedTool(name) && !isMcpToolName(name) && !isRegisteredExternalActionGated(name) && !writeEscapesVault && !writeTargetsProtected) {
    return { allow: true, source: 'ungated', tier: 'none' }
  }

  // Screen host-exec commands against the catastrophic floor (defense-in-depth;
  // executeRunCommand screens again at the seam). delete/move/spawn have no shell
  // command to screen → null.
  const isExecTool = name === 'run_command' || name === 'start_command'
  const execCommand = isExecTool ? (args as { command?: unknown }).command : undefined
  const screen = isExecTool ? screenCommand(execCommand) : null
  // Tier-aware AFK escalation inputs: does this host have a kernel sandbox, and is
  // this a high-risk (remote-payload-piped-to-shell) command shape? A high-risk
  // unsandboxed call loses the trusted-afk blanket auto-allow (see decideAguiGate).
  const sandboxed = hasKernelSandbox()
  const elevatedRisk = isExecTool && classifyCommandRisk(execCommand) === 'elevated'

  // Persisted per-action policy (deny precedence). A LOOKUP FAILURE (the store call
  // below throws — e.g. transient SQLITE_BUSY outlasting its retries) is reported as
  // 'unknown', never silently folded into `null`. `null` here must stay a confirmed
  // "nothing saved": collapsing a failed lookup into that same value is how a saved
  // global deny on a host-exec tool went on silently NOT being enforced — decideAguiGate
  // never reached its `policy === 'deny'` branch and fell through to the trusted-afk
  // blanket allow, auditable only as a console.debug line nobody was watching. The
  // 'unknown' tri-state (agui-approval.ts) makes decideAguiGate treat an unresolved
  // lookup at least as restrictively as any policy it can't yet prove is absent.
  let policy: 'allow' | 'deny' | null | 'unknown' = null
  try {
    // Resolve the workspace scope HERE rather than trusting the caller. Both
    // production callers (server.ts's mainPolicy.gate, agui-subagent.ts) passed
    // the VAULT notes dir, while the only writer of a workspace-scoped policy
    // (permissions-store.ts's requestApprovalDetailed) keys it to
    // getActiveWorkspace(). The two coincide until the user picks a workspace
    // with the ChatInput chip — getActiveWorkspace() falls back to the vault —
    // and diverge the moment they do, so an explicit "deny for this workspace"
    // was looked up under the wrong key, missed, and fell through to the
    // trusted-afk blanket allow. Resolving it at the single point of use means
    // no caller can get this wrong again.
    let policyWorkspace: string | undefined
    try {
      policyWorkspace = getActiveWorkspace() || undefined
    } catch (e) {
      policyWorkspace = ctx.workspacePath || undefined
      console.debug('[agui-gate] active-workspace unavailable  falling back to the caller path for policy scope:', messageOf(e))
    }
    const persisted = resolvePersistedDecision({
      toolId: name,
      risks: tierRisks(aguiTier(name)),
      conversationId: ctx.conversationId || undefined,
      workspacePath: policyWorkspace
    })
    if (persisted) policy = persisted.decision
  } catch (e) {
    policy = 'unknown'
    console.debug('[agui-gate] policy store unavailable  policy UNKNOWN, not "no policy" (decideAguiGate denies/prompts rather than auto-allowing):', messageOf(e))
  }

  let hasWindow = false
  try {
    hasWindow = BrowserWindow.getAllWindows().length > 0
  } catch (e) { console.debug('[agui-gate] no electron window layer  fail-closed for the interactive path:', messageOf(e)) }

  // Full computer access (operator opt-in, OFF by default — sandbox/operator-write-paths.ts):
  // when ON, authorize the LOCAL COMPUTER surface — host-exec (run/start_command) and file ops
  // (delete/move + a vault-escaping write_file) — for EVERY turn including inbound channels,
  // and auto-allow it (posture→trusted-afk), which is the "act on my whole machine,
  // automatically" the operator asked for. When OFF (a fresh install) none of this applies:
  // every gated call takes the exec-token + posture path below, so a de-privileged inbound
  // turn is denied and a renderer turn on the default pill prompts. Scope is deliberate:
  // irreversible EXTERNAL effects (send_email, MCP tools, ACT effectors, spawn_agent) are NOT
  // authorized here — they keep the normal exec-token gate, so an inbound message cannot
  // auto-send mail or drive external services just because full access is on. The
  // catastrophic-command screen (decideAguiGate rule 2) and any persisted DENY still apply,
  // and the tighten-only governors below still run — full access widens WHO + WHETHER for
  // local file/shell ops, it never removes the OS-bricking floor.
  const seamTier = aguiTier(name)
  const isLocalComputerOp =
    seamTier === 'host-exec' || seamTier === 'irreversible-file' || (name === 'write_file' && writeEscapesVault)
  // A protected-subtree write is a capability grant, not a local file op: full access never
  // authorizes it (same reasoning as create_skill's re-tiering).
  const fullAccessAuth = isLocalComputerOp && !writeTargetsProtected && fullComputerAccess()
  const effExecOk = fullAccessAuth || ctx.execOk
  const effPosture: AguiPosture = fullAccessAuth ? 'trusted-afk' : ctx.posture

  let verdict = decideAguiGate({ toolName: name, execOk: effExecOk, screen, posture: effPosture, policy, hasWindow, sandboxed, elevatedRisk, pathEscapesVault: writeEscapesVault, pathProtected: writeTargetsProtected })

  // GOVERN (compose): the consequence-TIER gate above and the ANS autonomy RUNG per
  // capability are two governors that never composed — a capability pinned to 'hold'
  // could still be auto-allowed by the tier. DEFAULT ON (set DUIN_ANS_COMPOSE=0 to
  // disable) → take the LEAST-PERMISSIVE meet at this choke-point: an ANS 'stage'/'hold'
  // rung can only TIGHTEN the tier verdict (allow→prompt→deny), never loosen it — safe
  // by construction. Only an allow/prompt can be tightened (a deny is already the floor);
  // a tool with no registered capability (rung=null) is unaffected — the tier stands.
  if (process.env.DUIN_ANS_COMPOSE !== '0' && (verdict.kind === 'allow' || verdict.kind === 'prompt')) {
    try {
      const cap = getCapability(name)
      const composed = composeTierRung(verdict.kind, cap ? cap.rung : null)
      if (composed.tightenedByRung) {
        const priorSource = 'source' in verdict ? verdict.source : 'tier'
        verdict =
          composed.kind === 'deny'
            ? {
                kind: 'deny',
                source: `${priorSource}+ans:${cap!.rung}`,
                reason: `ANS rung '${cap!.rung}' withholds autonomous '${name}'`,
                tier: verdict.tier
              }
            : { kind: 'prompt', tier: verdict.tier }
      }
    } catch (e) { console.debug('[agui-gate] ANS ledger unavailable  tier verdict stands:', messageOf(e)) }
  }

  // GOVERN (rule-of-two, W1): the third tighten-only composer at this choke-point. A session
  // that has already ingested untrusted content AND touched secret-class material must not take
  // a state-changing/external action on a blanket allow — including the trusted-afk posture,
  // which is exactly the door the ANS meet and the tier gate leave open. Escalates allow→prompt:
  // interactively the modal makes the human the Rule-of-Two gate; in AFK (no window) the prompt
  // fail-closes to deny below. Legs derive from the tier's own risk vocabulary (tierRisks) and
  // the shared session profile accrued at dispatch time (governance/rule-of-two.ts). Tighten-only,
  // never loosens; a lookup failure leaves the verdict as-is.
  let rotBlock: ReturnType<typeof ruleOfTwoCheck> = null
  if (verdict.kind === 'allow') {
    try {
      rotBlock = ruleOfTwoCheck(ctx.conversationId, {
        name,
        providerKind: isMcpToolName(name) ? 'mcp' : 'native',
        risks: tierRisks(verdict.tier as Parameters<typeof tierRisks>[0])
      })
      if (rotBlock) {
        console.debug(`[agui-gate] rule-of-two triple completed by '${name}' — escalating allow→prompt`)
        verdict = { kind: 'prompt', tier: verdict.tier }
      }
    } catch (e) { console.debug('[agui-gate] rule-of-two unavailable  verdict stands:', messageOf(e)) }
  }

  // GOVERN (action-reviewer, W3): a SEPARATE cheap model reviews each action the
  // trusted-afk blanket would auto-allow — the one verdict source where a gated action
  // runs with nobody watching and no deterministic floor objecting. Tighten-only:
  // critical → deny, high → prompt (fail-closes AFK), medium/low → the allow stands.
  // Fail-closed on a STAFFED lane failing; SKIPPED (verdict stands) when keyless/disabled
  // — see action-reviewer.ts polarity note. Only this blanket source is reviewed: a
  // policy-allow or an operator channel-approve is already a human decision.
  // KNOWN LIMIT (W3.1): actorModel is not threaded through AguiGateCtx yet, so the
  // distinct-family preference falls back to the extraction route on THIS face (the
  // chat-unattended and headless faces do pass it). Tier policy usually separates the
  // extraction pick from answer models regardless; threading the ctx field is the fix.
  if (verdict.kind === 'allow' && verdict.source === 'posture:trusted-afk') {
    try {
      const rot = ruleOfTwoProfile(ctx.conversationId)
      const review = await reviewAction({
        toolName: name,
        args,
        surface: 'agui-afk',
        context: {
          untrustedIngested: rot?.untrustedIngested,
          secretTouched: rot?.secretTouched,
          posture: effPosture
        }
      })
      if (review.source !== 'skipped') {
        if (review.tier === 'critical') {
          // The audit write is best-effort and must NEVER decide the outcome:
          // this whole block sits in a catch-to-allow, so a throwing
          // recordEvent would convert a critical deny into an allow (the
          // fail-open shape the other two faces already guard against).
          try {
            recordEvent({
              type: 'tool.call.denied',
              actorKind: 'system',
              severity: 'warning',
              conversationId: ctx.conversationId || undefined,
              workspacePath: ctx.workspacePath || undefined,
              entityKind: 'tool',
              entityId: name,
              payload: { toolId: name, tier: verdict.tier, source: `action-reviewer:${review.source}`, reason: review.reason, surface: 'agui' }
            })
          } catch (e) {
            console.debug('[agui-gate] deny audit failed (deny stands):', messageOf(e))
          }
          return {
            allow: false,
            reason: `Error: '${name}' was refused by the independent action reviewer (${review.reason}). Continue by answering directly or using a read/search tool.`,
            source: `action-reviewer:${review.source}`,
            tier: verdict.tier
          }
        }
        if (review.tier === 'high') {
          console.debug(`[agui-gate] action-reviewer rated '${name}' high — escalating allow→prompt`)
          verdict = { kind: 'prompt', tier: verdict.tier }
        }
      }
    } catch (e) { console.debug('[agui-gate] action-reviewer unavailable  verdict stands:', messageOf(e)) }
  }

  // GOVERN (cumulative-consequence): the tier gate + ANS rung each score a SINGLE action; neither
  // sees a SEQUENCE of individually-permissible actions adding up (100 reversible writes, a drip of
  // external sends, a runaway loop). Accrue this action's reversibility-weighted consequence into the
  // conversation's running total; when it crosses the ceiling, TIGHTEN allow→prompt — the SAME
  // tighten-only, safe-by-construction move as the ANS composer above (a prompt fail-closes in AFK,
  // shows a modal interactively). Reads (weight 0) never move the budget. DUIN_CONSEQUENCE_CEILING=0
  // disables (verdict untouched). Never loosens; a lookup failure leaves the verdict as-is.
  //
  // LOOP-CLOSED (Govern P2): a crossed ceiling used to mint a BARE prompt — which in AFK (no window)
  // silently fail-closed to DENY, blocking a benign flood with no operator recourse, and never reached
  // the approve branch below, so the accumulator was a ONE-WAY RATCHET (escalates forever). Now the
  // escalation ROUTES TO THE OPERATOR over the live channel (ask, don't silently deny); an operator
  // approval RESETS the session budget (resetConsequence), so a ratified "continue" isn't re-escalated.
  // Tighten-only preserved (shouldEscalateCumulative only ever escalates an allow; reset only zeroes the
  // cumulative accumulator, never the per-action tier floor). Opt-in default unchanged (ceiling 0 → inert).
  let cumulativeEscalated = false
  try {
    const weight = tierWeight(verdict.tier)
    if (verdict.kind === 'allow' && weight > 0) {
      // CHECK before ACCRUE: shouldEscalateCumulative asks "does prev-total + THIS weight cross the
      // ceiling?" (overConsequenceCeiling adds `weight` itself). Accruing first would count this action
      // twice and trip one action early — so decide, THEN record this action toward the next decision.
      const escalate = shouldEscalateCumulative(verdict.kind, verdict.tier, ctx.conversationId || '')
      accrueConsequence(ctx.conversationId || '', weight)
      if (escalate) {
        const cfg = readApprovalConfig()
        const routeToOperator = shouldRouteToChannelApproval({
          enabled: cfg.enabled,
          posture: ctx.posture,
          hasWindow,
          operator: cfg.operator,
          homeChannelKind: cfg.homeChannel.kind
        })
        if (routeToOperator) {
          console.debug(`[agui-gate] cumulative ceiling reached for '${name}' — routing escalation to the operator over the channel`)
          const outcome = await requestOperatorApproval(
            { summary: `Cumulative consequence ceiling reached for '${name}' (tier ${verdict.tier}). Continue?`, tool: name },
            // Wrapped, not raw: a channel that is CONFIGURED but not flipped enabled
            // accepts the send and nothing listens, so the operator answers into a
            // void and the ask times out with no error naming the real cause. This is
            // the wrapper already applied on the ACT approval path for this same class.
            { operator: cfg.operator, homeChannel: cfg.homeChannel, timeoutMs: cfg.timeoutMs, dispatch: gateDispatchOnChannelEnabled(channelDispatch) }
          )
          if (outcome.decision === 'approve') {
            resetConsequence(ctx.conversationId || '') // operator ratified "continue" → budget reset (loop closed)
            recordEvent({
              type: 'tool.call.approved',
              actorKind: 'system',
              severity: 'info',
              conversationId: ctx.conversationId || undefined,
              workspacePath: ctx.workspacePath || undefined,
              entityKind: 'tool',
              entityId: name,
              payload: { toolId: name, tier: verdict.tier, source: 'cumulative-approval:operator-approve', surface: 'agui' }
            })
            return { allow: true, source: 'cumulative-approval:operator-approve', tier: verdict.tier }
          }
          recordEvent({
            type: 'tool.call.denied',
            actorKind: 'system',
            severity: 'warning',
            conversationId: ctx.conversationId || undefined,
            workspacePath: ctx.workspacePath || undefined,
            entityKind: 'tool',
            entityId: name,
            payload: { toolId: name, tier: verdict.tier, source: `cumulative-approval:${outcome.source}`, surface: 'agui' }
          })
          return {
            allow: false,
            reason: `Error: '${name}' exceeded the cumulative consequence ceiling and was not approved by the operator (${outcome.source}). Continue by answering directly or using a read/search tool.`,
            source: `cumulative-approval:${outcome.source}`,
            tier: verdict.tier
          }
        }
        // Not AFK-routable (interactive window present / operator or two-way channel unconfigured) →
        // tighten to a modal prompt as before; flag it so a modal-approve resets the budget too.
        console.debug(`[agui-gate] cumulative ceiling reached for '${name}' — escalating allow→prompt (interactive)`)
        verdict = { kind: 'prompt', tier: verdict.tier }
        cumulativeEscalated = true
      }
    }
  } catch (e) { console.debug('[agui-gate] cumulative-consequence unavailable  verdict stands:', messageOf(e)) }

  // AFK OPERATOR APPROVAL (#1, opt-in via DUIN_CHANNEL_APPROVAL). When the pure gate
  // would BLANKET auto-allow under trusted-afk (no window to answer a modal), and an
  // operator + two-way home channel are configured, push the approval to the operator
  // and await their reply INSTEAD of silently allowing — strictly safer than the
  // status-quo auto-allow. Default OFF → the live app is byte-identical.
  //
  // SECURITY: only reachable for an ALREADY-authorized turn — a de-privileged turn
  // (execOk:false, e.g. an inbound channel turn) is denied at the exec-token rule
  // above and never gets here, so a channel reply can NEVER escalate an unprivileged
  // turn. On any failure we fall back to the original verdict (never MORE permissive).
  // NB: a registered ACT external action owns its OWN operator-approval step inside
  // runExternalAction (external-action.ts), so the gate must NOT also route it to the
  // channel — that would double-prompt. The gate's job for these is only the
  // exec-token + tier deny (already applied via decideAguiGate above).
  //
  // ONLY the irreversible tier, though. That "ACT approves it anyway" premise is true
  // for exactly one tier: action-tier.ts's requiresApproval is `tier === 'irreversible'`,
  // and its own comment says a write-reversible action is soft-gated — a privileged turn
  // is enough. Excluding 'external-write' here therefore left tools like
  // calendar_create_event / drive_upload_file / feishu_create_doc with NO operator
  // notification anywhere while AFK: not this channel gate (excluded), not a modal
  // (no window), and not the ACT substrate (auto-allows a reversible write).
  const isExternalAction = verdict.tier === 'external-irreversible'
  if (verdict.kind === 'allow' && verdict.source === 'posture:trusted-afk' && !isExternalAction) {
    try {
      const cfg = readApprovalConfig()
      if (
        shouldRouteToChannelApproval({
          enabled: cfg.enabled,
          posture: ctx.posture,
          hasWindow,
          operator: cfg.operator,
          homeChannelKind: cfg.homeChannel.kind
        })
      ) {
        const outcome = await requestOperatorApproval(
          { summary: `Run gated tool '${name}' (tier ${verdict.tier}).`, tool: name },
          {
            operator: cfg.operator,
            homeChannel: cfg.homeChannel,
            timeoutMs: cfg.timeoutMs,
            dispatch: gateDispatchOnChannelEnabled(channelDispatch)
          }
        )
        if (outcome.decision !== 'approve') {
          recordEvent({
            type: 'tool.call.denied',
            actorKind: 'system',
            severity: 'warning',
            conversationId: ctx.conversationId || undefined,
            workspacePath: ctx.workspacePath || undefined,
            entityKind: 'tool',
            entityId: name,
            payload: { toolId: name, tier: verdict.tier, source: `channel-approval:${outcome.source}`, surface: 'agui' }
          })
          return {
            allow: false,
            reason: `Error: '${name}' was not approved by the operator over the channel (${outcome.source}). Continue by answering directly or using a read/search tool.`,
            source: `channel-approval:${outcome.source}`,
            tier: verdict.tier
          }
        }
        // Approved over the channel → fall through to the allow audit + return below,
        // tagged so the audit trail shows the operator released it. The operator explicitly ratified
        // "continue", so RESET the cumulative budget too (Govern P2 loop-closure — an approval must not
        // leave the session pinned at/over the ceiling and re-escalating every subsequent action).
        resetConsequence(ctx.conversationId || '')
        recordEvent({
          type: 'tool.call.approved',
          actorKind: 'system',
          severity: 'info',
          conversationId: ctx.conversationId || undefined,
          workspacePath: ctx.workspacePath || undefined,
          entityKind: 'tool',
          entityId: name,
          payload: { toolId: name, tier: verdict.tier, source: 'channel-approval:operator-approve', surface: 'agui' }
        })
        return { allow: true, source: 'channel-approval:operator-approve', tier: verdict.tier }
      }
    } catch (e) {
      // Approval plumbing failed → keep the ORIGINAL verdict (no escalation).
      console.debug('[agui-gate] channel-approval routing skipped:', messageOf(e))
    }
  }

  // Interactive prompt → delegate to the approval service (persisted policy →
  // modal → fail-closed). It emits its OWN audit event, so don't double-record.
  if (verdict.kind === 'prompt') {
    try {
      const outcome = await permissionsService.requestApprovalDetailed({
        callId: randomUUID(),
        toolId: name,
        name,
        serverId: 'local-brain',
        providerKind: 'native',
        risks: tierRisks(verdict.tier),
        args,
        conversationId: ctx.conversationId || undefined
      })
      const allow = outcome.decision === 'allow'
      // If this prompt was raised by the cumulative-consequence ceiling (not the per-action tier), an
      // operator approve ratifies "continue" → reset the session budget (loop-closure on the interactive
      // path). A tier-raised prompt does not touch the accumulator.
      if (allow && cumulativeEscalated) resetConsequence(ctx.conversationId || '')
      return {
        allow,
        reason: allow
          ? undefined
          : rotBlock
            ? `Error: '${name}' was blocked by the Rule-of-Two floor (${outcome.source}): ${rotBlock.reason} Continue by answering directly or using a read/search tool.`
            : `Error: '${name}' was not approved (${outcome.source}). Continue by answering directly or using a read/search tool.`,
        source: rotBlock && !allow ? `rule-of-two:${outcome.source}` : outcome.source,
        tier: verdict.tier
      }
    } catch {
      // Approval plumbing failed → fail-closed deny (never silently run a gated op).
      return { allow: false, reason: deniedResult(name), source: 'approval-error', tier: verdict.tier }
    }
  }

  // allow / deny — record the decision on the audit spine, then return it.
  try {
    recordEvent({
      type: verdict.kind === 'allow' ? 'tool.call.approved' : 'tool.call.denied',
      actorKind: 'system',
      severity: verdict.kind === 'allow' ? 'info' : 'warning',
      conversationId: ctx.conversationId || undefined,
      workspacePath: ctx.workspacePath || undefined,
      entityKind: 'tool',
      entityId: name,
      payload: { toolId: name, tier: verdict.tier, source: verdict.source, surface: 'agui' }
    })
  } catch (e) { console.debug('[agui-gate] audit is best-effort; the decision itself is the load-bearing side effect:', messageOf(e)) }

  return verdict.kind === 'allow'
    ? { allow: true, source: verdict.source, tier: verdict.tier }
    : { allow: false, reason: verdict.reason, source: verdict.source, tier: verdict.tier }
}
