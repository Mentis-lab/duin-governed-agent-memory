// claim-entities — semantic entity resolution for the claim metabolism. The run-7 Memory review's
// #1 gap: supersession/recall keyed on EXACT lowercased strings, so "ProjectA" ≠ "《ProjectA》", "Theo" ≠
// "Theo Q", "Project Atlas" ≠ "Atlas project" never coalesce — the graph can't decide two claims
// are about the SAME real thing (what Graphiti does with embedding entity resolution).
//
// This lifts the (subject,relation) key from a raw string to a CANONICAL ENTITY: distinct claim
// subjects are embedded (the same on-device embedder retrieval uses), clustered by cosine, and each
// cluster gets one canonical label — so supersession/reinforcement now fire across alias/paraphrase
// variants of the same entity. Degrades safely: no embedder (embed → []) ⇒ every subject is its own
// entity ⇒ today's exact-string behavior.
//
// The CLUSTERING is PURE (labels + their vectors → Map<label,canonical>) so it unit-tests with a
// hand-built vector fixture; only the embed call is I/O and is injected.

import type { Claim } from './claim-metabolism'

/** Cosine of two vectors. Embedder output is L2-normalized, but normalize defensively. */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Cosine bar at which two subject vectors are UNIONed into one entity. Exported as the single source
 *  of truth so the supersession apply-guard can DERIVE its confidence bar strictly above it — a
 *  cross-alias durable retirement must require membership meaningfully STRONGER than the bare merge
 *  bar, so a bare-threshold cosine collision (e.g. 腾讯视频 vs 腾讯音乐 at ~0.86) can never itself
 *  authorize a retirement. Keep the two coupled: see SUPERSEDE_MIN_CONFIDENCE in claim-metabolism.ts. */
export const ENTITY_CLUSTER_THRESHOLD = 0.86

/** Pick the canonical label of a cluster: the LONGEST (fullest) form, tie-broken lexicographically
 *  so the choice is deterministic across runs. */
function canonicalOf(labels: string[]): string {
  return labels.reduce((best, l) => (l.length > best.length || (l.length === best.length && l < best) ? l : best), labels[0])
}

/**
 * PURE: cluster `labels` (each embedded as `vecs[i]`) into entities by cosine ≥ threshold, and
 * return label → canonical-label. Union-find so transitive similarity (a~b, b~c ⇒ a,b,c one entity)
 * coalesces. A label with no vector (embedding unavailable) stays its own entity.
 */
export function clusterAliases(labels: string[], vecs: number[][], threshold = ENTITY_CLUSTER_THRESHOLD): Map<string, string> {
  const n = labels.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }
  for (let i = 0; i < n; i++) {
    if (!vecs[i]?.length) continue
    for (let j = i + 1; j < n; j++) {
      if (!vecs[j]?.length) continue
      if (cosine(vecs[i], vecs[j]) >= threshold) union(i, j)
    }
  }
  const clusters = new Map<number, string[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    ;(clusters.get(r) ?? clusters.set(r, []).get(r)!).push(labels[i])
  }
  const canonical = new Map<number, string>()
  for (const [r, ls] of clusters) canonical.set(r, canonicalOf(ls))
  const out = new Map<string, string>()
  for (let i = 0; i < n; i++) out.set(labels[i], canonical.get(find(i))!)
  return out
}

/** Per-subject confidence that it belongs to its cluster: cosine of the subject's vector to its
 *  cluster's CANONICAL vector (1.0 when the subject IS the canonical). A transitively-linked member
 *  only weakly similar to the head scores LOW — this is the signal the supersession guard reads to
 *  REFUSE an ambiguous cross-alias retirement (a chain a~b~c can coalesce c into a's entity while
 *  cosine(a,c) is small; that pairing must never durably retire a real claim). PURE. */
export function clusterConfidences(labels: string[], vecs: number[][], map: Map<string, string>): Map<string, number> {
  const vecOf = new Map<string, number[]>()
  labels.forEach((l, i) => vecOf.set(l, vecs[i] ?? []))
  const out = new Map<string, number>()
  for (const l of labels) {
    const canon = map.get(l)
    out.set(l, !canon || canon === l ? 1 : cosine(vecOf.get(l) ?? [], vecOf.get(canon) ?? []))
  }
  return out
}

export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** Whether semantic entity resolution runs. Default ON (degrades to exact-string keys with no
 *  embedder); DUIN_CLAIM_ENTITY_RESOLVE=0 disables. */
export function entityResolveEnabled(): boolean {
  return process.env.DUIN_CLAIM_ENTITY_RESOLVE !== '0'
}

// ─── Incremental blocked resolution (P7) ────────────────────────────────────────────────────────
// The old cap (skip a ledger > 400 distinct subjects) meant the LIVE ledger (~3025 subjects) never
// resolved: a naive pass is O(n²) cosine (≈9M ops) + one embed of all n. We instead BLOCK by a cheap
// key and cluster only WITHIN a block, and — crucially — only embed subjects that share a block with
// another candidate. Aliases of the same real thing collide on the cheap key ("ProjectA"/"《ProjectA》" →
// "ProjectA" once punctuation/space is stripped; "Theo"/"Theo Q" → "th"), so clustering stays inside
// small blocks. Cost is Σ b_i² over kept blocks (bounded by MAX_BLOCK) plus an embed of only the
// block candidates (bounded by MAX_EMBED_SUBJECTS) — NOT n². The failure mode is UNDER-merging
// (subjects whose cheap keys differ never compare), which is the SAFE direction: a missed merge only
// keeps exact-string behavior, whereas an over-merge could feed a wrong supersession. Converges in a
// single pass; no per-tick state to carry.

