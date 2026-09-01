#!/usr/bin/env node
// gen-harness-handbook.mjs — Slice-1 of the DUIN Harness Handbook (PLANNING/DUIN_HARNESS_HANDBOOK_PLAN.md).
//
// Reads the REAL Coherence Map (electron/services/brain/coherence-map.ts), parses the code anchors
// embedded in each entry's `evidence` prose into locators, VALIDATES every locator against the live
// repo, and renders a navigable L1/L2/L3 handbook to ARCHITECTURE/HARNESS_HANDBOOK.md.
//
// This is the "living document" proof: run it any time and the doc reflects the current map + current
// code. A locator whose file/symbol no longer exists is flagged STALE/BROKEN, never silently trusted.
// Zero build toolchain — plain Node. Non-deployed, additive.
//
//   node scripts/gen-harness-handbook.mjs            # write the handbook + print a validation summary
//   node scripts/gen-harness-handbook.mjs --check    # exit 1 if any locator is BROKEN (for CI / deploy hook)

import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAP_FILE = join(REPO, 'electron', 'services', 'brain', 'coherence-map.ts')
// The machine-extended handbook layer (scouted + adversarially-verified). Curated map stays authoritative.
const CATALOG_FILE = join(REPO, 'electron', 'services', 'brain', 'handbook-catalog.json')
const CODE_ROOTS = [join(REPO, 'electron'), join(REPO, 'src')]
const OUT_FILE = join(REPO, 'ARCHITECTURE', 'HARNESS_HANDBOOK.md') // flat single-file mirror (artifact/browse)
const HANDBOOK_DIR = join(REPO, 'ARCHITECTURE', 'handbook')        // the navigable tree (INDEX + per-domain + GAPS)
// The evolution ledger: a per-subsystem state snapshot + an append-only history of what changed each
// build. This is what makes the doc "updated with each evolution" — every deploy leaves a delta record.
const STATE_FILE = join(REPO, 'ARCHITECTURE', '.harness-handbook-state.json')
const HISTORY_FILE = join(REPO, 'ARCHITECTURE', '.harness-handbook-history.jsonl')
const CHECK = process.argv.includes('--check')

// Stable content hash of the load-bearing fields of an entry — changes iff the behavior/state/evidence
// meaningfully changed. Used to compute per-subsystem delta vs the previous build.
function hashEntry(e) {
  const s = `${e.wiringState}|${e.designIntent}|${e.evidence}|${e.gap || ''}|${e.byDesign ? 1 : 0}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// ──────────────── load the real COHERENCE_MAP (trusted local code) ────────────────
// The map is a pure data literal (object literals, string/array/bool values, no runtime imports),
// so we slice the array literal out of the source and evaluate it. Trusted, local, no eval of input.
function loadMap() {
  const src = readFileSync(MAP_FILE, 'utf8')
  const marker = 'export const COHERENCE_MAP'
  const eq = src.indexOf('=', src.indexOf(marker))
  const start = src.indexOf('[', eq)
  const end = src.lastIndexOf(']')
  if (start < 0 || end < 0 || end < start) throw new Error('could not locate COHERENCE_MAP array literal')
  const literal = src.slice(start, end + 1)
  // eslint-disable-next-line no-eval
  return eval(literal)
}

// ──────────── index every .ts/.tsx under the given roots by basename (skip node_modules) ────────────
function indexCode(roots) {
  const byBase = new Map() // basename -> [absPaths]
  const walk = (dir) => {
    let names; try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out') continue
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
        const arr = byBase.get(name) || []
        arr.push(p)
        byBase.set(name, arr)
      }
    }
  }
  for (const r of roots) walk(r)
  return byBase
}

// ──────────────── parse code anchors out of `evidence` prose ────────────────
// Matches  foo-bar.ts:1234 symbolName   /   foo.ts:1234   /   foo.ts symbolName   /   foo.ts
const ANCHOR = /([a-zA-Z0-9_.-]+\.tsx?)(?::(\d+))?(?:\s+([A-Za-z_$][\w$]*))?/g

function parseLocators(evidence) {
  const out = []
  const seen = new Set()
  let m
  while ((m = ANCHOR.exec(evidence)) !== null) {
    let [, file, line, symbol] = m
    // Only treat the trailing token as a code symbol if it is identifier-shaped (has an interior
    // uppercase, digit, `_`, or `$`). Plain lowercase words after `file.ts:line` are prose
    // ("folds", "scheduled") — keep the anchor as file+line, don't invent a symbol (avoids false STALE).
    if (symbol && !/[A-Z0-9_$]/.test(symbol)) symbol = undefined
    const key = `${file}:${line || ''}:${symbol || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file, line: line ? Number(line) : undefined, symbol })
  }
  return out
}

