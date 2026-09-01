// headless-agent.test.ts — the UNATTENDED ALLOW-LIST contract.
//
// runHeadlessAgent is the autonomy primitive: a model loop with NO human present.
// Its whole safety story is `spec.allowedTools` — the capability allow-list — and
// until this file existed that allow-list had ZERO test coverage. A regression
// there is silent: the run still "works", it just works with more authority than
// the caller granted.
//
// Four contracts are pinned here, driving the REAL runHeadlessAgent + the REAL
// tool-exec / permissions gate, with only the PROVIDER seam stubbed:
//
//   (a) a tool NOT in allowedTools is never OFFERED to the model, and if the model
//       names it anyway it is never EXECUTED (capability-miss).
//   (b) a tool IN the list executes and reports its approvalSource.
//   (c) an EMPTY allowedTools yields ZERO tools — never the full registry. This is
//       the fail-open regression this file primarily exists to guard: `[]` must mean
//       "no tools", not "unset ⇒ everything".
//   (d) a GATING-RISK tool is REFUSED in capability mode rather than silently
//       auto-approved — both at the capability gate (sandbox-bypass) and at the
//       unattended action-class floor (network).
//
// Only `./providers/registry` is mocked (no API keys in CI, and we need to script
// the model's tool_calls). Everything below runHeadlessAgent — toolRegistry,
// executeToolCall, permissionsService capability mode, the action-class CAP floor
// — is the real production code, because that is where the guarantees live.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'

// ──────────────────── provider seam (the ONLY mock) ────────────────────

const seam = vi.hoisted(() => {
  return {
    /** The `tools` argument runHeadlessAgent handed the model, per turn. */
    toolsSeen: [] as (ChatCompletionTool[] | undefined)[],
    /** Scripted model turns, consumed in order. */
    script: [] as Array<{
      content: string
      toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }>
  }
})

vi.mock('./providers/registry', () => ({
  resolveModel: (id: string) => ({ id, supportsTools: true }),
  chatStream: async (
    _messages: unknown,
    _modelId: string,
    tools: ChatCompletionTool[] | undefined,
    cb: {
      onDone: (c: string, tc?: unknown[]) => void | Promise<void>
      onError: (e: string) => void
    }
  ) => {
    seam.toolsSeen.push(tools)
    const turn = seam.script.shift() ?? { content: 'finished', toolCalls: [] }
    await cb.onDone(turn.content, turn.toolCalls)
  }
}))

import { runHeadlessAgent } from './headless-agent'
import { toolRegistry } from './tool-registry'

// ──────────────────── purpose-built tools in the REAL registry ────────────────────
// Distinctive ids so they cannot collide with a bundled tool. Registration is a
// module-scope side effect, exactly like a tool pack.

const ran: Record<string, number> = {}
function countingHandler(id: string, out = 'ok') {
  return async (): Promise<string> => {
    ran[id] = (ran[id] ?? 0) + 1
    return out
  }
}

/** Ungated read tool — the one shape that can actually RUN unattended. */
toolRegistry.registerNative(
  {
    id: 'hl_probe_read',
    name: 'hl_probe_read',
    title: 'hl probe read',
    description: 'Read a probe value (test-only).',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  countingHandler('hl_probe_read', 'probe-value')
)

/** A second ungated read tool, deliberately kept OUT of the allow-list in (a). */
toolRegistry.registerNative(
  {
    id: 'hl_probe_offlist',
    name: 'hl_probe_offlist',
    title: 'hl probe offlist',
    description: 'Read a probe value the run was never granted (test-only).',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risks: ['read'],
    requiresApproval: false,
    enabled: true
  },
  countingHandler('hl_probe_offlist', 'should-never-be-returned')
)

/** GATING RISK: outward network. In the allow-list on purpose — the point is that
 *  membership alone must NOT be enough for an unattended run. */
toolRegistry.registerNative(
  {
    id: 'hl_probe_network',
    name: 'hl_probe_network',
    title: 'hl probe network',
    description: 'Reach an external endpoint (test-only).',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risks: ['network'],
    requiresApproval: false,
    enabled: true
  },
  countingHandler('hl_probe_network')
)

/** GATING RISK: sandbox bypass — permanently ineligible unattended. */
toolRegistry.registerNative(
  {
    id: 'hl_probe_bypass',
    name: 'hl_probe_bypass',
    title: 'hl probe bypass',
    description: 'Run outside the sandbox (test-only).',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    risks: ['sandboxBypass'],
    requiresApproval: false,
    enabled: true
  },
  countingHandler('hl_probe_bypass')
)

function call(name: string, id = `c-${name}`) {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } }
}

