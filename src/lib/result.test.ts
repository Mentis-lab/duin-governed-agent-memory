import { describe, it, expect } from 'vitest'
import { ok, err, isOk, isErr, fromIpc, attempt, describeError, isAbort } from './result'

describe('Result', () => {
  it('narrows: data is only reachable through ok', () => {
    const r = ok([1, 2, 3])
    expect(isOk(r)).toBe(true)
    if (r.ok) expect(r.data).toEqual([1, 2, 3])
  })

  it('never produces an empty error sentence', () => {
    expect(err('   ').error).toBe('Unknown error')
    expect(err('brain unreachable').error).toBe('brain unreachable')
  })

  it('keeps the original throw as cause', () => {
    const boom = new Error('ECONNREFUSED')
    const r = err('decisions: ECONNREFUSED', boom)
    expect(r.cause).toBe(boom)
  })
})

describe('fromIpc', () => {
  it('a missing preload surface is a FAILURE, not an empty success', () => {
    // The regression this pins: stores guarded with `if (!window.api?.x) return`
    // left the panel showing an authoritative empty list.
    const r = fromIpc<string[]>(undefined, 'agent runs')
    expect(isErr(r)).toBe(true)
    if (!r.ok) expect(r.error).toContain('no response from the main process')
  })

  it('success:false carries the handler error through', () => {
    const r = fromIpc<string[]>({ success: false, error: 'brain offline' }, 'agent runs')
    expect(r).toEqual({ ok: false, error: 'agent runs: brain offline', cause: undefined })
  })

  it('success:true with no data is a failure, not []', () => {
    const r = fromIpc<string[]>({ success: true }, 'agent runs')
    expect(isErr(r)).toBe(true)
  })

  it('an empty array is a legitimate SUCCESS and stays one', () => {
    const r = fromIpc<string[]>({ success: true, data: [] }, 'agent runs')
    expect(r).toEqual({ ok: true, data: [] })
  })
})

describe('attempt', () => {
  it('turns a throw into ok:false instead of a fallback value', async () => {
    const r = await attempt('decisions', async () => {
      throw new Error('state 500')
    })
    expect(isErr(r)).toBe(true)
    if (!r.ok) expect(r.error).toBe('decisions: state 500')
  })

  it('re-throws aborts — a cancelled read must not paint as failed', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    await expect(
      attempt('decisions', async () => {
        throw abort
      })
    ).rejects.toBe(abort)
  })

  it('passes a successful value straight through', async () => {
    const r = await attempt('decisions', async () => 7)
    expect(r).toEqual({ ok: true, data: 7 })
  })
})

describe('describeError / isAbort', () => {
  it('digs a sentence out of whatever was thrown', () => {
    expect(describeError(new Error('nope'))).toBe('nope')
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError({ error: 'from body' })).toBe('from body')
    expect(describeError(undefined, 'fallback')).toBe('fallback')
    expect(describeError(new Error('   '), 'fallback')).toBe('fallback')
  })

  it('recognises abort/timeout signals', () => {
    expect(isAbort({ name: 'AbortError' })).toBe(true)
    expect(isAbort({ name: 'TimeoutError' })).toBe(true)
    expect(isAbort(new Error('x'))).toBe(false)
    expect(isAbort(null)).toBe(false)
  })
})
