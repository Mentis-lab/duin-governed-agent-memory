import { describe, it, expect, vi, beforeEach } from 'vitest'

// Phase 1.1 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md, pinned.
//
// `syncOne` writes chunks via `syncSource`, which buys the STRUCTURAL half of
// comprehension (retrieval, causal graph) for free. The LLM half — entity/edge
// extraction, construction refresh, the channel→foresight bridge — lived only in
// `scheduleReindex`'s tail, so it fired on a chokidar vault-file event and nowhere
// else. A week of Slack/Gmail syncs into a quiet vault therefore produced no new
// comprehension, and a first-run user with one connected channel and zero notes
// had no file to edit and so never triggered any.
//
// That last case is the product strategy's own cold-start litmus test, which is
// why this is pinned rather than left to review.

const refreshComprehension = vi.hoisted(() => vi.fn(async () => {}))
const syncSource = vi.hoisted(() => vi.fn(async () => 0))

vi.mock('../local-brain/notes-watcher', () => ({ refreshComprehension }))
vi.mock('./source-adapters', () => ({
  syncSource,
  listAdapters: () => [{ id: 'slack', label: 'Slack', isConfigured: () => true }],
  getAdapter: (id: string) => (id === 'slack' ? { id: 'slack', label: 'Slack' } : null)
}))
vi.mock('../settings-helper', () => ({
  readSettings: () => ({ localBrainNotesDir: 'D:/vault' })
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp/duin-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('fs', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, existsSync: () => false, writeFileSync: () => {}, mkdirSync: () => {} }
})

import { syncOne } from './connections-store'

beforeEach(() => {
  refreshComprehension.mockClear()
  syncSource.mockReset()
})

describe('syncOne runs comprehension on what it just ingested', () => {
  it('refreshes comprehension when the sync brought something back', async () => {
    syncSource.mockResolvedValue(3)
    const r = await syncOne('slack')
    expect(r).toMatchObject({ ok: true, count: 3 })
    expect(refreshComprehension).toHaveBeenCalledTimes(1)
    // Passed the vault dir, not undefined — the refresh no-ops on a null dir, so a
    // wrong argument here would look like success and do nothing.
    expect(refreshComprehension).toHaveBeenCalledWith('D:/vault')
  })

  it('does not refresh on an empty poll', async () => {
    // The connector scheduler runs every 30 minutes; an empty poll has nothing new
    // to comprehend and re-running the LLM passes on it is pure cost.
    syncSource.mockResolvedValue(0)
    await syncOne('slack')
    expect(refreshComprehension).not.toHaveBeenCalled()
  })

  it('does not refresh when the sync failed', async () => {
    syncSource.mockRejectedValue(new Error('token expired'))
    const r = await syncOne('slack')
    expect(r.ok).toBe(false)
    expect(refreshComprehension).not.toHaveBeenCalled()
  })

  it('a comprehension failure does not fail the sync', async () => {
    // Best-effort by design: a broken extractor must not make a successful ingest
    // report as an error, or the operator retries a sync that actually worked.
    syncSource.mockResolvedValue(2)
    refreshComprehension.mockRejectedValueOnce(new Error('extractor down'))
    const r = await syncOne('slack')
    expect(r).toMatchObject({ ok: true, count: 2 })
  })
})
