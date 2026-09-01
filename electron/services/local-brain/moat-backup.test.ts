import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { backupMoatState, listMoatBackups, restoreLatestMoat } from './moat-backup'

const LEDGER_REL = join('.duin', '_state', 'claim-ledger.jsonl')
const CONSTRUCTION_REL = join('.brain', 'state', 'brain-construction.json')
const BACKUP_DIR = join('.duin', '_backups')

let vault: string
let userData: string

/** Write a userData moat JSON store (operator-model / success-traces / ans-capabilities). */
function writeUserDataStore(name: string, entries: number): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, name),
    JSON.stringify({ facts: Array.from({ length: entries }, (_, i) => ({ id: i, fact: `f${i}` })) })
  )
}
/** Write a `.duin/_state` ledger source by label→filename. */
function writeStateFile(file: string, bytes: number): void {
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  writeFileSync(join(vault, '.duin', '_state', file), 'x'.repeat(bytes))
}
function backupsFor(label: string): string[] {
  const d = join(vault, BACKUP_DIR)
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith(label + '.')) : []
}

function writeLedger(rows: number): void {
  const p = join(vault, LEDGER_REL)
  mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  const line = JSON.stringify({ id: 'x', subject: 's', relation: 'r', object: 'o' })
  writeFileSync(p, Array.from({ length: rows }, (_, i) => line + `#${i}`).join('\n') + '\n')
}
function writeConstruction(entities: number): void {
  const p = join(vault, CONSTRUCTION_REL)
  mkdirSync(join(vault, '.brain', 'state'), { recursive: true })
  writeFileSync(p, JSON.stringify({ data: { entities: Array.from({ length: entities }, (_, i) => ({ id: i })) } }))
}
function ledgerBackups(): string[] {
  const d = join(vault, BACKUP_DIR)
  return existsSync(d) ? readdirSync(d).filter((n) => n.startsWith('ledger.')) : []
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'moat-backup-'))
  userData = mkdtempSync(join(tmpdir(), 'moat-userdata-'))
  delete process.env.DUIN_MOAT_BACKUPS
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
  delete process.env.DUIN_MOAT_BACKUPS
})

describe('backupMoatState', () => {
  it('snapshots ledger + construction on first run', () => {
    writeLedger(300)
    writeConstruction(150)
    backupMoatState(vault, 'test')
    const all = listMoatBackups(vault)
    expect(all.filter((b) => b.label === 'ledger')).toHaveLength(1)
    expect(all.filter((b) => b.label === 'construction')).toHaveLength(1)
  })

  it('dedups: an unchanged state creates no new backup', () => {
    writeLedger(300)
    backupMoatState(vault, 'a')
    backupMoatState(vault, 'b')
    backupMoatState(vault, 'c')
    expect(ledgerBackups()).toHaveLength(1)
  })

  it('creates a new backup when content changes', () => {
    writeLedger(300)
    backupMoatState(vault, 'a')
    writeLedger(320) // grew — legitimate change
    backupMoatState(vault, 'b')
    expect(ledgerBackups()).toHaveLength(2)
  })

  it('shrink-guard: a clobbered (<50%) ledger does NOT overwrite good backups', () => {
    writeLedger(300)
    backupMoatState(vault, 'healthy')
    expect(ledgerBackups()).toHaveLength(1)
    // simulate the 309->28 clobber: the live ledger is now tiny
    writeLedger(20)
    backupMoatState(vault, 'post-clobber')
    // no new backup — the healthy snapshot is preserved, the clobbered state is refused
    expect(ledgerBackups()).toHaveLength(1)
  })

  it('skips an empty (0-byte) source', () => {
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(join(vault, LEDGER_REL), '')
    backupMoatState(vault, 'test')
    expect(ledgerBackups()).toHaveLength(0)
  })

  it('rotates to the newest N per label', () => {
    process.env.DUIN_MOAT_BACKUPS = '3'
    for (let i = 1; i <= 6; i++) {
      writeLedger(300 + i * 10) // distinct, monotonically GROWING content (dodges dedup + shrink-guard)
      backupMoatState(vault, `r${i}`)
    }
    expect(ledgerBackups().length).toBe(3)
  })

  it('is a silent no-op for a missing/blank vault dir', () => {
    expect(() => backupMoatState('', 'x')).not.toThrow()
    expect(() => backupMoatState(null, 'x')).not.toThrow()
    expect(() => backupMoatState(join(vault, 'does-not-exist'), 'x')).not.toThrow()
  })
})

