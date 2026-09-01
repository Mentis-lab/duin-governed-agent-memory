// extract-ui-strings — the translatable surface of the renderer, computed not typed.
//
// WHY A SCRIPT AND NOT A LIST. A hand-written inventory of UI copy is stale the day after
// it is written, and a localization effort measured against a stale inventory reports
// itself finished while whole panels are still English. This recomputes from source, so
// "what still needs translating" is always answerable.
//
// WHAT COUNTS AS UI TEXT. JSX text nodes, and string literals in the props that reach a
// human: title, placeholder, aria-label, alt, label. Deliberately NOT: className, ids,
// import paths, event names, or anything without a letter in it.
//
//   node scripts/extract-ui-strings.mjs            # summary
//   node scripts/extract-ui-strings.mjs --json     # full inventory as JSON
//   node scripts/extract-ui-strings.mjs --untranslated  # only what has no zh/ja yet

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const JSX_TEXT = />([^<>{}\n][^<>{}]{1,})</g
const TEXT_PROP = /\b(title|placeholder|aria-label|alt|label)=["']([^"']{2,})["']/g

/** Reject anything that is plainly not a sentence a user reads. */
function isUiText(s) {
  const t = s.trim()
  if (t.length < 2 || t.length > 200) return false
  if (!/[A-Za-z]/.test(t)) return false
  // Code that leaked through the JSX-text regex: declarations, calls, JSX fragments.
  if (/[{}]|=>|\bconst\b|\blet\b|\bfunction\b|\breturn\b|useState|=== |!== /.test(t)) return false
  if (/^(https?:|\/|\.\/|@\/|#|data:)/.test(t)) return false
  // Bare identifiers with no space are usually types, enum values or class names.
  if (!/\s/.test(t) && /^[A-Z][A-Za-z]+$/.test(t) && t.length > 6) return false
  return true
}

export function extract() {
  // execFileSync, not execSync: no shell, so the glob is an ARGUMENT rather than
  // something a shell expands or interprets.
  const files = execFileSync('git', ['ls-files', 'src/**/*.tsx'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.includes('.test.'))

  /** @type {Map<string, Set<string>>} */
  const strings = new Map()
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    const add = (raw) => {
      const t = raw.trim()
      if (!isUiText(t)) return
      if (!strings.has(t)) strings.set(t, new Set())
      strings.get(t).add(f)
    }
    for (const m of src.matchAll(JSX_TEXT)) add(m[1])
    for (const m of src.matchAll(TEXT_PROP)) add(m[2])
  }
  return strings
}

/** Which top-level surface a file belongs to — how the work gets staged. */
function surfaceOf(file) {
  const m = /^src\/(?:components|duin\/components)\/([^/]+)\//.exec(file)
  return m ? m[1] : 'other'
}

const strings = extract()
const localePath = join(root, 'src', 'locales', 'zh.json')
const existing = existsSync(localePath) ? JSON.parse(readFileSync(localePath, 'utf8')) : {}

const rows = [...strings.entries()].map(([text, files]) => ({
  text,
  files: [...files].sort(),
  surfaces: [...new Set([...files].map(surfaceOf))].sort(),
  translated: Object.prototype.hasOwnProperty.call(existing, text)
}))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2))
} else if (process.argv.includes('--untranslated')) {
  for (const r of rows.filter((r) => !r.translated)) console.log(r.text)
} else {
  const bySurface = new Map()
  for (const r of rows) {
    for (const s of r.surfaces) bySurface.set(s, (bySurface.get(s) ?? 0) + 1)
  }
  const done = rows.filter((r) => r.translated).length
  console.log(`[ui-strings] ${rows.length} distinct strings across ${new Set(rows.flatMap((r) => r.files)).size} files`)
  console.log(`[ui-strings] translated: ${done}/${rows.length}`)
  console.log('[ui-strings] by surface:')
  for (const [s, n] of [...bySurface.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${s}`)
  }
}
