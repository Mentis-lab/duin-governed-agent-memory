// cards-native — NET-NEW producers for the store-consolidation (Phase C1-T2).
// Re-sources three store kinds that had NO live TS producer (they lived only in the
// orphaned read-only duin.db): `card` (type:card vault notes), `project` (the DISTINCT
// project field across cards — NOT a folder walk), and the North-Star `goal` (the four
// cross-cycle Strategic Tracks in GOALS.md, distinct from the quarterly OKRs).
//
// Also produces `action` nodes (type:action vault notes) — the store's `action` kind is
// standalone T*.md action files, not inline checkbox tasks — because the card `references`
// edge points action→card and would dangle without them.
//
// Every producer is a PURE exported fn over the vault dir. Ids are BARE (store id space);
// kind-prefixing is a retrieval-surface concern handled elsewhere (canonical-id.ts).
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { ARENA_GENERIC } from './arena-folders'
import { CJK_CLASS } from './cjk-tokens'

const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.duin', '07 Templates'])

/** A store-graph node in the bare id space (GraphReadResult.nodes row). */
export interface StoreNode {
  id: string
  kind: string
  declared: number
  status?: string
  title?: string
  project?: string
  lane?: string
  decide_by?: string
  target?: string
  body?: string
  source_ref?: string
  extra?: unknown
  [k: string]: unknown
}
/** A store-graph edge (GraphReadResult.edges row). */
export interface StoreEdge {
  src: string
  dst: string
  type: string
}

/** Everything that is NOT ASCII-alphanumeric or CJK. The class carries the tokenizer's
 *  full CJK set (kanji + KANA), so a CJK-only title keeps its own id instead of
 *  stripping to '' and collapsing onto the shared 'output' fallback. */
const SLUG_STRIP_RE = new RegExp(`[^a-zA-Z0-9${CJK_CLASS}]+`, 'g')

function slug(s: string): string {
  const out = (s || '').replace(SLUG_STRIP_RE, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return out.slice(0, 48) || 'output'
}

export interface ParsedNote {
  rel: string
  stem: string
  fm: Record<string, string>
  fmBlock: string
  h1: string
}

/** Walk the vault once, yielding every .md note's parsed frontmatter (top-down).
 *  EXPORTED so a caller assembling several producers (graph-native.readGraphNative)
 *  can walk once and hand the same notes to each — one readGraphNative used to pay
 *  this full-vault sync walk five times (listCards, listCardProjects→listCards,
 *  listActions, cardEdges), all inside a single brain-graph rebuild on the main
 *  thread. Producers still default to walking themselves when called alone. */
export function walkNotes(vaultDir: string): ParsedNote[] {
  const out: ParsedNote[] = []
  const walk = (rel: string): void => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(join(vaultDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('_agui')) subdirs.push(e.name)
      } else if (e.name.endsWith('.md')) {
        const r = rel ? `${rel}/${e.name}` : e.name
        let txt: string
        try {
          txt = readFileSync(join(vaultDir, r), 'utf-8')
        } catch {
          continue
        }
        if (txt.charCodeAt(0) === 0xfeff) txt = txt.slice(1)
        txt = txt.replace(/\r\n?/g, '\n')
        const m = /^---\s*\n([\s\S]*?)\n---/.exec(txt)
        const fmBlock = m ? m[1] : ''
        const fm: Record<string, string> = {}
        for (const ln of fmBlock.split('\n')) {
          if (!ln.includes(':') || ln.trimStart().startsWith('#') || ln.trimStart().startsWith('-')) continue
          const i = ln.indexOf(':')
          const k = ln.slice(0, i).trim()
          let v = ln.slice(i + 1).trim()
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
          if (k) fm[k] = v
        }
        const body = m ? txt.slice(m[0].length) : txt
        const h1 = /^#\s+(.+)$/m.exec(body)
        out.push({ rel: r, stem: e.name.slice(0, -3), fm, fmBlock, h1: h1 ? h1[1].trim() : '' })
      }
    }
    for (const sd of subdirs) walk(rel ? `${rel}/${sd}` : sd)
  }
  walk('')
  return out
}

