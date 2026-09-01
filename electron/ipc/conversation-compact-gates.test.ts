// conversation:compact must not let a refusal string authorize total deletion, and must not destroy a
// transcript it failed to preserve.
//
// THE GAP (Pattern B — a fix shipped three guards and the test suite only ever reached one of them):
// b7aa826 "fix(compact): make /compact atomic, archived, and gated on a real summary" landed three
// separate guards on the same destructive path:
//   1. delete+insert in ONE TRANSACTION      -> conversation-store.ts:compactConversation
//   2. a MIN_SUMMARY_CHARS gate              -> this handler, below the chatOnce call
//   3. ARCHIVE-BEFORE-COMPACT                -> this handler, above the store call
// Only guard 1 was covered (conversation-compact-node.test.ts, "THE BUG: a failing insert leaves the
// conversation INTACT, never empty"). Guards 2 and 3 live in the IPC handler, and NO test drove the
// `conversation:compact` channel at all — the channel name appeared in the codebase only in
// conversation.ts, preload.ts, and a comment. The sibling suite conversation-delete-archive.test.ts
// sits right next to it exercising `conversation:delete`, which reads like compact is covered too. It
// is not: deleting the MIN_SUMMARY_CHARS check, or the archiveConversation call, failed NOTHING.
//
// Why that matters on this path specifically: compact is user-invoked with NO confirmation step, and
// its authorization to replace an entire thread comes from model output nobody verified is faithful.
// Without guard 2, `chatOnce` returning "I can't summarize that." — a perfectly well-formed, non-blank
// string — replaces a 200-message thread with that sentence. Without guard 3, the originals are gone
// with no disk artifact. The two guards are each other's backstop, and both were revertible green.
//
// These tests drive the REAL registered ipcMain handler against a REAL temp userData directory. Only
// electron is mocked (ipcMain to capture handlers, app.getPath for the archive dir), the store is
// mocked so the handler sees a real conversation row + messages, and chatOnce is mocked so each test
// chooses exactly what the "summarizer" returns. Archive assertions read actual bytes off disk.
//
// NO SKIP GATE. This suite is deliberately free of better-sqlite3: the guards under test are handler
// logic, not SQL. It is not behind `describe.skipIf(!nativeOk())`, which in this repo reports PASS
// while executing nothing (the better-sqlite3 ABI does not load under the node-env vitest) — the exact
// trap that let b7aa826's first draft certify a removed transaction.
//
// POWER CONTROL (verified, see the commit message for counts):
//   - removing the `text.length < MIN_SUMMARY_CHARS` check fails the refusal/boundary cases;
//   - replacing the archive block so nothing is written fails the archive cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

const getConversation = vi.fn()
const getMessages = vi.fn()
const compactConversation = vi.fn()
const clearConversationMessages = vi.fn()
const saveMessage = vi.fn()
const chatOnce = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  },
  app: { getPath: () => userDataDir },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../services/conversation-store', () => ({
  getConversation,
  getMessages,
  compactConversation,
  clearConversationMessages,
  saveMessage,
  deleteConversation: vi.fn(),
  createConversation: vi.fn(),
  findMessage: vi.fn(),
  updateConversationTitle: vi.fn(),
  updateConversationModel: vi.fn(),
  listConversations: vi.fn(() => []),
  listSessions: vi.fn(() => []),
  setConversationArchived: vi.fn(),
  setConversationPinned: vi.fn(),
  searchSessions: vi.fn(() => []),
  listConversationLineage: vi.fn(() => [])
}))

vi.mock('../services/providers/registry', () => ({ chatOnce }))
vi.mock('../services/workspace-state', () => ({ getActiveWorkspace: vi.fn(() => null) }))
vi.mock('../services/conversation-rag', () => ({ ensureConversationCollection: vi.fn() }))
vi.mock('../services/rag/store', () => ({
  addAttachment: vi.fn(),
  copyAttachments: vi.fn(() => 0),
  insertDocument: vi.fn(),
  insertChunks: vi.fn(),
  updateDocument: vi.fn()
}))
vi.mock('../services/rag/chunker', () => ({ chunk: vi.fn(() => []) }))
vi.mock('../services/settings-helper', () => ({ readSettings: vi.fn(() => ({})) }))
vi.mock('../services/event-log', () => ({ recordEvent: vi.fn() }))

const CONV = {
  id: 'compact-me',
  title: 'Retrieval rewrite — the long one',
  model: 'claude-opus-4-8',
  kind: 'local',
  createdAt: 1_700_000_000_000
}

