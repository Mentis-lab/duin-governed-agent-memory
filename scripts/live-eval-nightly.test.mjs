// live-eval-nightly.test.mjs — the nightly entry point's pure pieces and its two refusal paths:
// `--help` launches nothing, and a missing app is exit 2 (never a silent pass).
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs")

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseNightlyArgs, nightlyStamp, nightlyRunDir, buildRunArgs, historyLine, RUN_SCRIPT } from './live-eval-nightly.mjs'

const SCRIPT = fileURLToPath(new URL('./live-eval-nightly.mjs', import.meta.url))

test('parseNightlyArgs: flags, repeated --probe, and the failure modes', () => {
  const a = parseNightlyArgs(['--dry-run', '--root', 'r', '--exe', 'x.exe', '--probe', 'admission,brain', '--probe', 'renderer'])
  assert.deepEqual(a, { help: false, dryRun: true, root: 'r', exe: 'x.exe', probes: ['admission', 'brain', 'renderer'] })
  assert.equal(parseNightlyArgs(['-h']).help, true)
  assert.throws(() => parseNightlyArgs(['--bogus']), /unknown argument/)
  assert.throws(() => parseNightlyArgs(['--root']), /needs a value/)
})

test('nightlyStamp / nightlyRunDir: local-time, minute resolution, under <root>/nightly', () => {
  const d = new Date(2026, 8, 3, 2, 15, 59) // local 2026-09-03 02:15:59
  assert.equal(nightlyStamp(d), '2026-09-03T0215')
  assert.equal(nightlyRunDir('D:\\x\\runs', d), join('D:\\x\\runs', 'nightly', '2026-09-03T0215'))
})

test('buildRunArgs: run.mjs with --out, optional --exe and a joined --probe', () => {
  assert.deepEqual(buildRunArgs({ runDir: 'R' }), [RUN_SCRIPT, '--out', 'R'])
  assert.deepEqual(buildRunArgs({ runDir: 'R', exe: 'D.exe', probes: ['a', 'b'] }), [RUN_SCRIPT, '--out', 'R', '--exe', 'D.exe', '--probe', 'a,b'])
})

test('historyLine: one JSON line with per-lane scores, tolerant of a missing scorecard', () => {
  const line = JSON.parse(
    historyLine({
      scorecard: { build: 'abc1234', lanes: { L1: { score: 9.5, passed: 19, total: 20 }, L4: { score: 10 } } },
      runDir: 'R',
      exit: 0,
      at: '2026-09-03T02:15:00.000Z'
    })
  )
  assert.deepEqual(line, { at: '2026-09-03T02:15:00.000Z', build: 'abc1234', runDir: 'R', exit: 0, lanes: { L1: 9.5, L4: 10 } })
  const none = JSON.parse(historyLine({ scorecard: null, runDir: 'R', exit: 2, at: 't' }))
  assert.deepEqual(none, { at: 't', build: null, runDir: 'R', exit: 2, lanes: {} })
})

test('--help prints usage and exits 0 without launching', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /usage: node scripts\/live-eval-nightly\.mjs/)
})

test('a missing --exe is exit 2 with a plain message, never a run', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--exe', 'Z:\\no\\such\\DUIN.exe'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /cannot start/)
  assert.match(r.stderr, /--exe not found/)
})
