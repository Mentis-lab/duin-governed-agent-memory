import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  conceptForFact,
  materializeConcept,
  retireConcept,
  backfillConcepts,
  reconcileConcepts,
  conceptMemoryDir,
  exportBrainBundle,
  seamEnabled,
  seamEntityEdgesEnabled,
  matchEntities,
  assembleEntityCatalog,
  makeMaterializeHook,
  type EntityCatalogEntry
} from './concept-materialize'
import type { OperatorFact } from './operator-model'

function fact(over: Partial<OperatorFact> = {}): OperatorFact {
  return {
    id: 'f_test1',
    fact: 'TQ prefers conclusion-first, high-density replies.',
    kind: 'preference',
    status: 'promoted',
    ts: 1_700_000_000_000,
    source: 'operator',
    ...over
  } as OperatorFact
}

describe('concept-materialize (the seam)', () => {
  let tmp: string
  let memoryDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'seam-'))
    memoryDir = join(tmp, '.brain', 'memory')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  it('conceptForFact maps a fact to typed OKF frontmatter + body', () => {
    const { slug, md } = conceptForFact(fact(), '2026-07-24')
    expect(slug).toBe('concept-f_test1.md')
    expect(md).toContain('type: learned')
    expect(md).toContain('factId: f_test1')
    expect(md).toContain('TQ prefers conclusion-first')
    expect(md).toContain('generated: duin-seam') // machine-owned marker
  })

  it('materializeConcept writes the concept file, idempotent by slug', () => {
    const p1 = materializeConcept(fact(), memoryDir)
    expect(p1).not.toBeNull()
    expect(existsSync(p1!)).toBe(true)
    const p2 = materializeConcept(fact({ fact: 'updated claim text' }), memoryDir)
    expect(p2).toBe(p1) // same slug — overwrite, never duplicate
    expect(readFileSync(p1!, 'utf-8')).toContain('updated claim text')
  })

  it('never clobbers a hand-authored file that owns the slug', () => {
    mkdirSync(memoryDir, { recursive: true })
    const full = join(memoryDir, 'concept-f_test1.md')
    writeFileSync(full, '# hand written — no marker\n', 'utf-8')
    const r = materializeConcept(fact(), memoryDir)
    expect(r).toBeNull()
    expect(readFileSync(full, 'utf-8')).toContain('hand written')
  })

  it('retireConcept moves the concept OUTSIDE memory/ (into .brain/_retired) so it stops grounding', () => {
    const p = materializeConcept(fact(), memoryDir)!
    const dest = retireConcept(fact(), memoryDir)
    expect(dest).not.toBeNull()
    expect(existsSync(p)).toBe(false) // gone from the grounding/retrieval lane (memory/)
    // retired lane is a SIBLING of memory/, not a subdir — the grounding + retrieval collectors
    // walk memory/, so a subdir would still be read. It must live outside memory/.
    expect(existsSync(join(memoryDir, '_retired', 'concept-f_test1.md'))).toBe(false)
    expect(existsSync(join(tmp, '.brain', '_retired', 'concept-f_test1.md'))).toBe(true)
  })

  it('reconcileConcepts materializes the promoted set AND retires orphaned concepts', () => {
    // materialize a, b, c
    backfillConcepts([fact({ id: 'a' }), fact({ id: 'b' }), fact({ id: 'c' })], memoryDir)
    // now only a + b are promoted → c must be retired out of memory/
    const r = reconcileConcepts([fact({ id: 'a' }), fact({ id: 'b' })], memoryDir)
    expect(r.retired).toBe(1)
    expect(existsSync(join(memoryDir, 'concept-c.md'))).toBe(false)
    expect(existsSync(join(tmp, '.brain', '_retired', 'concept-c.md'))).toBe(true)
    expect(existsSync(join(memoryDir, 'concept-a.md'))).toBe(true)
    expect(existsSync(join(memoryDir, 'concept-b.md'))).toBe(true)
  })

  it('retire is a no-op on an absent or hand-authored concept', () => {
    expect(retireConcept(fact(), memoryDir)).toBeNull() // absent
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'concept-f_test1.md'), 'hand\n', 'utf-8')
    expect(retireConcept(fact(), memoryDir)).toBeNull() // hand-authored untouched
  })

  it('backfillConcepts materializes a set of promoted facts', () => {
    const facts = [fact({ id: 'a' }), fact({ id: 'b' }), fact({ id: 'c' })]
    const r = backfillConcepts(facts, memoryDir)
    expect(r.written).toBe(3)
    expect(existsSync(join(memoryDir, 'concept-a.md'))).toBe(true)
    expect(existsSync(join(memoryDir, 'concept-c.md'))).toBe(true)
  })

  it('exportBrainBundle copies the durable lanes with a manifest', () => {
    materializeConcept(fact(), memoryDir)
    mkdirSync(join(tmp, '.brain', '_moat'), { recursive: true })
    writeFileSync(join(tmp, '.brain', '_moat', 'operator-model.json'), '{"facts":[]}', 'utf-8')
    const r = exportBrainBundle(tmp, '2026-07-24-00-00-00')
    expect(r.ok).toBe(true)
    expect(r.copied).toContain('memory')
    expect(r.copied).toContain('_moat')
    expect(existsSync(join(r.bundleDir!, 'manifest.json'))).toBe(true)
    expect(existsSync(join(r.bundleDir!, 'memory', 'concept-f_test1.md'))).toBe(true)
  })

  // The bundle exists for offboarding / device migration / IP custody, so shipping it without
  // the operator's identity is the one failure that voids it. It read the identity files from
  // `.brain/` while they live at the VAULT ROOT, so it copied none of them — and said ok.
  // Measured on the live vault 2026-07-30: SOUL/BRAIN/ME/GOALS/MEMORY all at root, `.brain/`
  // holding only config.json, so the bundle carried config.json alone.
  it('exportBrainBundle carries the identity files, which live at the VAULT ROOT', () => {
    mkdirSync(join(tmp, '.brain'), { recursive: true })
    for (const f of ['SOUL.md', 'BRAIN.md', 'ME.md', 'GOALS.md', 'MEMORY.md']) {
      writeFileSync(join(tmp, f), `# ${f}\nidentity content`, 'utf-8')
    }
    writeFileSync(join(tmp, '.brain', 'config.json'), '{"v":1}', 'utf-8')

    const r = exportBrainBundle(tmp, '2026-07-24-00-00-00')

    expect(r.ok).toBe(true)
    for (const f of ['SOUL.md', 'BRAIN.md', 'ME.md', 'GOALS.md', 'MEMORY.md']) {
      expect(r.copied).toContain(f)
      expect(readFileSync(join(r.bundleDir!, f), 'utf-8')).toContain('identity content')
    }
    expect(r.copied).toContain('config.json') // this one really does live in .brain/
  })

  it('exportBrainBundle reports what it could not find instead of silently omitting it', () => {
    mkdirSync(join(tmp, '.brain'), { recursive: true })
    writeFileSync(join(tmp, 'SOUL.md'), '# SOUL', 'utf-8') // identity core present, rest absent

    const r = exportBrainBundle(tmp, '2026-07-24-00-00-00')

    expect(r.copied).toContain('SOUL.md')
    expect(r.missing).toContain('GOALS.md')
    expect(r.missing).toContain('config.json')
    // The manifest records the gap too, so a bundle opened months later is self-describing.
    const manifest = JSON.parse(readFileSync(join(r.bundleDir!, 'manifest.json'), 'utf-8'))
    expect(manifest.missing).toContain('GOALS.md')
    expect(manifest.vault).toBe(tmp)
  })

  it('exportBrainBundle accepts the pre-migration lowercase me.md', () => {
    mkdirSync(join(tmp, '.brain'), { recursive: true })
    writeFileSync(join(tmp, 'me.md'), '# me', 'utf-8')

    const r = exportBrainBundle(tmp, '2026-07-24-00-00-00')

    // Which SPELLING lands is filesystem-dependent — Windows resolves `ME.md` to the same file
    // and takes the exact-name branch, Linux needs the lowercase fallback. What must hold on
    // both is that the operator is not lost: it is carried, and not reported missing.
    expect(r.missing).not.toContain('ME.md')
    const landed = (r.copied ?? []).find((f) => f.toLowerCase() === 'me.md')
    expect(landed).toBeDefined()
    expect(readFileSync(join(r.bundleDir!, landed!), 'utf-8')).toBe('# me')
  })

  it('conceptMemoryDir resolves the vault .brain/memory lane; null on empty', () => {
    expect(conceptMemoryDir('/vault')).toBe(join('/vault', '.brain', 'memory'))
    expect(conceptMemoryDir('')).toBeNull()
    expect(conceptMemoryDir(null)).toBeNull()
  })

  it('the hook fires onWrite after each governed transition — and a throwing onWrite never escapes', () => {
    const prev = process.env.DUIN_SEAM_MATERIALIZE
    try {
      process.env.DUIN_SEAM_MATERIALIZE = '1'
      const seen: string[] = []
      const hook = makeMaterializeHook(() => tmp, (a) => seen.push(a))
      hook(fact(), 'promote')
      hook(fact(), 'retire')
      expect(seen).toEqual(['promote', 'retire'])

      delete process.env.DUIN_SEAM_MATERIALIZE
      hook(fact(), 'promote')
      expect(seen.length).toBe(2) // seam off ⇒ no write, no schedule

      process.env.DUIN_SEAM_MATERIALIZE = '1'
      const boom = makeMaterializeHook(() => tmp, () => { throw new Error('scheduler down') })
      expect(() => boom(fact(), 'promote')).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.DUIN_SEAM_MATERIALIZE
      else process.env.DUIN_SEAM_MATERIALIZE = prev
    }
  })

  it('the hook is flag-gated (default OFF → no write) and never throws', () => {
    const prev = process.env.DUIN_SEAM_MATERIALIZE
    try {
      delete process.env.DUIN_SEAM_MATERIALIZE
      expect(seamEnabled()).toBe(false)
      const hook = makeMaterializeHook(() => tmp)
      hook(fact(), 'promote')
      expect(existsSync(join(memoryDir, 'concept-f_test1.md'))).toBe(false) // gated off

      process.env.DUIN_SEAM_MATERIALIZE = '1'
      expect(seamEnabled()).toBe(true)
      hook(fact(), 'promote')
      expect(existsSync(join(memoryDir, 'concept-f_test1.md'))).toBe(true)

      // never throws even with a broken getter
      const bad = makeMaterializeHook(() => { throw new Error('boom') })
      expect(() => bad(fact(), 'promote')).not.toThrow()
    } finally {
      if (prev === undefined) delete process.env.DUIN_SEAM_MATERIALIZE
      else process.env.DUIN_SEAM_MATERIALIZE = prev
    }
  })
})

