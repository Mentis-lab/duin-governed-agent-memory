import { describe, it, expect } from 'vitest'
import { buildStrategyPrompt, buildModelPrompt, runGenerateStrategy, runGenerateModel } from './generate-strategy-native'

describe('generate-strategy — strategy', () => {
  it('prompt is verbatim (title fallback, Playing-to-Win, schema keys)', () => {
    const p = buildStrategyPrompt('project', '', '')
    expect(p).toContain('Draft a STRATEGY for "my overall knowledge work" (project level) using the Playing-to-Win cascade.')
    expect(p).toContain('"aspiration":"goals & aspirations"')
    expect(p).not.toContain('Direction from me:')
  })

  it('includes the direction line when instruction is given', () => {
    expect(buildStrategyPrompt('company', '北澜', 'focus on retention')).toContain('Direction from me: focus on retention ')
  })

  it('returns the 5 sections on a valid model reply', async () => {
    const out = await runGenerateStrategy({ target: '北澜' }, {
      generate: async () => '```json\n{"aspiration":"a","where_to_play":"b","how_to_win":"c","capabilities":"d","values":"e"}\n```'
    })
    expect(out).toEqual({ ok: true, sections: { aspiration: 'a', where_to_play: 'b', how_to_win: 'c', capabilities: 'd', values: 'e' } })
  })

  it('errors on unparseable output', async () => {
    const out = await runGenerateStrategy({}, { generate: async () => 'sorry no json' })
    expect(out).toEqual({ ok: false, error: 'could not parse a strategy from the model output' })
  })

  it('coerces missing keys to empty strings', async () => {
    const out = await runGenerateStrategy({}, { generate: async () => '{"aspiration":"only this"}' })
    expect(out.sections).toEqual({ aspiration: 'only this', where_to_play: '', how_to_win: '', capabilities: '', values: '' })
  })
})

describe('generate-strategy — mental model', () => {
  it('prompt keyspec + description follow the type template', () => {
    const p = buildModelPrompt('lens', 'Second-order thinking', '')
    expect(p).toContain('Draft a thinking lens (a way of looking) titled "Second-order thinking".')
    expect(p).toContain('{"lens":"The lens", "reveals":"What it surfaces", "prompts":"Questions it prompts", "watch_fors":"Watch-fors"}')
  })

  it('unknown type falls back to strategy', () => {
    expect(buildModelPrompt('nonsense', 'X', '')).toContain('Draft a Playing-to-Win strategy titled "X".')
  })

  it('returns typed sections for the chosen template', async () => {
    const out = await runGenerateModel({ type: 'principle', title: 'Slack in the system' }, {
      generate: async () => '{"statement":"s","why":"w","applies_when":"a","examples":"e"}'
    })
    expect(out).toEqual({ ok: true, type: 'principle', sections: { statement: 's', why: 'w', applies_when: 'a', examples: 'e' } })
  })

  it('untitled fallback + error path', async () => {
    expect(buildModelPrompt('framework', '', '')).toContain('titled "(untitled)"')
    expect(await runGenerateModel({ type: 'lens' }, { generate: async () => 'no json' })).toEqual({ ok: false, error: 'could not parse a model from the output' })
  })
})
