import { describe, it, expect } from 'vitest'
import { parseCard, parseInstinctCard, cardToFact } from './cold-start-seed'

const INSTINCT = `---
type: card
id: i-probation-layer
status: live
---

# Instincts Are the Probationary Layer Between Memory and Hard Rules

> Hard rules are immutable + reactive; instincts are confidence-scored + probabilistic — a probation slot where soft patterns earn promotion without getting burned first.
`

const VALIDATED = `---
type: value
id: v-truth-over-comfort
name: Truth over comfort
status: validated
---

# Value · Truth over comfort

**Statement:** Go looking for the read that proves you wrong. The flattering signal is the expensive one.
`

const DRAFT = `---
type: structure-principle
id: s-organic-over-template
name: Organic structure over imposed template
status: draft
---

# Structure Principle

**Principle:** Let structure emerge from where work accumulates; prune imposed templates.
`

describe('cold-start-seed — parseCard', () => {
  it('extracts name/type/validated/statement from a validated value card', () => {
    const c = parseCard(VALIDATED)!
    expect(c.name).toBe('Truth over comfort')
    expect(c.type).toBe('value')
    expect(c.validated).toBe(true)
    expect(c.statement).toMatch(/proves you wrong/)
  })
  it('reads the **Principle:** variant + draft status', () => {
    const c = parseCard(DRAFT)!
    expect(c.validated).toBe(false)
    expect(c.statement).toMatch(/emerge from where work/)
  })
  it('returns null when name or statement is missing', () => {
    expect(parseCard('---\nname: X\n---\nno statement line')).toBeNull()
    expect(parseCard('**Statement:** orphan with no frontmatter name')).toBeNull()
  })
})

describe('cold-start-seed — parseInstinctCard', () => {
  it('extracts the H1 title as name + the BLUF blockquote as statement', () => {
    const c = parseInstinctCard(INSTINCT)!
    expect(c.name).toMatch(/Probationary Layer/)
    expect(c.statement).toMatch(/confidence-scored/)
    expect(c.validated).toBe(false)
  })
  it('an instinct card seeds as candidate (status: live, not validated)', () => {
    expect(cardToFact(parseInstinctCard(INSTINCT)!).status).toBe('candidate')
  })
  it('returns null without both an H1 title and a blockquote thesis', () => {
    expect(parseInstinctCard('---\ntype: card\n---\n# Title only, no blockquote')).toBeNull()
    expect(parseInstinctCard('---\ntype: card\n---\n> blockquote but no H1 title')).toBeNull()
  })
})

describe('cold-start-seed — cardToFact', () => {
  it('validated → provisional (govern fuel); draft → candidate', () => {
    expect(cardToFact(parseCard(VALIDATED)!).status).toBe('provisional')
    expect(cardToFact(parseCard(DRAFT)!).status).toBe('candidate')
  })
  it('fact = "name — statement", carries the card type as kind', () => {
    const f = cardToFact(parseCard(VALIDATED)!)
    expect(f.fact.startsWith('Truth over comfort — ')).toBe(true)
    expect(f.kind).toBe('value')
  })
  it('truncates an over-long fact to the 280-char cap with an ellipsis', () => {
    const f = cardToFact({ id: 'x', name: 'N', type: 'value', validated: false, statement: 'y'.repeat(400) })
    expect(f.fact.length).toBe(280)
    expect(f.fact.endsWith('…')).toBe(true)
  })
})
