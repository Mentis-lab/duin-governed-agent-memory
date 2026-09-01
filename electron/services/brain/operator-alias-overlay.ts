// operator-alias-overlay.ts — operator-confirmed entity merges (the "operator-alias-overlay").
//
// resolveEntityIdentity fuses duplicates via a HAND-AUDITED whitelist (ENTITY_ALIAS, edited in source).
// A reveal surfaces FUZZY merge candidates the whitelist doesn't cover; when the operator CONFIRMS one
// ("this 'usage based' IS your existing usage-based-pricing"), that decision must persist WITHOUT
// editing hand-audited code. This overlay is that store: operator-confirmed label->canonical mappings,
// folded into resolution at read time (composed AFTER the whitelist pass, so an operator confirm is the
// final say). A REJECT is recorded too, undoing any prior confirm for that label.
//
// Append-only jsonl, last-write-wins, mirroring the other .duin/_state ledgers. Empty ⇒ no-op.

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { ConstructedData, ConstructedEntity } from './types'

const aliasOverlayPath = (vault: string): string => join(vault, '.duin', '_state', 'operator-aliases.jsonl')

export type AliasVerdict = 'confirm' | 'reject'

export interface AliasVerdictRecord {
  /** the label the model emitted (normalized on read) */
  label: string
  /** the canonical entity id the operator says it IS */
  canonicalId: string
  verdict: AliasVerdict
  ts: string
}

/** A confirmed operator overlay: normalized-label -> canonical id. */
export type AliasOverlay = Map<string, string>

const norm = (s: string): string => s.trim().toLowerCase()

export function recordAliasVerdict(vault: string, rec: AliasVerdictRecord): void {
  const path = aliasOverlayPath(vault)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf-8')
}

/** Read the overlay into a last-write-wins map of CONFIRMED aliases (a later reject drops the mapping). */
export function loadAliasOverlay(vault: string): AliasOverlay {
  const m: AliasOverlay = new Map()
  const path = aliasOverlayPath(vault)
  if (!existsSync(path)) return m
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as AliasVerdictRecord
      if (!r || !r.label || !r.canonicalId) continue
      if (r.verdict === 'confirm') m.set(norm(r.label), r.canonicalId)
      else if (r.verdict === 'reject') m.delete(norm(r.label))
    } catch {
      /* skip a corrupt row */
    }
  }
  return m
}

/** PURE — fold operator-confirmed merges into a construction: rewrite an entity whose label the
 *  operator mapped to a canonical id, rewire its edges, drop resulting self-loops, and dedup entities.
 *  Composes AFTER resolveEntityIdentity. Empty overlay (or no matches) ⇒ input returned unchanged. */
export function applyAliasOverlay(data: ConstructedData, overlay: AliasOverlay): ConstructedData {
  if (!overlay.size) return data
  const rewrite = new Map<string, string>() // old entity id -> operator's canonical id
  for (const e of data.entities) {
    const canon = overlay.get(norm(e.label))
    if (canon && canon !== e.id) rewrite.set(e.id, canon)
  }
  if (!rewrite.size) return data
  const map = (id: string): string => rewrite.get(id) ?? id

  const seen = new Set<string>()
  const entities: ConstructedEntity[] = []
  for (const e of data.entities) {
    const id = map(e.id)
    if (seen.has(id)) continue // a merge collapsed two entities onto one canonical id → keep the first
    seen.add(id)
    entities.push({ ...e, id })
  }
  const edges = data.edges
    .map((e) => ({ ...e, source: map(e.source), target: map(e.target) }))
    .filter((e) => e.source !== e.target) // a merge can turn an edge into a self-loop → drop it
  return { ...data, entities, edges }
}