function validateLocator(loc, codeIndex) {
  const paths = codeIndex.get(loc.file)
  if (!paths || paths.length === 0) return { ...loc, status: 'broken', note: 'file not found in electron/' }
  // Prefer a path whose content best matches the symbol; default to the first.
  let chosen = paths[0]
  let content = ''
  if (loc.symbol) {
    let found = false
    for (const p of paths) {
      const c = readFileSync(p, 'utf8')
      if (c.includes(loc.symbol)) { chosen = p; content = c; found = true; break }
    }
    if (!found) {
      const where = paths.length > 1 ? `${paths.length} files named ${loc.file}` : rel(paths[0])
      return { ...loc, status: 'stale', path: rel(chosen), note: `symbol "${loc.symbol}" absent in ${where}` }
    }
  } else {
    content = readFileSync(chosen, 'utf8')
  }
  // If a line was given and we have a symbol, sanity-check the symbol is within ~40 lines of it.
  if (loc.line && loc.symbol) {
    const lines = content.split('\n')
    const lo = Math.max(0, loc.line - 40)
    const hi = Math.min(lines.length, loc.line + 40)
    const near = lines.slice(lo, hi).join('\n').includes(loc.symbol)
    if (!near) return { ...loc, status: 'stale', path: rel(chosen), note: `line ${loc.line} drifted (symbol elsewhere in file)` }
  }
  return { ...loc, status: 'valid', path: rel(chosen) }
}

const rel = (p) => p.replace(REPO + '\\', '').replace(REPO + '/', '').replace(/\\/g, '/')

// ──────────────── validate the DETECTOR citations ────────────────
//
// Locators were validated against the file index from the first version; detectors were rendered
// straight through with no check at all, so "**Guarded by:** `role-tool-access.test.ts`" shipped
// for a file that has never existed. A claim of coverage over an unguarded subsystem is worse
// than the honest "_(unguarded — no detector)_" the generator prints for an empty list.
//
// Three outcomes, deliberately, because a detector string is not one kind of thing:
//   valid   it names a file (or a glob) that resolves
//   broken  it names a file (or a glob) that does not
//   name    it names a DETECTOR CONCEPT and cites no file at all ("dead-export",
//           "write-no-read", "compounding-health:grounding"). These are implemented inside other
//           modules; demanding a same-named file would paint 60+ false ❌ into the handbook, and
//           a red badge that is usually wrong is a badge readers learn to skip.

