// doctor-collect — the I/O half of `doctor`. Takes the readings; decides nothing.
//
// Split from doctor.ts on purpose: the decision layer stays pure and unit-testable, and
// everything that can hang, 404, or throw lives here behind per-reading try/catch. A
// reading that fails resolves to `null`, which the report renders as "could not answer"
// (exit 2) rather than as a pass — the whole point of the doctor.

import { buildInfo } from '../build-info'
import { detectBackendRegression, type BackendHealthEntry } from './backend-health-monitor'
import { parseHeadlessArgs } from './headless-runner'
import type { DoctorReadings } from './doctor'

import { LOCAL_BRAIN_ORIGIN as DEFAULT_BRAIN } from '../shared/brain-port'

export interface DoctorOptions {
  json: boolean
  /** Send one real, tiny model request. Costs money, so it is opt-in. */
  live: boolean
  brainUrl: string
}

/** `doctor [--json] [--live] [--brain <url>]`. Kept in the same style as parseHeadlessArgs
 *  so the two CLI verbs read alike. */
export function parseDoctorArgs(argv: string[]): DoctorOptions {
  const at = argv.indexOf('doctor')
  const args = at >= 0 ? argv.slice(at + 1) : []
  const opts: DoctorOptions = { json: false, live: false, brainUrl: process.env.DUIN_BRAIN_URL || DEFAULT_BRAIN }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') opts.json = true
    else if (arg === '--live') opts.live = true
    else if (arg === '--brain') opts.brainUrl = args[++i] ?? opts.brainUrl
    else if (arg.startsWith('--brain=')) opts.brainUrl = arg.slice('--brain='.length)
  }
  return opts
}

export function isDoctorArgv(argv: string[]): boolean {
  return argv.includes('doctor')
}

/** GET a brain route with a hard deadline. A hung engine must not hang the doctor —
 *  reporting "could not answer" quickly is more useful than blocking forever. */
async function getJson<T>(url: string, timeoutMs = 4000): Promise<T | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** What the RUNNING app says it is, from the /state/build route it already serves.
 *  This is the deploy-identity question in its useful form: the doctor compares the stamp
 *  compiled into ITSELF against the one the live process reports, so a deploy that shipped
 *  a stale asar (robocopy skipped the locked file and still exited 0 - a documented failure
 *  here) shows up as two different commits instead of as nothing at all. */
async function readRunningBuild(base: string): Promise<{ shortSha: string; builtAt: string } | null> {
  const info = await getJson<{ shortSha?: string; builtAt?: string }>(`${base}/state/build`)
  if (!info?.shortSha || info.shortSha === 'unknown') return null
  return { shortSha: info.shortSha, builtAt: info.builtAt ?? 'unknown' }
}

/** Turn a raw /debug/backend-health body into the verdict the report consumes, or null when
 *  it is not the shape this build understands. */
function backendHealthVerdict(
  entry: BackendHealthEntry | null
): { problems: string[]; integrityOk: boolean } | null {
  if (!entry || !Array.isArray(entry.integrity)) return null
  try {
    return {
      problems: detectBackendRegression(null, entry),
      integrityOk: entry.integrity.every((s) => s.integrityOk && s.fkViolations === 0)
    }
  } catch {
    return null
  }
}

export interface CollectDeps {
  /** Provider ids that have a key stored. */
  providersWithKeys: () => Promise<string[]> | string[]
  /** Send one tiny real request; only called with --live. */
  liveProbe: () => Promise<{ ok: boolean; provider?: string; error?: string }>
  /** Channels the operator enabled that report themselves unconfigured. */
  channelsWaiting: () => string[]
}

export async function collectDoctorReadings(
  opts: DoctorOptions,
  deps: CollectDeps
): Promise<DoctorReadings> {
  const base = opts.brainUrl.replace(/\/+$/, '')
  const [health, brainHealth, backendHealth, stalls, gaps, installedBuild] = await Promise.all([
    getJson<{ status?: string; indexed?: number }>(`${base}/health`),
    getJson<{ overall?: number }>(`${base}/debug/brain-health`),
    getJson<BackendHealthEntry>(`${base}/debug/backend-health`),
    getJson<{ recent?: { scope: string; ms: number }[] }>(`${base}/debug/stalls`),
    getJson<{ open?: number }>(`${base}/debug/gaps`),
    readRunningBuild(base)
  ])

  let providersWithKeys: string[] | undefined
  try {
    providersWithKeys = await deps.providersWithKeys()
  } catch {
    providersWithKeys = undefined // unreadable -> warn, not a false "no keys"
  }

  let liveProbe: DoctorReadings['liveProbe'] = null
  if (opts.live) {
    try {
      liveProbe = await deps.liveProbe()
    } catch (e) {
      liveProbe = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  let channelsWaiting: string[] | undefined
  try {
    channelsWaiting = deps.channelsWaiting()
  } catch {
    channelsWaiting = undefined
  }

  const self = buildInfo()
  return {
    build: {
      version: self.version,
      shortSha: self.shortSha,
      branch: self.branch,
      dirty: self.dirty,
      builtAt: self.builtAt
    },
    installedBuild,
    health,
    brainHealth,
    // The monitor owns the thresholds; the doctor only reports its verdict. `null` prev is
    // correct here: a CLI run has no previous sample, so only the ABSOLUTE checks (integrity,
    // stale backup, wedged runs) fire and the history-dependent deltas stay quiet.
    //
    // Shape-checked first: an older app (or a truncated response) can answer 200 with a
    // payload that is not an entry, and detectBackendRegression assumes its fields exist.
    // A doctor that CRASHES on a partial reading is worse than one that reports "could not
    // answer", which is the whole contract here.
    backendHealth: backendHealthVerdict(backendHealth),
    stalls,
    gaps,
    providersWithKeys,
    liveProbe,
    channelsWaiting
  }
}

// Re-exported so main.ts imports one module for the CLI verb.
export { parseHeadlessArgs }