const typeOf = (fm: Record<string, string>): string => (fm.type || '').trim().replace(/^["']|["']$/g, '')

/** The card's project = its `project` | `source-project` | `arena` frontmatter field. */
function cardProject(fm: Record<string, string>): string {
  return (fm.project || fm['source-project'] || fm.arena || '').trim()
}

// ──────────────────── card producer ────────────────────

/** All `type: card` notes as store `card` nodes (declared=1). id = fm.id | filename stem. */
export function listCards(vaultDir: string | null, notes?: ParsedNote[]): StoreNode[] {
  if (!vaultDir) return []
  const out: StoreNode[] = []
  for (const n of notes ?? walkNotes(vaultDir)) {
    if (typeOf(n.fm) !== 'card') continue
    out.push({
      id: (n.fm.id || n.stem).trim(),
      kind: 'card',
      declared: 1,
      status: n.fm.status || '',
      title: n.fm.title || n.h1 || n.stem,
      project: cardProject(n.fm),
      body: '',
      source_ref: n.rel,
      extra: { type: 'card', source_note: n.fm['source-note'] || '' }
    })
  }
  return out
}

// ──────────────────── action producer (type:action notes) ────────────────────

// The store's `action` kind is the standalone active action files under `DUIN/Active/`
// (the frozen db scoped actions there; other type:action notes across the vault — 12-week
// plans, rules, meta — are NOT store actions). Kept narrow for store parity.
const ACTION_DIR = 'DUIN/Active/'
const isActionNote = (n: ParsedNote): boolean => typeOf(n.fm) === 'action' && n.rel.startsWith(ACTION_DIR)

/** Active `type: action` notes under DUIN/Active/ as store `action` nodes (declared=1).
 *  Standalone T*.md action files — the source of the `references` edge. */
export function listActions(vaultDir: string | null, notes?: ParsedNote[]): StoreNode[] {
  if (!vaultDir) return []
  const out: StoreNode[] = []
  for (const n of notes ?? walkNotes(vaultDir)) {
    if (!isActionNote(n)) continue
    out.push({
      id: (n.fm.id || n.stem).trim(),
      kind: 'action',
      declared: 1,
      status: n.fm.status || 'open',
      title: n.fm.title || n.h1 || n.stem,
      project: (n.fm.project || '').trim(),
      source_ref: n.rel,
      extra: {
        chain_anchor: n.fm['chain-anchor'] || '',
        okr_link: n.fm['okr-link'] || '',
        next_action: n.fm['next-action'] || ''
      }
    })
  }
  return out
}

// ──────────────────── project producer (distinct card project field) ────────────────────

/** Distinct non-empty card `project` field → store `project` nodes (declared=1).
 *  NOT a folder walk (the frozen db's folder-walk projects are the STALE reference). */
export function listCardProjects(vaultDir: string | null, notes?: ParsedNote[]): StoreNode[] {
  if (!vaultDir) return []
  const seen = new Set<string>()
  const out: StoreNode[] = []
  for (const c of listCards(vaultDir, notes)) {
    const p = String(c.project || '').trim()
    if (!p || seen.has(p)) continue
    // Reject pseudo-project field values that are really card categories / pillar
    // names (e.g. `meta`) — same canonical not-an-arena set the folder rule uses.
    if (ARENA_GENERIC.has(p.toLowerCase())) continue
    seen.add(p)
    out.push({ id: p, kind: 'project', declared: 1, title: p, project: p })
  }
  return out
}

// ──────────────────── North-Star goal producer (GOALS.md) ────────────────────

/** The four cross-cycle Strategic Tracks in GOALS.md → store `goal` nodes (declared=1).
 *  id = `goal:<slug(title)>`. Distinct from the quarterly OKRs (okrs-native). */
export function listNorthStarGoals(vaultDir: string | null): StoreNode[] {
  if (!vaultDir) return []
  let txt: string
  try {
    txt = readFileSync(join(vaultDir, 'GOALS.md'), 'utf-8').replace(/\r\n?/g, '\n')
  } catch {
    return []
  }
  // isolate the "## Strategic Tracks (cross-cycle)" section (up to the next ## heading)
  const start = /^##\s+Strategic Tracks\b.*$/m.exec(txt)
  if (!start) return []
  const rest = txt.slice(start.index + start[0].length)
  const nextH2 = /^##\s+/m.exec(rest)
  const section = nextH2 ? rest.slice(0, nextH2.index) : rest
  const out: StoreNode[] = []
  const seen = new Set<string>()
  for (const m of section.matchAll(/^###\s+(.+)$/gm)) {
    const title = m[1].replace(/^\d+\.\s*/, '').trim()
    if (!title) continue
    const id = `goal:${slug(title)}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, kind: 'goal', declared: 1, title, source_ref: 'GOALS.md' })
  }
  return out
}

// ──────────────────── edges owned by the card layer ────────────────────

/** project→card `contains` (one per card with a non-empty project) + action→card
 *  `references` (a card whose source-note/links wikilink an existing action id). */
export function cardEdges(vaultDir: string | null, sharedNotes?: ParsedNote[]): StoreEdge[] {
  if (!vaultDir) return []
  const notes = sharedNotes ?? walkNotes(vaultDir)
  const cards = notes.filter((n) => typeOf(n.fm) === 'card')
  const actionIds = new Set(notes.filter(isActionNote).map((n) => (n.fm.id || n.stem).trim()))
  const edges: StoreEdge[] = []
  for (const n of cards) {
    const cid = (n.fm.id || n.stem).trim()
    const proj = cardProject(n.fm)
    if (proj) edges.push({ src: proj, dst: cid, type: 'contains' })
    // action→card references: any [[wikilink]] in the frontmatter that resolves to an action id.
    const refs = new Set<string>()
    for (const wl of n.fmBlock.matchAll(/\[\[([^\]|#]+)/g)) {
      const target = wl[1].trim()
      if (actionIds.has(target)) refs.add(target)
    }
    for (const a of refs) edges.push({ src: a, dst: cid, type: 'references' })
  }
  return edges
}

// ──────────────────── goal→project `guides` (heuristic domain match) ────────────────────

// Domain keywords per North-Star goal slug → matched against project name + a few aliases.
// The frozen snapshot's `guides` edges were LLM-inferred; this reproduces them
// heuristically (best-effort — see the parity note in the build handoff).
// COLD-START A3 (2026-07-25): the built-in map ships EMPTY. These were the author's own
// North-Star goal slugs with their project keywords. The mapping now lives in per-vault state at
// `.duin/_state/goal-domains.json` — a vault that hasn't supplied one simply gets no `guides`
// edges, which is an absent edge rather than a wrong one.
const GOAL_DOMAIN: Record<string, string[]> = {}

/** Per-vault goal-slug → project-keyword map. Best-effort: missing or malformed file → the empty
 *  built-in, i.e. no `guides` edges. */
export function loadGoalDomains(vaultDir: string | null): Record<string, string[]> {
  if (!vaultDir) return GOAL_DOMAIN
  try {
    const raw = JSON.parse(
      readFileSync(join(vaultDir, '.duin', '_state', 'goal-domains.json'), 'utf-8')
    ) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return GOAL_DOMAIN
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch {
    return GOAL_DOMAIN
  }
}

/** goal→project `guides`: for each North-Star goal, the single best-matching project by
 *  domain-keyword overlap (emit only when a project matches). Pure over the two node lists +
 *  the injected domain map (see loadGoalDomains). */
export function goalGuideEdges(
  goals: StoreNode[],
  projects: StoreNode[],
  domains: Record<string, string[]> = GOAL_DOMAIN
): StoreEdge[] {
  const edges: StoreEdge[] = []
  for (const g of goals) {
    const gslug = String(g.id).replace(/^goal:/, '')
    const kws = domains[gslug] || []
    if (!kws.length) continue
    let best: string | null = null
    let bestScore = 0
    for (const p of projects) {
      const name = String(p.id).toLowerCase()
      const score = kws.filter((k) => name.includes(k.toLowerCase())).length
      if (score > bestScore) {
        bestScore = score
        best = String(p.id)
      }
    }
    if (best) edges.push({ src: String(g.id), dst: best, type: 'guides' })
  }
  return edges
}
