// entity-card — PURE assembler of everything the brain already knows about ONE derived entity.
//
// A served graph node carries five fields ({id, kind, label, layer, group}); the meaning lives
// elsewhere and was never joined back: open-vocabulary triples in the construction cache (keyed by
// RAW label), the claim ledger (keyed by canonical id), alias groups + the operator overlay, typed
// relations and `mentions` provenance in the served graph, and the notes themselves. This module
// joins those by id, by normalized label (mergeKey) and by alias into one card. It reads nothing
// itself: the route hands it the data and a note reader, so it is testable with fixtures and
// costs no model call. The optional model pass (description / attributes) is entity-enrich.ts.

import { mergeKey } from './entity-key'
import type { ConstructedEntity, ConstructedTriple } from './types'
import type { Claim } from './claim-metabolism'
import type { AliasGroup } from './entity-resolver'
import { parseDateMs } from './claim-ledger'
import type { EntityEnrichment } from './entity-enrich'

/** One fact about the entity: a triple or a claim where the entity is the subject or the object. */
export interface CardFact {
  /** The other side of the fact, already resolved: the object when the entity is the subject, the
   *  subject when the entity is the object. */
  other: string
  relation: string
  /** 'subject' = "<entity> <relation> <other>", 'object' = "<other> <relation> <entity>". */
  direction: 'subject' | 'object'
  /** Vault-relative note the fact was lifted from (provenance); '' when unknown. */
  note: string
  /** Still holds now (a current claim / a triple whose validUntil has not passed). */
  current: boolean
  /** ISO date the fact became true when the prose stated it. */
  validFrom: string | null
  /** ISO date the fact stopped holding, when known. */
  validUntil: string | null
  /** Epoch ms the fact was observed (claims only); null for a bare triple. */
  observedAt: number | null
  source: 'claim' | 'triple'
}

export interface CardRelation {
  type: string
  /** 'out' = entity → other, 'in' = other → entity. */
  dir: 'out' | 'in'
  id: string
  label: string
  kind: string
}

export interface CardSource {
  /** Vault-relative note path (a graph note id). */
  path: string
  title: string
  /** The first sentence of the note that names the entity, or null when none was found. */
  snippet: string | null
  /** Note mtime (epoch ms) when the served graph carries it. */
  mtime: number | null
}

export interface MergeCandidate {
  id: string
  label: string
  kind: string
  /** Why it looks like the same thing. */
  reason: 'same-label' | 'alias' | 'same-slug'
}

export interface EntityCard {
  id: string
  label: string
  kind: string
  /** 'operator' when the label is an operator override (node-labels ledger). */
  labelBy: 'operator' | null
  /** The label the extractor produced, when the operator renamed the node. */
  extractedLabel: string | null
  aliases: string[]
  facts: CardFact[]
  factsTotal: number
  relations: CardRelation[]
  relationsTotal: number
  sources: CardSource[]
  sourcesTotal: number
  /** ISO timestamps: the earliest / latest evidence of the entity (claims, dated facts, note
   *  mtimes, entity_nodes row timestamps). Null when nothing dated exists. */
  firstSeen: string | null
  lastSeen: string | null
  mergeCandidates: MergeCandidate[]
  /** The model-written description + attributes, when one exists for the current material. */
  enrichment: EntityEnrichment | null
  /** sha1 of the material the enrichment must be grounded in; the route compares it with the
   *  stored enrichment's hash to decide whether the description is stale. */
  materialHash: string
}

export interface CardGraphNode {
  id: string
  label?: unknown
  kind?: unknown
  layer?: unknown
  labelBy?: unknown
  extractedLabel?: unknown
  mtime?: unknown
}

export interface CardGraphLink {
  source: unknown
  target: unknown
  type?: unknown
}

export interface CardInputs {
  id: string
  graph: { nodes: CardGraphNode[]; links: CardGraphLink[] }
  construction: { entities: ConstructedEntity[]; triples?: ConstructedTriple[] } | null
  claims: Claim[]
  aliasGroups: ReadonlyArray<AliasGroup>
  /** Operator alias overlay: normalized label → canonical id. */
  overlay: ReadonlyMap<string, string>
  /** Reads a vault-relative note's text; null when it does not exist. */
  readNote: (rel: string) => string | null
  /** entity_nodes row timestamps for the id, when the store has one. */
  timestamps?: { createdAt?: string | null; updatedAt?: string | null } | null
  enrichment?: EntityEnrichment | null
  now?: number
}

