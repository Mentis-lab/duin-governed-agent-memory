// cold-start-seed — FILL the empty tank. The whole learning architecture (govern loop, recall,
// consolidation, the metabolisms) idles on a cold vault: ~15 facts, 0 provisional, so the machinery
// has nothing to work on. But the operator's confirmed operating principles ALREADY exist in the
// vault as judgment/value/structure cards (DUIN/Rules/[fsv]-*.md) + operator instincts
// (DUIN/Instincts/*.md) — human-authored, many explicitly validated. This seeds them into the
// operator-fact store so grounding warms from turn one and the govern dual-verifier gets real fuel.
// Scoped to operator-identity cards; domain cards (Knowledge/Meta/arenas) are excluded on purpose.
//
// Legitimacy + safety: HUMAN-VALIDATED cards (frontmatter status: validated) seed as PROVISIONAL
// (endorsed, still proving via the jury) — the human gate was already passed, so this isn't
// bypassing it. Everything else seeds as CANDIDATE (soft-ground, enters the funnel). Never seeds
// `promoted` — that stays earned. Deduped + junk-gated by seedFacts, so it's idempotent and every
// seeded fact is individually vetoable.

import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { seedFacts } from './operator-model'
import { brainRootPath, BRAIN_STATE_DIR } from './brain-root'
import { messageOf } from '../guarded'

export interface SeedCard {
  id: string
  name: string
  type: string
  validated: boolean
  statement: string
}

/** PURE: parse a Rules card → its identity + the one-line principle. Null if it lacks either. */
export function parseCard(text: string): SeedCard | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const front = fm?.[1] ?? ''
  const get = (k: string): string => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(front)
    return m ? m[1].trim() : ''
  }
  const name = get('name')
  const status = get('status')
  // The core belief = the FIRST bold-label line in the BODY (after the frontmatter). Cards lead
  // with it under varying labels — Statement / Principle / Rule (values), Procedure / Lens /
  // Definition (frameworks) — so match generically rather than enumerate.
  const body = fm ? text.slice(fm.index + fm[0].length) : text
  const sm = /\*\*([A-Za-z][\w -]*?):\*\*\s*(.+)/.exec(body)
  const statement = sm ? sm[2].trim().replace(/\s+/g, ' ') : ''
  if (!name || !statement) return null
  return { id: get('id') || name, name, type: get('type') || 'principle', validated: /validated/i.test(status), statement }
}

/** PURE: a card → the operator-fact to seed. Validated ⇒ provisional (govern fuel), else candidate. */
export function cardToFact(c: SeedCard): { fact: string; kind: string; status: 'candidate' | 'provisional' } {
  const raw = `${c.name} — ${c.statement}`
  const fact = raw.length > 280 ? raw.slice(0, 279) + '…' : raw
  return { fact, kind: c.type, status: c.validated ? 'provisional' : 'candidate' }
}

/** PURE: parse a C…/I… card (Instinct / insight) → identity + one-line thesis. The claim = the H1
 *  title; the thesis = the first BLUF blockquote line. Null if it lacks either. Operator-identity
 *  Instinct cards carry `status: live` (not validated), so they seed as candidates. */
export function parseInstinctCard(text: string): SeedCard | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const front = fm?.[1] ?? ''
  const get = (k: string): string => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(front)
    return m ? m[1].trim() : ''
  }
  const body = fm ? text.slice(fm.index + fm[0].length) : text
  const h1 = /^#\s+(.+)$/m.exec(body)
  const name = (h1 ? h1[1] : get('name')).trim()
  // The thesis = the first blockquote line after the title.
  const bq = /^>\s*(.+)$/m.exec(body)
  const statement = bq ? bq[1].trim().replace(/\s+/g, ' ') : ''
  if (!name || !statement) return null
  return { id: get('id') || name, name, type: get('type') || 'instinct', validated: /validated/i.test(get('status')), statement }
}

