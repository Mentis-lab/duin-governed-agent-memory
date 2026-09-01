import { describe, it, expect } from 'vitest'
import { migrateRetiredKinds, migrateId, KIND_MIGRATIONS } from './construct-kind-migration'
import type { ConstructedData } from './types'

const base = (over: Partial<ConstructedData>): ConstructedData =>
  ({ entities: [], edges: [], classifications: [], triples: [], ...over }) as ConstructedData

const ent = (id: string, kind: string, label: string) => ({ id, kind, label, note: 'n.md' }) as never

describe('migrateId', () => {
  it('rewrites a retired kind prefix and leaves everything else alone', () => {
    expect(migrateId('project:beilan')).toBe('topic:beilan')
    expect(migrateId('person:theo-quill')).toBe('person:theo-quill')
    expect(migrateId('no-colon')).toBe('no-colon')
    expect(migrateId(':leading')).toBe(':leading')
  })

  it('preserves a slug that itself contains a colon', () => {
    expect(migrateId('project:a:b')).toBe('topic:a:b')
  })
})

describe('migrateRetiredKinds', () => {
  it('is a no-op, and returns the same object, when nothing is retired', () => {
    const d = base({ entities: [ent('topic:x', 'topic', 'X')] })
    const r = migrateRetiredKinds(d)
    expect(r.migrated).toBe(0)
    expect(r.data).toBe(d) // identity — callers may rely on this to skip a write
  })

  it('rewrites kind and id together', () => {
    const r = migrateRetiredKinds(base({ entities: [ent('project:w', 'project', 'W')] }))
    expect(r.migrated).toBe(1)
    expect(r.data.entities[0]).toMatchObject({ id: 'topic:w', kind: 'topic', label: 'W' })
  })

  it('remaps edge endpoints so no edge is left dangling', () => {
    const r = migrateRetiredKinds(
      base({
        entities: [ent('project:w', 'project', 'W'), ent('person:r', 'person', 'R')],
        edges: [{ source: 'person:r', target: 'project:w', type: 'owns' }] as never
      })
    )
    expect(r.data.edges[0]).toMatchObject({ source: 'person:r', target: 'topic:w' })
  })

  it('remaps triple subjects and objects', () => {
    const r = migrateRetiredKinds(
      base({
        entities: [ent('project:w', 'project', 'W')],
        triples: [{ subject: 'project:w', relation: 'is', object: 'project:w', note: 'n.md' }] as never
      })
    )
    expect(r.data.triples?.[0]).toMatchObject({ subject: 'topic:w', object: 'topic:w' })
  })

  // ── the case that makes this migration worth having ──
  it('FOLDS a remapped entity onto an existing one with the target kind', () => {
    // The common live shape: the same label already exists as BOTH project: and topic:. Leaving
    // both after the remap would produce two entities with the same id — worse than before.
    const r = migrateRetiredKinds(
      base({ entities: [ent('project:w', 'project', 'W'), ent('topic:w', 'topic', 'W')] })
    )
    expect(r.migrated).toBe(1)
    expect(r.folded).toBe(1)
    expect(r.data.entities).toHaveLength(1)
    expect(r.data.entities[0]).toMatchObject({ id: 'topic:w', kind: 'topic' })
  })

  it('the survivor of a fold is the one that already carried the target kind', () => {
    // Order must not decide identity — the pre-existing topic wins either way.
    const a = migrateRetiredKinds(
      base({ entities: [ent('topic:w', 'topic', 'Original'), ent('project:w', 'project', 'Remapped')] })
    )
    const b = migrateRetiredKinds(
      base({ entities: [ent('project:w', 'project', 'Remapped'), ent('topic:w', 'topic', 'Original')] })
    )
    expect(a.data.entities[0]).toMatchObject({ label: 'Original' })
    expect(b.data.entities[0]).toMatchObject({ label: 'Original' })
  })

  it('never emits duplicate ids', () => {
    const r = migrateRetiredKinds(
      base({
        entities: [
          ent('project:a', 'project', 'A'), ent('topic:a', 'topic', 'A'),
          ent('project:b', 'project', 'B'), ent('project:c', 'project', 'C')
        ]
      })
    )
    const ids = r.data.entities.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is idempotent — running it twice changes nothing the second time', () => {
    const once = migrateRetiredKinds(
      base({ entities: [ent('project:w', 'project', 'W'), ent('topic:w', 'topic', 'W')] })
    )
    const twice = migrateRetiredKinds(once.data)
    expect(twice.migrated).toBe(0)
    expect(twice.data).toBe(once.data)
  })

  it('every migration target is itself a live kind, not another retired one', () => {
    for (const to of Object.values(KIND_MIGRATIONS)) {
      expect(KIND_MIGRATIONS[to as string]).toBeUndefined()
    }
  })
})
