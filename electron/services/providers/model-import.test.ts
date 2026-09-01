import { describe, expect, it } from 'vitest'
import { buildLiveModelImports } from './model-import'

describe('live model import', () => {
  it('deduplicates input and skips an exact provider/apiModelId match', () => {
    const result = buildLiveModelImports('host', [' alpha ', 'alpha', 'beta'], [
      { id: 'already-local', apiModelId: 'alpha', provider: 'host' }
    ])
    expect(result.skipped).toBe(1)
    expect(result.additions.map((m) => m.apiModelId)).toEqual(['beta'])
  })

  it('namespaces a local collision while preserving the verbatim API id', () => {
    const result = buildLiveModelImports('second-host', ['shared/model'], [
      { id: 'shared/model', provider: 'first-host' }
    ])
    expect(result.additions[0]).toMatchObject({
      id: 'second-host:shared/model',
      apiModelId: 'shared/model',
      provider: 'second-host'
    })
  })

  it('imports volatile catalogs with conservative capability defaults', () => {
    const ids = Array.from({ length: 150 }, (_, index) => `model-${index}`)
    const result = buildLiveModelImports('large-host', ids, [])
    expect(result.additions).toHaveLength(150)
    expect(result.additions.every((m) => !m.supportsTools && !m.supportsVision)).toBe(true)
    // Conservative context floor, never over-claimed from a bare id list.
    expect(result.additions.every((m) => m.contextWindow === 65_536)).toBe(true)
  })

  it('caps a runaway catalog at 2,000 ids', () => {
    const ids = Array.from({ length: 2_500 }, (_, i) => `m-${i}`)
    const result = buildLiveModelImports('huge', ids, [])
    expect(result.additions).toHaveLength(2_000)
  })

  it('chains numeric suffixes when the namespaced id also collides', () => {
    const result = buildLiveModelImports('p', ['x'], [
      { id: 'x', provider: 'other' },
      { id: 'p:x', provider: 'p' }
    ])
    expect(result.additions[0]).toMatchObject({ id: 'p:x:2', apiModelId: 'x' })
  })
})
