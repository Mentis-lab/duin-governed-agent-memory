import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listWorkflows } from './workflows-native'

describe('listWorkflows', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-wf-'))
    mkdirSync(join(vault, '.duin', 'skills', 'refactor'), { recursive: true })
    mkdirSync(join(vault, '.duin', 'agents'), { recursive: true })
    mkdirSync(join(vault, 'Methods'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('collects skills (SKILL.md), agents, and method notes with classified wires', () => {
    writeFileSync(join(vault, '.duin', 'skills', 'refactor', 'SKILL.md'), '---\nname: refactor\ndescription: "clean code"\ncategory: dev\n---\n')
    writeFileSync(join(vault, '.duin', 'agents', 'scout.md'), '---\nname: scout\ndescription: finds things\n---\n')
    writeFileSync(join(vault, 'Methods', 'plan.md'), '---\ntype: method\ntitle: Planning\ndescription: how to plan\n---\n## Step one\nuse [[refactor]] and [[f-2080]]\n### Step two\n')
    const { skills, agents, methods } = listWorkflows(vault)
    expect(skills[0]).toMatchObject({ name: 'refactor', desc: 'clean code', category: 'dev', path: '.duin/skills/refactor/SKILL.md' })
    expect(agents[0]).toMatchObject({ name: 'scout', kind: 'agent' })
    expect(methods[0]).toMatchObject({ name: 'Planning', kind: 'method', stages: 2 })
    const wires = methods[0].wires!
    expect(wires.find((w) => w.name === 'refactor')!.kind).toBe('skill') // in skill_names
    expect(wires.find((w) => w.name === 'f-2080')!.kind).toBe('framework') // f- prefix
  })

  it('parses calls-skills frontmatter into skill wires + task-kind/deliverable', () => {
    writeFileSync(join(vault, '.duin', 'skills', 'refactor', 'SKILL.md'), '---\nname: refactor\ndescription: x\n---\n')
    writeFileSync(
      join(vault, 'Methods', 'debrief.md'),
      '---\ntype: method\nname: Debrief\ndescription: d\ntask-kind: debrief/deal\ndeliverable: an internal debrief\ncalls-skills: [meeting-note, preserve]\n---\n## Steps\n'
    )
    const m = listWorkflows(vault).methods.find((x) => x.name === 'Debrief')!
    expect(m.taskKind).toBe('debrief/deal')
    expect(m.deliverable).toBe('an internal debrief')
    const skillWires = m.wires!.filter((w) => w.kind === 'skill').map((w) => w.name)
    expect(skillWires).toEqual(expect.arrayContaining(['meeting-note', 'preserve']))
  })

  it('null vault → empty', () => {
    expect(listWorkflows(null)).toEqual({ methods: [], skills: [], agents: [] })
  })
})
