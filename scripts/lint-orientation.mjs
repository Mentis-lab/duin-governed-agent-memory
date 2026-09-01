#!/usr/bin/env node
// lint-orientation — make CLAUDE.md's claims ABOUT ITSELF checkable.
//
// WHY THIS EXISTS
// ---------------
// CLAUDE.md is the first thing every session reads, so a false line in it is not
// a stale doc — it is a wrong belief installed in every session that starts. It
// drifted about itself for months because nothing checked it: it cites planning
// documents that were deleted, it says the app routes to "three providers" while
// the registry declares fourteen, and it explains that Electron is "pinned to
// ^35.7.5 because better-sqlite3 12.10 doesn't yet support V8 13" three majors
// after both of those stopped being true.
//
// None of that is a hard problem to detect. It was simply nobody's job.
//
// WHAT IT CHECKS (all hard failures — exit 1)
//   R1 citations  every PLANNING/*, memory/* and ARCHITECTURE/* path cited in
//                 CLAUDE.md exists on disk. No escape hatch: a doc that is gone
//                 should be de-cited, never annotated around.
//   R2 providers  CLAUDE.md must NAME the source of truth
//                 (electron/services/providers/registry.ts), and any bare
//                 "<N> providers" claim must equal the live PROVIDERS key count.
//   R3 versions   the electron / better-sqlite3 versions named in CLAUDE.md must
//                 agree with package.json.
//
// THE HISTORICAL ESCAPE, and why it is narrow
// -------------------------------------------
// CLAUDE.md is half orientation and half dated build log. "FC-0 … all 4 providers
// use OpenAI-compatible endpoints" was TRUE on 2026-06-08 and should not be
// falsified to satisfy a lint. So R2/R3 accept a line-level opt-out:
//
//     … all 4 providers use … <!-- orientation-lint: historical -->
//
// R1 has no opt-out, because a dead link is never correct in either tense.
// Measured on this tree, exactly ONE line needs the historical marker.
//
// RELATED: electron/services/providers/provider-parity.test.ts already scrapes
// the ProviderId union and asserts member-identity with PROVIDERS. Folding R2
// in there was the alternative placement; it is NOT taken here because that file
// belongs to another lane this wave. If it is ever folded in, delete R2 rather
// than leaving two owners for one invariant.
//
// Usage:  node scripts/lint-orientation.mjs [--root <dir>] [--doc <path>]
//         npm run lint:orientation

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_DEFAULT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REGISTRY_REL = 'electron/services/providers/registry.ts'
const HISTORICAL = /<!--\s*orientation-lint:\s*historical\s*-->/

/**
 * Count the keys of `export const PROVIDERS = { … }` by brace-matching the
 * object literal. Deliberately NOT a regex over the whole file: the ProviderId
 * union above it is full of quoted member names, and a loose regex would count
 * those (and the long prose comment that names 'anthropic' four times) instead.
 */
export function countProviders(source) {
  const decl = source.indexOf('export const PROVIDERS')
  if (decl === -1) return { ok: false, reason: 'no `export const PROVIDERS` declaration' }
  const open = source.indexOf('{', decl)
  if (open === -1) return { ok: false, reason: 'PROVIDERS declaration has no object literal' }

  const keys = new Set()
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const c = source[i]
    const two = source.slice(i, i + 2)
    if (two === '//') {
      const nl = source.indexOf('\n', i)
      if (nl === -1) break
      i = nl
      continue
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      // Skip the string body. A depth-1 quoted KEY is recovered by the colon
      // handler below, which walks backwards over the (already-closed) quotes.
      let j = i + 1
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '{') {
      depth++
      continue
    }
    if (c === '}') {
      depth--
      if (depth === 0) break
      continue
    }
    if (depth === 1 && c === ':') {
      const before = source.slice(Math.max(0, i - 80), i)
      const km = before.match(/(?:^|[{,\n])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*$/)
      if (km) keys.add(km[1] ?? km[2] ?? km[3])
    }
  }
  if (depth !== 0) return { ok: false, reason: 'PROVIDERS object literal is unbalanced' }
  return { ok: true, count: keys.size, keys: [...keys].sort() }
}

const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20
}
// Plural only, and never after a hyphen — `FC-3 provider schema normalizer` is a
// prompt id, not a count, and matching it made the check cry wolf on three lines.
const COUNT_CLAIM =
  /(?<![-\w])(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d{1,3})\s+providers\b/gi
// `Electron … ^35.7.5` / `better-sqlite3 12.10`. The word may sit a few words of
// prose away from its version ("Electron is pinned to ^35.7.5").
const VERSION_CLAIM = /\b(electron|better-sqlite3)\b([^\n]{0,40}?)(\^?\d+(?:\.\d+)+)/gi

