// Backend Health MONITOR (backend-hardening B2) — the OPERATIONAL analog of the
// Brain Health monitor (brain/brain-health-monitor.ts). The brain monitor makes the
// 4-axis GRAPH benchmark self-policing on each construction rebuild; this module makes
// the whole persistence BACKEND self-policing on a CLOCK. Before it, the backend was
// internally sound but operationally BLIND: nothing watched DB integrity after boot,
// backup freshness, failure-count spikes, or leaked/stuck runs. A leftover automation
// failed 1,539 times over two weeks with the ONLY witness an unread failure_ledger row.
// This module runs a cheap composite check on an interval, records a compact history
// line, and WARNs on any anomaly or regression vs the prior run.
//
// Shape is copied deliberately from brain-health-monitor: a PURE core
// (detectBackendRegression / summarizeFailures — no I/O, no Electron, unit-tested
// against fixtures) + a thin FAILURE-ISOLATED I/O wrapper (runBackendHealthMonitor)
// whose ENTIRE body is try/caught so a monitor error can NEVER break or delay the app.
// The live DB read is behind an injection seam (collect) so this module stays
// import-clean + vitest-safe; tests pass a pure collector or a real in-memory
// better-sqlite3 handle and never touch Electron.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import type { Database } from 'better-sqlite3'
import { messageOf } from './guarded'
import { listBackups } from './backup-runner'
import { listMoatBackups } from './local-brain/moat-backup'

// ──────────────────── ledger schema ────────────────────

/** Per-DB integrity verdict (PRAGMA integrity_check + foreign_key_check). */
export interface IntegritySample {
  /** Which db this is ('lamprey' | 'local-brain'). */
  db: string
  /** True iff integrity_check returned exactly 'ok'. */
  integrityOk: boolean
  /** Rows returned by foreign_key_check (0 = clean). */
  fkViolations: number
}

/** Compact summary of the failure_ledger (the QA-automation blind spot). */
export interface FailureSummary {
  /** kind of the single worst fingerprint (by count), or null when empty. */
  topKind: string | null
  /** count of that worst fingerprint. */
  topCount: number
  /** Σ count across all fingerprints — the growth signal. */
  totalCount: number
}

/** One compact history line per monitor run. Mirrors the `.duin/_state/` jsonl-ledger
 *  convention (brain-health-history.jsonl etc.): flat + small so a long-lived install
 *  accumulates a cheap, greppable time-series. */
export interface BackendHealthEntry {
  /** ISO timestamp of the check. */
  ts: string
  /** Per-DB integrity verdicts (lamprey always; local-brain when reachable). */
  integrity: IntegritySample[]
  /** Age in hours of the newest lamprey-*.db backup; null when none exists. */
  backupAgeHours: number | null
  /** Age in hours of the newest moat backup; null when none / no vault. */
  moatBackupAgeHours: number | null
  /** failure_ledger summary. */
  failures: FailureSummary
  /** loop_runs + agent_runs in a non-terminal state with a far-past start. */
  stuckRuns: number
  /** tool_calls pointing at a conversation_id that no longer exists (dead parent). */
  orphanToolCalls: number
  /** events row count — the runaway-growth signature is a spike in the delta. */
  eventsRowCount: number
}

// ──────────────────── thresholds ────────────────────

/** Newest nightly backup older than this ⇒ WARN "stale/missing" (nightly cadence + slack). */
export const STALE_BACKUP_HOURS = 26
/** Any single failure_ledger fingerprint at/over this absolute count ⇒ WARN. Caught the
 *  1,539-failure QA automation; a healthy fingerprint sits in the low tens. */
export const FAILURE_COUNT_THRESHOLD = 100
/** failure_ledger total grew by more than this SINCE the prior monitor run ⇒ WARN. */
export const FAILURE_DELTA_THRESHOLD = 50
/** A non-terminal run whose start is older than this is treated as wedged/leaked. */
export const STUCK_RUN_AGE_HOURS = 6
/** events row-count growth beyond this vs the prior run ⇒ WARN (runaway writer). */
export const EVENTS_DELTA_THRESHOLD = 50_000

const HOUR_MS = 60 * 60 * 1000
/** How recently a fingerprint must have fired to be eligible as the 'runaway' top offender.
 *  7 days is wide enough to catch a slow-cadence failure (the construct-extraction ones fire
 *  every ~30min, quota outages ran for a fortnight) and narrow enough that an incident which
 *  genuinely stopped falls out of the alarm instead of holding it on forever. */
