import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  guarded,
  guardedSync,
  isExpected,
  setGuardTelemetry,
  __resetGuardTelemetry
} from './guarded'

afterEach(() => __resetGuardTelemetry())

describe('guarded — expected vs unexpected', () => {
  it('passes through the value on success', async () => {
    expect(await guarded(() => 42)).toBe(42)
    expect(await guarded(async () => 'ok')).toBe('ok')
  })

  it('EXPECTED degradation is quiet + returns the typed fallback (no telemetry)', async () => {
    const sink = vi.fn()
    setGuardTelemetry(sink)
    const out = await guarded(
      () => {
        throw new Error('no model key configured')
      },
      { expected: ['no model key'], fallback: 'DEGRADED', label: 'chat' }
    )
    expect(out).toBe('DEGRADED')
    expect(sink).not.toHaveBeenCalled() // expected → NOT loud
  })

  it('UNEXPECTED failure fires telemetry LOUDLY (never silent)', async () => {
    const sink = vi.fn()
    setGuardTelemetry(sink)
    const out = await guarded(
      () => {
        throw new Error('Only integers are allowed for primary key') // the real ledger bug
      },
      { expected: ['no model key'], fallback: null, label: 'ledger.sync' }
    )
    expect(out).toBe(null)
    expect(sink).toHaveBeenCalledOnce()
    expect(sink.mock.calls[0][0]).toBe('ledger.sync')
  })

  it('classify() maps the error to the reason tested against expected', async () => {
    const sink = vi.fn()
    setGuardTelemetry(sink)
    await guarded(
      () => {
        throw { code: 'ENOENT', path: '/vault' }
      },
      { expected: ['ENOENT'], classify: (e: any) => e.code, label: 'vault' }
    )
    expect(sink).not.toHaveBeenCalled() // classified ENOENT → expected → quiet
  })
})

describe('guardedSync', () => {
  it('same contract without await', () => {
    expect(guardedSync(() => 1)).toBe(1)
    const sink = vi.fn()
    setGuardTelemetry(sink)
    expect(
      guardedSync(
        () => {
          throw new Error('boom')
        },
        { fallback: 'fb' }
      )
    ).toBe('fb')
    expect(sink).toHaveBeenCalledOnce() // unexpected → loud
  })
})

describe('isExpected', () => {
  it('true only when a reason substring matches', () => {
    expect(isExpected(new Error('no vault connected'), { expected: ['no vault'] })).toBe(true)
    expect(isExpected(new Error('segfault'), { expected: ['no vault'] })).toBe(false)
    expect(isExpected(new Error('x'), {})).toBe(false) // no expected list → nothing is expected
  })
})