function baseSpec(over: Partial<Parameters<typeof runHeadlessAgent>[0]> = {}) {
  return {
    prompt: 'do the thing',
    workspacePath: process.cwd(),
    allowedTools: ['hl_probe_read'],
    model: 'test-model',
    maxTurns: 3,
    ...over
  }
}

/** Names of the tools offered on a given turn (undefined ⇒ none offered at all). */
function offered(turn = 0): string[] | undefined {
  const t = seam.toolsSeen[turn]
  if (!t) return undefined
  return t.map((x) => (x.type === 'function' ? x.function.name : '')).filter(Boolean)
}

beforeEach(() => {
  seam.toolsSeen.length = 0
  seam.script.length = 0
  for (const k of Object.keys(ran)) delete ran[k]
})

// ──────────────────── (a) not in the list → not offered, not executed ────────────────────

describe('(a) a tool outside allowedTools is neither offered nor executed', () => {
  it('is absent from the tool surface handed to the model', async () => {
    seam.script.push({ content: 'done', toolCalls: [] })
    await runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'] }))
    expect(offered(0)).toEqual(['hl_probe_read'])
    expect(offered(0)).not.toContain('hl_probe_offlist')
  })

  it('is DENIED (capability-miss) and its handler never runs even if the model names it anyway', async () => {
    // The model can always hallucinate a name it was never offered. `getById`
    // resolves against the FULL registry, so the allow-list must be re-checked at
    // EXECUTION, not only at offer time.
    seam.script.push({ content: '', toolCalls: [call('hl_probe_offlist')] })
    seam.script.push({ content: 'gave up', toolCalls: [] })

    const r = await runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'] }))

    expect(r.status).toBe('ok')
    expect(r.toolUses).toHaveLength(1)
    expect(r.toolUses[0].name).toBe('hl_probe_offlist')
    expect(r.toolUses[0].status).toBe('denied')
    expect(r.toolUses[0].approvalSource).toBe('capability-miss')
    expect(ran.hl_probe_offlist).toBeUndefined()
  })
})

// ──────────────────── (b) in the list → executes, reports approvalSource ────────────────────

describe('(b) a tool inside allowedTools executes and reports its approvalSource', () => {
  it('runs the real handler and threads the result back into the loop', async () => {
    seam.script.push({ content: '', toolCalls: [call('hl_probe_read')] })
    seam.script.push({ content: 'the answer', toolCalls: [] })

    const r = await runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'] }))

    expect(r.status).toBe('ok')
    expect(r.output).toBe('the answer')
    expect(ran.hl_probe_read).toBe(1)
    expect(r.toolUses).toEqual([
      // 'none' is the CORRECT source here and is load-bearing, not incidental:
      // descriptorNeedsApproval is false for a pure read, so the approval service
      // is never consulted. It also happens to be the ONLY source an executing
      // unattended tool can carry — every path that would report 'capability'
      // (requiresApproval / a gating risk) is refused by the action-class floor
      // in (d). If this ever reads 'capability' with status ok, an unattended run
      // has started executing gated tools.
      { name: 'hl_probe_read', status: 'ok', approvalSource: 'none' }
    ])
  })
})

// ──────────────────── (c) EMPTY list → zero tools, NOT the whole registry ────────────────────

describe('(c) an empty allowedTools yields zero tools, never the full registry', () => {
  it('offers the model no tools at all', async () => {
    // Guard the guard: if the registry were empty this assertion would pass for
    // the wrong reason.
    expect(toolRegistry.getOpenAITools().length).toBeGreaterThan(5)

    seam.script.push({ content: 'nothing to do', toolCalls: [] })
    await runHeadlessAgent(baseSpec({ allowedTools: [] }))

    expect(seam.toolsSeen).toHaveLength(1)
    // FAIL-OPEN GUARD: `[]` must mean "no tools". If the filter is ever changed to
    // fall through to the full catalog when the list is empty (`allow.size ? … : all`),
    // this receives the whole registry and goes red.
    expect(seam.toolsSeen[0]).toBeUndefined()
  })

  it('still denies execution if the model invents a call with no tools offered', async () => {
    seam.script.push({ content: '', toolCalls: [call('hl_probe_read')] })
    seam.script.push({ content: 'stopped', toolCalls: [] })

    const r = await runHeadlessAgent(baseSpec({ allowedTools: [] }))

    expect(r.toolUses[0].status).toBe('denied')
    expect(r.toolUses[0].approvalSource).toBe('capability-miss')
    expect(ran.hl_probe_read).toBeUndefined()
  })
})

