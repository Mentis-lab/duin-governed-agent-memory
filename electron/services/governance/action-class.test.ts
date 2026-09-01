import { describe, it, expect } from 'vitest'
import {
  classifyAction,
  gateForAction,
  isCap,
  isIrreversible,
  isFoundational, capFloorForDescriptor } from './action-class'

describe('classifyAction', () => {
  it('classifies read/analyze as Tier A grad', () => {
    const c = classifyAction('read the latest cards and summarize them')
    expect(c.tier).toBe('A')
    expect(c.disposition).toBe('grad')
    expect(c.matched).toBe(true)
  })

  it('classifies a note write as Tier B grad', () => {
    const c = classifyAction('write a note about the deploy plan')
    expect(c.classId).toBe('durable-write')
    expect(c.disposition).toBe('grad')
  })

  it('classifies outward sends as Tier C cap', () => {
    expect(classifyAction('send the report to the team').disposition).toBe('cap')
    expect(classifyAction('发送这份总结给老板').disposition).toBe('cap')
  })

  it('classifies destructive data ops as cap + irreversible — even when a note is named', () => {
    const c = classifyAction('delete the old note')
    expect(c.classId).toBe('destructive-data') // NOT durable-write — dangerous verb wins
    expect(c.disposition).toBe('cap')
    expect(c.irreversible).toBe(true)
  })

  it('classifies shell exec and credentials as cap', () => {
    expect(classifyAction('execute a shell command').disposition).toBe('cap')
    expect(classifyAction('rotate the api key').disposition).toBe('cap')
  })

  it('classifies foundational/config edits as cap + foundational (before generic file-edit)', () => {
    const c = classifyAction('update the permissions settings')
    expect(c.classId).toBe('foundational-edit')
    expect(c.foundational).toBe(true)
    expect(c.disposition).toBe('cap')
  })

  it('classifies a plain file edit as Tier B grad', () => {
    expect(classifyAction('modify the readme wording').classId).toBe('file-edit')
  })

  it('FAIL-SAFE: empty or unclassifiable → CAP / irreversible / foundational, matched=false', () => {
    for (const t of ['', '   ', 'xyzzy frobnicate the quux']) {
      const c = classifyAction(t)
      expect(c.disposition).toBe('cap')
      expect(c.irreversible).toBe(true)
      expect(c.foundational).toBe(true)
      expect(c.matched).toBe(false)
    }
  })
})

describe('gateForAction', () => {
  it('requires approval for cap, allows grad', () => {
    expect(gateForAction('send an email').gate).toBe('require-approval')
    expect(gateForAction('search the vault').gate).toBe('allow')
    expect(gateForAction('totally novel unnamed action').gate).toBe('require-approval') // fail-safe
  })
})

describe('convenience predicates', () => {
  it('mirror the classification', () => {
    expect(isCap('delete everything')).toBe(true)
    expect(isCap('read a file')).toBe(false)
    expect(isIrreversible('publish the post')).toBe(true)
    expect(isFoundational('edit governance policy')).toBe(true)
    expect(isFoundational('read a file')).toBe(false)
  })
})

// ── backlog finding 45 ──────────────────────────────────────────────────────

describe('capFloorForDescriptor — danger past the first 300 characters is still seen', () => {
  it('classifies on the WHOLE arg text, not a 300-char prefix', () => {
    // summarizeArgs capped the concatenated args at 300 chars BEFORE the classifier saw
    // them. apply_patch is a brain loop's only write tool and its envelopes run to
    // thousands of characters, so a patch whose dangerous portion sat past that offset
    // was classified off its opening lines alone.
    const descriptor = {
      name: 'apply_patch',
      risks: ['write'],
      requiresApproval: false,
      mutates: true
    }
    const benignPrefix = 'x'.repeat(1200)
    const nearMiss = capFloorForDescriptor(descriptor as never, { patch: benignPrefix })
    const farDanger = capFloorForDescriptor(descriptor as never, {
      patch: `${benignPrefix} delete the whole vault and rm -rf everything`
    })
    // The prefix alone must not be floored; the same text with danger appended past
    // 300 chars must be seen. If the cap were still 300 these two would be identical.
    expect(JSON.stringify(nearMiss)).not.toBe(JSON.stringify(farDanger))
  })
})