const ACTIVE_FAILURE_WINDOW_MS = 7 * 24 * HOUR_MS
const r1 = (x: number): number => Math.round(x * 10) / 10

// ──────────────────── PURE detect core ────────────────────

/**
 * PURE: evaluate the current snapshot against the PRIOR ledger entry and return a
 * (possibly empty) list of human-readable WARN messages. No I/O.
 *
 * History-INDEPENDENT anomalies (fire even when prev === null):
 *   - any integrity_check ≠ ok, or any foreign_key_check violation
 *   - newest backup missing, or older than STALE_BACKUP_HOURS
 *   - newest moat backup older than STALE_BACKUP_HOURS (only when one exists)
 *   - any failure_ledger fingerprint at/over FAILURE_COUNT_THRESHOLD
 *   - any stuck/leaked non-terminal run
 *   - any orphaned tool_call (dead conversation parent)
 * History-DEPENDENT regressions (need prev):
 *   - failure_ledger total grew by more than FAILURE_DELTA_THRESHOLD
 *   - events row count grew by more than EVENTS_DELTA_THRESHOLD
 */
export function detectBackendRegression(
  prev: BackendHealthEntry | null,
  curr: BackendHealthEntry
): string[] {
  const out: string[] = []

  // ── DB integrity (absolute — a corrupt DB is always a WARN). ──
  for (const s of curr.integrity) {
    if (!s.integrityOk) out.push(`INTEGRITY: ${s.db} integrity_check is not 'ok'`)
    if (s.fkViolations > 0) out.push(`INTEGRITY: ${s.db} has ${s.fkViolations} foreign_key_check violation(s)`)
  }

  // ── Backup freshness (absolute). ──
  if (curr.backupAgeHours === null) {
    out.push('BACKUP: no lamprey-*.db backup found (nightly backup missing)')
  } else if (curr.backupAgeHours > STALE_BACKUP_HOURS) {
    out.push(`BACKUP: newest lamprey backup ${r1(curr.backupAgeHours)}h old > ${STALE_BACKUP_HOURS}h (nightly backup stale/missing)`)
  }
  // NOTE: deliberately NO absolute moat-backup age WARN. Moat snapshots are content-hash
  // dedup'd (moat-backup.ts), so an unchanged moat keeps its old mtime — age measures
  // content churn, not backup health, and an idle-but-unchanged vault would false-alarm
  // every hour (the exact alert-fatigue this monitor exists to prevent). The daily backup
  // tick writes lamprey + moat together, so a genuinely stopped backup process is already
  // caught by the lamprey freshness WARN above. moatBackupAgeHours stays in the entry for
  // observability only.

  // ── failure_ledger spike (absolute threshold). This is the check that would have ──
  //    caught the QA automation: report the top offender's kind + count.
  if (curr.failures.topCount >= FAILURE_COUNT_THRESHOLD) {
    out.push(
      `FAILURES: fingerprint kind='${curr.failures.topKind ?? '?'}' count=${curr.failures.topCount} ` +
        `≥ ${FAILURE_COUNT_THRESHOLD} (runaway failure)`
    )
  }

  // ── Stuck / leaked runs (absolute). ──
  if (curr.stuckRuns > 0) {
    out.push(`RUNS: ${curr.stuckRuns} non-terminal run(s) older than ${STUCK_RUN_AGE_HOURS}h (wedged/leaked)`)
  }

  // ── Conversation-child orphans (absolute; post-B3 cascade should keep this ~0, so ──
  //    any positive count is a regression signal).
  if (curr.orphanToolCalls > 0) {
    out.push(`ORPHANS: ${curr.orphanToolCalls} tool_call(s) with a dead conversation parent`)
  }

  if (!prev) return out

  // ── failure_ledger sharp growth since the prior run. ──
  const failDelta = curr.failures.totalCount - prev.failures.totalCount
  if (failDelta > FAILURE_DELTA_THRESHOLD) {
    out.push(
      `FAILURES: total grew ${prev.failures.totalCount}→${curr.failures.totalCount} (+${failDelta}) since prior run ` +
        `(top kind='${curr.failures.topKind ?? '?'}' count=${curr.failures.topCount})`
    )
  }

  // ── events row-count spike (runaway writer signature). ──
  const evDelta = curr.eventsRowCount - prev.eventsRowCount
  if (evDelta > EVENTS_DELTA_THRESHOLD) {
    out.push(`EVENTS: row count grew ${prev.eventsRowCount}→${curr.eventsRowCount} (+${evDelta}) since prior run (runaway growth)`)
  }

  return out
}

