// Backlog finding 51. The built-in Explore / Plan / code-reviewer agents named four tools
// in allowedTools, and THREE of them did not exist as far as the enforcement layer was
// concerned. subagentToolAllowed refuses any name outside subagent-config's
// SUBAGENT_TOOLS ceiling, and that set contains neither `grep_search` nor `glob_search`
// (the real ids are search_files / glob_files) nor `shell_command` (the AGUI surface calls
// it run_command). So the three agents whose entire purpose is searching actually ran with
// `read_file` and nothing else. Nothing errored; the tools simply were not there.
//
// This pins every built-in agent's tool list against the ceiling that enforces it, so a
// rename or a typo fails here rather than silently removing an agent's capability.

import { describe, it, expect } from 'vitest'
import { SUBAGENT_TOOLS, subagentToolAllowed } from './local-brain/subagent-config'
import { BUILT_IN_SUBAGENT_TYPES } from './subagent-types'

describe('built-in subagent allowedTools are all inside the enforcement ceiling', () => {
  it('names no tool the dispatch filter would refuse', () => {
    const phantom: string[] = []
    for (const [agent, def] of Object.entries(BUILT_IN_SUBAGENT_TYPES)) {
      // allowedTools is `string[] | '*'`. '*' is the inherit-everything sentinel (the
      // `general` agent), expanded by resolveSubagentConfig — not a tool id, so there is
      // nothing to check against the ceiling.
      const tools = def.allowedTools
      if (!Array.isArray(tools)) continue
      for (const id of tools) {
        if (id === '*') continue
        // Ask the REAL predicate, not a re-implementation of it.
        if (!subagentToolAllowed(id, tools)) phantom.push(`${agent}:${id}`)
      }
    }
    expect(phantom, `named but unusable: ${phantom.join(', ')}`).toEqual([])
  })

  it('the search agents actually carry search tools', () => {
    // The capability the finding says they lost, named explicitly so a future edit that
    // drops them fails with a reason rather than an empty-array diff.
    for (const agent of ['Explore', 'Plan', 'code-reviewer']) {
      const tools = BUILT_IN_SUBAGENT_TYPES[agent].allowedTools
      expect(Array.isArray(tools), agent).toBe(true)
      expect(tools as string[], agent).toContain('search_files')
      expect(tools as string[], agent).toContain('glob_files')
    }
  })

  it('the retired phantom ids are gone', () => {
    const all = Object.values(BUILT_IN_SUBAGENT_TYPES).flatMap((d) =>
      Array.isArray(d.allowedTools) ? d.allowedTools : []
    )
    for (const dead of ['grep_search', 'glob_search', 'shell_command']) {
      expect(all).not.toContain(dead)
    }
  })

  it('the read-only agents were NOT quietly granted host-exec', () => {
    // shell_command was dropped rather than translated to run_command: the capability was
    // never live, all three agents are described as read-only, and run_command is
    // host-exec. Granting it is a governance decision, not a defect fix.
    for (const agent of ['Explore', 'Plan', 'code-reviewer']) {
      const t = BUILT_IN_SUBAGENT_TYPES[agent].allowedTools
      expect(Array.isArray(t) ? t : []).not.toContain('run_command')
    }
  })

  it('the ceiling itself still contains the ids the agents rely on', () => {
    expect(SUBAGENT_TOOLS.has('search_files')).toBe(true)
    expect(SUBAGENT_TOOLS.has('glob_files')).toBe(true)
    expect(SUBAGENT_TOOLS.has('read_file')).toBe(true)
  })
})