/** A filename token inside a detector string, path-qualified or bare. */
const DETECTOR_FILE_TOKEN = /[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.tsx?\b/g

function globToRegExp(glob) {
  const body = glob
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
    .join('')
  return new RegExp(`(^|/)${body}$`)
}

export function resolveDetector(detector, codeIndex) {
  const raw = String(detector ?? '')
  const d = raw.trim()
  if (!d) return { detector: raw, status: 'name' }

  if (/[*?]/.test(d)) {
    const re = globToRegExp(d)
    const files = []
    for (const paths of codeIndex.values()) {
      for (const p of paths) if (re.test(rel(p))) files.push(rel(p))
    }
    return files.length
      ? { detector: raw, status: 'valid', files }
      : { detector: raw, status: 'broken', note: `glob matches no file under electron/ or src/` }
  }

  // A bare `foo.test` stem is a citation of foo.test.ts OR foo.test.tsx — the map writes
  // detectors both ways, and a RENDERER test is .tsx. Expanding to .ts alone made every
  // bare citation of a component test unresolvable by construction: `AgentsSettings.test`
  // was reported "no file named AgentsSettings.test.ts" while
  // src/components/settings/AgentsSettings.test.tsx sat right there, failing the curated
  // check — and therefore every push — for a file that exists and runs.
  const bareTest = /\.test$/.test(d)
  const tokens = d.match(DETECTOR_FILE_TOKEN) || (bareTest ? [`${d}.ts`, `${d}.tsx`] : [])
  if (tokens.length === 0) return { detector: raw, status: 'name' }

  // A bare stem is satisfied by EITHER extension, so it is missing only when neither
  // resolves. An explicit filename still has to match exactly.
  const missing = bareTest
    ? tokens.every((t) => !codeIndex.get(basename(t))?.length)
      ? [tokens[0]]
      : []
    : tokens.filter((t) => !codeIndex.get(basename(t))?.length)
  return missing.length
    ? { detector: raw, status: 'broken', note: `no file named ${missing.map((t) => basename(t)).join(', ')}` }
    : { detector: raw, status: 'valid', files: tokens.flatMap((t) => (codeIndex.get(basename(t)) || []).map(rel)) }
}

// ──────────────── render L1 / L2 / L3 ────────────────
const AXES = [
  ['wiring', 'WIRING', 'Is every loop connected end-to-end (producer→consumer→behavior)?'],
  ['intent', 'INTENT-FIDELITY', 'Does code match design intent (no silent drift)?'],
  ['guarded', 'GUARDEDNESS', 'Is each loop protected by a detector + a scheduled monitor?'],
  ['liveness', 'LIVENESS', 'Are the loops actually turning (fresh, not frozen/stuck)?'],
]
const STATE_BADGE = {
  LIVE: '🟢 LIVE', COLD: '🟡 COLD', WRITTEN_NEVER_READ: '🟠 WRITTEN·NEVER·READ',
  SHADOW: '🟠 SHADOW', COLD_BY_DESIGN: '⚪ COLD·BY·DESIGN', GAP: '🔴 GAP', DEAD: '🔴 DEAD',
}
const VAL_BADGE = { valid: '✅', stale: '⚠️ stale', broken: '❌ broken' }

// which domain doc an entry lives in: curated entries → _core (the authoritative benchmark seed).
const domainOf = (e) => (e._prov === 'curated' ? '_core' : (e._domain || '_unknown'))
const anchorId = (s) => s.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()

function statsLine(rows, stamp) {
  const total = rows.length
  const live = rows.filter((x) => x.e.wiringState === 'LIVE').length
  const byDesign = rows.filter((x) => x.e.byDesign).length
  const allLoc = rows.flatMap((x) => x.v.locators)
  const lv = allLoc.filter((l) => l.status === 'valid').length
  const ls = allLoc.filter((l) => l.status === 'stale').length
  const lb = allLoc.filter((l) => l.status === 'broken').length
  const nCur = rows.filter((x) => x.e._prov === 'curated').length
  const nVer = rows.filter((x) => x.e._verified).length
  return `_Built ${stamp} · ${total} subsystems (${nCur} 📗 curated + ${total - nCur} 🔭 scouted, ${nVer} verified) · ` +
    `${live} LIVE · ${byDesign} cold-by-design · locators ${lv}✅ / ${ls}⚠️ / ${lb}❌_`
}

// Shared L3 detail for one subsystem — used by the flat mirror AND every domain doc (one source of truth).
function entryBlock(e, v) {
  const L = []
  const prov = e._prov === 'curated' ? '📗 curated' : '🔭 scouted'
  const vb = e._verified === 'confirmed' ? ' · ✔ verified-gap' : e._verified === 'refuted' ? ' · ✔ verified-live' : e._verified === 'partial' ? ' · ◐ partial' : ''
  const dom = e._domain ? ` · _${e._domain}_` : ''
  L.push(`### ${STATE_BADGE[e.wiringState] || e.wiringState} · ${e.subsystem} <a id="${anchorId(e.subsystem)}"></a>`)
  L.push('')
  L.push(`*${prov}${vb}${dom}*`)
  L.push('')
  L.push(`**Does:** ${e.designIntent}`)
  L.push('')
  if (e.byDesign) { L.push(`> ⚪ **Cold by design** — a chosen stance, not a defect. ${e.byDesignWhy || ''}`); L.push('') }
  L.push(`**Evidence:** ${e.evidence}`)
  L.push('')
  if (v.locators.length) {
    L.push('**Code anchors** (validated vs live repo):')
    L.push('')
    for (const loc of v.locators) {
      const at = loc.line ? `:${loc.line}` : ''
      const sym = loc.symbol ? ` \`${loc.symbol}\`` : ''
      const where = loc.path ? ` — \`${loc.path}\`` : ''
      const note = loc.note ? ` (${loc.note})` : ''
      L.push(`- ${VAL_BADGE[loc.status]} \`${loc.file}${at}\`${sym}${where}${note}`)
    }
    L.push('')
  }
  // Detector citations get the SAME broken badge locators get. Rendering an unresolvable guard
  // test as if it were real coverage is the one failure mode this line can have.
  if (e.detectors && e.detectors.length) {
    const dets = v.detectors && v.detectors.length ? v.detectors : e.detectors.map((d) => ({ detector: d, status: 'name' }))
    L.push(`**Guarded by:** ${dets.map((r) =>
      r.status === 'broken' ? `${VAL_BADGE.broken} \`${r.detector}\` (${r.note})` : `\`${r.detector}\``
    ).join(', ')}`)
  } else L.push('**Guarded by:** _(unguarded — no detector)_')
  L.push('')
  if (e.gap) { L.push(`**Gap:** ${e.gap}${e.leverage ? ` · leverage: **${e.leverage}**` : ''}`); L.push('') }
  return L
}

// The FLAT single-file mirror — everything grouped by axis, one page (for the artifact / browse).
function render(rows, stamp, deltas) {
  const byAx = (ax) => rows.filter((x) => x.e.axis === ax)
  const L = []
  L.push('# DUIN Harness Handbook')
  L.push('')
  L.push('> **Auto-generated — do not hand-edit.** Flat single-page mirror of the navigable tree in')
  L.push('> `ARCHITECTURE/handbook/` (start at `INDEX.md`). Rendered from `coherence-map.ts` +')
  L.push('> `handbook-catalog.json` by `scripts/gen-harness-handbook.mjs`. See `PLANNING/DUIN_HARNESS_HANDBOOK_PLAN.md`.')
  L.push('')
  L.push(statsLine(rows, stamp))
  L.push('')
  if (deltas && !deltas.firstRun && (deltas.added.length || deltas.changed.length || deltas.removed.length)) {
    L.push('**Changed since last build:**')
    for (const s of deltas.added) L.push(`- 🆕 added — ${s}`)
    for (const s of deltas.changed) L.push(`- ✏️ changed — ${s}`)
    for (const s of deltas.removed) L.push(`- 🗑️ removed — ${s}`)
    L.push('')
  }
  L.push('## L1 · System overview')
  L.push('')
  L.push('| Axis | Subsystems | LIVE | Cold-by-design | Question |')
  L.push('|---|---|---|---|---|')
  for (const [key, label, q] of AXES) {
    const r = byAx(key)
    L.push(`| [${label}](#l2--${key}) | ${r.length} | ${r.filter((x) => x.e.wiringState === 'LIVE').length} | ${r.filter((x) => x.e.byDesign).length} | ${q} |`)
  }
  L.push('')
  for (const [key, label, q] of AXES) {
    L.push(`## L2 · ${label} <a id="l2--${key}"></a>`)
    L.push('')
    L.push(`_${q}_`)
    L.push('')
    for (const { e, v } of byAx(key)) L.push(...entryBlock(e, v))
  }
  return L.join('\n')
}

// INDEX.md — the L1 entry point: read this first, then follow to the one domain doc you need.
function renderIndex(rows, domains, stamp, deltas) {
  const byAx = (ax) => rows.filter((x) => x.e.axis === ax)
  const L = []
  L.push('# DUIN Harness Handbook — Index')
  L.push('')
  L.push('> **Auto-generated — do not hand-edit** (`scripts/gen-harness-handbook.mjs`). Behavior-centric map')
  L.push('> of DUIN, organized by *what it does*, each behavior anchored to code validated against the live')
  L.push('> repo. Read this overview, then open the one domain doc you need (progressive disclosure).')
  L.push('')
  L.push(statsLine(rows, stamp))
  L.push('')
  L.push(`▸ **[Open gaps / fix queue → GAPS.md](./GAPS.md)** · [flat single-page view](../HARNESS_HANDBOOK.md)`)
  L.push('')
  if (deltas && !deltas.firstRun && (deltas.added.length || deltas.changed.length || deltas.removed.length)) {
    L.push(`**Changed since last build:** ${deltas.added.length} added · ${deltas.changed.length} changed · ${deltas.removed.length} removed`)
    L.push('')
  }
  L.push('## By axis')
  L.push('')
  L.push('| Axis | Subsystems | LIVE | Cold-by-design | Question |')
  L.push('|---|---|---|---|---|')
  for (const [key, label, q] of AXES) {
    const r = byAx(key)
    L.push(`| ${label} | ${r.length} | ${r.filter((x) => x.e.wiringState === 'LIVE').length} | ${r.filter((x) => x.e.byDesign).length} | ${q} |`)
  }
  L.push('')
  L.push('## By domain')
  L.push('')
  L.push('| Domain | Subsystems | LIVE | Not-LIVE |')
  L.push('|---|---|---|---|')
  for (const d of domains) {
    const r = rows.filter((x) => domainOf(x.e) === d)
    const notLive = r.filter((x) => !['LIVE', 'COLD_BY_DESIGN'].includes(x.e.wiringState)).length
    L.push(`| [${d}](./${d}.md) | ${r.length} | ${r.filter((x) => x.e.wiringState === 'LIVE').length} | ${notLive || ''} |`)
  }
  L.push('')
  return L.join('\n')
}

// One per-domain doc — the L2/L3 detail for its subsystems.
function renderDomain(domain, rows, stamp) {
  const L = []
  L.push(`# DUIN Harness Handbook — ${domain}`)
  L.push('')
  L.push(`> Auto-generated. [◂ back to INDEX](./INDEX.md) · [open gaps](./GAPS.md)`)
  L.push('')
  L.push(statsLine(rows, stamp))
  L.push('')
  for (const { e, v } of rows) L.push(...entryBlock(e, v))
  return L.join('\n')
}

// GAPS.md — the actionable register: not-LIVE subsystems + verified gaps = the fix queue (§5.2).
function renderGaps(rows, stamp) {
  const LEV = { high: 0, med: 1, low: 2 }
  const gaps = rows
    .filter((x) => !['LIVE', 'COLD_BY_DESIGN'].includes(x.e.wiringState) || x.e._verified === 'confirmed')
    .sort((a, b) => (LEV[a.e.leverage] ?? 3) - (LEV[b.e.leverage] ?? 3))
  const L = []
  L.push('# DUIN Harness Handbook — Open gaps (fix queue)')
  L.push('')
  L.push('> Auto-generated. Not-LIVE subsystems + adversarially-verified gaps, leverage-ranked. This is the')
  L.push('> improvement backlog the coherence/RSI loop reads (PLANNING/DUIN_HARNESS_HANDBOOK_PLAN §5.2).')
  L.push('> [◂ back to INDEX](./INDEX.md)')
  L.push('')
  L.push(`_${stamp} · ${gaps.length} open items_`)
  L.push('')
  L.push('| Leverage | State | Subsystem | Domain | Verified |')
  L.push('|---|---|---|---|---|')
  for (const { e } of gaps) {
    L.push(`| ${e.leverage ? `**${e.leverage}**` : '—'} | ${STATE_BADGE[e.wiringState] || e.wiringState} | ${e.subsystem} | ${domainOf(e)} | ${e._verified || '—'} |`)
  }
  L.push('')
  for (const { e, v } of gaps) L.push(...entryBlock(e, v))
  return L.join('\n')
}

// ──────────────── main ────────────────
// Combined source: curated Coherence Map (authoritative benchmark seed) + the extended handbook
// catalog (scouted + verified). Curated wins on any name collision.
const norm0 = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function main() {
if (!existsSync(MAP_FILE)) {
  // Nothing to render or to check. The curated map is product code and ships; this guard is for
  // a tree that dropped it (or a partial checkout), where --check must be a PASS, not a crash.
  console.log(`handbook: ${rel(MAP_FILE)} not present — ${CHECK ? 'CHECK PASS (nothing to verify)' : 'nothing to render'}`)
  return
}
const curated = loadMap().map((e) => ({ ...e, _prov: 'curated' }))
let catalog = []
try {
  const cj = JSON.parse(readFileSync(CATALOG_FILE, 'utf8'))
  const curatedNames = new Set(curated.map((e) => norm0(e.subsystem)))
  catalog = (cj.entries || [])
    .filter((e) => !curatedNames.has(norm0(e.subsystem)))
    .map((e) => ({ ...e, detectors: e.detectors || [], _prov: 'scouted', _verified: e.verified || null, _domain: e.domain }))
} catch { /* catalog optional */ }
const map = [...curated, ...catalog]
const codeIndex = indexCode(CODE_ROOTS)
const validated = map.map((e) => {
  // Scouted entries carry cleaned STRUCTURED anchors — validate those. Curated entries only have
  // prose evidence — parse anchors out of it.
  const src = (Array.isArray(e.anchors) && e.anchors.length) ? e.anchors : parseLocators(e.evidence || '')
  const locators = src.map((loc) => validateLocator(loc, codeIndex))
  const detectors = (e.detectors || []).map((d) => resolveDetector(d, codeIndex))
  return { locators, detectors }
})

// ── compute delta vs the previous build (the evolution ledger) ──
let prevState = {}
try { prevState = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { /* first run */ }
const curState = {}
const added = [], changed = []
for (const e of map) {
  const h = hashEntry(e)
  curState[e.subsystem] = h
  if (!(e.subsystem in prevState)) added.push(e.subsystem)
  else if (prevState[e.subsystem] !== h) changed.push(e.subsystem)
}
const removed = Object.keys(prevState).filter((k) => !(k in curState))
const firstRun = Object.keys(prevState).length === 0
const deltas = { added, changed, removed, firstRun }

const stampSrc = statSync(MAP_FILE).mtime.toISOString().slice(0, 10)
const rows = map.map((e, i) => ({ e, v: validated[i] }))

// --check is a GATE, so it must not write. Until now it validated and then regenerated
// anyway, which meant running it in CI would dirty the tree it was checking — the reason
// it could never be wired into one.
const domains = [...new Set(rows.map((x) => domainOf(x.e)))].sort()
if (!CHECK) {
  // ARCHITECTURE/ is owner documentation and does not ship in the public tree; `docs:handbook`
  // is an explicit opt-in there, so create the output root rather than fail on its absence.
  mkdirSync(dirname(OUT_FILE), { recursive: true })
  // 1) flat single-file mirror (artifact / one-page browse)
  writeFileSync(OUT_FILE, render(rows, stampSrc, deltas))

  // 2) the navigable tree: INDEX + one doc per domain + GAPS
  mkdirSync(HANDBOOK_DIR, { recursive: true })
  writeFileSync(join(HANDBOOK_DIR, 'INDEX.md'), renderIndex(rows, domains, stampSrc, deltas))
  for (const d of domains) writeFileSync(join(HANDBOOK_DIR, `${d}.md`), renderDomain(d, rows.filter((x) => domainOf(x.e) === d), stampSrc))
  writeFileSync(join(HANDBOOK_DIR, 'GAPS.md'), renderGaps(rows, stampSrc))
}

const allLoc = validated.flatMap((v) => v.locators)
const n = (s) => allLoc.filter((l) => l.status === s).length
const live = map.filter((e) => e.wiringState === 'LIVE').length
const byDesign = map.filter((e) => e.byDesign).length

// ── append the evolution ledger + persist the new state snapshot ──
// Also skipped under --check, and for a sharper reason than tidiness: STATE_FILE is what the
// NEXT run diffs against. A check that persisted it would consume the delta, so the following
// real build would report "no change" for subsystems that had just changed.
if (!CHECK) {
  const ts = new Date().toISOString()
  appendFileSync(HISTORY_FILE, JSON.stringify({
    ts, subsystems: map.length, live, byDesign,
    anchors: { valid: n('valid'), stale: n('stale'), broken: n('broken') },
    added, changed, removed,
  }) + '\n')
  writeFileSync(STATE_FILE, JSON.stringify(curState))
}

console.log(`Harness Handbook written → ${rel(OUT_FILE)} (flat) + ${rel(HANDBOOK_DIR)}/ (INDEX + ${domains.length} domains + GAPS)`)
console.log(`  ${map.length} subsystems · ${allLoc.length} code anchors: ${n('valid')} valid, ${n('stale')} stale, ${n('broken')} broken`)
if (firstRun) console.log('  (first build — no prior state to diff)')
else if (added.length || changed.length || removed.length)
  console.log(`  delta since last build: ${added.length} added, ${changed.length} changed, ${removed.length} removed`)
else console.log('  delta since last build: none')
// Detector citations are counted and reported alongside locators. Until now they were rendered
// straight into the doc with no check, so a nonexistent guard test read as real coverage.
const allDet = validated.flatMap((v) => v.detectors)
const brokenDet = allDet.filter((d) => d.status === 'broken')
console.log(`  ${allDet.length} detector citations: ${allDet.filter((d) => d.status === 'valid').length} resolve, ` +
  `${brokenDet.length} broken, ${allDet.filter((d) => d.status === 'name').length} name a detector rather than a file`)
if (n('stale') || n('broken') || brokenDet.length) {
  console.log('  flagged:')
  map.forEach((e, i) => {
    for (const l of validated[i].locators) {
      if (l.status !== 'valid') console.log(`    ${VAL_BADGE[l.status]}  ${e.subsystem}  →  ${l.file}${l.line ? ':' + l.line : ''}${l.symbol ? ' ' + l.symbol : ''}  (${l.note})`)
    }
    for (const d of validated[i].detectors) {
      if (d.status === 'broken') console.log(`    ${VAL_BADGE.broken}  ${e.subsystem}  →  detector ${d.detector}  (${d.note})`)
    }
  })
}
// The deploy/CI gate fails only on a broken anchor in the CURATED map (the authoritative benchmark
// seed). Scouted-catalog anchors are advisory: flagged in the doc + summary, but never block a ship.
// Detector citations follow the SAME policy — a curated one that names no file is a gate failure,
// a scouted one is advisory. Same rule for both citation kinds, so there is only one policy to know.
const curatedBrokenLoc = map.reduce((acc, e, i) =>
  acc + (e._prov === 'curated' ? validated[i].locators.filter((l) => l.status === 'broken').length : 0), 0)
const curatedBrokenDet = map.reduce((acc, e, i) =>
  acc + (e._prov === 'curated' ? validated[i].detectors.filter((d) => d.status === 'broken').length : 0), 0)
const curatedBroken = curatedBrokenLoc + curatedBrokenDet
if (n('broken') || n('stale') || brokenDet.length) console.log(`  (note: ${n('broken')} broken / ${n('stale')} stale locators + ${brokenDet.length} broken detector(s) are in the scouted catalog unless flagged curated; curated-broken=${curatedBroken} = ${curatedBrokenLoc} locator + ${curatedBrokenDet} detector)`)
if (CHECK && curatedBroken) {
  console.error(`CHECK FAILED: ${curatedBrokenLoc} broken locator(s) + ${curatedBrokenDet} broken detector citation(s) in the curated map.`)
  process.exit(1)
}
}

// Run ONLY when invoked as a script. Without this guard, importing resolveDetector (which is how
// it gets tested) would REGENERATE the whole handbook tree as an import side effect.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (entry === import.meta.url) main()
