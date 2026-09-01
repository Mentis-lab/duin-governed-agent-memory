import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  raceToolCallTimeout,
  toolTimeoutMs,
  toolWallClockBudgetMs,
  ToolTimeoutError,
  ToolAbortError
} from './tool-timeout'

// R4 (Phase-4) — per-tool wall-clock timeout + abort at the native seam.
// These are pure unit tests off the chat IPC path: the race primitive must
// ALWAYS settle (success, timeout, or abort) and never leak an unhandled
// rejection when the losing handler settles late.

afterEach(() => {
  delete process.env.DUIN_TOOL_TIMEOUT_MS
  vi.useRealTimers()
})

describe('toolTimeoutMs — env parsing', () => {
  it('defaults to 60000 when unset', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    expect(toolTimeoutMs()).toBe(60_000)
  })
  it('honors a finite override', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '5000'
    expect(toolTimeoutMs()).toBe(5000)
  })
  it('falls back to default on empty / non-numeric', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = ''
    expect(toolTimeoutMs()).toBe(60_000)
    process.env.DUIN_TOOL_TIMEOUT_MS = 'nope'
    expect(toolTimeoutMs()).toBe(60_000)
  })
  it('allows 0 to disable (returned verbatim)', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '0'
    expect(toolTimeoutMs()).toBe(0)
  })
})

describe('toolWallClockBudgetMs — shell_command budget vs the generic backstop', () => {
  // The shell descriptor advertises the model a 120s default / 600s ceiling;
  // shell-tool keeps the child alive that long. The generic race default is 60s.
  // These constants mirror shell-tool's DEFAULT_TIMEOUT_MS / MAX_TIMEOUT_MS.
  const shell = { defaultMs: 120_000, maxMs: 600_000 }

  it('returns undefined for non-shell tools (they keep the generic default)', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    expect(toolWallClockBudgetMs('read_file', {}, shell)).toBeUndefined()
    expect(toolWallClockBudgetMs('web_fetch', { timeout_ms: 300_000 }, shell)).toBeUndefined()
  })

  it('lifts the backstop above the shell 120s default so a plain command is not clipped at 60s', () => {
    // The core regression: with the flat 60s default the outer race fired at 60s
    // and killed npm install / builds the model was told had 120s.
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    const budget = toolWallClockBudgetMs('shell_command', {}, shell)
    expect(budget).toBeDefined()
    expect(budget!).toBeGreaterThan(120_000) // strictly above the tool's own timeout
    expect(budget!).toBeGreaterThan(60_000) // and above the generic 60s that clipped it
  })

  it('honors an explicit timeout_ms above the default (a 5-minute job survives)', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    const budget = toolWallClockBudgetMs('shell_command', { timeout_ms: 300_000 }, shell)
    expect(budget!).toBeGreaterThan(300_000)
  })

  it('clamps to the ceiling: never grants more head-room off a timeout_ms above 600s', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    const atCeiling = toolWallClockBudgetMs('shell_command', { timeout_ms: 600_000 }, shell)
    const overCeiling = toolWallClockBudgetMs('shell_command', { timeout_ms: 999_999_999 }, shell)
    expect(overCeiling).toBe(atCeiling)
  })

  it('falls back to the default budget on a non-finite timeout_ms', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    const budget = toolWallClockBudgetMs('shell_command', { timeout_ms: 'nope' as unknown }, shell)
    const dflt = toolWallClockBudgetMs('shell_command', {}, shell)
    expect(budget).toBe(dflt)
  })

  it('does not override when the operator raised the generic default above the shell budget', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = String(900_000) // 15 min, already covers 600s+grace
    expect(toolWallClockBudgetMs('shell_command', { timeout_ms: 600_000 }, shell)).toBeUndefined()
  })

  it('leaves the backstop disabled when the operator set it to 0', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '0'
    expect(toolWallClockBudgetMs('shell_command', {}, shell)).toBeUndefined()
  })
})

