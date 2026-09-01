import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureBrainRoot,
  loadBrain,
  buildBrainGroundingBlock,
  brainRootPath,
  BRAIN_GROUNDING_CHAR_CAP,
  BRAIN_DIRNAME,
  BRAIN_IDENTITY_FILE,
  BRAIN_MEMORY_DIR,
  BRAIN_MEMORY_INDEX,
  BRAIN_CONFIG_FILE
} from './brain-root'

let vault: string

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'brain-root-'))
})
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function writeBrainFile(rel: string, body: string): void {
  const full = join(vault, BRAIN_DIRNAME, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body, 'utf-8')
}

describe('brainRootPath', () => {
  it('resolves <notesDir>/.brain', () => {
    expect(brainRootPath('/x/y')).toBe(join('/x/y', BRAIN_DIRNAME))
  })
  it('returns null for empty/blank notesDir', () => {
    expect(brainRootPath('')).toBeNull()
    expect(brainRootPath('   ')).toBeNull()
    expect(brainRootPath(null)).toBeNull()
  })
})

describe('ensureBrainRoot', () => {
  it('creates the scaffolding and is idempotent', () => {
    const root = ensureBrainRoot(vault)
    expect(root).toBe(join(vault, BRAIN_DIRNAME))
    expect(existsSync(join(root as string, BRAIN_MEMORY_DIR))).toBe(true)
    expect(existsSync(join(root as string, 'skills'))).toBe(true)
    expect(existsSync(join(root as string, 'state'))).toBe(true)
    // second call no-throw
    expect(ensureBrainRoot(vault)).toBe(root)
  })
  it('no-ops on empty notesDir', () => {
    expect(ensureBrainRoot('')).toBeNull()
    expect(ensureBrainRoot(null)).toBeNull()
  })
})

describe('loadBrain', () => {
  it('returns null when no .brain/ exists', () => {
    expect(loadBrain(vault)).toBeNull()
    expect(loadBrain('')).toBeNull()
  })

  it('returns null when .brain/ exists but is empty', () => {
    ensureBrainRoot(vault)
    expect(loadBrain(vault)).toBeNull()
  })

  it('concatenates identity + memory (index first)', () => {
    writeBrainFile(BRAIN_IDENTITY_FILE, '# Me\nI build harnesses.')
    writeBrainFile(join(BRAIN_MEMORY_DIR, BRAIN_MEMORY_INDEX), '# MEMORY\n- prefers terse answers')
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'fact-1.md'), 'Lives in Shanghai.')
    const loaded = loadBrain(vault)
    expect(loaded).not.toBeNull()
    expect(loaded?.identity).toContain('I build harnesses')
    // index appears, plus the fact file
    expect(loaded?.memory.length).toBe(2)
    expect(loaded?.memory[0]).toContain('prefers terse answers') // MEMORY.md first
    expect(loaded?.memory.some((m) => m.includes('Shanghai'))).toBe(true)
  })

  it('loads with only memory (no identity)', () => {
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'a.md'), 'a memory')
    const loaded = loadBrain(vault)
    expect(loaded?.identity).toBe('')
    expect(loaded?.memory).toEqual(['a memory'])
  })

  it('caps total memory chars, dropping the biggest files first', () => {
    writeBrainFile(BRAIN_IDENTITY_FILE, 'short identity')
    const huge = 'X'.repeat(BRAIN_GROUNDING_CHAR_CAP + 100)
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'huge.md'), huge)
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'small.md'), 'tiny memory')
    const loaded = loadBrain(vault)
    expect(loaded).not.toBeNull()
    const total = (loaded?.memory ?? []).reduce((n, s) => n + s.length, 0)
    expect(total).toBeLessThanOrEqual(BRAIN_GROUNDING_CHAR_CAP)
    // the small one survives, the huge one is dropped
    expect(loaded?.memory).toContain('tiny memory')
    expect(loaded?.memory.some((m) => m.startsWith('XXXX'))).toBe(false)
  })

  it('excludes seam projections from the always-on dump (type: learned AND generated-by: duin-seam), keeps pillars', () => {
    // seam belief concept — excluded by type (pre-existing behavior, pinned here)
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'concept-x.md'), '---\ntype: learned\n---\n\nlearned fact body')
    // T2 entity projection — typed by REAL kind, excluded by its generator key instead
    writeBrainFile(
      join(BRAIN_MEMORY_DIR, 'entity-beilan.md'),
      '---\ntype: project\ngenerated-by: duin-seam\n---\n\nbeilan entity body'
    )
    // scaffold pillar — generated, but NOT seam-generated: still grounds (unchanged behavior)
    writeBrainFile(
      join(BRAIN_MEMORY_DIR, '_about-people.md'),
      '---\ntype: person\ngenerated: true\n---\n\npeople pillar body'
    )
    const loaded = loadBrain(vault)
    expect(loaded?.memory.some((m) => m.includes('learned fact body'))).toBe(false)
    expect(loaded?.memory.some((m) => m.includes('beilan entity body'))).toBe(false)
    expect(loaded?.memory.some((m) => m.includes('people pillar body'))).toBe(true)
  })

  it('reads identity/memory from a LINKED source live (link mode)', () => {
    // Create a linked source dir laid out like a mapped .brain (identity.md + memory/)
    const linked = mkdtempSync(join(tmpdir(), 'linked-'))
    writeFileSync(join(linked, 'AGENTS.md'), '# Linked Identity\nfrom the original', 'utf-8')
    mkdirSync(join(linked, BRAIN_MEMORY_DIR), { recursive: true })
    writeFileSync(join(linked, BRAIN_MEMORY_DIR, 'm.md'), 'linked memory', 'utf-8')

    ensureBrainRoot(vault)
    writeBrainFile(
      BRAIN_CONFIG_FILE,
      JSON.stringify({ linkedSources: [{ adapter: 'codex', dir: linked }] })
    )

    const loaded = loadBrain(vault)
    expect(loaded?.identity).toContain('Linked Identity')
    expect(loaded?.memory).toContain('linked memory')
    rmSync(linked, { recursive: true, force: true })
  })
})

