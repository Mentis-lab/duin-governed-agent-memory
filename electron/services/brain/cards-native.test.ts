import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listCards,
  listActions,
  listCardProjects,
  listNorthStarGoals,
  cardEdges,
  goalGuideEdges,
  loadGoalDomains
} from './cards-native'

// A tiny fixture vault exercising the net-new producers.
let VAULT: string

function write(rel: string, content: string): void {
  const p = join(VAULT, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
}

beforeAll(() => {
  VAULT = mkdtempSync(join(tmpdir(), 'cards-fixture-'))

  // two cards under a 北澜 project (one via `project`, one via `source-project`)…
  write(
    '北澜/C260101-first-card.md',
    ['---', 'type: card', 'project: 北澜', 'status: draft', '---', '', '# First card title', '', 'body'].join('\n')
  )
  write(
    '北澜/C260102-second-card.md',
    ['---', 'type: card', 'source-project: 北澜', 'status: live', 'id: C260102-second-card', '---', '', '# Second'].join('\n')
  )
  // …one card under an AI project that links an action (references edge)…
  write(
    'AI-strategy/C260103-ai-card.md',
    [
      '---',
      'type: card',
      'arena: AI-strategy',
      'status: draft',
      'source-note: "[[T260103-ai-action]]"',
      'links:',
      '  - "[[T260103-ai-action]]"',
      '---',
      '',
      '# AI card'
    ].join('\n')
  )
  // …a card with NO project (no contains edge)…
  write('Misc/C260104-orphan.md', ['---', 'type: card', 'status: draft', '---', '', '# Orphan card'].join('\n'))
  // …an action file (type: action)…
  write(
    'DUIN/Active/T260103-ai-action.md',
    ['---', 'type: action', 'status: open', '---', '', '# AI action'].join('\n')
  )
  // …a non-card note that must be ignored…
  write('Notes/random.md', ['---', 'type: person', '---', '', '# Somebody'].join('\n'))

  // GOALS.md with the North-Star Strategic Tracks section + a decoy OKR section.
  write(
    'GOALS.md',
    [
      '# Goals',
      '',
      '## Strategic Tracks (cross-cycle)',
      '',
      'intro line',
      '',
      '### 1. Gaming Ecosystem & Brand Synergy',
      'body',
      '### 2. M&A Strategy & "Closed-Loop" Sourcing',
      'body',
      '### 3. AIT (AI Transformation) & Operational Efficiency',
      'body',
      '### 4. Cross-Border Governance & Executive Leadership',
      'body',
      '',
      '## Quarterly OKRs',
      '',
      '### Q3 decoy heading (must NOT become a goal)',
      'body'
    ].join('\n')
  )
})

afterAll(() => {
  rmSync(VAULT, { recursive: true, force: true })
})

describe('listCards', () => {
  it('collects every type:card note, id from fm.id else filename stem', () => {
    const cards = listCards(VAULT)
    expect(cards.length).toBe(4)
    expect(cards.every((c) => c.kind === 'card' && c.declared === 1)).toBe(true)
    const byId = new Map(cards.map((c) => [c.id, c]))
    // explicit fm.id honoured
    expect(byId.has('C260102-second-card')).toBe(true)
    // stem fallback
    expect(byId.has('C260101-first-card')).toBe(true)
    // title from H1 when no fm.title
    expect(byId.get('C260101-first-card')?.title).toBe('First card title')
    // project via project | source-project | arena
    expect(byId.get('C260101-first-card')?.project).toBe('北澜')
    expect(byId.get('C260102-second-card')?.project).toBe('北澜')
    expect(byId.get('C260103-ai-card')?.project).toBe('AI-strategy')
    expect(byId.get('C260104-orphan')?.project ?? '').toBe('')
  })
})

describe('listActions', () => {
  it('collects type:action notes as action nodes', () => {
    const actions = listActions(VAULT)
    expect(actions.map((a) => a.id)).toEqual(['T260103-ai-action'])
    expect(actions[0].kind).toBe('action')
    expect(actions[0].declared).toBe(1)
  })
})

describe('listCardProjects', () => {
  it('is the DISTINCT non-empty card project field (not a folder walk)', () => {
    const projects = listCardProjects(VAULT)
    const ids = projects.map((p) => p.id).sort()
    expect(ids).toEqual(['AI-strategy', '北澜'])
    expect(projects.every((p) => p.kind === 'project' && p.declared === 1)).toBe(true)
  })
})

describe('listCardProjects — rejects pseudo-project values (P0-4)', () => {
  it('drops ARENA_GENERIC field values like `meta`/`Outputs`, keeps real arenas', () => {
    const v = mkdtempSync(join(tmpdir(), 'cards-meta-'))
    try {
      const card = (rel: string, project: string): void => {
        const p = join(v, rel)
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, ['---', 'type: card', `project: ${project}`, 'status: draft', '---', '', '# c'].join('\n'))
      }
      card('a/C1.md', '北澜') // real arena → kept
      card('b/C2.md', 'meta') // pseudo-value → dropped
      card('c/C3.md', 'Outputs') // container name (case-insensitive) → dropped
      expect(listCardProjects(v).map((p) => p.id).sort()).toEqual(['北澜'])
    } finally {
      rmSync(v, { recursive: true, force: true })
    }
  })
})

