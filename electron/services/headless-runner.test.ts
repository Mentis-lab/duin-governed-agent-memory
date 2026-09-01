import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./automations-runner', () => ({ runAutomation: vi.fn() }))
vi.mock('./automations-store', () => ({ getAutomation: vi.fn() }))
vi.mock('./chat-history', () => ({ buildApiMessagesFromStoredMessages: vi.fn() }))
vi.mock('./conversation-store', () => ({
  getConversation: vi.fn(),
  getMessages: vi.fn(),
  saveMessage: vi.fn()
}))
vi.mock('./memory-store', () => ({
  buildMemoryBlock: vi.fn(() => ''),
  buildMemoryIndexBlock: vi.fn(() => '')
}))
vi.mock('./providers/registry', () => ({ chatOnce: vi.fn() }))
vi.mock('./system-prompt-builder', () => ({ buildSystemPrompt: vi.fn(() => '') }))

import {
  formatHeadlessResult,
  isHeadlessCliArgv,
  parseHeadlessArgs,
  runHeadless
} from './headless-runner'
import { runAutomation } from './automations-runner'
import { getAutomation } from './automations-store'

describe('G3 headless CLI parsing', () => {
  it('parses conversation runs with JSON output', () => {
    expect(parseHeadlessArgs(['electron', '.', '--lamprey-headless', 'run', '--conv', 'c1', '--json'])).toEqual({
      conversationId: 'c1',
      json: true
    })
  })

  it('parses automation runs', () => {
    expect(parseHeadlessArgs(['run', '--automation=a1'])).toEqual({
      automationId: 'a1',
      json: false
    })
  })

  it('detects headless argv', () => {
    expect(isHeadlessCliArgv(['electron', '.', '--duin-headless'])).toBe(true)
    // pre-rename spelling stays accepted (existing aliases / scheduled tasks)
    expect(isHeadlessCliArgv(['electron', '.', '--lamprey-headless'])).toBe(true)
    expect(isHeadlessCliArgv(['lamprey', 'run'])).toBe(true)
    expect(isHeadlessCliArgv(['electron', '.'])).toBe(false)
  })

  it('formats structured errors as JSON when requested', () => {
    expect(formatHeadlessResult({ success: false, error: 'missing' }, true)).toContain('"success": false')
  })
})

describe('headless automation runs surface failure', () => {
  const mockRunAutomation = vi.mocked(runAutomation)
  const mockGetAutomation = vi.mocked(getAutomation)

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAutomation.mockReturnValue({ id: 'a1', label: 'Nightly' } as never)
  })

  it('reports success when the run completes', async () => {
    mockRunAutomation.mockResolvedValue({ status: 'ok' })
    const result = await runHeadless({ automationId: 'a1', json: false })
    expect(result.success).toBe(true)
    expect(formatHeadlessResult(result, false)).toContain('Status: success')
  })

  // The regression: runHeadlessAgent RETURNS an error instead of throwing, so nothing
  // propagated and the CLI printed 'Status: success' and exited 0 on a failed job.
  it('reports failure when the run errored', async () => {
    mockRunAutomation.mockResolvedValue({ status: 'error', error: 'model outage' })
    const result = await runHeadless({ automationId: 'a1', json: false })
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).toContain('model outage')
    expect(formatHeadlessResult(result, false)).not.toContain('Status: success')
  })

  it('reports failure when the run aborted', async () => {
    mockRunAutomation.mockResolvedValue({ status: 'aborted', error: 'timeout' })
    const result = await runHeadless({ automationId: 'a1', json: false })
    expect(result.success).toBe(false)
    expect(result.success === false && result.error).toContain('timeout')
  })
})
