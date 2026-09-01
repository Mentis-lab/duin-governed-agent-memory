import { describe, it, expect, beforeEach, vi } from 'vitest'

// `request_permissions` is the one native tool that fans a SINGLE approval out
// into per-RISK policies, which makes it the one place where the duration the
// user picked in the modal ("Just this once" vs "This conversation" vs
// "Always") has to survive the trip back from the permissions service.
//
// Regression under test: the executor previously called `requestApproval`,
// which returns a bare ApprovalDecision, and then wrote sticky risk policies
// whenever the decision was 'allow'. A user who answered "Just this once"
// therefore silently granted the whole risk class — including 'network', a
// GATING_RISK — for the rest of the conversation.

const setRiskPolicy = vi.fn()
const requestApprovalDetailed = vi.fn()

vi.mock('./permissions-store', () => ({
  permissionsService: {
    requestApprovalDetailed: (...args: unknown[]) => requestApprovalDetailed(...args),
    // Mirrors the real decision-only wrapper (permissions-store.ts) exactly, so
    // the pre-fix code path runs to completion and these tests fail on the
    // ASSERTION — the sticky policy that should not exist — rather than on a
    // missing mock method.
    requestApproval: async (...args: unknown[]) =>
      (await requestApprovalDetailed(...args)).decision,
    setRiskPolicy: (...args: unknown[]) => setRiskPolicy(...args)
  }
}))

const { executeRequestPermissions } = await import('./native-aux-tools')

const CTX = { conversationId: 'conv-1' }
const ARGS = { scope: 'shell' as const, reason: 'run one build' }

beforeEach(() => {
  setRiskPolicy.mockReset()
  requestApprovalDetailed.mockReset()
})

