// run-help.test.mjs — the CLI parses, `--help` never launches anything, and engines are picked
// from LIVE_EVAL_KEY_<PROVIDER> in provider-policy order. Run: node --test bench/live-eval/test/*.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs, enginesFromEnv, PROBE_ORDER } from '../run.mjs'

const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url))

test('parseArgs: flags, repeated --probe, and the failure modes', () => {
  const a = parseArgs(['--json', '--keep', '--exe', 'x.exe', '--probe', 'admission,brain', '--probe', 'renderer', '--out', 'o', '--config', 'c'])
  assert.deepEqual(a, { help: false, json: true, keep: true, exe: 'x.exe', probes: ['admission', 'brain', 'renderer'], config: 'c', out: 'o' })
  assert.equal(parseArgs(['-h']).help, true)
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/)
  assert.throws(() => parseArgs(['--exe']), /needs a value/)
  assert.throws(() => parseArgs(['--probe', 'nope']), /unknown probe/)
  assert.equal(PROBE_ORDER.at(-1), 'exemption')
})

test('enginesFromEnv: only keyed providers, policy order, model override, keys kept verbatim', () => {
  const config = {
    providerPolicy: { order: ['deepseek', 'openai'] },
    engines: [
      { provider: 'openai', model: 'gpt-5.5' },
      { provider: 'deepseek', model: 'deepseek-v4-flash' },
      { provider: 'zhipu', model: 'glm-5.3-flash' }
    ]
  }
  const env = { LIVE_EVAL_KEY_OPENAI: ' sk-o ', LIVE_EVAL_KEY_DEEPSEEK: 'sk-d', LIVE_EVAL_KEY_ZHIPU: '   ', LIVE_EVAL_MODEL_DEEPSEEK: 'deepseek-v4-pro' }
  assert.deepEqual(enginesFromEnv(config, env), [
    { provider: 'deepseek', model: 'deepseek-v4-pro', key: 'sk-d' },
    { provider: 'openai', model: 'gpt-5.5', key: 'sk-o' }
  ])
  assert.deepEqual(enginesFromEnv(config, {}), [])
})

test('run.mjs --help prints usage and exits 0 without launching', () => {
  const r = spawnSync(process.execPath, [RUN, '--help'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /usage: node bench\/live-eval\/run\.mjs/)
  assert.match(r.stdout, /LIVE_EVAL_KEY_<PROVIDER>/)
  for (const p of PROBE_ORDER) assert.match(r.stdout, new RegExp(p))
})

test('run.mjs rejects an unknown flag with exit 2', () => {
  const r = spawnSync(process.execPath, [RUN, '--nope'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /unknown argument/)
})
