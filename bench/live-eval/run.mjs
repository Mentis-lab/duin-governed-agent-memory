#!/usr/bin/env node
// run.mjs — bench/live-eval: the 2026-09-02 seven-lane evaluation as a repeatable suite.
//
// Launches an ISOLATED DUIN instance built from this tree (scripts/live-eval-launch.mjs), seeds
// provider keys over CDP from LIVE_EVAL_KEY_<PROVIDER>, runs the probe modules serially (one turn
// in flight, every /agui turn carrying x-duin-bench: 1), and writes
// runs/<ISO>/{scorecard.json,summary.md,turns.jsonl,run.log}. Exit 1 when a measured lane scores
// below config.json `threshold`. See README.md.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { launchIsolated } from '../../scripts/live-eval-launch.mjs'
import { rawRequest, aguiTurn, aguiBeacon, mcpCall, parseJsonSafe } from './lib/http.mjs'
import { connectCdp, waitForApi } from './lib/cdp.mjs'
import { openReadOnly } from './lib/sql.mjs'
import { snapshotTree } from './lib/fs-snap.mjs'
import { aggregateLanes, lanesBelow, renderSummary } from './lib/scorecard.mjs'
import { readText } from './lib/probe-utils.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/** Module order is the run order. `exemption` must stay last: it measures what every other turn left behind. */
export const PROBE_ORDER = ['admission', 'engines', 'tools', 'brain', 'governance', 'memory', 'observability', 'renderer', 'exemption']

export const USAGE = `usage: node bench/live-eval/run.mjs [options]

Runs the L1-L7 live evaluation against an ISOLATED DUIN instance built from this tree
(dist/win-unpacked/DUIN.exe when present, else node_modules electron + out/) and writes
bench/live-eval/runs/<ISO>/scorecard.json + summary.md. Exit code 1 when any measured
lane scores below the threshold in bench/live-eval/config.json.

  --probe <name[,name]>  run only these probe modules (${PROBE_ORDER.join(', ')})
  --exe <path>           launch this binary instead of the tree's own build
  --keep                 leave the instance running afterwards (stop it with
                         node scripts/live-eval-launch.mjs --stop <runDir>/instance)
  --json                 print the scorecard JSON instead of the summary
  --config <path>        alternative config.json
  --out <dir>            run directory (default bench/live-eval/runs/<ISO>)
  --help                 this text

Provider keys come from LIVE_EVAL_KEY_<PROVIDER> (e.g. LIVE_EVAL_KEY_DEEPSEEK) and are
seeded into the isolated instance over CDP; the owner's keys.json is never read. With no
key set only the keyless probes run and engine-dependent probes are reported as skipped.
LIVE_EVAL_MODEL_<PROVIDER> overrides the model id pinned for that provider.
`