export interface SeedResult {
  read: number
  added: number
  provisional: number
  candidate: number
}

/** Read one DUIN card dir with a filename filter + parser. Null-safe; skips unreadable cards. */
function readCardDir(
  vaultDir: string,
  sub: string,
  filter: RegExp,
  parser: (t: string) => SeedCard | null
): SeedCard[] {
  const dir = join(vaultDir, 'DUIN', sub)
  if (!existsSync(dir)) return []
  const out: SeedCard[] = []
  for (const f of readdirSync(dir)) {
    if (!filter.test(f)) continue
    try {
      const c = parser(readFileSync(join(dir, f), 'utf-8'))
      if (c) out.push(c)
    } catch (e) { console.debug('[cold-start-seed] skip an unreadable card:', messageOf(e)) }
  }
  return out
}

/** Read the vault's operator-identity cards — Rules [fsv] frameworks/structure/values + Instincts —
 *  and seed them. Deliberately scoped to operator-identity: NOT Knowledge / Meta / arena domain
 *  cards, which are domain knowledge and would pollute the operator-model. Idempotent (dedup in
 *  seedFacts). */
export function seedFromVault(vaultDir: string | null): SeedResult {
  const empty: SeedResult = { read: 0, added: 0, provisional: 0, candidate: 0 }
  if (!vaultDir) return empty
  const cards: SeedCard[] = [
    ...readCardDir(vaultDir, 'Rules', /^[fsv]-.*\.md$/, parseCard),
    ...readCardDir(vaultDir, 'Instincts', /\.md$/, parseInstinctCard)
  ]
  if (cards.length === 0) return empty
  const r = seedFacts(cards.map(cardToFact))
  return { read: cards.length, added: r.added, provisional: r.provisional, candidate: r.added - r.provisional }
}

// ── PER-VAULT cold-start marker ───────────────────────────────────────────────
// Cold-start seeding used to be gated by a single GLOBAL settings flag
// (`coldStartSeeded`), which fired once per INSTALL. That's wrong the moment a
// second operator connects a second vault: the global flag is already set, so
// their vault never seeds. The gate must be PER-VAULT. We record it as a marker
// file inside the vault's own `.brain/state/` root (`cold-start.json`) — so it
// travels with the vault (sync it, move it, the marker moves too) and each vault
// is independently keyed. Best-effort + tolerant: a missing/broken marker simply
// reads as "not yet cold-started" (worst case: an idempotent re-seed, which
// seedFacts dedups anyway).

/** Name of the per-vault cold-start marker file under `.brain/state/`. */
export const COLD_START_MARKER_FILE = 'cold-start.json'

/** Resolve the per-vault cold-start marker path, or null when no vault dir. */
export function coldStartMarkerPath(vaultDir: string | null | undefined): string | null {
  const root = brainRootPath(vaultDir)
  if (!root) return null
  return join(root, BRAIN_STATE_DIR, COLD_START_MARKER_FILE)
}

/** Has THIS vault already been cold-started? (marker present under its .brain/state/) */
export function hasColdStarted(vaultDir: string | null | undefined): boolean {
  const p = coldStartMarkerPath(vaultDir)
  if (!p) return false
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

/** Record that THIS vault has been cold-started. Idempotent (overwrites its own
 *  marker). Returns true on a successful write, false when there's no vault dir
 *  or the write failed (caller treats a failure as "not marked" — safe: at worst
 *  a later boot re-seeds idempotently). `meta` is stamped for provenance only. */
export function markColdStarted(
  vaultDir: string | null | undefined,
  meta?: { added?: number; provisional?: number; read?: number }
): boolean {
  const p = coldStartMarkerPath(vaultDir)
  if (!p) return false
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(
      p,
      JSON.stringify({ seededAt: new Date().toISOString(), ...(meta ?? {}) }, null, 2),
      'utf-8'
    )
    return true
  } catch {
    return false
  }
}
