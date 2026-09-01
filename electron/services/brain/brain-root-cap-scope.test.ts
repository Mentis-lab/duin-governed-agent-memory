import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadBrain,
  BRAIN_GROUNDING_CHAR_CAP,
  BRAIN_DIRNAME,
  BRAIN_MEMORY_DIR
} from './brain-root'

// SCOPE PIN for BRAIN_GROUNDING_CHAR_CAP.
//
// THE DEFECT THIS LOCKS DOWN was a documentation defect, which is why no existing test caught it:
// the constant's docblock said "Total character cap on the concatenated identity+memory grounding
// block", but `loadBrain` only ever budgets the MEMORY half. Identity — SOUL.md + BRAIN.md + ME.md,
// or the legacy `.brain/identity.md` — is returned at whatever length it was authored, on every
// path, and `agui-grounding` puts the assembled block in the compiler's 'floor' tier, which is
// exempt from budget compression. So a reader who trusted the docblock would budget the system
// prompt against a bound that does not exist.
//
// The fix chosen was (b) from the item: state the real scope rather than implement the stated one,
// because uncapped identity is the deliberate product decision (the operator hand-authors those
// files and controls their size). That fix is a COMMENT, so it cannot fail a behavioural test on
// its own — this file instead pins the two halves of the contract the comment now states, so the
// comment and the code can never drift apart again in either direction:
//
//   (1) identity is UNCAPPED  — a 200 KB SOUL.md comes back whole;
//   (2) memory IS capped      — oversized memory bodies are trimmed under the cap.
//
// If someone later implements a real identity budget, (1) fails and forces the docblock to move
// with the code. If someone removes the memory budget, (2) fails. Either way the file stays honest.

let vault: string

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'brain-root-cap-scope-'))
})
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** A body of exactly `n` chars that survives `.trim()` unchanged. */
const filler = (n: number): string => 'x'.repeat(n)

describe('BRAIN_GROUNDING_CHAR_CAP — documented scope is MEMORY only', () => {
  it('does NOT cap identity: a 200 KB SOUL.md is returned whole', () => {
    const soul = filler(200_000)
    writeFileSync(join(vault, 'SOUL.md'), soul, 'utf-8')

    const loaded = loadBrain(vault)
    expect(loaded).not.toBeNull()
    // The documented guarantee: identity is intentionally unbounded. This is an ASSERTION OF THE
    // DOCBLOCK, not an endorsement of unbounded prompts — see the docblock for why the operator
    // authoring these files is what makes it safe.
    expect(loaded!.identity.length).toBeGreaterThan(BRAIN_GROUNDING_CHAR_CAP)
    expect(loaded!.identity).toContain(soul)
    expect(loaded!.identityFiles).toEqual([join(vault, 'SOUL.md')])
  })

  it('DOES cap memory: oversized memory bodies are trimmed under the cap', () => {
    writeFileSync(join(vault, 'SOUL.md'), 'i am duin', 'utf-8')
    const memDir = join(vault, BRAIN_DIRNAME, BRAIN_MEMORY_DIR)
    mkdirSync(memDir, { recursive: true })
    // Three bodies whose total (12 000) is double the cap; smallest-first retention keeps two.
    writeFileSync(join(memDir, 'a.md'), filler(4000), 'utf-8')
    writeFileSync(join(memDir, 'b.md'), filler(4000), 'utf-8')
    writeFileSync(join(memDir, 'c.md'), filler(4000), 'utf-8')

    const loaded = loadBrain(vault)
    expect(loaded).not.toBeNull()
    const memChars = loaded!.memory.reduce((n, s) => n + s.length, 0)
    expect(memChars).toBeLessThanOrEqual(BRAIN_GROUNDING_CHAR_CAP)
    expect(loaded!.memory.length).toBeLessThan(3)
  })

  it('the two halves are budgeted INDEPENDENTLY — a huge identity does not evict memory', () => {
    // The asymmetry is the whole point of the docblock: were the cap really "identity+memory",
    // a 200 KB SOUL.md would leave zero budget and the memory block would come back empty.
    writeFileSync(join(vault, 'SOUL.md'), filler(200_000), 'utf-8')
    const memDir = join(vault, BRAIN_DIRNAME, BRAIN_MEMORY_DIR)
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, 'small.md'), 'a durable memory', 'utf-8')

    const loaded = loadBrain(vault)
    expect(loaded).not.toBeNull()
    expect(loaded!.memory).toContain('a durable memory')
  })
})
