// F2 (bounded-context) wiring proof — the tool executors must relevance-bound an over-budget output
// to the turn query when a warm embedder is threaded in, and stay byte-identical to today's blind
// head-slice when it is absent/cold. This locks that boundToBudget is LOAD-BEARING at the executor
// seam (not merely imported), and that the fail-open contract holds.

import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeReadFile } from './agui-executors'
import type { EmbedFn } from '../brain/claim-entities'

// Three blank-line-separated paragraphs. A one-hot keyword embedder makes the LAST paragraph the most
// relevant to the query, so relevance-selection keeps GAMMA while a blind head-slice would keep ALPHA.
const PARA_A = 'alpha ' + 'a'.repeat(200)
const PARA_B = 'beta ' + 'b'.repeat(200)
const PARA_C = 'gamma target ' + 'c'.repeat(200)
const CONTENT = [PARA_A, PARA_B, PARA_C].join('\n\n')

const oneHot = (t: string): number[] => [
  /gamma|target/.test(t) ? 1 : 0,
  /alpha/.test(t) ? 1 : 0,
  /beta/.test(t) ? 1 : 0
]
const warmEmbed: EmbedFn = async (texts: string[]) => texts.map(oneHot)

const dir = mkdtempSync(join(tmpdir(), 'duin-f2-'))
const file = 'big.md'
writeFileSync(join(dir, file), CONTENT, 'utf8')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// Budget that fits ~one paragraph, forcing a real truncation decision.
const MAX = 260

describe('F2 executor relevance-bounding', () => {
  it('keeps the query-relevant chunk when a warm embedder is supplied (not a head-slice)', async () => {
    const r = await executeReadFile(dir, file, MAX, 'gamma target', warmEmbed)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toContain('gamma') // relevance selected the last paragraph
    expect(r.content).not.toContain('alpha') // a blind head-slice would have kept this first paragraph
  })

  it('is byte-identical to the blind head-slice when no embedder is supplied (fail-open)', async () => {
    const r = await executeReadFile(dir, file, MAX) // no query/embed → today's behaviour
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toBe(CONTENT.slice(0, MAX) + '\n\n[…truncated…]')
    expect(r.content).toContain('alpha')
  })

  it('falls back to head-slice when the embedder is cold (returns empty vectors)', async () => {
    const coldEmbed: EmbedFn = async () => []
    const r = await executeReadFile(dir, file, MAX, 'gamma target', coldEmbed)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.content).toBe(CONTENT.slice(0, MAX) + '\n\n[…truncated…]')
  })
})
