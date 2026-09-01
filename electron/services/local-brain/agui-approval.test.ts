import { describe, it, expect } from 'vitest'
import {
  decideAguiGate,
  aguiTier,
  tierRisks,
  readAguiPosture,
  resolveTurnPosture,
  pillToPosture,
  isReviewAutoAllowTier,
  isMcpToolName,
  type AguiGateInput,
  type AguiPosture,
  type AguiTier
} from './agui-approval'
import { registerExternalActionTier } from '../act/action-tier'

// A permissive baseline (authorized, screen-clean, no policy, AFK). Each test
// overrides only the dimension it exercises so the deny-first ordering is clear.
function base(over: Partial<AguiGateInput> = {}): AguiGateInput {
  return {
    toolName: 'run_command',
    execOk: true,
    screen: { ok: true },
    posture: 'trusted-afk',
    policy: null,
    hasWindow: true,
    ...over
  }
}

// Release M11 (A4 F9): a file mutation inside `.duin/agents|skills|hooks` or `.brain/` is a
// capability grant / memory edit. It is gated at tier 'capability-write' and forfeits the
// trusted-afk blanket, so only a saved allow policy or the operator's modal answer lets it run.
describe('decideAguiGate — protected vault subtrees (pathProtected)', () => {
  const protectedWrite = (over: Partial<AguiGateInput> = {}): AguiGateInput =>
    base({ toolName: 'write_file', screen: null, pathProtected: true, ...over })

  it('classes a protected write_file at tier capability-write', () => {
    const v = decideAguiGate(protectedWrite())
    expect(v.tier).toBe('capability-write')
  })

  it('does NOT auto-allow under trusted-afk — it prompts when a window exists', () => {
    const v = decideAguiGate(protectedWrite({ posture: 'trusted-afk', hasWindow: true }))
    expect(v.kind).toBe('prompt')
  })

  it('fails closed under trusted-afk with no window (nobody to ask)', () => {
    const v = decideAguiGate(protectedWrite({ posture: 'trusted-afk', hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })

  it('denies a de-privileged turn at the exec-token rule before any posture applies', () => {
    const v = decideAguiGate(protectedWrite({ execOk: false, posture: 'trusted-afk' }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })

  it('honours an explicit saved ALLOW policy (the operator decided once)', () => {
    const v = decideAguiGate(protectedWrite({ policy: 'allow' }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('policy')
  })

  it('covers every file-mutation tool, and nothing else', () => {
    for (const toolName of ['write_file', 'edit_file', 'delete_file', 'move_file', 'create_dir']) {
      const v = decideAguiGate(protectedWrite({ toolName }))
      expect(v.kind, toolName).toBe('prompt')
      expect(v.tier, toolName).toBe('capability-write')
    }
    // A read with the flag set is still a read: the flag only means something for mutations.
    const read = decideAguiGate(base({ toolName: 'read_file', screen: null, pathProtected: true }))
    expect(read.kind).toBe('allow')
    expect(read.tier).toBe('none')
  })

  it('leaves an ordinary in-vault write_file ungated (pathProtected false/absent)', () => {
    const v = decideAguiGate(base({ toolName: 'write_file', screen: null }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('ungated')
  })
})

describe('aguiTier — irreversibility classification', () => {
  it('classes host-exec tools', () => {
    expect(aguiTier('run_command')).toBe('host-exec')
    expect(aguiTier('start_command')).toBe('host-exec')
  })
  it('classes irreversible file ops', () => {
    expect(aguiTier('delete_file')).toBe('irreversible-file')
    expect(aguiTier('move_file')).toBe('irreversible-file')
  })
  it('classes spawn_agent as recursive', () => {
    expect(aguiTier('spawn_agent')).toBe('spawn-recursive')
  })
  it('classes send_email as an irreversible send', () => {
    expect(aguiTier('send_email')).toBe('irreversible-send')
  })
  it('classes any MCP tool (serverId__tool) as mcp-external', () => {
    expect(aguiTier('feishu__send_message')).toBe('mcp-external')
    expect(aguiTier('node-repl__eval')).toBe('mcp-external')
    expect(isMcpToolName('chrome__navigate')).toBe(true)
    expect(isMcpToolName('read_file')).toBe(false)
  })
  it('non-gated / unknown tools are tier none', () => {
    expect(aguiTier('read_file')).toBe('none')
    expect(aguiTier('write_file')).toBe('none')
    expect(aguiTier(undefined)).toBe('none')
  })
})

describe('decideAguiGate — MCP tools are gated like host-exec', () => {
  it('an MCP tool with no token is denied (exec-token)', () => {
    const v = decideAguiGate(base({ toolName: 'feishu__send_message', execOk: false, screen: null }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
    expect(v.kind === 'deny' && v.tier).toBe('mcp-external')
  })
  it('an authorized MCP tool auto-allows under trusted-afk (audited)', () => {
    const v = decideAguiGate(base({ toolName: 'node-repl__eval', screen: null }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.tier).toBe('mcp-external')
  })
  it('a persisted DENY blocks an MCP tool even in trusted-afk', () => {
    const v = decideAguiGate(base({ toolName: 'chrome__navigate', screen: null, policy: 'deny' }))
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })
})

describe('decideAguiGate — send_email is a GATED irreversible send', () => {
  // SECURITY KEYSTONE: a de-privileged inbound/channel turn carries execToken:null
  // (execOk:false). The exec-token rule (deny-first, before trusted-afk) must refuse
  // send_email so an untrusted inbound message can never make DUIN send mail.
  it('DENIES send_email on a de-privileged turn (execOk:false → exec-token)', () => {
    const v = decideAguiGate(base({ toolName: 'send_email', execOk: false, screen: null }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
    expect(v.kind === 'deny' && v.tier).toBe('irreversible-send')
  })
  it('the deny fires BEFORE the trusted-afk auto-allow (posture cannot rescue it)', () => {
    const v = decideAguiGate(
      base({ toolName: 'send_email', execOk: false, screen: null, posture: 'trusted-afk' })
    )
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })
  it('a persisted DENY blocks send_email even on an authorized trusted-afk turn', () => {
    const v = decideAguiGate(base({ toolName: 'send_email', screen: null, policy: 'deny' }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })
  it('an authorized trusted-afk turn auto-allows send_email (audited)', () => {
    const v = decideAguiGate(base({ toolName: 'send_email', screen: null }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.tier).toBe('irreversible-send')
  })
  it('an authorized interactive turn PROMPTS for send_email approval', () => {
    const v = decideAguiGate(
      base({ toolName: 'send_email', screen: null, posture: 'interactive', policy: null, hasWindow: true })
    )
    expect(v.kind).toBe('prompt')
    expect(v.tier).toBe('irreversible-send')
  })
  it('tierRisks maps the send tier to a destructive gating risk', () => {
    expect(tierRisks('irreversible-send')).toEqual(['destructive'])
  })
})

describe('decideAguiGate — tier-aware AFK escalation (unsandboxed + high-risk)', () => {
  it('refuses a high-risk command on an UNSANDBOXED host under trusted-afk', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', sandboxed: false, elevatedRisk: true }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('unsandboxed-elevated')
  })

  it('STILL auto-allows a high-risk command on a SANDBOXED host (isolation covers it)', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', sandboxed: true, elevatedRisk: true }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('posture:trusted-afk')
  })

  it('auto-allows a NORMAL command on an unsandboxed host (no false friction)', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', sandboxed: false, elevatedRisk: false }))
    expect(v.kind).toBe('allow')
  })

  it('the catastrophic floor still wins over the escalation (deny-first)', () => {
    const v = decideAguiGate(
      base({ posture: 'trusted-afk', sandboxed: false, elevatedRisk: true, screen: { ok: false, reason: 'x' } })
    )
    expect(v.kind === 'deny' && v.source).toBe('command-screen')
  })

  it('omitting the new fields preserves the old blanket auto-allow (back-compat)', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk' }))
    expect(v.kind).toBe('allow')
  })
})

describe('decideAguiGate — deny-first ordering', () => {
  it('denies a non-authorized (no exec token) turn first of all', () => {
    const v = decideAguiGate(base({ execOk: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })

  it('exec-token deny wins even when a catastrophic screen would ALSO fire', () => {
    // Ordering guarantee: authentication is checked before the floor.
    const v = decideAguiGate(base({ execOk: false, screen: { ok: false, reason: 'rm -rf /' } }))
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
  })

  it('catastrophic screen is a floor even on an authorized, allow-policy turn', () => {
    const v = decideAguiGate(
      base({ execOk: true, policy: 'allow', posture: 'interactive', screen: { ok: false, reason: 'formatting a drive' } })
    )
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('command-screen')
    expect(v.kind === 'deny' && v.reason).toContain('formatting a drive')
  })

  it('persisted DENY has precedence over trusted-afk auto-allow', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', policy: 'deny' }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })

  it('persisted DENY has precedence over an interactive allow window', () => {
    const v = decideAguiGate(base({ posture: 'interactive', policy: 'deny', hasWindow: true }))
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })
})

describe('decideAguiGate — trusted-afk posture (default, live app)', () => {
  it('auto-allows an authorized, screen-clean, un-denied call — audited by source', () => {
    const v = decideAguiGate(base())
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('posture:trusted-afk')
  })

  it('never opens a modal (no prompt) in AFK, even with no window', () => {
    const v = decideAguiGate(base({ hasWindow: false }))
    expect(v.kind).toBe('allow')
  })

  it('screen=null (delete/move/spawn, no command to screen) still auto-allows', () => {
    const v = decideAguiGate(base({ toolName: 'delete_file', screen: null }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.tier).toBe('irreversible-file')
  })
})

// ─── Regression: a policy LOOKUP FAILURE ('unknown') must not read as "no policy" ──
//
// The defect: agui-gate.ts's catch around resolvePersistedDecision() defaulted
// `policy` to `null` on ANY failure — the exact same value a genuine "operator never
// saved anything" produces. A saved global DENY on a host-exec tool that happened to
// hit a transient SQLITE_BUSY (permission-policies-store.ts's runDb rethrows by
// design; it does not swallow) then silently stopped being enforced: decideAguiGate
// never reached its `policy === 'deny'` branch and fell through to the trusted-afk
// blanket allow. `'unknown'` is the tri-state fix — see agui-gate.ts and rules 4/4.5
// above.
describe('decideAguiGate — policy lookup FAILURE ("unknown") forfeits every auto-allow', () => {
  it('REGRESSION: trusted-afk + unresolved lookup + no window must DENY, not blanket-allow', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', policy: 'unknown', hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })

  it('contrast: a CONFIRMED no-policy (null) keeps the trusted-afk no-window blanket allow', () => {
    // Same posture/window as above, only the policy state differs — isolates that
    // 'unknown' (not AFK-with-no-window in general) is what tightens the verdict.
    const v = decideAguiGate(base({ posture: 'trusted-afk', policy: null, hasWindow: false }))
    expect(v.kind).toBe('allow')
  })

  it('a REAL persisted deny still wins outright — "unknown" only matters when the store never answered', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', policy: 'deny', hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })

  it('with a window present, an unresolved lookup routes to the modal instead of auto-allowing', () => {
    const v = decideAguiGate(base({ posture: 'trusted-afk', policy: 'unknown', hasWindow: true }))
    expect(v.kind).toBe('prompt')
  })

  it('the review posture\'s reversible-tier auto-allow is forfeited the same way', () => {
    registerExternalActionTier('testconn_unknown_policy_probe', 'write-reversible')
    expect(aguiTier('testconn_unknown_policy_probe')).toBe('external-write')
    const v = decideAguiGate(
      base({
        toolName: 'testconn_unknown_policy_probe',
        screen: null,
        posture: 'review',
        policy: 'unknown',
        hasWindow: false
      })
    )
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })

  it('interactive posture is unaffected either way (already asked-or-denied on a null policy)', () => {
    const withWindow = decideAguiGate(base({ posture: 'interactive', policy: 'unknown', hasWindow: true }))
    expect(withWindow.kind).toBe('prompt')
    const noWindow = decideAguiGate(base({ posture: 'interactive', policy: 'unknown', hasWindow: false }))
    expect(noWindow.kind).toBe('deny')
    expect(noWindow.kind === 'deny' && noWindow.source).toBe('no-window')
  })
})

describe('decideAguiGate — interactive posture', () => {
  it('a saved ALLOW short-circuits the modal', () => {
    const v = decideAguiGate(base({ posture: 'interactive', policy: 'allow' }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('policy')
  })

  it('no saved policy + a window → prompt (route to the modal)', () => {
    const v = decideAguiGate(base({ posture: 'interactive', policy: null, hasWindow: true }))
    expect(v.kind).toBe('prompt')
  })

  it('no saved policy + NO window → fail-closed deny', () => {
    const v = decideAguiGate(base({ posture: 'interactive', policy: null, hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })
})

describe('decideAguiGate — non-gated defensive no-op', () => {
  it('fails OPEN only for a non-gated tool (safe reads never routed here)', () => {
    const v = decideAguiGate(base({ toolName: 'read_file', execOk: false }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('ungated')
  })
})

describe('tierRisks + readAguiPosture', () => {
  it('every gated tier gates through the permission service', () => {
    expect(tierRisks('host-exec')).toEqual(['destructive'])
    expect(tierRisks('irreversible-file')).toEqual(['destructive'])
    expect(tierRisks('spawn-recursive')).toEqual(['destructive'])
    // mcp-external carries 'destructive' TOO (backlog finding 46). It used to be
    // 'network' alone, which meant a persisted "ask before destructive actions" policy
    // could never match ANY MCP call regardless of what that third-party tool did — the
    // risk vocabulary the policy is written in simply did not include it.
    expect(tierRisks('mcp-external')).toEqual(['network', 'destructive'])
    // external-write is a REGISTERED ACT effector with a declared reversible tier, so
    // its effect is known and it keeps the narrower risk.
    expect(tierRisks('external-write')).toEqual(['network'])
  })
  it('posture defaults to trusted-afk; only exact "interactive" opts in', () => {
    expect(readAguiPosture({} as NodeJS.ProcessEnv)).toBe('trusted-afk')
    expect(readAguiPosture({ DUIN_AGUI_APPROVAL: 'interactive' } as unknown as NodeJS.ProcessEnv)).toBe('interactive')
    expect(readAguiPosture({ DUIN_AGUI_APPROVAL: 'Interactive' } as unknown as NodeJS.ProcessEnv)).toBe('trusted-afk')
    expect(readAguiPosture({ DUIN_AGUI_APPROVAL: 'yolo' } as unknown as NodeJS.ProcessEnv)).toBe('trusted-afk')
  })
})

// ─── Composer permissions pill → posture (§4.3 / §7 tests 1–2) ────────────────

describe('pillToPosture — composer pill → gate posture', () => {
  it('full → trusted-afk (today permissive default)', () => {
    expect(pillToPosture('full')).toBe('trusted-afk')
  })
  it('default → interactive (ask on each gated call)', () => {
    expect(pillToPosture('default')).toBe('interactive')
  })
  it('auto-review → review (the honest middle)', () => {
    expect(pillToPosture('auto-review')).toBe('review')
  })
  it('unknown / absent / garbage → null (caller falls back to env)', () => {
    expect(pillToPosture(undefined)).toBeNull()
    expect(pillToPosture(null)).toBeNull()
    expect(pillToPosture('yolo')).toBeNull()
    expect(pillToPosture('')).toBeNull()
    expect(pillToPosture(42)).toBeNull()
    expect(pillToPosture({ mode: 'full' })).toBeNull()
  })
})

describe('resolveTurnPosture — env is a FLOOR, the pill may only TIGHTEN (§4.4)', () => {
  const ENV_UNSET = {} as NodeJS.ProcessEnv
  const ENV_INTERACTIVE = { DUIN_AGUI_APPROVAL: 'interactive' } as unknown as NodeJS.ProcessEnv

  // Full matrix: {env unset, env=interactive} × {absent, full, auto-review, default, garbage}.
  // Result must always be the MEET (most-restrictive) of env posture and pill posture.
  it('env unset → the pill decides freely (only tighter than trusted-afk is reachable)', () => {
    expect(resolveTurnPosture(undefined, ENV_UNSET)).toBe('trusted-afk')   // absent → env
    expect(resolveTurnPosture('full', ENV_UNSET)).toBe('trusted-afk')      // full = env floor
    expect(resolveTurnPosture('auto-review', ENV_UNSET)).toBe('review')    // tighter
    expect(resolveTurnPosture('default', ENV_UNSET)).toBe('interactive')   // tightest
    expect(resolveTurnPosture('garbage', ENV_UNSET)).toBe('trusted-afk')   // garbled → env
  })

  it('env=interactive → the pill can NEVER loosen it (anti-loosening invariant)', () => {
    expect(resolveTurnPosture(undefined, ENV_INTERACTIVE)).toBe('interactive')
    expect(resolveTurnPosture('full', ENV_INTERACTIVE)).toBe('interactive')       // NO loosening
    expect(resolveTurnPosture('auto-review', ENV_INTERACTIVE)).toBe('interactive') // NO loosening
    expect(resolveTurnPosture('default', ENV_INTERACTIVE)).toBe('interactive')     // equal
    expect(resolveTurnPosture('garbage', ENV_INTERACTIVE)).toBe('interactive')     // garbled → env
  })

  it('absent pill yields EXACTLY readAguiPosture(env) — byte-for-byte today (§6 back-compat)', () => {
    for (const env of [ENV_UNSET, ENV_INTERACTIVE]) {
      expect(resolveTurnPosture(undefined, env)).toBe(readAguiPosture(env))
      expect(resolveTurnPosture(null, env)).toBe(readAguiPosture(env))
      expect(resolveTurnPosture('nonsense', env)).toBe(readAguiPosture(env))
    }
  })
})

// ─── decideAguiGate under the `review` posture (§4.2 / §7 test 3) ─────────────

describe('isReviewAutoAllowTier — only reversible external writes auto-allow', () => {
  it('external-write is the sole auto-allow tier; everything else prompts', () => {
    expect(isReviewAutoAllowTier('external-write')).toBe(true)
    const promptTiers: AguiTier[] = [
      'host-exec', 'irreversible-file', 'irreversible-send',
      'spawn-recursive', 'external-irreversible', 'mcp-external', 'none'
    ]
    for (const t of promptTiers) expect(isReviewAutoAllowTier(t)).toBe(false)
  })
})

describe('decideAguiGate — review posture (the honest middle)', () => {
  it('AUTO-ALLOWS a reversible external-write effector (the middle rung earns its name)', () => {
    // Register a write-reversible external action so aguiTier resolves its tool name to
    // the `external-write` tier, then assert review auto-allows it (source posture:review).
    registerExternalActionTier('testconn_save_draft', 'write-reversible')
    expect(aguiTier('testconn_save_draft')).toBe('external-write')
    const v = decideAguiGate(base({ toolName: 'testconn_save_draft', screen: null, posture: 'review', hasWindow: true }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('posture:review')
    expect(v.tier).toBe('external-write')
  })

  it('PROMPTS on host-exec under review with a window (irreversible tier)', () => {
    const v = decideAguiGate(base({ posture: 'review', policy: null, hasWindow: true }))
    expect(v.kind).toBe('prompt')
    expect(v.tier).toBe('host-exec')
  })

  it('PROMPTS on an MCP tool under review (R2 — arbitrary external effect must NOT auto-allow)', () => {
    const v = decideAguiGate(base({ toolName: 'feishu__send_message', screen: null, posture: 'review', hasWindow: true }))
    expect(v.kind).toBe('prompt')
    expect(v.tier).toBe('mcp-external')
  })

  it('PROMPTS on send_email / delete_file / spawn_agent under review', () => {
    for (const toolName of ['send_email', 'delete_file', 'spawn_agent']) {
      const v = decideAguiGate(base({ toolName, screen: null, posture: 'review', hasWindow: true }))
      expect(v.kind, `${toolName} must prompt under review`).toBe('prompt')
    }
  })

  it('a saved ALLOW short-circuits the review prompt (persisted-allow honoured)', () => {
    const v = decideAguiGate(base({ posture: 'review', policy: 'allow', hasWindow: true }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('policy')
  })

  it('review FAILS CLOSED with no window (never prompt) on an irreversible tier', () => {
    const v = decideAguiGate(base({ posture: 'review', policy: null, hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })

  it('persisted DENY overrides review; exec-token deny precedes review', () => {
    const denied = decideAguiGate(base({ posture: 'review', policy: 'deny', hasWindow: true }))
    expect(denied.kind === 'deny' && denied.source).toBe('policy')
    const noTok = decideAguiGate(base({ posture: 'review', execOk: false, screen: null, hasWindow: true }))
    expect(noTok.kind === 'deny' && noTok.source).toBe('exec-token')
  })

  it('review sits strictly between trusted-afk (looser) and interactive (tighter)', () => {
    // trusted-afk auto-allows host-exec; review prompts it; interactive prompts it too.
    expect(decideAguiGate(base({ posture: 'trusted-afk' })).kind).toBe('allow')
    expect(decideAguiGate(base({ posture: 'review', hasWindow: true })).kind).toBe('prompt')
    expect(decideAguiGate(base({ posture: 'interactive', hasWindow: true })).kind).toBe('prompt')
  })
})

// ─── AFK no-deadlock (§7 test 4, decide-gate half) ────────────────────────────

describe('decideAguiGate — AFK never deadlocks (interactive + no window ⇒ deny, never prompt)', () => {
  it('interactive + hasWindow:false ⇒ deny no-window (a headless turn can never block on a modal)', () => {
    const v = decideAguiGate(base({ posture: 'interactive', policy: null, hasWindow: false }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })
  it('review + hasWindow:false ⇒ deny no-window (same fail-closed guarantee)', () => {
    const v = decideAguiGate(base({ posture: 'review', policy: null, hasWindow: false }))
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })
})

// ─── write_file vault-escape gating (the "organize my Desktop" capability) ────

describe('decideAguiGate — a write_file that escapes the vault is gated like delete/move', () => {
  const w = (over: Partial<AguiGateInput> = {}): AguiGateInput =>
    base({ toolName: 'write_file', screen: null, ...over })

  it('IN-VAULT write (pathEscapesVault falsy) stays ungated — no regression to note-taking', () => {
    // Even with NO exec token it passes: an in-vault write is fail-open by design.
    const v = decideAguiGate(w({ execOk: false }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('ungated')
    expect(v.tier).toBe('none')
  })

  it('escaping write with NO exec token ⇒ deny at the exec-token floor (an inbound turn cannot write to the Desktop)', () => {
    const v = decideAguiGate(w({ execOk: false, pathEscapesVault: true }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('exec-token')
    expect(v.tier).toBe('irreversible-file')
  })

  it('escaping write under trusted-afk (authorized) ⇒ allow, audited', () => {
    const v = decideAguiGate(w({ posture: 'trusted-afk', pathEscapesVault: true }))
    expect(v.kind).toBe('allow')
    expect(v.kind === 'allow' && v.source).toBe('posture:trusted-afk')
    expect(v.tier).toBe('irreversible-file')
  })

  it('escaping write under interactive with a window ⇒ prompt (the operator approves the Desktop write)', () => {
    const v = decideAguiGate(w({ posture: 'interactive', hasWindow: true, pathEscapesVault: true }))
    expect(v.kind).toBe('prompt')
    expect(v.tier).toBe('irreversible-file')
  })

  it('escaping write under interactive with NO window ⇒ deny no-window (never deadlocks AFK)', () => {
    const v = decideAguiGate(w({ posture: 'interactive', hasWindow: false, pathEscapesVault: true }))
    expect(v.kind === 'deny' && v.source).toBe('no-window')
  })

  it('a persisted DENY on an escaping write wins over the trusted-afk blanket', () => {
    const v = decideAguiGate(w({ posture: 'trusted-afk', pathEscapesVault: true, policy: 'deny' }))
    expect(v.kind).toBe('deny')
    expect(v.kind === 'deny' && v.source).toBe('policy')
  })
})

// Type-level: the exported posture union carries exactly the three modes.
const _postureExhaustive: Record<AguiPosture, true> = { 'trusted-afk': true, review: true, interactive: true }
void _postureExhaustive
