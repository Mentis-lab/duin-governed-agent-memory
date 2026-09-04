import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  withScope,
  getStalls,
  resetStallsForTest,
  startMainStallMonitor,
  instrumentIpcMain,
  instrumentIntervals,
  withPhase,
  currentPhase,
  _resetPhases
} from './main-stall-monitor'

beforeEach(() => resetStallsForTest())

describe('withScope', () => {
  it('records a sync block at or over the 100ms attribution floor', () => {
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValueOnce(1000) // start
    spy.mockReturnValueOnce(1250) // lastAttributedAt stamp
    spy.mockReturnValueOnce(1250) // end
    withScope('test:slow', () => undefined)
    spy.mockRestore()
    const { stalls, totals } = getStalls()
    expect(stalls.length).toBe(1)
    expect(stalls[0].scope).toBe('test:slow')
    expect(stalls[0].ms).toBeGreaterThanOrEqual(100)
    expect(totals['test:slow'].count).toBe(1)
  })

  it('does not record a fast block', () => {
    withScope('test:fast', () => undefined)
    expect(getStalls().stalls.length).toBe(0)
  })

  it('nested scopes record once, attributed to the outermost', () => {
    const spy = vi.spyOn(Date, 'now')
    let t = 0
    spy.mockImplementation(() => {
      t += 60 // every clock read advances 60ms → outer sees ≥100ms total
      return t
    })
    withScope('outer', () => withScope('inner', () => undefined))
    spy.mockRestore()
    const { stalls } = getStalls()
    expect(stalls.length).toBe(1)
    expect(stalls[0].scope).toBe('outer')
  })

  it('propagates the return value and exceptions', () => {
    expect(withScope('t', () => 42)).toBe(42)
    expect(() =>
      withScope('t', () => {
        throw new Error('x')
      })
    ).toThrow('x')
  })
})

describe('heartbeat', () => {
  it('records unattributed lag over the floor and stays quiet under it', () => {
    let t = 0
    const beats: Array<() => void> = []
    const stop = startMainStallMonitor({
      now: () => t,
      schedule: (fn) => {
        beats.push(fn)
      }
    })
    // Normal beat: 250ms elapsed, zero lag.
    t = 250
    beats.shift()?.()
    expect(getStalls().stalls.length).toBe(0)
    // Stalled beat: 800ms elapsed → 550ms lag, nothing attributed → recorded.
    t = 1050
    beats.shift()?.()
    const { stalls } = getStalls()
    expect(stalls.length).toBe(1)
    expect(stalls[0].scope).toBe('unattributed')
    expect(stalls[0].ms).toBeGreaterThanOrEqual(150)
    stop()
  })
})

describe('instrumentIpcMain', () => {
  it('wraps handlers so their sync cost is attributed to the channel', () => {
    const registered = new Map<string, (...a: unknown[]) => unknown>()
    const fake = {
      handle: (channel: string, listener: (...a: never[]) => unknown) => {
        registered.set(channel, listener as (...a: unknown[]) => unknown)
      }
    }
    instrumentIpcMain(fake as unknown as import('electron').IpcMain)
    fake.handle('conv:list', (() => 'ok') as never)
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValueOnce(0).mockReturnValueOnce(200).mockReturnValueOnce(200)
    const out = registered.get('conv:list')?.()
    spy.mockRestore()
    expect(out).toBe('ok')
    const { stalls } = getStalls()
    expect(stalls.length).toBe(1)
    expect(stalls[0].scope).toBe('ipc:conv:list')
  })
})