export function parseArgs(argv) {
  const args = { help: false, json: false, keep: false, exe: null, probes: [], config: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--json') args.json = true
    else if (a === '--keep') args.keep = true
    else if (a === '--exe') args.exe = next()
    else if (a === '--probe')
      args.probes.push(
        ...next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    else if (a === '--config') args.config = next()
    else if (a === '--out') args.out = next()
    else throw new Error(`unknown argument: ${a}`)
  }
  for (const p of args.probes) if (!PROBE_ORDER.includes(p)) throw new Error(`unknown probe: ${p} (known: ${PROBE_ORDER.join(', ')})`)
  return args
}

/** PURE. Engines with a key in the environment, ordered by the provider policy. Keys never leave this process. */
export function enginesFromEnv(config, env) {
  const order = config.providerPolicy?.order ?? []
  const rank = (p) => {
    const i = order.indexOf(p)
    return i < 0 ? order.length : i
  }
  const envKey = (p) => p.toUpperCase().replace(/-/g, '_')
  const seeded = []
  for (const e of config.engines ?? []) {
    const key = env[`LIVE_EVAL_KEY_${envKey(e.provider)}`]
    if (!key || !key.trim()) continue
    const model = (env[`LIVE_EVAL_MODEL_${envKey(e.provider)}`] || e.model).trim()
    seeded.push({ provider: e.provider, model, key: key.trim() })
  }
  return seeded.sort((a, b) => rank(a.provider) - rank(b.provider))
}

function gitBuild() {
  const sha = spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || 'unknown'
  const dirty = (spawnSync('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout ?? '').trim().length > 0
  return dirty ? `${sha}+dirty` : sha
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startStallSampler({ http, pollMs }) {
  const seen = new Map()
  let latestTotals = {}
  const started = Date.now()
  let polls = 0
  let errors = 0
  const tick = async () => {
    try {
      const r = await http({ path: '/debug/stalls', timeoutMs: 10000 })
      const j = parseJsonSafe(r.text)
      if (!j) return
      polls += 1
      latestTotals = j.totals ?? latestTotals
      for (const s of j.stalls ?? []) seen.set(`${s.at}:${s.scope}:${s.ms}`, s)
    } catch {
      errors += 1
    }
  }
  const timer = setInterval(() => {
    void tick()
  }, pollMs)
  timer.unref?.()
  void tick()
  return {
    started,
    stop: () => clearInterval(timer),
    summary: () => {
      const samples = [...seen.values()]
      const un = samples
        .filter((s) => s.scope === 'unattributed')
        .map((s) => s.ms)
        .sort((a, b) => a - b)
      const topScopes = Object.entries(latestTotals)
        .sort((a, b) => (b[1]?.totalMs ?? 0) - (a[1]?.totalMs ?? 0))
        .slice(0, 8)
        .map(([scope, v]) => ({ scope, ...v }))
      return {
        windowMs: Date.now() - started,
        polls,
        errors,
        ringSamples: samples.length,
        unattributed: { count: un.length, maxMs: un.length ? un[un.length - 1] : null, medianMs: un.length ? un[Math.floor(un.length / 2)] : null },
        topScopes
      }
    }
  }
}

async function buildCtx({ config, questions, engines, instance, cdp, runDir, log }) {
  const port = instance.brain.port
  const token = instance.execToken()
  const sandboxDir = join(instance.root, 'sandbox')
  mkdirSync(sandboxDir, { recursive: true })
  const threadIds = new Set()
  const runIds = new Set()
  const turnsPath = join(runDir, 'turns.jsonl')
  const newId = (prefix) => `live-eval-${prefix}-${randomUUID().slice(0, 8)}`
  const http = (opts) => rawRequest({ port, ...opts })

  let chain = Promise.resolve()
  const agui = (body, opts = {}) => {
    const exec = async () => {
      const threadId = body.threadId ?? newId(opts.probe ?? 'turn')
      threadIds.add(threadId)
      const rec = await aguiTurn({
        port,
        token,
        body: { ...body, threadId },
        timeoutMs: opts.timeoutMs ?? config.turnTimeoutMs,
        onRunStarted: (rid) => {
          runIds.add(rid)
          opts.onRunStarted?.(rid)
        }
      })
      rec.threadId = threadId
      rec.model = body.model ?? null
      rec.mode = body.permissionsMode ?? null
      rec.probe = opts.probe ?? null
      appendFileSync(turnsPath, JSON.stringify(rec) + '\n')
      log(`    turn ${opts.probe ?? threadId}: ${rec.seconds}s ${rec.answer.length} chars tools=${rec.tools.map((t) => t.name).join(',') || '-'}${rec.errors.length ? ` errors=${JSON.stringify(rec.errors)}` : ''}`)
      return rec
    }
    if (opts.concurrent) return exec()
    const p = chain.then(exec, exec)
    chain = p.then(
      () => {},
      () => {}
    )
    return p
  }

  let db = null
  const sql = async (q, params = []) => {
    if (!db) db = await openReadOnly(join(instance.userData, 'lamprey.db'))
    if (!db.ok) return { ok: false, error: db.error }
    try {
      return { ok: true, rows: db.query(q, params) }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }
  const turns = async (limit = 200) => {
    try {
      const r = await http({ path: `/debug/turns?limit=${limit}`, timeoutMs: 20000 })
      return parseJsonSafe(r.text)?.turns ?? []
    } catch {
      return []
    }
  }
  const turnFor = async (threadId, { waitMs = 10000 } = {}) => {
    const t0 = Date.now()
    let best = null
    for (;;) {
      const hit = (await turns(300)).find((t) => t.threadId === threadId)
      if (hit) {
        best = hit
        if (hit.end) return hit
      }
      if (Date.now() - t0 > waitMs) return best
      await sleep(2000)
    }
  }
  const journal = (runId) => {
    const text = readText(join(instance.userData, 'agui-journal', `${runId}.jsonl`))
    if (!text) return []
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => parseJsonSafe(l))
      .filter(Boolean)
  }
  const benchHonored = () => {
    for (const rid of runIds) {
      const rows = journal(rid)
      if (rows.length && rows[0].bench === true) return true
    }
    return false
  }
  let laneC = false
  try {
    laneC = (await http({ path: '/debug/log-tail', timeoutMs: 5000 })).status === 200
  } catch {
    laneC = false
  }
  const readLearningState = () => {
    const om = parseJsonSafe(readText(join(instance.userData, 'operator-model.json')) ?? '')
    const facts = Array.isArray(om?.facts) ? om.facts.filter((f) => f && typeof f.id === 'string') : []
    const notices = Object.values(parseJsonSafe(readText(join(instance.userData, 'notices.json')) ?? '')?.notices ?? {})
    const beliefNotices = notices.filter((n) => /candidate belief/i.test(n?.title ?? '')).length
    const corrections = (readText(join(instance.vaultDir, '.duin', '_state', 'corrections.jsonl')) ?? '').split('\n').filter(Boolean).length
    return { facts, factIds: new Set(facts.map((f) => f.id)), beliefNotices, corrections }
  }
  const sampler = startStallSampler({ http, pollMs: config.observability.stallPollMs })
  const ctx = {
    config,
    questions,
    engines,
    primary: engines[0] ?? null,
    keyless: engines.length === 0,
    instance,
    cdp,
    port,
    token,
    sandboxDir,
    runDir,
    threadIds,
    runIds,
    log,
    sleep,
    newId,
    http,
    mcp: (opts) => mcpCall({ port, ...opts }),
    beacon: (payload) => aguiBeacon({ port, token, payload }),
    agui,
    cdpEval: (expr) => {
      if (!cdp) throw new Error('no CDP session')
      return cdp.evaluate(expr)
    },
    sql,
    turns,
    turnFor,
    journal,
    benchHonored,
    laneCLanded: () => laneC,
    snapshotVault: () => snapshotTree(instance.vaultDir),
    readLearningState,
    baseline: readLearningState(),
    stallSummary: async () => {
      const remaining = config.observability.stallSampleMs - (Date.now() - sampler.started)
      if (remaining > 0) await sleep(remaining)
      return sampler.summary()
    },
    _sampler: sampler,
    _closeDb: () => db?.close?.()
  }
  return ctx
}

function fixtureNoteCount(dir) {
  let n = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else if (e.name.toLowerCase().endsWith('.md')) n += 1
    }
  }
  walk(dir)
  return n
}

/** The brain indexes the vault at boot; probes must not race it. Resolves with the indexed count once it reaches
 *  the fixture's note count, or once it stops moving for 10 s, or at the deadline. */
async function waitForIndex(port, want, timeoutMs) {
  const t0 = Date.now()
  let last = -1
  let lastChange = Date.now()
  for (;;) {
    let n
    try {
      n = Number(parseJsonSafe((await rawRequest({ port, path: '/health', timeoutMs: 5000 })).text)?.indexed ?? 0)
    } catch {
      n = last
    }
    if (n !== last) {
      last = n
      lastChange = Date.now()
    }
    if (n >= want || (n > 0 && Date.now() - lastChange > 10000) || Date.now() - t0 > timeoutMs) return n
    await sleep(1000)
  }
}

const fmt = (r) => (r.skipped ? 'skip' : r.unverified ? `unverified(${r.pass ? 'pass' : 'fail'})` : r.pass ? 'PASS' : 'FAIL')

export async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const config = JSON.parse(readFileSync(args.config ? resolve(args.config) : join(HERE, 'config.json'), 'utf8'))
  const questions = JSON.parse(readFileSync(join(HERE, 'fixtures', 'questions.json'), 'utf8')).questions
  const engines = enginesFromEnv(config, process.env)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const runDir = args.out ? resolve(args.out) : join(HERE, 'runs', stamp)
  mkdirSync(runDir, { recursive: true })
  const logPath = join(runDir, 'run.log')
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`
    if (!args.json) console.log(line)
    appendFileSync(logPath, line + '\n')
  }
  const build = gitBuild()
  log(`live-eval build=${build} engines=${engines.map((e) => e.provider).join(',') || 'none (keyless)'} runDir=${runDir}`)

  const instance = await launchIsolated({
    root: join(runDir, 'instance'),
    repoRoot: REPO,
    exe: args.exe,
    brainPort: config.ports.brain,
    cdpPort: config.ports.cdp,
    fixtureVault: join(HERE, 'fixtures', 'vault'),
    providerPolicy: config.providerPolicy,
    settingsSeed: { ...config.settingsSeed, approvalTimeoutMs: config.approvalTimeoutMs },
    readyTimeoutMs: config.readyTimeoutMs,
    detached: args.keep
  })
  log(`instance up: ${instance.kind} ${instance.exe} pid=${instance.pid} brain=:${instance.brain.port} cdp=:${instance.cdp.port}`)

  let cdp = null
  let ctx = null
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    ctx?._sampler?.stop()
    try {
      ctx?._closeDb?.()
    } catch {
      /* best-effort */
    }
    try {
      cdp?.close()
    } catch {
      /* best-effort */
    }
    if (args.keep) {
      log(`--keep: instance left running; stop it with: node scripts/live-eval-launch.mjs --stop "${instance.root}"`)
      return
    }
    const pids = await instance.stop()
    log(`instance stopped (${pids.length} process(es) swept by exe+userData)`)
  }
  const onSignal = () => {
    stop().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  let exitCode
  try {
    cdp = await connectCdp({ port: instance.cdp.port, timeoutMs: 90000 })
    await waitForApi(cdp, 90000)
    log('renderer bridge up')
    for (const e of engines) {
      const r = await cdp.evaluate(`window.api.settings.saveProviderKey(${JSON.stringify(e.provider)}, ${JSON.stringify(e.key)})`)
      if (!r || r.success !== true) throw new Error(`seeding the ${e.provider} key failed: ${r?.error ?? JSON.stringify(r).slice(0, 120)}`)
      log(`seeded ${e.provider} key (model ${e.model})`)
    }
    log(`fixture index: ${await waitForIndex(instance.brain.port, fixtureNoteCount(join(HERE, 'fixtures', 'vault')), 90000)} notes indexed`)
    ctx = await buildCtx({ config, questions, engines, instance, cdp, runDir, log })
    const selected = args.probes.length ? PROBE_ORDER.filter((p) => args.probes.includes(p)) : PROBE_ORDER
    const probes = []
    for (const modName of selected) {
      const mod = await import(`./probes/${modName}.mjs`)
      log(`> ${modName}`)
      const t0 = Date.now()
      let results
      try {
        results = await mod.run(ctx)
      } catch (err) {
        results = [{ id: 'crashed', pass: false, evidence: (err.stack ?? String(err)).slice(0, 600) }]
        log(`${modName} crashed: ${err.message}`)
      }
      for (const r of results) {
        const id = r.id.startsWith(`${mod.name}.`) ? r.id : `${mod.name}.${r.id}`
        probes.push({ ...r, id, lane: r.lane ?? mod.lane })
        log(`  ${fmt(r)} ${id}`)
      }
      log(`< ${modName} ${Date.now() - t0} ms`)
    }
    const lanes = aggregateLanes(probes)
    const below = lanesBelow(lanes, config.threshold)
    const card = {
      build,
      at: new Date().toISOString(),
      node: process.version,
      exe: instance.exe,
      kind: instance.kind,
      threshold: config.threshold,
      engines: engines.map((e) => `${e.provider}:${e.model}`),
      keyless: engines.length === 0,
      bench: { header: 'x-duin-bench', exemption: ctx.benchHonored() ? 'honored (TURN_START.bench = true)' : 'unverified: header sent on every turn, not yet honored by this build (lane A)' },
      laneC: ctx.laneCLanded(),
      lanes,
      lanesBelow: below,
      probes,
      turns: ctx.threadIds.size,
      instance: { root: instance.root, userData: instance.userData, vault: instance.vaultDir, brainPort: instance.brain.port, cdpPort: instance.cdp.port, log: instance.logPath }
    }
    writeFileSync(join(runDir, 'scorecard.json'), JSON.stringify(card, null, 2))
    writeFileSync(join(runDir, 'summary.md'), renderSummary(card))
    if (args.json) process.stdout.write(JSON.stringify(card, null, 2) + '\n')
    else {
      console.log('\n' + renderSummary(card))
      console.log(`scorecard: ${join(runDir, 'scorecard.json')}`)
    }
    exitCode = below.length ? 1 : 0
  } catch (err) {
    log(`FATAL: ${err.stack ?? err}`)
    exitCode = 2
  } finally {
    await stop()
  }
  return exitCode
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  // node:sqlite still announces itself as experimental on Node 22/24; the suite opens it read-only.
  const origEmit = process.emitWarning.bind(process)
  process.emitWarning = (warning, ...rest) => {
    const msg = typeof warning === 'string' ? warning : (warning?.message ?? '')
    if (/sqlite/i.test(msg)) return
    origEmit(warning, ...rest)
  }
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err))
      process.exit(2)
    }
  )
}
