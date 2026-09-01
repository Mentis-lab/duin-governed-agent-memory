import { describe, it, expect } from 'vitest'
import {
  MODEL_CATALOG,
  PROVIDERS,
  normalizeCatalogPayload,
  ModelCatalogUnsupportedError
} from './registry'

// Structural invariants the provider expansion must never silently break.
// These are cheap set/shape assertions — the live-id truth lives in
// verifyCatalog / listLiveModelIds and the smoke playbook, never in a unit test.

describe('catalog structural invariants', () => {
  it('every catalog model references an existing built-in provider', () => {
    for (const m of MODEL_CATALOG) {
      expect(
        Object.prototype.hasOwnProperty.call(PROVIDERS, m.provider),
        `${m.id} → unknown provider '${m.provider}'`
      ).toBe(true)
    }
  })

  it('model ids are globally unique', () => {
    const seen = new Map<string, number>()
    for (const m of MODEL_CATALOG) seen.set(m.id, (seen.get(m.id) ?? 0) + 1)
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    expect(dupes).toEqual([])
  })

  it('shared apiModelIds within a provider are deliberate context-window variants only', () => {
    // DUIN (unlike upstream) intentionally aliases variants onto ONE wire model —
    // e.g. glm-5.2 (128K) and glm-5.2-1m (1M) both send apiModelId 'glm-5.2', the
    // 1M window being an app-side capability. So a duplicate (provider, apiModelId)
    // pair is legal ONLY when the entries are genuine variants: distinct catalog
    // ids AND distinct context windows. Accidental copy-paste (same window) fails.
    const byWireId = new Map<string, typeof MODEL_CATALOG>()
    for (const m of MODEL_CATALOG) {
      const key = `${m.provider} ${m.apiModelId}`
      const arr = byWireId.get(key) ?? []
      arr.push(m)
      byWireId.set(key, arr)
    }
    for (const [key, group] of byWireId) {
      if (group.length === 1) continue
      const ids = new Set(group.map((m) => m.id))
      const windows = new Set(group.map((m) => m.contextWindow))
      expect(ids.size, `${key}: duplicate catalog ids share a wire model`).toBe(group.length)
      expect(
        windows.size,
        `${key}: ${group.length} entries share a wire model AND a context window (accidental dupe?)`
      ).toBe(group.length)
    }
  })

  it('every key-required provider can verify a key: a discoverable catalog or a chat-probe floor', () => {
    // DUIN shape: a keyless/local runtime (keyOptional) is exempt. Otherwise the
    // provider must give validateProviderKeyDetailed *something* to authenticate
    // against — either a machine-readable catalog (catalog.kind !== 'unsupported',
    // which includes the default OpenAI /v1/models when `catalog` is omitted), or
    // at least one pinned MODEL_CATALOG entry validateViaChatProbe can probe.
    for (const p of Object.values(PROVIDERS)) {
      if (p.keyOptional) continue
      const count = MODEL_CATALOG.filter((m) => m.provider === p.id).length
      const hasDiscoverableCatalog = p.catalog?.kind !== 'unsupported'
      expect(
        hasDiscoverableCatalog || count > 0,
        `${p.id} has neither a discoverable catalog nor a model to probe with`
      ).toBe(true)
    }
  })

  it('every provider descriptor carries a usable label, baseURL, docsUrl, and keyEnv===id', () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.label.trim().length, `${p.id}: empty label`).toBeGreaterThan(0)
      expect(/^https?:\/\//i.test(p.baseURL), `${p.id}: non-http baseURL '${p.baseURL}'`).toBe(true)
      expect(p.docsUrl.trim().length, `${p.id}: empty docsUrl`).toBeGreaterThan(0)
      expect(p.keyEnv, `${p.id}: keyEnv must equal the provider id`).toBe(p.id)
    }
  })

  it('every url-catalog strategy is fully specified', () => {
    for (const p of Object.values(PROVIDERS)) {
      const c = p.catalog
      if (!c || c.kind !== 'url') continue
      expect(/^https?:\/\//i.test(c.url), `${p.id}: non-http catalog url`).toBe(true)
      expect(['openai', 'array', 'deepinfra']).toContain(c.format)
      expect(['bearer', 'x-api-key', 'none']).toContain(c.auth)
    }
  })

  it('context windows are sane positive integers', () => {
    for (const m of MODEL_CATALOG) {
      expect(Number.isInteger(m.contextWindow), `${m.id}: non-integer contextWindow`).toBe(true)
      expect(m.contextWindow, `${m.id}: contextWindow too small`).toBeGreaterThanOrEqual(8_192)
    }
  })

  it('descriptions and names are non-empty', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.name.trim().length, `${m.id}: empty name`).toBeGreaterThan(0)
      expect(m.description.trim().length, `${m.id}: empty description`).toBeGreaterThan(0)
    }
  })
})

describe('normalizeCatalogPayload', () => {
  it('reads the OpenAI {data:[{id}]} shape', () => {
    const ids = normalizeCatalogPayload(
      { data: [{ id: 'b' }, { id: 'a' }, { id: '  ' }, { nope: 1 }] },
      'openai'
    )
    expect(ids).toEqual(['a', 'b']) // trimmed, sorted, blanks dropped
  })

  it('reads a bare array of {id} rows', () => {
    const ids = normalizeCatalogPayload([{ id: 'z' }, { id: 'z' }, { id: 'y' }], 'array')
    expect(ids).toEqual(['y', 'z']) // de-duplicated
  })

  it('reads DeepInfra rows on model_name, filtering to live text-generation', () => {
    const ids = normalizeCatalogPayload(
      [
        { model_name: 'live', type: 'text-generation' },
        { model_name: 'reported', reported_type: 'text-generation' },
        { model_name: 'image', type: 'text-to-image' },
        { model_name: 'gone', type: 'text-generation', deprecated: '2025-01-01' }
      ],
      'deepinfra'
    )
    expect(ids).toEqual(['live', 'reported'])
  })

  it('returns an empty list for a malformed payload rather than throwing', () => {
    expect(normalizeCatalogPayload(null, 'openai')).toEqual([])
    expect(normalizeCatalogPayload({ data: 'nope' }, 'openai')).toEqual([])
    expect(normalizeCatalogPayload(42, 'array')).toEqual([])
  })
})

describe('ModelCatalogUnsupportedError', () => {
  it('names the provider and carries the right error name', () => {
    const err = new ModelCatalogUnsupportedError('Some Provider')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ModelCatalogUnsupportedError')
    expect(err.message).toContain('Some Provider')
  })
})