// Clustering within a block is O(b²); skip a pathological mega-block (keeps those exact-string).
const MAX_BLOCK = 64
// Global bound on how many subjects we embed per pass (block candidates only). Realistic ledgers have
// far fewer alias candidates than this, so it rarely binds; it caps the worst case deterministically.
const MAX_EMBED_SUBJECTS = 2000
// Never let a slow/first-load embedder hang the caller (the GET route awaits this).
const RESOLVE_EMBED_TIMEOUT_MS = 8000

/** Cheap blocking key: normalized (lowercased, punctuation/space/symbols stripped) prefix. Aliases
 *  that differ only by punctuation/casing/suffix share it, so they land in the same block; distinct
 *  entities generally do not. Deterministic. */
export function blockKeyOf(subject: string): string {
  const norm = subject.trim().toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  if (!norm) return subject.trim().toLowerCase()
  return Array.from(norm).slice(0, 2).join('') // first two significant characters (CJK ideographs or latin)
}

export interface EntityBlockPlan {
  /** the subjects we will actually embed — block candidates only (singletons excluded) */
  toEmbed: string[]
  /** each block is a group of ≥2 alias-candidate subjects to cluster together */
  blocks: string[][]
}

/**
 * PURE + BOUNDED: partition distinct subjects into alias-candidate blocks. A subject alone in its
 * block has no alias to compare against, so it is NEVER embedded and NEVER clustered (exact-string
 * key). This is what keeps the pass off O(n²) on a 3025-subject ledger: only the (few) subjects that
 * collide on the cheap key are embedded and compared. `blocks`/`toEmbed` are capped so a degenerate
 * distribution can't blow up cost.
 */
export function planEntityBlocks(distinct: string[]): EntityBlockPlan {
  const byBlock = new Map<string, string[]>()
  for (const s of distinct) {
    const k = blockKeyOf(s)
    ;(byBlock.get(k) ?? byBlock.set(k, []).get(k)!).push(s)
  }
  const blocks: string[][] = []
  const toEmbed: string[] = []
  // Deterministic order (sorted block key) so the global budget cuts the same way every run.
  for (const k of [...byBlock.keys()].sort()) {
    const group = byBlock.get(k)!
    if (group.length < 2) continue // singleton → no alias candidate, never embed
    if (group.length > MAX_BLOCK) continue // pathological mega-block → skip (exact-string), bounds Σb²
    if (toEmbed.length + group.length > MAX_EMBED_SUBJECTS) break // global embed budget
    blocks.push(group)
    toEmbed.push(...group)
  }
  return { toEmbed, blocks }
}

/**
 * Resolve the distinct subjects of `claims` to canonical entities and stamp `entityKey` (+ the
 * membership `entityKeyConfidence`) on each, so runVerdicts groups the (entity,relation) key across
 * aliases. Mutates in place. Best-effort: any embed failure or empty result leaves entityKey unset
 * (⇒ exact-string fallback in supersedeKey). Runs INCREMENTALLY via planEntityBlocks so it scales to
 * the live ledger without an O(n²) blowup (see the block above).
 */
export async function annotateEntityKeys(claims: Claim[], embed: EmbedFn, threshold = ENTITY_CLUSTER_THRESHOLD): Promise<void> {
  if (!entityResolveEnabled() || claims.length === 0) return
  const distinct = Array.from(new Set(claims.map((c) => c.subject.trim()).filter((s) => s.length > 0)))
  if (distinct.length < 2) return
  const { toEmbed, blocks } = planEntityBlocks(distinct)
  if (toEmbed.length === 0) return // no alias candidates anywhere → exact-string keys, no embed call
  let vecs: number[][] = []
  try {
    // Degrade to exact-string keys rather than hang if the embedder is slow / loading.
    vecs = await Promise.race([
      embed(toEmbed),
      new Promise<number[][]>((resolve) => setTimeout(() => resolve([]), RESOLVE_EMBED_TIMEOUT_MS))
    ])
  } catch {
    return
  }
  if (vecs.length !== toEmbed.length) return // embedder unavailable / mismatch / timeout → exact-string keys
  const vecOf = new Map<string, number[]>()
  toEmbed.forEach((s, i) => vecOf.set(s, vecs[i]))
  const canon = new Map<string, string>() // subject → canonical entity label
  const conf = new Map<string, number>() // subject → membership confidence
  for (const block of blocks) {
    const bvecs = block.map((s) => vecOf.get(s) ?? [])
    const map = clusterAliases(block, bvecs, threshold)
    const cmap = clusterConfidences(block, bvecs, map)
    for (const s of block) {
      canon.set(s, map.get(s)!)
      conf.set(s, cmap.get(s)!)
    }
  }
  for (const c of claims) {
    const s = c.subject.trim()
    const cn = canon.get(s)
    if (cn) {
      c.entityKey = cn
      c.entityKeyConfidence = conf.get(s)
    }
  }
}
