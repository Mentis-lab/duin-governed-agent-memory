#!/usr/bin/env node
// LOOP-LIVENESS LINT — is every unattended loop still wired, and did it actually run?
//
// `bundle-safety-lint` catches a loop that VANISHED FROM THE BINARY. It cannot catch a loop that
// ships fine and never fires — and that failure is just as silent and lasted just as long:
//
//   2026-08-04, measured against the shipped app. `runEntityAutoMergeTick` had never executed in
//   any packaged build; `runDecisionLoop` had never archived a lapsed decision window; the
//   confidential egress firewall ran with an empty denylist. Nothing alerted. The only reason any
//   of it surfaced was someone reading the asar by hand, months later.
//
// So this gate does two things, and the second is the one that would have caught that.
//
// STATIC (default, runs in CI / pre-commit):
//   1. every registered loop's module exists and exports its starter
//   2. every registered starter is imported AND called in electron/main.ts
//   3. every `start*` called in main.ts is REGISTERED here
//
// (3) is the anti-rot property. A registry you have to remember to update is a registry that
// silently goes stale; this one fails the build the day someone adds a loop without declaring it,
// which is also the day they still remember what it does.
//
// RUNTIME (`--probe <vaultDir>`): read the durable artifact each loop appends to and report which
// have gone quiet past their own interval. This is the check that answers "is it ALIVE", not
// merely "is it wired". Advisory by default (`--probe --strict` to fail).

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

/**
 * Every unattended runner started from main.ts.
 *
 * `writes` is the durable artifact under `<vault>/.duin/_state/` that proves the loop RAN. A loop
 * with no observable output cannot be probed, and that is itself worth knowing — record `null`
 * with a reason rather than leaving the field off.
 *
 * `quietAfterMs` is generous on purpose: this should fire when something is DEAD, not when a tick
 * was slow or the machine was asleep.
 */
