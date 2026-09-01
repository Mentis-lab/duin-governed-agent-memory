import { describe, it, expect } from 'vitest'
import { extractFirstJsonObject, salvageJsonObject } from './extraction-util'

describe('extraction-util — extractFirstJsonObject (happy path unchanged)', () => {
  it('parses a complete object', () => {
    const obj = extractFirstJsonObject('{"entities":[{"id":"a"}],"edges":[]}')
    expect(obj).toEqual({ entities: [{ id: 'a' }], edges: [] })
  })

  it('tolerates a ```json fence and leading prose', () => {
    const obj = extractFirstJsonObject('here you go:\n```json\n{"a":1}\n```')
    expect(obj).toEqual({ a: 1 })
  })

  it('returns null on genuine garbage', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull()
    expect(extractFirstJsonObject('')).toBeNull()
  })
})

describe('extraction-util — element-level salvage of a truncated (finish_reason:length) body', () => {
  it('recovers complete entity objects streamed before a mid-object cut', () => {
    // The stream was cut mid-way through the THIRD entity — the whole-object parse
    // would throw (unbalanced braces), losing the two complete entities too.
    const truncated =
      '{"entities":[' +
      '{"id":"person:a","kind":"person","label":"Ann","note":"n1"},' +
      '{"id":"person:b","kind":"person","label":"Bob","note":"n2"},' +
      '{"id":"person:c","kind":"per'
    const obj = extractFirstJsonObject(truncated)
    expect(obj).not.toBeNull()
    const entities = obj!.entities as Array<{ id: string }>
    expect(entities.map((e) => e.id)).toEqual(['person:a', 'person:b']) // 3rd (incomplete) dropped
  })

  it('recovers multiple arrays and drops only the final incomplete item', () => {
    const truncated =
      '{"entities":[{"id":"e1"}],' +
      '"edges":[{"source":"e1","target":"e2","type":"about"},{"source":"e1","target":"e3","typ'
    const obj = salvageJsonObject(truncated)
    expect(obj).not.toBeNull()
    expect((obj!.entities as unknown[]).length).toBe(1)
    const edges = obj!.edges as Array<{ target: string }>
    expect(edges.map((e) => e.target)).toEqual(['e2']) // 2nd edge incomplete → dropped
  })

  it('is string-aware — a brace inside a quoted value does not confuse the scan', () => {
    const truncated =
      '{"triples":[{"subject":"a","relation":"note","object":"has {braces} inside","note":"n1"},{"subject":"b"'
    const obj = salvageJsonObject(truncated)
    expect(obj).not.toBeNull()
    const triples = obj!.triples as Array<{ object: string }>
    expect(triples.length).toBe(1)
    expect(triples[0].object).toBe('has {braces} inside')
  })

  it('returns null when nothing complete can be recovered', () => {
    expect(salvageJsonObject('{"entities":[{"id":"a')).toBeNull()
    expect(salvageJsonObject('')).toBeNull()
  })
})