describe('backupMoatState — extended B1 sources', () => {
  it('snapshots the userData moat JSON stores when userDataDir is passed', () => {
    writeUserDataStore('operator-model.json', 40)
    writeUserDataStore('success-traces.json', 10)
    writeUserDataStore('ans-capabilities.json', 5)
    backupMoatState(vault, 'daily', userData)
    expect(backupsFor('operator-model')).toHaveLength(1)
    expect(backupsFor('success-traces')).toHaveLength(1)
    expect(backupsFor('ans-capabilities')).toHaveLength(1)
  })

  it('SKIPS userData sources when userDataDir is omitted (pre-reindex hook shape)', () => {
    writeUserDataStore('operator-model.json', 40)
    writeLedger(300)
    backupMoatState(vault, 'pre-reindex') // no userDataDir
    expect(backupsFor('operator-model')).toHaveLength(0) // userData source untouched
    expect(ledgerBackups()).toHaveLength(1) // vault source still covered
  })

  it('snapshots the new `.duin/_state` ledgers', () => {
    writeStateFile('risk-predictions.jsonl', 500)
    writeStateFile('forecast-track-record.json', 300)
    writeStateFile('corrections.jsonl', 400)
    writeStateFile('taste-engine.json', 200)
    backupMoatState(vault, 'daily', userData)
    expect(backupsFor('risk-predictions')).toHaveLength(1)
    expect(backupsFor('forecast-track-record')).toHaveLength(1)
    expect(backupsFor('corrections')).toHaveLength(1)
    expect(backupsFor('taste-engine')).toHaveLength(1)
  })

  it('hash-dedup: an unchanged userData store creates no second backup', () => {
    writeUserDataStore('operator-model.json', 40)
    backupMoatState(vault, 'a', userData)
    backupMoatState(vault, 'b', userData)
    backupMoatState(vault, 'c', userData)
    expect(backupsFor('operator-model')).toHaveLength(1)
  })

  it('shrink-guard: a clobbered (<50%) userData store does NOT rotate out the good backup', () => {
    writeUserDataStore('operator-model.json', 60) // healthy
    backupMoatState(vault, 'healthy', userData)
    expect(backupsFor('operator-model')).toHaveLength(1)
    const good = readFileSync(join(userData, 'operator-model.json'), 'utf-8')
    writeUserDataStore('operator-model.json', 3) // clobbered to <50%
    backupMoatState(vault, 'post-clobber', userData)
    expect(backupsFor('operator-model')).toHaveLength(1) // refused — healthy snapshot preserved
    // and the healthy backup still holds the pre-clobber content
    const dir = join(vault, BACKUP_DIR)
    const bak = readdirSync(dir).find((n) => n.startsWith('operator-model.'))!
    expect(readFileSync(join(dir, bak), 'utf-8')).toBe(good)
  })

  it('rotation caps a userData source to the newest N', () => {
    process.env.DUIN_MOAT_BACKUPS = '3'
    for (let i = 1; i <= 6; i++) {
      writeUserDataStore('operator-model.json', 40 + i * 10) // growing → dodges dedup + shrink-guard
      backupMoatState(vault, `r${i}`, userData)
    }
    expect(backupsFor('operator-model')).toHaveLength(3)
  })

  it('restores a userData store from its snapshot', () => {
    writeUserDataStore('operator-model.json', 50)
    backupMoatState(vault, 'healthy', userData)
    const good = readFileSync(join(userData, 'operator-model.json'), 'utf-8')
    writeFileSync(join(userData, 'operator-model.json'), '{"CLOBBERED":true}')
    const restored = restoreLatestMoat(vault, 'operator-model', userData)
    expect(restored).toContain('operator-model')
    expect(readFileSync(join(userData, 'operator-model.json'), 'utf-8')).toBe(good)
  })
})

describe('restoreLatestMoat', () => {
  it('restores the newest ledger backup over a clobbered live ledger', () => {
    writeLedger(300)
    backupMoatState(vault, 'healthy')
    const good = readFileSync(join(vault, LEDGER_REL), 'utf-8')
    // clobber the live ledger
    writeFileSync(join(vault, LEDGER_REL), 'CLOBBERED\n')
    const restored = restoreLatestMoat(vault, 'ledger')
    expect(restored).toContain('ledger')
    expect(readFileSync(join(vault, LEDGER_REL), 'utf-8')).toBe(good)
  })

  it('returns [] when there is nothing to restore', () => {
    expect(restoreLatestMoat(vault)).toEqual([])
    expect(restoreLatestMoat('')).toEqual([])
  })
})
