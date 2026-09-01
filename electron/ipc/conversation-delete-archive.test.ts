// conversation:delete must not destroy a transcript without preserving it first.
//
// The defect (Pattern A — the guard exists in the SAME file, exactly one call site skipped it):
// `conversation:delete` was four lines — `store.deleteConversation(id)` and nothing else — while
// `archiveConversation()`, defined at the top of this same file, writes every message to
// `userData/compact-archive/<id>-<ts>.json`, and the sibling `conversation:compact` handler not only
// calls it but RETURNS AN ERROR rather than proceed when the archive write throws. Compact is
// strictly LESS destructive: it swaps the messages for a summary and keeps the conversation row.
// Delete runs one transaction that drops the conversation row, FK-cascades every message, and clears
// tool_calls / snip_command_log / snip_events / FTS / RAG attachments — with no disk artifact at all.
//
// The scenario: the user right-clicks a 200-message design thread in the Sidebar, accepts
// `confirm("Delete \"<title>\"?")` (which never said the transcript was unrecoverable), and the thread
// is gone. The only recovery is persistence:restoreFromBackup — a whole-DB snapshot up to 24h stale
// that rolls every OTHER conversation back too. There is no way to recover just the deleted thread.
//
// These tests drive the REAL registered ipcMain handler against a REAL temp userData directory: only
// electron is mocked (ipcMain to capture handlers, app.getPath for the archive dir) and the store is
// mocked so the handler sees a real conversation row + messages. The archive assertions read actual
// bytes off disk, so they cannot pass vacuously.
//
// POWER CONTROL: restoring the bare `store.deleteConversation(id); return { success: true, data: null }`
// makes 5 of the 6 tests below FAIL (no file is written, no metadata is captured, and the delete
// proceeds even when the archive cannot be written).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

const deleteConversation = vi.fn()
const getConversation = vi.fn()
const getMessages = vi.fn()

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
  deleteConversation,
  createConversation: vi.fn(),
  findMessage: vi.fn(),
  saveMessage: vi.fn(),
  updateConversationTitle: vi.fn(),
  updateConversationModel: vi.fn(),
  listConversations: vi.fn(() => []),
  listSessions: vi.fn(() => []),
  setConversationArchived: vi.fn(),
  setConversationPinned: vi.fn(),
  searchSessions: vi.fn(() => []),
  clearConversationMessages: vi.fn(),
  compactConversation: vi.fn(),
  listConversationLineage: vi.fn(() => [])
}))

vi.mock('../services/providers/registry', () => ({ chatOnce: vi.fn() }))
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
  id: 'design-thread',
  title: 'Sidebar redesign — the long one',
  model: 'claude-opus-4-8',
  kind: 'local',
  createdAt: 1_700_000_000_000
}

/** A transcript worth losing sleep over: hand-authored user turns plus assistant replies. */
const MESSAGES = Array.from({ length: 200 }, (_, i) => ({
  id: `m${i}`,
  conversationId: CONV.id,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Turn ${i}: a decision, a file path, and an unresolved question worth preserving.`,
  createdAt: 1_700_000_000_000 + i
}))

const archiveFiles = (): string[] => {
  try {
    return readdirSync(join(userDataDir, 'compact-archive'))
  } catch {
    return []
  }
}
const readArchive = (name: string): any =>
  JSON.parse(readFileSync(join(userDataDir, 'compact-archive', name), 'utf-8'))

beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'conv-delete-archive-'))
  handlers.clear()
  vi.clearAllMocks()
  getConversation.mockReturnValue(CONV)
  getMessages.mockReturnValue(MESSAGES)
  const mod = await import('./conversation')
  mod.registerConversationHandlers()
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('conversation:delete — archive before destroying', () => {
  it('THE BUG: writes the full transcript to disk before the delete runs', async () => {
    const res = await handlers.get('conversation:delete')!({}, CONV.id)

    expect(res.success).toBe(true)
    const files = archiveFiles()
    expect(files).toHaveLength(1) // was 0 before the fix: nothing was ever written
    const archived = readArchive(files[0])
    expect(archived.messages).toHaveLength(200)
    expect(archived.messages[0].content).toBe(MESSAGES[0].content)
    expect(archived.messages[199].content).toBe(MESSAGES[199].content)
    expect(deleteConversation).toHaveBeenCalledWith(CONV.id)
  })

  it('captures the conversation row too — delete destroys it, compact does not', async () => {
    await handlers.get('conversation:delete')!({}, CONV.id)

    const archived = readArchive(archiveFiles()[0])
    // Without title/model the messages alone cannot reconstruct the thread.
    expect(archived.conversation.title).toBe(CONV.title)
    expect(archived.conversation.model).toBe(CONV.model)
    expect(archived.conversationId).toBe(CONV.id)
    expect(archived.reason).toBe('conversation:delete')
    expect(archived.messageCount).toBe(200)
    expect(typeof archived.archivedAt).toBe('string')
  })

  it('archives BEFORE the store call, not after', async () => {
    // If the archive were written after the delete, this callback would see an empty directory.
    let filesAtDeleteTime: string[] = []
    deleteConversation.mockImplementation(() => {
      filesAtDeleteTime = archiveFiles()
    })

    await handlers.get('conversation:delete')!({}, CONV.id)

    expect(filesAtDeleteTime).toHaveLength(1)
  })

  it('ABANDONS the delete when the transcript cannot be archived', async () => {
    // Occupy the archive directory path with a FILE, so mkdirSync throws — same shape as a
    // read-only userData, a full disk, or a permissions fault in production.
    writeFileSync(join(userDataDir, 'compact-archive'), 'not a directory')

    const res = await handlers.get('conversation:delete')!({}, CONV.id)

    expect(res.success).toBe(false)
    expect(res.error).toContain('Could not archive the conversation before deleting it')
    // The whole point: a failed preserve must never become a delete.
    expect(deleteConversation).not.toHaveBeenCalled()
  })

  it('returns the archive path so the UI can say where the transcript went', async () => {
    const res = await handlers.get('conversation:delete')!({}, CONV.id)

    expect(res.data.archivePath).toBeTruthy()
    expect(res.data.archivePath).toContain('compact-archive')
    expect(res.data.archivePath).toContain(CONV.id)
  })

  it('still deletes a conversation that no longer exists, without an empty archive file', async () => {
    getConversation.mockReturnValue(null)
    getMessages.mockReturnValue([])

    const res = await handlers.get('conversation:delete')!({}, 'ghost')

    expect(res.success).toBe(true)
    expect(res.data.archivePath).toBeNull()
    expect(archiveFiles()).toHaveLength(0)
    expect(deleteConversation).toHaveBeenCalledWith('ghost')
  })
})
