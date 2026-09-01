import { describe, it, expect } from 'vitest'
import { buildIdentityFiles, hasIdentitySignal, type IdentityInput } from './brain-identity'

const NOW = '2026-07-01'

describe('brain-identity — interview → ME.md + BRAIN.md (A1 cold-start)', () => {
  it('generates a grounded ME.md from a full interview', () => {
    const input: IdentityInput = {
      name: 'Theo',
      role: 'Game publishing lead',
      expertise: 'CN/JP market entry, AI agents',
      workingStyle: 'Be concise; flag risks early; reply in English.',
      working: 'Ship the v1 launch\nClose the Q3 deal',
      deciding: 'Whether to open the public beta in March',
      worried: 'Vendor SLA\nBudget overrun'
    }
    const { meMd } = buildIdentityFiles(input, { now: NOW })
    // identity is present + grounded on the real fields
    expect(meMd).toContain('# Theo')
    expect(meMd).toContain('Role: Game publishing lead')
    expect(meMd).toContain('Works on: CN/JP market entry, AI agents')
    expect(meMd).toContain('How to work with me')
    expect(meMd).toContain('Be concise; flag risks early')
    // current context threads through
    expect(meMd).toContain('Ship the v1 launch')
    expect(meMd).toContain('Whether to open the public beta in March')
    expect(meMd).toContain('Budget overrun')
    // valid frontmatter, deterministic date
    expect(meMd.startsWith('---\ntype: identity')).toBe(true)
    expect(meMd).toContain(`generated: ${NOW}`)
  })

  it('always produces a personalized BRAIN.md contract', () => {
    const { brainMd } = buildIdentityFiles({ name: 'Theo', workingStyle: 'Reply in English.' }, { now: NOW })
    expect(brainMd).toContain("# BRAIN.md — Theo's DUIN")
    expect(brainMd).toContain('Operating contract')
    expect(brainMd).toContain('Ground every answer in the vault')
    expect(brainMd).toContain("Owner's working style: Reply in English.")
  })

  it('produces a valid default BRAIN.md even with NO signal, and skips ME.md', () => {
    const input: IdentityInput = {}
    expect(hasIdentitySignal(input)).toBe(false)
    const { meMd, brainMd } = buildIdentityFiles(input, { now: NOW })
    expect(meMd).toBe('') // caller skips writing ME.md — no fake identity
    expect(brainMd).toContain('# BRAIN.md — Your DUIN') // grounding still non-empty
    expect(brainMd).toContain('Operating contract')
  })

  it('treats current-context-only answers as enough for ME.md', () => {
    const { meMd } = buildIdentityFiles({ working: 'Launch DUIN v1' }, { now: NOW })
    expect(hasIdentitySignal({ working: 'Launch DUIN v1' })).toBe(true)
    expect(meMd).toContain('# The Operator') // no name → generic heading
    expect(meMd).toContain('Launch DUIN v1')
  })

  it('handles CN / bilingual input without mangling', () => {
    const { meMd, brainMd } = buildIdentityFiles(
      { name: '高', role: '发行负责人', expertise: '北澜项目 · AI 落地', workingStyle: '用中文回复，先说风险。' },
      { now: NOW }
    )
    expect(meMd).toContain('# 高')
    expect(meMd).toContain('Role: 发行负责人')
    expect(meMd).toContain('北澜项目 · AI 落地')
    expect(brainMd).toContain("# BRAIN.md — 高's DUIN")
    expect(brainMd).toContain('用中文回复，先说风险。')
  })

  it('is deterministic and never emits 3+ blank lines', () => {
    const a = buildIdentityFiles({ name: 'X', working: 'a\nb' }, { now: NOW })
    const b = buildIdentityFiles({ name: 'X', working: 'a\nb' }, { now: NOW })
    expect(a).toEqual(b)
    expect(a.meMd).not.toMatch(/\n{3,}/)
    expect(a.brainMd).not.toMatch(/\n{3,}/)
  })
})

describe('brain-identity — study-vault control (subjects are material, not identity)', () => {
  it('study vault → study-companion BRAIN.md that forbids treating subjects as identity', () => {
    const { brainMd } = buildIdentityFiles(
      { name: 'Sam', role: 'Student', vaultKind: 'study-reference', vaultTopics: ['Organic Chemistry', 'Thermodynamics'] },
      { now: NOW }
    )
    expect(brainMd).toContain('study companion')
    expect(brainMd).toContain('STUDY / REFERENCE vault')
    expect(brainMd).toContain("NEVER assert the subject matter as the owner's own identity")
  })

  it('study topics appear as MATERIAL, never in the owner Role/Who-I-am', () => {
    const { meMd } = buildIdentityFiles(
      { name: 'Sam', role: 'Student', vaultKind: 'study-reference', vaultTopics: ['Organic Chemistry', 'Thermodynamics'] },
      { now: NOW }
    )
    expect(meMd).toContain('What my vault covers (study / reference material)')
    expect(meMd).toContain('- Organic Chemistry')
    // the control: the subject must NOT be asserted as the owner's role
    expect(meMd).toContain('Role: Student')
    expect(meMd).not.toContain('Role: Organic Chemistry')
    expect(meMd).not.toMatch(/Works on:.*Organic Chemistry/)
  })

  it('study vault with topics but NO interview still writes a material ME.md, no fabricated identity', () => {
    const { meMd, brainMd } = buildIdentityFiles(
      { vaultKind: 'study-reference', vaultTopics: ['Spanish', 'Verb conjugation'] },
      { now: NOW }
    )
    expect(meMd).toContain('What my vault covers')
    expect(meMd).toContain('- Spanish')
    expect(meMd).not.toContain('## Who I am') // no fabricated role/identity
    expect(brainMd).toContain('study companion')
  })

  it('self-work vault labels topics plainly and keeps the work contract', () => {
    const { meMd, brainMd } = buildIdentityFiles(
      { name: 'Gao', role: 'Publishing lead', vaultKind: 'self-work', vaultTopics: ['北澜', 'Orbis Inc'] },
      { now: NOW }
    )
    expect(meMd).toContain('## What my vault covers')
    expect(meMd).not.toContain('study / reference material')
    expect(brainMd).toContain('second brain')
    expect(brainMd).not.toContain('study companion')
  })
})
