import { describe, it, expect } from 'vitest'
import { sortedByOwed, owedCount, mergeDerivedPeople, type Person } from './people'

const p = (name: string, owed?: string, lastContact?: string): Person => ({
  id: name,
  name,
  owed,
  lastContact
})

describe('sortedByOwed', () => {
  it('floats people you owe to the top', () => {
    const out = sortedByOwed([p('Clear'), p('Owed', 'send the deck')])
    expect(out.map((x) => x.name)).toEqual(['Owed', 'Clear'])
  })

  it('among non-owed, surfaces who you have gone quiet on (oldest contact first)', () => {
    const out = sortedByOwed([p('Recent', undefined, '2026-06-20'), p('Stale', undefined, '2026-01-01')])
    expect(out.map((x) => x.name)).toEqual(['Stale', 'Recent'])
  })

  it('falls back to name when owed + contact tie', () => {
    const out = sortedByOwed([p('Bob'), p('Ann')])
    expect(out.map((x) => x.name)).toEqual(['Ann', 'Bob'])
  })

  it('does not mutate the input', () => {
    const input = [p('B', 'x'), p('A')]
    sortedByOwed(input)
    expect(input.map((x) => x.name)).toEqual(['B', 'A'])
  })
})

describe('owedCount', () => {
  it('counts only people with a non-blank owed', () => {
    expect(owedCount([p('A', 'reply'), p('B', '  '), p('C')])).toBe(1)
  })
})

describe('mergeDerivedPeople', () => {
  it('appends derived people that are not already tracked', () => {
    const out = mergeDerivedPeople(
      [p('Ann')],
      [{ id: 'person:jordan', name: 'Jordan', mentions: 3 }]
    )
    expect(out.map((x) => x.name)).toEqual(['Ann', 'Jordan'])
    expect(out[1].id).toBe('person:jordan') // graph id preserved for focus
  })

  it('does not duplicate a derived person already tracked by id', () => {
    const out = mergeDerivedPeople(
      [{ id: 'person:jordan', name: 'Jordan' }],
      [{ id: 'person:jordan', name: 'Jordan' }]
    )
    expect(out).toHaveLength(1)
  })

  it('does not duplicate a derived person already tracked by (case-insensitive) name', () => {
    const out = mergeDerivedPeople([p('Jordan')], [{ id: 'person:jordan', name: 'jordan' }])
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('Jordan') // manual entry wins
  })

  it('manual entries always come first and are unchanged', () => {
    const manual = [p('Ann', 'owe a reply')]
    const out = mergeDerivedPeople(manual, [{ id: 'person:bob', name: 'Bob' }])
    expect(out[0]).toEqual(manual[0])
  })

  it('skips derived entries with no id or name', () => {
    const out = mergeDerivedPeople([], [{ id: '', name: 'X' }, { id: 'y', name: '  ' }])
    expect(out).toEqual([])
  })
})
