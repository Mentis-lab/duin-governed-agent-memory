import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scaffoldOkf, ensureFoundationSoul } from './okf-scaffold'
import { scanConcepts } from './concept-index'
import { buildGraph } from './build-graph-native'

const memDir = (v: string): string => join(v, '.brain', 'memory')

describe('scaffoldOkf', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-okf-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('seeds foundation + typed pillar concepts + a concept index on a fresh vault', () => {
    const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
    expect(res.ok).toBe(true)
    // Foundation concepts at root.
    expect(existsSync(join(vault, 'BRAIN.md'))).toBe(true)
    expect(existsSync(join(vault, 'ME.md'))).toBe(true)
    expect(existsSync(join(vault, 'GOALS.md'))).toBe(true)
    // Typed pillar _about concepts + the machine-owned index.
    expect(existsSync(join(memDir(vault), '_about-knowledge.md'))).toBe(true)
    expect(res.indexPath).toBe(join(memDir(vault), '_concept-index.md'))
    expect(existsSync(res.indexPath as string)).toBe(true)
    // Every pillar concept is TYPED (no untyped in the bundle).
    const concepts = scanConcepts(memDir(vault))
    expect(concepts.length).toBeGreaterThanOrEqual(8)
    expect(concepts.every((c) => c.type !== '(untyped)')).toBe(true)
    expect(res.conceptsWritten).toBe(concepts.length)
  })

  it('materializes interview answers as typed project/decision/risk concepts', () => {
    scaffoldOkf({
      vaultDir: vault,
      today: '2026-07-12',
      answers: { working: 'Ship v1\nClose Q3 deal', deciding: 'Open the public beta in March', worried: 'Vendor SLA' }
    })
    const byType = (t: string): number => scanConcepts(memDir(vault)).filter((c) => c.type === t).length
    expect(byType('project')).toBeGreaterThanOrEqual(2) // 2 work items
    expect(byType('decision')).toBeGreaterThanOrEqual(1) // the decision
    expect(byType('risk')).toBeGreaterThanOrEqual(1) // the worry
  })

  it('is idempotent + no-clobber: a re-run writes 0 new concepts and preserves edits', () => {
    scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
    // Hand-edit a concept + a foundation file.
    const about = join(memDir(vault), '_about-knowledge.md')
    writeFileSync(about, '---\ntype: knowledge\n---\nMINE — do not clobber\n', 'utf-8')
    const brain = join(vault, 'BRAIN.md')
    writeFileSync(brain, 'MY OWN BRAIN\n', 'utf-8')

    const again = scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
    expect(again.ok).toBe(true)
    expect(again.conceptsWritten).toBe(0)
    expect(readFileSync(about, 'utf-8')).toContain('MINE — do not clobber')
    expect(readFileSync(brain, 'utf-8')).toBe('MY OWN BRAIN\n')
  })

  // ── overwrite:true must PRESERVE before it replaces ────────────────────────────────
  // The defect: putRoot/putConcept read the same `overwrite` flag as writeIdentityFiles
  // (which snapshots to .trash and refuses to write if that fails) but bare-writeFileSync'd
  // over the target — dropping the 275-byte `defaultGoals` stub over an operator's
  // hand-maintained GOALS.md with no snapshot, no tombstone and no diff, reported as a
  // plain success in `wrote`.
  describe('overwrite:true — preserve+record before replacing', () => {
    const HAND_WRITTEN_GOALS = [
      '---',
      'type: goals',
      '---',
      '',
      '# Goals',
      '',
      '## Tracks',
      '- Track 1 — 北澜 BD lead',
      '- Track 2 — M&A consulting',
      '',
      'Graph edges: [[ME]] [[北澜]]',
      ''
    ].join('\n')

    it('snapshots a hand-written GOALS.md to .trash and reports the recovery path', () => {
      const goals = join(vault, 'GOALS.md')
      writeFileSync(goals, HAND_WRITTEN_GOALS, 'utf-8')

      const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-12', overwrite: true })

      expect(res.ok).toBe(true)
      expect(res.wrote).toContain('GOALS.md')
      // The stub did land (overwrite was authorized) …
      expect(readFileSync(goals, 'utf-8')).toContain('*(—)*')
      // … but the operator's months of strategy are recoverable, and the caller is TOLD where.
      const rel = (res.replaced ?? {})['GOALS.md']
      expect(rel).toBeTruthy()
      const preserved = join(vault, ...(rel as string).split('/'))
      expect(existsSync(preserved)).toBe(true)
      expect(readFileSync(preserved, 'utf-8')).toBe(HAND_WRITTEN_GOALS)
      // …and the alteration is traceable: what changed, when, by whom, where it went.
      const journal = readFileSync(join(vault, '.trash', '_tombstones.jsonl'), 'utf-8')
      expect(journal).toContain('GOALS.md')
      expect(journal).toContain('okf-scaffold')
      expect(journal).toContain('"op":"overwrite"')
    })

    it('snapshots a hand-edited .brain/memory concept before replacing it', () => {
      scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
      const about = join(memDir(vault), '_about-knowledge.md')
      writeFileSync(about, '---\ntype: knowledge\n---\nMINE — months of notes\n', 'utf-8')

      const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-12', overwrite: true })

      expect(res.ok).toBe(true)
      const rel = (res.replaced ?? {})['.brain/memory/_about-knowledge.md']
      expect(rel).toBeTruthy()
      expect(readFileSync(join(vault, ...(rel as string).split('/')), 'utf-8')).toContain('MINE — months of notes')
    })

    it('refuses the destructive write when the prior content CANNOT be preserved', () => {
      // .trash occupied by a regular file → snapshotToTrash fails. The safe side is to skip
      // the write, not to proceed blind: the live bytes are the thing at risk.
      const goals = join(vault, 'GOALS.md')
      writeFileSync(goals, HAND_WRITTEN_GOALS, 'utf-8')
      writeFileSync(join(vault, '.trash'), 'not a directory', 'utf-8')

      const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-12', overwrite: true })

      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/could not be preserved/)
      expect(res.skipped).toContain('GOALS.md')
      expect(res.wrote).not.toContain('GOALS.md')
      expect(readFileSync(goals, 'utf-8')).toBe(HAND_WRITTEN_GOALS)
    })

    it('halts when writeIdentityFiles refuses: a failed identity snapshot stops GOALS too', () => {
      // writeIdentityFiles returns ok:false ("could not be preserved") — its deliberate halt
      // signal. scaffoldOkf used to read only .wrote/.skipped and destroy GOALS.md anyway.
      writeFileSync(join(vault, 'BRAIN.md'), '# my own contract\n', 'utf-8')
      const goals = join(vault, 'GOALS.md')
      writeFileSync(goals, HAND_WRITTEN_GOALS, 'utf-8')
      writeFileSync(join(vault, '.trash'), 'not a directory', 'utf-8')

      const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-12', overwrite: true })

      expect(res.ok).toBe(false)
      expect(readFileSync(join(vault, 'BRAIN.md'), 'utf-8')).toBe('# my own contract\n')
      expect(readFileSync(goals, 'utf-8')).toBe(HAND_WRITTEN_GOALS)
    })
  })

  it('feeds the first-run store graph: scaffolded empty vault renders typed concept nodes', () => {
    scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
    const g = buildGraph(vault)
    // The blank vault now renders a NON-empty, namespaced concept skeleton.
    expect(g.nodes.length).toBeGreaterThan(0)
    expect(g.nodes.every((n) => n.id.startsWith('concept:'))).toBe(true)
    expect(g.folders).toContain('.concepts')
    // BRAIN foundation is the hub — everything links toward it.
    const brain = g.nodes.find((n) => n.id === 'concept:BRAIN')
    expect(brain).toBeTruthy()
    expect(g.links.some((l) => l.target === 'concept:BRAIN')).toBe(true)
    // Typedness rides in note_tags.
    expect(g.note_tags['concept:BRAIN']).toEqual(['operating-instructions'])
  })

  it('does NOT emit concept nodes once the vault has a real note (supplement is cold-start only)', () => {
    // A real user note means the vault is populated → the concept skeleton must
    // not fire; foundation files render exactly as before (raw nodes).
    writeFileSync(join(vault, 'real-note.md'), '# Real\n', 'utf-8')
    scaffoldOkf({ vaultDir: vault, today: '2026-07-12' })
    const g = buildGraph(vault)
    expect(g.nodes.some((n) => n.id.startsWith('concept:'))).toBe(false)
    expect(g.folders).not.toContain('.concepts')
    expect(g.nodes.some((n) => n.id === 'real-note.md')).toBe(true)
  })
})

