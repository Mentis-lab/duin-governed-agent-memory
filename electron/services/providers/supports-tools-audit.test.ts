import { describe, it, expect } from 'vitest'
import { MODEL_CATALOG, resolveModel } from './registry'

describe('FC-2 — supportsTools flag audit', () => {
  it('every model in catalog has a boolean supportsTools', () => {
    for (const model of MODEL_CATALOG) {
      expect(typeof model.supportsTools, `${model.id}: supportsTools must be boolean`).toBe('boolean')
    }
  })

  it('DeepSeek native models have correct supportsTools', () => {
    const v4pro = resolveModel('deepseek-v4-pro')
    expect(v4pro.supportsTools).toBe(true)

    const v4flash = resolveModel('deepseek-v4-flash')
    expect(v4flash.supportsTools).toBe(true)

    const reasoner = resolveModel('deepseek-reasoner')
    expect(reasoner.supportsTools).toBe(true)
    expect(reasoner.id).toBe('deepseek-v4-pro')
  })

  it('Qwen native models have correct supportsTools', () => {
    const max = resolveModel('qwen3-max')
    expect(max.supportsTools).toBe(true)

    const coderPlus = resolveModel('qwen3-coder-plus')
    expect(coderPlus.supportsTools).toBe(true)

    // qwen3.5-plus was retired in the 2026-08-21 redo; the alias resolves to
    // qwen3.7-plus, which DOES support tools (the old false flag was itself
    // stale — current Model Studio docs list function calling on 3.5-plus too).
    const plus35 = resolveModel('qwen3.5-plus')
    expect(plus35.id).toBe('qwen3.7-plus')
    expect(plus35.supportsTools).toBe(true)

    const long = resolveModel('qwen-long')
    expect(long.supportsTools).toBe(false)
  })

  it('Google Gemma models have correct supportsTools', () => {
    const gemma27b = resolveModel('gemma-3-27b-it')
    expect(gemma27b.supportsTools).toBe(true)

    const gemma12b = resolveModel('gemma-3-12b-it')
    expect(gemma12b.supportsTools).toBe(true)
  })

  it('OpenRouter Gemma 4 models have correct supportsTools', () => {
    const g4free = resolveModel('gemma-4-31b-it-free')
    expect(g4free.supportsTools).toBe(true)

    const g4paid = resolveModel('gemma-4-31b-it')
    expect(g4paid.supportsTools).toBe(true)
  })

  it('resolveModel for unknown model falls back to supportsTools=true', () => {
    const custom = resolveModel('custom-unknown-model')
    expect(custom.supportsTools).toBe(true)
  })
})