export const LOOPS = [
  {
    id: 'claim-metabolism',
    starter: 'startClaimMetabolismTick',
    module: 'electron/services/brain/claim-metabolism-tick.ts',
    gate: "DUIN_CLAIM_METABOLISM_LIVE !== '0' (default ON)",
    writes: 'claim-ledger.jsonl',
    quietAfterMs: 6 * 60 * 60 * 1000,
    note: 'Carries the graph sync, the cross-kind collapse and the containment-spine automerge. Idle-gated since 2026-08-21 (runWhenIdle 30s/10min): the ~4s pass froze input when it landed under the operator.'
  },
  {
    id: 'main-stall-monitor',
    starter: 'startMainStallMonitor',
    module: 'electron/services/main-stall-monitor.ts',
    gate: 'always on',
    // In-memory ring buffer served at GET /debug/stalls — deliberately no durable artifact:
    // the instrument must stay cheap enough to never itself appear in its own data.
    writes: null,
    // A 250ms heartbeat is either alive or the process is gone; a quiet window cannot
    // distinguish "healthy, no stalls" from "dead", so probe /debug/stalls instead.
    quietAfterMs: null,
    note: 'The freeze-attribution instrument (P0 of the page-open-freeze work, 2026-08-21). If this is dark, every stall diagnosis is guesswork again.'
  },
  {
    id: 'calibration',
    starter: 'startCalibrationTick',
    module: 'electron/services/brain/calibration-tick.ts',
    gate: 'DUIN_CALIBRATION_TICK_MS !== 0 (default ON)',
    writes: 'forecast-track-record.json',
    quietAfterMs: 6 * 60 * 60 * 1000,
    note: 'Also carries runDecisionLoop, which was dead in the binary until 2026-08-04.'
  },
  {
    id: 'seam-auto-reconcile',
    starter: 'startSeamAutoReconcile',
    module: 'electron/services/brain/seam-reconcile.ts',
    gate: "DUIN_SEAM_AUTO_RECONCILE !== '0' (default ON)",
    // Projects concept/entity files into conceptMemoryDir(notesDir) — a DIRECTORY under
    // .brain/memory, not one artifact — so there is no single file to stat. Same shape as
    // construction-floor below.
    writes: null,
    // Event-debounced (10s) plus a one-shot boot pass at 90s. It is legitimately silent
    // for as long as the vault is untouched, so a quiet window would only ever produce
    // false alarms; liveness is observable through the projected files instead.
    quietAfterMs: null,
    note: 'Started 2026-08-13 (d8baaea) and went unregistered until 2026-08-19 — exactly the anti-rot case rule 3 exists for.'
  },
  {
    id: 'construction-floor',
    starter: 'startConstructionFloor',
    module: 'electron/services/local-brain/notes-watcher.ts',
    gate: 'DUIN_CONSTRUCTION_FLOOR_HOURS !== 0 (default ON)',
    writes: null,
    quietAfterMs: null,
    note: 'Writes the construction cache under .brain/state, not _state — probe via brain-health.'
  },
  {
    id: 'backup-runner',
    starter: 'startBackupRunner',
    module: 'electron/services/backup-runner.ts',
    gate: 'always on',
    writes: null,
    quietAfterMs: null,
    note: 'Writes into .duin/_backups/, not _state.'
  },
  {
    id: 'self-improve',
    starter: 'startSelfImproveTick',
    module: 'electron/services/brain/self-improve-tick.ts',
    gate: 'settings.backgroundAutonomy === true (DARK by default)',
    writes: 'self-improve-bench-history.jsonl',
    quietAfterMs: null,
    note: 'Autonomy-gated: quiet is the CORRECT state unless backgroundAutonomy is on.'
  },
  {
    id: 'measure',
    starter: 'startMeasureTick',
    module: 'electron/services/brain/measure-tick.ts',
    gate: 'DUIN_MEASURE_TICK',
    writes: null,
    quietAfterMs: null,
    note: 'Cloud fallback additionally gated on backgroundAutonomy.'
  },
  {
    id: 'transfer-ab',
    starter: 'startTransferAbTick',
    module: 'electron/services/brain/transfer-ab-tick.ts',
    gate: "DUIN_TRANSFER_AB_TICK !== '0'",
    writes: 'transfer-ab-history.jsonl',
    quietAfterMs: 3 * 24 * 60 * 60 * 1000,
    note: 'Daily.'
  },
  {
    id: 'automations',
    starter: 'startAutomations',
    module: 'electron/services/automations-runner.ts',
    gate: 'per-automation enabled flag; agent turns gated on backgroundAutonomy',
    writes: 'autonomous-log.jsonl',
    quietAfterMs: null,
    note: 'Quiet when no automation is enabled, which is a legitimate state.'
  },
  {
    id: 'loop-wakeups',
    starter: 'startLoopWakeups',
    module: 'electron/services/loop-runner.ts',
    gate: 'settings.backgroundAutonomy === true (DARK by default)',
    writes: 'loop-runner.log',
    quietAfterMs: null,
    note: 'Logs [DRY] lines even when parked, so a fresh mtime does NOT prove it fired.'
  },
  {
    id: 'loop-controller',
    starter: 'startLoopController',
    module: 'electron/services/loop-controller.ts',
    gate: 'loop entities present',
    writes: null,
    quietAfterMs: null,
    note: ''
  },
  {
    id: 'loop-scheduler',
    starter: 'startLoopScheduler',
    module: 'electron/services/loop-scheduler.ts',
    gate: 'settings.backgroundAutonomy === true (DARK by default)',
    writes: null,
    quietAfterMs: null,
    note: ''
  },
  {
    id: 'feedback-bridge',
    starter: 'startFeedbackBridge',
    module: 'electron/services/feedback-bridge.ts',
    gate: 'always on',
    writes: null,
    quietAfterMs: null,
    note: ''
  },
  {
    id: 'learn-bridge',
    starter: 'startLearnBridge',
    module: 'electron/services/learn-bridge.ts',
    gate: 'always on',
    writes: 'corrections.jsonl',
    quietAfterMs: null,
    note: 'Drains pending corrections; quiet when the operator has not corrected anything.'
  },
  {
    id: 'connector-sync',
    starter: 'startConnectorSync',
    module: 'electron/services/connectors/connections-store.ts',
    gate: 'per-connector enabled flag',
    writes: null,
    quietAfterMs: null,
    note: ''
  },
  {
    id: 'channels-gateway',
    starter: 'startGateway',
    module: 'electron/services/channels/gateway.ts',
    gate: 'per-channel enabled AND configured (a keychain secret)',
    writes: 'channel-anchors.jsonl',
    quietAfterMs: null,
    note: 'A channel can be enabled and still never run: there is no UI to supply its credential.'
  },
  {
    id: 'local-brain',
    starter: 'startLocalBrain',
    module: 'electron/services/local-brain/server.ts',
    gate: 'always on',
    writes: 'brain-health-history.jsonl',
    quietAfterMs: 24 * 60 * 60 * 1000,
    note: 'The :8799 server. If this is quiet, everything downstream of it is too.'
  },
  {
    id: 'db-checkpoint',
    starter: 'startPeriodicCheckpoint',
    module: 'electron/services/database.ts',
    gate: 'always on',
    writes: null,
    quietAfterMs: null,
    note: 'WAL checkpoint; no artifact of its own.'
  }
]

