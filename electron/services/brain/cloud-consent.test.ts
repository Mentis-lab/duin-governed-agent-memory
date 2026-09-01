// cloud-consent — the rule that keeps a stranger's key from paying for unattended vault
// extraction (release M11, A4 F7 / R1 C4). Pure rule + the live gate with injected deps.

import { describe, it, expect } from 'vitest'
import { cloudWorkAllowedFor, automaticCloudWorkAllowed } from './cloud-consent'

/** The injected locality predicate: only an Ollama route is on-device. */
const onlyOllamaIsLocal = (id: string): boolean => id.startsWith('ollama:')

describe('cloudWorkAllowedFor — pure rule', () => {
  it('declines on a fresh install with a cloud model routable (key present, nothing consented)', () => {
    const v = cloudWorkAllowedFor({}, 'deepseek-chat', onlyOllamaIsLocal)
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('no-cloud-consent')
  })

  it('allows once the operator saved a key after the disclosure (cloudExtractionConsent)', () => {
    expect(cloudWorkAllowedFor({ cloudExtractionConsent: true }, 'deepseek-chat', onlyOllamaIsLocal).ok).toBe(true)
  })

  it('allows under backgroundAutonomy (the master switch for unattended billable work)', () => {
    expect(cloudWorkAllowedFor({ backgroundAutonomy: true }, 'deepseek-chat', onlyOllamaIsLocal).ok).toBe(true)
  })

  it('needs an explicit boolean true — strings and other truthy junk do not consent', () => {
    for (const v of ['true', 1, 'yes', {}]) {
      expect(cloudWorkAllowedFor({ cloudExtractionConsent: v }, 'deepseek-chat', onlyOllamaIsLocal).ok).toBe(false)
      expect(cloudWorkAllowedFor({ backgroundAutonomy: v }, 'deepseek-chat', onlyOllamaIsLocal).ok).toBe(false)
    }
  })

  it('allows a LOCAL model with no consent at all — Ollama egresses nothing', () => {
    expect(cloudWorkAllowedFor({}, 'ollama:qwen2.5', onlyOllamaIsLocal).ok).toBe(true)
  })

  it('allows when nothing is routable — there is nothing to spend, the pass no-ops key-gated', () => {
    expect(cloudWorkAllowedFor({}, null, onlyOllamaIsLocal).ok).toBe(true)
  })
})

describe('automaticCloudWorkAllowed — live gate with injected deps', () => {
  it('resolves settings and the extraction route fresh per call', () => {
    let consent = false
    const deps = {
      settings: () => ({ cloudExtractionConsent: consent }),
      extractionModel: () => 'deepseek-chat',
      isLocal: () => false
    }
    expect(automaticCloudWorkAllowed(deps).ok).toBe(false)
    consent = true
    expect(automaticCloudWorkAllowed(deps).ok).toBe(true)
  })

  it('fails CLOSED when settings cannot be read', () => {
    const v = automaticCloudWorkAllowed({
      settings: () => {
        throw new Error('unreadable')
      },
      extractionModel: () => 'deepseek-chat',
      isLocal: () => false
    })
    expect(v.ok).toBe(false)
    expect(v.detail).toMatch(/unreadable/)
  })

  it('treats a throwing router as "nothing routable" rather than crashing the caller', () => {
    const v = automaticCloudWorkAllowed({
      settings: () => ({}),
      extractionModel: () => {
        throw new Error('registry not ready')
      },
      isLocal: () => false
    })
    expect(v.ok).toBe(true)
  })
})
