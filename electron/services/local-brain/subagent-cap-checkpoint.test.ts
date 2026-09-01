import { describe, it, expect } from 'vitest'
import { deterministicCapCheckpoint } from './agui-subagent'

// The cap checkpoint's fallback. Before this, a subagent that ran out of rounds returned
// `finalText` — which on a cap exit is usually the last TOOL-CALL round and therefore empty, so
// the parent received "(subagent produced no final text)" for a child that had done real work and
// read a truncated attempt as a finished one. The fallback is what runs when no model can write a
// summary, so it has to carry the whole signal on its own.

describe('deterministicCapCheckpoint', () => {
  it('says INCOMPLETE, and says so as "not failed" — the distinction the parent acts on', () => {
    const s = deterministicCapCheckpoint('read 4 files', 7)
    expect(s).toContain('INCOMPLETE')
    // The phrasing is load-bearing: a cut-off child did real work, and a parent that reads it as a
    // failure discards that work and starts over.
    expect(s).toContain('not failed')
  })

  it('names the cap and the work done so the parent can size what remains', () => {
    const s = deterministicCapCheckpoint('', 7)
    expect(s).toContain('round cap')
    expect(s).toContain('7 tool call(s)')
  })

  it('keeps whatever prose the child did produce', () => {
    const s = deterministicCapCheckpoint('Found the config at src/app.ts', 3)
    expect(s).toContain('Found the config at src/app.ts')
  })

  it('is explicit when there was no prose at all (the common cap case)', () => {
    const s = deterministicCapCheckpoint('   ', 3)
    expect(s).toContain('no prose before the cap')
  })

  it('tells the parent to re-dispatch rather than assume completion', () => {
    expect(deterministicCapCheckpoint('x', 1)).toMatch(/re-dispatch/i)
  })
})
