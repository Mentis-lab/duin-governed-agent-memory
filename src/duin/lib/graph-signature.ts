// graph-signature — "has the brain graph actually changed?" as a pure function.
//
// WHY IT LIVES HERE. The graph fetch fires on every window focus/visibility change even
// when nothing changed, so the shell compares a cheap signature before calling setData
// and re-running layout. That comparison has now been wrong three separate ways — ids
// only (a rename was invisible), then a field list copied from a type mirror that had
// drifted from the served payload (tag edits went invisible again) — and each time the
// bug was unobservable because it lives inside a 2,000-line renderer component with no
// jsdom in this repo and therefore no test. Pulling it out is what makes it testable.
//
// HASH THE PAYLOAD, NOT THE TYPE. `state.ts`'s BrainNode omits `tags`, but
// /state/brain-graph is served by `buildBrainGraph` (brain-graph-native.ts), which emits
// up to 16 sorted tags per node. Reading the interface and concluding the field is dead
// is exactly the mistake that shipped. The input type here is deliberately loose for the
// same reason: this hashes what arrived over the wire.

/** FNV-1a over the string, as an unsigned 32-bit value. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Murmur3 finalizer. Needed because the two accumulator lanes must be INDEPENDENT.
 *
 * The previous form was `b += Math.imul(h, K)`, and multiplication distributes over
 * addition mod 2^32 — so `b === Math.imul(a, K)` exactly, for every input. The second
 * lane was a scaled copy of the first and contributed nothing: the signature was 32 bits
 * wearing a 64-bit label, while the per-node hash input kept being widened on the
 * assumption that more content meant more discrimination.
 *
 * Summing a NON-LINEAR mix of each hash keeps the fold order-free (a sum, so node order
 * from the route cannot change the result) while making lane b genuinely independent of
 * lane a.
 */
function mix32(h: number): number {
  let x = h >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return x >>> 0
}

interface SigNode {
  id?: unknown
  kind?: unknown
  label?: unknown
  layer?: unknown
  group?: unknown
  tags?: unknown
  declared?: unknown
  date?: unknown
  mtime?: unknown
}

interface SigLink {
  source?: unknown
  target?: unknown
  type?: unknown
}

/**
 * The per-node fields that must trigger a repaint when they change.
 *
 *  - kind / layer  — decide which lens a node appears under
 *  - group         — decides the folder rail and hue
 *  - tags          — the Tags lens renders them (and they ARE on the payload)
 *  - declared      — decides the canvas fill: solid vs hollow
 *  - label / date / mtime — shown directly
 *
 * NOT covered, and it cannot be from here: a pure body edit. The payload carries no
 * content hash, and `mtime` is not a modification time for any dated file — graph-derive
 * prefers `parseDateFromName` over the real mtime, so a daily note's mtime is its
 * FILENAME date and is constant across edits. Detecting body edits needs a content
 * signal added to the route.
 */
function nodeKey(n: SigNode): string {
  const tags = Array.isArray(n.tags) ? n.tags.join(',') : ''
  return [
    n.id ?? '',
    n.kind ?? '',
    n.label ?? '',
    n.layer ?? '',
    n.group ?? '',
    tags,
    n.declared ?? '',
    n.date ?? '',
    n.mtime ?? ''
  ].join('|')
}

/** Stable signature of a brain graph. Equal signature ⇒ skip the re-render. */
export function graphSignature(g: { nodes?: SigNode[]; links?: SigLink[] } | null | undefined): string {
  if (!g) return ''
  let a = 0
  let b = 0
  const nodes = g.nodes ?? []
  const links = g.links ?? []
  for (const n of nodes) {
    const h = hashString(nodeKey(n))
    a = (a + h) >>> 0
    b = (b + mix32(h)) >>> 0
  }
  for (const l of links) {
    const h = hashString(`${l.source ?? ''}>${l.target ?? ''}:${l.type ?? ''}`)
    a = (a + h) >>> 0
    b = (b + mix32(h)) >>> 0
  }
  return `${nodes.length}.${links.length}.${a}.${b}`
}