describe('phase attribution', () => {
  afterEach(() => _resetPhases())

  it('names heartbeat lag with the open phase instead of "unattributed"', () => {
    let clock = 0
    const now = (): number => clock
    const beats: Array<() => void> = []
    const stop = startMainStallMonitor({ now, schedule: (fn) => { beats.push(fn) } })

    // Open a phase, then let the loop stall for 900ms while it is in flight.
    const p = withPhase('agui-turn', async () => {
      clock += 250 + 900
      beats.shift()?.()
      return 'done'
    })

    return p.then((v) => {
      expect(v).toBe('done')
      const named = getStalls().stalls.filter((s) => s.scope === 'phase:agui-turn')
      expect(named.length).toBe(1)
      expect(named[0].ms).toBeGreaterThanOrEqual(900)
      stop()
    })
  })

  it('falls back to "unattributed" when no phase is open', () => {
    let clock = 0
    const beats: Array<() => void> = []
    const stop = startMainStallMonitor({ now: () => clock, schedule: (fn) => { beats.push(fn) } })
    clock += 250 + 900
    beats.shift()?.()
    expect(getStalls().stalls.some((s) => s.scope === 'unattributed')).toBe(true)
    stop()
  })

  it('reports the INNERMOST phase, the most specific answer available', async () => {
    let clock = 0
    const beats: Array<() => void> = []
    const stop = startMainStallMonitor({ now: () => clock, schedule: (fn) => { beats.push(fn) } })

    await withPhase('agui-turn', async () =>
      withPhase('turn:grounding', async () => {
        clock += 250 + 800
        beats.shift()?.()
      })
    )
    expect(getStalls().stalls.some((s) => s.scope === 'phase:turn:grounding')).toBe(true)
    stop()
  })

  it('closes the phase even when the wrapped work throws', async () => {
    await expect(withPhase('boom', async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(currentPhase()).toBeNull()
  })
})

// ── instrumentIntervals ──────────────────────────────────────────────────────────
//
// What this guards: 'unattributed' was 41.4s across 29 samples in four minutes of a
// live session — an order of magnitude past any named scope — and while idle it
// recurred every 40-46s. A fixed idle period is a timer, and there are ~28 setInterval
// sites in main across services owned by different lanes. Naming them at the one wrap
// site is the same trade instrumentIpcMain makes for 381 handlers.
//
// POWER CONTROL: drop the withScope wrap in the patched setInterval and
// "records a slow tick under the timer's call site" fails.
describe('instrumentIntervals', () => {
  it('records a slow tick, named for the call site, not as unattributed', () => {
    const host = { setInterval: ((fn: () => void) => fn) as unknown as typeof setInterval }
    const restore = instrumentIntervals(host)
    // The patched setInterval returns whatever the original did — here, the callback,
    // so the test can invoke one tick synchronously without a real timer.
    const tick = host.setInterval(() => undefined, 1000) as unknown as () => void

    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValueOnce(1000) // scope start
    spy.mockReturnValueOnce(1400) // lastAttributedAt stamp
    spy.mockReturnValueOnce(1400) // scope end
    tick()
    spy.mockRestore()
    restore()

    const { stalls } = getStalls()
    expect(stalls.length).toBe(1)
    expect(stalls[0].scope.startsWith('timer:'), stalls[0].scope).toBe(true)
    expect(stalls[0].scope, 'the name must locate the timer, not just say "a timer"')
      .toMatch(/^timer:.+\.(ts|js):\d+$/)
    expect(stalls[0].ms).toBe(400)
  })

  it('a fast tick costs nothing — the wrap must not become the thing it measures', () => {
    const host = { setInterval: ((fn: () => void) => fn) as unknown as typeof setInterval }
    const restore = instrumentIntervals(host)
    const tick = host.setInterval(() => undefined, 1000) as unknown as () => void
    tick()
    tick()
    restore()
    expect(getStalls().stalls.length).toBe(0)
  })

  it('preserves arguments, `this`, and the original return value', () => {
    const calls: unknown[][] = []
    const host = {
      setInterval: ((fn: unknown, ms?: number, ...args: unknown[]) => {
        calls.push([typeof fn, ms, ...args])
        return { id: 7, fn } as unknown
      }) as unknown as typeof setInterval
    }
    const restore = instrumentIntervals(host)
    const handle = host.setInterval(function (this: unknown, a: number) {
      return [this, a]
    } as never, 250, 'x' as never) as unknown as { id: number; fn: (...a: unknown[]) => unknown }
    restore()

    expect(handle.id, 'the caller still needs the real handle to clear/unref it').toBe(7)
    expect(calls[0]).toEqual(['function', 250, 'x'])
    const self = { tag: 'host' }
    expect(handle.fn.call(self, 42)).toEqual([self, 42])
  })

  it('passes a non-function handler through untouched', () => {
    // setInterval accepts a code string in the DOM signature; wrapping it would throw.
    const seen: unknown[] = []
    const host = {
      setInterval: ((h: unknown) => {
        seen.push(h)
        return 0 as unknown
      }) as unknown as typeof setInterval
    }
    const restore = instrumentIntervals(host)
    host.setInterval('noop()' as never, 10)
    restore()
    expect(seen).toEqual(['noop()'])
  })

  it('restore is a no-op once something else has patched on top', () => {
    const orig = ((fn: () => void) => fn) as unknown as typeof setInterval
    const host = { setInterval: orig }
    const restore = instrumentIntervals(host)
    const later = ((fn: () => void) => fn) as unknown as typeof setInterval
    host.setInterval = later
    restore()
    expect(host.setInterval, 'restoring over a later wrapper would un-instrument it').toBe(later)
  })
})