export const CARD_FACT_CAP = 80
export const CARD_RELATION_CAP = 120
export const CARD_SOURCE_CAP = 12

/** Structural edge types that say nothing about the entity itself. `mentions` is provenance
 *  (folded into sources), the rest are container/index plumbing. */
const STRUCTURAL_TYPES = new Set(['mentions', 'synonym', 'wiki', 'in', 'about', 'contains', 'indexes', 'anchors', 'folder', 'core'])

/** Relations that record provenance, not a fact about the entity (the sources section carries them). */
const PROVENANCE_RELATIONS = new Set(['mentions', 'about', 'mentioned_in', 'appears_in'])

const linkEnd = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? String((v as { id?: unknown }).id ?? '') : '')

/** Normalized form used for every label join in this module: mergeKey, falling back to a lowercase
 *  trim for labels mergeKey strips to nothing (pure punctuation / emoji). */
export function nameKey(label: string): string {
  const k = mergeKey(label)
  return k || label.trim().toLowerCase()
}

/** The slug part of a `<kind>:<slug>` id, as a readable name ("person:ada-lovelace" → "ada lovelace"). */
export function slugName(id: string): string {
  const i = id.indexOf(':')
  return (i >= 0 ? id.slice(i + 1) : id).replace(/-+/g, ' ').trim()
}

const isNoteLike = (id: string): boolean => /\.(md|markdown|txt|pdf|docx?)$/i.test(id) || id.includes('/')

/** The first sentence of `text` that names any of `names` (case-insensitive), trimmed to `max`
 *  characters. Sentence boundaries: . ! ? and their CJK forms 。！？, or a line break. Markdown
 *  heading marks, wikilink brackets and bold markers are stripped from the returned sentence. */
export function sentenceFor(text: string, names: string[], max = 220): string | null {
  if (!text) return null
  const needles = names.map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2)
  if (!needles.length) return null
  const body = text.replace(/^---[\s\S]*?\n---\s*/u, '')
  const parts = body.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u)
  for (const raw of parts) {
    const s = raw
      .replace(/^#{1,6}\s+/u, '')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_m, a: string, b?: string) => b ?? a)
      .replace(/\*\*/gu, '')
      .replace(/^[-*>]\s+/u, '')
      .trim()
    if (!s) continue
    const low = s.toLowerCase()
    if (!needles.some((n) => low.includes(n))) continue
    return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
  }
  return null
}

/** Every surface form that denotes this entity: served + extracted labels, the id's slug, alias
 *  groups whose canonical is this id (or whose canonical/aliases share the label), overlay labels
 *  mapped to this id. Order is stable; the served label comes first. */
export function namesOf(
  id: string,
  label: string,
  extractedLabel: string | null,
  aliasGroups: ReadonlyArray<AliasGroup>,
  overlay: ReadonlyMap<string, string>
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (s: string | null | undefined): void => {
    const v = (s ?? '').trim()
    if (!v) return
    const k = nameKey(v)
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push(v)
  }
  push(label)
  push(extractedLabel)
  push(slugName(id))
  const labelKey = nameKey(label)
  for (const g of aliasGroups) {
    const mine = g.canonicalId === id || nameKey(g.canonical) === labelKey || g.aliases.some((a) => nameKey(a) === labelKey)
    if (!mine) continue
    push(g.canonical)
    for (const a of g.aliases) push(a)
  }
  for (const [lab, canon] of overlay) if (canon === id) push(lab)
  return out
}

const factKey = (f: CardFact): string => `${f.direction}|${f.relation.trim().toLowerCase()}|${nameKey(f.other)}`

const DAY_MS = 86_400_000
const ID_RE = /^[a-z][a-z0-9_-]*:[^\s]+$/u