// ─────────────────────────── seam edge-projection (T0+T1) ───────────────────────────
// The 2026-08-12 md2hd trial over the live bundle showed the projection gap: 49 concepts,
// zero edges except the machine index star. These tests pin the fix: concepts carry an
// OKF `id:` (T0) and machine-owned relations derived from the moat (T1) — kind→pillar
// links, supersession lineage, and a concept-index that stays fresh on reconcile.
describe('seam edge-projection (T0+T1)', () => {
  let tmp: string
  let memoryDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'seam-edges-'))
    memoryDir = join(tmp, '.brain', 'memory')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  it('T0: emits a top-level OKF id equal to the filename stem', () => {
    const { slug, md } = conceptForFact(fact(), '2026-08-12')
    expect(slug).toBe('concept-f_test1.md')
    expect(md).toContain('\nid: concept-f_test1\n')
  })

  it('T1a: body carries a machine-owned Relations section with exactly one pillar link by kind', () => {
    const cases: Array<[string, string]> = [
      ['correction', '_about-instincts'],
      ['preference', '_about-instincts'],
      ['principle', '_about-instincts'],
      ['goal', '_about-planning'],
      ['context', '_about-knowledge'],
      ['some-future-kind', '_about-knowledge'] // kind is an open string — unknown falls back
    ]
    for (const [kind, pillar] of cases) {
      const { md } = conceptForFact(fact({ kind }))
      expect(md, `kind=${kind}`).toContain('## Relations')
      expect(md, `kind=${kind}`).toContain(`- [[${pillar}]] — pillar`)
      // exactly ONE pillar line — deterministic, no hairball
      expect(md.match(/— pillar/g)!.length, `kind=${kind}`).toBe(1)
    }
  })

  it('T1b: ctx.supersedes renders as frontmatter metadata (ids only — targets are retired, no dangling links)', () => {
    const { md } = conceptForFact(fact(), '2026-08-12', { supersedes: ['f_old1', 'f_old2'] })
    expect(md).toContain('supersedes: [f_old1, f_old2]')
    expect(md).not.toContain('[[concept-f_old1]]') // never a body link into _retired/
  })

  it('T1b: retiring a superseded fact writes a tombstone that names its successor', () => {
    materializeConcept(fact(), memoryDir)
    const dest = retireConcept(fact({ supersededBy: 'f_new9', invalidatedAt: 1_800_000_000_000 }), memoryDir)
    expect(dest).not.toBeNull()
    const tomb = readFileSync(join(tmp, '.brain', '_retired', 'concept-f_test1.md'), 'utf-8')
    expect(tomb).toContain('supersededBy: f_new9')
  })

  it('T1b: reconcile with the full fact list renders reverse supersession lineage on the live concept', () => {
    const oldFact = fact({
      id: 'f_old',
      fact: 'TQ prefers terse replies.',
      supersededBy: 'f_new',
      invalidatedAt: 1_800_000_000_000
    })
    const newFact = fact({ id: 'f_new', fact: 'TQ prefers conclusion-first, high-density replies.' })
    reconcileConcepts([newFact], memoryDir, [newFact, oldFact])
    const live = readFileSync(join(memoryDir, 'concept-f_new.md'), 'utf-8')
    expect(live).toContain('supersedes: [f_old]')
  })

  it('T1c: reconcile regenerates _concept-index.md so the index never goes stale on the seam path', () => {
    reconcileConcepts([fact({ id: 'a' }), fact({ id: 'b' })], memoryDir)
    const idx = join(memoryDir, '_concept-index.md')
    expect(existsSync(idx)).toBe(true)
    const body = readFileSync(idx, 'utf-8')
    expect(body).toContain('[[concept-a]]')
    expect(body).toContain('[[concept-b]]')
  })

  it('T0+T1 stay idempotent: re-materializing with identical inputs is byte-identical', () => {
    const a = conceptForFact(fact({ kind: 'correction' }), '2026-08-12', { supersedes: ['f_old'] })
    const b = conceptForFact(fact({ kind: 'correction' }), '2026-08-12', { supersedes: ['f_old'] })
    expect(a.md).toBe(b.md)
  })
})

