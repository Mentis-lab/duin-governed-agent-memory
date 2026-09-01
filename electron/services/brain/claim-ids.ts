// Shared claim-id construction + a one-time migration for prose TRIPLE claims.
//
// Bug this fixes: the prose triple-claim id was `prose:t:${subject}|${relation}|${object}` —
// the NOTE was omitted from the key. Two different notes asserting the SAME subject-relation-object
// (e.g. one stating it current, a LATER one retiring/re-dating it via validUntil) collided to one id,
// so `constructionClaims`' `seen` set silently dropped the second row. The dropped row often carried
// the RETIREMENT (validUntil) and distinct provenance, so the claim stayed `current` forever and the
// born-retired temporal verdict never fired. Including the note in the key (matching construct.ts's
// own 4-tuple triple dedup subject∥relation∥object∥note) lets both rows co-exist and the temporal
// logic run. Pure + unit-tested.

import { type Claim } from './claim-metabolism'

/** Escape the `|` id delimiter inside a segment so two distinct facts can't collide to one id. */
export const encClaimSeg = (s: string): string => s.replace(/\|/g, '%7C')

/** Prefix that uniquely identifies a prose TRIPLE claim id (distinct from the prose EDGE-claim
 *  prefix `prose:` which is immediately followed by an entity id, never a literal `t:`). */
export const PROSE_TRIPLE_ID_PREFIX = 'prose:t:'

/** Canonical id for a prose triple claim — note INCLUDED so same-fact rows from different notes
 *  (with different validity/provenance) are distinct. */
export function proseTripleClaimId(subject: string, relation: string, object: string, note: string): string {
  return `${PROSE_TRIPLE_ID_PREFIX}${encClaimSeg(subject)}|${encClaimSeg(relation)}|${encClaimSeg(object)}|${encClaimSeg(note)}`
}

/**
 * One-time, idempotent load-time migration: re-key legacy 3-segment prose triple ids
 * (`prose:t:s|r|o`) to the 4-segment note-bearing form (`prose:t:s|r|o|note`) using each row's
 * stored `notePath`. This makes a migrated on-disk row byte-identical (in id/chunkId) to what a
 * fresh extraction now produces, so mergeLedger matches it and carries forward its verdict /
 * validTo / reviewState (human pins) — no duplication, no lost decisions. Applied in loadLedger.
 * Idempotent: an already-4-segment id (or a non-prose / edge claim) is returned untouched.
 */
export function migrateLegacyProseTripleIds(claims: Claim[]): Claim[] {
  let changed = false
  const out = claims.map((c) => {
    if (c.source !== 'prose' || !c.id.startsWith(PROSE_TRIPLE_ID_PREFIX)) return c
    const rest = c.id.slice(PROSE_TRIPLE_ID_PREFIX.length)
    // segments are `|`-delimited; each is enc()'d so none contains a literal `|`.
    if (rest.split('|').length !== 3) return c // already migrated (4) or unexpected — leave it
    const newId = `${c.id}|${encClaimSeg(c.notePath ?? '')}`
    changed = true
    return { ...c, id: newId, chunkId: c.chunkId === c.id ? newId : c.chunkId }
  })
  return changed ? out : claims
}
