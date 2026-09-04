#!/usr/bin/env node
// live-eval-nightly.mjs — the SCHEDULED entry point for bench/live-eval (plan §2.6 / W19).
//
// One command an unattended scheduler runs (the Windows scheduled task itself is created on the
// operator's machine, not in this repo):
//
//   node scripts/live-eval-nightly.mjs [--root <dir>] [--exe <path>] [--probe a,b] [--dry-run]
//
// What it does, and nothing else:
//   1. resolves the app under test exactly as run.mjs does (live-eval-launch.mjs
//      resolveLaunchTarget): dist/win-unpacked/DUIN.exe when present, else node_modules electron +
//      out/, else --exe. Exits 2 with a plain message when nothing is built — a nightly that
//      "passes" because there was nothing to launch is the failure this repo keeps finding;
//   2. runs bench/live-eval/run.mjs --out <root>/nightly/<YYYY-MM-DDTHHMM> (provider keys come from
//      LIVE_EVAL_KEY_<PROVIDER> in the scheduler's environment; the owner's keys.json is never read);
//   3. copies that run's scorecard.json to <root>/nightly/latest.json and appends one line to
//      <root>/nightly/history.jsonl ({ at, build, runDir, exit, lanes }) so the plan's gate — three
//      consecutive runs at target — is readable from one file;
//   4. exits with run.mjs's code (0 pass, 1 a measured lane below threshold), or 2 when the run
//      could not start.
//
// Isolation is the launcher's (own userData, ports 8899/9444, the owner's dirs and ports refused);
// this script adds no process control of its own. `--dry-run` resolves and prints without
// launching, which is how a scheduled task is verified before its first night.
//
// The pure pieces are exported for scripts/live-eval-nightly.test.mjs (npm run test:teeth).

import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveLaunchTarget } from './live-eval-launch.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const RUN_SCRIPT = join(REPO_ROOT, 'bench', 'live-eval', 'run.mjs')
export const DEFAULT_ROOT = join(REPO_ROOT, 'bench', 'live-eval', 'runs')

export const USAGE = `usage: node scripts/live-eval-nightly.mjs [--root <dir>] [--exe <path>] [--probe a,b] [--dry-run]

Runs bench/live-eval/run.mjs unattended against dist/win-unpacked/DUIN.exe when present (else
node_modules electron + out/, else --exe) under <root>/nightly/<YYYY-MM-DDTHHMM>/, then writes
<root>/nightly/latest.json and appends one line to <root>/nightly/history.jsonl.
Default root: bench/live-eval/runs. Exit 0 pass, 1 a lane below threshold, 2 could not start.

  --root <dir>      where the nightly/ tree lives (default bench/live-eval/runs)
  --exe <path>      launch this binary instead of the tree's own build
  --probe <a,b>     pass-through to run.mjs --probe
  --dry-run         resolve the app and the run directory, print them, launch nothing
  --help            this text
`

export function parseNightlyArgs(argv) {
  const args = { help: false, dryRun: false, root: null, exe: null, probes: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--root') args.root = next()
    else if (a === '--exe') args.exe = next()
    else if (a === '--probe')
      args.probes.push(
        ...next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

const pad = (n) => String(n).padStart(2, '0')

/** PURE. Local-time run stamp, minute resolution, filesystem-safe: 2026-09-03T0215. */
export function nightlyStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** PURE. <root>/nightly/<stamp>. */
export function nightlyRunDir(root, date = new Date()) {
  return join(resolve(root), 'nightly', nightlyStamp(date))
}

/** PURE. The run.mjs argv for one nightly run. */
export function buildRunArgs({ runDir, exe = null, probes = [] }) {
  const out = [RUN_SCRIPT, '--out', runDir]
  if (exe) out.push('--exe', exe)
  if (probes.length) out.push('--probe', probes.join(','))
  return out
}

/** PURE. One history.jsonl line: what a reader needs to judge three consecutive runs. */
export function historyLine({ scorecard, runDir, exit, at = new Date().toISOString() }) {
  const lanes = {}
  for (const [lane, v] of Object.entries(scorecard?.lanes ?? {})) lanes[lane] = v?.score ?? null
  return JSON.stringify({ at, build: scorecard?.build ?? null, runDir, exit, lanes })
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

async function main(argv) {
  let args
  try {
    args = parseNightlyArgs(argv)
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    return 2
  }
  if (args.help) {
    console.log(USAGE)
    return 0
  }
  let target
  try {
    target = resolveLaunchTarget(REPO_ROOT, args.exe)
  } catch (err) {
    console.error(`live-eval-nightly: cannot start — ${err.message}`)
    return 2
  }
  const root = resolve(args.root ?? DEFAULT_ROOT)
  const runDir = nightlyRunDir(root)
  const runArgs = buildRunArgs({ runDir, exe: args.exe, probes: args.probes })
  console.log(`live-eval-nightly: app = ${target.exe} (${target.kind})`)
  console.log(`live-eval-nightly: run  = ${runDir}`)
  if (args.dryRun) {
    console.log(`live-eval-nightly: dry run — would exec: node ${runArgs.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`)
    return 0
  }
  mkdirSync(runDir, { recursive: true })
  const r = spawnSync(process.execPath, runArgs, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env })
  const exit = typeof r.status === 'number' ? r.status : 2
  const scorecardPath = join(runDir, 'scorecard.json')
  const scorecard = readJson(scorecardPath)
  const nightlyDir = join(root, 'nightly')
  mkdirSync(nightlyDir, { recursive: true })
  if (scorecard && existsSync(scorecardPath)) copyFileSync(scorecardPath, join(nightlyDir, 'latest.json'))
  appendFileSync(join(nightlyDir, 'history.jsonl'), historyLine({ scorecard, runDir, exit }) + '\n')
  console.log(`live-eval-nightly: exit ${exit}${scorecard ? '' : ' (no scorecard written)'} — history at ${join(nightlyDir, 'history.jsonl')}`)
  return exit
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`live-eval-nightly: ${err?.stack || err}`)
      process.exit(2)
    }
  )
}
