import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// voice-directive-path.test.ts — the Voice & tone preset must reach the DEFAULT chat path.
//
// THE DEFECT THIS PINS (the "wired-looking but inert" shape). `resolveToneDirective` had exactly one
// reader: system-prompt-builder.buildSystemPrompt. buildSystemPrompt has two production callers —
// headless-runner and ipc/chat.ts's runHeadlessTurn — and the interactive handler reaches the second
// one ONLY on the `raw:`-prefixed escape hatch. Every normal model selection takes the brain branch
// (`if (!rawBypass)`), which returns ~500 lines earlier, so the <voice> block was never composed and
// never crossed the wire. Picking "Caveman" persisted the id, lit the tile, and changed nothing about
// the reply — the exact inverse of what the panel promises, with no error to notice.
//
// WHY A GREP COULDN'T CATCH IT: the symbol WAS called, from a function that WAS production code. Only
// the reachability of that function from the default branch was false. So these tests assert the
// three links of the chain separately: resolve+forward (ipc/chat.ts), transport (buildAguiBody), and
// composition (buildGroundedMessages) — a break in any one of them reintroduces a silent no-op.

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-voice-directive-test',
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

const QUERY = 'what is the booth plan?'
const HISTORY = [{ role: 'user' as const, content: QUERY }]
const CONTEXT_OVERRIDE = 'bw.md — the booth plan.'

/** Everything in the request, regardless of which message carries it. */
const allText = (msgs: { content?: unknown }[]): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

async function groundedText(voice?: string): Promise<string> {
  const { buildGroundedMessages } = await import('./agui-grounding')
  return allText(
    await buildGroundedMessages(
      HISTORY, QUERY, [], CONTEXT_OVERRIDE, null, 'thread-voice',
      undefined, undefined, undefined, undefined, undefined, voice
    )
  )
}

describe('voice/tone preset — composition into the grounding prompt', () => {
  const priorPrefix = process.env.DUIN_STABLE_PREFIX
  const priorCompiler = process.env.DUIN_CONTEXT_COMPILER
  beforeEach(() => {
    delete process.env.DUIN_STABLE_PREFIX
    delete process.env.DUIN_CONTEXT_COMPILER
  })
  afterEach(() => {
    if (priorPrefix === undefined) delete process.env.DUIN_STABLE_PREFIX
    else process.env.DUIN_STABLE_PREFIX = priorPrefix
    if (priorCompiler === undefined) delete process.env.DUIN_CONTEXT_COMPILER
    else process.env.DUIN_CONTEXT_COMPILER = priorCompiler
  })

  it('renders the <voice> block into the prompt (legacy concat — the shipped default)', async () => {
    const { resolveToneDirective } = await import('../agent-tones')
    const caveman = resolveToneDirective('caveman')
    expect(caveman).not.toBe('')

    const text = await groundedText(caveman)
    // Same wrapper buildSystemPrompt uses, so the brain path and the raw:/headless path deliver an
    // identical block rather than two dialects of the same instruction.
    expect(text).toContain('<voice>')
    expect(text).toContain('</voice>')
    expect(text).toContain('caveman mode — minimize output tokens')
  })

  it('survives the context compiler (durably armed in this operator env — floor tier, never dropped)', async () => {
    process.env.DUIN_CONTEXT_COMPILER = '1'
    const { resolveToneDirective } = await import('../agent-tones')
    const text = await groundedText(resolveToneDirective('warm'))
    expect(text).toContain('<voice>')
    expect(text).toContain('warm, personable, and encouraging')
  })

  it('survives the stable-prefix layout (rides the volatile tail, never the cached core)', async () => {
    process.env.DUIN_STABLE_PREFIX = '1'
    const { buildGroundedMessages } = await import('./agui-grounding')
    const { resolveToneDirective } = await import('../agent-tones')
    const msgs = await buildGroundedMessages(
      HISTORY, QUERY, [], CONTEXT_OVERRIDE, null, 'thread-voice',
      undefined, undefined, undefined, undefined, undefined, resolveToneDirective('concise')
    )
    const core = String(msgs[0].content)
    const tail = String(msgs[msgs.length - 1].content)
    expect(tail).toContain('<voice>')
    expect(tail).toContain('concise and direct')
    // The preset can be changed mid-thread; a core whose bytes move destroys the prefill cache it
    // exists to protect, so the block must NOT live there.
    expect(core).not.toContain('<voice>')
  })

  it("emits nothing for 'balanced'/absent — the default prompt is byte-identical to before", async () => {
    const { resolveToneDirective } = await import('../agent-tones')
    expect(resolveToneDirective('balanced')).toBe('')
    const baseline = await groundedText(undefined)
    expect(baseline).not.toContain('<voice>')
    expect(await groundedText(resolveToneDirective('balanced'))).toBe(baseline)
    // A custom voice the user left blank must also collapse to nothing, not an empty tag pair.
    expect(await groundedText('   ')).toBe(baseline)
  })
})

describe('voice/tone preset — transport (the /agui body)', () => {
  const wire = { threadId: 't', runId: 'r', prompt: 'p' }

  it('a resolved directive lands on the POST body as `voice`', async () => {
    const { buildAguiBody } = await import('../duin-bridge')
    const body = buildAguiBody({ voice: 'Voice: concise and direct.' }, wire)
    expect(body.voice).toBe('Voice: concise and direct.')
  })

  it('no voice -> the field is omitted (old body shape preserved)', async () => {
    const { buildAguiBody } = await import('../duin-bridge')
    expect(buildAguiBody({}, wire)).not.toHaveProperty('voice')
    expect(buildAguiBody({ voice: '' }, wire)).not.toHaveProperty('voice')
  })
})

describe('voice/tone preset — the wiring in ipc/chat.ts (source parity)', () => {
  // ipc/chat.ts cannot be imported here (it registers IPC handlers against the electron main
  // process at module scope), so the brain branch is asserted at the source level — the same idiom
  // rag/multi-query-wiring.test.ts uses for the planner it was missing. Without this the two tests
  // above would both pass while the value still never left the handler, which is precisely the
  // failure that shipped.
  const chatSource = readFileSync(join(__dirname, '..', '..', 'ipc', 'chat.ts'), 'utf-8')

  it('resolves the persisted preset on the brain branch', () => {
    expect(chatSource).toMatch(/resolveToneDirective/)
    expect(chatSource).toMatch(/agentTone/)
    expect(chatSource).toMatch(/agentToneCustom/)
  })

  it('forwards it on the streamFromDuin call the default path actually takes', () => {
    const start = chatSource.indexOf('await streamFromDuin(')
    expect(start).toBeGreaterThan(-1)
    const end = chatSource.indexOf('signal: duinAbort.signal', start)
    expect(end).toBeGreaterThan(start)
    expect(chatSource.slice(start, end)).toMatch(/voice \? \{ voice \}/)
  })
})
