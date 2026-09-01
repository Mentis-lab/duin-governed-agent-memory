// doctor — one answer to "is this install actually working?", assembled from the
// instruments that already exist and were only reachable one debug URL at a time.
//
// WHY THIS EXISTS. Every check below was already implemented and already running: the
// brain-health monitor, the stall monitor, the backend-health probe, the capability-gap
// detector, the provider key store, build provenance. What did not exist was a place that
// reads them TOGETHER and says pass/warn/fail — so the two most expensive outages in this
// repo's history were both invisible for weeks while every individual surface looked fine:
// a 402 that killed every model call for ~2 weeks behind a green "Connected" badge, and a
// packaged install shipping a stale asar that nothing compared against its source.
//
// THE CONTRACT (deliberately the same shape a CI step wants):
//   exit 0 — every check passed.
//   exit 1 — at least one check FAILED. Something is broken; act on it.
//   exit 2 — nothing failed, but a check WARNED or could not answer. A script must treat
//            2 as neither pass nor fail, because "I could not measure this" is not "fine".
//
// PURITY. This module computes a report from injected readings — it opens no sockets and
// imports no electron — so the decision layer is unit-testable without a running app. The
// I/O half (fetching the routes, reading the keychain) lives in the caller.

export type DoctorStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  id: string
  /** One line, written for the person reading a terminal at 2am. */
  title: string
  status: DoctorStatus
  /** What was actually observed — never a restatement of the title. */
  detail: string
  /** What to do about it, when there is something to do. */
  remedy?: string
}

export interface DoctorReport {
  checks: DoctorCheck[]
  status: DoctorStatus
  exitCode: 0 | 1 | 2
  summary: string
}

/** The raw readings the checks are computed from. Every field is optional: a reading that
 *  could not be taken becomes a WARN ("could not answer"), never a silent pass. */
export interface DoctorReadings {
  build?: { version: string; shortSha: string; branch: string; dirty: boolean; builtAt: string }
  /** The installed bundle's own build info, when the caller can read it (deploy identity). */
  installedBuild?: { shortSha: string; builtAt: string } | null
  health?: { status?: string; indexed?: number } | null
  brainHealth?: { overall?: number } | null
  /** The backend-health entry as /debug/backend-health serves it, plus the monitor's OWN
   *  verdict on it. `problems` comes from detectBackendRegression so the thresholds live in
   *  one place - re-deriving "is 14h too old for a backup" here would be a second opinion
   *  that drifts from the monitor's. */
  backendHealth?: { problems?: string[]; integrityOk?: boolean } | null
  stalls?: { recent?: { scope: string; ms: number }[] } | null
  gaps?: { open?: number } | null
  /** Provider ids that have a key stored. */
  providersWithKeys?: string[]
  /** Result of an OPT-IN live probe: did a real request actually get an answer? */
  liveProbe?: { ok: boolean; provider?: string; error?: string } | null
  /** Channels the operator enabled that still lack their credential. */
  channelsWaiting?: string[]
}

const STALL_WARN_MS = 500

function worst(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail'
  if (checks.some((c) => c.status === 'warn')) return 'warn'
  return 'pass'
}

