import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { revealForSource } from './reveal-service'
import type { ExtractionChat } from './construct-one-source'
import type { GraphFrame } from './reveal-frames'
import { recordEdgeVerdict, edgeKey } from './edge-verdicts'
import { registerRevealOutcome, type RevealOutcomeRecord } from './reveal-outcomes'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'reveal-service-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const SRC = { id: 'drop:memo.md', text: 'usage-based pricing; Jon Reyes flagged the SLA.' }
const DATA = {
  entities: [
    { id: 'topic:usage-based-pricing', kind: 'topic', label: 'usage-based pricing', note: SRC.id },
    { id: 'person:jon-reyes', kind: 'person', label: 'Jon Reyes', note: SRC.id }
  ],
  edges: [{ source: 'person:jon-reyes', target: 'topic:usage-based-pricing', type: 'mentions' }],
  classifications: [],
  triples: []
}
const chat: ExtractionChat = async () => ({ text: JSON.stringify(DATA), finishReason: 'stop' })

describe('revealForSource (governed composition)', () => {
  it('annotates a proposed edge with a confidence and REVIEW when the source is uncalibrated', async () => {
    const frames: GraphFrame[] = []
    await revealForSource(tmpVault(), SRC, { emit: (f) => frames.push(f), chat, model: 'test-model' })
    const link = frames.find((f) => f.op === 'link-formed')
    expect(link?.confidence).toBe(0.6) // llm prior
    expect(link?.accept).toBe('review') // no calibration yet → review
  })

  it('AUTO-accepts a confident edge once the source:edge-type is calibrated + trusted', async () => {
    const vault = tmpVault()
    // 20 endorsements of llm:mentions → calibrated + high trust
    const rec = (): RevealOutcomeRecord => ({ kind: 'llm:mentions', source: 'llm', edgeType: 'mentions', confidence: 0.6, verdict: 'materialized', ts: 't' })
    for (let i = 0; i < 20; i++) registerRevealOutcome(vault, rec())
    const frames: GraphFrame[] = []
    await revealForSource(vault, SRC, { emit: (f) => frames.push(f), chat, model: 'test-model' })
    expect(frames.find((f) => f.op === 'link-formed')?.accept).toBe('auto')
  })

  it('emits deterministic Wave-1 alias edges for existing entities name-dropped in the text', async () => {
    const frames: GraphFrame[] = []
    await revealForSource(tmpVault(), { id: SRC.id, text: 'This is about DUIN and the walled data garden.' }, {
      emit: (f) => frames.push(f),
      chat,
      model: 'test-model',
      existingEntities: [
        { id: 'project:duin', label: 'DUIN', kind: 'project' },
        { id: 'topic:walled-data-garden', label: 'walled data garden', kind: 'topic' }
      ]
    })
    const aliasLinks = frames.filter((f) => f.op === 'link-formed' && f.src === 'alias')
    expect(aliasLinks.map((f) => f.to).sort()).toEqual(['project:duin', 'topic:walled-data-garden'])
    // Wave-1 alias edges come before the Wave-2 llm edge
    const firstAlias = frames.findIndex((f) => f.src === 'alias')
    const firstLlm = frames.findIndex((f) => f.src === 'llm')
    expect(firstAlias).toBeGreaterThan(-1)
    expect(firstAlias).toBeLessThan(firstLlm)
  })

  it('reconciles a Wave-2 LLM entity onto an existing node Wave-1 matched (no duplicate twin)', async () => {
    const frames: GraphFrame[] = []
    await revealForSource(tmpVault(), { id: SRC.id, text: 'usage-based pricing; Jon Reyes flagged the SLA.' }, {
      emit: (f) => frames.push(f),
      chat,
      model: 'test-model',
      existingEntities: [{ id: 'topic:ubp-existing', label: 'usage-based pricing', kind: 'topic' }]
    })
    // the LLM's freshly-minted topic:usage-based-pricing fuses onto the existing node (merge reported)
    expect(frames.find((f) => f.op === 'entity-merged')).toMatchObject({ into: 'topic:ubp-existing' })
    // and the Wave-2 edge now points at the existing id, not a duplicate
    const llmEdges = frames.filter((f) => f.op === 'link-formed' && f.src === 'llm')
    expect(llmEdges.some((f) => f.to === 'topic:ubp-existing')).toBe(true)
  })

  it('suppresses an edge the operator vetoed (edge-verdict overlay)', async () => {
    const vault = tmpVault()
    recordEdgeVerdict(vault, { from: 'person:jon-reyes', to: 'topic:usage-based-pricing', edgeType: 'mentions', verdict: 'vetoed', ts: 't' })
    const frames: GraphFrame[] = []
    await revealForSource(vault, SRC, { emit: (f) => frames.push(f), chat, model: 'test-model' })
    expect(frames.filter((f) => f.op === 'link-formed')).toHaveLength(0)
  })
})
