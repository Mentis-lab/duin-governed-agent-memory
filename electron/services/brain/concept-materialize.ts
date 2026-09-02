// The SEAM — materialize a promoted (or, since W3, provisional) operator fact into a portable OKF concept file.
//
// When the govern loop promotes a fact (confirmFact), it has always only flipped a
// status field on operator-model.json — nothing reached portable memory. This module
// closes that gap: a promoted fact becomes a typed `.md` concept in `<vault>/.brain/memory/`
// (the lane `loadBrain` body-dumps into grounding), and a reverted/vetoed/superseded fact
// is retired out of that lane.
//
// Design constraints (see PLANNING/DUIN_SEAM_BUILD_SPEC.md):
//  - PURE + decoupled: functions take `memoryDir` explicitly; only a type-import from
//    operator-model (no runtime cycle). The govern core calls an injected hook.
//  - FLAG-GATED: `DUIN_SEAM_MATERIALIZE` default-ON (DUIN_SEAM_MATERIALIZE) since W3 2026-09-02;
//    `=0` is the kill switch (no writes, no reconcile).
//  - VAULT-SAFE: never clobber a hand-authored file (only files carrying our marker).
//  - NEVER THROW into the govern loop: the hook swallows all errors.
//  - IDEMPOTENT: slug derived from fact.id → re-promotion overwrites, never duplicates.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, cpSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { BRAIN_DIRNAME, BRAIN_MEMORY_DIR } from './brain-root'
import { FOUNDATION_BASENAMES, IDENTITY_FOUNDATION_ORDER } from './foundation-files'
import { generateConceptIndex } from './concept-index'
import { normName, slugifyLabel } from './entity-resolver'
import type { OperatorFact } from './operator-model'
import { loadSeamLedger, saveSeamLedger, contentHash, type SeamLedger } from './seam-ledger'

/** Exported so the grounding body-dump collector can identify (and skip) seam concepts. */
export const SEAM_GEN_MARKER = '<!-- generated: duin-seam · rewrite the claim line to restate this fact; delete the file to retract it -->'
const GEN_MARKER = SEAM_GEN_MARKER
/** Every marker the seam has ever written starts with this. Files written before W4 carry the old
 *  "machine-owned · do not hand-edit" text; they are still ours and are regenerated once. */
const GEN_MARKER_PREFIX = '<!-- generated: duin-seam'
const hasMarker = (md: string): boolean => md.includes(GEN_MARKER_PREFIX)
/** Retired concepts live OUTSIDE `memory/` (at `.brain/_retired/`) so neither the grounding
 *  collector nor the retrieval carve-out — both of which walk `memory/` — ever re-read them. */
const RETIRED_DIRNAME = '_retired'

/** Flag gate — ON by default since 2026-09-02 (W3): a public install gets its learned facts as vault
 *  files without setting anything. `DUIN_SEAM_MATERIALIZE=0` is the kill switch. */
export function seamEnabled(): boolean {
  return process.env.DUIN_SEAM_MATERIALIZE !== '0'
}

/** Flag gate for T2 entity projection — default OFF, independent of the seam flag. The entity
 *  CATALOG is assembled by the caller (the backfill route) behind this flag; the seam itself
 *  only consumes data, so unset ⇒ the `entities` param stays undefined ⇒ byte-identical T1. */
export function seamEntityEdgesEnabled(): boolean {
  return process.env.DUIN_SEAM_ENTITY_EDGES === '1'
}

/** Resolve `<notesDir>/.brain/memory` (the OKF concept lane loadBrain reads). */
export function conceptMemoryDir(notesDir: string | null | undefined): string | null {
  const dir = typeof notesDir === 'string' ? notesDir.trim() : ''
  if (!dir) return null
  return join(dir, BRAIN_DIRNAME, BRAIN_MEMORY_DIR)
}

/** Stable, id-derived filename so re-promotion overwrites the same file. */
function slugFor(fact: OperatorFact): string {
  const safe = String(fact.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)
  return `concept-${safe}.md`
}

function titleFor(fact: OperatorFact): string {
  const t = String(fact.fact || '').trim().replace(/\s+/g, ' ')
  const first = t.split(/[.;\n]/)[0].trim()
  return (first || t).slice(0, 80)
}