function main() {
  const flag = (name, fallback) => {
    const i = process.argv.indexOf(name)
    if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
    return fallback
  }
  const ROOT = flag('--root', REPO_DEFAULT)
  const DOC = flag('--doc', join(ROOT, 'CLAUDE.md'))

  const findings = []
  const fail = (rule, lineNo, msg) => findings.push({ rule, lineNo, msg })

  if (!existsSync(DOC)) {
    // CLAUDE.md is the owner's session orientation and does not ship in the public tree. No
    // doc, no claims, nothing to check — a PASS, not a failure the contributor cannot fix.
    console.log(`[lint:orientation] PASS — ${DOC} not present (public tree; no orientation doc to verify)`)
    process.exit(0)
  }
  const lines = readFileSync(DOC, 'utf8').split(/\r?\n/)

  // ── R1 — cited orientation documents must exist ────────────────────────────
  // Scoped to the three doc trees a session is steered INTO. Source paths drift
  // for legitimate reasons (a file moves; a dated entry names its old home); a
  // planning document that is GONE is never a legitimate place to send the next
  // session.
  const CITATION = /\b(?:PLANNING|memory|ARCHITECTURE)\/[A-Za-z0-9._/-]+/g
  const citations = new Map() // path -> first line number
  lines.forEach((line, i) => {
    for (const m of line.matchAll(CITATION)) {
      const path = m[0].replace(/[.,;:)\]}]+$/, '') // strip trailing prose punctuation
      if (!citations.has(path)) citations.set(path, i + 1)
    }
  })
  for (const [path, lineNo] of citations) {
    if (!existsSync(join(ROOT, path)))
      fail('R1', lineNo, `cites \`${path}\`, which does not exist on disk`)
  }

  // ── R2 — provider count ────────────────────────────────────────────────────
  const registryPath = join(ROOT, REGISTRY_REL)
  let providerCount = null
  if (!existsSync(registryPath)) {
    fail('R2', 0, `${REGISTRY_REL} not found — the provider source of truth has moved; update this lint`)
  } else {
    const parsed = countProviders(readFileSync(registryPath, 'utf8'))
    if (!parsed.ok) fail('R2', 0, `cannot count PROVIDERS in ${REGISTRY_REL}: ${parsed.reason}`)
    else providerCount = parsed.count
  }

  // (a) The doc must NAME the source of truth. This is the durable half: a count
  //     rots, a pointer does not.
  if (!lines.some((l) => l.includes(REGISTRY_REL)))
    fail(
      'R2',
      0,
      `does not name the provider source of truth \`${REGISTRY_REL}\` anywhere — a reader has nowhere to check the count`
    )

  // (b) Any bare count must be right.
  if (providerCount !== null) {
    lines.forEach((line, i) => {
      if (HISTORICAL.test(line)) return
      for (const m of line.matchAll(COUNT_CLAIM)) {
        const raw = m[1].toLowerCase()
        const claimed = WORD_NUM[raw] === undefined ? Number(raw) : WORD_NUM[raw]
        if (claimed !== providerCount)
          fail(
            'R2',
            i + 1,
            `claims "${m[0]}" but ${REGISTRY_REL} declares ${providerCount}. ` +
              'Name the source of truth instead of a number, or mark the line ' +
              '`<!-- orientation-lint: historical -->` if it is a dated record.'
          )
      }
    })
  }

  // ── R3 — version claims ────────────────────────────────────────────────────
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = (name) => pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null
  const majorOf = (range) => {
    const m = String(range).match(/(\d+)/)
    return m ? Number(m[1]) : null
  }

  lines.forEach((line, i) => {
    if (HISTORICAL.test(line)) return
    for (const m of line.matchAll(VERSION_CLAIM)) {
      const name = m[1].toLowerCase()
      const claim = m[3]
      const range = declared(name)
      if (!range) continue // not a dependency here — nothing to compare against
      if (claim.startsWith('^')) {
        // A caret is the doc QUOTING the pin. Quoting it wrong IS the defect.
        if (claim !== range)
          fail('R3', i + 1, `quotes ${name} pin \`${claim}\` but package.json declares \`${range}\``)
      } else if (majorOf(claim) !== majorOf(range)) {
        // Bare versions are compared by MAJOR on purpose. Requiring the patch to
        // match would redden the tree on every routine bump, and a gate that goes
        // red for a non-reason is a gate somebody deletes — the exact failure mode
        // this lane exists to remove. Majors carry the meaning the doc's own
        // reasoning depends on (Electron 35 → 43, better-sqlite3 12 → 13 N-API).
        fail(
          'R3',
          i + 1,
          `names ${name} ${claim} (major ${majorOf(claim)}) but package.json declares \`${range}\` (major ${majorOf(range)})`
        )
      }
    }
  })

  // ── report ─────────────────────────────────────────────────────────────────
  const out = (s) => process.stdout.write(s + '\n')
  const rule = '  ' + '─'.repeat(60)
  out('\n  CLAUDE.md orientation lint')
  out(rule)
  out(`  doc        : ${DOC}`)
  out(`  citations  : ${citations.size} PLANNING/memory/ARCHITECTURE path(s) cited`)
  out(`  providers  : ${providerCount === null ? '(uncounted)' : providerCount} in ${REGISTRY_REL}`)
  out(
    `  versions   : electron ${declared('electron') ?? '(absent)'}, better-sqlite3 ${declared('better-sqlite3') ?? '(absent)'}`
  )
  out(rule)
  if (findings.length === 0) {
    out('  RESULT: PASS — CLAUDE.md tells the truth about itself.\n')
    process.exit(0)
  }
  for (const f of findings) out(`  ✗ ${f.rule} CLAUDE.md${f.lineNo ? ':' + f.lineNo : ''} — ${f.msg}`)
  out(rule)
  out(`  RESULT: FAIL — ${findings.length} orientation claim(s) are not true.\n`)
  process.exit(1)
}

// Only lint when RUN. Importing this file (the test imports countProviders) must
// not execute a gate that calls process.exit — that made the test file itself
// exit 1 before a single case ran.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
