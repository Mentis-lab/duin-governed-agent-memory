#!/usr/bin/env node
//
// WC-7 — Repo-local proof policy gate.
//
// Flags:
//   --require-smokes   force-run the bundle / renderer smokes; fail if
//                      the build output is not present.
//   --no-tests         skip the vitest pass. Intended for CI's static
//                      gate job, where a sibling `test` job already runs
//                      the full suite under coverage. Skipping here
//                      avoids duplicate work without losing the lint /
//                      tsc / script-composition check.
//   --list-native-skips print only the native-SQLite accounting and exit.
//   --require-native-sqlite
//                      treat dark native-DB suites as a FAILURE. Also settable
//                      via DUIN_REQUIRE_NATIVE_SQLITE=1. Off by default: on the
//                      Electron ABI those suites are expected to be dark, and
//                      failing every local run would be noise. CI's `test-sqlite`
//                      job — which rebuilds for the Node ABI precisely so they
//                      run — sets it.
//
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = process.cwd()
const requireSmokes = process.argv.includes('--require-smokes')
const skipTests = process.argv.includes('--no-tests')
const listNativeSkipsOnly = process.argv.includes('--list-native-skips')

// Dark native-DB suites are advisory by default (a local run on the Electron
// ABI is *expected* to have them dark, and turning every such run red would be
// noise). CI's `test-sqlite` job — whose entire purpose is to execute those
// suites for real — sets this to make the dark case fatal.
const requireNativeSqlite =
  process.argv.includes('--require-native-sqlite') ||
  ['1', 'true', 'yes'].includes(String(process.env.DUIN_REQUIRE_NATIVE_SQLITE || '').toLowerCase())

// ---------------------------------------------------------------------------
// SP-9 (Sweet Spot Phase, 2026-06-10) — native-skip accounting (D7).
//
// The better-sqlite3 native binding is built for Electron's ABI; when vitest
// runs under a mismatched Node ABI, every `describe.skipIf(!HAS_NATIVE_SQLITE)`
// / `it.skipIf(!nativeOk())` suite silently skips. That silence already cost
// a P0 once (v0.9.2: schema-init regression shipped because its test was
// skipping on every CI and local run). This block makes the loss visible at
// gate time: probe whether the binding is USABLE under the CURRENT node, list
// the gated test files, and print an explicit accounting line either way.
//
// 2026-07-25 — the probe used to lie. It ran `node -e "require('better-sqlite3')"`
// and treated exit 0 as "native DB available". better-sqlite3 resolves to a
// plain JS wrapper and defers the dlopen of `better_sqlite3.node` until the
// first `new Database(...)`, so that bare require exits 0 even when the binding
// is compiled for a different NODE_MODULE_VERSION. The gate therefore always
// took the happy path and reported that the guarded suites RAN, while the
// tests' own guard (`new BetterSqlite3(':memory:')` in a try/catch) threw and
// skipped them — the exact silent-loss shape this block was written to prevent.
// The probe must do what the tests do: actually open a database.
// ---------------------------------------------------------------------------

// Mirrors the tests' HAS_NATIVE_SQLITE / nativeOk() guard: construct a real
// Database and run a statement. Anything less does not touch the binding.
const NATIVE_OPEN_PROBE =
  "const D = require('better-sqlite3');" +
  "const db = new D(':memory:');" +
  "db.prepare('select 1 as ok').get();" +
  'db.close()'
const NATIVE_REQUIRE_PROBE = "require('better-sqlite3')"

function runNodeProbe(source) {
  const probe = spawnSync(process.execPath, ['-e', source], {
    cwd: root,
    encoding: 'utf8'
  })
  return {
    ok: probe.status === 0,
    stderr: String(probe.stderr || '').trim()
  }
}

/**
 * Probe whether better-sqlite3's native binding is usable under this Node.
 * Returns { usable, reason, requireOnlyPasses } — `requireOnlyPasses` records
 * whether the old require-only probe would still have reported success, so the
 * dark-suite report can name the lazy-load trap explicitly.
 */
