import { describe, it, expect, vi, beforeEach } from 'vitest'

// A fired scheduled wake-up dispatches a real, billable, tool-capable agent turn
// (chat.ts wires the turn runner to runHeadlessTurn({ unattended: true })), so it
// MUST honour the backgroundAutonomy kill switch exactly like every sibling
// scheduler does. This suite pins that gate.
//
// Deliberately mocked all the way down — no sqlite. fireDueWakeups is otherwise
// only reachable through the native DB, and a describe.skipIf(!HAS_NATIVE_SQLITE)
// guard would let this safety assertion VANISH rather than fail on an ABI
// mismatch. A silent skip is not a pass, least of all for a kill switch.

let settings: Record<string, unknown> = {}
const turnRunner = vi.fn(
  async (_input: { conversationId: string; model: string; promptBody?: string }) => undefined
)
const saveMessage = vi.fn((m: Record<string, unknown>) => m)

/** Rows the fake SELECT hands back; UPDATEs are recorded, not applied. */
let pendingRows: Record<string, unknown>[] = []
const updates: { sql: string; args: unknown[] }[] = []

const fakeDb = {
  prepare: (sql: string) => ({
    all: (..._a: unknown[]) => (/^SELECT/i.test(sql.trim()) ? pendingRows : []),
    run: (...args: unknown[]) => {
      updates.push({ sql, args })
      return { changes: 1 }
    }
  })
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test-irrelevant' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./database', () => ({ getDb: () => fakeDb }))
vi.mock('./conversation-store', () => ({
  saveMessage: (m: Record<string, unknown>) => saveMessage(m),
  getConversation: (id: string) => ({ id, model: 'deepseek-chat' })
}))
vi.mock('./settings-helper', () => ({ readSettings: () => settings }))
vi.mock('./event-log', () => ({
  boundedJsonPreview: (v: unknown) => v,
  recordEvent: () => undefined
}))

import { fireDueWakeups, setLoopTurnRunner } from './loop-runner'

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w1',
    conversation_id: 'c1',
    fire_at: 0,
    prompt: 'Check whether the build finished.',
    reason: 'build check',
    status: 'pending',
    created_at: 0,
    fired_at: null,
    error: null,
    ...over
  }
}

beforeEach(() => {
  turnRunner.mockClear()
  saveMessage.mockClear()
  updates.length = 0
  pendingRows = [row()]
  settings = {}
  setLoopTurnRunner(turnRunner)
})

describe('fireDueWakeups — backgroundAutonomy kill switch', () => {
  it('runs NO agent turn when autonomy is OFF, even with a due wake-up', () => {
    settings = { backgroundAutonomy: false }
    const fired = fireDueWakeups(1000)
    expect(fired.map((w) => w.id)).toEqual(['w1'])
    expect(turnRunner).not.toHaveBeenCalled()
  })

  it('treats a missing backgroundAutonomy key as OFF (default-safe)', () => {
    settings = {} // shipped default: the key is absent
    fireDueWakeups(1000)
    expect(turnRunner).not.toHaveBeenCalled()
  })

  it('still injects the user message and consumes the row when autonomy is OFF', () => {
    // The operator must SEE the wake-up and be able to answer it by hand, and
    // the row must not linger pending — otherwise re-enabling autonomy later
    // would stampede a backlog of stale wake-ups all at once.
    settings = { backgroundAutonomy: false }
    fireDueWakeups(1000)
    expect(saveMessage).toHaveBeenCalledTimes(1)
    expect(saveMessage.mock.calls[0][0].role).toBe('user')
    expect(String(saveMessage.mock.calls[0][0].content)).toContain('[scheduled wake-up] build check')
    expect(updates.some((u) => /status = 'fired'/.test(u.sql))).toBe(true)
  })

  it('DOES run the turn when autonomy is ON (the gate is not a blanket disable)', () => {
    settings = { backgroundAutonomy: true }
    fireDueWakeups(1000)
    expect(turnRunner).toHaveBeenCalledTimes(1)
    expect(turnRunner.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      model: 'deepseek-chat',
      promptBody: 'Check whether the build finished.'
    })
  })
})