describe('raceToolCallTimeout', () => {
  it('resolves with the handler value when it settles in time', async () => {
    const out = await raceToolCallTimeout(async () => 'ok', { timeoutMs: 1000 })
    expect(out).toBe('ok')
  })

  it('rejects with ToolTimeoutError when the handler exceeds the deadline', async () => {
    const p = raceToolCallTimeout(
      () => new Promise<string>(() => {}), // never settles
      { timeoutMs: 20, toolName: 'slow_tool' }
    )
    await expect(p).rejects.toBeInstanceOf(ToolTimeoutError)
    await p.catch((e: ToolTimeoutError) => {
      expect(e.toolName).toBe('slow_tool')
      expect(e.timeoutMs).toBe(20)
    })
  })

  it('rejects with ToolAbortError when the signal aborts mid-flight', async () => {
    const ctrl = new AbortController()
    const p = raceToolCallTimeout(() => new Promise<string>(() => {}), {
      signal: ctrl.signal,
      timeoutMs: 10_000,
      toolName: 'hung_tool'
    })
    setTimeout(() => ctrl.abort(), 10)
    await expect(p).rejects.toBeInstanceOf(ToolAbortError)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const p = raceToolCallTimeout(async () => 'ok', {
      signal: ctrl.signal,
      toolName: 'x'
    })
    await expect(p).rejects.toBeInstanceOf(ToolAbortError)
  })

  // Gate finding F5 — the race discarded the RESULT of an aborted call but not
  // its SIDE EFFECT. It rejected with ToolAbortError and invoked the handler
  // anyway, so a queued push_notification / spawn_task / schedule_wakeup /
  // loop_enqueue still fired after the user pressed Stop. Approval-gated tools
  // are auto-denied on abort and were safe; the ~20 mutating-but-ungated tools
  // were not.
  it('does NOT invoke the handler when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    let invoked = 0
    const p = raceToolCallTimeout(
      async () => {
        invoked++
        return 'side effect happened'
      },
      { signal: ctrl.signal, toolName: 'push_notification' }
    )
    await expect(p).rejects.toBeInstanceOf(ToolAbortError)
    // Let any stray microtask/macrotask the old code would have scheduled run.
    await new Promise((r) => setTimeout(r, 10))
    expect(invoked, 'an aborted tool call must not run its handler at all').toBe(0)
  })

  it('does not invoke a SYNCHRONOUSLY-effectful handler when already aborted', async () => {
    // The old code kicked the handler off via Promise.resolve().then(handler),
    // so even a handler that mutates before its first await still ran.
    const ctrl = new AbortController()
    ctrl.abort()
    const fired: string[] = []
    const p = raceToolCallTimeout(
      () => {
        fired.push('spawn_task')
        return Promise.resolve('spawned')
      },
      { signal: ctrl.signal, toolName: 'spawn_task' }
    )
    await expect(p).rejects.toBeInstanceOf(ToolAbortError)
    await new Promise((r) => setTimeout(r, 10))
    expect(fired).toEqual([])
  })

  it('still runs the handler when the signal exists but has not aborted', async () => {
    // Guard the other direction: the fix must not turn every signalled call
    // into a no-op.
    const ctrl = new AbortController()
    let invoked = 0
    const out = await raceToolCallTimeout(
      async () => {
        invoked++
        return 'ok'
      },
      { signal: ctrl.signal, timeoutMs: 1000, toolName: 'read_file' }
    )
    expect(out).toBe('ok')
    expect(invoked).toBe(1)
  })

  it('leaves the timeout path untouched: a hung handler still runs and still times out', async () => {
    // The timeout semantics are separate from abort — a handler that is started
    // and then exceeds the deadline must still be started, still time out, and
    // still have its late settle swallowed.
    const ctrl = new AbortController()
    let invoked = 0
    const p = raceToolCallTimeout(
      () => {
        invoked++
        return new Promise<string>(() => {})
      },
      { signal: ctrl.signal, timeoutMs: 20, toolName: 'slow_tool' }
    )
    await expect(p).rejects.toBeInstanceOf(ToolTimeoutError)
    expect(invoked).toBe(1)
  })

  it('timeoutMs<=0 disables the wall-clock timeout (still honors abort)', async () => {
    // No timeout, no abort → resolves whenever the handler does.
    const out = await raceToolCallTimeout(
      () => new Promise<string>((res) => setTimeout(() => res('late'), 15)),
      { timeoutMs: 0 }
    )
    expect(out).toBe('late')
  })

  it('a late handler rejection after a timeout does not escape as unhandled', async () => {
    // The handler rejects AFTER we've already settled via timeout. If the race
    // did not swallow the loser, this would surface as an unhandled rejection.
    let rejectLater: (e: Error) => void = () => {}
    const p = raceToolCallTimeout(
      () => new Promise<string>((_res, rej) => { rejectLater = rej }),
      { timeoutMs: 10, toolName: 'leaky' }
    )
    await expect(p).rejects.toBeInstanceOf(ToolTimeoutError)
    // Now reject the underlying handler; must be swallowed silently.
    rejectLater(new Error('too late'))
    await new Promise((r) => setTimeout(r, 5))
    // No assertion needed beyond "test process didn't crash"; the swallow is
    // the contract. A trivial assert keeps the case explicit.
    expect(true).toBe(true)
  })

  it('propagates a normal handler rejection as-is (wrapped Error)', async () => {
    const p = raceToolCallTimeout(async () => {
      throw new Error('boom')
    }, { timeoutMs: 1000 })
    await expect(p).rejects.toThrow('boom')
  })
})

// ── backlog finding 37 ──────────────────────────────────────────────────────

describe('toolWallClockBudgetMs — wait_tasks bounds its own wait', () => {
  const shell = { defaultMs: 120_000, maxMs: 600_000 }

  it('lifts the backstop above the generic default for a long wait', () => {
    // wait_tasks advertises up to 300s in its own schema and clamps to it, but got the
    // generic 60s backstop — so a legitimately-still-waiting call (nothing hung, just a
    // long real wait the model asked for) died at 60s with a generic timeout message
    // pointing at the wrong thing.
    const b = toolWallClockBudgetMs('wait_tasks', { timeoutMs: 300_000 }, shell)
    expect(b).toBeDefined()
    expect(b!).toBeGreaterThan(300_000)
  })

  it('clamps to the same 300s ceiling task-query enforces, not whatever was asked', () => {
    const b = toolWallClockBudgetMs('wait_tasks', { timeoutMs: 9_000_000 }, shell)
    expect(b!).toBeLessThan(400_000)
  })

  it('uses the 30s default when no timeout is given, which needs no override', () => {
    // 30s + grace is under the generic backstop, so there is nothing to lift.
    expect(toolWallClockBudgetMs('wait_tasks', {}, shell)).toBeUndefined()
  })

  it('leaves every other tool on the generic backstop', () => {
    expect(toolWallClockBudgetMs('read_file', { timeoutMs: 300_000 }, shell)).toBeUndefined()
  })
})
