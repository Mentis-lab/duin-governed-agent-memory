import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildEnrichPrompt, parseEnrichment, groundedIn, enrichEntity, readEnrichments, writeEnrichment, currentEnrichment, enrichmentPath, applyEntityDescriptions } from './entity-enrich'
import type { EntityCard } from './entity-card'

const card = (over: Partial<EntityCard> = {}): EntityCard => ({
  id: 'project:yunque',
  label: '云雀',
  kind: 'project',
  labelBy: null,
  extractedLabel: null,
  aliases: ['Sky Watch'],
  facts: [
    { other: '2026-12-01', relation: 'has deadline', direction: 'subject', note: 'n/a.md', current: true, validFrom: '2026-03-01', validUntil: null, observedAt: null, source: 'triple' },
    { other: 'Tessa', relation: 'owns', direction: 'object', note: 'n/a.md', current: false, validFrom: null, validUntil: '2026-01-01', observedAt: null, source: 'claim' }
  ],
  factsTotal: 2,
  relations: [{ type: 'affects', dir: 'out', id: 'topic:launch', label: 'Launch', kind: 'topic' }],
  relationsTotal: 1,
  sources: [{ path: 'n/a.md', title: 'a', snippet: '云雀 is the publishing project for Q4.', mtime: null }],
  sourcesTotal: 1,
  firstSeen: null,
  lastSeen: null,
  mergeCandidates: [],
  enrichment: null,
  materialHash: 'abcd1234',
  ...over
})

describe('buildEnrichPrompt', () => {
  it('lists label, kind, aliases, facts with currency and dates, relations, snippets and the JSON contract', () => {
    const p = buildEnrichPrompt(card())
    expect(p).toContain('Entity: 云雀')
    expect(p).toContain('Kind: project')
    expect(p).toContain('Other names already known: Sky Watch')
    expect(p).toContain('- 云雀 has deadline 2026-12-01 (since 2026-03-01)')
    expect(p).toContain('- * Tessa owns 云雀')
    expect(p).toContain('- 云雀 affects Launch (topic)')
    expect(p).toContain('- a: "云雀 is the publishing project for Q4."')
    expect(p).toContain('Return ONLY a JSON object')
    expect(p).toContain('ONLY the material below')
  })
})

describe('groundedIn / parseEnrichment', () => {
  const material = buildEnrichPrompt(card())
  it('grounds latin tokens and CJK bigrams', () => {
    expect(groundedIn(material, 'Q4 deadline')).toBe(true)
    expect(groundedIn(material, '发行项目')).toBe(false)
    expect(groundedIn(material, '云雀项目')).toBe(true)
    expect(groundedIn(material, '')).toBe(false)
  })
  it('keeps grounded attributes and aliases, drops invented ones, caps the description', () => {
    const text = `Sure! Here is the JSON:\n{"description": "${'云雀 is a publishing project. '.repeat(30)}", "attributes": [{"key": "Deadline", "value": "2026-12-01"}, {"key": "owner", "value": "Alice Smith"}, {"key": "deadline", "value": "again"}], "aliases": ["Sky Watch", "Project Moon", "云雀", "publishing project"]}`
    const r = parseEnrichment(text, material, '云雀')!
    expect(r.description.length).toBeLessThanOrEqual(320)
    expect(r.description.endsWith('…')).toBe(true)
    expect(r.attributes).toEqual([{ key: 'deadline', value: '2026-12-01' }])
    expect(r.aliases).toEqual(['Sky Watch'])
  })
  it('drops aliases that name another entity on the card or bolt words onto the label', () => {
    const text = '{"description": "d", "aliases": ["Sky Watch", "Launch", "云雀 forecast", "Tessa"]}'
    const r = parseEnrichment(text, material, '云雀', ['Launch', 'Tessa'])!
    expect(r.aliases).toEqual(['Sky Watch'])
  })
  it('is null without a description', () => {
    expect(parseEnrichment('no json here', material, 'x')).toBeNull()
    expect(parseEnrichment('{"attributes": []}', material, 'x')).toBeNull()
  })
})

describe('enrichEntity + store', () => {
  let vault = ''
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-enrich-'))
  })
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true })
  })

  it('calls the model once, persists, and serves the stored result while the material matches', async () => {
    let calls = 0
    const call = async (prompt: string, model: string): Promise<string> => {
      calls++
      expect(model).toBe('ollama:test')
      expect(prompt).toContain('Entity: 云雀')
      return '{"description": "云雀 is the Q4 publishing project.", "attributes": [{"key":"deadline","value":"2026-12-01"}], "aliases": []}'
    }
    const c = card()
    const e1 = await enrichEntity(vault, c, { call, model: 'ollama:test' })
    expect(e1?.description).toBe('云雀 is the Q4 publishing project.')
    expect(e1?.model).toBe('ollama:test')
    expect(e1?.materialHash).toBe('abcd1234')
    expect(existsSync(enrichmentPath(vault)!)).toBe(true)
    const e2 = await enrichEntity(vault, c, { call, model: 'ollama:test' })
    expect(calls).toBe(1)
    expect(e2?.at).toBe(e1?.at)
    expect(currentEnrichment(vault, c)?.id).toBe('project:yunque')
    // changed material: stale → re-described
    const e3 = await enrichEntity(vault, card({ materialHash: 'ffff0000' }), { call, model: 'ollama:test' })
    expect(calls).toBe(2)
    expect(e3?.materialHash).toBe('ffff0000')
    expect(currentEnrichment(vault, c)).toBeNull()
    const file = JSON.parse(readFileSync(enrichmentPath(vault)!, 'utf-8')) as { version: number; entities: Record<string, unknown> }
    expect(file.version).toBe(1)
    expect(Object.keys(file.entities)).toEqual(['project:yunque'])
  })

  it('returns null without a model call when model is null and nothing is stored', async () => {
    let calls = 0
    const e = await enrichEntity(vault, card(), { call: async () => { calls++; return '{}' }, model: null })
    expect(e).toBeNull()
    expect(calls).toBe(0)
  })

  it('returns null and stores nothing when the model answer does not parse', async () => {
    const e = await enrichEntity(vault, card(), { call: async () => 'I cannot do that.', model: 'ollama:test' })
    expect(e).toBeNull()
    expect(readEnrichments(vault).size).toBe(0)
  })

  it('shares one in-flight call between concurrent requests for the same id', async () => {
    let calls = 0
    const call = async (): Promise<string> => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return '{"description": "d"}'
    }
    const [a, b] = await Promise.all([enrichEntity(vault, card(), { call, model: 'm' }), enrichEntity(vault, card(), { call, model: 'm' })])
    expect(calls).toBe(1)
    expect(a?.at).toBe(b?.at)
  })

  it('applyEntityDescriptions stamps construction nodes only', () => {
    writeEnrichment(vault, { id: 'topic:x', description: 'about x', attributes: [], aliases: [], model: 'm', materialHash: 'h', at: 'now' })
    const nodes = [
      { id: 'topic:x', layer: 'construction' },
      { id: 'topic:y', layer: 'construction' },
      { id: 'topic:x', layer: 'notes' }
    ] as Array<{ id: string; layer?: unknown; desc?: unknown; descBy?: unknown }>
    applyEntityDescriptions(nodes, readEnrichments(vault))
    expect(nodes[0].desc).toBe('about x')
    expect(nodes[0].descBy).toBe('m')
    expect(nodes[1].desc).toBeUndefined()
    expect(nodes[2].desc).toBeUndefined()
  })
})