// SOUL.md — DUIN's character file. Distinct from BRAIN.md (rules): a rule is
// followed literally, character generalizes to what no rule covered. These tests
// pin the two properties that make it real rather than decorative: it is written
// on a fresh scaffold, and it is BACKFILLED into vaults adopted before it existed
// (otherwise it ships to new users only — built, but default-off for everyone
// who already had a vault).
describe('SOUL.md foundation', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-soul-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('scaffolds SOUL.md alongside the other foundation files', () => {
    const res = scaffoldOkf({ vaultDir: vault, today: '2026-07-30' })
    expect(res.ok).toBe(true)
    const soul = join(vault, 'SOUL.md')
    expect(existsSync(soul)).toBe(true)
    const body = readFileSync(soul, 'utf-8')
    expect(body).toContain('type: soul')
    // A blank template would train the agent to have no voice — assert real content.
    expect(body).toContain('## Character')
    expect(body).toContain('## Voice')
    expect(body.length).toBeGreaterThan(500)
  })

  it('is a graph hub like the other foundations, typed as soul', () => {
    scaffoldOkf({ vaultDir: vault, today: '2026-07-30' })
    const g = buildGraph(vault)
    expect(g.nodes.some((n) => n.id === 'concept:SOUL')).toBe(true)
    expect(g.note_tags['concept:SOUL']).toEqual(['soul'])
  })

  it('backfills an already-onboarded vault that predates SOUL.md', () => {
    // Simulate a vault adopted before this feature: foundations present, no SOUL.
    scaffoldOkf({ vaultDir: vault, today: '2026-07-30' })
    rmSync(join(vault, 'SOUL.md'))
    expect(ensureFoundationSoul(vault, '2026-07-30')).toEqual({ created: true })
    expect(existsSync(join(vault, 'SOUL.md'))).toBe(true)
  })

  it('never clobbers an operator-edited SOUL.md', () => {
    const soul = join(vault, 'SOUL.md')
    writeFileSync(join(vault, 'BRAIN.md'), '# Brain\n', 'utf-8')
    writeFileSync(soul, 'MINE — hand written\n', 'utf-8')
    expect(ensureFoundationSoul(vault, '2026-07-30')).toEqual({ created: false })
    expect(readFileSync(soul, 'utf-8')).toBe('MINE — hand written\n')
  })

  it('does not litter a directory that is not an adopted vault', () => {
    // No BRAIN.md → not a DUIN vault. Seeding character files here would be litter.
    expect(ensureFoundationSoul(vault, '2026-07-30')).toEqual({ created: false })
    expect(existsSync(join(vault, 'SOUL.md'))).toBe(false)
    expect(ensureFoundationSoul(join(vault, 'nope'), '2026-07-30')).toEqual({ created: false })
    expect(ensureFoundationSoul(null)).toEqual({ created: false })
  })
})
