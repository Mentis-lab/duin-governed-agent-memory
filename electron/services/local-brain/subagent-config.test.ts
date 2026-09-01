import { describe, it, expect } from 'vitest'
import {
  resolveSubagentConfig, listSubagentTypes, SUBAGENT_TYPE_IDS, BUILT_IN_SUBAGENT_TYPES
} from './subagent-config'

const ctx = { defaultModelId: 'parent-model' }

describe('subagent-config — registry', () => {
  it('exposes stable type ids incl. the general default', () => {
    expect(SUBAGENT_TYPE_IDS).toContain('general')
    expect(SUBAGENT_TYPE_IDS).toEqual(listSubagentTypes().map((t) => t.id))
  })
  it('general is the full-toolset, no-system-prompt default', () => {
    const general = BUILT_IN_SUBAGENT_TYPES.find((t) => t.id === 'general')!
    expect(general.allowedTools).toEqual([])
    expect(general.systemPrompt).toBe('')
  })
})

describe('subagent-config — resolveSubagentConfig', () => {
  it('a bare general {task} derives a MINIMAL toolset (default-deny), not the full toolset', () => {
    const cfg = resolveSubagentConfig({ task: 'do a thing' }, ctx)
    expect(cfg.modelId).toBe('parent-model')
    expect(cfg.effort).toBe('low')
    expect(cfg.systemPrompt).toBe('')
    expect(cfg.maxRounds).toBe(6)
    // no mutation/shell hint → read-only floor (NOT the old blanket full toolset)
    expect(cfg.allowedToolNames).toEqual(['read_file', 'list_dir', 'search_files', 'glob_files', 'web_fetch'])
    expect(cfg.allowedToolNames).not.toContain('write_file')
    expect(cfg.allowedToolNames).not.toContain('run_command')
  })

  it('researcher → read-only toolset + a research system prompt', () => {
    const cfg = resolveSubagentConfig({ task: 't', agent_type: 'researcher' }, ctx)
    expect(cfg.allowedToolNames).toEqual(['read_file', 'list_dir', 'search_files', 'glob_files', 'web_fetch'])
    expect(cfg.systemPrompt).toMatch(/research subagent/i)
    expect(cfg.allowedToolNames).not.toContain('run_command')
    expect(cfg.allowedToolNames).not.toContain('write_file')
  })

  it('coder → file+shell toolset (no web)', () => {
    const cfg = resolveSubagentConfig({ task: 't', agent_type: 'coder' }, ctx)
    expect(cfg.allowedToolNames).toContain('run_command')
    expect(cfg.allowedToolNames).toContain('edit_file')
    expect(cfg.allowedToolNames).not.toContain('web_fetch')
  })

  it('honors model + reasoning_effort overrides', () => {
    const cfg = resolveSubagentConfig({ task: 't', model: 'claude-fable-5', reasoning_effort: 'high' }, ctx)
    expect(cfg.modelId).toBe('claude-fable-5')
    expect(cfg.effort).toBe('high')
  })

  it('tolerant on blank model / bad effort, but FAIL-CLOSED on an unknown (requested) agent_type', () => {
    const cfg = resolveSubagentConfig({ task: 't', agent_type: 'wizard', model: '   ', reasoning_effort: 'ultra' }, ctx)
    expect(cfg.modelId).toBe('parent-model') // blank model → default
    expect(cfg.effort).toBe('low') // bad effort → default
    // least-privilege: a REQUESTED-but-unknown type is a capability-miss → read-only floor, NOT full toolset
    expect(cfg.allowedToolNames).toEqual(['read_file', 'list_dir', 'search_files', 'glob_files', 'web_fetch'])
    expect(cfg.allowedToolNames).not.toContain('run_command')
    expect(cfg.allowedToolNames).not.toContain('write_file')
    expect(cfg.systemPrompt).toBe('')
  })

  it('general is DEFAULT-DENY: derives file/shell ONLY when the task implies them', () => {
    // a mutation task widens to file tools
    const write = resolveSubagentConfig({ task: 'fix the bug in auth.ts and edit the config' }, ctx)
    expect(write.allowedToolNames).toContain('edit_file')
    expect(write.allowedToolNames).toContain('write_file')
    // a shell task widens to run_command
    const shell = resolveSubagentConfig({ task: 'run the test suite and build the app' }, ctx)
    expect(shell.allowedToolNames).toContain('run_command')
    // a pure read task stays at the read-only floor
    const read = resolveSubagentConfig({ task: 'find where the parser is defined' }, ctx)
    expect(read.allowedToolNames).not.toContain('write_file')
    expect(read.allowedToolNames).not.toContain('run_command')
    // a blank agent_type is treated as no request → general derivation (not the old full toolset)
    expect(resolveSubagentConfig({ task: 'summarize the readme', agent_type: '  ' }, ctx).allowedToolNames)
      .toEqual(['read_file', 'list_dir', 'search_files', 'glob_files', 'web_fetch'])
  })

  it('respects ctx defaults for effort and rounds', () => {
    const cfg = resolveSubagentConfig({ task: 't' }, { defaultModelId: 'm', defaultEffort: 'medium', defaultMaxRounds: 10 })
    expect(cfg.effort).toBe('medium')
    expect(cfg.maxRounds).toBe(10)
  })
})
