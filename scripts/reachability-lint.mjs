#!/usr/bin/env node
// REACHABILITY LINT — can the operator actually get to this code?
//
// Phase 0.2 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md. The 2026-07-30 audit found ~39
// renderer files (~12.5% of the component tree) fully implemented and never
// mounted, while the hand-typed coherence map reported SHADOW: 1. Three of them
// (MentalModelsPanel / MeetingsPanel / OutputsPanel) are lazy-imported, labelled,
// and `case`-handled in ToolsPanel — they pass every "is it wired?" check except
// the one that matters, so no reviewer reading a diff would catch them.
//
// This computes the answer instead of asserting it (constitution property 6):
// breadth-first from the renderer entry point over VALUE imports only.
//
// The `import type` distinction is the load-bearing part. `brain-shell.tsx`
// imports `View` from `app-sidebar.tsx` as a TYPE — erased at build — so the
// whole DUIN sidebar subtree looks reachable in the import graph and renders
// nowhere. Any checker that counts type edges misses the most convincing class of
// dead code in the codebase.
//
// Existing violations live in an allowlist, so this lands as a hard gate on NEW
// dead code without requiring the Phase 3 cleanup first. A stale allowlist entry
// is also an error: an allowlist that rots is the same disease one level up.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SRC = join(REPO, 'src')
const ALLOWLIST = join(REPO, 'scripts', 'reachability-allowlist.txt')

/** Trees to census. One graph, many roots — so a file shared across process
 *  boundaries (e.g. `electron/shared/*` imported by the renderer) is correctly
 *  reachable rather than reported dead under whichever tree it happens to sit in. */
const SCAN_DIRS = ['src', 'electron']

/**
 * Every entry point the application actually has, taken from
 * `electron.vite.config.ts`'s rollup `input` maps rather than invented here.
 *
 * That is the load-bearing choice: **if the bundler has no entry for a file and
 * nothing imports it, the file is not in the app.** The two workers are entries
 * precisely because they are `utilityProcess.fork`ed by path at runtime rather
 * than imported, so an import-graph walk cannot discover them — and the config
 * comments record that omitting them once silently disabled vector retrieval in
 * every packaged build.
 *
 * Keep in step with the config. A new rollup input belongs here the same day.
 */
const ROOTS = [
  'src/main.tsx', // renderer (src/index.html loads it)
  'electron/main.ts', // main process
  'electron/cli.ts', // headless CLI
  'electron/preload.ts', // preload bridge
  'electron/services/rag/embeddings/worker.ts', // utilityProcess, forked by path
  'electron/services/rag/ocr/paddle-worker.ts', // utilityProcess, forked by path
  // Out-of-process stdio MCP server with its own main(), launched by an external
  // client's mcpServers config via `npx tsx …`. Nothing in-repo spawns it, so the
  // import graph cannot reach it — but it is shipped, entered and tested.
  'electron/services/mcp-brain/brain-mcp-server.ts'
]

const CODE_RE = /\.(tsx|ts|jsx|js)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '__tests__'])
const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs']

/**
 * Not application code, so not a reachability finding.
 *
 * Tests, fixtures, eval harnesses and benchmarks are entered by vitest, never by
 * the app — reporting them as unreachable is true and useless. They stay eligible
 * as graph *targets* (a stray production import of a fixture would still resolve);
 * they are just not candidates for the census.
 */
const isNotAppCode = (p) =>
  /\.(test|spec)\.[tj]sx?$/.test(p) ||
  /\.d\.ts$/.test(p) ||
  /\.eval\.[tj]sx?$/.test(p) ||
  /\.fixture\.[tj]sx?$/.test(p) ||
  p.includes('__fixtures__/') ||
  p.includes('/_eval/') ||
  p.includes('/agent-bench/')

const isTest = isNotAppCode

/**
 * A module with no VALUE exports is erased at build time, so "unreachable at
 * runtime" is trivially true of it and says nothing. Type-only modules are
 * consumed through `import type` by design — the very edge this lint deliberately
 * does not follow — so flagging them would punish correct code.
 */
