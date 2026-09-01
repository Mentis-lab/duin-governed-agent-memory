#!/usr/bin/env node
// BUNDLE-SAFETY LINT — can the shipped single-file main bundle actually resolve this?
//
// electron-vite emits the whole main process as ONE file, `out/main/index.js`, plus a few
// rollup chunks. Rollup builds that file from the STATIC import graph and from `import()`
// call sites. It does NOT follow a runtime `require('./sibling')`: the call is copied into
// the output verbatim, and because nothing ever imported the target, the target file was
// never emitted. At runtime the require throws MODULE_NOT_FOUND — and every one of these
// call sites in this repo has historically been wrapped in a best-effort try/catch, so the
// failure is SILENT and the feature simply never runs.
//
// This has now happened three times:
//   1. `require('./plugin-loader')` in skill-loader.ts / mcp-manager.ts / slash-commands.ts
//   2. `require('../event-log')` in act/external-action.ts (the act audit spine wrote nothing)
//   3. 2026-08-04 — eight sites at once. `runEntityAutoMergeTick` had NEVER run in any packaged
//      build (all 14 live alias groups lack its `source:'auto'` stamp); `runDecisionLoop` never
//      archived a lapsed decision window; and the confidential egress firewall ran with an EMPTY
//      denylist because `require('../settings-helper')` threw and the dir fell to null.
//
// Each time it was found by accident, months late. It is mechanically detectable, so detect it.
//
// THE RULE: inside electron/, a relative module specifier must be reached by a static `import`
// or a dynamic `import()`. A bare `require('./x')` / `require('../x')` is an error.
// Node BUILTINS (`node:fs`, `path`, …) and bare package names are fine — those are externalized
// and resolve normally at runtime.
//
// The fix is always one of:
//   - `await import('./x')`            in an async context (keeps the laziness, gets emitted)
//   - `void import('./x').then(…)`     when the caller is sync and the work is best-effort
//   - `import { x } from './x'`        when there is no cycle and no weight reason to defer

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = join(REPO, 'electron')

/** Files excluded from the census. Tests and evals run under vitest, which resolves a real
 *  filesystem and is never bundled, so a runtime require there cannot ship broken. */
const SKIP = /\.(test|eval|bench)\.ts$|[\\/]__fixtures__[\\/]/

/** A relative require that is genuinely fine: none today. Kept so a deliberate exception is
 *  recorded WITH its reason rather than silently tolerated by loosening the regex. */
const ALLOW = new Set([])

/**
 * Find `require('<relative>')` calls that are real CODE, not text.
 *
 * A regex alone cannot do this, and both naive attempts fail in opposite directions. Leaving
 * strings intact reports the JS programs that `agent-bench/tasks.ts` embeds as string literals
 * and writes to disk for a sandboxed agent to run — that `require('./add.js')` is a fixture's
 * source, resolved in the sandbox at its own path, not a call this module makes. Blanking string
 * literals instead destroys the specifier we are trying to read, since it IS a string literal.
 *
 * So: walk the source once, tracking whether we are in code, a comment, or a string, and only
 * consider a `require(` that begins in CODE. Comments matter too — several headers in electron/
 * quote the broken pattern deliberately, including the ones written the last time it was fixed.
 */
export function findRelativeRequires(src) {
  const hits = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '\n') { line++; i++; continue }
    // comments
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++ }
      i += 2
      continue
    }
    // strings — consume whole, honouring escapes; template literals may span lines
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '\n') line++
        i++
      }
      i++
      continue
    }
    // code: is a require( starting here?
    if (src.startsWith('require', i) && /[^A-Za-z0-9_$.]/.test(src[i - 1] ?? ' ')) {
      const m = /^require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/.exec(src.slice(i))
      if (m) { hits.push({ line, spec: m[2] }); i += m[0].length; continue }
    }
    i++
  }
  return hits
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === 'out') continue
      walk(p, out)
    } else if (name.endsWith('.ts') && !SKIP.test(p)) {
      out.push(p)
    }
  }
  return out
}

// Importable for `scripts/bundle-safety-lint.test.mjs` without running the census.
if (!process.argv[1] || !process.argv[1].endsWith('bundle-safety-lint.mjs')) {
  // imported as a module — export only
} else {
  runCli()
}

function runCli() {
const FILES = walk(ROOT)
const violations = []
for (const file of FILES) {
  const rel = relative(REPO, file).replace(/\\/g, '/')
  for (const hit of findRelativeRequires(readFileSync(file, 'utf-8'))) {
    if (ALLOW.has(`${rel}:${hit.spec}`)) continue
    violations.push({ file: rel, line: hit.line, spec: hit.spec })
  }
}

const BAR = '─'.repeat(74)
console.log('')
console.log('  bundle-safety lint — does the shipped main bundle resolve this?')
console.log(`  ${BAR}`)
if (violations.length === 0) {
  console.log(`  scanned ${FILES.length} files under electron/`)
  console.log(`  ${BAR}`)
  console.log('  RESULT: PASS — no runtime require() of a relative module.')
  console.log('')
  process.exit(0)
}
for (const v of violations) {
  console.log(`  ✗ ${v.file}:${v.line}  require('${v.spec}')`)
}
console.log(`  ${BAR}`)
console.log(`  RESULT: FAIL — ${violations.length} runtime require(s) of a relative module.`)
console.log('')
console.log('  Rollup does not follow require(). These specifiers are copied verbatim into')
console.log('  out/main/index.js, the target is never emitted, and the call throws')
console.log('  MODULE_NOT_FOUND at runtime — silently, inside the surrounding try/catch.')
console.log("  Use `await import('./x')`, `void import('./x').then(…)`, or a static import.")
console.log('')
process.exit(1)
}
