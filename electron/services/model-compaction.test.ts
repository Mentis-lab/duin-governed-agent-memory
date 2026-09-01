import { describe, it, expect, vi } from 'vitest'
import {
  runModelCompaction,
  buildCompactionDirective,
  pickAnchorRow,
  modelCompactionEnabled,
  DETERMINISTIC_BACKSTOP_THRESHOLD_PCT,
  type ModelCompactionDeps
} from './model-compaction'
import type { CompressorRow } from './context-compressor'

const row = (id: string, content: string, at = 1000): CompressorRow => ({
  id,
  conversation_id: 'c1',
  role: 'user',
  content,
  created_at: at,
  compressed_into: null
})

// Selections must be big enough that a short summary passes the ≥5%
// reduction gate.
const bigSelection = () => [
  row('m1', 'alpha '.repeat(200), 1000),
  row('m2', 'bravo '.repeat(200), 2000),
  row('m3', 'charlie boundary anchor line', 3000)
]

function makeDeps(overrides: Partial<ModelCompactionDeps> = {}): ModelCompactionDeps {
  return {
    shouldCompress: () => true,
    selectMessages: () => bigSelection(),
    persist: vi.fn((conversationId, selection, summaryText) => ({
      summaryMessageId: 'sum-1',
      compressedCount: selection.length,
      originalTokens: 1000,
      summaryTokens: Math.ceil(summaryText.length / 4),
      reductionPct: 0.9
    })),
    complete: vi.fn(async () => 'Key decisions: use bravo. Open question: charlie.'),
    ...overrides
  }
}

const input = (conversationId = 'c1') => ({
  conversationId,
  contextWindow: 1000,
  modelId: 'deepseek-chat',
  apiMessages: [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' }
  ]
})

describe('runModelCompaction — prefix-extension summarization', () => {
  it('happy path: extends the exact apiMessages with one directive, persists wrapped summary', async () => {
    const deps = makeDeps()
    const result = await runModelCompaction(input('happy-1'), deps)

    expect(result).not.toBeNull()
    // The request is the turn's own messages + ONE trailing user directive.
    const sent = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(sent).toHaveLength(4)
    expect(sent.slice(0, 3)).toEqual(input().apiMessages)
    expect(sent[3].role).toBe('user')
    expect(sent[3].content).toContain('charlie boundary anchor line')
    expect(sent[3].content).toContain('Do not summarize anything after')

    const persisted = (deps.persist as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(persisted[2]).toContain('<conversation_summary>')
    expect(persisted[2]).toContain('model-compacted')
    expect(persisted[2]).toContain('Key decisions: use bravo.')
    expect(persisted[3]).toBe('model')
  })

  it('threads the turn\'s tool list through to the completion (prefix parity)', async () => {
    const deps = makeDeps()
    const tools = [{ type: 'function', function: { name: 'run_command' } }]
    await runModelCompaction({ ...input('tools-1'), tools }, deps)
    const call = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[3]).toBe(tools)
  })

  it('below threshold → null, no model call', async () => {
    const deps = makeDeps({ shouldCompress: () => false })
    expect(await runModelCompaction(input('t-1'), deps)).toBeNull()
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it('model failure → null, nothing persisted (backstop takes over later)', async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => {
        throw new Error('provider down')
      })
    })
    await expect(runModelCompaction(input('fail-1'), deps)).rejects.toThrow('provider down')
    expect(deps.persist).not.toHaveBeenCalled()
    // The in-flight guard must be released after a failure.
    const deps2 = makeDeps()
    expect(await runModelCompaction(input('fail-1'), deps2)).not.toBeNull()
  })

  it('empty / whitespace reply → null, no persist', async () => {
    const deps = makeDeps({ complete: vi.fn(async () => '   \n ') })
    expect(await runModelCompaction(input('empty-1'), deps)).toBeNull()
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('summary not materially smaller than originals → null, no persist', async () => {
    const deps = makeDeps({
      selectMessages: () => [row('m1', 'short original', 1000)],
      complete: vi.fn(async () => 'a very long reply '.repeat(50))
    })
    expect(await runModelCompaction(input('big-1'), deps)).toBeNull()
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('echoed envelope tags are stripped before wrapping', async () => {
    const deps = makeDeps({
      complete: vi.fn(
        async () => '<conversation_summary>the facts</conversation_summary>'
      )
    })
    const result = await runModelCompaction(input('tags-1'), deps)
    expect(result).not.toBeNull()
    const summaryText = (deps.persist as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
    // Exactly one envelope — the module's own wrap.
    expect(summaryText.match(/<conversation_summary>/g)).toHaveLength(1)
    expect(summaryText).toContain('the facts')
  })

  it('concurrent call on the same conversation is refused; other conversations proceed', async () => {
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => (release = r))
    const deps = makeDeps({ complete: vi.fn(() => gate) })
    const first = runModelCompaction(input('race-1'), deps)

    const depsSecond = makeDeps()
    expect(await runModelCompaction(input('race-1'), depsSecond)).toBeNull()
    expect(depsSecond.complete).not.toHaveBeenCalled()
    expect(await runModelCompaction(input('race-2'), depsSecond)).not.toBeNull()

    release('late summary of the early messages')
    expect(await first).not.toBeNull()
  })

  it('selection with no visible content (pure tool-call rows) → null, no model call', async () => {
    const deps = makeDeps({
      selectMessages: () => [row('m1', '', 1000), row('m2', '   ', 2000)]
    })
    expect(await runModelCompaction(input('anchor-1'), deps)).toBeNull()
    expect(deps.complete).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('pickAnchorRow takes the LAST row with visible content', () => {
    const sel = [row('a', 'first'), row('b', 'last visible'), row('c', '  ')]
    expect(pickAnchorRow(sel)?.id).toBe('b')
    expect(pickAnchorRow([row('x', ' ')])).toBeNull()
  })

  it('directive embeds the anchor excerpt and demands a bare reply', () => {
    const d = buildCompactionDirective('the anchor text')
    expect(d).toContain('"the anchor text"')
    expect(d).toContain('contains, at or near its start')
    expect(d).toContain('ONLY the summary text')
  })

  it('flag + backstop threshold constants', () => {
    expect(modelCompactionEnabled()).toBe(process.env.DUIN_MODEL_COMPACTION === '1')
    expect(DETERMINISTIC_BACKSTOP_THRESHOLD_PCT).toBe(0.9)
  })
})