function factsOf(i: CardInputs, id: string, nameKeys: Set<string>, now: number, labelOf: (id: string) => string | null): CardFact[] {
  const byKey = new Map<string, CardFact>()
  // A fact's other side may be an entity id ("event:winter-campaign"): show its label, or its slug.
  const readable = (s: string): string => (ID_RE.test(s) ? (labelOf(s) ?? slugName(s)) : s)
  const provenance = (rel: string): boolean => PROVENANCE_RELATIONS.has(rel.trim().toLowerCase())
  const keep = (f: CardFact): void => {
    const k = factKey(f)
    const prev = byKey.get(k)
    // A claim beats a bare triple for the same fact (it carries observation time + verdict); a
    // current fact beats a retired duplicate.
    if (!prev || (f.source === 'claim' && prev.source === 'triple') || (f.current && !prev.current)) byKey.set(k, f)
  }
  const matches = (s: string): boolean => s === id || nameKeys.has(nameKey(s))
  for (const c of i.claims) {
    if (provenance(c.relation)) continue
    const asSubject = matches(c.subject)
    const asObject = !asSubject && matches(c.object)
    if (!asSubject && !asObject) continue
    const retired = c.validTo != null && c.validTo <= now
    // A claim's validFrom defaults to its observation time; only a prose-stated date (a day or
    // more away from the observation) is worth showing as "since".
    const stated = c.validFrom && (!c.observedAt || Math.abs(c.validFrom - c.observedAt) >= DAY_MS)
    keep({
      other: readable(asSubject ? c.object : c.subject),
      relation: c.relation,
      direction: asSubject ? 'subject' : 'object',
      note: c.notePath ?? '',
      current: c.verdict === 'current' && !c.supersededBy && !retired,
      validFrom: stated ? new Date(c.validFrom).toISOString().slice(0, 10) : null,
      validUntil: c.validTo != null ? new Date(c.validTo).toISOString().slice(0, 10) : null,
      observedAt: c.observedAt ?? null,
      source: 'claim'
    })
  }
  for (const tr of i.construction?.triples ?? []) {
    if (provenance(tr.relation)) continue
    const asSubject = matches(tr.subject)
    const asObject = !asSubject && matches(tr.object)
    if (!asSubject && !asObject) continue
    const untilMs = parseDateMs(tr.validUntil ?? null)
    keep({
      other: readable(asSubject ? tr.object : tr.subject),
      relation: tr.relation,
      direction: asSubject ? 'subject' : 'object',
      note: tr.note ?? '',
      current: untilMs == null || untilMs > now,
      validFrom: tr.validFrom ?? null,
      validUntil: tr.validUntil ?? null,
      observedAt: null,
      source: 'triple'
    })
  }
  const time = (f: CardFact): number => f.observedAt ?? parseDateMs(f.validFrom) ?? 0
  return [...byKey.values()].sort((a, b) => Number(b.current) - Number(a.current) || time(b) - time(a) || a.relation.localeCompare(b.relation))
}