/** Build the report. Pure: same readings in, same report out. */
export function buildDoctorReport(r: DoctorReadings): DoctorReport {
  const checks: DoctorCheck[] = []

  // 1 — WHICH BUILD IS THIS. The stale-asar failure mode is silent by construction: the
  // app runs, every surface renders, and the code is simply older than the fix you shipped.
  if (!r.build || r.build.shortSha === 'unknown') {
    checks.push({
      id: 'build',
      title: 'Build provenance',
      status: 'warn',
      detail: 'This build carries no commit stamp (a source run, or built outside the pipeline).',
      remedy: 'Nothing to do for a dev run; a packaged install without a stamp is worth investigating.'
    })
  } else {
    const dirty = r.build.dirty ? ' (built from a DIRTY tree)' : ''
    const drifted = !!r.installedBuild && r.installedBuild.shortSha !== r.build.shortSha
    const drift = drifted
      ? ` - the running app reports ${r.installedBuild!.shortSha}, which is not this build`
      : ''
    // A dirty build DRIFTING from the running app is ordinary: it means someone is running
    // the CLI out of a working tree while the app runs the last thing that was deployed.
    // Only a CLEAN build disagreeing with the app is the stale-asar failure - the deploy
    // shipped, reported success, and left the old bundle in place.
    checks.push({
      id: 'build',
      title: 'Build provenance',
      status: drifted ? (r.build.dirty ? 'warn' : 'fail') : 'pass',
      detail: `${r.build.version} @ ${r.build.shortSha} on ${r.build.branch}${dirty}, built ${r.build.builtAt}${drift}`,
      ...(drifted
        ? {
            remedy: r.build.dirty
              ? 'Expected for a dev-tree run. Deploy this tree if the app should be running it.'
              : 'A deploy shipped a stale asar. Re-run deploy.cmd and confirm its GUARD B hash match.'
          }
        : {})
    })
  }

  // 2 — IS THE BRAIN ANSWERING AT ALL.
  if (!r.health) {
    checks.push({
      id: 'brain',
      title: 'Brain endpoint',
      status: 'fail',
      detail: 'The in-process brain did not answer /health.',
      remedy: 'Is the app running? Check the engine port and the main-process log.'
    })
  } else if (r.health.status !== 'ok') {
    checks.push({
      id: 'brain',
      title: 'Brain endpoint',
      status: 'fail',
      detail: `/health reported status=${String(r.health.status)}`,
      remedy: 'Read the main-process log; the engine started but is not healthy.'
    })
  } else {
    const indexed = r.health.indexed ?? 0
    checks.push({
      id: 'brain',
      title: 'Brain endpoint',
      status: indexed > 0 ? 'pass' : 'warn',
      detail: `answering, ${indexed} notes indexed`,
      ...(indexed === 0
        ? { remedy: 'No notes are indexed - connect a folder in Settings > Brain, or run a reindex.' }
        : {})
    })
  }

  // 3 — CAN A MODEL ACTUALLY RUN. A stored key is NOT evidence: the 402 outage passed every
  // key check for two weeks because listing models is free while completing is not.
  const keys = r.providersWithKeys
  if (!keys) {
    checks.push({
      id: 'model',
      title: 'Model access',
      status: 'warn',
      detail: 'Could not read which providers have keys.'
    })
  } else if (keys.length === 0) {
    checks.push({
      id: 'model',
      title: 'Model access',
      status: 'fail',
      detail: 'No provider key is stored, so no model can run.',
      remedy: 'Add a key in Settings > API Keys.'
    })
  } else if (!r.liveProbe) {
    checks.push({
      id: 'model',
      title: 'Model access',
      status: 'warn',
      detail: `${keys.length} provider key(s) stored - but a stored key only proves a key exists.`,
      remedy: 'Run with --live to send one tiny request and prove a model actually answers.'
    })
  } else if (!r.liveProbe.ok) {
    checks.push({
      id: 'model',
      title: 'Model access',
      status: 'fail',
      detail: `the live probe was refused: ${r.liveProbe.error ?? 'no reason given'}`,
      remedy: 'Check the provider balance/quota - this is the shape the 402 outage took.'
    })
  } else {
    checks.push({
      id: 'model',
      title: 'Model access',
      status: 'pass',
      detail: `a live request to ${r.liveProbe.provider ?? 'the routed provider'} was answered`
    })
  }

  // 4 — BACKEND (db + durable stores). A corrupt DB is a FAIL; everything else the monitor
  // flags (a stale backup, a wedged run) is a WARN — real, but not "your data is damaged".
  if (!r.backendHealth) {
    checks.push({
      id: 'backend',
      title: 'Backend health',
      status: 'warn',
      detail: 'The backend-health monitor did not report.'
    })
  } else {
    const problems = r.backendHealth.problems ?? []
    const corrupt = r.backendHealth.integrityOk === false
    checks.push({
      id: 'backend',
      title: 'Backend health',
      status: corrupt ? 'fail' : problems.length ? 'warn' : 'pass',
      detail: problems.length
        ? problems.join('; ')
        : 'stores respond, integrity_check is clean, no wedged runs',
      ...(problems.length ? { remedy: 'Full readings at /debug/backend-health.' } : {})
    })
  }

  // 5 — BRAIN QUALITY, as its own benchmark scores it.
  if (typeof r.brainHealth?.overall === 'number') {
    const overall = r.brainHealth.overall
    checks.push({
      id: 'brain-health',
      title: 'Brain health score',
      status: overall >= 70 ? 'pass' : 'warn',
      detail: `overall ${overall}`,
      ...(overall < 70 ? { remedy: 'See /debug/brain-health for the weakest axis.' } : {})
    })
  }

  // 6 — MAIN-THREAD STALLS. The UI-freeze class, and the one number that says whether the
  // idle-gating still holds on this install.
  if (r.stalls?.recent) {
    const bad = r.stalls.recent.filter((s) => s.ms >= STALL_WARN_MS)
    const worstStall = bad.slice().sort((a, b) => b.ms - a.ms)[0]
    checks.push({
      id: 'stalls',
      title: 'Main-thread stalls',
      status: bad.length === 0 ? 'pass' : 'warn',
      detail:
        bad.length === 0
          ? `no stall over ${STALL_WARN_MS}ms in the recent window`
          : `${bad.length} stall(s) over ${STALL_WARN_MS}ms, worst ${worstStall.ms}ms in ${worstStall.scope}`,
      ...(bad.length ? { remedy: 'An unattributed scope means the work is past an await - widen the scope before optimising.' } : {})
    })
  }

  // 7 — CAPABILITY GAPS the brain itself recorded.
  if (typeof r.gaps?.open === 'number' && r.gaps.open > 0) {
    checks.push({
      id: 'gaps',
      title: 'Capability gaps',
      status: 'warn',
      detail: `${r.gaps.open} open gap(s) recorded by the detector`,
      remedy: 'See /debug/gaps.'
    })
  }

  // 8 — CHANNELS ENABLED BUT UNCONFIGURED: on, and silently unable to connect.
  if (r.channelsWaiting?.length) {
    checks.push({
      id: 'channels',
      title: 'Channels',
      status: 'warn',
      detail: `enabled but waiting for credentials: ${r.channelsWaiting.join(', ')}`,
      remedy: 'Settings > Channels now has an input for each one.'
    })
  }

  const status = worst(checks)
  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  return {
    checks,
    status,
    exitCode: status === 'fail' ? 1 : status === 'warn' ? 2 : 0,
    summary:
      status === 'pass'
        ? `${checks.length} checks passed.`
        : `${failed} failed, ${warned} need reading, ${checks.length - failed - warned} passed.`
  }
}

const MARK: Record<DoctorStatus, string> = { pass: '+', warn: '!', fail: 'x' }

/** Some detail text is passed through from other modules (the backend monitor writes
 *  "count=1532 >= 100" with a real >= glyph), so terminal-safety cannot be a property of
 *  this file's string literals alone - it has to be enforced at the boundary that prints. */
function ascii(text: string): string {
  return text
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[—–]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, '->')
    // Anything still outside printable ASCII becomes ? rather than mojibake.
    .replace(/[^ -~]/g, '?')
}

/** Render for a terminal. ASCII only - this prints under cmd.exe and Git Bash alike. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines = ['', '  DUIN doctor', '  ' + '-'.repeat(56)]
  for (const c of report.checks) {
    lines.push(`  [${MARK[c.status]}] ${ascii(c.title)}`)
    lines.push(`      ${ascii(c.detail)}`)
    if (c.remedy) lines.push(`      -> ${ascii(c.remedy)}`)
  }
  lines.push('  ' + '-'.repeat(56))
  lines.push(`  ${report.summary} (exit ${report.exitCode})`)
  lines.push('')
  return lines.join('\n')
}
