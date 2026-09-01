// reveal-wave1.ts — the deterministic Wave-1 for a reveal: connect the drop to EXISTING entities by
// name-match, no LLM. The scoped LLM extraction (Wave 2) under-pulls a short drop; but a drop routinely
// name-drops things the brain already knows ("walled data garden", "calibration ledger", "DUIN"). This
// finds those by scanning the drop text for existing entity labels and emits instant `alias`-source
// edges to their canonical nodes — so the reveal connects richly and immediately, and Wave 2's LLM edges
// layer on top. PURE (the caller injects the existing-entity set + the governance annotator).

import type { GraphFrame, EdgeSource } from './reveal-frames'

export interface ExistingEntity {
  id: string
  label: string
  kind?: string
}

export interface EntityMatch {
  id: string
  label: string
  kind?: string
}

/** True if `label` appears in the already-lowercased `text` as a whole token (ASCII word-boundary;
 *  CJK — which has no word chars at its edges — matches as a substring). Avoids "AI" matching inside
 *  "brain" etc. */
function labelPresent(lcText: string, lcLabel: string): boolean {
  let from = 0
  const isWord = (c: string): boolean => /[a-z0-9]/.test(c)
  for (;;) {
    const i = lcText.indexOf(lcLabel, from)
    if (i < 0) return false
    const before = i === 0 ? '' : lcText[i - 1]
    const after = i + lcLabel.length >= lcText.length ? '' : lcText[i + lcLabel.length]
    const leftOk = !before || !isWord(before) || !isWord(lcLabel[0])
    const rightOk = !after || !isWord(after) || !isWord(lcLabel[lcLabel.length - 1])
    if (leftOk && rightOk) return true
    from = i + 1
  }
}

/** PURE — the existing entities whose label is name-dropped in `text`. Skips very short labels (noise:
 *  "AI", "ME"), dedups by id, caps the count. */
export function matchExistingEntities(
  text: string,
  entities: ExistingEntity[],
  opts?: { minLabel?: number; cap?: number }
): EntityMatch[] {
  const min = opts?.minLabel ?? 3
  const cap = opts?.cap ?? 20
  const lc = (text || '').toLowerCase()
  if (!lc.trim()) return []
  const seen = new Set<string>()
  const out: EntityMatch[] = []
  for (const e of entities) {
    if (!e || !e.id || !e.label) continue
    const label = e.label.trim()
    if (label.length < min || seen.has(e.id)) continue
    if (labelPresent(lc, label.toLowerCase())) {
      seen.add(e.id)
      out.push({ id: e.id, label, kind: e.kind })
      if (out.length >= cap) break
    }
  }
  return out
}

/** PURE — Wave-1 frames for the matched existing entities: an entity-found (it already exists) + a
 *  deterministic `alias`-source link from the drop to it. The governance annotator (if given) stamps
 *  accept + confidence, same as Wave-2 edges. */
export function wave1Frames(
  matches: EntityMatch[],
  rootId: string,
  annotate?: (from: string, to: string, edgeType: string, src: EdgeSource) => { accept?: GraphFrame['accept']; confidence?: number }
): GraphFrame[] {
  const frames: GraphFrame[] = []
  for (const m of matches) {
    if (m.id === rootId) continue
    frames.push({ type: 'graph', op: 'entity-found', id: m.id, kind: m.kind ?? 'topic', label: m.label })
    const ann = annotate?.(rootId, m.id, 'mentions', 'alias') ?? {}
    frames.push({
      type: 'graph',
      op: 'link-formed',
      from: rootId,
      to: m.id,
      edgeType: 'mentions',
      src: 'alias',
      confidence: ann.confidence ?? 0.9,
      accept: ann.accept
    })
  }
  return frames
}