/** PURE: fold failure_ledger rows into the compact summary. Rows come straight from
 *  `SELECT kind, count FROM failure_ledger`; empty ⇒ a clean, zeroed summary. */
export function summarizeFailures(
  rows: Array<{ kind: string; count: number; lastSeenAt?: number }>,
  opts?: { now?: number; activeWindowMs?: number }
): FailureSummary {
  // The 'runaway' alarm ranks by count, but a count is ALL-TIME while the alarm is meant to
  // say "something is going wrong NOW". Unwindowed, one incident that ran for two weeks in
  // July stayed the top offender through late August - permanently on, drowning the genuinely
  // live failures underneath it, which is the alert-fatigue this monitor exists to prevent.
  // Rows carrying a lastSeenAt outside the window still count toward totalCount (the growth
  // delta is a real signal) but cannot BE the top offender.
  const now = opts?.now ?? Date.now()
  const windowMs = opts?.activeWindowMs ?? ACTIVE_FAILURE_WINDOW_MS
  let topKind: string | null = null
  let topCount = 0
  let totalCount = 0
  for (const r of rows) {
    const c = Number(r.count) || 0
    totalCount += c
    // A row with no timestamp is treated as active: an unknown age must not silence an alarm.
    const active = typeof r.lastSeenAt !== 'number' || now - r.lastSeenAt <= windowMs
    if (active && c > topCount) {
      topCount = c
      topKind = r.kind
    }
  }
  return { topKind, topCount, totalCount }
}

/** PURE: age in hours from a file mtime (ms) to `now` (ms); null when there is no file. */
export function ageHours(mtimeMs: number | null | undefined, now: number): number | null {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return null
  return Math.max(0, (now - mtimeMs) / HOUR_MS)
}

// ──────────────────── DB snapshot (I/O over an open handle) ────────────────────

/** A guarded scalar query: returns 0 when the table is absent or the query throws, so a
 *  partial DB (or an early-boot handle) can never crash the monitor. */
function safeCount(db: Database, sql: string, params: unknown[] = []): number {
  try {
    const row = db.prepare(sql).get(...params) as { n?: number } | undefined
    return Number(row?.n ?? 0) || 0
  } catch (e) {
    console.debug('[backend-health] count query skipped:', messageOf(e))
    return 0
  }
}

/** Run quick_check + foreign_key_check on one open handle. Read-only pragmas.
 *
 *  quick_check, NOT integrity_check (changed 2026-08-21): the full pair was
 *  MEASURED at ~2.1s across the two live DBs (DUIN_PERF_LAUNCH_HANDOFF.md:37) and
 *  this runs hourly on the main thread. quick_check skips only the index-content
 *  verification; page-level corruption — the failure this monitor exists to catch
 *  within the hour — still trips it. The startup one-shot full integrity_check
 *  (database.ts scheduleStartupIntegrityCheck) keeps deep coverage once per boot. */
export function checkDbIntegrity(db: Database, label: string): IntegritySample {
  try {
    const rows = db.pragma('quick_check') as Array<{ quick_check: string }>
    const lines = rows.map((r) => r?.quick_check ?? '').filter((s) => s.length > 0)
    const integrityOk = lines.length === 1 && lines[0] === 'ok'
    let fkViolations = 0
    try {
      fkViolations = (db.pragma('foreign_key_check') as unknown[]).length
    } catch (e) {
      console.debug('[backend-health] foreign_key_check skipped:', messageOf(e))
    }
    return { db: label, integrityOk, fkViolations }
  } catch (e) {
    // A pragma that throws is itself a strong integrity signal — report not-ok.
    console.debug('[backend-health] integrity_check threw:', messageOf(e))
    return { db: label, integrityOk: false, fkViolations: 0 }
  }
}

/**
 * Build the DB-derived parts of a snapshot from an OPEN better-sqlite3 handle. Pure w.r.t.
 * Electron (tests pass an in-memory handle). `now` drives the stuck-run cutoff. Every read
 * is guarded so a missing table yields a zero, not a throw.
 */
