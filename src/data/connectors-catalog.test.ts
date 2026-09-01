import { describe, it, expect } from 'vitest'
import { CONNECTORS_CATALOG } from './connectors-catalog'

describe('connectors catalog — computer-use entries are opt-in', () => {
  const computerUse = CONNECTORS_CATALOG.filter((c) => c.category === 'Computer Use')

  it('ships the two desktop computer-use connectors', () => {
    expect(computerUse.map((c) => c.id).sort()).toEqual(['computer-use', 'terminator'])
  })

  it('has every computer-use connector disabled by default (attended, opt-in)', () => {
    for (const c of computerUse) expect(c.enabled).toBe(false)
  })
})
