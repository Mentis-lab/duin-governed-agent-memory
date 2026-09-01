#!/usr/bin/env node
// signal-lint — catches SIGNAL COLLAPSE: one representation standing for two different states.
//
// This is the defect class that cost the most in the 2026-07-30/31 campaign, and it is not one of
// the constitution's original seven properties. Every instance is locally correct, well-commented,
// and invisible at the site — it only surfaces when something downstream behaves oddly, and then
// diagnosis costs hours of manual measurement.
//
// Measured instances, all from one campaign:
//   - `{entities: 0, status: 'built'}` returned from FOUR unrelated branches, so a ten-day
//     construction stall was indistinguishable from a successful build of an empty vault.
//   - `kind: 'entity'` meaning BOTH "typed extraction failed" (a defect) and "this plane has no
//     kind to assign" (honest), so a 0% defect rate was read as 63% for two days.
//   - `Number(process.env.X) || FALLBACK` cannot express 0. construct.ts documented "0 disables the
//     sleep — used by tests", the suite set it to '0', and the fallback won on every run.
//
// RULE 1 is mechanical and is what this script enforces: `Number(process.env.X) || N` collapses
// "unset" and "explicitly zero". Use `envNum` (electron/shared/env-number.ts), which distinguishes
// them, or add an explicit ignore with a reason.
//
// Rules 2 and 3 (duplicate return literals, mutual mocking) are reported as ADVISORY counts only —
// they need type information to judge, and a false positive that fails CI is worse than a number a
// human reads. Property 5: this states its own limits.

import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const ROOTS = ['electron', 'src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.git', 'release'])

/** Opt out with a trailing `// signal-lint-ignore: <reason>` — a reason is REQUIRED. */
const IGNORE = /\/\/\s*signal-lint-ignore:\s*\S+/

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue
    const full = join(dir, e)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mjs)$/.test(e)) out.push(full)
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(join(REPO, r)))

// ── RULE 1 (enforced): env numeric read that cannot express zero ──────────────
const FALSY_ZERO = /Number\(\s*process\.env\.[A-Za-z_][A-Za-z0-9_]*\s*\)\s*\|\|/
const violations = []
// ── RULE 2 (advisory): the same object-literal return in >1 place in one file ──
const RETURN_LITERAL = /return\s+\{[^}\n]*\}/g
let duplicateReturnFiles = 0
// ── RULE 3 (advisory): modules mocked by a test other than their own ──────────
const VI_MOCK = /vi\.mock\(\s*['"](\.[^'"]+)['"]/g
let mockEdges = 0

for (const f of files) {
  let body
  try {
    body = readFileSync(f, 'utf-8')
  } catch {
    continue
  }
  const rel = relative(REPO, f).replace(/\\/g, '/')
  const isTest = /\.test\.tsx?$/.test(rel)

  body.split(/\r?\n/).forEach((line, i) => {
    // Skip comments and string literals: this file and env-number.ts both DESCRIBE the bad idiom,
    // and a lint that cannot tell code from prose about code is itself a signal collapse.
    const code = line.trim()
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
    if (code.startsWith("console.log(") || code.startsWith("'") || code.startsWith('`')) return
    if (FALSY_ZERO.test(line) && !IGNORE.test(line)) {
      violations.push({ rel, line: i + 1, text: code })
    }
  })

  if (!isTest) {
    const seen = new Map()
    for (const m of body.matchAll(RETURN_LITERAL)) {
      const key = m[0].replace(/\s+/g, ' ')
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    if ([...seen.values()].some((n) => n > 1)) duplicateReturnFiles++
  } else {
    mockEdges += [...body.matchAll(VI_MOCK)].length
  }
}

console.log('')
console.log('  signal-lint — one representation, one meaning')
console.log('  ' + '─'.repeat(58))
console.log(`  scanned ${files.length} files`)
console.log(`  advisory · files returning an identical object literal twice: ${duplicateReturnFiles}`)
console.log(`  advisory · vi.mock edges (mutual mocking hides seams): ${mockEdges}`)
console.log('  ' + '─'.repeat(58))

if (violations.length === 0) {
  console.log('  RESULT: PASS — no env read collapses "unset" with "zero".')
  console.log('')
  process.exit(0)
}

console.log(`  RESULT: FAIL — ${violations.length} env read(s) cannot express 0:`)
for (const v of violations) {
  console.log(`    ${v.rel}:${v.line}`)
  console.log(`      ${v.text}`)
}
console.log('')
console.log('  `Number(process.env.X) || N` returns N when X is "0", because 0 is falsy.')
console.log('  Use envNum(...) from electron/shared/env-number.ts, which distinguishes')
console.log('  "unset" from "explicitly zero". If 0 genuinely cannot be meaningful here,')
console.log('  append:  // signal-lint-ignore: <why 0 is impossible>')
console.log('')
process.exit(1)