function probeNativeSqlite() {
  const open = runNodeProbe(NATIVE_OPEN_PROBE)
  if (open.ok) return { usable: true, reason: '', requireOnlyPasses: true }

  const requireOnly = runNodeProbe(NATIVE_REQUIRE_PROBE)
  const abi = open.stderr.match(/NODE_MODULE_VERSION\s+\d+[\s\S]{0,120}?NODE_MODULE_VERSION\s+\d+/)
  const firstError = open.stderr.split('\n').find((l) => /^\s*(Error|TypeError)\b/.test(l))
  const reason = abi
    ? abi[0].replace(/\s+/g, ' ')
    : firstError
      ? firstError.trim()
      : open.stderr.split('\n')[0] || 'unknown failure'
  return { usable: false, reason, requireOnlyPasses: requireOnly.ok }
}

// A file counts as ABI-gated only when it *gates on* the guard in live code —
// `describe.skipIf(!HAS_NATIVE_SQLITE)`, `.runIf(HAS_NATIVE_SQLITE)`,
// `if (!nativeOk()) return`. Several test files merely MENTION the guard in a
// header comment precisely because they were written to run without the native
// DB; counting those inflated the cohort and made the printed number false.
const GUARD = '(?:HAS_NATIVE_SQLITE|nativeOk\\s*\\(\\s*\\))'
const GATE_PATTERNS = [
  new RegExp(`\\.(?:skipIf|runIf)\\s*\\(\\s*!?\\s*${GUARD}`),
  new RegExp(`\\bif\\s*\\(\\s*!\\s*${GUARD}\\s*\\)`)
]

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

function listNativeGatedTestFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (/\.test\.tsx?$/.test(name)) {
        try {
          const code = stripComments(readFileSync(full, 'utf8'))
          if (GATE_PATTERNS.some((re) => re.test(code))) {
            out.push(full.slice(root.length + 1).replace(/\\/g, '/'))
          }
        } catch {
          /* unreadable file — skip */
        }
      }
    }
  }
  walk(join(root, 'electron'))
  walk(join(root, 'src'))
  return out.sort()
}

const RULE = '='.repeat(78)

function printNativeSkipAccounting() {
  const gated = listNativeGatedTestFiles()
  const { usable, reason, requireOnlyPasses } = probeNativeSqlite()
  const nodeId = `${process.version}, NODE_MODULE_VERSION ${process.versions.modules}`

  if (usable) {
    console.log(
      `\n[verify:proof] native-sqlite probe: OPENED an in-memory database under ` +
        `this Node (${nodeId}).`
    )
    console.log(
      `[verify:proof] ${gated.length} test file(s) gate suites on the native binding; ` +
        `those suites execute.`
    )
  } else {
    console.warn(`\n${RULE}`)
    console.warn(`[verify:proof] DARK SUITES — better-sqlite3 native binding is NOT usable`)
    console.warn(RULE)
    console.warn(`[verify:proof]   node        : ${nodeId}`)
    console.warn(`[verify:proof]   probe       : new Database(':memory:') THREW`)
    console.warn(`[verify:proof]   reason      : ${reason}`)
    if (requireOnlyPasses) {
      console.warn(
        `[verify:proof]   trap        : require('better-sqlite3') alone still EXITS 0 — the`
      )
      console.warn(
        `[verify:proof]                 binding is dlopen'd lazily, so a require-only probe`
      )
      console.warn(
        `[verify:proof]                 reports a false green. That is the v0.9.2 failure mode.`
      )
    }
    console.warn(
      `[verify:proof]   impact      : ${gated.length} test file(s) gate suites on the native binding.`
    )
    console.warn(
      `[verify:proof]                 Every one of those suites is SKIPPED, not passed. A green`
    )
    console.warn(`[verify:proof]                 run does NOT cover the native-DB paths.`)
    console.warn(`[verify:proof]   gated files :`)
    for (const file of gated) console.warn(`[verify:proof]                 - ${file}`)
    console.warn(
      `[verify:proof]   fix         : run these under a Node whose ABI matches the built binding,`
    )
    console.warn(
      `[verify:proof]                 or rebuild for the Node ABI in a DEDICATED job (CI: test-sqlite).`
    )
    console.warn(
      `[verify:proof]                 Do NOT rebuild in an Electron workspace — the app needs the`
    )
    console.warn(`[verify:proof]                 Electron ABI build.`)
    console.warn(
      `[verify:proof]   gate        : ${
        requireNativeSqlite
          ? 'FATAL (DUIN_REQUIRE_NATIVE_SQLITE / --require-native-sqlite set)'
          : 'advisory — set DUIN_REQUIRE_NATIVE_SQLITE=1 to make this fatal'
      }`
    )
    console.warn(`${RULE}\n`)
  }
  return { usable, gatedCount: gated.length }
}

