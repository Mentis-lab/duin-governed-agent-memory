// Bounded recursion must actually be OFFERED. The per-run least-privilege allow-list is drawn from
// AguiToolName, which has no 'spawn_agent' member, while every resolveSubagentConfig branch returns a
// NON-empty list — so the schema filter in runSubagent stripped SPAWN_AGENT_TOOL on every production
// spawn and SUBAGENT_MAX_DEPTH / allowSpawn / runSpawn were dead code. These tests pin the offered
// tool schemas (the only observable the model ever sees) rather than the filter's internals.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-subagent-spawn-offer-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const chatStreamMock = vi.fn<(...a: unknown[]) => unknown>()
vi.mock('../providers/registry', () => ({ chatStream: (...a: unknown[]) => chatStreamMock(...a) }))

import { runSubagent } from './agui-subagent'
import { resolveSubagentConfig } from './subagent-config'

/** Names of the tool schemas runSubagent handed the model on its first round. */
function offeredToolNames(): string[] {
  const tools = chatStreamMock.mock.calls[0]?.[2] as Array<{ function: { name: string } }>
  return tools.map((t) => t.function.name)
}

describe('runSubagent — spawn_agent survives the per-run allow-list filter', () => {
  beforeEach(() => {
    chatStreamMock.mockReset()
    // One round, no tool calls → the loop exits after a single chatStream call.
    chatStreamMock.mockImplementation((...args: unknown[]) => {
      const cbs = args[3] as { onDone: (c: string, t: unknown[]) => void }
      cbs.onDone('done', [])
      return Promise.resolve()
    })
  })

  it('offers SPAWN_AGENT_TOOL to a depth-0 subagent resolved from a bare {task}', async () => {
    // Exactly what server.ts threads at depth 0: a config resolved from the model's bare spawn args.
    const cfg = resolveSubagentConfig({ task: 'summarize the docs' }, { defaultModelId: 'model-x' })
    expect(cfg.allowedToolNames.length).toBeGreaterThan(0) // the condition that armed the bug
    expect(cfg.allowedToolNames).not.toContain('spawn_agent') // ...and why it stripped

    await runSubagent('summarize the docs', '/vault', 'model-x', undefined, 6, true, cfg, 0)

    expect(offeredToolNames()).toContain('spawn_agent')
  })

  it('still applies the allow-list to every other tool (least-privilege intact)', async () => {
    const cfg = resolveSubagentConfig({ task: 'summarize the docs' }, { defaultModelId: 'model-x' })

    await runSubagent('summarize the docs', '/vault', 'model-x', undefined, 6, true, cfg, 0)

    const offered = offeredToolNames()
    expect(offered).toContain('read_file') // on the derived read-only floor
    expect(offered).not.toContain('delete_file') // off-list mutation tool stays filtered out
  })

  it('does NOT offer spawn_agent at the depth cap', async () => {
    const cfg = resolveSubagentConfig({ task: 'summarize the docs' }, { defaultModelId: 'model-x' })
    // Default DUIN_SUBAGENT_MAX_DEPTH is 2; depth 2 is at the cap, so canSpawn is false.
    await runSubagent('summarize the docs', '/vault', 'model-x', undefined, 6, true, cfg, 2)

    expect(offeredToolNames()).not.toContain('spawn_agent')
  })
})
