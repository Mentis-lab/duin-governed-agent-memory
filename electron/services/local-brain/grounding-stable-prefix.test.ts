import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Integration guard for the stable-prefix layout (efficiency campaign §5.1).
//
// prompt-layout.test.ts proves the LAYOUT property in isolation. The risk this file covers is
// different and worse: the stable-prefix branch in buildGroundedMessages re-assembles the prompt
// from the individual block variables, so a block the legacy concat included could silently go
// MISSING — the model would just answer with less grounding and nothing would fail loudly. These
// tests run the REAL buildGroundedMessages under both layouts on identical inputs and assert that
// everything the legacy prompt carried still reaches the model, only repositioned.

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-stable-prefix-test',
    getName: () => 'duin',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

// The `aboutOperator` decomposition is the most intricate part of the split: legacy emits ONE
// `WHAT YOU KNOW ABOUT THE OPERATOR:` header over `operator + '\n' + memory`, while the stable
// layout must route the durable memory index into the cached core and the operator whole-dump into
// the volatile tail. A default test vault has BOTH blocks empty, so without these mocks the case
// silently goes untested. Recall does not run here (no embedder), so this is the !recallActive path
// where the operator dump is present — exactly the case that must not emit a duplicate header.
vi.mock('../memory-store', () => ({ buildMemoryIndexBlock: () => 'MEMORY-INDEX-BODY' }))
vi.mock('../brain/operator-model', () => ({
  buildOperatorBlock: () => 'OPERATOR-PROFILE-BODY',
  getOperatorFacts: () => [],
  isQuarantinedExternal: () => false,
  groundingReliability: () => null,
  isLowTrustDerived: () => false
}))

const QUERY = 'when is BilibiliWorld?'
const HISTORY = [
  { role: 'user' as const, content: 'what is lamprey?' },
  { role: 'assistant' as const, content: 'A fish.' },
  { role: 'user' as const, content: QUERY }
]
const CONTEXT_OVERRIDE = 'bw.md — BilibiliWorld is in July.'
const PINNED = { label: 'BW plan', kind: 'card', content: 'the BW booth plan' }

/** Everything in the request, regardless of which message carries it. */
// `content` is OPTIONAL on the SDK's assistant-message variant, so it must be optional here too.
const allText = (msgs: { content?: unknown }[]): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

async function build() {
  const { buildGroundedMessages } = await import('./agui-grounding')
  return buildGroundedMessages(HISTORY, QUERY, [], CONTEXT_OVERRIDE, PINNED, 'thread-1')
}