export function snapshotFromDb(
  db: Database,
  now: number,
  opts?: { label?: string; extraIntegrity?: IntegritySample[] }
): Omit<BackendHealthEntry, 'ts' | 'backupAgeHours' | 'moatBackupAgeHours'> {
  const cutoff = now - STUCK_RUN_AGE_HOURS * HOUR_MS

  let failures: FailureSummary = { topKind: null, topCount: 0, totalCount: 0 }
  try {
    const rows = db
      .prepare('SELECT kind, count, last_seen_at AS lastSeenAt FROM failure_ledger')
      .all() as Array<{ kind: string; count: number; lastSeenAt: number }>
    failures = summarizeFailures(rows, { now })
  } catch (e) {
    console.debug('[backend-health] failure_ledger read skipped:', messageOf(e))
  }

  // loop_runs (terminal: done/error/timeout) + agent_runs (terminal: done/error/aborted).
  // Anything else — running / pending — with a far-past start is wedged.
  const stuckLoop = safeCount(
    db,
    `SELECT COUNT(*) AS n FROM loop_runs WHERE status NOT IN ('done','error','timeout') AND started_at < ?`,
    [cutoff]
  )
  const stuckAgent = safeCount(
    db,
    `SELECT COUNT(*) AS n FROM agent_runs WHERE status NOT IN ('done','error','aborted') AND started_at < ?`,
    [cutoff]
  )

  const orphanToolCalls = safeCount(
    db,
    `SELECT COUNT(*) AS n FROM tool_calls tc
       WHERE tc.conversation_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = tc.conversation_id)`
  )

  const eventsRowCount = safeCount(db, 'SELECT COUNT(*) AS n FROM events')

  const integrity = [checkDbIntegrity(db, opts?.label ?? 'lamprey'), ...(opts?.extraIntegrity ?? [])]

  return { integrity, failures, stuckRuns: stuckLoop + stuckAgent, orphanToolCalls, eventsRowCount }
}

// ──────────────────── full collector (real backend readers, injectable) ────────────────────

/** Injected readers so the whole collector is testable without Electron. */
export interface CollectDeps {
  /** userData dir — holds lamprey.db, local-brain.db, and backups/. */
  userDataDir: string
  /** Vault dir (localBrainNotesDir) — holds the moat backups + the history ledger. */
  vaultDir: string | null
  /** Live lamprey handle. Default: the app's shared getDb(). */
  getDb?: () => Database
  /** Clock. Default Date.now. */
  now?: () => number
}

/** Default collector: read the live backend and produce a full snapshot entry. Lazily
 *  imports getDb so this module never pulls Electron at import time (vitest-safe). */
export async function collectBackendSnapshot(deps: CollectDeps): Promise<BackendHealthEntry> {
  const now = (deps.now ?? Date.now)()
  const getDbFn = deps.getDb ?? (async () => (await import('./database')).getDb())
  const db = await getDbFn()

  // Optionally include local-brain.db integrity when the file is reachable. Opened on a
  // FRESH read-only handle so we never disturb the live vector index; best-effort.
  const extraIntegrity: IntegritySample[] = []
  try {
    const lbPath = join(deps.userDataDir, 'local-brain.db')
    if (existsSync(lbPath)) {
      const { default: BetterSqlite3 } = await import('better-sqlite3')
      const lb = new BetterSqlite3(lbPath, { readonly: true, fileMustExist: true })
      try {
        extraIntegrity.push(checkDbIntegrity(lb as unknown as Database, 'local-brain'))
      } finally {
        try {
          lb.close()
        } catch (e) {
          console.debug('[backend-health] local-brain handle already closed:', messageOf(e))
        }
      }
    }
  } catch (e) {
    console.debug('[backend-health] local-brain integrity skipped:', messageOf(e))
  }

  const dbParts = snapshotFromDb(db, now, { label: 'lamprey', extraIntegrity })

  // Backup freshness — newest lamprey-*.db mtime under userData/backups.
  let backupAgeHours: number | null = null
  try {
    const backups = listBackups(join(deps.userDataDir, 'backups'))
    backupAgeHours = ageHours(backups[0]?.mtime ?? null, now)
  } catch (e) {
    console.debug('[backend-health] listBackups skipped:', messageOf(e))
  }

  // Moat backups (travel with the vault). Cheap dir listing; best-effort.
  let moatBackupAgeHours: number | null = null
  try {
    const moat = listMoatBackups(deps.vaultDir)
    moatBackupAgeHours = ageHours(moat[0]?.mtimeMs ?? null, now)
  } catch (e) {
    console.debug('[backend-health] listMoatBackups skipped:', messageOf(e))
  }

  return { ts: new Date(now).toISOString(), backupAgeHours, moatBackupAgeHours, ...dbParts }
}

// ──────────────────── ledger I/O (best-effort, isolated) ────────────────────

