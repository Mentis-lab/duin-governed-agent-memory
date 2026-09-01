import { describe, it, expect } from 'vitest'
import { collectPeople } from './derive-knowledge'
import type { ConstructedData } from './types'

// The meeting / output / mental-model classifiers were RETIRED 2026-08-04, and their tests with
// them: isMeeting, normMeetingTitle, dedupeMeetings, parseNaturalDate, resolveMeetingDate and
// attendeesFromConstruction no longer exist. They were well covered — that was never the problem.
// The problem was that a well-tested classifier still produced an untrustworthy category, because
// its four signals had no precedence and its folder heuristics matched nothing on a vault not
// organised the way it assumed. Keeping the tests would have meant testing dead code.
//
// collectPeople survives: it reads constructed `person:*` nodes and person-note frontmatter.
describe('collectPeople (construction path)', () => {
  it('surfaces person entities from the construction graph with mention counts', () => {
    const construction: ConstructedData = {
      entities: [
        { id: 'person:jordan', kind: 'person', label: 'Jordan', note: 'a.md' },
        { id: 'person:sam', kind: 'person', label: 'Sam', note: 'b.md' },
        { id: 'project:atlas', kind: 'project', label: 'Atlas', note: 'a.md' }
      ],
      edges: [
        { source: 'person:jordan', target: 'project:atlas', type: 'owns' },
        { source: 'person:jordan', target: 'a.md', type: 'attends' }
      ],
      classifications: []
    }
    const people = collectPeople([], construction)
    expect(people.map((p) => p.name).sort()).toEqual(['Jordan', 'Sam'])
    const jordan = people.find((p) => p.id === 'person:jordan')!
    expect(jordan.mentions).toBe(2) // two edges touch person:jordan
    expect(jordan.note).toBe('a.md')
    // ranked by mentions desc → Jordan (2) before Sam (0)
    expect(people[0].name).toBe('Jordan')
  })

  it('returns [] with no construction and no notes', () => {
    expect(collectPeople([], null)).toEqual([])
  })
})
