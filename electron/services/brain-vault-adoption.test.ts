import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  buildBrain: vi.fn(async () => ({ status: 'no-model' })),
  refreshNotesExtraction: vi.fn(async () => false),
  exportTables: vi.fn(() => 0),
  reloadTables: vi.fn(),
  recordEvent: vi.fn(),
  clearDenylist: vi.fn(),
  clearGraph: vi.fn(),
  reindex: vi.fn(async () => 0),
  reindexReady: vi.fn(),
  restartWatcher: vi.fn(),
  switchMoat: vi.fn(),
  recordSwitch: vi.fn(),
  readSettingsFile: vi.fn(() => ({ data: { localBrainNotesDir: 'vault-a' } })),
  writeSettingsFile: vi.fn(),
  send: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'user-data' },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
  }
}))

vi.mock('./brain', () => ({
  buildBrain: mocks.buildBrain,
  refreshNotesExtraction: mocks.refreshNotesExtraction
}))

vi.mock('./brain/brain-db-durability', () => ({
  exportBrainTablesToVault: mocks.exportTables,
  reloadBrainTablesFromVault: mocks.reloadTables
}))

vi.mock('./event-log', () => ({ recordEvent: mocks.recordEvent }))
vi.mock('./governance/confidential-firewall', () => ({ setActiveDenylist: mocks.clearDenylist }))
vi.mock('./local-brain/brain-graph-cache', () => ({ invalidateBrainGraphCache: mocks.clearGraph }))
vi.mock('./local-brain/index-store', () => ({
  reindex: mocks.reindex,
  reindexUntilReady: mocks.reindexReady
}))
vi.mock('./local-brain/notes-watcher', () => ({ restartNotesWatcher: mocks.restartWatcher }))
vi.mock('./moat-durability', () => ({
  recordSwitchOutcome: mocks.recordSwitch,
  switchMoatVault: mocks.switchMoat
}))
vi.mock('./settings-file', () => ({
  readSettingsFile: mocks.readSettingsFile,
  writeSettingsFile: mocks.writeSettingsFile
}))

import { commitReadyBrainVault } from './brain-vault-adoption'

const moatSuccess = (from: string | null, to: string) => ({
  ok: true as const,
  outcome: 'switched' as const,
  from,
  to,
  flushTarget: from || to,
  moatVerified: 0,
  memoryVerified: 0,
  trashVerified: 0
})

const tablesSuccess = {
  ok: true as const,
  outcome: 'reloaded' as const,
  imported: 0,
  priorRows: 0
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.reindexReady.mockResolvedValue(7)
  mocks.switchMoat.mockImplementation((_userData: string, from: string | null, to: string) =>
    moatSuccess(from, to)
  )
  mocks.reloadTables.mockReturnValue(tablesSuccess)
  mocks.readSettingsFile.mockReturnValue({ data: { localBrainNotesDir: 'vault-a' } })
})

describe('commitReadyBrainVault', () => {
  it('publishes only after the target index and both durability planes confirm success', async () => {
    const result = await commitReadyBrainVault(
      { localBrainNotesDir: 'vault-b' },
      { localBrainNotesDir: 'vault-a' },
      true
    )

    expect(result).toEqual({
      success: true,
      data: { indexedCount: 7, indexStatus: 'ready' }
    })
    expect(mocks.reindexReady).toHaveBeenCalledTimes(1)
    expect(mocks.reindexReady).toHaveBeenCalledWith('vault-b')
    expect(mocks.switchMoat).toHaveBeenCalledWith('user-data', 'vault-a', 'vault-b')
    expect(mocks.reloadTables).toHaveBeenCalledWith(
      'vault-b',
      expect.objectContaining({ userDataDir: 'user-data', flushedTo: 'vault-a', from: 'vault-a' })
    )
    // Production builds the path with join(), so the separator is the platform's.
    expect(mocks.writeSettingsFile).toHaveBeenCalledWith(
      join('user-data', 'settings.json'),
      { localBrainNotesDir: 'vault-b' }
    )
    expect(mocks.send).toHaveBeenCalledWith('brain:updated', { count: 7 })
    expect(mocks.writeSettingsFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0]
    )
  })

  it('restores the prior index and never publishes when moat durability is retained', async () => {
    mocks.switchMoat.mockReturnValueOnce({
      ok: false,
      outcome: 'retained',
      from: 'vault-a',
      to: 'vault-b',
      flushTarget: 'vault-a',
      reason: 'old vault is read-only',
      moatPending: ['operator-model.json'],
      memoryPending: []
    })

    await expect(
      commitReadyBrainVault(
        { localBrainNotesDir: 'vault-b' },
        { localBrainNotesDir: 'vault-a' },
        true
      )
    ).rejects.toThrow('Vault durability moat failed: old vault is read-only')

    expect(mocks.reindexReady.mock.calls.map(([dir]) => dir)).toEqual(['vault-b', 'vault-a'])
    expect(mocks.reloadTables).not.toHaveBeenCalled()
    expect(mocks.writeSettingsFile).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.restartWatcher).toHaveBeenCalledTimes(1)
    expect(mocks.restartWatcher).toHaveBeenCalledWith('vault-a')
  })

  it('reverses durability and the index when settings publication fails', async () => {
    mocks.writeSettingsFile.mockImplementationOnce(() => {
      throw new Error('settings disk full')
    })

    await expect(
      commitReadyBrainVault(
        { localBrainNotesDir: 'vault-b' },
        { localBrainNotesDir: 'vault-a' },
        true
      )
    ).rejects.toThrow('settings disk full')

    expect(mocks.switchMoat.mock.calls.map(([, from, to]) => [from, to])).toEqual([
      ['vault-a', 'vault-b'],
      ['vault-b', 'vault-a']
    ])
    expect(mocks.reloadTables.mock.calls.map(([to]) => to)).toEqual(['vault-b', 'vault-a'])
    expect(mocks.reindexReady.mock.calls.map(([dir]) => dir)).toEqual(['vault-b', 'vault-a'])
    expect(mocks.restartWatcher.mock.calls.map(([dir]) => dir)).toEqual(['vault-b', 'vault-a'])
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
