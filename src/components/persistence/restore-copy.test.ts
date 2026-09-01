import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  restoreConfirmMessage,
  restoreCompletionMessage,
  formatBackupTime,
  RESTORE_RELAUNCH_COPY
} from './restore-copy'

// U9 — restore swapped the whole user database on one unconfirmed click and
// then reported only "Restore <name> complete.". Two halves are tested:
//
//   1. the copy builders, as pure functions;
//   2. a source-lock (the ToolApprovalModal.wiring.test.ts pattern) proving
//      BOTH surfaces actually consult the confirm before calling
//      restoreFromBackup — the renderer env here is node-only (no jsdom), so
//      the components cannot be mounted and clicked.

const root = join(__dirname, '..', '..', '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf-8')

const BACKUP = { name: 'lamprey-2026-07-30.db', mtime: Date.UTC(2026, 6, 30, 4, 5, 6) }

describe('restoreConfirmMessage', () => {
  it("names the backup's file name and its timestamp", () => {
    const msg = restoreConfirmMessage(BACKUP)
    expect(msg).toContain('lamprey-2026-07-30.db')
    expect(msg).toContain(formatBackupTime(BACKUP.mtime))
  })

  it('says the current database is preserved, and that a relaunch is needed', () => {
    const msg = restoreConfirmMessage(BACKUP)
    expect(msg).toContain('pre-restore-')
    expect(msg).toContain(RESTORE_RELAUNCH_COPY)
  })

  it('degrades without throwing when the mtime is not a real number', () => {
    expect(restoreConfirmMessage({ name: 'x.db', mtime: NaN })).toContain('unknown time')
  })
})

describe('restoreCompletionMessage', () => {
  it('names the pre-restore path so the previous DB is findable', () => {
    const msg = restoreCompletionMessage({
      movedTo: 'C:\\Users\\x\\AppData\\Roaming\\DUIN\\lamprey.db.pre-restore-1754300000000',
      restoredFrom: 'C:\\backups\\lamprey-2026-07-30.db',
      restoredAt: 1754300000000
    })
    expect(msg).toContain('lamprey.db.pre-restore-1754300000000')
    expect(msg).toContain(RESTORE_RELAUNCH_COPY)
  })

  it('still instructs a relaunch when the envelope carried no path, and invents none', () => {
    for (const input of [null, undefined, { movedTo: '  ' } as never]) {
      const msg = restoreCompletionMessage(input)
      expect(msg).toContain(RESTORE_RELAUNCH_COPY)
      expect(msg).not.toContain('undefined')
      expect(msg).not.toContain('pre-restore-')
    }
  })
})

describe('both restore surfaces are gated by the same confirm (source-lock)', () => {
  const panel = read('src/components/settings/PersistenceSettings.tsx')
  const banner = read('src/components/persistence/IntegrityBanner.tsx')

  it('PersistenceSettings confirms before restoring, and bails when declined', () => {
    expect(panel).toMatch(/restoreConfirmMessage/)
    // The guard must be an early return, not a post-hoc notice.
    expect(panel).toMatch(/if\s*\(\s*!\s*window\.confirm\(\s*restoreConfirmMessage\([^)]*\)\s*\)\s*\)\s*return/)
  })

  it('PersistenceSettings surfaces the pre-restore path on success', () => {
    expect(panel).toMatch(/restoreCompletionMessage/)
    // ...and no longer leaves the generic "<label> complete." as the only word
    // the operator gets after a database swap.
    expect(panel).toMatch(/setInfo\(\s*restoreCompletionMessage/)
  })

  it('IntegrityBanner raises the identical confirm from the other surface', () => {
    expect(banner).toMatch(/restoreConfirmMessage/)
    expect(banner).toMatch(/if\s*\(\s*!\s*window\.confirm\(\s*restoreConfirmMessage\([^)]*\)\s*\)\s*\)\s*return/)
  })

  it('IntegrityBanner reports completion through the shared builder', () => {
    expect(banner).toMatch(/restoreCompletionMessage/)
  })

  it('neither surface hand-rolls its own relaunch sentence', () => {
    // Guards the "identical dialog" requirement: if a future edit re-types the
    // copy locally the two surfaces drift and this fails.
    const literal = "Please quit + relaunch DUIN"
    expect(panel.includes(literal)).toBe(false)
    expect(banner.includes(literal)).toBe(false)
  })
})
