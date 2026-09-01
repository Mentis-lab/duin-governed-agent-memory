import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

// SOURCE-LOCK: the entity-kind vocabulary is written down in THREE places with no mechanical link
// between them —
//
//   1. `ENTITY_KINDS`                 construct.ts            (the runtime gate)
//   2. `buildConstructionPrompt`      construct.ts            (what the batch extractor is told)
//   3. `buildRevealPrompt`            construct-one-source.ts (what the single-note extractor is told)
//
// Editing (1) alone is worse than doing nothing. `coerceEntityKind` REJECTS an unrecognised kind
// and the entity is filtered out downstream — not defaulted, not logged. So the model, still told
// the old vocabulary by (2) and (3), keeps emitting the removed kind and every one of those
// entities is silently deleted on the construction floor's 24-hour timer.
//
// That is exactly the shape of the `project` removal on 2026-08-04, and the reason this test
// exists rather than a comment asking the next person to remember.

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const construct = read('./construct.ts')
const oneSource = read('./construct-one-source.ts')

/** The runtime Set, as written. */
function runtimeKinds(src: string): string[] {
  const m = /const ENTITY_KINDS = new Set<EntityKind>\(\[([^\]]*)\]\)/.exec(src)
  if (!m) throw new Error('ENTITY_KINDS not found — did its declaration change shape?')
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean)
}

/** The `kind":"a|b|c"` alternation a prompt hands the model. */
function promptKinds(src: string): string[] {
  const m = /"kind":"([a-z|_]+)"/.exec(src)
  if (!m) throw new Error('prompt kind alternation not found')
  return m[1].split('|').filter(Boolean)
}

describe('entity-kind vocabulary stays in lockstep', () => {
  it('the batch prompt offers exactly the kinds the runtime accepts', () => {
    expect(promptKinds(construct).sort()).toEqual(runtimeKinds(construct).sort())
  })

  it('the reveal prompt offers exactly the same kinds as the batch prompt', () => {
    expect(promptKinds(oneSource).sort()).toEqual(promptKinds(construct).sort())
  })

  it('`project` is retired from every site', () => {
    expect(runtimeKinds(construct)).not.toContain('project')
    expect(promptKinds(construct)).not.toContain('project')
    expect(promptKinds(oneSource)).not.toContain('project')
  })

  it('a retired kind is REMAPPED, never merely dropped', () => {
    // Without this, removing a kind deletes entities instead of reclassifying them — silently,
    // because coerceEntityKind returns undefined and the caller filters rather than logs.
    expect(construct).toMatch(/RETIRED_ENTITY_KINDS[\s\S]{0,120}project:\s*'topic'/)
    // …and the remap must be consulted BEFORE the membership test, or it never fires.
    const fn = /function coerceEntityKind[\s\S]*?\n}/.exec(construct)?.[0] ?? ''
    expect(fn.indexOf('RETIRED_ENTITY_KINDS')).toBeGreaterThan(-1)
    expect(fn.indexOf('RETIRED_ENTITY_KINDS')).toBeLessThan(fn.indexOf('ENTITY_KINDS.has'))
  })

  it('every retired kind maps to a kind that is still accepted', () => {
    const accepted = new Set(runtimeKinds(construct))
    const block = /const RETIRED_ENTITY_KINDS[^=]*=\s*\{([^}]*)\}/.exec(construct)?.[1] ?? ''
    const targets = [...block.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(accepted.has(t)).toBe(true)
  })
})
