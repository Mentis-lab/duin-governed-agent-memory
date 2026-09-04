// Where the map's nodes were, remembered across launches.
//
// Within a session the shell carries each node's x/y across refreshes (prevNodes in
// brain-shell), so a brain update never re-scatters the map. Across launches nothing was kept:
// every start placed 3k nodes on d3's phyllotaxis spiral and settled from alpha 1 for five to
// eight seconds, and the map the operator had learned came back as a different picture. This
// module keeps the last settled positions in localStorage, per vault, and the layout seeds from
// them: the first settle after a launch is then a gentle re-heat, not a re-layout.
//
// Storage-agnostic on purpose (a `Storage`-shaped object is passed in), so a node test can run
// it against a Map-backed fake and the renderer passes window.localStorage.

export const POSITIONS_VERSION = 1
/** Nodes above this are not persisted: 20k × ~40 bytes is the most a 5 MB localStorage should carry for one key. */
export const POSITIONS_MAX_NODES = 20_000

export type StoredPositions = Map<string, [number, number]>

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** One key per vault, so switching vaults never seeds one map from another's layout. */
export function positionsKey(vaultDir: string | null | undefined): string {
  return `duin:brainPositions:${(vaultDir || 'default').replace(/\\/g, '/').toLowerCase()}`
}

export function loadPositions(storage: StorageLike | null | undefined, key: string): StoredPositions {
  const out: StoredPositions = new Map()
  if (!storage) return out
  try {
    const raw = storage.getItem(key)
    if (!raw) return out
    const parsed = JSON.parse(raw) as { v?: number; pos?: Record<string, unknown> }
    if (!parsed || parsed.v !== POSITIONS_VERSION || !parsed.pos || typeof parsed.pos !== 'object') return out
    for (const [id, xy] of Object.entries(parsed.pos)) {
      if (Array.isArray(xy) && xy.length === 2 && Number.isFinite(xy[0]) && Number.isFinite(xy[1])) out.set(id, [xy[0] as number, xy[1] as number])
    }
  } catch { /* corrupt or blocked storage: behave as if nothing was stored */ }
  return out
}

/**
 * Persist the current positions. Pinned nodes store their pin; a node without a position is
 * skipped. Returns false when nothing was written (no storage, too many nodes, quota).
 */
export function savePositions(
  storage: StorageLike | null | undefined,
  key: string,
  nodes: Iterable<{ id: string; x?: number; y?: number; fx?: number; fy?: number }>,
  max = POSITIONS_MAX_NODES,
): boolean {
  if (!storage) return false
  const pos: Record<string, [number, number]> = {}
  let count = 0
  for (const n of nodes) {
    const x = typeof n.fx === 'number' ? n.fx : n.x
    const y = typeof n.fy === 'number' ? n.fy : n.y
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    pos[n.id] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10]
    if (++count > max) return false
  }
  if (count === 0) return false
  try {
    storage.setItem(key, JSON.stringify({ v: POSITIONS_VERSION, at: Date.now(), pos }))
    return true
  } catch {
    return false // quota or blocked storage
  }
}