// ─────────────────────────── seam entity projection (T2) ───────────────────────────
// Belief→entity edges projected from the entity plane's KNOWN catalog (store live nodes +
// resolver whitelist, assembled by the route behind DUIN_SEAM_ENTITY_EDGES). The seam stays
// pure: the catalog comes IN as data; matching is deterministic label/alias matching (v1 —
// no embedder, per T2 design note Q3).
describe('seam entity projection (T2)', () => {
  let tmp: string
  let memoryDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'seam-entity-'))
    memoryDir = join(tmp, '.brain', 'memory')
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  const CATALOG: EntityCatalogEntry[] = [
    { label: 'Beilan', entityId: 'project:beilan', kind: 'project', aliases: ['北澜', '《北澜》'] },
    { label: 'Dana Whitfield', entityId: 'person:dana-whitfield', kind: 'person' },
    { label: 'DUIN', kind: 'project' }
  ]

  it('matchEntities: latin labels match on word boundaries, not substrings', () => {
    expect(matchEntities('Works on the Beilan launch plan.', CATALOG).map((e) => e.label)).toEqual(['Beilan'])
    expect(matchEntities('The beilanlike project.', CATALOG)).toEqual([]) // no substring hits
    expect(matchEntities('Ships DUIN weekly.', CATALOG).map((e) => e.label)).toEqual(['DUIN'])
  })

  it('matchEntities: CJK aliases match by containment and resolve to the canonical entry', () => {
    const hits = matchEntities('推进《北澜》二测的BD节奏', CATALOG)
    expect(hits.map((e) => e.label)).toEqual(['Beilan'])
  })

  it('matchEntities: an apostrophe is not a word boundary — "Don" must not match "don\'t"', () => {
    const cat: EntityCatalogEntry[] = [{ label: 'Don', kind: 'person' }]
    expect(matchEntities("press, don't pivot", cat)).toEqual([])
    expect(matchEntities('Met Don at the expo.', cat).map((e) => e.label)).toEqual(['Don'])
  })

  it('reconcile honors minRefs: auto entities need ≥2 distinct believing concepts, and below-bar hits emit no about-link', () => {
    const cat: EntityCatalogEntry[] = [{ label: 'Windows', kind: 'org', minRefs: 2 }]
    const one = fact({ id: 'w1', fact: 'Tracks decision Windows carefully.' })
    reconcileConcepts([one], memoryDir, undefined, cat)
    expect(existsSync(join(memoryDir, 'entity-windows.md'))).toBe(false)
    expect(readFileSync(join(memoryDir, 'concept-w1.md'), 'utf-8')).not.toContain('— about')
    const two = fact({ id: 'w2', fact: 'Ships Windows builds weekly.' })
    reconcileConcepts([one, two], memoryDir, undefined, cat)
    expect(existsSync(join(memoryDir, 'entity-windows.md'))).toBe(true)
    expect(readFileSync(join(memoryDir, 'concept-w1.md'), 'utf-8')).toContain('- [[entity-windows]] — about')
  })

  it('matchEntities: short/noisy surface forms are guarded; output is deduped + deterministic', () => {
    const noisy: EntityCatalogEntry[] = [
      { label: 'a', kind: 'project' }, // 1-char latin — never matches
      { label: 'of', kind: 'org' }, // 2-char lowercase latin — never matches
      { label: 'Beilan', aliases: ['beilan', 'BEILAN'] } // alias dupes → one hit
    ]
    expect(matchEntities('a of Beilan beilan', noisy).map((e) => e.label)).toEqual(['Beilan'])
  })

  it('conceptForFact ctx.entities renders about-links after the pillar line, sorted', () => {
    const { md } = conceptForFact(fact(), '2026-08-12', {
      entities: [
        { slug: 'entity-beilan', label: 'Beilan' },
        { slug: 'entity-dana-whitfield', label: 'Dana Whitfield' }
      ]
    })
    expect(md).toContain('- [[entity-dana-whitfield]] — about')
    expect(md).toContain('- [[entity-beilan]] — about')
    expect(md.indexOf('— pillar')).toBeLessThan(md.indexOf('entity-beilan'))
    expect(md.indexOf('entity-beilan')).toBeLessThan(md.indexOf('entity-dana-whitfield'))
  })

  it('reconcile with a catalog materializes entity files with reverse links and typed frontmatter', () => {
    const f1 = fact({ id: 'w1', fact: 'Works on the Beilan launch.', kind: 'context' })
    const f2 = fact({ id: 'w2', fact: '北澜 BD cadence owned by Dana Whitfield.', kind: 'context' })
    reconcileConcepts([f1, f2], memoryDir, undefined, CATALOG)
    const ent = readFileSync(join(memoryDir, 'entity-beilan.md'), 'utf-8')
    expect(ent).toContain('id: entity-beilan')
    expect(ent).toContain('type: project')
    expect(ent).toContain('generated-by: duin-seam')
    expect(ent).toContain('- [[concept-w1]] — believed')
    expect(ent).toContain('- [[concept-w2]] — believed')
    const person = readFileSync(join(memoryDir, 'entity-dana-whitfield.md'), 'utf-8')
    expect(person).toContain('type: person')
    expect(person).toContain('- [[_about-people]] — pillar') // person/org entities hub into the people pillar
    // and the believing concept links out to the entity
    expect(readFileSync(join(memoryDir, 'concept-w1.md'), 'utf-8')).toContain('- [[entity-beilan]] — about')
  })

  it('reconcile retires an entity file once nothing live references it (retire-not-delete)', () => {
    const f1 = fact({ id: 'w1', fact: 'Works on the Beilan launch.' })
    reconcileConcepts([f1], memoryDir, undefined, CATALOG)
    expect(existsSync(join(memoryDir, 'entity-beilan.md'))).toBe(true)
    const f3 = fact({ id: 'n1', fact: 'Prefers quiet mornings.' })
    reconcileConcepts([f3], memoryDir, undefined, CATALOG)
    expect(existsSync(join(memoryDir, 'entity-beilan.md'))).toBe(false)
    expect(existsSync(join(tmp, '.brain', '_retired', 'entity-beilan.md'))).toBe(true)
  })

  it('never clobbers a hand-authored entity file that owns the slug', () => {
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(join(memoryDir, 'entity-beilan.md'), '# my own beilan note\n', 'utf-8')
    reconcileConcepts([fact({ id: 'w1', fact: 'Works on the Beilan launch.' })], memoryDir, undefined, CATALOG)
    expect(readFileSync(join(memoryDir, 'entity-beilan.md'), 'utf-8')).toContain('my own beilan note')
  })

  it('omitting the catalog keeps T1 behavior exactly: no entity files, no about-links, none retired', () => {
    reconcileConcepts([fact({ id: 'w1', fact: 'Works on the Beilan launch.' })], memoryDir)
    expect(existsSync(join(memoryDir, 'entity-beilan.md'))).toBe(false)
    expect(readFileSync(join(memoryDir, 'concept-w1.md'), 'utf-8')).not.toContain('— about')
    // a pre-existing entity file is LEFT ALONE when the catalog is absent (flag off ≠ retire-all)
    writeFileSync(join(memoryDir, 'entity-stale.md'), `x\n\n${'<!-- generated: duin-seam · machine-owned · do not hand-edit -->'}\n`, 'utf-8')
    reconcileConcepts([fact({ id: 'w1', fact: 'Works on the Beilan launch.' })], memoryDir)
    expect(existsSync(join(memoryDir, 'entity-stale.md'))).toBe(true)
  })

  // T2.5 — catalog assembly with trust tiers + alias folding. Every junk entity file the live
  // backfill produced traced to ONE flaw: all 891 whitelist groups (869 of them machine-written
  // `auto-kind`) entered at curator trust (minRefs 1, no kind gate).
  describe('assembleEntityCatalog (T2.5)', () => {
    const groups = [
      // hand-authored (no source) — full trust
      { canonicalId: 'project:北澜', canonical: '北澜', aliases: ['《北澜》', 'beilan', 'hokuran'] },
      // machine-appended — same bar as store rows
      { canonicalId: 'org:beilan-project', canonical: 'Beilan Project', aliases: ['Beilan project'], source: 'auto-kind' as const },
      // non-entity kind — gated out entirely, whatever its source
      { canonicalId: 'event:beilan-launch', canonical: 'Beilan Launch', aliases: ['Beilan launch'], source: 'auto-kind' as const },
      { canonicalId: 'decision:tasks', canonical: 'tasks', aliases: [], source: 'auto-kind' as const }
    ]

    it('kind-gates BOTH populations and trust-tiers minRefs (hand=1, auto/store=2)', () => {
      const cat = assembleEntityCatalog(groups, [
        { id: 'n1', label: 'Crunchyroll', kind: 'org', source: 'construction' }
      ])
      const byLabel = new Map(cat.map((e) => [e.label, e]))
      expect(byLabel.get('北澜')?.minRefs ?? 1).toBe(1) // hand group — curator trust
      expect(byLabel.get('Beilan Project')?.minRefs).toBe(2) // auto-kind — machine bar
      expect(byLabel.get('Crunchyroll')?.minRefs).toBe(2) // store row — machine bar
      expect(byLabel.has('Beilan Launch')).toBe(false) // event: kind — gated
      expect(byLabel.has('tasks')).toBe(false) // decision: kind — gated
    })

    it('folds a store row into its whitelist group by alias instead of minting a duplicate entry', () => {
      const cat = assembleEntityCatalog(groups, [
        { id: 'store-9', label: 'Hokuran', kind: 'project', source: 'construction' }
      ])
      expect(cat.filter((e) => e.label === '北澜').length).toBe(1)
      expect(cat.some((e) => e.label === 'Hokuran')).toBe(false) // folded, not separate
    })

    it('keeps unresolved store rows as their own entries and is deterministic', () => {
      const a = assembleEntityCatalog(groups, [
        { id: 'n2', label: 'LionTree', kind: 'org', source: 'construction' },
        { id: 'n1', label: 'Crunchyroll', kind: 'org', source: 'construction' }
      ])
      const b = assembleEntityCatalog(groups, [
        { id: 'n1', label: 'Crunchyroll', kind: 'org', source: 'construction' },
        { id: 'n2', label: 'LionTree', kind: 'org', source: 'construction' }
      ])
      expect(a).toEqual(b)
      expect(a.some((e) => e.label === 'LionTree')).toBe(true)
    })

    it('end-to-end: the beilan trio yields ONE entity file carrying all three beliefs', () => {
      const cat = assembleEntityCatalog(groups, [])
      const facts = [
        fact({ id: 'w1', fact: 'Works on Beilan launch.' }),
        fact({ id: 'w2', fact: 'Works on the Beilan project.' }),
        fact({ id: 'w3', fact: 'Focused on strategic value to Beilan.' })
      ]
      reconcileConcepts(facts, memoryDir, undefined, cat)
      expect(existsSync(join(memoryDir, 'entity-北澜.md'))).toBe(true)
      expect(existsSync(join(memoryDir, 'entity-beilan-project.md'))).toBe(false) // 1 ref < bar
      const ent = readFileSync(join(memoryDir, 'entity-北澜.md'), 'utf-8')
      expect(ent).toContain('- [[concept-w1]] — believed')
      expect(ent).toContain('- [[concept-w2]] — believed')
      expect(ent).toContain('- [[concept-w3]] — believed')
    })
  })

  it('seamEntityEdgesEnabled is flag-gated, default OFF', () => {
    const prev = process.env.DUIN_SEAM_ENTITY_EDGES
    try {
      delete process.env.DUIN_SEAM_ENTITY_EDGES
      expect(seamEntityEdgesEnabled()).toBe(false)
      process.env.DUIN_SEAM_ENTITY_EDGES = '1'
      expect(seamEntityEdgesEnabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.DUIN_SEAM_ENTITY_EDGES
      else process.env.DUIN_SEAM_ENTITY_EDGES = prev
    }
  })
})