describe('buildBrainGroundingBlock', () => {
  it('returns empty string for null', () => {
    expect(buildBrainGroundingBlock(null)).toBe('')
  })
  it('prefixes the WHO YOU ARE / WHO THE OWNER IS header and includes identity + memory', () => {
    const block = buildBrainGroundingBlock({
      identity: 'I am Theo.',
      memory: ['prefers terse'],
      root: '/x/.brain',
      identityFiles: []
    })
    expect(block).toContain('WHO YOU ARE')
    expect(block).toContain('I am Theo.')
    expect(block).toContain('prefers terse')
  })
  it('returns empty when identity + memory are both empty', () => {
    expect(buildBrainGroundingBlock({ identity: '', memory: [], root: '/x/.brain', identityFiles: [] })).toBe('')
  })
  // P6 — discoverability pointer for the style-fingerprint mirror.
  it('cold start stays byte-identical (no pointer leaks into an empty block)', () => {
    expect(buildBrainGroundingBlock(null)).toBe('')
    expect(buildBrainGroundingBlock({ identity: '', memory: [], root: '/x/.brain', identityFiles: [] })).toBe('')
  })
  it('appends exactly one muted /state/style-fingerprint pointer when the block is non-empty', () => {
    const block = buildBrainGroundingBlock({ identity: 'I am Theo.', memory: ['prefers terse'], root: '/x/.brain', identityFiles: [] })
    expect(block).toContain('/state/style-fingerprint')
    expect(block).toContain('A mirror, not a grader')
    expect(block.split('/state/style-fingerprint')).toHaveLength(2) // exactly one pointer
    expect(block).not.toContain('duin_style_fingerprint') // the chat model uses the route, not the MCP tool name
  })
})