/** YAML-quote a scalar when it carries structural characters. */
function yamlStr(s: string): string {
  return /[:#[\]{},&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s
}

/** Moat-derived relation context for a concept. Everything here is DERIVED structure —
 *  regenerated wholesale on every materialize/reconcile, never earned content. */
export interface ConceptCtx {
  /** Fact ids this fact superseded (reverse of OperatorFact.supersededBy — needs the full list). */
  supersedes?: string[]
  /** Successor fact id — set on the retiring fact itself (tombstone pointer). */
  supersededBy?: string
  /** Canonical entities this belief is about (T2) — rendered as `about` links. */
  entities?: Array<{ slug: string; label: string }>
}

/** A known real-world entity from the entity plane (store live nodes + resolver whitelist).
 *  Assembled by the caller; the seam never reaches into SQLite or electron. */
export interface EntityCatalogEntry {
  /** Canonical human label — also the slug source (`entity-<slugifyLabel(label)>`). */
  label: string
  /** Stable id from the entity plane (`<kind>:<slug>` whitelist id or store node id). */
  entityId?: string
  /** person | org | project | … — maps onto the OKF `type:`; falls back to entityId's prefix. */
  kind?: string
  aliases?: string[]
  /** Selection bar (design note Q1): how many DISTINCT believing concepts an entity needs to
   *  earn a file + about-links. Callers set 2 for auto-mined planes (generic single-word
   *  labels collide on one-off mentions); curated/whitelist entries stay at the default 1. */
  minRefs?: number
}

const hasCJK = (s: string): boolean => /[⺀-鿿぀-ヿ豈-﫿]/.test(s)
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Does `surface` denote-match inside normalized `text`? CJK surfaces match by containment
 *  (no word boundaries in CJK); latin surfaces on word boundaries only. Short forms are
 *  guarded against noise: latin needs ≥3 chars unless the RAW surface is an ALL-CAPS acronym
 *  (≥2); CJK needs ≥2 chars. */
function surfaceHits(textNorm: string, surface: string): boolean {
  const key = normName(surface)
  if (!key) return false
  if (hasCJK(key)) {
    if (key.length < 2) return false
    return textNorm.includes(key)
  }
  const allCapsAcronym = /^[A-Z0-9]{2,}$/.test(String(surface).trim())
  if (key.length < 3 && !allCapsAcronym) return false
  // An apostrophe is NOT a boundary: "don't" must not surface-match the label "Don" (the cost
  // is possessive mentions like "Dana's" — junk contractions hurt more than lost possessives).
  return new RegExp(`(^|[^a-z0-9'])${escapeRe(key)}([^a-z0-9']|$)`).test(textNorm)
}

/** PURE + deterministic: which catalog entities does this claim text mention? One hit per
 *  canonical slug (label + aliases are surface forms of the SAME entity; first catalog entry
 *  wins a slug collision), sorted by slug. v1 is label/alias matching only — no embedder —
 *  per the T2 design note (Q3); the catalog is already alias-coalesced by the entity plane. */
export function matchEntities(text: string, catalog: EntityCatalogEntry[]): EntityCatalogEntry[] {
  const textNorm = normName(String(text ?? ''))
  if (!textNorm) return []
  const out = new Map<string, EntityCatalogEntry>()
  for (const e of catalog ?? []) {
    if (!e?.label) continue
    const slug = slugifyLabel(e.label)
    if (!slug || out.has(slug)) continue
    const surfaces = [e.label, ...(e.aliases ?? [])]
    if (surfaces.some((s) => surfaceHits(textNorm, String(s ?? '')))) out.set(slug, e)
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, e]) => e)
}

/** The entity-SHAPED kinds the seam projects (design note Q2). Everything else — topic,
 *  decision, event, fact-echo phrases — is not an entity page and is gated out. */
const SEAM_ENTITY_KINDS = new Set(['person', 'org', 'organization', 'company', 'project', 'product'])

/** Whitelist group shape consumed by the assembler — structurally matches entity-resolver's
 *  AliasGroup (type-only mirror keeps this module free of a value import direction change). */
export interface CatalogAliasGroup {
  canonicalId: string
  canonical: string
  aliases: string[]
  /** absent = hand-authored (curator trust); 'auto' | 'auto-kind' = machine-appended. */
  source?: 'auto' | 'auto-kind' | 'human'
}

/** PURE (T2.5): whitelist groups + store nodes → curated entity catalog.
 *
 *  Every junk entity file the first live backfill produced traced to ONE flaw: all whitelist
 *  groups entered at curator trust. Three rules fix it:
 *   1. KIND GATE on both populations — a group's kind is its canonicalId prefix; only
 *      entity-shaped kinds (person/org/project/…) project.
 *   2. TRUST TIER — hand-authored groups (no `source`, or 'human') keep minRefs 1; machine
 *      groups ('auto'/'auto-kind') and store rows carry minRefs 2, the same bar.
 *   3. FOLD — a store row whose label is a known surface form of a kept group merges into that
 *      group's entry (novel label becomes an alias) instead of minting a duplicate entity. */
