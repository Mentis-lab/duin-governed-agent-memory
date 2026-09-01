#!/usr/bin/env node
// UNSUPPLIED-INPUT LINT — is anyone actually passing this?
//
// WHY THIS EXISTS
// ---------------
// `reachability-lint` bounds one half of DUIN's dominant defect class: a whole FILE that no entry
// point reaches. It cannot see the other half, and the other half is where the expensive bugs have
// been:
//
//   forkAgent's `deps.parentTools` was declared, documented, and set by NO production caller, so
//   `allowedTools: '*'` collapsed to `[]` and every `general` sub-agent ran with zero tools.
//   subagent-runner.ts was fully "reachable" the whole time (fixed 2026-08-17, ce828a4).
//
//   runWorkflow's `journalDir` / `resumeFromRunId` were accepted, implemented, and covered by a
//   resume test suite, and the two IPC handlers that are its only production callers passed
//   neither. Nothing was ever journaled, so nothing could ever be resumed from. workflow-runner.ts
//   was "reachable" the whole time too (fixed 2026-08-18, 290818c).
//
// Both are the same shape: an option a function ACCEPTS and READS that nothing on the production
// path ever SUPPLIES. Tests supply it — which is exactly why the suite stayed green and nobody
// noticed. A green test over a path production cannot reach is the failure this file exists to end.
//
// WHAT IT CHECKS
// --------------
// For every optional property of an exported options-object type (name ending in Input / Options /
// Opts / Config / Params / Args / Deps — the convention this codebase already follows), across
// production source only:
//
//     read somewhere in production  AND  supplied nowhere in production   ->  FINDING
//
// Read-but-never-supplied is the defect. A property neither read nor supplied is merely unused type
// surface and is NOT reported: that is a tidiness question, and reporting it would bury the signal.
//
// WHY NOT AN AST
// --------------
// A regex pass over declarations plus a text search for call sites is enough to answer "does any
// production line supply this?", with no build step, no compiler version to track, and no failure
// mode where a parse error silently drops a file from the census. The cost is precision, which the
// allowlist absorbs. `reachability-lint` made the same trade for the same reason.
//
// THE ALLOWLIST IS DEBT, NOT CONFIGURATION — same contract as reachability-allowlist.txt. Every
// line is either something to wire or something to delete. A stale entry (one now supplied) is an
// error too, so the list cannot quietly become permanent.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const REPO = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ALLOWLIST = join(REPO, 'scripts', 'unsupplied-input-allowlist.txt')
const SCAN_DIRS = ['electron', 'src']

// Narrow on purpose: these are the types whose whole job is to carry caller intent, so an
// unsupplied field is a dead capability rather than an unused struct member.
const OPTIONS_TYPE = /(Input|Options|Opts|Config|Params|Args|Deps)$/

const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /[\\/]__tests__[\\/]/.test(p)
const isSource = (p) => /\.[cm]?[jt]sx?$/.test(p) && !/\.d\.ts$/.test(p)

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === 'out' || e.startsWith('.')) continue
    const full = join(dir, e)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (isSource(full)) out.push(full)
  }
  return out
}

/**
 * Is this line a TYPE ANNOTATION rather than an object-literal supply?
 *
 * The first version of this lint had no such test, so `parentTools: string[] | null,` — a
 * PARAMETER in resolveAllowedTools's own signature — counted as somebody supplying the option,
 * and the lint reported a comfortable zero for the exact bug it was written to catch (ce828a4).
 * A checker that mis-parses is worse than no checker, because it is believed.
 */
export function isTypeAnnotation(line) {
  return /:\s*(?:readonly\s+)?(?:string|number|boolean|void|any|unknown|never|null|undefined|symbol|bigint|object|[A-Z][A-Za-z0-9_]*)\b[^=]*$/.test(line)
}

/**
 * Line endings are not signal. Every matcher below splits on '\n' and strips `// …` with
 * `.*$` — and `.` does not match '\r', so on a CRLF checkout a trailing comment was never
 * stripped and `// seeds: …` in prose counted as a supply. The allowlist had been calibrated on
 * the owner's mixed-ending worktree: a fresh Windows clone (all CRLF) reported 2 STALE rows and
 * an LF checkout (every ubuntu CI run) reported 2 NEW ones, for the same source. Normalise once,
 * at read time, so the verdict depends on the code and not on core.autocrlf.
 */
