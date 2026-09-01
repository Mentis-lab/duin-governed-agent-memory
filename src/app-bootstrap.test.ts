import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { settleBootstrap } from './app-bootstrap'

const appSource = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8')

describe('application bootstrap', () => {
  it('becomes ready when all required local stores settle', async () => {
    await expect(settleBootstrap([
      async () => undefined,
      async () => ({ success: true })
    ])).resolves.toEqual({ status: 'ready' })
  })

  it('degrades instead of rejecting when one startup task fails', async () => {
    const state = await settleBootstrap([
      async () => { throw new Error('database unavailable') },
      async () => undefined
    ])
    expect(state.status).toBe('degraded')
    if (state.status === 'degraded') expect(state.message).toMatch(/One part/)
  })

  it('treats a false IPC/store outcome as degraded', async () => {
    await expect(settleBootstrap([async () => false])).resolves.toMatchObject({ status: 'degraded' })
  })

  it('degrades instead of displaying Loading forever when a task never settles', async () => {
    const state = await settleBootstrap([
      () => new Promise(() => undefined)
    ], 5)
    expect(state.status).toBe('degraded')
  })

  it('aborts timed-out attempts so stale loaders cannot mutate after Retry', async () => {
    let signal: AbortSignal | undefined
    await settleBootstrap([
      (attemptSignal) => {
        signal = attemptSignal
        return new Promise(() => undefined)
      }
    ], 5)

    expect(signal?.aborted).toBe(true)
  })

  it('keeps optional provider discovery outside the awaited bootstrap tasks', () => {
    const start = appSource.match(/const startBootstrap[\s\S]*?\n {2}\}, \[/)?.[0] ?? ''
    // loadConversations is called WITHOUT a signal on purpose: chat-store's action takes none,
    // so the original `loadConversations(signal)` this test pinned was a type error (it is why
    // a source-shape assertion is weaker than compiling the thing).
    expect(start).toMatch(/loadConversations\(\)/)
    expect(start).toMatch(/loadModels\(signal\)/)
    expect(start).toMatch(/loadSettings\(signal\)/)
    expect(start).not.toMatch(/listProviderKeys/)
    expect(appSource).toMatch(/Continue locally/)
    expect(appSource).toMatch(/Open settings/)
  })

  it('unsubscribes the app-level error, warning, and needs-key listeners', () => {
    expect(appSource).toMatch(/offError\?\.\(\)/)
    expect(appSource).toMatch(/offWarning\?\.\(\)/)
    expect(appSource).toMatch(/offNeedsKey\?\.\(\)/)
  })
})