if (listNativeSkipsOnly) {
  const { usable } = printNativeSkipAccounting()
  process.exit(!usable && requireNativeSqlite ? 1 : 0)
}

// Owner-tooling stages: they verify files that do not ship in the public tree (the lane board,
// CLAUDE.md, the generated handbook). Each script already PASSES when its input is absent; this
// guard covers the tree where the SCRIPT itself was dropped, so the gate reads the same on the
// private trunk and on a public checkout instead of failing on its own missing tooling.
const ownerStage = (label, script, cmd) =>
  existsSync(join(root, script)) ? [[label, cmd]] : (console.log(`[verify:proof] ${label} skipped: ${script} not present (public tree)`), [])

const steps = [
  ['lint', ['npm', ['run', 'lint']]],
  // Architectural lint (dead engines / owner-path leakage / retired-transport refs).
  // It is static, zero-dep and fast, so it belongs on the same static gate as
  // eslint + tsc rather than being a command someone has to remember to type.
  ['lint:cohesion', ['npm', ['run', 'lint:cohesion']]],
  // Signal collapse (property 8). `lint:signal` shipped as a registered npm
  // script that NO gate invoked, so property 8 was "enforced by remembering to
  // type it" — which is what a decoration is. It is static, zero-dep and fast
  // (one pass over ~1,800 files, ~1s) and its enforced rule (RULE 1: an env read
  // that cannot express zero) is exactly the class that silently disabled
  // construct.ts's test sleep. Wired here so the property has teeth.
  ['lint:signal', ['npm', ['run', 'lint:signal']]],
  // The coordination board (SESSION-LANES.md) is only load-bearing while it is
  // TRUE, and it decayed to three stale rows because expiring them was somebody's
  // job to remember. One of those rows was left behind by a MERGE, which is why
  // this lint resolves each row's branch against trunk rather than only reading
  // its date: a date can be retyped, ancestry cannot.
  ...ownerStage('lint:lanes', 'scripts/lane-lint.mjs', ['npm', ['run', 'lint:lanes']]),
  // CLAUDE.md is the first thing every session reads, so a false line in it is a
  // wrong belief installed in every session that starts — not a stale doc. It
  // drifted about itself for months (dead PLANNING citations, "three providers"
  // against a registry declaring fourteen, an Electron pin three majors out of
  // date) because checking it was nobody's job. Now it is this step's.
  ...ownerStage('lint:orientation', 'scripts/lint-orientation.mjs', ['npm', ['run', 'lint:orientation']]),
  // Language parity. The Learn loop could not hear its operator in Chinese —
  // 6/6 real corrections dropped, the same text in English 4/4 captured — and
  // nothing noticed, because whether a gate heard the operator's own language
  // was decided file by file. `success-miner` was bilingual while its sibling
  // `capture-hook` had no CJK at all. This step is the policy: a regex that
  // gates on natural-language MEANING carries CJK alternations or says it is
  // structural, and each gate is pinned by a bilingual test.
  ['lint:language-parity', ['npm', ['run', 'lint:language-parity']]],
  // The lints' OWN tests. vitest's `include` is electron/** + src/**, so a test
  // living next to a script in scripts/ silently never runs — and a gate whose
  // test never runs is the same decoration this file keeps removing. `test:teeth`
  // is node:test (no config, ~4s) and drives each lint as a subprocess against
  // real fixtures, so "the lint stopped parsing the board and now passes
  // vacuously" fails here instead of being discovered by a lost merge.
  ['test:teeth', ['npm', ['run', 'test:teeth']]],
  // Reachability: is this code something the operator can actually get to? The
  // 2026-07-30 audit found ~12.5% of the renderer built and never mounted while
  // the hand-typed coherence map reported one such file. This computes it. It is
  // here rather than in a report because the audit's other lesson was that a
  // mechanism emitting a blocking exit code works and one emitting a warning rots.
  ['lint:reachability', ['npm', ['run', 'lint:reachability']]],
  // Reachability's blind spot, and a different question rather than a second opinion on the
  // same one: that step walks the IMPORT GRAPH and answers "is this FILE ever imported", so
  // `electron/preload.ts` — itself a bundler entry — is maximally reachable no matter how much
  // dead surface it exposes. On 2026-08-17 `window.api.executive` had six handlers registered
  // in main, six bindings on the bridge, and ZERO renderer callers; the pairing notice sent the
  // operator to a screen that had never been built, and it survived three days of this gate.
  // Exposing a binding is cheap and invisible, and it is the moment a capability starts
  // claiming an operator surface exists.
  ['lint:preload-surface', ['npm', ['run', 'lint:preload-surface']]],
  // The blind spot BOTH of the above share: they answer questions about FILES and BRIDGES,
  // so a capability living inside a fully-reached file, exposed on a fully-reached bridge, is
  // invisible to them. That is where August's two most expensive bugs actually lived.
  // `ForkAgentDeps.parentTools` was declared and read and set by no production caller, so
  // `allowedTools: '*'` collapsed to `[]` and every `general` sub-agent ran with zero tools.
  // `WorkflowRunInput.journalDir` was accepted, implemented and covered by a resume test
  // suite that its only two production callers never triggered, so nothing was ever journaled
  // and nothing could ever be resumed from. Both files were maximally 'reachable' throughout.
  // Tests supplied the option in each case, which is precisely why the suite stayed green.
  ['lint:unsupplied-input', ['npm', ['run', 'lint:unsupplied-input']]],
  ['tsc:node', ['npx', ['tsc', '--noEmit', '-p', 'tsconfig.node.json']]],
  ['tsc:web', ['npx', ['tsc', '--noEmit', '-p', 'tsconfig.web.json']]],
  // Both arrived 2026-08-04 as npm scripts that NO runner invoked — the same
  // "enforced by remembering" shape this file's own comments name, shipped by the
  // commit that added two gates to prevent it. A gate nothing runs is documentation.
  ['lint:bundle-safety', ['npm', ['run', 'lint:bundle-safety']]],
  ['lint:loop-liveness', ['npm', ['run', 'lint:loop-liveness']]],
  // The generated handbook describes what the code DOES; --check fails when a curated
  // anchor no longer resolves. Its own header advertised it "for CI / deploy hook" and
  // nothing invoked it, so the handbook could drift from the code with every gate green.
  // Safe to gate only since --check stopped writing: it used to regenerate the tree it
  // was checking, which would have dirtied any CI working copy that ran it.
  ...ownerStage('handbook:check', 'scripts/gen-harness-handbook.mjs', ['node', ['scripts/gen-harness-handbook.mjs', '--check']])
]
if (!skipTests) {
  steps.push(['test', ['npm', ['test']]])
}

