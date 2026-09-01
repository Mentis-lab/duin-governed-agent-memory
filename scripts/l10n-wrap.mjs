#!/usr/bin/env node
// l10n-wrap — wrap the user-visible English that l10n-scan finds in t().
//
// Safe BY CONSTRUCTION because of how i18n.ts is designed: the English source IS the key, and
// a missing translation returns the source unchanged. So wrapping a string can never change
// what an English user sees, and can never blank a screen — the worst case is a string that is
// wrapped but not yet translated, which renders exactly as it does today.
//
// Deliberately narrow. It rewrites only the two shapes l10n-scan reports:
//   >Some words</            ->  >{t('Some words')}</
//   placeholder="Some words" ->  placeholder={t('Some words')}
// It does NOT touch template literals, concatenations, or strings held in variables: those need
// a human to decide whether the RESULT or the PARTS are the sentence, and getting that wrong
// produces word-salad in exactly the languages nobody on the team reads back.
//
//   node scripts/l10n-wrap.mjs <file...>     # rewrite in place
//   node scripts/l10n-wrap.mjs --dry <file>  # report only

import { readFileSync, writeFileSync } from 'node:fs'

const VISIBLE_PROPS = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'tooltip']

function looksTechnical(s) {
  return (
    /^[A-Z0-9_]+$/.test(s) ||
    /^[a-z]+([A-Z][a-z]+)+$/.test(s) ||
    /^[\w.-]+\/[\w./-]+$/.test(s) ||
    /^https?:/.test(s) ||
    /^[#.][\w-]+$/.test(s) ||
    /^\d/.test(s) ||
    !/[a-z]/.test(s) ||
    (s.trim().split(/\s+/).length === 1 && s.length < 3)
  )
}

/** Escape for a single-quoted JS string literal. */
const lit = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** Is `index` inside a quoted string literal on its own line?
 *
 *  This repo stores HTML TEMPLATES in string literals — `content: '<div>New text</div>'` — and
 *  those match the JSX-text shape exactly. Rewriting one produces `'<div>{t('New text')}</div>'`,
 *  which both breaks the quoting and localizes a template rather than a rendered string. Counting
 *  unescaped quotes before the match on its line is enough to tell the two apart: real JSX text
 *  sits outside quotes, template content sits inside them. */
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

const IMPORT_LINE = "import { t } from '@/lib/i18n'"

/** Insert the import at the very TOP, stepping past a directive prologue if one is present.
 *
 *  Not "after the last import": a regex for an import STATEMENT matches the first LINE of a
 *  multi-line `import type {` block, and inserting after that line drops the new import INSIDE
 *  the braces. That produced 116 syntax errors across 157 files on the first full run. Plain
 *  string handling, no regex — the simplest form that cannot be corrupted wins. */
function withImport(text) {
  if (/from ['"]@\/lib\/i18n['"]/.test(text)) return text
  const lines = text.split('\n')
  let at = 0
  for (const line of lines) {
    const s = line.trim()
    if (s === '') { at++; continue }
    const isDirective = (s.startsWith('"use ') || s.startsWith("'use ")) && /['"];?$/.test(s)
    if (isDirective) { at++; continue }
    break
  }
  lines.splice(at, 0, IMPORT_LINE)
  return lines.join('\n')
}

export function wrapSource(text) {
  let out = text
  let changed = 0

  // 1. Visible string props. First, so the JSX pass never sees a rewritten `{t('…')}`.
  const propRe = new RegExp(`\\b(${VISIBLE_PROPS.join('|')})=(["'])([A-Z][^"']{2,120})\\2`, 'g')
  out = out.replace(propRe, (m, prop, _q, value, offset, whole) => {
    if (looksTechnical(value) || insideStringLiteral(whole, offset)) return m
    changed++
    return `${prop}={t(${lit(value)})}`
  })

  // 2. JSX text nodes — the narrowest shape that is unambiguously JSX: text between a
  //    tag-closing `>` and a CLOSING tag `</`. Two exclusions earn their keep:
  //      • a preceding `=` means that `>` was an arrow (`=> Promise<T>`), not a tag;
  //      • requiring `</` after the text rules out TypeScript generics (`Promise<{…}>`), which
  //        the looser `>text<` form matched happily and rewrote into syntax errors — caught on
  //        the very first trial file, which is why this pass is anchored rather than greedy.
  //    Text followed by a nested element (`<b>`) is skipped as a conservative miss: splitting a
  //    sentence around markup needs a human to keep it a sentence in CJK word order.
  out = out.replace(/(?<!=)>(\s*)([A-Z][A-Za-z0-9 ,.'’!?()/–—:-]{2,120}?)(\s*)<\//g, (m, pre, value, post, offset, whole) => {
    if (looksTechnical(value) || insideStringLiteral(whole, offset)) return m
    changed++
    return `>${pre}{t(${lit(value)})}${post}</`
  })

  if (changed > 0) out = withImport(out)
  return { out, changed }
}

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const files = args.filter((a) => !a.startsWith('--'))
let totalFiles = 0
let totalStrings = 0
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const { out, changed } = wrapSource(src)
  if (!changed) continue
  totalFiles++
  totalStrings += changed
  if (dry) console.log(`${f}: ${changed} string(s)`)
  else writeFileSync(f, out)
}
console.log(`${dry ? 'would wrap' : 'wrapped'} ${totalStrings} string(s) across ${totalFiles} file(s)`)
