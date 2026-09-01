// EXTRACTION_DEFAULT ↔ MODEL_CATALOG parity lock.
//
// routeModel's designated-extractor path only honours EXTRACTION_DEFAULT ids that
// pass isUsableModel(), and isUsableModel matches LIVE catalog ids only. A retired
// id therefore doesn't fail — it silently unreaches the designated pick and drops
// that provider onto the generic tier loop, the throttled/thinking-on hazard the
// map exists to prevent. After the 2026-08-21 catalog redo, 5 of 9 rows were dead
// this way (glm-4.5-airx, moonshot-v1-128k, qwen3.5-flash, claude-haiku-4-openrouter,
// gpt-4o-mini). The map is module-private by design, so this suite reads the source
// text — same technique as provider-cards-parity.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { MODEL_CATALOG, PROVIDERS } from './registry'

const source = readFileSync(join(__dirname, 'registry.ts'), 'utf-8')

/** The `provider: 'model-id'` rows of the EXTRACTION_DEFAULT literal. */
function extractionDefaultRows(): Array<{ provider: string; id: string }> {
  const block = source.match(/const EXTRACTION_DEFAULT[^=]*=\s*\{([\s\S]*?)\n\}/)
  expect(block, 'EXTRACTION_DEFAULT literal not found in registry.ts').toBeTruthy()
  const rows: Array<{ provider: string; id: string }> = []
  const re = /^\s*(\w+):\s*'([^']+)'/gm
  for (let m = re.exec(block![1]); m; m = re.exec(block![1])) {
    rows.push({ provider: m[1], id: m[2] })
  }
  return rows
}

describe('EXTRACTION_DEFAULT ↔ catalog parity', () => {
  const rows = extractionDefaultRows()

  it('found the map at all (the extractor is not silently matching nothing)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(5)
  })

  it('every designated extraction id is a LIVE catalog id', () => {
    const live = new Set(MODEL_CATALOG.map((m) => m.id))
    for (const { provider, id } of rows) {
      expect(live.has(id), `EXTRACTION_DEFAULT.${provider} names '${id}', which is not in MODEL_CATALOG — the designated pick is silently dead for that provider`).toBe(true)
    }
  })

  it('every designated id actually belongs to the provider that designates it', () => {
    for (const { provider, id } of rows) {
      const m = MODEL_CATALOG.find((x) => x.id === id)
      if (m) expect(m.provider, `EXTRACTION_DEFAULT.${provider} names '${id}' which runs on '${m.provider}'`).toBe(provider)
    }
  })

  it('every key in the map is a registry provider', () => {
    for (const { provider } of rows) {
      expect(Object.keys(PROVIDERS), `EXTRACTION_DEFAULT keys unknown provider '${provider}'`).toContain(provider)
    }
  })
})
