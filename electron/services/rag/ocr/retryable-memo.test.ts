import { describe, expect, it } from 'vitest'
import { createRetryableMemo } from './retryable-memo'

describe('createRetryableMemo', () => {
  it('caches a successful load (loader runs once across concurrent + later calls)', async () => {
    let calls = 0
    const memo = createRetryableMemo(async () => {
      calls++
      return calls
    })
    const [a, b] = await Promise.all([memo.get(), memo.get()])
    const c = await memo.get()
    expect(calls).toBe(1)
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(c).toBe(1)
  })

  it('does NOT cache a rejection — a later call re-attempts the load', async () => {
    // This is the paddle-worker bug: the previous `if (loadedP) return loadedP`
    // memo pinned the first rejected promise forever, so one transient ONNX/AV/EBUSY
    // failure disabled OCR for the whole process. A fresh get() must retry.
    let calls = 0
    const memo = createRetryableMemo(async () => {
      calls++
      if (calls === 1) throw new Error('transient load failure')
      return 'loaded'
    })

    await expect(memo.get()).rejects.toThrow('transient load failure')
    // The second call must actually invoke the loader again and succeed.
    await expect(memo.get()).resolves.toBe('loaded')
    expect(calls).toBe(2)
  })

  it('reset() forces the next get() to reload even after a success', async () => {
    let calls = 0
    const memo = createRetryableMemo(async () => {
      calls++
      return calls
    })
    expect(await memo.get()).toBe(1)
    expect(await memo.get()).toBe(1)
    memo.reset()
    expect(await memo.get()).toBe(2)
  })

  it('a stale rejection after reset()+new load does not clobber the fresh slot', async () => {
    // Concurrency guard: dispose (reset) can arrive while a failing load is still
    // pending; when that old load finally rejects it must NOT null out the memo that
    // a newer load has since populated.
    let rejectFirst!: (e: unknown) => void
    let attempt = 0
    const memo = createRetryableMemo<string>(() => {
      attempt++
      if (attempt === 1) {
        return new Promise<string>((_res, rej) => {
          rejectFirst = rej
        })
      }
      return Promise.resolve('second')
    })

    const firstP = memo.get() // starts the never-yet-settled first load
    firstP.catch(() => {}) // avoid an unhandled rejection when we reject it below
    memo.reset() // dispose arrives
    const secondP = memo.get() // a fresh load populates the slot
    await expect(secondP).resolves.toBe('second')

    // Now let the ORIGINAL load reject; it must not wipe the good cached load.
    rejectFirst(new Error('late failure'))
    await Promise.resolve()
    expect(await memo.get()).toBe('second') // still cached, loader not called a 3rd time
    expect(attempt).toBe(2)
  })
})
