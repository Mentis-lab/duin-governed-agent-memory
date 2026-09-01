#!/usr/bin/env node
// PRELOAD SURFACE LINT — is anything on the other side of this bridge?
//
// The gap this exists to close, found 2026-08-17: `electron/ipc/executive.ts` registered six
// handlers, `electron/preload.ts` exposed all six on `window.api.executive`, and NOTHING in
// `src/` ever called them. The pairing notice told the operator to approve in a screen that had
// never been built, so admitting an agent meant calling approvePairing() by hand. Three days,
// a full suite, ship-gate and two lint passes went by without anyone noticing, because nobody
// was asking the question.
//
// WHY THE EXISTING REACHABILITY LINT CANNOT SEE THIS. scripts/reachability-lint.mjs walks the
// IMPORT GRAPH from bundler entry points and answers "is this FILE ever imported". preload.ts
// is itself an entry point, so it is maximally reachable — and the dead surface is not a file,
// it is a property inside one. File-level reachability is structurally blind to it. This is
// symbol-level and crosses a process boundary, which is a different question, not a second
// opinion on the same one.
//
// WHAT IT CHECKS. Every top-level group on the `api` object exposed via contextBridge must be
// referenced somewhere under `src/`. Group granularity is deliberate: it is the level the real
// bug occurred at (an entire namespace with no consumer), and it is the level this can prove
// without a type checker. Leaf-level would need to resolve destructuring and aliasing
// (`const { approve } = window.api.executive.pairings`), and a checker that guesses at that
// produces false alarms — which is how a gate becomes something people skip.
//
// Existing violations live in an allowlist WITH REASONS, so this lands as a hard gate on new
// dead surface without blocking on cleanup. A stale allowlist entry is also an error: an
// allowlist that rots is the same disease one level up.
//
// Run: node scripts/preload-surface-lint.mjs   (or `npm run lint:preload-surface`)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PRELOAD = join(REPO, 'electron', 'preload.ts')
const SRC = join(REPO, 'src')
const ALLOWLIST = join(REPO, 'scripts', 'preload-surface-allowlist.txt')

/**
 * Strip line and block comments.
 *
 * Load-bearing, not cosmetic: this codebase explains itself at length, so an API name is
 * constantly DISCUSSED in prose near code that does not call it. Counting a comment as a
 * consumer would let the exact bug being hunted — a surface described but never wired — pass
 * because its own documentation mentions it.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/**
 * Top-level group names on the `const api = { ... }` literal.
 *
 * Brace-counted rather than regex-matched per line, so a nested `foo: {` at depth 2 is not
 * mistaken for a group. Returns [] if the literal cannot be found — the caller treats that as
 * a hard error rather than as "no groups", because silently passing when the parse fails is
 * how a lint becomes decorative.
 */
export function extractApiGroups(source) {
  const clean = stripComments(source)
  const start = clean.search(/\bconst\s+api\s*=\s*\{/)
  if (start === -1) return []
  let i = clean.indexOf('{', start)
  let depth = 0
  // Parens must be tracked separately from braces. A member like
  //   setUiZoom: (factor: number): void => webFrame.setZoomFactor(factor)
  // keeps brace depth at 1 all the way through its parameter list, so a brace-only scanner
  // reads `factor:` as a member of the exposed surface. The first run of this lint duly
  // reported `window.api.factor` as dead cross-boundary capability. It is an argument name.
  let paren = 0
  const groups = []
  for (; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '(' || ch === '[') {
      paren++
      continue
    }
    if (ch === ')' || ch === ']') {
      paren--
      continue
    }
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth === 1 && paren === 0) {
      // At depth 1 every `name:` is a member of the exposed surface.
      const rest = clean.slice(i)
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest)
      if (m) {
        groups.push(m[1])
        i += m[0].length - 1
      }
    }
  }
  return groups
}

