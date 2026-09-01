import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectNoteFiles } from './index-store'

// The OKF cold-start scaffold writes the user's typed concept skeleton to
// `<vault>/.brain/memory/*.md`. `.brain/` is in SKIP_DIRS (DUIN's own state — _moat
// ledgers, config.json, caches — must NEVER reach retrieval), so those concepts were
// indexed nowhere → un-searchable/un-citable in chat. collectNoteFiles now appends a
// SCOPED carve-out: `.brain/memory/*.md` ONLY. These tests lock that scope — the
// concept notes are collected, and NOTHING else under `.brain/` (moat/config/state,
// any `.json`) leaks in. collectNoteFiles is pure fs (no better-sqlite3), so it runs
// under vitest where the DB ops don't.
describe('collectNoteFiles — .brain/memory carve-out', () => {
  let vault: string
  const rel = (v: string, abs: string): string => abs.slice(v.length + 1).split('\\').join('/')

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-bm-'))
    // A real user note (populated-vault content).
    writeFileSync(join(vault, 'real-note.md'), '# Real\n', 'utf-8')
    // The OKF concept skeleton under .brain/memory.
    mkdirSync(join(vault, '.brain', 'memory'), { recursive: true })
    writeFileSync(join(vault, '.brain', 'memory', '_about-knowledge.md'), '---\ntype: knowledge\n---\nAtomic insights.\n', 'utf-8')
    writeFileSync(join(vault, '.brain', 'memory', '_about-decisions.md'), '---\ntype: decision\n---\nCalls you weigh.\n', 'utf-8')
    writeFileSync(join(vault, '.brain', 'memory', '_concept-index.md'), '---\ntype: concept-index\n---\nindex\n', 'utf-8')
    // DUIN internal state that MUST stay unindexed.
    mkdirSync(join(vault, '.brain', '_moat'), { recursive: true })
    writeFileSync(join(vault, '.brain', '_moat', 'operator-model.json'), '{"secret":true}', 'utf-8')
    writeFileSync(join(vault, '.brain', 'config.json'), '{"linkedSources":[]}', 'utf-8')
    // A non-.md file colocated with the concepts must be excluded (.md-only).
    writeFileSync(join(vault, '.brain', 'memory', 'cache.json'), '{"x":1}', 'utf-8')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('collects .brain/memory/*.md (the concept skeleton) → indexable/searchable', () => {
    const rels = collectNoteFiles(vault).map((f) => rel(vault, f))
    expect(rels).toContain('.brain/memory/_about-knowledge.md')
    expect(rels).toContain('.brain/memory/_about-decisions.md')
    expect(rels).toContain('.brain/memory/_concept-index.md')
    // Real user notes still collected as before.
    expect(rels).toContain('real-note.md')
  })

  it('does NOT collect .brain/_moat/*.json, .brain/config.json, or any non-.md under .brain (no state leak)', () => {
    const rels = collectNoteFiles(vault).map((f) => rel(vault, f))
    expect(rels.some((r) => r.startsWith('.brain/_moat/'))).toBe(false)
    expect(rels).not.toContain('.brain/config.json')
    expect(rels).not.toContain('.brain/memory/cache.json')
    // Prove the carve-out is memory/-scoped AND .md-only: nothing under .brain except *.md in memory/.
    for (const r of rels.filter((x) => x.startsWith('.brain/'))) {
      expect(r.startsWith('.brain/memory/')).toBe(true)
      expect(r.endsWith('.md')).toBe(true)
    }
  })
})

// P5 "machine files only": the scaffolding boundary is `_`-prefixed FILE basenames.
// DUIN/Meta design cards are REAL knowledge (indexed + retrievable), so collectNoteFiles
// KEEPS them — the P0-era DUIN/Meta subtree exclusion was removed. A `_`-prefixed FILE is
// still excluded everywhere, while a normal file inside a `_`-prefixed DIR survives.
describe('collectNoteFiles — P5 scaffolding = `_`-files only (DUIN/Meta kept)', () => {
  let vault: string
  const rel = (v: string, abs: string): string => abs.slice(v.length + 1).split('\\').join('/')

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-p5-'))
    // DUIN/Meta = REAL knowledge → a normal-basename design card is KEPT; a `_`-file is NOT.
    mkdirSync(join(vault, 'DUIN', 'Meta'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Meta', 'design-card.md'), '# a design card\n', 'utf-8')
    writeFileSync(join(vault, 'DUIN', 'Meta', '_metrics.md'), '# machine metrics\n', 'utf-8')
    // A `_`-file at the vault root → excluded. A normal file inside a `_`-DIR → kept.
    writeFileSync(join(vault, '_concept-index.md'), '# machine index\n', 'utf-8')
    mkdirSync(join(vault, '北澜', '_原始转录'), { recursive: true })
    writeFileSync(join(vault, '北澜', '_原始转录', 'transcript.md'), '# a transcript\n', 'utf-8')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('KEEPS DUIN/Meta design cards + `_`-DIR notes; EXCLUDES `_`-basename files', () => {
    const rels = collectNoteFiles(vault).map((f) => rel(vault, f))
    // KEPT
    expect(rels).toContain('DUIN/Meta/design-card.md')
    expect(rels).toContain('北澜/_原始转录/transcript.md')
    // EXCLUDED (machine files)
    expect(rels).not.toContain('DUIN/Meta/_metrics.md')
    expect(rels).not.toContain('_concept-index.md')
  })
})
