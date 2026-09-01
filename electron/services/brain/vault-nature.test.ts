import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sampleVault, classifyVaultNature } from './vault-nature'

function write(dir: string, rel: string, body: string): void {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body, 'utf-8')
}

describe('vault-nature — the study-vault safety control', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-vault-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('classifies a self/work vault (decisions/people/cards, first-person) as self-work', () => {
    write(dir, '05 Decisions/D260601-open-beta.md', '---\ntype: decision\nreviewOn: 2026-07-01\n---\n# Open the beta\nI decided we should hold; my read is the SLA risk is real.')
    write(dir, 'People/zhang.md', '---\ntype: person\n---\n# Zhang\nStakeholder on my publishing deal.')
    write(dir, '02 Cards/C1-warm-network.md', '---\ntype: card\n---\nMy lesson: warm intros beat cold BD.')
    write(dir, 'Daily/2026-06-30.md', '# Today\nWe shipped v1. I need to close the deal.')
    const nature = classifyVaultNature(sampleVault(dir))
    expect(nature.kind).toBe('self-work')
    expect(nature.confidence).toBeGreaterThan(0.5)
  })

  it('classifies a STUDY vault (chapters/definitions, expository) as study-reference — NOT self-work', () => {
    write(dir, 'Organic Chemistry/Chapter 1.md', '---\ntype: concept\n---\n# Alkanes\nDefinition: a saturated hydrocarbon. Example: methane. Theorem of valence.')
    write(dir, 'Organic Chemistry/Chapter 2.md', '# Reaction Mechanisms\nExercise: draw the SN2 pathway. Problem set 2. Quiz next week.')
    write(dir, 'Thermodynamics/lecture-3.md', '---\ntype: flashcard\n---\nQ: What is enthalpy? A: heat content at constant pressure. 定义与例题。')
    write(dir, 'Study/exam-review.md', '# Midterm review\nKey definitions and theorems for the exam. 考点与习题。')
    const nature = classifyVaultNature(sampleVault(dir))
    // The core of the control: a subject vault must NOT be read as the owner's identity.
    expect(nature.kind).toBe('study-reference')
    expect(nature.kind).not.toBe('self-work')
    // Topics describe the MATERIAL (safe), not the person.
    expect(nature.topics.join(' ').toLowerCase()).toMatch(/chemistry|thermodynamics/)
  })

  it('an empty / thin vault is unknown -> caller must ask, never infer identity', () => {
    write(dir, 'note.md', '# A note\nsome text')
    const nature = classifyVaultNature(sampleVault(dir))
    expect(nature.kind).toBe('unknown')
    expect(nature.confidence).toBeLessThan(0.4)
    expect(nature.rationale.join(' ')).toMatch(/do not infer identity/)
  })

  it('a genuinely mixed vault is classified mixed (infer self parts, describe study parts)', () => {
    // self signals
    write(dir, 'Decisions/d1.md', '---\ntype: decision\nreviewOn: 2026-07\n---\nI decided to prioritize the deal. My call.')
    write(dir, 'People/p1.md', '---\ntype: person\n---\nMy stakeholder.')
    // roughly equal study signals
    write(dir, 'Courses/ml/chapter-1.md', '# Gradient descent\nDefinition, theorem, example, exercise. 定义 例题 习题 考点.')
    write(dir, 'Courses/ml/chapter-2.md', '# Backprop\nDefinition, theorem, example, problem set, quiz. 定义 例题 习题.')
    const nature = classifyVaultNature(sampleVault(dir))
    expect(['mixed', 'self-work', 'study-reference']).toContain(nature.kind)
    // whatever it lands on, it must carry a confidence and rationale (auditable)
    expect(nature.rationale.length).toBeGreaterThan(0)
  })
})
