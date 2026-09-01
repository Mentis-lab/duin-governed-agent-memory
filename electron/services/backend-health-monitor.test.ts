import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import BetterSqlite3, { type Database } from 'better-sqlite3'
import {
  detectBackendRegression,
  summarizeFailures,
  ageHours,
  snapshotFromDb,
  checkDbIntegrity,
  appendEntry,
  readLastEntry,
  historyPath,
  runBackendHealthMonitor,
  backendHealthMonitorEnabled,
  STALE_BACKUP_HOURS,
  FAILURE_COUNT_THRESHOLD,
  FAILURE_DELTA_THRESHOLD,
  EVENTS_DELTA_THRESHOLD,
  STUCK_RUN_AGE_HOURS,
  type BackendHealthEntry
} from './backend-health-monitor'

const HAS_NATIVE_SQLITE: boolean = (() => {
  try {
    const probe = new BetterSqlite3(':memory:')
    probe.close()
    return true
  } catch {
    return false
  }
})()

// ──────────────────── fixtures ────────────────────

function entry(over: Partial<BackendHealthEntry> = {}): BackendHealthEntry {
  return {
    ts: '2026-07-16T02:00:00.000Z',
    integrity: [{ db: 'lamprey', integrityOk: true, fkViolations: 0 }],
    backupAgeHours: 3,
    moatBackupAgeHours: 3,
    failures: { topKind: 'runtime_failed', topCount: 5, totalCount: 12 },
    stuckRuns: 0,
    orphanToolCalls: 0,
    eventsRowCount: 1000,
    ...over
  }
}

// ──────────────────── detectBackendRegression (PURE) ────────────────────

describe('detectBackendRegression', () => {
  it('flags nothing on a clean, stable backend', () => {
    expect(detectBackendRegression(entry(), entry())).toEqual([])
  })

  it('flags a failure-count spike over the absolute threshold (the QA-automation case)', () => {
    const curr = entry({ failures: { topKind: 'automation_failed', topCount: 1539, totalCount: 1539 } })
    const msgs = detectBackendRegression(null, curr)
    expect(msgs.some((m) => /FAILURES:.*automation_failed.*count=1539/.test(m))).toBe(true)
  })

  it('does NOT flag a failure count just under the threshold', () => {
    const curr = entry({ failures: { topKind: 'x', topCount: FAILURE_COUNT_THRESHOLD - 1, totalCount: 99 } })
    expect(detectBackendRegression(null, curr).some((m) => /FAILURES: fingerprint/.test(m))).toBe(false)
  })

  it('flags a sharp failure-total growth since the prior run (delta)', () => {
    const prev = entry({ failures: { topKind: 'x', topCount: 5, totalCount: 10 } })
    const curr = entry({ failures: { topKind: 'x', topCount: 9, totalCount: 10 + FAILURE_DELTA_THRESHOLD + 1 } })
    expect(detectBackendRegression(prev, curr).some((m) => /FAILURES: total grew/.test(m))).toBe(true)
  })

  it('flags a stale / missing backup', () => {
    const stale = detectBackendRegression(null, entry({ backupAgeHours: STALE_BACKUP_HOURS + 1 }))
    expect(stale.some((m) => /BACKUP:.*stale\/missing/.test(m))).toBe(true)
    const missing = detectBackendRegression(null, entry({ backupAgeHours: null }))
    expect(missing.some((m) => /BACKUP: no lamprey.*backup found/.test(m))).toBe(true)
  })

  it('does NOT flag a fresh backup', () => {
    expect(detectBackendRegression(null, entry({ backupAgeHours: STALE_BACKUP_HOURS - 1 })).some((m) => /BACKUP/.test(m))).toBe(false)
  })

  it('never WARNs on moat backup age (dedup makes age the wrong signal)', () => {
    // Moat snapshots are content-hash dedup'd, so an unchanged moat keeps an old mtime;
    // age measures content churn, not backup health, and must NOT produce a WARN.
    expect(detectBackendRegression(null, entry({ moatBackupAgeHours: STALE_BACKUP_HOURS + 5 })).some((m) => /moat/.test(m))).toBe(false)
    expect(detectBackendRegression(null, entry({ moatBackupAgeHours: null })).some((m) => /moat/.test(m))).toBe(false)
  })

  it('flags an integrity failure and a FK violation', () => {
    const bad = entry({ integrity: [{ db: 'lamprey', integrityOk: false, fkViolations: 2 }] })
    const msgs = detectBackendRegression(null, bad)
    expect(msgs.some((m) => /INTEGRITY: lamprey integrity_check is not/.test(m))).toBe(true)
    expect(msgs.some((m) => /INTEGRITY: lamprey has 2 foreign_key_check/.test(m))).toBe(true)
  })

  it('flags stuck runs and orphaned tool_calls', () => {
    const msgs = detectBackendRegression(null, entry({ stuckRuns: 3, orphanToolCalls: 4 }))
    expect(msgs.some((m) => /RUNS: 3 non-terminal/.test(m))).toBe(true)
    expect(msgs.some((m) => /ORPHANS: 4 tool_call/.test(m))).toBe(true)
  })

  it('flags an events row-count spike vs the prior run', () => {
    const prev = entry({ eventsRowCount: 1000 })
    const curr = entry({ eventsRowCount: 1000 + EVENTS_DELTA_THRESHOLD + 1 })
    expect(detectBackendRegression(prev, curr).some((m) => /EVENTS: row count grew/.test(m))).toBe(true)
  })

  it('with no prior entry, delta checks cannot fire', () => {
    const curr = entry({ failures: { topKind: 'x', topCount: 5, totalCount: 10_000 }, eventsRowCount: 10_000_000 })
    // absolute checks are clean here; only delta checks would fire, and they need prev
    expect(detectBackendRegression(null, curr)).toEqual([])
  })
})