export function assembleEntityCatalog(
  aliasGroups: ReadonlyArray<CatalogAliasGroup>,
  storeNodes: ReadonlyArray<{ id: string; label: string; kind: string; source?: string }>
): EntityCatalogEntry[] {
  const entries = new Map<string, EntityCatalogEntry>() // canonicalId/store-id → entry
  const surfaceToEntry = new Map<string, string>() // normName(surface) → entry key, first wins
  for (const g of aliasGroups ?? []) {
    const kind = String(g?.canonicalId ?? '').split(':')[0].toLowerCase()
    if (!g?.canonical || !SEAM_ENTITY_KINDS.has(kind)) continue
    if (entries.has(g.canonicalId)) continue
    const trusted = !g.source || g.source === 'human'
    const aliases = [...new Set((g.aliases ?? []).filter((a) => a && a !== g.canonical))]
    entries.set(g.canonicalId, {
      label: g.canonical,
      entityId: g.canonicalId,
      kind,
      aliases,
      ...(trusted ? {} : { minRefs: 2 })
    })
    for (const s of [g.canonical, ...aliases]) {
      const key = normName(s)
      if (key && !surfaceToEntry.has(key)) surfaceToEntry.set(key, g.canonicalId)
    }
  }
  for (const n of storeNodes ?? []) {
    const kind = String(n?.kind ?? '').toLowerCase()
    if (!n?.label || !SEAM_ENTITY_KINDS.has(kind)) continue
    const key = normName(n.label)
    if (!key) continue
    const owner = surfaceToEntry.get(key)
    if (owner) {
      // FOLD: this store row is a known surface form of a whitelist group — enrich, don't dup.
      const e = entries.get(owner)
      if (e && normName(e.label) !== key && !(e.aliases ?? []).some((a) => normName(a) === key)) {
        e.aliases = [...(e.aliases ?? []), n.label]
      }
      continue
    }
    if (entries.has(n.id)) continue
    entries.set(n.id, { label: n.label, entityId: n.id, kind, minRefs: 2 })
    surfaceToEntry.set(key, n.id)
  }
  return [...entries.values()].sort((a, b) => {
    const ka = slugifyLabel(a.label)
    const kb = slugifyLabel(b.label)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

/** Catalog kind → OKF `type:`. Unknown kinds project as the generic `entity`. */
function entityTypeFor(e: EntityCatalogEntry): string {
  const k = String(e.kind ?? e.entityId?.split(':')[0] ?? '').toLowerCase()
  if (k === 'person' || k === 'people') return 'person'
  if (k === 'org' || k === 'organization' || k === 'company') return 'org'
  if (k === 'project' || k === 'product') return 'project'
  return 'entity'
}

/** PURE: catalog entity + its believing concepts → entity concept markdown. `generated-by:
 *  duin-seam` is the body-dump exclusion key (brain-root gatherFrom) — entity files are NOT
 *  `type: learned`, so without it they would enter always-on grounding and eat the char cap. */
export function entityConceptFor(
  e: EntityCatalogEntry,
  referencing: Array<{ slug: string; name: string }>,
  today?: string
): { slug: string; md: string } {
  const stem = `entity-${slugifyLabel(e.label)}`
  const created = today || new Date().toISOString().slice(0, 10)
  const type = entityTypeFor(e)
  const aliases = (e.aliases ?? []).filter(Boolean)
  const refs = referencing.slice().sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
  // person/org entities hub into the people pillar (entity→pillar direction: the scaffold-owned
  // pillar file itself is never rewritten — no-clobber discipline).
  const pillarLine = type === 'person' || type === 'org' ? `- [[_about-people]] — pillar\n` : ''
  const md =
    `---\n` +
    `id: ${yamlStr(stem)}\n` +
    `name: ${yamlStr(e.label)}\n` +
    `description: ${yamlStr(`${e.label} — entity referenced by promoted operator beliefs`)}\n` +
    `type: ${yamlStr(type)}\n` +
    `generated-by: duin-seam\n` +
    `metadata:\n` +
    (e.entityId ? `  entityId: ${yamlStr(String(e.entityId))}\n` : '') +
    (aliases.length ? `  aliases: [${aliases.map((a) => yamlStr(String(a))).join(', ')}]\n` : '') +
    `  projectedAt: ${yamlStr(created)}\n` +
    `tags: [entity, generated]\n` +
    `---\n\n` +
    `${GEN_MARKER}\n\n` +
    `${e.label} — a real-world entity the operator's promoted beliefs are about. Projected from the entity plane; links regenerate on every reconcile.\n\n` +
    `## Relations\n\n` +
    pillarLine +
    refs.map((r) => `- [[${r.slug.replace(/\.md$/, '')}]] — believed\n`).join('')
  return { slug: `${stem}.md`, md }
}

/** kind → pillar (`_about-*` scaffold concept). `kind` is an OPEN string on OperatorFact, so
 *  unknown kinds fall back to knowledge. Pillars exist only after the onboarding scaffoldOkf —
 *  a link may dangle until then (harmless: the main graph drops `.brain/` and the body-dump
 *  skips `type: learned`; viewers show an unresolved link that self-heals on scaffold). */
function pillarFor(kind: string): string {
  switch (kind) {
    case 'correction':
    case 'preference':
    case 'principle':
      return '_about-instincts' // reflexes/heuristics earned about how to work with the operator
    case 'goal':
      return '_about-planning'
    case 'context':
    default:
      return '_about-knowledge'
  }
}

/** PURE: fact → concept markdown (frontmatter + body).
 *  Dates come from the FACT, never from the clock (W3): a re-projection on a later day is byte-identical.
 *  `capturedAt` is stamped at creation (legacy rows fall back to `ts`), `promotedAt` when the govern loop
 *  confirms or a human ratifies, `provisionalAt` when the fact entered probation. `today` is accepted for
 *  callers that still pass it but no longer reaches the output. */
export function conceptForFact(
  fact: OperatorFact,
  today?: string,
  ctx?: ConceptCtx
): { slug: string; md: string } {
  void today
  const slug = slugFor(fact)
  const claim = String(fact.fact || '').trim()
  const kind = String(fact.kind || 'context')
  const status = String(fact.status || 'promoted')
  const e = fact.efficacy
  const effLine = e
    ? `\n**Efficacy:** trials ${e.trials} · verdict ${e.verdict} · flipRate ${e.flipRate}${e.regressions ? ` · regressions ${e.regressions}` : ''}\n`
    : ''
  const capturedMs = typeof fact.capturedAt === 'number' ? fact.capturedAt : (fact.ts ?? 0)
  const iso = (ms: number): string => {
    try { return new Date(ms).toISOString() } catch { return String(ms) }
  }
  const capturedISO = iso(capturedMs)
  const statusMs = status === 'promoted' ? (fact.promotedAt ?? fact.ts ?? capturedMs) : (fact.provisionalAt ?? fact.ts ?? capturedMs)
  const statusDate = iso(statusMs).slice(0, 10)
  const statusDateLine = status === 'promoted'
    ? `  promotedAt: ${yamlStr(statusDate)}\n`
    : `  provisionalAt: ${yamlStr(statusDate)}\n`
  // Provenance is recorded, never inferred (constitution §3): an untagged legacy row is written as
  // `unknown`, even though the store protects it as operator-stated (the safe direction under doubt).
  const src = String(fact.source ?? 'unknown')
  // Supersession lineage lives in FRONTMATTER ONLY: the targets are retired out of memory/,
  // so a body [[wikilink]] would dangle in every viewer. Ids are audit pointers, not edges.
  const supersedes = (ctx?.supersedes ?? []).filter(Boolean)
  const supersedesLine = supersedes.length
    ? `  supersedes: [${supersedes.map((s) => yamlStr(String(s))).join(', ')}]\n`
    : ''
  const supersededByLine = ctx?.supersededBy ? `  supersededBy: ${yamlStr(String(ctx.supersededBy))}\n` : ''
  const standing =
    status === 'promoted'
      ? 'A promoted operator fact — earned through the govern loop (dual-verifier gate).'
      : status === 'provisional'
        ? 'A provisional operator fact — on probation. DUIN grounds it softly until the govern loop confirms it or you ratify it.'
        : `An operator fact with status ${status}.`
  const md =
    `---\n` +
    `id: ${yamlStr(slug.replace(/\.md$/, ''))}\n` +
    `name: ${yamlStr(titleFor(fact))}\n` +
    `description: ${yamlStr(claim)}\n` +
    `type: learned\n` +
    `metadata:\n` +
    `  kind: ${yamlStr(kind)}\n` +
    `  factId: ${yamlStr(String(fact.id))}\n` +
    `  status: ${yamlStr(status)}\n` +
    `  source: ${yamlStr(src)}\n` +
    `  adjudicatedBy: ${yamlStr(String(fact.adjudicatedBy ?? 'auto'))}\n` +
    `  capturedAt: ${capturedMs}\n` +
    statusDateLine +
    supersedesLine +
    supersededByLine +
    `tags: [${kind}, ${status}, learned]\n` +
    `---\n\n` +
    `${GEN_MARKER}\n\n` +
    `${claim}\n\n` +
    `${standing}${effLine}\n` +
    `Provenance: captured ${capturedISO}, ${status === 'promoted' ? 'promoted' : 'provisional since'} ${statusDate}, source ${src}.\n` +
    `\n## Relations\n\n` +
    `- [[${pillarFor(kind)}]] — pillar\n` +
    (ctx?.entities ?? [])
      .slice()
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((e) => `- [[${e.slug}]] — about\n`)
      .join('')
  return { slug, md }
}

/** Is this file one of ours (safe to overwrite/retire)? Absent file → ours (nothing to protect).
 *  A read error FAILS CLOSED (not ours) — never clobber a file we couldn't inspect. */
function isOurs(full: string): boolean {
  if (!existsSync(full)) return true
  try { return hasMarker(readFileSync(full, 'utf-8')) } catch { return false }
}

/** Project a fact's concept file (W3). Idempotent by slug AND by bytes: when the file already holds
 *  exactly what we would write, nothing is written and `changed` is false, so a reconcile pass over an
 *  unchanged store touches no mtime. Every projection is recorded in the seam ledger (slug, content
 *  hash, status, claim, lineage) — the record W4 reads to tell a human deletion or edit from our own.
 *  Skips (path null) when a hand-authored file owns the slug. `ledger` lets a reconcile thread one
 *  loaded ledger through many projections; without it the ledger is loaded and saved per call. */
export function projectConcept(
  fact: OperatorFact,
  memoryDir: string,
  ctx?: ConceptCtx,
  ledger?: SeamLedger
): { path: string | null; changed: boolean } {
  if (!memoryDir) return { path: null, changed: false }
  const { slug, md } = conceptForFact(fact, undefined, ctx)
  const full = join(memoryDir, slug)
  if (!isOurs(full)) return { path: null, changed: false }
  const led = ledger ?? loadSeamLedger(memoryDir)
  const id = String(fact.id)
  const rec = led.facts[id]
  const lineage = (ctx?.supersedes ?? []).map(String).sort().join(',')
  // W4: the human annotated this file (marker kept, claim intact). Their bytes stand until the fact
  // itself changes — status, claim or lineage — at which point the file is regenerated.
  if (
    rec?.annotated &&
    rec.status === String(fact.status) &&
    rec.claim === String(fact.fact ?? '').trim() &&
    rec.lineage === lineage &&
    existsSync(full)
  ) {
    return { path: full, changed: false }
  }
  let existing: string | null
  try {
    existing = existsSync(full) ? readFileSync(full, 'utf-8') : null
  } catch {
    existing = null
  }
  const unchanged = existing !== null && existing === md
  if (!unchanged) {
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(full, md, 'utf-8')
  }
  led.facts[id] = {
    slug,
    hash: contentHash(md),
    writtenAt: unchanged && rec ? rec.writtenAt : Date.now(),
    status: String(fact.status),
    claim: String(fact.fact ?? '').trim(),
    lineage
  }
  if (!ledger) saveSeamLedger(memoryDir, led)
  return { path: full, changed: !unchanged }
}

/** Materialize (write/overwrite) a fact's concept file. Idempotent by slug; see projectConcept.
 *  Returns the path (also when the bytes were already current), or null if a hand-authored file
 *  owns the slug. */
export function materializeConcept(fact: OperatorFact, memoryDir: string, ctx?: ConceptCtx): string | null {
  return projectConcept(fact, memoryDir, ctx).path
}

/** The `.brain/_retired/` dir (sibling of `memory/`) — retired concepts live OUTSIDE the
 *  grounded/retrieved `memory/` lane so they are audit-preserved but never re-grounded. */
function retiredDirFor(memoryDir: string): string {
  return join(dirname(memoryDir), RETIRED_DIRNAME)
}

/** Retire a concept out of `memory/` into `.brain/_retired/` (retire-not-delete = audit-
 *  preserving). No-op if the concept is absent or hand-authored. */
export function retireConcept(fact: OperatorFact, memoryDir: string, ledger?: SeamLedger): string | null {
  if (!memoryDir) return null
  const { slug } = conceptForFact(fact)
  const dest = retireSlug(slug, memoryDir, ledger)
  // Tombstone enrichment: a fact retired BY SUPERSESSION records its successor, so the
  // audit trail in `_retired/` is self-describing. String surgery (not regeneration)
  // preserves the original promotedAt/body exactly; best-effort — the retire (the move)
  // already succeeded and must never be failed by enrichment.
  if (dest && fact.supersededBy) {
    try {
      const content = readFileSync(dest, 'utf-8')
      if (!content.includes('supersededBy:') && content.includes('\ntags: [')) {
        writeFileSync(
          dest,
          content.replace('\ntags: [', `\n  supersededBy: ${yamlStr(String(fact.supersededBy))}\ntags: [`),
          'utf-8'
        )
      }
    } catch {
      /* enrichment is best-effort */
    }
  }
  return dest
}

/** Retire by slug (used by the reconciler for orphans whose fact object we don't hold). Drops the
 *  slug's ledger entry BEFORE the move, so the unlink our own rename produces can never read as a
 *  human deletion (W4). */
function retireSlug(slug: string, memoryDir: string, ledger?: SeamLedger): string | null {
  const full = join(memoryDir, slug)
  if (!existsSync(full) || !isOurs(full)) return null
  const retiredDir = retiredDirFor(memoryDir)
  try {
    const led = ledger ?? loadSeamLedger(memoryDir)
    for (const [id, rec] of Object.entries(led.facts)) if (rec.slug === slug) delete led.facts[id]
    if (!ledger) saveSeamLedger(memoryDir, led)
    mkdirSync(retiredDir, { recursive: true })
    const dest = join(retiredDir, slug)
    renameSync(full, dest)
    return dest
  } catch { return null }
}

/** Backfill: project concepts for a set of facts. Idempotent: `written` counts files whose bytes
 *  changed; an already-current file (or a hand-authored one) counts as `skipped`.
 *  `ctxFor` optionally supplies per-fact derived relations (see reconcileConcepts). */
export function backfillConcepts(
  facts: OperatorFact[],
  memoryDir: string,
  ctxFor?: (f: OperatorFact) => ConceptCtx | undefined,
  ledger?: SeamLedger
): { written: number; skipped: number } {
  let written = 0
  let skipped = 0
  for (const f of facts) {
    if (projectConcept(f, memoryDir, ctxFor?.(f), ledger).changed) written++
    else skipped++
  }
  return { written, skipped }
}

/** W4 — the human side of the seam. Production wiring lives in seam-reconcile
 *  (productionHumanEditHooks): a deleted file → vetoFact; a rewritten claim line → supersedeFact +
 *  promoteFact (+ confirmFact when the old fact was promoted). Tests inject fakes. */
export interface HumanEditHooks {
  onDeleted: (fact: OperatorFact) => void
  onEdited: (fact: OperatorFact, newClaim: string) => void
}

const normClaim = (s: string): string => s.toLowerCase().replace(/[.?!]+$/, '').replace(/\s+/g, ' ').trim()

/** The claim line: the first non-empty line after the machine marker. */
function claimLineOf(md: string): string | null {
  const at = md.indexOf(GEN_MARKER_PREFIX)
  if (at < 0) return null
  const end = md.indexOf('-->', at)
  if (end < 0) return null
  for (const line of md.slice(end + 3).split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return null
}

/** Read the ledger against the lane BEFORE re-projecting (W4): what did the human do to our files?
 *   - gone from `memory/`, not in `_retired/`, while `memory/` exists → DELETED → hooks.onDeleted
 *   - marker kept, claim line rewritten → EDITED → hooks.onEdited(fact, newClaim)
 *   - marker kept, claim intact, other bytes changed → ANNOTATED → left alone until the fact changes
 *   - marker removed → RELEASED → the file is the human's now; the seam forgets it
 *  A missing `memory/` directory is a reset (re-project everything), never a mass veto. Returns the
 *  ids the human acted on so the caller drops them from the projection set — otherwise the backfill
 *  that follows would re-create what the human just retracted. Hooks never throw into the seam. */
export function applyHumanEdits(
  facts: OperatorFact[],
  memoryDir: string,
  ledger: SeamLedger,
  hooks: HumanEditHooks
): { deleted: number; edited: number; annotated: number; released: number; changedIds: Set<string> } {
  const out = { deleted: 0, edited: 0, annotated: 0, released: 0, changedIds: new Set<string>() }
  if (!memoryDir || !existsSync(memoryDir)) return out
  const byId = new Map(facts.map((f) => [String(f.id), f]))
  const retiredDir = retiredDirFor(memoryDir)
  for (const [id, rec] of Object.entries(ledger.facts)) {
    const fact = byId.get(id)
    const full = join(memoryDir, rec.slug)
    if (!existsSync(full)) {
      if (existsSync(join(retiredDir, rec.slug))) {
        delete ledger.facts[id] // our own retire; the entry merely outlived the move
        continue
      }
      if (!fact) {
        delete ledger.facts[id] // no longer projected — nothing to retract
        continue
      }
      delete ledger.facts[id]
      out.changedIds.add(id)
      out.deleted++
      saveSeamLedger(memoryDir, ledger) // the hook may project through the seam; it must see this retraction
      try {
        hooks.onDeleted(fact)
      } catch {
        /* the seam never breaks the govern loop */
      }
      ledger.facts = loadSeamLedger(memoryDir).facts // pick up what the hook projected; never clobber it
      continue
    }
    if (!fact) continue // the orphan sweep retires it
    let content: string
    try {
      content = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    if (!hasMarker(content)) {
      delete ledger.facts[id]
      out.released++
      continue
    }
    const hash = contentHash(content)
    if (hash === rec.hash) continue
    const claim = claimLineOf(content)
    if (claim && normClaim(claim) !== normClaim(String(fact.fact ?? ''))) {
      delete ledger.facts[id]
      out.changedIds.add(id)
      out.edited++
      saveSeamLedger(memoryDir, ledger) // the replacement projects through the seam with its own ledger load
      try {
        hooks.onEdited(fact, claim)
      } catch {
        /* the seam never breaks the govern loop */
      }
      ledger.facts = loadSeamLedger(memoryDir).facts // pick up the replacement's entry; never clobber it
      continue
    }
    ledger.facts[id] = { ...rec, hash, annotated: true } // into the CURRENT map (it may have been reloaded)
    out.annotated++
  }
  return out
}

/** RECONCILE — make the concept lane match the promoted set exactly. Materializes every
 *  promoted fact AND retires any of OUR concept files whose fact is no longer promoted.
 *  This is the sweep that repairs every missed-retire path (flag toggles, evictToCap,
 *  any un-hooked demotion) — the concept projection can never durably drift from the store. */
export function reconcileConcepts(
  promoted: OperatorFact[],
  memoryDir: string,
  allFacts?: OperatorFact[],
  entities?: EntityCatalogEntry[],
  hooks?: HumanEditHooks
): { written: number; skipped: number; retired: number; entitiesWritten: number; entitiesRetired: number } {
  const ledger = loadSeamLedger(memoryDir)
  // W4: the human's edits and deletions are read FIRST, and whatever they retracted leaves the
  // projection set — otherwise the backfill below would put the file straight back.
  const hookProjected = new Set<string>()
  if (hooks) {
    const before = new Set(Object.keys(ledger.facts))
    const human = applyHumanEdits(promoted, memoryDir, ledger, hooks)
    if (human.changedIds.size) promoted = promoted.filter((f) => !human.changedIds.has(String(f.id)))
    // The hooks project replacements through the seam hook (their own ledger load/save): pick those
    // entries up, and keep their files out of the orphan sweep below — the projection set we were
    // handed predates them; the next reconcile folds them in with lineage.
    ledger.facts = loadSeamLedger(memoryDir).facts
    for (const [id, rec] of Object.entries(ledger.facts)) {
      if (!before.has(id) && !human.changedIds.has(id)) hookProjected.add(rec.slug)
    }
  }
  // Reverse supersession map: old.supersededBy = new.id is stored on the DEAD fact, so the
  // live concept's "what did I supersede" needs the full (bitemporal) list. Optional — the
  // per-promote hook path doesn't have it, and the next reconcile self-heals the lineage.
  const supersededIdsBy = new Map<string, string[]>()
  for (const f of allFacts ?? []) {
    if (!f?.supersededBy) continue
    const arr = supersededIdsBy.get(String(f.supersededBy)) ?? []
    arr.push(String(f.id))
    supersededIdsBy.set(String(f.supersededBy), arr)
  }
  // T2 entity hits per fact — computed once, feeds both the concept about-links and the
  // entity-file reverse links. `entities === undefined` (flag off / hook path) skips the
  // entire entity phase: no about-links, no entity writes, no entity retires — byte-identical T1.
  const hitsByFact = new Map<string, EntityCatalogEntry[]>()
  if (entities?.length) {
    for (const f of promoted) hitsByFact.set(String(f.id), matchEntities(String(f.fact ?? ''), entities))
  }
  // Selection pass (design note Q1): an entity QUALIFIES when distinct believing concepts
  // ≥ its minRefs bar. Below the bar it gets no file AND no about-link (a link to a file
  // that will never exist would dangle by design).
  const refCounts = new Map<string, number>()
  for (const f of promoted) {
    for (const e of hitsByFact.get(String(f.id)) ?? []) {
      const stem = `entity-${slugifyLabel(e.label)}`
      refCounts.set(stem, (refCounts.get(stem) ?? 0) + 1)
    }
  }
  const qualifies = (e: EntityCatalogEntry): boolean =>
    (refCounts.get(`entity-${slugifyLabel(e.label)}`) ?? 0) >= Math.max(1, e.minRefs ?? 1)
  const ctxFor = (f: OperatorFact): ConceptCtx | undefined => {
    const supersedes = supersededIdsBy.get(String(f.id))
    const hits = (hitsByFact.get(String(f.id)) ?? []).filter(qualifies)
    const ctx: ConceptCtx = {}
    if (supersedes?.length) ctx.supersedes = supersedes.slice().sort()
    if (hits.length) {
      ctx.entities = hits.map((e) => ({ slug: `entity-${slugifyLabel(e.label)}`, label: e.label }))
    }
    return ctx.supersedes || ctx.entities ? ctx : undefined
  }
  const { written, skipped } = backfillConcepts(promoted, memoryDir, ctxFor, ledger)
  const expected = new Set(promoted.map((f) => conceptForFact(f).slug))
  for (const slug of hookProjected) expected.add(slug)
  let retired = 0
  let existing: string[]
  try {
    existing = existsSync(memoryDir) ? readdirSync(memoryDir) : []
  } catch {
    existing = []
  }
  for (const name of existing) {
    if (!name.startsWith('concept-') || !name.endsWith('.md')) continue
    if (expected.has(name)) continue // still promoted — keep
    if (retireSlug(name, memoryDir, ledger)) retired++ // ours + orphaned → retire
  }
  // T2 entity phase — materialize referenced entity files, retire unreferenced ones. Runs
  // ONLY when a catalog was supplied (undefined ⇒ pre-existing entity files are left alone;
  // turning the flag off must not retire-all).
  let entitiesWritten = 0
  let entitiesRetired = 0
  if (entities !== undefined) {
    const referenced = new Map<string, { entry: EntityCatalogEntry; refs: Array<{ slug: string; name: string }> }>()
    for (const f of promoted) {
      for (const e of (hitsByFact.get(String(f.id)) ?? []).filter(qualifies)) {
        const stem = `entity-${slugifyLabel(e.label)}`
        const rec = referenced.get(stem) ?? { entry: e, refs: [] }
        rec.refs.push({ slug: conceptForFact(f).slug, name: titleFor(f) })
        referenced.set(stem, rec)
      }
    }
    for (const rec of referenced.values()) {
      const { slug, md } = entityConceptFor(rec.entry, rec.refs)
      const full = join(memoryDir, slug)
      if (!isOurs(full)) continue // hand-authored entity note owns the slug — never clobber
      let prev: string | null
      try { prev = existsSync(full) ? readFileSync(full, 'utf-8') : null } catch { prev = null }
      if (prev === md) continue // byte-current already (W3 idempotency)
      mkdirSync(memoryDir, { recursive: true })
      writeFileSync(full, md, 'utf-8')
      entitiesWritten++
    }
    let entityFiles: string[]
    try {
      entityFiles = existsSync(memoryDir) ? readdirSync(memoryDir) : []
    } catch {
      entityFiles = []
    }
    for (const name of entityFiles) {
      if (!name.startsWith('entity-') || !name.endsWith('.md')) continue
      if (referenced.has(name.replace(/\.md$/, ''))) continue // still referenced — keep
      if (retireSlug(name, memoryDir, ledger)) entitiesRetired++ // ours + unreferenced → retire
    }
  }
  // Keep `_concept-index.md` fresh on the seam path — its only other regeneration is the
  // onboarding scaffold, so without this every backfill leaves the index stale. Runs AFTER
  // the entity phase so entity concepts index too. Best-effort: an index failure must never
  // fail the reconcile.
  try {
    generateConceptIndex(memoryDir, 'memory', new Date().toISOString().slice(0, 10))
  } catch {
    /* index refresh is best-effort */
  }
  saveSeamLedger(memoryDir, ledger)
  return { written, skipped, retired, entitiesWritten, entitiesRetired }
}

/** Export a portable `.brain` bundle (offboarding / device migration / IP custody).
 *  Copies the durable lanes (memory concepts + moat + saved-memory + identity) into a
 *  timestamped bundle dir under `.brain/_exports/` with a manifest. No secrets: the moat
 *  is facts/verdicts, not credentials. Returns the bundle path. */
export function exportBrainBundle(
  notesDir: string | null | undefined,
  today?: string
): { ok: boolean; bundleDir?: string; copied?: string[]; missing?: string[]; error?: string } {
  const dir = typeof notesDir === 'string' ? notesDir.trim() : ''
  if (!dir) return { ok: false, error: 'no vault (localBrainNotesDir) configured' }
  const root = join(dir, BRAIN_DIRNAME)
  if (!existsSync(root)) return { ok: false, error: `no .brain/ root at ${root}` }
  const stamp = (today || new Date().toISOString().slice(0, 19)).replace(/[:T]/g, '-')
  const bundleDir = join(root, '_exports', `brain-bundle-${stamp}`)
  const copied: string[] = []
  try {
    mkdirSync(bundleDir, { recursive: true })
    for (const lane of [BRAIN_MEMORY_DIR, '_moat', '_memory-store']) {
      const src = join(root, lane)
      if (existsSync(src)) {
        cpSync(src, join(bundleDir, lane), { recursive: true })
        copied.push(lane)
      }
    }
    // Identity lives at the VAULT ROOT, not inside `.brain/`. This loop read `join(root, f)`
    // and so copied none of it: an export whose entire purpose is IP custody shipped with ZERO
    // identity — silently, because `existsSync` skips a miss and the result still said ok. On
    // the live vault it carried `config.json` and nothing else.
    //
    // The names come from FOUNDATION_BASENAMES rather than a private array, because this
    // function held a FIFTH independent spelling of that list. Keeping them in agreement by
    // hand is exactly what foundation-files.ts exists to stop; its header records that SOUL.md
    // already hit the silent version of this failure once.
    const missing: string[] = []
    for (const f of FOUNDATION_BASENAMES) {
      const src = join(dir, f)
      if (existsSync(src)) {
        cpSync(src, join(bundleDir, f))
        copied.push(f)
        continue
      }
      // `me.md` is the pre-migration lowercase spelling. A case-insensitive filesystem finds it
      // above; a case-sensitive one needs it asked for by name, and losing ME.md on Linux would
      // be losing the operator.
      const lower = f.toLowerCase()
      if (lower !== f && existsSync(join(dir, lower))) {
        cpSync(join(dir, lower), join(bundleDir, lower))
        copied.push(lower)
        continue
      }
      missing.push(f)
    }
    // config.json is the one bundled file that genuinely does live under `.brain/`.
    if (existsSync(join(root, 'config.json'))) {
      cpSync(join(root, 'config.json'), join(bundleDir, 'config.json'))
      copied.push('config.json')
    } else {
      missing.push('config.json')
    }
    // A vault legitimately may not have every optional foundation file, so a miss is reported
    // rather than fatal. Losing the whole identity core is different: that is the bundle failing
    // at its one job, and it must not look like a clean export.
    const identityCore = IDENTITY_FOUNDATION_ORDER.filter((f) => copied.includes(f) || copied.includes(f.toLowerCase()))
    if (identityCore.length === 0) {
      console.warn(
        `[brain-bundle] exported WITHOUT any identity file (looked for ${IDENTITY_FOUNDATION_ORDER.join(', ')} in ${dir})`
      )
    }
    writeFileSync(
      join(bundleDir, 'manifest.json'),
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          root,
          vault: dir,
          lanes: copied,
          missing,
          note: 'Portable DUIN operator brain — concepts + moat + identity. Import into a fresh vault .brain/.'
        },
        null,
        2
      ),
      'utf-8'
    )
    return { ok: true, bundleDir, copied, missing }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

/** Hook factory — wired from main. Fire-and-forget, flag-gated, NEVER throws.
 *  `onWrite` (auto-reconcile scheduling) fires AFTER the immediate per-fact write, in its own
 *  guard, so the fast path (this fact's file appears instantly) and the slow path (the
 *  debounced FULL reconcile that adds lineage/entity edges + index) stay independent — a
 *  broken scheduler can never break the govern loop either. */
export function makeMaterializeHook(
  getNotesDir: () => string | null,
  onWrite?: (action: 'promote' | 'retire') => void
): (fact: OperatorFact, action: 'promote' | 'retire') => void {
  return (fact, action) => {
    if (!seamEnabled()) return
    try {
      const memoryDir = conceptMemoryDir(getNotesDir())
      if (!memoryDir) return
      if (action === 'promote') materializeConcept(fact, memoryDir)
      else retireConcept(fact, memoryDir)
    } catch {
      /* the seam must never break the govern loop */
    }
    try {
      onWrite?.(action)
    } catch {
      /* scheduling is best-effort; the govern loop stays unbreakable */
    }
  }
}
