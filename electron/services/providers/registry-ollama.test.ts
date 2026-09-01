import { describe, it, expect, vi, afterEach } from 'vitest'

// No bring-your-own keys → exercises the keyless Ollama fallback.
vi.mock('../keychain', () => ({ getKey: () => null, hasKey: () => false }))
vi.mock('../event-log', () => ({ recordEvent: vi.fn() }))

import { detectOllama, resolveCompletionModel, getOllamaModels } from './registry'

function mockFetch(impl: () => Promise<unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = vi.fn(impl) as any
}

afterEach(() => vi.restoreAllMocks())

describe('Ollama auto-detect', () => {
  it('detectOllama parses /api/tags and caches the model list', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5' }] }) }))
    const r = await detectOllama()
    expect(r.available).toBe(true)
    expect(r.models).toEqual(['llama3.2:latest', 'qwen2.5'])
    expect(getOllamaModels()).toContain('qwen2.5')
  })

  it('is unavailable (and clears the cache) when Ollama is not running', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ models: [{ name: 'x' }] }) }))
    await detectOllama()
    mockFetch(async () => { throw new Error('ECONNREFUSED') })
    const r = await detectOllama()
    expect(r.available).toBe(false)
    expect(getOllamaModels()).toHaveLength(0)
  })

  it('resolveCompletionModel falls back to a local Ollama model when no BYO key', async () => {
    mockFetch(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) }))
    await detectOllama()
    expect(resolveCompletionModel()).toBe('ollama:llama3.2:latest')
    // a preferred Ollama model that IS installed is honored
    expect(resolveCompletionModel('ollama:llama3.2:latest')).toBe('ollama:llama3.2:latest')
    // the duin-brain sentinel is never returned
    expect(resolveCompletionModel('duin-brain')).toBe('ollama:llama3.2:latest')
  })

  it('returns null when neither a key nor Ollama is available', async () => {
    mockFetch(async () => { throw new Error('down') })
    await detectOllama()
    expect(resolveCompletionModel()).toBeNull()
  })
})
