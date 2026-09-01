// The runCode tool's wiring through the retrieval loop. The sandbox itself is covered in
// code-sandbox.test.ts; this covers what the LOOP does with it — that it is offered only when
// enabled, that results reach RetrieveResult.computed, that a failure stays distinguishable from
// "no computation", and that a computed number can never be mistaken for something a note said.
import { describe, it, expect, afterEach } from 'vitest'
import {
  retrieveContext,
  renderComputed,
  activeTools,
  codeEvalEnabled,
  defaultCodeEval,
  TOOLS,
  CODE_TOOL,
  type TurnFn,
  type NoteText,
  type CodeEvalFn
} from './retrieve-agent'

const note = (id: string, text: string): NoteText => ({ id, text, lines: text.split('\n') })
const NOTES: NoteText[] = [
  note('a.md', 'Atlas is late'),
  note('b.md', 'Atlas shipped'),
  note('c.md', 'unrelated')
]
const GRAPH = { nodes: [], edges: [] }

/** A driver that calls runCode once, then cites nothing — the pure-computation turn. */
const driverCounting = (code: string): TurnFn => {
  let called = false
  return async () => {
    if (!called) {
      called = true
      return {
        content: '',
        toolCalls: [{ id: 'c1', type: 'function' as const, function: { name: 'runCode', arguments: JSON.stringify({ code }) } }]
      }
    }
    return { content: '{"citations":[]}', toolCalls: [] }
  }
}

const ENV = process.env.DUIN_RETRIEVER_CODE
afterEach(() => {
  if (ENV === undefined) delete process.env.DUIN_RETRIEVER_CODE
  else process.env.DUIN_RETRIEVER_CODE = ENV
})

describe('the flag', () => {
  // Default reversed to OFF on 2026-08-02 after review: the SHIPPED configuration (notes-only
  // scope, 4 turns/16 calls) has never been measured — the 18/18 came from a more capable proxy.
  it('is OFF by default and ON only for an explicit 1', () => {
    delete process.env.DUIN_RETRIEVER_CODE
    expect(codeEvalEnabled()).toBe(false)
    process.env.DUIN_RETRIEVER_CODE = '0'
    expect(codeEvalEnabled()).toBe(false)
    process.env.DUIN_RETRIEVER_CODE = '1'
    expect(codeEvalEnabled()).toBe(true)
  })
})

describe('activeTools', () => {
  it('adds runCode when enabled and is byte-identical to TOOLS when not', () => {
    expect(activeTools(false)).toBe(TOOLS)
    const on = activeTools(true)
    expect(on).toHaveLength(TOOLS.length + 1)
    expect(on[on.length - 1]).toBe(CODE_TOOL)
  })
})

describe('retrieveContext — code ON', () => {
  it('runs the code and records the result on RetrieveResult.computed', async () => {
    const r = await retrieveContext('how many notes mention Atlas', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: true,
      runTurnFn: driverCounting('result = Object.keys(notes).filter(k => notes[k].includes("Atlas")).length')
    })
    expect(r?.computed).toHaveLength(1)
    expect(r?.computed?.[0].result).toBe('2')
    expect(r?.computed?.[0].failed).toBeUndefined()
  })

  it('a computed turn survives with ZERO citations — the case the feature exists for', async () => {
    const r = await retrieveContext('how many notes mention Atlas', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: true,
      runTurnFn: driverCounting('result = 2')
    })
    expect(r?.citations).toHaveLength(0)
    expect(r?.computed?.[0].result).toBe('2')
  })

  it('records a FAILED computation rather than dropping it', async () => {
    const r = await retrieveContext('how many', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: true,
      runTurnFn: driverCounting('throw new Error("bad code")')
    })
    expect(r?.computed).toHaveLength(1)
    expect(r?.computed?.[0].failed).toBe(true)
    expect(r?.computed?.[0].result).toContain('bad code')
  })

  it('accepts an injected evaluator, so the loop is testable without node:vm', async () => {
    let sawCode = ''
    const stub: CodeEvalFn = (code) => {
      sawCode = code
      return { output: '99' }
    }
    const r = await retrieveContext('q', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: true,
      codeEval: stub,
      runTurnFn: driverCounting('result = 1')
    })
    expect(sawCode).toBe('result = 1')
    expect(r?.computed?.[0].result).toBe('99')
  })
})

describe('retrieveContext — code OFF', () => {
  it('omits `computed` entirely, so "unavailable" and "available but unused" stay distinct', async () => {
    const r = await retrieveContext('q', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: false,
      runTurnFn: async () => ({ content: '{"citations":[]}', toolCalls: [] })
    })
    expect(r?.computed).toBeUndefined()
  })

  it('a runCode call is an unknown tool, and the loop survives it', async () => {
    const r = await retrieveContext('q', {
      notes: NOTES,
      graph: GRAPH,
      hyde: false,
      code: false,
      runTurnFn: driverCounting('result = 1')
    })
    expect(r).not.toBeNull()
    expect(r?.computed).toBeUndefined()
  })
})

describe('defaultCodeEval', () => {
  it('exposes the corpus as an id -> text object', () => {
    const r = defaultCodeEval('result = Object.keys(notes).sort()', NOTES)
    expect(r.output).toBe('["a.md","b.md","c.md"]')
  })
  it('is sandboxed — no require reaches the script', () => {
    const r = defaultCodeEval('result = typeof require', NOTES)
    expect(r.output).toBe('undefined')
  })
})

describe('renderComputed', () => {
  it('is empty when there is nothing to report', () => {
    expect(renderComputed()).toBe('')
    expect(renderComputed([])).toBe('')
  })

  it('drops FAILED computations — an error string must never read as evidence', () => {
    expect(renderComputed([{ code: 'x', result: 'ERROR: boom', failed: true }])).toBe('')
  })

  it('labels the value as computed across the vault, not as a note quote', () => {
    const out = renderComputed([{ code: 'result = 2', result: '2' }])
    expect(out).toContain('computed_over_whole_vault')
    expect(out).toContain('COMPUTED across every note')
    expect(out).toContain('=> 2')
    // the guard that matters: it must tell the model to prefer this over counting the excerpts
    expect(out).toMatch(/Prefer them over any count/i)
  })
})
