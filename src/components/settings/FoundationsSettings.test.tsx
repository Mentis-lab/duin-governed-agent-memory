import { describe, it, expect } from 'vitest'
import {
  FOUNDATION_FILES,
  capState,
  memoryNearCap,
  MEMORY_GROUNDING_CAP,
  AGENTS_MD_CAP
} from './FoundationsSettings'

// Renderer render tests need jsdom, which this repo's node-only vitest env does not
// provide (see vitest.config.ts). So the pane's behaviour is factored into pure,
// exported helpers and unit-tested here — the cap-indicator state machine and the
// foundation-file config that drives the nav-visible editors — matching the repo's
// existing renderer-test convention (SeedContextChip.test.tsx tests a pure fn).

describe('FoundationsSettings config', () => {
  // SOUL leads: it is read into context ahead of BRAIN.md, because an imperative
  // rule only covers what someone anticipated while character generalizes to the
  // rest — so the pane presents them in the order the model receives them.
  it('drives exactly the four editable foundation files, in SOUL→ME→BRAIN→GOALS order', () => {
    expect(FOUNDATION_FILES.map((f) => f.name)).toEqual(['SOUL.md', 'ME.md', 'BRAIN.md', 'GOALS.md'])
  })

  // The pane used to advertise ME.md as sharing the 6 KB memory budget. It does not:
  // MEMORY_GROUNDING_CAP bounds the MEMORY block (root MEMORY.md + .brain/memory
  // concepts), while SOUL/ME/BRAIN go into the IDENTITY block, which loadBrain never
  // caps and nothing truncates downstream. Only BRAIN.md has a real limit, and only on
  // its second copy — the <agents_md> loader's 20 KB truncation.
  it('surfaces the real caps: identity files uncapped, BRAIN hard 20 KB on its agents_md copy', () => {
    const by = Object.fromEntries(FOUNDATION_FILES.map((f) => [f.name, f]))
    expect(by['SOUL.md'].capChars).toBe(Infinity)
    expect(by['SOUL.md'].capKind).toBe('none')
    expect(by['ME.md'].capChars).toBe(Infinity)
    expect(by['ME.md'].capKind).toBe('none')
    expect(by['BRAIN.md'].capChars).toBe(AGENTS_MD_CAP)
    expect(by['BRAIN.md'].capChars).toBe(20000)
    expect(by['GOALS.md'].capChars).toBe(Infinity)
    // The constant itself is unchanged — it still describes the memory block.
    expect(MEMORY_GROUNDING_CAP).toBe(6000)
  })

  it('every file carries a badge and a non-empty "how this is used" note', () => {
    for (const f of FOUNDATION_FILES) {
      expect(f.badge.length).toBeGreaterThan(0)
      expect(f.howUsed.length).toBeGreaterThan(0)
    }
  })
})

describe('capState — the indicator state machine', () => {
  it('is under below 80% of the cap', () => {
    expect(capState(0, 20000)).toBe('under')
    expect(capState(15999, 20000)).toBe('under')
  })
  it('is near from 80% up to the cap', () => {
    expect(capState(16000, 20000)).toBe('near')
    expect(capState(20000, 20000)).toBe('near')
  })
  it('is over past the cap (21,000-char BRAIN.md ⇒ over)', () => {
    expect(capState(21000, AGENTS_MD_CAP)).toBe('over')
  })
  it('is always under for an uncapped (Infinity) file like GOALS.md', () => {
    expect(capState(1_000_000, Infinity)).toBe('under')
  })
})

describe('memoryNearCap — read-only MEMORY.md eviction warning', () => {
  it('warns at/above 80% of the 6 KB memory grounding budget', () => {
    expect(memoryNearCap(4799)).toBe(false)
    expect(memoryNearCap(4800)).toBe(true) // 80% of 6000
    expect(memoryNearCap(5000)).toBe(true) // the spec's 5,000-char amber case
  })
})
