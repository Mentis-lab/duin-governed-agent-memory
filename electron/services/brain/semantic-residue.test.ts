import { describe, it, expect } from 'vitest'
import { buildResiduePrompt, parseResidueVerdicts, runSemanticResidue, type ResidueDeps } from './semantic-residue'

describe('semantic-residue — buildResiduePrompt', () => {
  it('is empty when there is nothing to judge', () => {
    expect(buildResiduePrompt([], ['topic'])).toEqual([])
    expect(buildResiduePrompt([{ id: 'a', text: 'x' }], [])).toEqual([])
  })
  it('lists resolved matters + tagged beliefs; instructs conservative JSON output', () => {
    const msgs = buildResiduePrompt([{ id: 'f1', text: 'orbis is the top priority' }], ['recommit orbis as priority'])
    expect(msgs[0].content).toMatch(/CONSERVATIVE/)
    expect(msgs[1].content).toContain('recommit orbis as priority')
    expect(msgs[1].content).toContain('[f1] orbis is the top priority')
  })
})

describe('semantic-residue — parseResidueVerdicts', () => {
  const ids = new Set(['f1', 'f2'])
  it('parses a clean JSON array, keeping only known ids', () => {
    const out = parseResidueVerdicts('[{"id":"f1","topic":"t","reason":"settled"},{"id":"nope","topic":"t","reason":"r"}]', ids)
    expect(out).toEqual([{ id: 'f1', topic: 't', reason: 'settled' }])
  })
  it('tolerates prose around the JSON', () => {
    const out = parseResidueVerdicts('Sure, here you go:\n[{"id":"f2","topic":"x","reason":"y"}]\nDone.', ids)
    expect(out).toEqual([{ id: 'f2', topic: 'x', reason: 'y' }])
  })
  it('returns [] on garbage or an empty array', () => {
    expect(parseResidueVerdicts('no json here', ids)).toEqual([])
    expect(parseResidueVerdicts('[]', ids)).toEqual([])
  })
  it('supplies a default reason when the model omits it', () => {
    const out = parseResidueVerdicts('[{"id":"f1","topic":"t"}]', ids)
    expect(out[0].reason).toMatch(/settled/i)
  })
})

describe('semantic-residue — runSemanticResidue', () => {
  it('returns [] with no model configured', async () => {
    const deps: ResidueDeps = { model: () => null, chat: async () => '[]' }
    expect(await runSemanticResidue([{ id: 'f1', text: 'x' }], ['t'], deps)).toEqual([])
  })
  it('flags the paraphrase case the deterministic layer misses', async () => {
    // fact shares NO verbatim tokens with the topic — only the model can connect them
    const deps: ResidueDeps = {
      model: () => 'test-model',
      chat: async () => '[{"id":"f1","topic":"recommit orbis as priority","reason":"the belief assumes the priority is still open, but it was settled"}]'
    }
    const out = await runSemanticResidue(
      [{ id: 'f1', text: 'we should keep debating which studio to back first' }],
      ['recommit orbis as priority'],
      deps
    )
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('f1')
  })
  it('swallows model errors → []', async () => {
    const deps: ResidueDeps = { model: () => 'm', chat: async () => { throw new Error('boom') } }
    expect(await runSemanticResidue([{ id: 'f1', text: 'x' }], ['t'], deps)).toEqual([])
  })
})
