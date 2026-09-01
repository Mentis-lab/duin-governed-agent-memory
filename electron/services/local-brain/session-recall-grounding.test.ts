import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Behavioral guard for DUIN_SESSION_RECALL (Phase 1A cross-session recall). Runs the REAL
// buildGroundedMessages with a mocked session store and asserts: flag-off ⇒ no block (byte-
// identical); flag-on ⇒ a labelled "FROM YOUR PAST CHATS" block carrying relevant hits, with the
// current thread excluded, duplicates of live history dropped, and tool/JSON-noise snippets filtered.

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-session-recall-test',
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
vi.mock('../memory-store', () => ({ buildMemoryIndexBlock: () => 'MEMORY-INDEX-BODY' }))

const searchSessions = vi.fn()
vi.mock('../conversation-store', () => ({ searchSessions: (...a: unknown[]) => searchSessions(...a) }))

const QUERY = 'when is BilibiliWorld?'
const HISTORY = [
  { role: 'user' as const, content: 'what is lamprey?' },
  { role: 'assistant' as const, content: 'A fish.' },
  { role: 'user' as const, content: QUERY }
]
const CONTEXT_OVERRIDE = 'bw.md — BilibiliWorld is in July.'

const hit = (conversationId: string, snippet: string, rank = -5) => ({
  conversationId,
  source: 'message' as const,
  messageId: 'm-' + conversationId,
  snippet,
  rank
})

async function build(threadId = 'thread-current') {
  const { buildGroundedMessages } = await import('./agui-grounding')
  const msgs = await buildGroundedMessages(HISTORY, QUERY, [], CONTEXT_OVERRIDE, null, threadId)
  return msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')
}

describe('DUIN_SESSION_RECALL — cross-session grounding injection', () => {
  const prior = process.env.DUIN_SESSION_RECALL
  beforeEach(() => {
    searchSessions.mockReset()
    delete process.env.DUIN_SESSION_RECALL
  })
  afterEach(() => {
    if (prior === undefined) delete process.env.DUIN_SESSION_RECALL
    else process.env.DUIN_SESSION_RECALL = prior
  })

  it('flag OFF ⇒ no sessions block and the store is never queried', async () => {
    const out = await build()
    expect(out).not.toContain('FROM YOUR PAST CHATS')
    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('flag ON ⇒ injects a labelled block with a relevant past-session excerpt', async () => {
    process.env.DUIN_SESSION_RECALL = '1'
    searchSessions.mockReturnValue([hit('sess-42', 'we decided the BW booth is 8 people')])
    const out = await build()
    expect(out).toContain('FROM YOUR PAST CHATS')
    expect(out).toContain('the BW booth is 8 people')
  })

  it('sanitizes the raw NL question into a lenient FTS query (no syntax error, no implicit AND)', async () => {
    process.env.DUIN_SESSION_RECALL = '1'
    searchSessions.mockReturnValue([hit('sess-7', 'the BW contingency booth codeword is HALCYON-42')])
    // QUERY is 'when is BilibiliWorld?' — a raw '?' would make FTS5 throw and recall would go empty.
    const out = await build()
    expect(out).toContain('HALCYON-42') // recall still fires despite the punctuation
    const ftsArg = String(searchSessions.mock.calls[0]?.[0] ?? '')
    expect(ftsArg).not.toContain('?') // sanitized: no raw punctuation reaches FTS5 MATCH
    expect(ftsArg).toContain('"') // tokens are quoted literals OR-ed together
    expect(ftsArg.toLowerCase()).not.toContain('"is"') // stopwords dropped
  })

  it('excludes the current thread, dedups live history, and filters tool/JSON noise', async () => {
    process.env.DUIN_SESSION_RECALL = '1'
    searchSessions.mockReturnValue([
      hit('thread-current', 'this belongs to the active thread'), // excluded: same thread
      hit('sess-1', 'A fish.'), // excluded: duplicate of a live history turn
      hit('sess-2', '{"tool":"search_notes","args":{"query":"x"},"result":[{"id":1}]}'), // excluded: tool noise
      hit('sess-3', 'the Merlin playtest feedback was mostly about pacing') // kept
    ])
    const out = await build('thread-current')
    expect(out).toContain('the Merlin playtest feedback was mostly about pacing')
    expect(out).not.toContain('this belongs to the active thread')
    expect(out).not.toContain('"tool":"search_notes"')
  })
})