export function assembleEntityCard(i: CardInputs): EntityCard | null {
  const now = i.now ?? Date.now()
  const node = i.graph.nodes.find((n) => n.id === i.id)
  const cons = i.construction?.entities.find((e) => e.id === i.id) ?? null
  if (!node && !cons) return null
  const label = String(node?.label ?? cons?.label ?? slugName(i.id))
  const kind = String(node?.kind ?? cons?.kind ?? i.id.split(':')[0] ?? 'entity')
  const labelBy = node?.labelBy === 'operator' ? 'operator' : null
  const extractedLabel = labelBy
    ? typeof node?.extractedLabel === 'string' && node.extractedLabel
      ? node.extractedLabel
      : cons?.label && cons.label !== label
        ? cons.label
        : null
    : null
  const names = namesOf(i.id, label, extractedLabel, i.aliasGroups, i.overlay)
  const nameKeys = new Set(names.map(nameKey))
  const aliases = names.filter((n) => nameKey(n) !== nameKey(label) && n !== slugName(i.id))

  const nodeById = new Map(i.graph.nodes.map((n) => [n.id, n]))
  const labelOf = (nid: string): string | null => {
    const n = nodeById.get(nid)
    return n && typeof n.label === 'string' ? n.label : (i.construction?.entities.find((e) => e.id === nid)?.label ?? null)
  }
  const facts = factsOf(i, i.id, nameKeys, now, labelOf)

  // Relations: typed graph edges touching the node; structural plumbing excluded.
  const relations: CardRelation[] = []
  const mentionNotes = new Set<string>()
  const seenRel = new Set<string>()
  for (const l of i.graph.links) {
    const s = linkEnd(l.source)
    const t = linkEnd(l.target)
    if (s !== i.id && t !== i.id) continue
    const type = typeof l.type === 'string' ? l.type : 'related'
    const other = s === i.id ? t : s
    if (type === 'mentions' || type === 'about') {
      if (isNoteLike(other)) mentionNotes.add(other)
      continue
    }
    if (STRUCTURAL_TYPES.has(type)) continue
    if (isNoteLike(other)) {
      mentionNotes.add(other)
      continue
    }
    const k = `${type}|${other}|${s === i.id ? 'out' : 'in'}`
    if (seenRel.has(k)) continue
    seenRel.add(k)
    const on = nodeById.get(other)
    relations.push({ type, dir: s === i.id ? 'out' : 'in', id: other, label: String(on?.label ?? slugName(other)), kind: String(on?.kind ?? other.split(':')[0] ?? 'entity') })
  }
  relations.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))

  // Sources: provenance notes from mentions, the construction entity's own note, the facts' notes.
  const sourcePaths = new Set<string>(mentionNotes)
  if (cons?.note) sourcePaths.add(cons.note)
  for (const f of facts) if (f.note) sourcePaths.add(f.note)
  const sources: CardSource[] = []
  for (const path of sourcePaths) {
    const n = nodeById.get(path)
    const mtime = typeof n?.mtime === 'number' ? n.mtime : null
    const title = path.replace(/\\/g, '/').split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') ?? path
    sources.push({ path, title, snippet: null, mtime })
  }
  sources.sort((a, b) => (b.mtime ?? -1) - (a.mtime ?? -1) || a.title.localeCompare(b.title))
  const shown = sources.slice(0, CARD_SOURCE_CAP)
  for (const s of shown) {
    const text = i.readNote(s.path)
    s.snippet = text ? sentenceFor(text, names) : null
  }

  // First / last seen across everything dated.
  const times: number[] = []
  for (const f of facts) {
    if (f.observedAt) times.push(f.observedAt)
    const vf = parseDateMs(f.validFrom)
    if (vf != null) times.push(vf)
  }
  for (const s of sources) if (s.mtime != null) times.push(s.mtime)
  const created = parseDateMs(i.timestamps?.createdAt ?? null)
  const updated = parseDateMs(i.timestamps?.updatedAt ?? null)
  if (created != null) times.push(created)
  if (updated != null) times.push(updated)
  const firstSeen = times.length ? new Date(Math.min(...times)).toISOString() : null
  const lastSeen = times.length ? new Date(Math.max(...times)).toISOString() : null

  // Merge candidates: other derived nodes that look like the same thing.
  const mySlug = nameKey(slugName(i.id))
  const mergeCandidates: MergeCandidate[] = []
  for (const n of i.graph.nodes) {
    if (n.id === i.id || n.layer !== 'construction' || typeof n.label !== 'string') continue
    const k = nameKey(n.label)
    let reason: MergeCandidate['reason'] | null = null
    if (k === nameKey(label)) reason = 'same-label'
    else if (nameKeys.has(k)) reason = 'alias'
    else if (nameKey(slugName(n.id)) === mySlug) reason = 'same-slug'
    if (!reason) continue
    mergeCandidates.push({ id: n.id, label: n.label, kind: String(n.kind ?? n.id.split(':')[0]), reason })
    if (mergeCandidates.length >= 5) break
  }

  const materialHash = materialHashOf({ label, kind, aliases, facts, relations, sources: shown })

  return {
    id: i.id,
    label,
    kind,
    labelBy,
    extractedLabel,
    aliases,
    facts: facts.slice(0, CARD_FACT_CAP),
    factsTotal: facts.length,
    relations: relations.slice(0, CARD_RELATION_CAP),
    relationsTotal: relations.length,
    sources: shown,
    sourcesTotal: sources.length,
    firstSeen,
    lastSeen,
    mergeCandidates,
    enrichment: i.enrichment ?? null,
    materialHash
  }
}

/** A stable digest of the material a description must be grounded in. Order-independent over
 *  facts / relations / sources so a re-sorted card does not read as changed material. */
export function materialHashOf(m: {
  label: string
  kind: string
  aliases: string[]
  facts: Pick<CardFact, 'other' | 'relation' | 'direction' | 'current'>[]
  relations: Pick<CardRelation, 'type' | 'dir' | 'label'>[]
  sources: Pick<CardSource, 'path' | 'snippet'>[]
}): string {
  const lines = [
    `label:${m.label}`,
    `kind:${m.kind}`,
    ...m.aliases.map((a) => `alias:${a}`),
    ...m.facts.map((f) => `fact:${f.direction}|${f.relation}|${f.other}|${f.current ? 1 : 0}`).sort(),
    ...m.relations.map((r) => `rel:${r.type}|${r.dir}|${r.label}`).sort(),
    ...m.sources.map((s) => `src:${s.path}|${s.snippet ?? ''}`).sort()
  ]
  return fnv1a(lines.join('\n'))
}

/** 32-bit FNV-1a as 8 hex chars: a cheap content fingerprint, not a security hash. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
