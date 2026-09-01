import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ipc-client', () => ({ query: vi.fn() }))
vi.mock('@/stores/plugins-store', () => ({ usePluginsStore: () => vi.fn() }))

import { summarizeRisk, collectMissing, type StagedPlugin } from './InstallPluginFlow'
import type { RequirementResult } from '@/lib/types'

// The review screen answers one question: what will this run on my machine?
//
// Both halves of that answer have to be right. Overstating it is not the safe
// default — if every plugin renders as dangerous, the warning stops being read, and
// the one that actually spawns `npx -y something` looks like all the others.

const staged = (over: Partial<StagedPlugin> = {}): StagedPlugin => ({
  stageId: 's1',
  sourceUrl: 'https://github.com/o/r',
  id: 'demo',
  name: 'Demo',
  description: '',
  version: '1.0.0',
  connectors: [],
  skills: [],
  slashCommands: [],
  missing: [],
  alreadyInstalled: false,
  ...over
})

const missing = (label: string, detail?: string): RequirementResult => ({
  requirement: { kind: 'binary', name: label },
  satisfied: false,
  label,
  detail
})

describe('summarizeRisk', () => {
  it('says plainly when a plugin is text only', () => {
    const r = summarizeRisk(staged({ skills: ['a.md'] }))
    expect(r.severe).toBe(false)
    expect(r.spawns).toEqual([])
    expect(r.headline).toMatch(/runs nothing/i)
  })

  it('names the count of commands it would run', () => {
    const r = summarizeRisk(
      staged({
        connectors: [
          { id: 'a', name: 'A', transport: 'stdio', commandLine: 'npx -y x', envKeys: [], missing: [] },
          { id: 'b', name: 'B', transport: 'stdio', commandLine: 'node y.js', envKeys: [], missing: [] }
        ]
      })
    )
    expect(r.severe).toBe(true)
    expect(r.headline).toMatch(/runs 2 commands/i)
    expect(r.spawns).toHaveLength(2)
  })

  it('singularizes one command', () => {
    const r = summarizeRisk(
      staged({
        connectors: [
          { id: 'a', name: 'A', transport: 'stdio', commandLine: 'npx -y x', envKeys: [], missing: [] }
        ]
      })
    )
    expect(r.headline).toMatch(/runs 1 command\b/i)
  })

  // A remote connector reaches out but spawns nothing locally. Painting it the same
  // amber as a local process spawn is the overstatement that kills the signal.
  it('separates "contacts a remote server" from "runs a local command"', () => {
    const r = summarizeRisk(
      staged({
        connectors: [
          { id: 'a', name: 'A', transport: 'http', url: 'https://api.example.com', envKeys: [], missing: [] }
        ]
      })
    )
    expect(r.severe).toBe(false)
    expect(r.headline).toMatch(/remote/i)
    expect(r.headline).toMatch(/runs nothing on this machine/i)
  })

  it('a stdio connector with NO command cannot spawn, so it is not counted', () => {
    // Mirrors refuseUnapprovedStdioConnectors, which skips exactly this shape:
    // connectStdio has nothing to exec. Counting it would raise a warning for a
    // spawn that never happens.
    const r = summarizeRisk(
      staged({ connectors: [{ id: 'a', name: 'A', transport: 'stdio', envKeys: [], missing: [] }] })
    )
    expect(r.severe).toBe(false)
    expect(r.spawns).toEqual([])
  })
})

describe('collectMissing', () => {
  it('gathers requirements from the plugin AND its connectors', () => {
    const out = collectMissing(
      staged({
        missing: [missing('git')],
        connectors: [
          { id: 'a', name: 'A', transport: 'stdio', commandLine: 'npx x', envKeys: [], missing: [missing('npx')] }
        ]
      })
    )
    expect(out.map((m) => m.label).sort()).toEqual(['git', 'npx'])
  })

  it('de-duplicates by label so three connectors needing npx say it once', () => {
    const conn = (id: string) => ({
      id,
      name: id,
      transport: 'stdio',
      commandLine: 'npx x',
      envKeys: [],
      missing: [missing('npx', 'Install Node.js.')]
    })
    const out = collectMissing(staged({ connectors: [conn('a'), conn('b'), conn('c')] }))
    expect(out).toHaveLength(1)
    expect(out[0].detail).toBe('Install Node.js.')
  })

  it('is empty when nothing is missing', () => {
    expect(collectMissing(staged())).toEqual([])
  })
})
