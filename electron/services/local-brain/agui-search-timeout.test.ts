// R4/Phase-2 — web_search hard timeout + signal honoring. searchCascade and the DDG fallback have
// no wall-clock bound of their own, so executeAguiWebSearch must race them against DUIN_TOOL_TIMEOUT_MS
// and short-circuit an already-aborted turn signal, so a stalled provider can never hang the round loop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the two I/O collaborators so the timeout/abort behaviour is deterministic and offline.
const searchCascadeMock = vi.fn<(...a: unknown[]) => unknown>()
const executeWebSearchMock = vi.fn<(...a: unknown[]) => unknown>()
vi.mock('../research/adapter-cascade', () => ({ searchCascade: (...a: unknown[]) => searchCascadeMock(...a) }))
vi.mock('./agui-executors', () => ({ executeWebSearch: (...a: unknown[]) => executeWebSearchMock(...a) }))

import { executeAguiWebSearch, withToolTimeout, toolTimeoutMs } from './agui-search'

describe('withToolTimeout — race work vs timeout vs abort', () => {
  it('resolves with the work value when work finishes first', async () => {
    const out = await withToolTimeout(Promise.resolve('done'), 1000, undefined, () => 'EXPIRED')
    expect(out).toBe('done')
  })

  it('resolves with onExpire when the timeout wins', async () => {
    const never = new Promise<string>(() => {}) // never resolves
    const out = await withToolTimeout(never, 10, undefined, () => 'EXPIRED')
    expect(out).toBe('EXPIRED')
  })

  it('resolves with onExpire when the signal aborts before work finishes', async () => {
    const ctl = new AbortController()
    const never = new Promise<string>(() => {})
    const p = withToolTimeout(never, 10_000, ctl.signal, () => 'ABORTED')
    ctl.abort()
    expect(await p).toBe('ABORTED')
  })

  it('short-circuits to onExpire for an already-aborted signal (no waiting)', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const never = new Promise<string>(() => {})
    expect(await withToolTimeout(never, 10_000, ctl.signal, () => 'ABORTED')).toBe('ABORTED')
  })

  it('resolves with onExpire when work rejects', async () => {
    const out = await withToolTimeout(Promise.reject(new Error('boom')), 1000, undefined, () => 'EXPIRED')
    expect(out).toBe('EXPIRED')
  })
})

describe('toolTimeoutMs — env-tunable, 60s default', () => {
  afterEach(() => { delete process.env.DUIN_TOOL_TIMEOUT_MS })
  it('defaults to 60000', () => { expect(toolTimeoutMs()).toBe(60_000) })
  it('honors DUIN_TOOL_TIMEOUT_MS', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '5000'
    expect(toolTimeoutMs()).toBe(5_000)
  })
  it('0 disables the cap', () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '0'
    expect(toolTimeoutMs()).toBe(0)
  })
})

describe('executeAguiWebSearch — R4 timeout + signal', () => {
  beforeEach(() => {
    searchCascadeMock.mockReset()
    executeWebSearchMock.mockReset()
    delete process.env.DUIN_TOOL_TIMEOUT_MS
    delete process.env.DUIN_AGUI_WEB_CASCADE
  })

  it('returns a timeout error (not a hang) when the cascade stalls past the budget', async () => {
    process.env.DUIN_TOOL_TIMEOUT_MS = '20' // tiny budget
    searchCascadeMock.mockReturnValue(new Promise(() => {})) // stalls forever
    executeWebSearchMock.mockResolvedValue({ ok: true, results: 'ddg' }) // must NOT be reached in time
    const res = await executeAguiWebSearch('anything')
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/web_search timed out after 20ms/)
  })

  it('short-circuits an already-aborted turn signal without calling the cascade', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const res = await executeAguiWebSearch('q', {}, 8000, ctl.signal)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/aborted/)
    expect(searchCascadeMock).not.toHaveBeenCalled()
    expect(executeWebSearchMock).not.toHaveBeenCalled()
  })

  it('empty query is rejected before any I/O', async () => {
    const res = await executeAguiWebSearch('   ')
    expect(res).toEqual({ ok: false, error: 'query is required' })
    expect(searchCascadeMock).not.toHaveBeenCalled()
  })

  it('passes through real cascade results within budget (happy path unchanged)', async () => {
    searchCascadeMock.mockResolvedValue({
      results: [{ title: 'A', url: 'https://a', snippet: 's' }],
      providersUsed: ['brave']
    })
    const res = await executeAguiWebSearch('q')
    expect(res.ok).toBe(true)
    expect((res as { results: string }).results).toContain('https://a')
    expect(executeWebSearchMock).not.toHaveBeenCalled()
  })
})
