// seam-ledger — what the seam has projected, kept IN THE VAULT so a vault switch starts empty.
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadSeamLedger, saveSeamLedger, seamLedgerPath, contentHash } from './seam-ledger'

let tmp: string
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

describe('seam-ledger', () => {
  it('lives under the vault state dir, round-trips, and tolerates a missing or corrupt file', () => {
    tmp = mkdtempSync(join(tmpdir(), 'seam-ledger-'))
    const memoryDir = join(tmp, '.brain', 'memory')
    expect(seamLedgerPath(memoryDir)).toBe(join(tmp, '.duin', '_state', 'seam-ledger.json'))
    expect(loadSeamLedger(memoryDir)).toEqual({ version: 1, facts: {} })

    const led = loadSeamLedger(memoryDir)
    led.facts.a = { slug: 'concept-a.md', hash: 'h', writtenAt: 1, status: 'promoted', claim: 'x', lineage: '' }
    saveSeamLedger(memoryDir, led)
    expect(existsSync(seamLedgerPath(memoryDir))).toBe(true)
    expect(loadSeamLedger(memoryDir).facts.a).toMatchObject({ slug: 'concept-a.md', status: 'promoted' })

    mkdirSync(join(tmp, '.duin', '_state'), { recursive: true })
    writeFileSync(seamLedgerPath(memoryDir), '{ not json', 'utf-8')
    expect(loadSeamLedger(memoryDir)).toEqual({ version: 1, facts: {} }) // corrupt → empty, never throws
    expect(() => saveSeamLedger('', led)).not.toThrow()
  })

  it('contentHash is stable and content-sensitive', () => {
    expect(contentHash('a')).toBe(contentHash('a'))
    expect(contentHash('a')).not.toBe(contentHash('b'))
    expect(contentHash('a')).toMatch(/^[0-9a-f]{12,}$/)
  })
})
