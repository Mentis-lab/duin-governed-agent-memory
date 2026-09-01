import { describe, it, expect, afterEach, vi } from 'vitest'

// P8 · private-grounding guard predicates. Keychain is mocked so cloud catalog
// ids resolve without a real key; locality never consults the keychain anyway.
vi.mock('../keychain', () => ({ getKey: vi.fn(() => 'test-key'), hasKey: vi.fn(() => true) }))
vi.mock('../event-log', () => ({ recordEvent: vi.fn() }))

import { isLocalModel, wholeNoteEgressAllowed } from './registry'

const ORIG_ALLOW = process.env.DUIN_WHOLENOTE_ALLOW_CLOUD

afterEach(() => {
  if (ORIG_ALLOW === undefined) delete process.env.DUIN_WHOLENOTE_ALLOW_CLOUD
  else process.env.DUIN_WHOLENOTE_ALLOW_CLOUD = ORIG_ALLOW
})

describe('isLocalModel', () => {
  it('is true for an ollama: prefixed local model', () => {
    expect(isLocalModel('ollama:llama3.2:latest')).toBe(true)
    expect(isLocalModel('ollama:x')).toBe(true)
  })
  it('is false for cloud catalog models', () => {
    expect(isLocalModel('deepseek-v4-pro')).toBe(false)
    expect(isLocalModel('glm-5.2')).toBe(false)
    expect(isLocalModel('claude-sonnet-4-openrouter')).toBe(false)
    expect(isLocalModel('gpt-4o')).toBe(false)
  })
  it('is false for an unknown id (falls back to a cloud DeepSeek descriptor)', () => {
    expect(isLocalModel('some-custom-model')).toBe(false)
  })
  it('is false for empty / missing id', () => {
    expect(isLocalModel('')).toBe(false)
  })
})

describe('wholeNoteEgressAllowed — fails closed', () => {
  it('allows a LOCAL answer model (no egress) regardless of the flag', () => {
    delete process.env.DUIN_WHOLENOTE_ALLOW_CLOUD
    expect(wholeNoteEgressAllowed('ollama:llama3.2')).toBe(true)
  })
  it('BLOCKS a cloud answer model when DUIN_WHOLENOTE_ALLOW_CLOUD is unset', () => {
    delete process.env.DUIN_WHOLENOTE_ALLOW_CLOUD
    expect(wholeNoteEgressAllowed('deepseek-v4-pro')).toBe(false)
    expect(wholeNoteEgressAllowed('glm-5.2')).toBe(false)
  })
  it('ALLOWS a cloud answer model only when DUIN_WHOLENOTE_ALLOW_CLOUD=1 (explicit opt-in)', () => {
    process.env.DUIN_WHOLENOTE_ALLOW_CLOUD = '1'
    expect(wholeNoteEgressAllowed('deepseek-v4-pro')).toBe(true)
    expect(wholeNoteEgressAllowed('gpt-4o')).toBe(true)
  })
  it('treats any non-"1" value as NOT opting in (still blocked for cloud)', () => {
    process.env.DUIN_WHOLENOTE_ALLOW_CLOUD = '0'
    expect(wholeNoteEgressAllowed('deepseek-v4-pro')).toBe(false)
    process.env.DUIN_WHOLENOTE_ALLOW_CLOUD = 'true'
    expect(wholeNoteEgressAllowed('deepseek-v4-pro')).toBe(false)
  })
})