/** 40 turns of the kind of thread a user actually invokes /compact on. Must be >= 4: the handler
 *  refuses shorter conversations before it ever reaches the guards under test. */
const MESSAGES = Array.from({ length: 40 }, (_, i) => ({
  id: `m${i}`,
  conversationId: CONV.id,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Turn ${i}: a decision, a file path, and an unresolved question worth preserving.`,
  createdAt: 1_700_000_000_000 + i
}))

/** The constant the handler enforces. Pinned here on purpose: if someone loosens MIN_SUMMARY_CHARS,
 *  the boundary cases below should force them to look at this file and justify it. */
const MIN_SUMMARY_CHARS = 120

/** A summary that is genuinely substantive — what the guard is meant to let THROUGH. */
const REAL_SUMMARY =
  '## Retrieval rewrite\n\nDecided to move chunking into `electron/services/rag/chunker.ts` and keep ' +
  'the 512-token window. Open question: whether re-embedding on settings change should be lazy. ' +
  'Follow-up owed on the migration path for existing collections.'

/** A refusal: well-formed, non-blank, and under the fix it would have authorized destroying all 40
 *  messages. This is the string the old `!summary?.trim()` gate happily accepted. */
const REFUSAL = "I'm sorry, I can't summarize that."

const archiveFiles = (): string[] => {
  try {
    return readdirSync(join(userDataDir, 'compact-archive'))
  } catch {
    return []
  }
}
const readArchive = (name: string): any =>
  JSON.parse(readFileSync(join(userDataDir, 'compact-archive', name), 'utf-8'))

const invokeCompact = (id: string = CONV.id) => handlers.get('conversation:compact')!({}, id)

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'conv-compact-gates-'))
  handlers.clear()
  vi.clearAllMocks()
  getConversation.mockReturnValue(CONV)
  getMessages.mockReturnValue(MESSAGES)
  compactConversation.mockReturnValue(MESSAGES.length)
  chatOnce.mockResolvedValue({ content: REAL_SUMMARY })
  const mod = await import('./conversation')
  mod.registerConversationHandlers()
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('conversation:compact — the channel is actually registered', () => {
  it('registers a conversation:compact handler at all', () => {
    // The premise of every test below. Before this file, nothing in the suite asserted even this.
    expect(handlers.has('conversation:compact')).toBe(true)
  })
})

describe('conversation:compact — GUARD 2: MIN_SUMMARY_CHARS gates total deletion', () => {
  it('THE BUG: a model REFUSAL does not authorize replacing the whole thread', async () => {
    chatOnce.mockResolvedValue({ content: REFUSAL })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    // The whole point: the destructive call must never happen on this input.
    expect(compactConversation).not.toHaveBeenCalled()
    // And nothing was destroyed by an older code path either.
    expect(clearConversationMessages).not.toHaveBeenCalled()
  })

  it('reports what it refused — the length AND the number of messages it protected', async () => {
    chatOnce.mockResolvedValue({ content: REFUSAL })

    const res = await invokeCompact()

    // A bare "compact failed" toast is what made the original defect invisible to the user.
    expect(res.error).toContain(String(REFUSAL.length))
    expect(res.error).toContain(String(MESSAGES.length))
  })

  it('refuses a truncated token — a provider cutoff is not a summary', async () => {
    chatOnce.mockResolvedValue({ content: '## Retr' })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(compactConversation).not.toHaveBeenCalled()
  })

  it('refuses a provider error string returned as content', async () => {
    chatOnce.mockResolvedValue({ content: 'Error: upstream 502 (request id 7f3a)' })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(compactConversation).not.toHaveBeenCalled()
  })

  it('refuses blank output with a distinct error, and still destroys nothing', async () => {
    chatOnce.mockResolvedValue({ content: '   \n\t  ' })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(res.error).toContain('empty')
    expect(compactConversation).not.toHaveBeenCalled()
  })

  it('refuses padded output — the gate measures the TRIMMED summary', async () => {
    // 200 chars of whitespace around a refusal must not buy its way past a length check.
    chatOnce.mockResolvedValue({ content: `${' '.repeat(200)}${REFUSAL}${' '.repeat(200)}` })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(compactConversation).not.toHaveBeenCalled()
  })

  it('BOUNDARY: one character under the minimum is refused', async () => {
    chatOnce.mockResolvedValue({ content: 'x'.repeat(MIN_SUMMARY_CHARS - 1) })

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(compactConversation).not.toHaveBeenCalled()
  })

  // GUARD-STRENGTH NEGATIVE CONTROL. Without this, every assertion above could be satisfied by a
  // handler that refuses EVERYTHING — a gate stuck shut would look identical to a gate working.
  it('NEGATIVE CONTROL: exactly the minimum length is ACCEPTED and does compact', async () => {
    chatOnce.mockResolvedValue({ content: 'x'.repeat(MIN_SUMMARY_CHARS) })

    const res = await invokeCompact()

    expect(res.success).toBe(true)
    expect(compactConversation).toHaveBeenCalledTimes(1)
  })

  it('NEGATIVE CONTROL: a real summary compacts, and the summary survives into the marker', async () => {
    const res = await invokeCompact()

    expect(res.success).toBe(true)
    expect(res.data.summary).toBe(REAL_SUMMARY)
    expect(compactConversation).toHaveBeenCalledTimes(1)
    const [convId, marker] = compactConversation.mock.calls[0]
    expect(convId).toBe(CONV.id)
    // The replacement message must actually carry the summary, not just be well-formed.
    expect(marker.content).toContain(REAL_SUMMARY)
    expect(marker.id).toBeTruthy()
  })
})

describe('conversation:compact — GUARD 3: archive before anything is destroyed', () => {
  it('THE BUG: writes the full transcript to disk before compacting', async () => {
    const res = await invokeCompact()

    expect(res.success).toBe(true)
    const files = archiveFiles()
    expect(files).toHaveLength(1) // was 0 before the fix: nothing was ever written
    const archived = readArchive(files[0])
    expect(archived.messages).toHaveLength(MESSAGES.length)
    expect(archived.messages[0].content).toBe(MESSAGES[0].content)
    expect(archived.messages[MESSAGES.length - 1].content).toBe(MESSAGES[MESSAGES.length - 1].content)
    expect(archived.conversationId).toBe(CONV.id)
    expect(archived.reason).toBe('conversation:compact')
    expect(archived.messageCount).toBe(MESSAGES.length)
  })

  it('archives BEFORE the store call, not after', async () => {
    // If the archive were written after the compact, this callback would see an empty directory —
    // which is precisely the window in which a crash loses the transcript.
    let filesAtCompactTime: string[] = []
    compactConversation.mockImplementation(() => {
      filesAtCompactTime = archiveFiles()
      return MESSAGES.length
    })

    await invokeCompact()

    expect(filesAtCompactTime).toHaveLength(1)
  })

  it('ABANDONS the compact when the transcript cannot be archived', async () => {
    // Occupy the archive directory path with a FILE so mkdirSync throws — the same shape as a
    // read-only userData, a full disk, or a permissions fault in production.
    writeFileSync(join(userDataDir, 'compact-archive'), 'not a directory')

    const res = await invokeCompact()

    expect(res.success).toBe(false)
    expect(res.error).toContain('Could not archive the conversation before compacting')
    // A failed preserve must never become a destroy.
    expect(compactConversation).not.toHaveBeenCalled()
  })

  it('returns the archive path so the UI can say where the transcript went', async () => {
    const res = await invokeCompact()

    expect(res.data.archivePath).toBeTruthy()
    expect(res.data.archivePath).toContain('compact-archive')
    expect(res.data.archivePath).toContain(CONV.id)
  })

  it('names the archive path INSIDE the summary marker — the trace the reader will see', async () => {
    const res = await invokeCompact()

    const marker = compactConversation.mock.calls[0][1]
    // Recovery instructions the user never reads are not recovery instructions.
    expect(marker.content).toContain(res.data.archivePath)
    expect(marker.content).toContain(String(MESSAGES.length))
  })

  // GUARD-STRENGTH NEGATIVE CONTROL for guard 3: a successful archive must not itself block the
  // compact. Otherwise "compactConversation not called" would be trivially true in every test.
  it('NEGATIVE CONTROL: a successful archive does NOT block the compact', async () => {
    const res = await invokeCompact()

    expect(res.success).toBe(true)
    expect(archiveFiles()).toHaveLength(1)
    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(res.data.archived).toBe(MESSAGES.length)
  })

  it('does not archive when the summary was refused — no junk files from a rejected compact', async () => {
    chatOnce.mockResolvedValue({ content: REFUSAL })

    await invokeCompact()

    // Guard 2 runs BEFORE guard 3; a refused compact should leave no trace on disk.
    expect(archiveFiles()).toHaveLength(0)
  })
})