export function normalizeEol(text) {
  return text.replace(/\r\n?/g, '\n')
}

/** `export interface XInput {` / `export type XOpts = {` plus its brace-balanced body. */
export function declarations(text) {
  const out = []
  const re = /export\s+(?:interface|type)\s+([A-Za-z0-9_]+)\s*(?:=\s*)?\{/g
  let m
  while ((m = re.exec(text))) {
    if (!OPTIONS_TYPE.test(m[1])) continue
    let depth = 0
    let i = re.lastIndex - 1
    const start = re.lastIndex
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ type: m[1], body: text.slice(start, i) })
  }
  return out
}

/** Optional props declared at the body's top level (nested object literals are skipped). */
export function optionalProps(body) {
  const out = []
  let depth = 0
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '')
    if (depth === 0) {
      const m = line.match(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\?\s*:/)
      if (m) out.push(m[1])
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    if (depth < 0) depth = 0
  }
  return out
}

// The scan runs ONLY when invoked directly. The tests import the parsers above, and doing the
// whole 1,070-file census at import time cost `test:teeth` fifty seconds for a runner that is
// meant to take four -- and a module-level process.exit() would kill it mid-file besides. A gate
// that makes its own harness expensive is a gate someone eventually stops running.
if ((process.argv[1] || '').endsWith('unsupplied-input-lint.mjs')) {
  const prod = SCAN_DIRS.flatMap((d) => walk(join(REPO, d))).filter((f) => !isTest(f))
  const prodText = new Map(prod.map((f) => [f, normalizeEol(readFileSync(f, 'utf8'))]))

  const findings = []
  for (const file of prod) {
  const text = prodText.get(file)
  for (const decl of declarations(text)) {
    for (const prop of optionalProps(decl.body)) {
      // Supplied: `prop: <value>` in an object literal. The naive form of this also matched
      // TYPE ANNOTATIONS — `parentTools: string[] | null,` in resolveAllowedTools's own signature
      // read as a supply, which hid the very bug this lint was written for (ce828a4). So a line
      // whose right-hand side is a type rather than a value does not count.
      const supplyLine = new RegExp('(?:^|[{,(\\s])' + prop + '\\s*:')
      // Read: `.prop`, or destructured `{ …, prop, … }` / `{ prop = default }`.
      const readRe = new RegExp('\\.' + prop + '\\b|\\{[^}]*\\b' + prop + '\\s*[,=}]')
      let supplied = 0
      let read = 0
      for (const [f, t] of prodText) {
        const body = f === file ? t.replace(decl.body, '') : t
        for (const line of body.split('\n')) {
          const l = line.replace(/\/\/.*$/, '')
          if (!supplyLine.test(l)) continue
          if (isTypeAnnotation(l)) continue // a declaration, not a call site
          supplied++
          break
        }
        if (readRe.test(body)) read++
      }
      if (read > 0 && supplied === 0) {
        findings.push({ file: relative(REPO, file).replace(/\\/g, '/'), type: decl.type, prop })
      }
    }
  }
  }

  const allow = existsSync(ALLOWLIST)
  ? readFileSync(ALLOWLIST, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean)
  : []
  const key = (f) => `${f.file}::${f.type}.${f.prop}`
  const fresh = findings.filter((f) => !allow.includes(key(f)))
  const stale = allow.filter((a) => !findings.some((f) => key(f) === a))

  console.log('')
  console.log('  unsupplied-input-lint — does any production caller pass this?')
  console.log('  ' + '-'.repeat(58))
  console.log(`  production files        : ${prod.length}`)
  console.log(`  read-but-never-supplied : ${findings.length}`)
  console.log(`  allowlisted             : ${allow.length}`)
  console.log('  ' + '-'.repeat(58))
  for (const f of fresh) console.log(`  NEW   ${key(f)}`)
  for (const a of stale) console.log(`  STALE ${a}  (now supplied, or the declaration is gone — remove this line)`)
  console.log('  ' + '-'.repeat(58))
  if (fresh.length === 0 && stale.length === 0) {
    console.log(`  RESULT: PASS — no NEW unsupplied input. ${allow.length} known debt(s) still allowlisted.`)
    process.exit(0)
  }
  console.log('  RESULT: FAIL')
  if (fresh.length) console.log('  An option that is read but never supplied is a capability nothing can reach.')
  if (stale.length) console.log('  A stale allowlist entry is an error too: the list must not become permanent.')
  process.exit(1)
  }
