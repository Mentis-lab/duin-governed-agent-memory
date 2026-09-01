import { describe, it, expect } from 'vitest'
import { generateOnce, type GenerateDeps } from './generate-once-native'

// A fake chatStream that feeds canned chunks then onDone. Matches the registry callback shape.
function fakeDeps(modelId: string | null, chunks: string[], full?: string): GenerateDeps {
  return {
    routeModel: () => modelId,
    chatStream: (async (_messages, _model, _tools, callbacks) => {
      for (const c of chunks) callbacks.onChunk(c)
      callbacks.onDone(full ?? chunks.join(''))
    }) as GenerateDeps['chatStream']
  }
}

describe('generate-once-native', () => {
  it('collects streamed text and returns the full content (trimmed)', async () => {
    const out = await generateOnce('hi', 'extraction', undefined, fakeDeps('m1', ['{"a":', '1}'], '  {"a":1}  '))
    expect(out).toBe('{"a":1}')
  })
  it('falls back to accumulated chunks when onDone gives empty', async () => {
    const out = await generateOnce('hi', 'extraction', undefined, fakeDeps('m1', ['part-a', 'part-b'], ''))
    expect(out).toBe('part-apart-b')
  })
  it('returns "" when no keyed model is available', async () => {
    const out = await generateOnce('hi', 'reason', undefined, fakeDeps(null, ['ignored']))
    expect(out).toBe('')
  })
  it('returns "" for an empty prompt (no model call)', async () => {
    let called = false
    const deps: GenerateDeps = {
      routeModel: () => {
        called = true
        return 'm1'
      },
      chatStream: (async () => undefined) as GenerateDeps['chatStream']
    }
    expect(await generateOnce('', 'extraction', undefined, deps)).toBe('')
    expect(called).toBe(false)
  })
  it('never throws — a chatStream error yields "" (best-effort)', async () => {
    const deps: GenerateDeps = {
      routeModel: () => 'm1',
      chatStream: (async () => {
        throw new Error('provider down')
      }) as GenerateDeps['chatStream']
    }
    expect(await generateOnce('hi', 'extraction', undefined, deps)).toBe('')
  })
})
