import { describe, expect, it } from 'vitest'
import { loadPositions, savePositions, positionsKey, POSITIONS_VERSION } from './graph-positions'

function fakeStorage(quotaBytes = Infinity) {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (v.length > quotaBytes) throw new Error('QuotaExceededError'); m.set(k, v) },
    raw: m,
  }
}

describe('graph-positions: the map comes back where it was', () => {
  it('round-trips positions, pins over positions, skips nodes without one, rounds to a tenth', () => {
    const s = fakeStorage()
    const ok = savePositions(s, 'k', [
      { id: 'a', x: 1.234, y: -5.678 },
      { id: 'core', x: 3, y: 3, fx: 0, fy: 0 },
      { id: 'fresh' },
      { id: 'nan', x: NaN, y: 1 },
    ])
    expect(ok).toBe(true)
    const back = loadPositions(s, 'k')
    expect(back.get('a')).toEqual([1.2, -5.7])
    expect(back.get('core')).toEqual([0, 0])
    expect(back.has('fresh')).toBe(false)
    expect(back.has('nan')).toBe(false)
  })

  it('an unknown version, corrupt JSON, or no storage reads as empty', () => {
    const s = fakeStorage()
    s.setItem('k', JSON.stringify({ v: POSITIONS_VERSION + 1, pos: { a: [1, 2] } }))
    expect(loadPositions(s, 'k').size).toBe(0)
    s.setItem('k', '{not json')
    expect(loadPositions(s, 'k').size).toBe(0)
    expect(loadPositions(null, 'k').size).toBe(0)
  })

  it('a quota failure or an oversized map writes nothing and says so', () => {
    const tiny = fakeStorage(10)
    expect(savePositions(tiny, 'k', [{ id: 'a', x: 1, y: 1 }])).toBe(false)
    expect(loadPositions(tiny, 'k').size).toBe(0)
    const s = fakeStorage()
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, x: i, y: i }))
    expect(savePositions(s, 'k', many, 3)).toBe(false)
    expect(savePositions(s, 'k', many, 5)).toBe(true)
  })

  it('the key is per vault and path-shape agnostic', () => {
    expect(positionsKey('D:\\Vaults\\field-brain')).toBe(positionsKey('d:/vaults/field-brain'))
    expect(positionsKey('a')).not.toBe(positionsKey('b'))
    expect(positionsKey(null)).toBe(positionsKey(undefined))
  })
})