// ──────────────────── summarizeFailures / ageHours (PURE) ────────────────────

describe('summarizeFailures', () => {
  it('finds the top fingerprint and sums totals', () => {
    expect(summarizeFailures([{ kind: 'a', count: 3 }, { kind: 'b', count: 20 }, { kind: 'c', count: 1 }])).toEqual({
      topKind: 'b',
      topCount: 20,
      totalCount: 24
    })
  })
  it('zeroes cleanly on an empty ledger', () => {
    expect(summarizeFailures([])).toEqual({ topKind: null, topCount: 0, totalCount: 0 })
  })

  // The alarm says "something is going wrong NOW", but a ledger count is ALL-TIME. Unwindowed,
  // a July incident stayed the top offender through late August and held the alarm on
  // permanently, hiding the failures that were actually still firing.
  const DAY = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-08-25T00:00:00.000Z')

  it('a huge but DEAD fingerprint cannot be the top offender', () => {
    const out = summarizeFailures(
      [
        { kind: 'automation_failed', count: 1532, lastSeenAt: now - 40 * DAY },
        { kind: 'runtime_failed', count: 738, lastSeenAt: now - 1000 }
      ],
      { now }
    )
    expect(out.topKind).toBe('runtime_failed')
    expect(out.topCount).toBe(738)
    // …but it still counts toward the total, because growth is a separate, real signal.
    expect(out.totalCount).toBe(2270)
  })

  it('a row with no timestamp stays eligible — an unknown age must not silence an alarm', () => {
    const out = summarizeFailures([{ kind: 'legacy', count: 900 }], { now })
    expect(out.topKind).toBe('legacy')
  })

  it('everything dead yields no top offender rather than a stale one', () => {
    const out = summarizeFailures(
      [{ kind: 'automation_failed', count: 1532, lastSeenAt: now - 40 * DAY }],
      { now }
    )
    expect(out.topKind).toBeNull()
    expect(out.topCount).toBe(0)
    expect(out.totalCount).toBe(1532)
  })
})

describe('ageHours', () => {
  const now = Date.parse('2026-07-16T12:00:00.000Z')
  it('computes hours from an mtime', () => {
    expect(ageHours(now - 2 * 3600_000, now)).toBeCloseTo(2)
  })
  it('null when there is no file', () => {
    expect(ageHours(null, now)).toBeNull()
    expect(ageHours(undefined, now)).toBeNull()
  })
})

// ──────────────────── snapshotFromDb (real in-memory better-sqlite3) ────────────────────

