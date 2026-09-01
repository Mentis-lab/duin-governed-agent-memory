import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLocalBrainStoreForTest,
  __setReindexRunnerForTest,
  reindex,
  reindexUntilReady
} from './index-store'

interface Deferred {
  promise: Promise<number>
  resolve: (value: number) => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: (value: number) => void
  let reject!: (error: Error) => void
  const promise = new Promise<number>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function controlledRunner(): {
  calls: Array<{ dir: string | null | undefined; pass: Deferred }>
} {
  const calls: Array<{ dir: string | null | undefined; pass: Deferred }> = []
  __setReindexRunnerForTest((dir) => {
    const pass = deferred()
    calls.push({ dir, pass })
    return pass.promise
  })
  return { calls }
}

afterEach(() => {
  __resetLocalBrainStoreForTest()
  vi.restoreAllMocks()
})

describe('reindexUntilReady', () => {
  it('waits for the requested vault pass instead of returning the active vault result', async () => {
    const { calls } = controlledRunner()
    const active = reindex('vault-a')
    const ready = reindexUntilReady('vault-b')
    let settled = false
    void ready.finally(() => { settled = true })

    expect(calls.map((call) => call.dir)).toEqual(['vault-a'])
    calls[0].pass.resolve(3)
    await active

    expect(calls.map((call) => call.dir)).toEqual(['vault-a', 'vault-b'])
    expect(settled).toBe(false)

    calls[1].pass.resolve(7)
    await expect(ready).resolves.toBe(7)
  })

  it('requires a pass started after the request even when the same vault is already indexing', async () => {
    const { calls } = controlledRunner()
    const active = reindex('vault-b')
    const ready = reindexUntilReady('vault-b')

    calls[0].pass.resolve(2)
    await active
    expect(calls.map((call) => call.dir)).toEqual(['vault-b', 'vault-b'])

    calls[1].pass.resolve(5)
    await expect(ready).resolves.toBe(5)
  })

  it('requeues its vault when a later background request supersedes the trailing slot', async () => {
    const { calls } = controlledRunner()
    const active = reindex('vault-a')
    const ready = reindexUntilReady('vault-b')
    const coalesced = reindex('vault-c')
    expect(coalesced).toBe(active)

    calls[0].pass.resolve(1)
    await active
    expect(calls.map((call) => call.dir)).toEqual(['vault-a', 'vault-c'])

    calls[1].pass.resolve(4)
    // `coalesced` is deliberately the original A promise; let C's own
    // controlled pass settle so the readiness waiter can observe/requeue B.
    await calls[1].pass.promise
    await Promise.resolve()
    expect(calls.map((call) => call.dir)).toEqual(['vault-a', 'vault-c', 'vault-b'])

    calls[2].pass.resolve(9)
    await expect(ready).resolves.toBe(9)
  })

  it('does not publish readiness when a queued pass starts immediately after the target', async () => {
    const { calls } = controlledRunner()
    const ready = reindexUntilReady('vault-b')
    const coalesced = reindex('vault-c')
    let settled = false
    void ready.finally(() => { settled = true })

    expect(calls.map((call) => call.dir)).toEqual(['vault-b'])
    calls[0].pass.resolve(7)
    await coalesced

    expect(calls.map((call) => call.dir)).toEqual(['vault-b', 'vault-c'])
    expect(settled).toBe(false)

    calls[1].pass.resolve(4)
    await calls[1].pass.promise
    await Promise.resolve()
    expect(calls.map((call) => call.dir)).toEqual(['vault-b', 'vault-c', 'vault-b'])
    expect(settled).toBe(false)

    calls[2].pass.resolve(8)
    await expect(ready).resolves.toBe(8)
  })

  it('ignores an unrelated pass failure but rejects when its requested pass fails', async () => {
    const { calls } = controlledRunner()
    const unrelated = reindex('vault-a')
    const ready = reindexUntilReady('vault-b')

    calls[0].pass.reject(new Error('vault-a failed'))
    await expect(unrelated).rejects.toThrow('vault-a failed')
    expect(calls.map((call) => call.dir)).toEqual(['vault-a', 'vault-b'])

    calls[1].pass.reject(new Error('vault-b failed'))
    await expect(ready).rejects.toThrow('vault-b failed')
  })
})
