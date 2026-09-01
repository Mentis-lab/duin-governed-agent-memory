// The single source of truth for "which root `.md` files are DUIN's own
// scaffolding rather than user notes".
//
// This used to be three independent lists — `FOUNDATION_FILES` in
// scaffold-harness (the in-place mover's never-move set), and two byte-identical
// `ROOT_FOUNDATION` sets in graph-derive and build-graph-native (the cold-start
// "is this vault populated?" test) — plus a fourth ordered list inside
// brain-root's identity loop. Nothing kept them in agreement, and the failure is
// silent in both directions: a name missing from the mover's set gets a
// foundation file relocated into a pillar folder where loadBrain (vault ROOT
// only) stops seeing it, and a name missing from the graph sets makes a
// scaffold-only vault look populated. SOUL.md hit the first case for real.
//
// Pure constants + one predicate. No fs, no electron — importable from anywhere.

/** Canonical-cased basenames of every root foundation file. Order is
 *  presentation-only; membership is what matters. */
export const FOUNDATION_BASENAMES: readonly string[] = [
  'SOUL.md',
  'BRAIN.md',
  'ME.md',
  'GOALS.md',
  'MEMORY.md',
  'VAULT-MAP.md',
  'INDEX.md',
  'DIAGNOSIS.md'
]

/** Never-move / never-delete set for the in-place scaffold mover, which files
 *  any root `.md` it does not recognize into a pillar folder. */
export const FOUNDATION_FILES: ReadonlySet<string> = new Set(FOUNDATION_BASENAMES)

/** Lowercased mirror, for the case-insensitive relative-path test below. */
const FOUNDATION_LOWER: ReadonlySet<string> = new Set(
  FOUNDATION_BASENAMES.map((n) => n.toLowerCase())
)

/**
 * True when `rel` is a root-level foundation file. Vault-relative path, either
 * slash style; anything inside a subdirectory is a user note by definition —
 * a `DUIN/Archive/BRAIN.md` is content, not scaffolding.
 */
export function isRootFoundation(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/')
  return !norm.includes('/') && FOUNDATION_LOWER.has(norm.toLowerCase())
}

/**
 * The identity block's foundation files, in the order `loadBrain` concatenates
 * them. A deliberate ORDERED SUBSET of the set above, not a duplicate of it:
 *
 *  - SOUL leads. BRAIN.md is imperative and gets followed literally; SOUL.md is
 *    declarative and generalizes to situations no rule anticipated, so character
 *    is established before the rules that constrain it.
 *  - `me.md` trails `ME.md` as a lowercase fallback for pre-migration vaults;
 *    the loader stops after whichever it finds first.
 *  - GOALS.md / MEMORY.md / VAULT-MAP.md / INDEX.md / DIAGNOSIS.md are
 *    deliberately ABSENT — they reach the model through the graph, the memory
 *    block, or retrieval, and putting them here would put them in every prompt.
 */
export const IDENTITY_FOUNDATION_ORDER: readonly string[] = [
  'SOUL.md',
  'BRAIN.md',
  'ME.md',
  'me.md'
]