describe('listNorthStarGoals', () => {
  it('parses the four Strategic-Tracks headings into goal:<slug> nodes, ignoring OKRs', () => {
    const goals = listNorthStarGoals(VAULT)
    expect(goals.map((g) => g.id)).toEqual([
      'goal:gaming-ecosystem-brand-synergy',
      'goal:m-a-strategy-closed-loop-sourcing',
      'goal:ait-ai-transformation-operational-efficiency',
      'goal:cross-border-governance-executive-leadership'
    ])
    expect(goals.every((g) => g.kind === 'goal' && g.declared === 1)).toBe(true)
    expect(goals[0].title).toBe('Gaming Ecosystem & Brand Synergy')
  })
})

describe('cardEdges', () => {
  it('emits project→card contains (only for projected cards) + action→card references', () => {
    const edges = cardEdges(VAULT)
    const contains = edges.filter((e) => e.type === 'contains')
    const refs = edges.filter((e) => e.type === 'references')
    // 3 of the 4 cards have a project; the orphan card does not.
    expect(contains.length).toBe(3)
    expect(contains).toContainEqual({ src: '北澜', dst: 'C260101-first-card', type: 'contains' })
    // references: the AI card wikilinks the action id in its frontmatter.
    expect(refs).toEqual([{ src: 'T260103-ai-action', dst: 'C260103-ai-card', type: 'references' }])
  })
})

describe('goalGuideEdges', () => {
  // Cold-start A3 moved the goal-slug → project-keyword map out of source and into per-vault
  // state (`.duin/_state/goal-domains.json`); the built-in ships empty. The matching heuristic is
  // unchanged, so the map is supplied here the way a vault supplies it.
  const DOMAINS = {
    'gaming-ecosystem-brand-synergy': ['北澜', 'beilan', 'gaming', 'game', 'brand'],
    'ait-ai-transformation-operational-efficiency': ['ai', 'ait', 'ai-strategy', 'aistrategy']
  }

  it('maps each goal to the best-matching project by domain keyword (best-effort)', () => {
    const goals = listNorthStarGoals(VAULT)
    const projects = listCardProjects(VAULT)
    const guides = goalGuideEdges(goals, projects, DOMAINS)
    // gaming goal → 北澜 project; AIT goal → AI-strategy project.
    expect(guides).toContainEqual({ src: 'goal:gaming-ecosystem-brand-synergy', dst: '北澜', type: 'guides' })
    expect(guides).toContainEqual({
      src: 'goal:ait-ai-transformation-operational-efficiency',
      dst: 'AI-strategy',
      type: 'guides'
    })
    // every guides endpoint is a real project node (no dangling)
    const projIds = new Set(projects.map((p) => p.id))
    expect(guides.every((e) => projIds.has(e.dst))).toBe(true)
  })

  it('with no domain map (the shipped default) emits NO guides edges rather than wrong ones', () => {
    expect(goalGuideEdges(listNorthStarGoals(VAULT), listCardProjects(VAULT))).toEqual([])
  })

  it('loadGoalDomains reads the per-vault file and tolerates a missing/malformed one', () => {
    expect(loadGoalDomains(VAULT)).toEqual({}) // fixture vault has no goal-domains.json
    expect(loadGoalDomains(null)).toEqual({})
    const v = mkdtempSync(join(tmpdir(), 'duin-gd-'))
    try {
      mkdirSync(join(v, '.duin', '_state'), { recursive: true })
      writeFileSync(join(v, '.duin', '_state', 'goal-domains.json'), JSON.stringify(DOMAINS))
      expect(loadGoalDomains(v)['gaming-ecosystem-brand-synergy']).toContain('gaming')
      writeFileSync(join(v, '.duin', '_state', 'goal-domains.json'), '{ not json')
      expect(loadGoalDomains(v)).toEqual({})
    } finally {
      rmSync(v, { recursive: true, force: true })
    }
  })
})
