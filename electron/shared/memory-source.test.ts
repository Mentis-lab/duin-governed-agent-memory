import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  MEMORY_SOURCES,
  MEMORY_SOURCE_LABELS,
  MEMORY_SOURCES_WITHOUT_EMITTER,
  isMemorySource,
  type MemorySource
} from './memory-source'

// The memory-provenance vocabulary had TWO definitions — this one and a copy in src/lib/types.ts
// carrying the comment "Mirrors MemorySource in electron/services/memory-frontmatter.ts... Keep the
// two in step." One concept, two owners, agreement held by asking a human to remember. Constitution
// property 1 names that exact shape and says the agreement must be held by a TEST, not by review;
// the file's own worked example is three lists that each encoded "this is not a user note", every
// site individually correct and well-commented, with nobody owning the concept.
//
// The duplication is now gone — both sides import this module — so these tests hold the two things
// an import cannot: that no copy comes BACK, and that the stated limit stays true.

const REPO = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8')

describe('memory-source — one owner, held by a test', () => {
  it('every source has a label, and every label a source', () => {
    expect(Object.keys(MEMORY_SOURCE_LABELS).sort()).toEqual([...MEMORY_SOURCES].sort())
  })

  it('accepts exactly the declared vocabulary and nothing else', () => {
    for (const s of MEMORY_SOURCES) expect(isMemorySource(s)).toBe(true)
    // The two values OperatorFact.source can hold are deliberately NOT memory sources: a fact's
    // authorship and a memory file's provenance are different questions over different planes.
    for (const s of ['operator', 'machine', '', 'REFLECTION', null, 7]) expect(isMemorySource(s)).toBe(false)
  })

  // The regression that matters: a future edit re-adding a local copy on either side. An import
  // cannot prevent someone declaring the type again next to it, so this asserts the absence.
  it('is the ONLY declaration — neither side redeclares the type or the labels', () => {
    for (const rel of ['src/lib/types.ts', 'electron/services/memory-frontmatter.ts']) {
      const body = read(rel)
      expect(body, `${rel} must import MemorySource, not redeclare it`).not.toMatch(
        /export\s+type\s+MemorySource\s*=/
      )
      expect(body, `${rel} must import MEMORY_SOURCE_LABELS, not redeclare it`).not.toMatch(
        /export\s+const\s+MEMORY_SOURCE_LABELS\s*[:=]/
      )
    }
  })

  it('both consumers reach this module for the vocabulary', () => {
    expect(read('src/lib/types.ts')).toContain('electron/shared/memory-source')
    expect(read('electron/services/memory-frontmatter.ts')).toContain('../shared/memory-source')
  })

  // Property 5: a mechanism publishes its limits, and a published limit that rots is worse than
  // none. `reflection` is documented as having no emitter; if one is ever added, this fails and the
  // doc must be updated in the same change.
  it('pins the stated limit — `reflection` still has no emitter anywhere in the app', () => {
    expect(MEMORY_SOURCES_WITHOUT_EMITTER).toEqual(['reflection'])
    const emitters = ["source: 'reflection'", 'source:"reflection"', "'reflection' as MemorySource"]
    for (const rel of ['electron/services/memory-store.ts', 'electron/ipc/memory.ts']) {
      const body = read(rel)
      for (const needle of emitters) expect(body).not.toContain(needle)
    }
  })

  it('keeps `unknown` in the vocabulary — it is a first-class value, not a hole', () => {
    const s: MemorySource = 'unknown'
    expect(MEMORY_SOURCES).toContain(s)
    expect(MEMORY_SOURCE_LABELS.unknown).toBe('Unknown origin')
  })
})
