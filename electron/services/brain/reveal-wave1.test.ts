import { describe, it, expect } from 'vitest'
import { matchExistingEntities, wave1Frames, type ExistingEntity } from './reveal-wave1'

const ENTITIES: ExistingEntity[] = [
  { id: 'project:duin', label: 'DUIN', kind: 'project' },
  { id: 'topic:walled-data-garden', label: 'walled data garden', kind: 'topic' },
  { id: 'topic:calibration-ledger', label: 'calibration ledger', kind: 'topic' },
  { id: 'person:ai', label: 'AI', kind: 'person' }, // 2 chars → skipped as noise
  { id: 'topic:art', label: 'art', kind: 'topic' } // must NOT match inside "started"
]

describe('matchExistingEntities', () => {
  it('matches existing entity labels name-dropped in the text (incl. multi-word)', () => {
    const text = 'The DUIN moat is the calibration ledger inside a walled data garden.'
    const m = matchExistingEntities(text, ENTITIES).map((e) => e.id).sort()
    expect(m).toEqual(['project:duin', 'topic:calibration-ledger', 'topic:walled-data-garden'])
  })

  it('respects word boundaries — "art" does not match inside "started"; skips too-short labels', () => {
    const m = matchExistingEntities('We started the AI work', ENTITIES).map((e) => e.id)
    expect(m).not.toContain('topic:art')
    expect(m).not.toContain('person:ai') // < minLabel
  })

  it('dedups and caps', () => {
    const text = 'DUIN DUIN DUIN'
    expect(matchExistingEntities(text, ENTITIES)).toHaveLength(1)
    expect(matchExistingEntities('DUIN', ENTITIES, { cap: 0 }).length).toBeLessThanOrEqual(20)
  })

  it('empty text → no matches', () => {
    expect(matchExistingEntities('', ENTITIES)).toEqual([])
  })
})

describe('wave1Frames', () => {
  it('emits entity-found + a deterministic alias link per match, and applies the annotator', () => {
    const matches = [{ id: 'project:duin', label: 'DUIN', kind: 'project' }]
    const frames = wave1Frames(matches, 'drop:x', () => ({ accept: 'auto', confidence: 0.9 }))
    expect(frames.map((f) => f.op)).toEqual(['entity-found', 'link-formed'])
    expect(frames[1]).toMatchObject({ from: 'drop:x', to: 'project:duin', src: 'alias', edgeType: 'mentions', accept: 'auto', confidence: 0.9 })
  })

  it('skips a self-match (an entity whose id is the drop itself)', () => {
    expect(wave1Frames([{ id: 'drop:x', label: 'x' }], 'drop:x')).toEqual([])
  })
})