/**
 * Nested passes — work that rides on a loop above rather than being started from main.ts.
 *
 * These need a CONTENT probe, not an mtime one, and the automerge is exactly why. Its artifact
 * (`entity-aliases.json`) legitimately sits unchanged for weeks when there is nothing to merge, so
 * a stale mtime proves nothing. What actually gave it away on 2026-08-04 was that not one group in
 * the file carried the `source:'auto'` stamp the pass writes — i.e. it had never run, on any build,
 * ever. That is a question about CONTENT, and it is the question worth asking of any pass whose
 * silence is otherwise indistinguishable from having nothing to do.
 */
export const NESTED = [
  {
    id: 'entity-automerge + kind-collapse',
    ridesOn: 'claim-metabolism',
    artifact: 'entity-aliases.json',
    /** @returns {{ok: boolean, why: string}} */
    probe(raw) {
      let groups
      try {
        groups = JSON.parse(raw)
      } catch {
        return { ok: false, why: 'entity-aliases.json is not valid JSON' }
      }
      if (!Array.isArray(groups)) return { ok: false, why: 'entity-aliases.json is not an array' }
      const machine = groups.filter((g) => g && (g.source === 'auto' || g.source === 'auto-kind'))
      if (machine.length === 0) {
        return {
          ok: false,
          why:
            `${groups.length} alias group(s), NONE machine-written. Both the containment-spine ` +
            `automerge and the cross-kind collapse stamp \`source\`, so a file with none means ` +
            `neither has ever run — which was true of every packaged build before 2026-08-04.`
        }
      }
      return { ok: true, why: `${machine.length}/${groups.length} group(s) machine-written` }
    }
  }
]

const IS_CLI = !!process.argv[1] && process.argv[1].endsWith('loop-liveness-lint.mjs')
if (!IS_CLI) {
  // imported by scripts/loop-liveness-lint.test.mjs — export the registry and probes, run nothing.
} else {
  runCli()
}