// SOUL.md in the identity block. This is the wiring that makes the character file
// real rather than decorative: it has to be READ, and read BEFORE BRAIN.md, since
// an imperative contract only covers what someone anticipated while character
// generalizes to the rest.
describe('SOUL.md in the grounding identity block', () => {
  it('loads SOUL.md, ahead of BRAIN.md and ME.md', () => {
    writeFileSync(join(vault, 'SOUL.md'), '# SOUL\nI would rather be useful than agreeable.\n', 'utf-8')
    writeFileSync(join(vault, 'BRAIN.md'), '# BRAIN\nPropose, do not act.\n', 'utf-8')
    writeFileSync(join(vault, 'ME.md'), '# ME\nRick.\n', 'utf-8')

    const loaded = loadBrain(vault)
    expect(loaded?.identity).toContain('useful than agreeable')
    const soulAt = loaded!.identity.indexOf('### SOUL.md')
    const brainAt = loaded!.identity.indexOf('### BRAIN.md')
    const meAt = loaded!.identity.indexOf('### ME.md')
    expect(soulAt).toBeGreaterThanOrEqual(0)
    expect(soulAt).toBeLessThan(brainAt)
    expect(brainAt).toBeLessThan(meAt)

    // …and it survives into the block actually injected into the prompt.
    expect(buildBrainGroundingBlock(loaded)).toContain('useful than agreeable')
  })

  it('is absent-tolerant: a vault with no SOUL.md loads exactly as before', () => {
    writeFileSync(join(vault, 'BRAIN.md'), '# BRAIN\nPropose, do not act.\n', 'utf-8')
    writeFileSync(join(vault, 'ME.md'), '# ME\nRick.\n', 'utf-8')
    const loaded = loadBrain(vault)
    expect(loaded?.identity).toContain('### BRAIN.md')
    expect(loaded?.identity).not.toContain('SOUL')
  })

  it('still reaches the lowercase operator file with SOUL ahead of the break', () => {
    // The loop breaks after the first ME.md/me.md hit. SOUL.md now sits in FRONT of
    // that break, so this pins that adding it did not shadow or short-circuit the
    // operator file. (Only one case variant is written: on a case-insensitive
    // filesystem ME.md and me.md are the same file, so testing both is meaningless
    // on Windows and would pass vacuously elsewhere.)
    writeFileSync(join(vault, 'SOUL.md'), '# SOUL\nchar\n', 'utf-8')
    writeFileSync(join(vault, 'me.md'), '# me\nthe operator\n', 'utf-8')
    const identity = loadBrain(vault)!.identity
    expect(identity).toContain('char')
    expect(identity).toContain('the operator')
  })
})

// identityFiles exists so a second consumer can tell it is about to ship a file
// the identity block already carries. BRAIN.md was doing exactly that: once here
// and once verbatim as <agents_md>, from two independently-resolved roots.
describe('loadBrain reports which files the identity block came from', () => {
  it('lists every foundation file it read, in block order', () => {
    writeFileSync(join(vault, 'SOUL.md'), '# SOUL\nchar\n', 'utf-8')
    writeFileSync(join(vault, 'BRAIN.md'), '# BRAIN\ncontract\n', 'utf-8')
    writeFileSync(join(vault, 'ME.md'), '# ME\nRick.\n', 'utf-8')
    expect(loadBrain(vault)?.identityFiles).toEqual([
      join(vault, 'SOUL.md'),
      join(vault, 'BRAIN.md'),
      join(vault, 'ME.md')
    ])
  })

  it('omits files that are absent or empty', () => {
    writeFileSync(join(vault, 'BRAIN.md'), '# BRAIN\ncontract\n', 'utf-8')
    writeFileSync(join(vault, 'ME.md'), '   \n', 'utf-8') // whitespace only
    expect(loadBrain(vault)?.identityFiles).toEqual([join(vault, 'BRAIN.md')])
  })

  it('reports the fallback identity source when no root foundation file exists', () => {
    writeBrainFile(BRAIN_IDENTITY_FILE, 'legacy identity')
    const loaded = loadBrain(vault)
    expect(loaded?.identity).toContain('legacy identity')
    expect(loaded?.identityFiles).toEqual([join(vault, BRAIN_DIRNAME, BRAIN_IDENTITY_FILE)])
  })

  it('is empty on a memory-only vault', () => {
    writeBrainFile(join(BRAIN_MEMORY_DIR, 'a.md'), 'a memory')
    const loaded = loadBrain(vault)
    expect(loaded?.identity).toBe('')
    expect(loaded?.identityFiles).toEqual([])
  })
})