describe('buildGroundedMessages — stable-prefix layout', () => {
  const prior = process.env.DUIN_STABLE_PREFIX
  beforeEach(() => {
    delete process.env.DUIN_STABLE_PREFIX
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.DUIN_STABLE_PREFIX
    else process.env.DUIN_STABLE_PREFIX = prior
  })

  it('is OFF by default — today\'s exact shape: one system message carrying the CONTEXT', async () => {
    const msgs = await build()
    expect(msgs[0].role).toBe('system')
    expect(String(msgs[0].content)).toContain(`CONTEXT (retrieved for: ${QUERY})`)
    // history follows verbatim
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs[3].content).toBe(QUERY)
  })

  it('DROPS NOTHING when enabled — every legacy block still reaches the model', async () => {
    const legacy = allText(await build())
    process.env.DUIN_STABLE_PREFIX = '1'
    const stable = allText(await build())

    for (const fragment of [
      'You are DUIN, a local-first second-brain agent', // preamble
      'The CONTEXT below was gathered by an AGENTIC retrieval pass', // retrievalNote
      `CONTEXT (retrieved for: ${QUERY})`, // the retrieved context, with its query framing
      CONTEXT_OVERRIDE,
      'PINNED NOTE', // pinned-note block
      PINNED.content,
      QUERY, // the user's question
      'A fish.' // prior history
    ]) {
      expect(legacy, `legacy prompt should contain: ${fragment}`).toContain(fragment)
      expect(stable, `stable-prefix prompt dropped: ${fragment}`).toContain(fragment)
    }
  })

  it('moves the volatile grounding OFF message[0] and onto the last user message', async () => {
    process.env.DUIN_STABLE_PREFIX = '1'
    const msgs = await build()
    const core = String(msgs[0].content)
    const last = String(msgs[msgs.length - 1].content)

    expect(msgs[0].role).toBe('system')
    expect(core).toContain('You are DUIN')
    // the cached core must carry NO per-turn bytes
    expect(core).not.toContain('CONTEXT (retrieved for:')
    expect(core).not.toContain(QUERY)
    expect(core).not.toContain('PINNED NOTE')

    expect(msgs[msgs.length - 1].role).toBe('user')
    expect(last).toContain(`CONTEXT (retrieved for: ${QUERY})`)
    expect(last.endsWith(QUERY)).toBe(true)
  })

  it('keeps message[0] byte-identical across two turns of the same thread', async () => {
    process.env.DUIN_STABLE_PREFIX = '1'
    const { buildGroundedMessages } = await import('./agui-grounding')
    const turn1 = await buildGroundedMessages(
      [{ role: 'user', content: 'q1' }], 'q1', [], 'ctx one', null, 't'
    )
    const turn2 = await buildGroundedMessages(
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'a totally different q2' }
      ],
      'a totally different q2', [], 'ctx two — different retrieval entirely', PINNED, 't'
    )
    expect(turn1[0].content).toBe(turn2[0].content)
  })

  it('carries the operator-enabled ACTIVE SKILLS block on the volatile tail (not dropped)', async () => {
    // Regression guard: the stable-prefix branch re-assembles the prompt from individual block
    // variables and once omitted activeSkillBlock entirely, so enabling Skills + DUIN_STABLE_PREFIX=1
    // silently sent nothing to the model — the exact "toggle does nothing" defect the floor-tier
    // treatment exists to prevent. The block must reach the model, and (like all per-turn content)
    // ride the volatile tail, never the byte-stable cached core.
    const { buildGroundedMessages } = await import('./agui-grounding')
    const skills = [{ name: 'booth-runbook', content: 'ALWAYS confirm the booth number first.' }]

    const legacy = allText(
      await buildGroundedMessages(HISTORY, QUERY, [], CONTEXT_OVERRIDE, PINNED, 'thread-1', undefined, skills)
    )
    expect(legacy).toContain('ACTIVE SKILLS')
    expect(legacy).toContain('booth-runbook')

    process.env.DUIN_STABLE_PREFIX = '1'
    const msgs = await buildGroundedMessages(
      HISTORY, QUERY, [], CONTEXT_OVERRIDE, PINNED, 'thread-1', undefined, skills
    )
    const core = String(msgs[0].content)
    const tail = String(msgs[msgs.length - 1].content)

    expect(tail).toContain('ACTIVE SKILLS')
    expect(tail).toContain('booth-runbook')
    // per-turn selection must not contaminate the cacheable core
    expect(core).not.toContain('ACTIVE SKILLS')
  })

  it('splits operator/memory without duplicating the header or losing either body', async () => {
    const legacy = allText(await build())
    expect(legacy).toContain('OPERATOR-PROFILE-BODY')
    expect(legacy).toContain('MEMORY-INDEX-BODY')

    process.env.DUIN_STABLE_PREFIX = '1'
    const msgs = await build()
    const core = String(msgs[0].content)
    const tail = String(msgs[msgs.length - 1].content)

    // durable half cached, volatile half on the turn — both still delivered
    expect(core).toContain('MEMORY-INDEX-BODY')
    expect(tail).toContain('OPERATOR-PROFILE-BODY')
    // the operator dump must NOT ride the cached core: its presence flips with recall per turn
    expect(core).not.toContain('OPERATOR-PROFILE-BODY')
    // and the two halves must not be introduced by the SAME heading in two different messages
    expect(tail).not.toContain('WHAT YOU KNOW ABOUT THE OPERATOR:')
    expect(tail).toContain('THE OPERATOR — DURABLE PROFILE:')
  })

  it('preserves the wire shape — still one leading system message, then alternating history', async () => {
    process.env.DUIN_STABLE_PREFIX = '1'
    const msgs = await build()
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs.filter((m) => m.role === 'system')).toHaveLength(1)
  })
})
