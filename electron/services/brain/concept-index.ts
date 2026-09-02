// concept-index — generate an OKF-shaped concept index for a memory bundle.
//
// Port of the legacy harness `concept_index.py`, adapted for DUIN. Scans a bundle
// directory (default: `<vault>/.brain/memory/`), and writes a machine-owned
// `_concept-index.md`: every concept grouped by frontmatter `type`, one line
// each, linked as `[[wikilinks]]` (target = the concept slug = OKF concept ID).
//
// This gives the agent a structured, type-grouped map to navigate memory
// (complementing flat semantic top-k) and is the source for the lightweight
// `<memory_index>`-style grounding block + the first-run graph skeleton.
//
// Deterministic (no model — a DETECTOR). Idempotent: overwrites each run.
// Borrows only OKF's two live-useful pillars (typed concepts + index); the
// export-only parts (index.md rename, wikilink→path, okf_version, log.md) stay
// in the deferred exporter. See PLANNING/DUIN_MEMORY_OKF_DESIGN.md.

import matter from 'gray-matter'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs'
import { join, relative, basename } from 'path'

export const CONCEPT_INDEX_FILE = '_concept-index.md'

// Never walk into these — the node_modules/.obsidian footgun (npm docs leaking
// into the concept graph) plus build output and VCS/state dirs.
const SKIP_DIRS = new Set([
  '.git',
  '.obsidian',
  '.trash',
  '.smart-env',
  'node_modules',
  'dist',
  'build',
  '.next',
  '_state'
])

// Don't index the indexes / hand-maintained nav.
const SKIP_FILES = new Set([CONCEPT_INDEX_FILE, 'index.md', 'MEMORY.md', 'README.md'])

const DESC_MAX = 140

export interface Concept {
  type: string
  id: string
  name: string
  desc: string
}

export interface ConceptIndexResult {
  concepts: number
  untyped: number
  indexPath: string
}

function walk(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walk(join(dir, entry.name), out)
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
}

// First real prose line — mirrors concept_index.py `_desc`: skip headings,
// quotes, tables, list markers, html, and fences.
function firstProseLine(body: string): string {
  for (const line of body.split('\n')) {
    const s = line.trim()
    if (s && !/^([#>|!<]|-|```)/.test(s)) return s.slice(0, DESC_MAX)
  }
  return ''
}

// Read a concept's `type` (OKF flat `type:` OR nested `metadata.type` from the
// memory-store format) + a one-line description.
function readConcept(bundleDir: string, full: string): Concept | null {
  let raw: string
  try {
    raw = readFileSync(full, 'utf-8')
  } catch {
    return null
  }
  let data: Record<string, unknown> = {}
  let content = raw
  try {
    const parsed = matter(raw)
    data = (parsed.data ?? {}) as Record<string, unknown>
    content = parsed.content
  } catch {
    // Malformed frontmatter — still index it as untyped.
  }
  const flatType = typeof data.type === 'string' ? data.type.trim() : ''
  const nested = data.metadata as { type?: unknown } | undefined
  const nestedType =
    nested && typeof nested === 'object' && typeof nested.type === 'string' ? nested.type.trim() : ''
  const type = flatType || nestedType || '(untyped)'
  const id = relative(bundleDir, full).replace(/\\/g, '/').replace(/\.md$/, '')
  const name = basename(full, '.md')
  const desc =
    typeof data.description === 'string' && data.description.trim()
      ? data.description.trim().slice(0, DESC_MAX)
      : firstProseLine(content)
  return { type, id, name, desc }
}

function render(bundleName: string, concepts: Concept[], today: string): string {
  const byType = new Map<string, Concept[]>()
  for (const c of concepts) {
    const list = byType.get(c.type) ?? []
    list.push(c)
    byType.set(c.type, list)
  }
  const lines: string[] = [
    '---',
    'type: concept-index',
    `bundle: ${bundleName}`,
    `generated: ${today}`,
    `concepts: ${concepts.length}`,
    'auto-generated: true',
    'generated-by: concept-index.ts',
    '---',
    '',
    `# ${bundleName} — Concept Index`,
    '',
    '> Auto-generated OKF-shaped concept map (one line per concept, grouped by `type`). ' +
      'Do NOT hand-edit — regenerated automatically.',
    ''
  ]
  // Typed groups first (alpha), untyped last.
  const typed = [...byType.keys()].filter((t) => t !== '(untyped)').sort()
  const ordered = byType.has('(untyped)') ? [...typed, '(untyped)'] : typed
  for (const t of ordered) {
    const items = (byType.get(t) ?? []).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    lines.push(`## ${t}  (${items.length})`)
    for (const c of items) {
      lines.push(`- [[${c.name}]]${c.desc ? ` — ${c.desc}` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Scan a bundle dir into its typed concept list (id/type/name/desc), skipping
 * the index files + the node_modules/.obsidian footgun dirs. The shared reader
 * behind both the index generator AND the first-run graph skeleton (graph-derive
 * / build-graph-native read `.brain/memory` through this). Returns [] when the
 * dir is absent, so callers can treat "no bundle" as "no concepts".
 */
export function scanConcepts(bundleDir: string): Concept[] {
  if (!existsSync(bundleDir)) return []
  const files: string[] = []
  walk(bundleDir, files)
  const concepts: Concept[] = []
  for (const full of files) {
    const c = readConcept(bundleDir, full)
    if (c) concepts.push(c)
  }
  return concepts
}

/**
 * Regenerate `<bundleDir>/_concept-index.md`. Returns null if the bundle dir
 * does not exist. `today` is passed in (never `new Date()` inside) so callers
 * control the stamp and the routine stays deterministic/testable.
 */
export function generateConceptIndex(
  bundleDir: string,
  bundleName: string,
  today: string
): ConceptIndexResult | null {
  if (!existsSync(bundleDir)) return null
  const concepts = scanConcepts(bundleDir)
  const untyped = concepts.filter((c) => c.type === '(untyped)').length
  const indexPath = join(bundleDir, CONCEPT_INDEX_FILE)
  const next = render(bundleName, concepts, today)
  // Idempotent (W3): the only volatile token is the `generated:` stamp. If nothing else changed, leave
  // the file — and its mtime — alone, so a daily reconcile does not churn the vault or its watchers.
  try {
    if (existsSync(indexPath)) {
      const strip = (t: string): string => t.replace(/^generated: .*$/m, 'generated: -')
      if (strip(readFileSync(indexPath, 'utf-8')) === strip(next)) return { concepts: concepts.length, untyped, indexPath }
    }
  } catch {
    /* fall through to the write */
  }
  writeFileSync(indexPath, next, 'utf-8')
  return { concepts: concepts.length, untyped, indexPath }
}
