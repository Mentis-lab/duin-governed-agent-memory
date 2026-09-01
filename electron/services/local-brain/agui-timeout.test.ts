import { describe, it, expect, vi, afterEach } from 'vitest'
import { withToolTimeout, toolTimeoutMs, toolTimeoutMessage } from './agui-timeout'

// The dispatcher-level wall-clock backstop. Before this, only run_command (30s) and web_fetch
// (15s) bounded themselves; every other simple tool was a bare `await` that could hang a turn
// forever. The subtlety worth pinning is the throw/expiry distinction: withToolTimeout treats a
// REJECTION as an expiry, so the dispatcher settles the tool's promise into a tagged shape first.
// If that ever regresses, a genuine tool error would be relabelled "timed out" and the model would
// be told to stop retrying something that actually failed for a fixable reason.

const ORIGINAL = process.env.DUIN_TOOL_TIMEOUT_MS
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DUIN_TOOL_TIMEOUT_MS
  else process.env.DUIN_TOOL_TIMEOUT_MS = ORIGINAL
})

type Settled = { kind: 'ok'; value: unknown } | { kind: 'threw'; error: unknown } | { kind: 'expired' }

/** The exact pattern agui-dispatch uses around spec.execute(). */
function race(work: Promise<unknown>, ms: number, signal?: AbortSignal): Promise<Settled> {
  return withToolTimeout<Settled>(
    work.then(
      (value): Settled => ({ kind: 'ok', value }),
      (error): Settled => ({ kind: 'threw', error })
    ),
    ms,
    signal,
    (): Settled => ({ kind: 'expired' })
  )
}

describe('toolTimeoutMs — env budget', () => {
  it('defaults to 60s', () => {
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    expect(toolTimeoutMs()).toBe(60_000)
  })
  it('honors an explicit override', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '1500'
    expect(toolTimeoutMs()).toBe(1500)
  })
  it('treats 0 as "disabled" rather than "expire immediately"', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '0'
    expect(toolTimeoutMs()).toBe(0)
  })
  it('falls back to the default on garbage', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = 'soon'
    expect(toolTimeoutMs()).toBe(60_000)
  })
})

describe('withToolTimeout — the dispatcher race', () => {
  it('abandons a tool that never settles', async () => {
    vi.useFakeTimers()
    try {
      const hung = new Promise<unknown>(() => {}) // never resolves
      const p = race(hung, 1000)
      await vi.advanceTimersByTimeAsync(1001)
      expect(await p).toEqual({ kind: 'expired' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes a fast success straight through', async () => {
    expect(await race(Promise.resolve('done'), 5000)).toEqual({ kind: 'ok', value: 'done' })
  })

  // The regression that matters: a real throw must stay a throw.
  it('reports a genuine rejection as threw, NOT as expired', async () => {
    const boom = new Error('ENOENT: no such file')
    const r = await race(Promise.reject(boom), 5000)
    expect(r.kind).toBe('threw')
    expect((r as { error: unknown }).error).toBe(boom)
  })

  it('an already-aborted signal expires without waiting', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await race(new Promise<unknown>(() => {}), 60_000, ac.signal)).toEqual({ kind: 'expired' })
  })

  it('a timeout of 0 disables the timer (a slow tool still completes)', async () => {
    vi.useFakeTimers()
    try {
      const slow = new Promise<unknown>((res) => setTimeout(() => res('eventually'), 5000))
      const p = race(slow, 0)
      await vi.advanceTimersByTimeAsync(5001)
      expect(await p).toEqual({ kind: 'ok', value: 'eventually' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('toolTimeoutMessage', () => {
  it('is shaped like a tool error so the loop classifies it as a failure', () => {
    // server.ts gates markProgress() on !/^Error:/ — an expiry must NOT read as forward progress,
    // or the stall watchdog goes back to being unable to fire on a wedged tool.
    const msg = toolTimeoutMessage('write_file', 60_000)
    expect(msg).toMatch(/^Error:/)
    expect(msg).toContain('write_file')
    expect(msg).toContain('60s')
  })
})