describe.runIf(HAS_NATIVE_SQLITE)('snapshotFromDb', () => {
  let db: Database
  const now = Date.parse('2026-07-16T12:00:00.000Z')
  const OLD = STUCK_RUN_AGE_HOURS // referenced so the import is used meaningfully

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    db.exec(`
      CREATE TABLE failure_ledger (id TEXT PRIMARY KEY, fingerprint TEXT, kind TEXT NOT NULL, count INTEGER NOT NULL, last_seen_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE loop_runs (id TEXT PRIMARY KEY, loop_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_type TEXT, label TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL);
      CREATE TABLE conversations (id TEXT PRIMARY KEY);
      CREATE TABLE tool_calls (id TEXT PRIMARY KEY, tool_id TEXT, name TEXT, conversation_id TEXT, args_json TEXT, status TEXT, started_at INTEGER);
      CREATE TABLE events (id TEXT PRIMARY KEY);
    `)
  })
  afterEach(() => {
    db.close()
  })

  it('summarizes failures, counts stuck runs, orphans and events', () => {
    const farPast = now - (OLD + 2) * 3600_000
    const recent = now - 60_000
    db.prepare('INSERT INTO failure_ledger VALUES (?,?,?,?,?)').run('1', 'fp1', 'automation_failed', 1539, recent)
    db.prepare('INSERT INTO failure_ledger VALUES (?,?,?,?,?)').run('2', 'fp2', 'runtime_failed', 4, recent)
    // stuck: running & far past. not-stuck: running but recent; and done & far past.
    db.prepare('INSERT INTO loop_runs VALUES (?,?,?,?)').run('l1', 'loopA', 'running', farPast)
    db.prepare('INSERT INTO loop_runs VALUES (?,?,?,?)').run('l2', 'loopA', 'running', recent)
    db.prepare('INSERT INTO loop_runs VALUES (?,?,?,?)').run('l3', 'loopA', 'done', farPast)
    db.prepare('INSERT INTO agent_runs VALUES (?,?,?,?,?)').run('a1', 't', 'lbl', 'running', farPast)
    // orphan tool_call: conversation_id with no matching conversations row
    db.prepare('INSERT INTO conversations VALUES (?)').run('conv-live')
    db.prepare('INSERT INTO tool_calls VALUES (?,?,?,?,?,?,?)').run('tc1', 'x', 'n', 'conv-dead', '{}', 'done', now)
    db.prepare('INSERT INTO tool_calls VALUES (?,?,?,?,?,?,?)').run('tc2', 'x', 'n', 'conv-live', '{}', 'done', now)
    db.prepare('INSERT INTO events VALUES (?)').run('e1')
    db.prepare('INSERT INTO events VALUES (?)').run('e2')

    const s = snapshotFromDb(db, now)
    expect(s.failures).toEqual({ topKind: 'automation_failed', topCount: 1539, totalCount: 1543 })
    expect(s.stuckRuns).toBe(2) // l1 + a1
    expect(s.orphanToolCalls).toBe(1) // tc1
    expect(s.eventsRowCount).toBe(2)
    expect(s.integrity[0]).toEqual({ db: 'lamprey', integrityOk: true, fkViolations: 0 })
  })

  it('missing tables yield zeros, not a throw', () => {
    const bare = new BetterSqlite3(':memory:')
    try {
      const s = snapshotFromDb(bare, now)
      expect(s.failures.totalCount).toBe(0)
      expect(s.stuckRuns).toBe(0)
      expect(s.orphanToolCalls).toBe(0)
      expect(s.eventsRowCount).toBe(0)
      expect(s.integrity[0].integrityOk).toBe(true) // an empty DB is 'ok'
    } finally {
      bare.close()
    }
  })

  it('checkDbIntegrity reports ok on a healthy in-memory DB', () => {
    expect(checkDbIntegrity(db, 'lamprey')).toEqual({ db: 'lamprey', integrityOk: true, fkViolations: 0 })
  })
})

// ──────────────────── ledger I/O ────────────────────

describe('ledger I/O', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'bhm2-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('historyPath lands under .duin/_state; null without a vault', () => {
    expect(historyPath(vault)).toBe(join(vault, '.duin', '_state', 'backend-health-history.jsonl'))
    expect(historyPath(null)).toBeNull()
    expect(historyPath('')).toBeNull()
  })

  it('appendEntry writes a well-formed JSONL line that readLastEntry round-trips', () => {
    const e = entry({ eventsRowCount: 42 })
    appendEntry(vault, e)
    expect(existsSync(historyPath(vault)!)).toBe(true)
    expect(readLastEntry(vault)).toEqual(e)
  })

  it('readLastEntry returns the MOST RECENT of several entries', () => {
    appendEntry(vault, entry({ eventsRowCount: 1 }))
    appendEntry(vault, entry({ eventsRowCount: 2 }))
    expect(readLastEntry(vault)?.eventsRowCount).toBe(2)
  })

  it('readLastEntry is null when no ledger exists', () => {
    expect(readLastEntry(vault)).toBeNull()
  })
})

// ──────────────────── the fire-and-forget wrapper ────────────────────

describe('runBackendHealthMonitor', () => {
  let vault: string
  const OLD = process.env.DUIN_BACKEND_HEALTH_MONITOR
  const deps = (): { userDataDir: string; vaultDir: string } => ({ userDataDir: vault, vaultDir: vault })

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'bhm2-'))
    delete process.env.DUIN_BACKEND_HEALTH_MONITOR // default-ON
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_BACKEND_HEALTH_MONITOR
    else process.env.DUIN_BACKEND_HEALTH_MONITOR = OLD
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  it('default-ON: appends a ledger line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runBackendHealthMonitor(deps(), () => entry({ eventsRowCount: 77 }))
    expect(readLastEntry(vault)?.eventsRowCount).toBe(77)
  })

  it('WARNs on an anomaly and still records the entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runBackendHealthMonitor(deps(), () =>
      entry({ failures: { topKind: 'automation_failed', topCount: 1539, totalCount: 1539 } })
    )
    expect(warn.mock.calls.flat().some((a) => String(a).includes('automation_failed'))).toBe(true)
    expect(readLastEntry(vault)?.failures.topCount).toBe(1539)
  })

  it('SWALLOWS a collector error (app-safe): a throwing collect never rejects, writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      runBackendHealthMonitor(deps(), () => {
        throw new Error('boom')
      })
    ).resolves.toBeUndefined()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('flag-OFF (DUIN_BACKEND_HEALTH_MONITOR=0) ⇒ no-op: no collect, no ledger write', async () => {
    process.env.DUIN_BACKEND_HEALTH_MONITOR = '0'
    expect(backendHealthMonitorEnabled()).toBe(false)
    const collect = vi.fn(() => entry())
    await runBackendHealthMonitor(deps(), collect)
    expect(collect).not.toHaveBeenCalled()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })
})