function walk(dir, out = []) {
  let ents
  try {
    ents = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of ents) {
    if (e === 'node_modules' || e === '.git') continue
    const p = join(dir, e)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Groups referenced from renderer code. `api.<group>` covers `window.api.x`, a local
 *  `const api = window.api` alias, and ipc-client's re-exports — all of which are real
 *  consumers. Test files count: a binding exercised only by a test is still not operator-
 *  reachable, but that is the reachability lint's question, not this one. */
export function reachedGroups(groups, sources) {
  const hit = new Set()
  for (const src of sources) {
    const clean = stripComments(src)
    for (const g of groups) {
      if (hit.has(g)) continue
      // `api?.group` as well as `api.group`. The first version of this regex required a
      // literal dot and immediately reported `executive` dead — a binding wired minutes
      // earlier through `(window as ...).api?.executive`. A detector whose first output is a
      // false alarm about live code is worse than none: it teaches you to skim the list.
      if (new RegExp(`\\bapi\\s*\\??\\.\\s*${g}\\b`).test(clean)) hit.add(g)
    }
  }
  return hit
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return new Map()
  const out = new Map()
  for (const raw of readFileSync(ALLOWLIST, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(' ')
    if (idx === -1) {
      out.set(line, '')
      continue
    }
    out.set(line.slice(0, idx), line.slice(idx + 1).trim())
  }
  return out
}

function main() {
  const preloadSrc = readFileSync(PRELOAD, 'utf-8')
  const groups = extractApiGroups(preloadSrc)
  const findings = []

  if (groups.length === 0) {
    console.log('\n  preload-surface-lint')
    console.log('  ' + '─'.repeat(58))
    console.log('  RESULT: FAIL — could not parse the `const api = {` literal in electron/preload.ts.')
    console.log('  Refusing to report "no dead surface" from a failed parse.')
    process.exit(1)
  }

  const sources = walk(SRC).map((p) => readFileSync(p, 'utf-8'))
  const reached = reachedGroups(groups, sources)
  const allow = readAllowlist()

  const unreached = groups.filter((g) => !reached.has(g))
  for (const g of unreached) {
    if (allow.has(g)) {
      if (!allow.get(g)) findings.push(`${g} — allowlisted with NO reason. Say why, or wire it.`)
      continue
    }
    findings.push(
      `window.api.${g} is exposed across the process boundary and referenced nowhere in src/ — ` +
        `a capability the operator cannot reach. Wire a consumer, delete the binding, or add it ` +
        `to scripts/preload-surface-allowlist.txt with a reason.`
    )
  }

  // A stale allowlist is the same disease one level up.
  for (const [g] of allow) {
    if (!groups.includes(g)) findings.push(`allowlist names \`${g}\`, which is no longer exposed at all — drop the line.`)
    else if (reached.has(g)) findings.push(`allowlist names \`${g}\`, which now HAS a consumer — drop the line.`)
  }

  console.log('\n  preload-surface-lint — is anything on the other side of the bridge?')
  console.log('  ' + '─'.repeat(58))
  console.log(`  exposed groups   : ${groups.length}`)
  console.log(`  reached from src : ${reached.size}`)
  console.log(`  allowlisted      : ${allow.size}`)
  console.log('  ' + '─'.repeat(58))
  for (const f of findings) console.log(`  ✗ ${f}`)
  console.log('  ' + '─'.repeat(58))
  if (findings.length === 0) {
    // Say what is actually true. "Every group has a consumer" would be a lie while N sit in
    // the allowlist, and a gate that overstates its own result is the thing it exists to catch.
    const debts = unreached.length
    console.log(
      debts === 0
        ? '  RESULT: PASS — every exposed API group has a renderer consumer.'
        : `  RESULT: PASS — no NEW dead surface. ${debts} known debt(s) still allowlisted.`
    )
    process.exit(0)
  }
  console.log(`  RESULT: FAIL — ${findings.length} finding(s).`)
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main()
}