describe('executeRequestPermissions — answered scope governs risk-policy fan-out', () => {
  it('writes NO risk policy when the user answered "Just this once"', async () => {
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'modal',
      scope: 'once'
    })

    const out = await executeRequestPermissions(ARGS, CTX)

    // The single call is still approved…
    expect(out).toBe('Approved (scope=shell)')
    // …but nothing becomes sticky. Before the fix this wrote 'write' AND
    // 'network' allow policies for the whole conversation.
    expect(setRiskPolicy).not.toHaveBeenCalled()
  })

  it('writes conversation-scoped risk policies when the user answered "This conversation"', async () => {
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'policy:p1',
      scope: 'conversation'
    })

    await executeRequestPermissions(ARGS, CTX)

    expect(setRiskPolicy.mock.calls).toEqual([
      ['write', 'conversation', 'allow', 'conv-1'],
      ['network', 'conversation', 'allow', 'conv-1']
    ])
  })

  it('writes global risk policies only when the user answered "Always"', async () => {
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'policy:p2',
      scope: 'always'
    })

    await executeRequestPermissions(ARGS, CTX)

    expect(setRiskPolicy.mock.calls).toEqual([
      ['write', 'always', 'allow', 'conv-1'],
      ['network', 'always', 'allow', 'conv-1']
    ])
  })

  it('never widens "This workspace" into a global grant', async () => {
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'policy:p3',
      scope: 'workspace'
    })

    await executeRequestPermissions(ARGS, CTX)

    // setRiskPolicy has no workspace tier; narrowing to 'conversation' is the
    // safe direction. Nothing may land at 'always'.
    for (const call of setRiskPolicy.mock.calls) expect(call[1]).toBe('conversation')
  })

  it('still writes nothing when the user denied', async () => {
    requestApprovalDetailed.mockResolvedValue({
      decision: 'deny',
      source: 'modal',
      scope: 'always'
    })

    const out = await executeRequestPermissions(ARGS, CTX)

    expect(out).toBe('Denied (scope=shell)')
    expect(setRiskPolicy).not.toHaveBeenCalled()
  })

  it('rejects the removed path-scoped scopes instead of granting the whole risk class', async () => {
    // Regression: `write_path`/`read_path` were offered by the schema with a
    // `path` argument, but the policy engine has no path predicate — a grant
    // persisted setRiskPolicy('write', …), identical to `write_workspace`,
    // auto-approving apply_patch/move_file/delete_file across the whole
    // workspace. Approving a path-narrow-LOOKING request silently granted the
    // broad class. The scope was dropped; the executor must now REJECT it
    // rather than fan it out. If this ever passes with setRiskPolicy called,
    // the false affordance is back.
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'modal',
      scope: 'conversation'
    })

    await expect(
      executeRequestPermissions(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { scope: 'write_path', reason: 'write .env.example', path: 'C:\\work\\proj\\.env.example' } as any,
        CTX
      )
    ).rejects.toThrow(/scope must be one of/)

    // Nothing sticky was persisted — no whole-'write'-class grant leaked out.
    expect(setRiskPolicy).not.toHaveBeenCalled()
    // And the approval modal was never even reached: validation fails first.
    expect(requestApprovalDetailed).not.toHaveBeenCalled()
  })

  // ── privilege escalation via the no-human fan-out ────────────────────────
  //
  // This case previously asserted the OPPOSITE ("preserves the pre-existing
  // fan-out when no human answered"), i.e. that a policy-resolved allow still
  // wrote the whole SCOPE_RISKS set. That expectation was itself the defect,
  // not a guard being relaxed here: the assertion below is strictly stronger
  // (no policy at all, where the old one demanded two), and the escalation
  // test that follows it could not pass while the old expectation held.
  it('writes NO risk policy when no human answered (persisted policy / capability)', async () => {
    // No `scope` field — the approval resolved from a persisted policy or a
    // headless capability allow-list, so no human expressed a duration and
    // this executor must not invent one for the risks it did not resolve on.
    requestApprovalDetailed.mockResolvedValue({ decision: 'allow', source: 'policy:existing' })

    await executeRequestPermissions(ARGS, CTX)

    expect(setRiskPolicy).not.toHaveBeenCalled()
  })

  it('does not turn a policy-resolved "network" allow into a "destructive" grant', async () => {
    // The full escalation, in the two calls the model actually makes.
    //
    // Call 1: the human genuinely answers scope='network' with Allow+Always.
    requestApprovalDetailed.mockResolvedValue({
      decision: 'allow',
      source: 'policy:net',
      scope: 'always'
    })
    await executeRequestPermissions({ scope: 'network', reason: 'fetch docs' }, CTX)
    expect(setRiskPolicy.mock.calls).toEqual([['network', 'always', 'allow', 'conv-1']])

    // Call 2: the model asks for scope='browser_destructive' (risks
    // ['destructive','network']). The global 'network' allow written by call 1
    // matches at level 6 — resolveDecisionFromPolicies matches a risk policy
    // when ANY call risk matches — so requestApprovalDetailed short-circuits
    // with NO modal and NO `scope`. The user sees nothing.
    setRiskPolicy.mockReset()
    requestApprovalDetailed.mockResolvedValue({ decision: 'allow', source: 'policy:net' })

    const out = await executeRequestPermissions(
      { scope: 'browser_destructive', reason: 'clear the page' },
      CTX
    )

    // The single call still rides the existing network grant…
    expect(out).toBe('Approved (scope=browser_destructive)')
    // …but 'destructive' — a GATING_RISK the user never approved — must not
    // become policy. Before the fix this wrote BOTH risks, auto-approving every
    // destructive tool (delete_file, send_email) for the rest of the
    // conversation with no human ever seeing a prompt.
    expect(setRiskPolicy).not.toHaveBeenCalled()
  })

  it('never persists a GLOBAL grant for a non-human resolution with no conversation id', async () => {
    // Worst variant: a background/headless run has no conversationId, so the
    // old `outcome.scope === undefined && !ctx.conversationId` branch selected
    // 'always' — a policy-resolved allow wrote GLOBAL allows for the whole risk
    // set, escaping the run entirely and outliving it on disk.
    requestApprovalDetailed.mockResolvedValue({ decision: 'allow', source: 'capability' })

    await executeRequestPermissions({ scope: 'destructive_fs', reason: 'tidy up' }, {})

    expect(setRiskPolicy).not.toHaveBeenCalled()
  })
})