/** History ledger path — same `.duin/_state/` dir brain-health-history.jsonl uses. Null
 *  when there is no vault (nothing to persist against). */
export function historyPath(vault: string | null | undefined): string | null {
  const dir = typeof vault === 'string' ? vault.trim() : ''
  if (!dir) return null
  return join(dir, '.duin', '_state', 'backend-health-history.jsonl')
}

/** Retain the most recent entries so a long-lived install can't grow the ledger unbounded. */
const MAX_HISTORY_ENTRIES = 5000

function readRawLines(vault: string | null | undefined): string[] {
  const p = historyPath(vault)
  if (!p || !existsSync(p)) return []
  try {
    return readFileSync(p, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[backend-health] history unreadable:', messageOf(e))
    return []
  }
}

/** The PRIOR (most-recent) ledger entry, or null when none / unparseable. */
export function readLastEntry(vault: string | null | undefined): BackendHealthEntry | null {
  const lines = readRawLines(vault)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]) as BackendHealthEntry
    } catch (e) {
      console.debug('[backend-health] skip a corrupt history line:', messageOf(e))
    }
  }
  return null
}

/** Append one entry (atomic whole-file rewrite, capped). No-op when no vault. */
export function appendEntry(vault: string | null | undefined, entry: BackendHealthEntry): void {
  const p = historyPath(vault)
  if (!p) return
  const lines = readRawLines(vault)
  lines.push(JSON.stringify(entry))
  const capped = lines.length > MAX_HISTORY_ENTRIES ? lines.slice(-MAX_HISTORY_ENTRIES) : lines
  mkdirSync(dirname(p), { recursive: true })
  const body = capped.join('\n') + '\n'
  const tmp = p + '.tmp'
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, p)
}

// ──────────────────── flag gate + the fire-and-forget wrapper ────────────────────

/** Default-ON; opt-OUT via DUIN_BACKEND_HEALTH_MONITOR=0 (matches the `!== '0'` polarity
 *  of DUIN_BRAIN_HEALTH_MONITOR / DUIN_LOCAL_BRAIN_BACKUP). */
export function backendHealthMonitorEnabled(): boolean {
  return process.env.DUIN_BACKEND_HEALTH_MONITOR !== '0'
}

/** Injection seam: the live collector needs the Electron better-sqlite3 ABI, so the
 *  default reads the real backend; tests pass a pure collector. */
export type Collect = (deps: CollectDeps) => BackendHealthEntry | Promise<BackendHealthEntry>

/**
 * Run the backend health check: collect a live snapshot, WARN on any anomaly/regression vs
 * the prior run, append a history line, and cache the result for the debug route.
 *
 * FAILURE-ISOLATED + NON-BLOCKING: the entire body is wrapped in try/catch, so a monitor
 * error (or a throwing collector) is swallowed and can NEVER break or delay the app. Call
 * it fire-and-forget (`void runBackendHealthMonitor(deps)`). Flag-gated:
 * DUIN_BACKEND_HEALTH_MONITOR=0 ⇒ immediate no-op (no collect, no ledger write).
 */
export async function runBackendHealthMonitor(deps: CollectDeps, collect?: Collect): Promise<void> {
  try {
    if (!backendHealthMonitorEnabled()) return
    const fn: Collect = collect ?? collectBackendSnapshot
    const curr = await fn(deps)
    const prev = readLastEntry(deps.vaultDir)

    const regressions = detectBackendRegression(prev, curr)
    if (regressions.length > 0) {
      console.warn(`[backend-health] ${regressions.length} anomaly/anomalies on check (${curr.ts}):`)
      for (const msg of regressions) console.warn(`[backend-health]   - ${msg}`)
      // ALERT SURFACE (MVP): the tagged console.warn above + the history ledger + the
      // optional GET /debug/backend-health route are the signal. A richer in-app toast is
      // a deliberate follow-on (would need renderer wiring outside this phase's ownership).
    } else {
      console.log(
        `[backend-health] OK — failures Σ${curr.failures.totalCount} (top ${curr.failures.topCount}), ` +
          `stuck ${curr.stuckRuns}, orphans ${curr.orphanToolCalls}, backup ` +
          `${curr.backupAgeHours === null ? 'none' : r1(curr.backupAgeHours) + 'h'}`
      )
    }

    appendEntry(deps.vaultDir, curr)
  } catch (e) {
    // Swallow — the monitor is advisory only; the app must be unaffected.
    console.warn('[backend-health] monitor error (app unaffected):', messageOf(e))
  }
}
