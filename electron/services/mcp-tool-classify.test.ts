import { describe, it, expect, vi } from 'vitest'

// tool-registry pulls in electron via the snip import chain; mock it (mirrors tool-registry.test.ts).
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-mcp-classify-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { classifyMcpTool, COMPUTER_USE_SERVER_IDS, CODE_EXEC_SERVER_IDS } = await import('./tool-registry')

describe('classifyMcpTool — computer-use servers are fail-closed', () => {
  it.each(['click', 'type_text', 'press_key', 'run_command', 'drag', 'scroll', 'open_application'])(
    'gates actuation tool %s on a computer-use server (destructive + approval)',
    (name) => {
      const c = classifyMcpTool('terminator', name)
      expect(c.requiresApproval).toBe(true)
      expect(c.mutates).toBe(true)
      expect(c.risks).toContain('destructive')
    }
  )

  it('still treats an explicitly read-only computer-use tool as read-only', () => {
    const c = classifyMcpTool('terminator', 'capture_screen', { readOnlyHint: true })
    expect(c.requiresApproval).toBe(false)
    expect(c.mutates).toBe(false)
    expect(c.risks).toEqual(['network'])
  })

  it('gates a bare read-looking name on a computer-use server when unannotated (fail-closed)', () => {
    // `get_window_tree` has no write verb and no annotation — on a normal server it would be a read,
    // but on a desktop actuator we cannot assume that, so it must gate.
    const c = classifyMcpTool('computer-use', 'get_window_tree')
    expect(c.requiresApproval).toBe(true)
  })

  it('all four catalog ids are registered as computer-use servers', () => {
    for (const id of ['terminator', 'computer-use', 'windows-mcp', 'desktop']) {
      expect(COMPUTER_USE_SERVER_IDS.has(id)).toBe(true)
    }
  })
})

describe('classifyMcpTool — non-computer-use servers keep prior behaviour', () => {
  it('leaves an unannotated read tool ungated on a normal server', () => {
    const c = classifyMcpTool('someapi', 'get_user')
    expect(c.requiresApproval).toBe(false)
    expect(c.risks).toEqual(['network'])
  })

  it('gates a write-verb tool on a normal server', () => {
    const c = classifyMcpTool('someapi', 'delete_user')
    expect(c.requiresApproval).toBe(true)
    expect(c.risks).toContain('destructive')
  })

  it('respects destructiveHint even without a write verb', () => {
    const c = classifyMcpTool('someapi', 'do_thing', { destructiveHint: true })
    expect(c.requiresApproval).toBe(true)
  })

  it('honors readOnlyHint over a write-verb name (annotation wins)', () => {
    const c = classifyMcpTool('someapi', 'send_report', { readOnlyHint: true })
    expect(c.requiresApproval).toBe(false)
  })

  it('now gates actuation/exec verbs on any server (extended heuristic)', () => {
    expect(classifyMcpTool('someapi', 'execute_shell').requiresApproval).toBe(true)
    expect(classifyMcpTool('someapi', 'click_button').requiresApproval).toBe(true)
  })

  it('keeps the Chrome destructive set gated', () => {
    expect(classifyMcpTool('chrome', 'click').requiresApproval).toBe(true)
    expect(classifyMcpTool('chrome', 'snapshot').requiresApproval).toBe(false)
  })
})

describe('classifyMcpTool — code-exec servers are fail-closed', () => {
  // 2026-08-14 estate-audit escalation: the bundled node-repl server ships ENABLED, its
  // tool names (`js`, `js_reset`, `js_add_node_module_dir`) contain no verb the heuristic
  // recognises, and it sent no annotations — so a code-execution tool classified as a
  // harmless network read and auto-ran under the default trusted-afk interactive posture.
  // A code-exec tool's name carries no signal about what the code does; the server id is
  // the signal, so the server is fail-closed exactly like the computer-use executors.
  it.each(['js', 'js_reset', 'js_add_node_module_dir'])(
    'gates unannotated %s on the bundled node-repl server (destructive + approval)',
    (name) => {
      const c = classifyMcpTool('node-repl', name)
      expect(c.requiresApproval).toBe(true)
      expect(c.mutates).toBe(true)
      expect(c.risks).toContain('destructive')
    }
  )

  it('destructiveHint from the server (now self-declared on js) also gates on its own', () => {
    // Belt: even if the fail-closed set ever lost the id, the bundled server's own
    // annotations keep the eval tool gated.
    const c = classifyMcpTool('some-other-repl', 'js', { destructiveHint: true })
    expect(c.requiresApproval).toBe(true)
  })

  it('still honors an explicit readOnlyHint on a code-exec server', () => {
    const c = classifyMcpTool('node-repl', 'list_state', { readOnlyHint: true })
    expect(c.requiresApproval).toBe(false)
    expect(c.risks).toEqual(['network'])
  })

  it('node-repl is registered as a code-exec server', () => {
    expect(CODE_EXEC_SERVER_IDS.has('node-repl')).toBe(true)
  })
})
