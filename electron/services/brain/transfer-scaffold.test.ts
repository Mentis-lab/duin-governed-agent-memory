import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scaffoldNewOperatorBrain } from './transfer-scaffold'
import { hasColdStarted, coldStartMarkerPath } from './cold-start-seed'
import { setOperatorModelPath, getAllOperatorFacts, __resetOperatorModel } from './operator-model'

// #4a — the orchestrated PER-VAULT first-run flow. We prove: it chains
// ensureBrainRoot → identity → seed → per-vault marker; it's idempotent (a
// second run is a no-op); and two vaults seed INDEPENDENTLY (the whole point —
// a second operator's vault must not be blocked by a first install's flag).
// Temp dirs only, no app, no electron. We skip `rawSrcDir` here so the flow
// stays keyless/offline (scaffoldHarness's LLM passes aren't exercised).

const ME_MD = ['---', 'type: identity', '---', '', '# Gao', '', '发行负责人', ''].join('\n')
const BRAIN_MD = ['---', 'type: operating-instructions', '---', '', '# BRAIN', '', '- Ground answers in the vault', ''].join('\n')

/** Write a couple of operator-identity cards so seedFromVault has fuel. `tag`
 *  varies the card text so distinct operators produce distinct (non-deduped)
 *  facts in the shared per-install operator store. */
function seedVaultCards(vaultDir: string, tag = 'A'): void {
  const rules = join(vaultDir, 'DUIN', 'Rules')
  mkdirSync(rules, { recursive: true })
  writeFileSync(
    join(rules, 'v-truth-over-comfort.md'),
    `---\ntype: value\nname: Truth over comfort ${tag}\nstatus: validated\n---\n\n# Value\n\n**Statement:** Go looking for the read that proves you wrong (${tag}).\n`
  )
  writeFileSync(
    join(rules, 's-organic-structure.md'),
    `---\ntype: structure-principle\nname: Organic structure ${tag}\nstatus: draft\n---\n\n# Structure\n\n**Principle:** Let structure emerge from where work accumulates (${tag}).\n`
  )
}

describe('transfer-scaffold — scaffoldNewOperatorBrain (#4a)', () => {
  let dir: string
  let userData: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-newop-'))
    userData = mkdtempSync(join(tmpdir(), 'duin-ud-'))
    setOperatorModelPath(userData) // isolate the operator-fact store per test
    __resetOperatorModel()
  })
  afterEach(() => {
    for (const d of [dir, userData]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('chains root → identity → seed → per-vault marker on a fresh vault', async () => {
    seedVaultCards(dir)
    const res = await scaffoldNewOperatorBrain(dir, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })

    expect(res.ok).toBe(true)
    expect(res.alreadySetUp).toBeFalsy()
    // .brain/ root created
    expect(existsSync(join(dir, '.brain', 'memory'))).toBe(true)
    expect(existsSync(join(dir, '.brain', 'state'))).toBe(true)
    // identity written
    expect(res.foundationWritten).toEqual(['BRAIN.md', 'ME.md'])
    expect(readFileSync(join(dir, 'ME.md'), 'utf-8')).toContain('发行负责人')
    // seeded from the vault's Rules cards
    expect(res.seededFacts).toBeGreaterThan(0)
    expect(getAllOperatorFacts().some((f) => f.fact.includes('Truth over comfort'))).toBe(true)
    // per-vault marker set, inside THIS vault's .brain/state/
    expect(res.marker).toBe(true)
    expect(existsSync(coldStartMarkerPath(dir)!)).toBe(true)
    expect(hasColdStarted(dir)).toBe(true)
  })

  it('is idempotent: a second run is a no-op (alreadySetUp), no re-seed', async () => {
    seedVaultCards(dir)
    const first = await scaffoldNewOperatorBrain(dir, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
    expect(first.seededFacts).toBeGreaterThan(0)
    const factsAfterFirst = getAllOperatorFacts().length

    const second = await scaffoldNewOperatorBrain(dir, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
    expect(second.ok).toBe(true)
    expect(second.alreadySetUp).toBe(true)
    expect(second.foundationWritten).toEqual([])
    expect(second.seededFacts).toBe(0)
    // no duplicate facts from the re-run
    expect(getAllOperatorFacts().length).toBe(factsAfterFirst)
  })

  it('no-clobber: a hand-written ME.md survives (identity skipped when no scaffold ran)', async () => {
    writeFileSync(join(dir, 'ME.md'), '# My own identity\n', 'utf-8')
    const res = await scaffoldNewOperatorBrain(dir, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
    expect(res.ok).toBe(true)
    // overwrite defaults to false with no rawSrcDir → the user's file is preserved
    expect(res.foundationWritten).toEqual(['BRAIN.md'])
    expect(readFileSync(join(dir, 'ME.md'), 'utf-8')).toContain('My own identity')
  })

  it('PER-VAULT isolation: a SECOND vault seeds independently of the first', async () => {
    // First operator's vault set up.
    seedVaultCards(dir)
    const a = await scaffoldNewOperatorBrain(dir, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
    expect(a.marker).toBe(true)

    // Second operator's vault — its OWN marker must be absent until IT runs,
    // and it must seed on its own (this is exactly what the global flag broke).
    const dir2 = mkdtempSync(join(tmpdir(), 'duin-newop2-'))
    try {
      seedVaultCards(dir2, 'B')
      expect(hasColdStarted(dir2)).toBe(false) // not blocked by vault #1's marker
      const b = await scaffoldNewOperatorBrain(dir2, { identity: { meMd: ME_MD, brainMd: BRAIN_MD } })
      expect(b.ok).toBe(true)
      expect(b.alreadySetUp).toBeFalsy()
      expect(b.seededFacts).toBeGreaterThan(0)
      expect(hasColdStarted(dir2)).toBe(true)
      // markers are distinct files under each vault's own .brain/state/
      expect(coldStartMarkerPath(dir2)).not.toBe(coldStartMarkerPath(dir))
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }
  })

  it('errors cleanly on an empty vaultDir', async () => {
    const res = await scaffoldNewOperatorBrain('')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/vaultDir is required/)
  })
})
