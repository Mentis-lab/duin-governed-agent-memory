#!/usr/bin/env node
// l10n-scan — find user-visible English that is NOT going through t().
//
// WHY THIS EXISTS. The dictionary (src/locales/{zh,ja}.json) was translated for the whole app,
// but only 12 of 213 components ever called t() — so ~92% of the visible strings rendered in
// English regardless of the operator's language, and 98 already-translated keys sat unused.
// Nothing detected that, because a missing translation degrades to English silently by design
// (i18n.ts) — the one failure mode that looks identical to working software.
//
// This is deliberately a LINT, not a codemod: it reports, and `--json` feeds a wrapper. Machine
// rewriting of JSX is how you localize a `className` or an internal id by accident.
//
// USAGE
//   node scripts/l10n-scan.mjs            # human report, worst files first
//   node scripts/l10n-scan.mjs --json     # machine-readable findings
//   node scripts/l10n-scan.mjs --check    # exit 1 if any file over budget (CI gate)
//   node scripts/l10n-scan.mjs --keys     # print the distinct strings needing translation

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** Attributes whose value the user reads. `title`/`aria-label` are read by a11y tooling too. */
const VISIBLE_PROPS = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'tooltip']

/** Files that legitimately hold English that is NOT UI copy. */
const SKIP_FILE = /(\.test\.tsx?$|\.d\.ts$|[\\/]locales[\\/]|i18n\.ts$)/

/** A candidate that is obviously not prose: identifiers, css, urls, single tokens, code. */
function looksTechnical(s) {
  return (
    /^[A-Z0-9_]+$/.test(s) ||            // CONSTANT_CASE
    /^[a-z]+([A-Z][a-z]+)+$/.test(s) ||  // camelCase identifier
    /^[\w.-]+\/[\w./-]+$/.test(s) ||     // path/or/url
    /^https?:/.test(s) ||
    /^[#.][\w-]+$/.test(s) ||            // css selector
    /^\d/.test(s) ||
    !/[a-z]/.test(s) ||                  // no lowercase = probably an acronym/label id
    s.trim().split(/\s+/).length === 1 && s.length < 3
  )
}

/** Quotes before this point on the line -> we are inside a string literal, not JSX. Keeps HTML
 *  held in template strings out of the report (the codemod skips them for the same reason). */
function insideStringLiteral(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const before = text.slice(lineStart, index)
  let single = 0
  let double = 0
  let backtick = 0
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '\\') { i++; continue }
    if (before[i] === "'") single++
    else if (before[i] === '"') double++
    else if (before[i] === '`') backtick++
  }
  return single % 2 === 1 || double % 2 === 1 || backtick % 2 === 1
}

export function scanSource(text) {
  const findings = []
  const add = (kind, value, index) => {
    const v = value.trim()
    if (!v || looksTechnical(v)) return
    findings.push({ kind, value: v, line: text.slice(0, index).split('\n').length })
  }

  // 1. JSX text nodes. SAME anchored rule the codemod uses - text between a tag-closing `>` and
  //    a CLOSING `</`, with no preceding `=`. The loose `>text<` form the first version used
  //    matched every TypeScript generic in the tree (`=> Promise<T>`), so the report was 142
  //    findings of which 138 were the word "Promise". A gate that cries wolf gets ignored, and
  //    this one has to survive being wired into CI.
  for (const m of text.matchAll(/(?<!=)>\s*([A-Z][A-Za-z0-9 ,.'’!?()/–—:-]{2,120}?)\s*<\//g)) {
    if (!insideStringLiteral(text, m.index)) add('text', m[1], m.index)
  }
  // 2. Visible string props:  placeholder="Some words"
  const propRe = new RegExp(`(?:${VISIBLE_PROPS.join('|')})=["']([A-Z][^"']{2,120})["']`, 'g')
  for (const m of text.matchAll(propRe)) {
    if (!insideStringLiteral(text, m.index)) add('prop', m[1], m.index)
  }

  return findings
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.tsx$/.test(e.name) && !SKIP_FILE.test(p)) acc.push(p)
  }
  return acc
}

const files = existsSync(SRC) ? walk(SRC) : []
const report = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const findings = scanSource(text)
  if (findings.length) {
    report.push({ file: relative(ROOT, f).split(sep).join('/'), count: findings.length, findings })
  }
}
report.sort((a, b) => b.count - a.count)
const total = report.reduce((s, r) => s + r.count, 0)

const args = process.argv.slice(2)
if (args.includes('--json')) {
  console.log(JSON.stringify({ total, files: report }, null, 2))
} else if (args.includes('--keys')) {
  const keys = [...new Set(report.flatMap((r) => r.findings.map((f) => f.value)))].sort()
  console.log(keys.join('\n'))
} else {
  console.log(`\n  l10n-scan — ${total} untranslated user-visible string(s) in ${report.length} file(s)\n`)
  for (const r of report.slice(0, 40)) console.log(`  ${String(r.count).padStart(4)}  ${r.file}`)
  if (report.length > 40) console.log(`  … and ${report.length - 40} more files`)
  console.log('')
}

if (args.includes('--check') && total > 0) {
  console.error(`  l10n-scan: ${total} untranslated string(s) — wrap them in t() or extend the skip rules.`)
  process.exit(1)
}
