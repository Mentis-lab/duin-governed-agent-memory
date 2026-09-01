// Brain graph color SCHEMES — named palettes for the home brain graph's
// kind→color map. Additive layer over the existing KIND_COLOR map in
// brain-shell.tsx: the "default" scheme reproduces today's colors exactly, so
// the out-of-box look is unchanged. Selectable in Settings → Appearance and
// persisted as `brainGraphScheme` in AppSettings.
//
// Each scheme maps the graph's node KINDS to dark-field-readable hex colors.
// brain-shell's colorOf() reads `KIND_COLOR.core`, `KIND_COLOR[person|org]`,
// and `KIND_COLOR[kind]` (product-layer nodes); link colors derive from the
// node colors, so swapping the map recolors links too. Keep every key the
// default map carries — a missing key falls back to the product-layer default
// (#94a3b8), which would silently drop a kind's color.

export type BrainGraphSchemeId =
  | 'default' | 'aurora' | 'ember' | 'mono'

export interface BrainGraphScheme {
  id: BrainGraphSchemeId
  name: string
  /** Short descriptor shown under the name in the picker. */
  source: string
  /** kind → hex. Must cover every key the default map covers. */
  colors: Record<string, string>
  /** A few representative colors for the picker swatch row. */
  swatch: string[]
}

// The default map — byte-for-byte the historical KIND_COLOR literal from
// brain-shell.tsx. brain-shell imports DEFAULT_KIND_COLOR from here so the two
// can never drift.
export const DEFAULT_KIND_COLOR: Record<string, string> = {
  core: '#e2e8f0', goal: '#fde047', kr: '#fde68a', event: '#fbbf24', milestone: '#fbbf24', release: '#fbbf24', project: '#38bdf8', track: '#2dd4bf', strategy: '#a78bfa',
  move: '#34d399', risk: '#fb7185', issue: '#f59e0b', owed: '#60a5fa', insight: '#22d3ee',
  person: '#94a3b8', org: '#818cf8', task: '#fb923c', card: '#bef264', decision: '#c084fc', prediction: '#f472b6', page: '#4ade80',
  product: '#f0abfc', place: '#5eead4',
}

export const BRAIN_GRAPH_SCHEMES: BrainGraphScheme[] = [
  {
    id: 'default',
    name: 'Default',
    source: 'Original DUIN palette',
    colors: DEFAULT_KIND_COLOR,
    swatch: ['#e2e8f0', '#fde047', '#38bdf8', '#2dd4bf', '#a78bfa', '#fb7185'],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    source: 'Blue · purple · teal',
    colors: {
      core: '#e0e7ff', goal: '#818cf8', kr: '#a5b4fc', event: '#60a5fa', milestone: '#60a5fa', release: '#60a5fa', project: '#38bdf8', track: '#2dd4bf', strategy: '#a78bfa',
      move: '#5eead4', risk: '#f0abfc', issue: '#7dd3fc', owed: '#93c5fd', insight: '#67e8f9',
      person: '#94a3b8', org: '#818cf8', task: '#7dd3fc', card: '#99f6e4', decision: '#c4b5fd', prediction: '#d8b4fe', page: '#5eead4',
      product: '#f0abfc', place: '#5eead4',
    },
    swatch: ['#e0e7ff', '#818cf8', '#38bdf8', '#2dd4bf', '#a78bfa', '#67e8f9'],
  },
  {
    id: 'ember',
    name: 'Ember',
    source: 'Red · orange · amber',
    colors: {
      core: '#fff7ed', goal: '#fbbf24', kr: '#fcd34d', event: '#fb923c', milestone: '#fb923c', release: '#fb923c', project: '#f97316', track: '#f59e0b', strategy: '#fb7185',
      move: '#fdba74', risk: '#ef4444', issue: '#f59e0b', owed: '#fca5a5', insight: '#fde047',
      person: '#a8a29e', org: '#e879a6', task: '#fb923c', card: '#fcd34d', decision: '#f9a8d4', prediction: '#f472b6', page: '#a3e635',
      product: '#f9a8d4', place: '#a3e635',
    },
    swatch: ['#fff7ed', '#fbbf24', '#fb923c', '#f97316', '#ef4444', '#fb7185'],
  },
  {
    id: 'mono',
    name: 'Mono',
    source: 'Grayscale · minimal',
    colors: {
      core: '#f8fafc', goal: '#e2e8f0', kr: '#cbd5e1', event: '#cbd5e1', milestone: '#cbd5e1', release: '#cbd5e1', project: '#94a3b8', track: '#64748b', strategy: '#b0b8c4',
      move: '#cbd5e1', risk: '#e2e8f0', issue: '#cbd5e1', owed: '#94a3b8', insight: '#cbd5e1',
      person: '#94a3b8', org: '#64748b', task: '#94a3b8', card: '#cbd5e1', decision: '#b0b8c4', prediction: '#94a3b8', page: '#cbd5e1',
      product: '#cbd5e1', place: '#94a3b8',
    },
    swatch: ['#f8fafc', '#e2e8f0', '#cbd5e1', '#94a3b8', '#64748b', '#475569'],
  },
]

const SCHEME_BY_ID: Record<string, BrainGraphScheme> = Object.fromEntries(
  BRAIN_GRAPH_SCHEMES.map((s) => [s.id, s]),
)

export const DEFAULT_BRAIN_GRAPH_SCHEME: BrainGraphSchemeId = 'default'

/** Resolve a scheme id (possibly undefined / unknown) to its kind→color map,
 *  always falling back to the default palette. */
export function getSchemeColors(id: string | undefined): Record<string, string> {
  return (SCHEME_BY_ID[id || ''] || SCHEME_BY_ID.default).colors
}

// The original folder-hash palette (mirrors graph-colors.ts PALETTE) — so the
// DEFAULT scheme keeps its exact historical folder coloring.
const ORIGINAL_FOLDER_PALETTE = [
  '#8b7cf6', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#22d3ee', '#a78bfa',
  '#4ade80', '#fb923c', '#e879f9', '#2dd4bf', '#facc15', '#38bdf8', '#c084fc', '#fca5a5',
]

/** Folder/group cycling palette for a scheme. Most graph nodes are vault notes
 *  colored BY FOLDER (not by kind), so this is what actually recolors the bulk of
 *  the field when the scheme changes. Default returns the original palette (look
 *  unchanged); other schemes derive a family-consistent palette from their own
 *  kind colors, so switching schemes visibly recolors the whole graph. */
export function getSchemePalette(id: string | undefined): string[] {
  if (!id || id === 'default') return ORIGINAL_FOLDER_PALETTE
  const c = (SCHEME_BY_ID[id] || SCHEME_BY_ID.default).colors
  const derived = [
    c.strategy, c.project, c.track, c.move, c.goal, c.insight, c.decision,
    c.org, c.task, c.card, c.risk, c.prediction, c.kr, c.event, c.owed, c.issue,
  ].filter(Boolean)
  return derived.length >= 6 ? derived : ORIGINAL_FOLDER_PALETTE
}