// ──────────────────── (d) gating-risk tools are REFUSED, not auto-approved ────────────────────

describe('(d) a gating-risk tool is refused in capability mode, never silently auto-approved', () => {
  it('refuses a NETWORK tool at the unattended action-class floor even though it is granted', async () => {
    seam.script.push({ content: '', toolCalls: [call('hl_probe_network')] })
    seam.script.push({ content: 'refused', toolCalls: [] })

    const r = await runHeadlessAgent(
      baseSpec({ allowedTools: ['hl_probe_read', 'hl_probe_network'] })
    )

    // It IS offered (the caller granted it) — the refusal happens at execution,
    // which is the honest place for it: the model is told why.
    expect(offered(0)).toContain('hl_probe_network')
    expect(r.toolUses[0].status).toBe('denied')
    expect(r.toolUses[0].approvalSource).toBe('action-class:risk:network')
    expect(ran.hl_probe_network).toBeUndefined()
  })

  it('refuses a SANDBOX-BYPASS tool at the capability gate itself', async () => {
    seam.script.push({ content: '', toolCalls: [call('hl_probe_bypass')] })
    seam.script.push({ content: 'refused', toolCalls: [] })

    const r = await runHeadlessAgent(
      baseSpec({ allowedTools: ['hl_probe_read', 'hl_probe_bypass'] })
    )

    expect(r.toolUses[0].status).toBe('denied')
    // Not 'capability' — membership in the allow-list does NOT make a sandbox-bypass
    // tool eligible unattended. Fail-closed by construction.
    expect(r.toolUses[0].approvalSource).toBe('capability-bypass-denied')
    expect(ran.hl_probe_bypass).toBeUndefined()
  })
})

// ──────────────────── (e) budget exhaustion is NOT success ────────────────────
//
// Both budget exits used to return `status: 'ok'`. The tool-call exit at least carried an
// `error` string that callers branching on `status === 'error'` never read; the turn exit
// carried no marker at all and was byte-identical to a clean finish. Downstream, an
// automation that stopped halfway recorded `automation.completed` at severity info, fired
// its success hook, and settled its ledger row as completed — so "ran out of budget" and
// "did the job" were the same observable event.

describe('(e) a run that exhausts its budget reports truncated, not ok', () => {
  it('flags the tool-call budget, and keeps the partial output', () => {
    // The model asks for one tool per turn forever; maxToolCalls is the binding limit.
    for (let i = 0; i < 6; i++) {
      seam.script.push({ content: `step ${i}`, toolCalls: [call('hl_probe_read')] })
    }
    return runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'], maxToolCalls: 2 })).then((r) => {
      expect(r.status).toBe('truncated')
      expect(r.stopReason).toBe('max-tool-calls')
      expect(r.toolUses).toHaveLength(2)
      // The partial answer still comes back — truncated is not empty, it is unfinished.
      expect(r.output).toContain('step')
      expect(r.error).toMatch(/not finished/i)
    })
  })

  it('flags the turn budget — the case that previously carried NO marker whatsoever', () => {
    for (let i = 0; i < 6; i++) {
      seam.script.push({ content: `turn ${i}`, toolCalls: [call('hl_probe_read')] })
    }
    return runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'], maxTurns: 2 })).then((r) => {
      expect(r.status).toBe('truncated')
      expect(r.stopReason).toBe('max-turns')
      expect(r.turns).toBe(2)
      expect(r.error).toMatch(/not finished/i)
    })
  })

  it('still reports ok when the model chooses to stop inside its budget', () => {
    seam.script.push({ content: '', toolCalls: [call('hl_probe_read')] })
    seam.script.push({ content: 'all done', toolCalls: [] })
    return runHeadlessAgent(baseSpec({ allowedTools: ['hl_probe_read'], maxTurns: 8, maxToolCalls: 8 })).then((r) => {
      expect(r.status).toBe('ok')
      expect(r.stopReason).toBeUndefined()
      expect(r.output).toBe('all done')
    })
  })
})
