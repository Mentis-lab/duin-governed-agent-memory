import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ipc-client.ts reads `window.api` at MODULE LOAD, so the stub has to exist before
// the dynamic import below. Each test imports fresh via vi.resetModules().
beforeEach(() => {
  vi.stubGlobal('window', { api: {} })
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadQuery(): Promise<typeof import('./ipc-client').query> {
  const mod = await import('./ipc-client')
  return mod.query
}

async function loadInvoke(): Promise<typeof import('./ipc-client').invoke> {
  const mod = await import('./ipc-client')
  return mod.invoke
}

describe('invoke — the IPC WRITE chokepoint (U2)', () => {
  it('THROWS on success:false, so a success toast after it is unreachable', async () => {
    // Pattern B: ~19 writes did `await window.api.x.y()` then toast.success(),
    // never reading the envelope. Remove a model and the row stays; Stop a
    // runaway agent and nothing happens.
    const invoke = await loadInvoke()
    await expect(
      invoke('remove model', async () => ({ success: false, error: 'model is in use' }))
    ).rejects.toThrow('remove model: model is in use')
  })

  it('throws when the handler is missing rather than resolving undefined', async () => {
    const invoke = await loadInvoke()
    await expect(invoke('remove model', undefined)).rejects.toThrow(/no handler/)
  })

  it('throws when the main process answers nothing at all', async () => {
    const invoke = await loadInvoke()
    await expect(invoke('remove model', async () => undefined)).rejects.toThrow(
      /no response from the main process/
    )
  })

  it('returns the payload on success', async () => {
    const invoke = await loadInvoke()
    await expect(invoke('remove model', async () => ({ success: true, data: { id: 'x' } }))).resolves.toEqual({
      id: 'x'
    })
  })

  it('a void handler still resolves — success with no payload is not a failure', async () => {
    const invoke = await loadInvoke()
    await expect(invoke('stop agent', async () => ({ success: true }))).resolves.toBeUndefined()
  })
})

describe('query — the IPC read chokepoint', () => {
  it('an ABSENT preload surface is a failure, not an empty result', async () => {
    // The audit's exact shape: `if (!window.api?.tasks?.list) return` left the
    // Activity panel rendering "nothing is running" on an autonomy product.
    const query = await loadQuery()
    const r = await query<string[]>('agent runs', undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('no handler')
  })

  it('success:false surfaces the handler error', async () => {
    const query = await loadQuery()
    const r = await query<string[]>('agent runs', async () => ({
      success: false,
      error: 'brain unreachable'
    }))
    expect(r).toEqual({ ok: false, error: 'agent runs: brain unreachable', cause: undefined })
  })

  it('a THROWN ipc error becomes ok:false rather than an unhandled rejection', async () => {
    const query = await loadQuery()
    const r = await query<string[]>('agent runs', async () => {
      throw new Error('Error invoking remote method')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Error invoking remote method')
  })

  it('a genuinely empty list is a SUCCESS and stays one', async () => {
    const query = await loadQuery()
    const r = await query<string[]>('agent runs', async () => ({ success: true, data: [] }))
    expect(r).toEqual({ ok: true, data: [] })
  })

  it('passes data through on success', async () => {
    const query = await loadQuery()
    const r = await query<string[]>('agent runs', async () => ({
      success: true,
      data: ['run-1']
    }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual(['run-1'])
  })
})