function runCli() {
const main = readFileSync(join(REPO, 'electron/main.ts'), 'utf-8')
const errors = []
const warnings = []

// ── 1 + 2: every registered loop is wired ─────────────────────────────────────────────────
for (const l of LOOPS) {
  const modPath = join(REPO, l.module)
  if (!existsSync(modPath)) {
    errors.push(`${l.id}: module missing — ${l.module}`)
    continue
  }
  const src = readFileSync(modPath, 'utf-8')
  if (!new RegExp(`export\\s+(async\\s+)?function\\s+${l.starter}\\b`).test(src)) {
    errors.push(`${l.id}: ${l.module} does not export ${l.starter}()`)
  }
  if (!new RegExp(`\\b${l.starter}\\b`).test(main)) {
    errors.push(`${l.id}: ${l.starter} is never referenced in electron/main.ts — the loop cannot start`)
  } else if (!new RegExp(`\\b${l.starter}\\s*\\(`).test(main)) {
    errors.push(`${l.id}: ${l.starter} is imported into main.ts but never CALLED`)
  }
}

// ── 3: every start* in main.ts is registered (the anti-rot property) ──────────────────────
const registered = new Set(LOOPS.map((l) => l.starter))
const called = new Set([...main.matchAll(/\b(start[A-Z][A-Za-z]*)\s*\(/g)].map((m) => m[1]))
for (const c of called) {
  if (!registered.has(c)) {
    errors.push(
      `${c}() is started in main.ts but is NOT in the LOOPS registry. ` +
        `Add it (with its gate and the artifact it writes) so it can be probed for liveness.`
    )
  }
}
for (const l of LOOPS) {
  if (!called.has(l.starter)) {
    warnings.push(`${l.id}: registered but no call found in main.ts — retired? remove the entry.`)
  }
}

// ── runtime probe ─────────────────────────────────────────────────────────────────────────
const probeIdx = process.argv.indexOf('--probe')
const quiet = []
if (probeIdx >= 0) {
  const vault = process.argv[probeIdx + 1]
  const stateDir = vault ? join(vault, '.duin', '_state') : null
  if (!stateDir || !existsSync(stateDir)) {
    warnings.push(`--probe: no state dir at ${stateDir ?? '(no vault given)'}`)
  } else {
    const now = Date.now()
    const present = new Set(readdirSync(stateDir))
    for (const l of LOOPS) {
      if (!l.writes || l.quietAfterMs == null) continue
      if (!present.has(l.writes)) {
        quiet.push({ id: l.id, artifact: l.writes, age: null, why: 'artifact has never been written' })
        continue
      }
      const age = now - statSync(join(stateDir, l.writes)).mtimeMs
      if (age > l.quietAfterMs) {
        quiet.push({ id: l.id, artifact: l.writes, age, why: 'stale' })
      }
    }
    for (const n of NESTED) {
      const p = join(stateDir, n.artifact)
      if (!existsSync(p)) {
        quiet.push({ id: n.id, artifact: n.artifact, age: null, why: 'artifact has never been written' })
        continue
      }
      const r = n.probe(readFileSync(p, 'utf-8'))
      if (!r.ok) quiet.push({ id: n.id, artifact: n.artifact, age: null, why: r.why })
    }
  }
}

const BAR = '─'.repeat(76)
const hrs = (ms) => `${Math.round(ms / 3_600_000)}h`
console.log('')
console.log('  loop-liveness lint — is every unattended loop wired, and did it run?')
console.log(`  ${BAR}`)
console.log(`  ${LOOPS.length} registered · ${called.size} started in main.ts`)
for (const w of warnings) console.log(`  ⚠ ${w}`)
if (probeIdx >= 0) {
  if (quiet.length === 0) console.log('  probe: every probeable loop has written within its window')
  for (const q of quiet) {
    console.log(`  ⚠ QUIET ${q.id} — ${q.artifact} ${q.age == null ? q.why : `last written ${hrs(q.age)} ago`}`)
  }
}
console.log(`  ${BAR}`)
if (errors.length === 0) {
  console.log('  RESULT: PASS — every loop is wired, and every started loop is declared.')
  console.log('')
  process.exit(quiet.length && process.argv.includes('--strict') ? 1 : 0)
}
for (const e of errors) console.log(`  ✗ ${e}`)
console.log(`  ${BAR}`)
console.log(`  RESULT: FAIL — ${errors.length} loop wiring problem(s).`)
console.log('')
console.log('  A loop that loses its start call, its export, or its registry entry goes dark')
console.log('  silently — every one of these sits behind a best-effort try/catch.')
console.log('')
process.exit(1)
}
