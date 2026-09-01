// Proves the FLUSH behaviour VisualHtmlEditor's teardown and ArtifactPanel's
// save/download/copy now depend on. The bug this guards: the old cleanup did
// `clearTimeout(timer)` only — an armed export was DROPPED, so the last <400ms
// of visual edits never reached the shared source. `flush()` must instead fire
// the pending produce()+emit() immediately and hand back the value.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDebouncedExport } from './debounced-export'

describe('createDebouncedExport', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not emit until the delay elapses, then emits the produced value', () => {
    const emit = vi.fn()
    let doc = 'a'
    const ctrl = createDebouncedExport(() => doc, emit, 400)

    ctrl.schedule()
    expect(emit).not.toHaveBeenCalled()
    expect(ctrl.isPending()).toBe(true)

    doc = 'a-edited'
    vi.advanceTimersByTime(400)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('a-edited')
    expect(ctrl.isPending()).toBe(false)
  })

  it('flush() fires the armed export immediately and returns the value', () => {
    // This is the regression: before the fix, teardown/read paths would have
    // simply cancelled here and lost `latest`.
    const emit = vi.fn()
    let doc = 'stale'
    const ctrl = createDebouncedExport(() => doc, emit, 400)

    ctrl.schedule()
    doc = 'latest' // edit lands inside the debounce window
    const flushed = ctrl.flush()

    expect(flushed).toBe('latest')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('latest')
    expect(ctrl.isPending()).toBe(false)

    // The trailing timer must not also fire — flush consumed it.
    vi.advanceTimersByTime(400)
    expect(emit).toHaveBeenCalledTimes(1)
  })

  it('flush() with nothing armed is a no-op that returns null', () => {
    const emit = vi.fn()
    const ctrl = createDebouncedExport(() => 'x', emit, 400)

    expect(ctrl.flush()).toBeNull()
    expect(emit).not.toHaveBeenCalled()
  })

  it('cancel() drops the armed export without emitting', () => {
    const emit = vi.fn()
    const ctrl = createDebouncedExport(() => 'x', emit, 400)

    ctrl.schedule()
    ctrl.cancel()
    expect(ctrl.isPending()).toBe(false)
    vi.advanceTimersByTime(400)
    expect(emit).not.toHaveBeenCalled()
  })

  it('re-scheduling coalesces to a single trailing emit', () => {
    const emit = vi.fn()
    let doc = '1'
    const ctrl = createDebouncedExport(() => doc, emit, 400)

    ctrl.schedule()
    vi.advanceTimersByTime(200)
    doc = '2'
    ctrl.schedule() // resets the window
    vi.advanceTimersByTime(399)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('2')
  })
})