function isTypeOnlyModule(absPath) {
  let text
  try {
    text = readFileSync(absPath, 'utf8')
  } catch {
    return false
  }
  const src = text.replace(/\/\/[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  // Every `export` must be a type export for the module to be erasable. Checking
  // for the presence of `export const|function|…` is NOT enough: shadcn-style
  // components declare `const X = forwardRef(...)` and then `export { X }` at the
  // bottom, and treating those as type-only would silently HIDE dead components —
  // the opposite of this lint's purpose.
  const exports = src.match(/\bexport\s+(?:type\b|interface\b|\*|\{|default\b|[A-Za-z_$])/g)
  if (!exports) return true // no exports at all — nothing runtime to reach
  return exports.every((e) => /\btype\b|\binterface\b/.test(e))
}
const posix = (p) => p.split(sep).join('/')

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    // isNotAppCode is checked against the REPO-RELATIVE PATH, not the basename.
    // Passing `name` here meant every directory-based exclusion (__fixtures__,
    // _eval, agent-bench) silently never fired.
    else if (CODE_RE.test(name) && !isNotAppCode(posix(relative(REPO, full)))) acc.push(full)
  }
  return acc
}

/**
 * Import specifiers that survive to runtime.
 *
 * Deliberately included: dynamic `import()` (ToolsPanel lazy-registers panels
 * this way), bare side-effect imports, and `export … from` re-exports.
 * Deliberately excluded: statements beginning `import type` / `export type`.
 * A value import carrying inline `{ type X, Y }` still counts — Y is real.
 */
function valueImportsOf(text) {
  const out = new Set()
  // ORDER IS LOAD-BEARING: line comments first, block comments second.
  //
  // The other order is silently catastrophic here. This codebase writes paths in
  // prose comments — `memory/*.md`, `.brain/**/*.md` — and a `/*` inside a `//`
  // line opens a block comment for a naive stripper, which then runs to the next
  // `*/` anywhere below and eats every import in between. coherence-health-live.ts
  // extracted ZERO specifiers that way, which reported its dependencies
  // (coherence-map, coherence-lint) as dead while they are plainly live.
  const withoutComments = text
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
  const patterns = [
    /(?:^|\n)\s*import\s+(?!type\s)[^'";]*?from\s*['"]([^'"]+)['"]/g, // value import
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g, // side-effect
    /(?:^|\n)\s*export\s+(?!type\s)[^'";]*?from\s*['"]([^'"]+)['"]/g, // re-export
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic
    // A Web Worker spawned by URL is a real edge too: `new Worker(new URL('./x.worker.ts',
    // import.meta.url))` is Vite's worker idiom, and electron-vite bundles that file as
    // an entry of its own. The walk could not see it, and graph-layout.worker.ts hid
    // behind the type-only-module filter (every export it had was a type) until it grew
    // a value export and surfaced as dead — while being spawned on every brain-graph
    // mount. Relative specifiers only: that is the only form the bundler resolves.
    /\bnew\s+URL\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
    // `require()` is a real edge in main-process code and is used DELIBERATELY
    // there: several modules lazy-require heavy dependencies so the tick's static
    // import chain does not pull the embedder or the index store. Missing these
    // reported live modules (coherence-lint, coherence-map) as dead.
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(withoutComments)) !== null) out.add(m[1])
  }
  return [...out]
}

/** Resolve a specifier to a repo file, or null for packages / assets. */
function resolveSpecifier(rawSpec, fromFile) {
  // Vite query suffixes are real value imports: `./pdf-worker?worker` is how the
  // PDF worker is pulled in, and missing it reported a live file as dead. Strip
  // the query before resolving.
  const spec = rawSpec.replace(/[?#].*$/, '')
  let base
  if (spec.startsWith('@/')) base = join(SRC, spec.slice(2))
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec)
  else return null // bare package, or an alias we do not follow
  if (existsSync(base) && statSync(base).isFile() && CODE_RE.test(base)) return base
  for (const ext of EXTS) if (existsSync(base + ext)) return base + ext
  for (const ext of EXTS) {
    const idx = join(base, 'index' + ext)
    if (existsSync(idx)) return idx
  }
  return null
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return new Set()
  // Split on /\r?\n/ and strip with /#.*/ rather than /#.*$/. On a CRLF file the
  // anchored form silently matches nothing — JS `.` does not match \r, so it can
  // never reach the `$`, and every comment line survived as a bogus entry.
  return new Set(
    readFileSync(ALLOWLIST, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, '').trim())
      .filter(Boolean)
  )
}

// ── walk ──────────────────────────────────────────────────────────────────────
const reached = new Set()
const queue = ROOTS.map((r) => join(REPO, r)).filter((f) => {
  if (existsSync(f)) return true
  console.error(`reachability-lint: entry point missing: ${posix(relative(REPO, f))}`)
  return false
})
if (queue.length === 0) {
  console.error('reachability-lint: no entry points resolved — refusing to report everything dead')
  process.exit(2)
}
for (const f of queue) reached.add(f)

while (queue.length > 0) {
  const file = queue.shift()
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const spec of valueImportsOf(text)) {
    const target = resolveSpecifier(spec, file)
    if (!target || reached.has(target)) continue
    reached.add(target)
    queue.push(target)
  }
}

const all = SCAN_DIRS.flatMap((d) => walk(join(REPO, d)))
const unreached = all
  .filter((f) => !reached.has(f))
  .filter((f) => !isTypeOnlyModule(f))
  .map((f) => posix(relative(REPO, f)))
  .sort()

// ── report ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--print')) {
  for (const f of unreached) console.log(f)
  process.exit(0)
}

const allow = readAllowlist()
const isNew = unreached.filter((f) => !allow.has(f))
const stale = [...allow].filter((f) => !unreached.includes(f)).sort()

console.log(
  `reachability-lint: ${reached.size} reachable, ${unreached.length} unreachable ` +
    `(${allow.size} allowlisted) from ${ROOTS.join(', ')}`
)

let failed = false

if (isNew.length > 0) {
  failed = true
  console.error(
    `\nUNREACHABLE FROM THE ENTRY POINT (${isNew.length}) — built, and the operator cannot get to it:\n`
  )
  for (const f of isNew) console.error(`  ${f}`)
  console.error(
    '\nMount it, delete it, or — if it is deliberately parked — add it to\n' +
      '  scripts/reachability-allowlist.txt\n' +
      'with a one-line reason. Note that an `import type` edge does NOT make a\n' +
      'module reachable: it is erased at build time.\n'
  )
}

if (stale.length > 0) {
  failed = true
  console.error(
    `\nSTALE ALLOWLIST ENTRIES (${stale.length}) — these are reachable now, so the\n` +
      'allowlist is asserting something untrue. Delete these lines:\n'
  )
  for (const f of stale) console.error(`  ${f}`)
  console.error('')
}

process.exit(failed ? 1 : 0)