const hasBuildOutput =
  existsSync(join(root, 'out', 'main', 'index.js')) &&
  existsSync(join(root, 'out', 'renderer', 'index.html'))

if (hasBuildOutput || requireSmokes) {
  steps.push(['smoke:bundle', ['npm', ['run', 'smoke:bundle']]])
  steps.push(['smoke:renderer', ['npm', ['run', 'smoke:renderer']]])
}

let failed = false
for (const [label, [cmd, args]] of steps) {
  console.log(`\n[verify:proof] ${label}`)
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  if (result.status !== 0) {
    failed = true
    console.error(`[verify:proof] ${label} failed with exit ${result.status ?? 'unknown'}`)
    break
  }
}

if (!hasBuildOutput && !requireSmokes) {
  console.log('\n[verify:proof] smoke checks skipped: build output not present')
}

if (skipTests) {
  console.log('\n[verify:proof] vitest skipped: --no-tests flag set (CI static gate mode)')
}

// SP-9 — always print the native-skip accounting so an ABI mismatch is
// visible at gate time instead of user runtime (the v0.9.2 lesson).
const nativeAccounting = printNativeSkipAccounting()

// Default: advisory (exit code unchanged, as SP-9 shipped it). Opt-in: fatal,
// for the CI job that exists to prove those suites actually ran.
if (!nativeAccounting.usable && requireNativeSqlite) {
  console.error(
    '[verify:proof] native-DB suites are dark and DUIN_REQUIRE_NATIVE_SQLITE is set — failing.'
  )
  failed = true
}

if (requireSmokes && !hasBuildOutput) {
  console.error('[verify:proof] build output missing but --require-smokes was requested')
  failed = true
}

process.exit(failed ? 1 : 0)
