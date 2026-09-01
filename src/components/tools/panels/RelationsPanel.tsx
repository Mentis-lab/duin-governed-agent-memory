import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@/components/ui/Button'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { useBrainStore } from '@/stores/brain-store'
import { toast } from '@/stores/toast-store'

// Relations — the ego-centric entity/belief surface over the persistent entity
// plane (PLANNING/DUIN_RELATIONS_SURFACE_DESIGN.md §4/§5). Pick an entity and the
// canvas re-forms around it: inbound neighbors in a left column, outbound in a
// right column, typed + labeled edges. Type tabs itemize the population; the
// drawer shows a node's connections — and for beliefs, the GOVERN block
// (promote/veto), so the map is where memory is adjudicated, not just admired.
//
// Deliberately NOT the BrainMap: this reads the capped ego payload from
// brain:entityGraph, never the 1.5 MB whole-graph blob. Selecting here drives the
// ambient map's dimming one-way via brain-store.focusNode (Q2).

// ── the IPC contract this panel consumes ─────────────────────────────────────
// brain:entityGraph is being added by the seam-edges backend work. Typed LOCALLY
// (LearningPanel precedent) rather than in preload types, and reached through an
// accessor so a build without the handler degrades to a friendly empty state
// instead of crashing.

interface EgoNode {
  id: string
  label: string
  kind: string
  source: string
  beliefCount?: number
}
interface EgoEdge {
  src: string
  dst: string
  type: string
  /** Relative to the anchor's hop: 'in' flows toward the anchor, 'out' away. */
  dir: 'in' | 'out'
}
interface EgoBelief {
  factId: string
  text: string
  kind: string
  status: string
}
interface EgoGraph {
  anchor: string
  nodes: EgoNode[]
  edges: EgoEdge[]
  stats: { nodes: number; edges: number; truncated: boolean }
  beliefs: EgoBelief[]
}

type EntityGraphFn = (
  anchor: string,
  depth?: number
) => Promise<{ success: boolean; data?: EgoGraph; error?: string }>

function entityGraphApi(): EntityGraphFn | undefined {
  return (window as unknown as { api?: { brain?: { entityGraph?: EntityGraphFn } } }).api?.brain
    ?.entityGraph
}

interface OperatorApi {
  promote?: (id: string, reason?: string) => Promise<{ success: boolean; data?: boolean; error?: string }>
  veto?: (id: string, reason?: string) => Promise<{ success: boolean; data?: boolean; error?: string }>
  onChanged?: (cb: (facts: unknown[]) => void) => () => void
}
function operatorApi(): OperatorApi | undefined {
  return (window as unknown as { api?: { operator?: OperatorApi } }).api?.operator
}

// ── layout ────────────────────────────────────────────────────────────────────
// Columnar by hop (md2hd's reading order), no dagre: inbound column left, anchor
// center, outbound right; deeper hops keep walking outward in their column family.

const COL_W = 300
const ROW_H = 90
const NODE_W = 200

function layoutPositions(graph: EgoGraph): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const ids = new Set(graph.nodes.map((n) => n.id))
  const adj = new Map<string, { other: string; dir: 'in' | 'out' }[]>()
  const add = (a: string, other: string, dir: 'in' | 'out'): void => {
    const list = adj.get(a) ?? []
    list.push({ other, dir })
    adj.set(a, list)
  }
  for (const e of graph.edges) {
    add(e.src, e.dst, e.dir)
    add(e.dst, e.src, e.dir)
  }

  // BFS out from the anchor. Hop-1 nodes take the side their edge points
  // (inbound → left, outbound → right); deeper hops inherit their discovery
  // parent's side so a chain stays in one column family.
  const hop = new Map<string, number>([[graph.anchor, 0]])
  const side = new Map<string, number>([[graph.anchor, 0]])
  const queue: string[] = [graph.anchor]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    const curHop = hop.get(cur) ?? 0
    for (const { other, dir } of adj.get(cur) ?? []) {
      if (!ids.has(other) || hop.has(other)) continue
      hop.set(other, curHop + 1)
      side.set(other, curHop === 0 ? (dir === 'in' ? -1 : 1) : (side.get(cur) ?? 1))
      queue.push(other)
    }
  }

  // Column buckets: signed hop → x. Rows spread vertically around the anchor line.
  const buckets = new Map<number, string[]>()
  for (const n of graph.nodes) {
    if (n.id === graph.anchor || !hop.has(n.id)) continue
    const key = (side.get(n.id) ?? 1) * (hop.get(n.id) ?? 1)
    const list = buckets.get(key) ?? []
    list.push(n.id)
    buckets.set(key, list)
  }
  pos.set(graph.anchor, { x: 0, y: 0 })
  let maxY = 0
  for (const [key, list] of buckets) {
    list.forEach((id, i) => {
      const y = (i - (list.length - 1) / 2) * ROW_H
      pos.set(id, { x: key * COL_W, y })
      maxY = Math.max(maxY, Math.abs(y))
    })
  }
  // Nodes whose connecting edges were clipped by the fan-out cap still deserve a
  // spot — park them in a quiet band under the columns rather than dropping them.
  const orphans = graph.nodes.filter((n) => !pos.has(n.id))
  orphans.forEach((n, i) => {
    pos.set(n.id, {
      x: ((i % 3) - 1) * COL_W,
      y: maxY + ROW_H * 1.5 + Math.floor(i / 3) * ROW_H
    })
  })
  return pos
}

// ── canvas node card ──────────────────────────────────────────────────────────

interface RelNodeData extends Record<string, unknown> {
  label: string
  kind: string
  beliefCount?: number
  isAnchor: boolean
  highlight: boolean
}

/** Handles must exist or xyflow draws no edges at all (see CanvasEditor). This
 *  canvas is read-only, so they render invisibly small. */
const HANDLE_CLS = '!h-1 !w-1 !min-h-0 !min-w-0 !border-none !bg-transparent'

function RelNode({ data }: NodeProps): ReactElement {
  const d = data as RelNodeData
  return (
    <div
      style={{ width: NODE_W }}
      title={d.isAnchor ? `${d.label} — anchor` : `Re-anchor on ${d.label}`}
      className={
        'cursor-pointer rounded-lg border bg-[var(--panel-bg)] px-2.5 py-2 ' +
        (d.isAnchor
          ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]'
          : d.highlight
            ? 'border-[var(--accent)]/70 bg-[var(--bg-tertiary)]'
            : 'border-[var(--panel-border)]')
      }
    >
      <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{d.label}</div>
      <div className="mt-1 flex items-center gap-1.5">
        <span className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {d.kind}
        </span>
        {typeof d.beliefCount === 'number' && d.beliefCount > 0 && (
          <span className="rounded-full bg-[var(--accent)]/15 px-1.5 py-px text-[10px] font-medium text-[var(--accent)]">
            {d.beliefCount} belief{d.beliefCount === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <Handle type="target" id="t-l" position={Position.Left} className={HANDLE_CLS} />
      <Handle type="target" id="t-r" position={Position.Right} className={HANDLE_CLS} />
      <Handle type="source" id="s-l" position={Position.Left} className={HANDLE_CLS} />
      <Handle type="source" id="s-r" position={Position.Right} className={HANDLE_CLS} />
    </div>
  )
}

// Module-scope so the object identity is stable — xyflow remounts every node when
// nodeTypes changes identity (same reason CanvasEditor pins its map).
const NODE_TYPES = { relNode: RelNode }

// ── chips ─────────────────────────────────────────────────────────────────────
// Operator-fact statuses (see LearningPanel): candidate/provisional are proving
// out, promoted is a governing rule, vetoed/reverted are retracted.

const STATUS_CHIP: Record<string, string> = {
  promoted: 'bg-[var(--accent)]/15 text-[var(--accent)]',
  candidate: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  provisional: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
  vetoed: 'bg-[var(--error)]/10 text-[var(--error)]',
  reverted: 'bg-[var(--error)]/10 text-[var(--error)]'
}
const statusChip = (status: string): string =>
  'rounded-full px-1.5 py-px text-[10px] font-medium ' +
  (STATUS_CHIP[status] ?? 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')

const kindChip =
  'rounded-full bg-[var(--bg-tertiary)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--text-muted)]'

type DrawerSelection = { type: 'node'; id: string } | { type: 'belief'; factId: string }

const DEPTHS = [1, 2, 3] as const

function RelationsPanelInner(): ReactElement {
  const focusNode = useBrainStore((s) => s.focusNode)
  // Q1: open on the last focused entity when there is one; otherwise the empty
  // state asks for one (the backend resolves ids AND labels — nothing hardcoded).
  // Internal index nodes (`__projidx__…` and friends) are excluded: opening a note
  // focuses its folder's projidx node, and seeding THAT here guaranteed a raw
  // internal id in the input and an empty "0 nodes · 0 edges" ego view (QA
  // 2026-08-24, F9). The empty state's "pick an entity" copy is strictly better.
  const [anchor, setAnchor] = useState<string | null>(() => {
    const id = useBrainStore.getState().focusId
    return id && !id.startsWith('__') ? id : null
  })
  const [depth, setDepth] = useState<(typeof DEPTHS)[number]>(1)
  const [graph, setGraph] = useState<EgoGraph | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queryText, setQueryText] = useState('')
  const [tab, setTab] = useState<string | null>(null)
  const [selected, setSelected] = useState<DrawerSelection | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [governing, setGoverning] = useState<'promote' | 'veto' | null>(null)
  // Ignore out-of-order responses when the user re-anchors mid-flight.
  const seqRef = useRef(0)
  // Set when the anchor was typed (a label, not an id) — the resolved id only
  // exists after the fetch, so the Q2 focus sync happens on load completion.
  const syncFocusRef = useRef(false)

  const available = Boolean(entityGraphApi())

  const load = useCallback(
    async (a: string, d: number): Promise<void> => {
      const fn = entityGraphApi()
      if (!fn) return
      const seq = ++seqRef.current
      setLoading(true)
      const r = await query('entity graph', () => fn(a, d))
      if (seq !== seqRef.current) return
      setLoading(false)
      if (r.ok) {
        setGraph(r.data)
        setError(null)
        const anchorNode = r.data.nodes.find((n) => n.id === r.data.anchor)
        setQueryText(anchorNode?.label ?? a)
        if (syncFocusRef.current) {
          syncFocusRef.current = false
          focusNode(r.data.anchor)
        }
      } else {
        setError(r.error)
      }
    },
    [focusNode]
  )

  useEffect(() => {
    if (anchor && available) void load(anchor, depth)
  }, [anchor, depth, available, load])

  // Live refresh: promote/veto from THIS drawer, another window, or the automatic
  // govern loop all land here. Returns an unsubscribe — clean up on unmount.
  useEffect(() => {
    if (!anchor) return
    const unsubscribe = operatorApi()?.onChanged?.(() => void load(anchor, depth))
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [anchor, depth, load])

  // Q2 focus sync: selecting here drives the ambient BrainMap's dimming (one-way).
  const reanchor = useCallback(
    (id: string): void => {
      setSelected(null)
      setReason('')
      focusNode(id)
      // Re-anchoring on the current anchor is a refresh, not a state change.
      if (anchor === id) void load(id, depth)
      else setAnchor(id)
    },
    [focusNode, anchor, depth, load]
  )

  const submitAnchor = (): void => {
    const q = queryText.trim()
    if (!q) return
    setSelected(null)
    setReason('')
    syncFocusRef.current = true
    if (anchor === q) void load(q, depth)
    else setAnchor(q)
  }

  const onNodeClick = useCallback(
    (_e: React.MouseEvent, node: Node): void => {
      if (!graph) return
      if (node.id === graph.anchor) setSelected({ type: 'node', id: node.id })
      else reanchor(node.id)
    },
    [graph, reanchor]
  )

  const govern = async (action: 'promote' | 'veto', factId: string): Promise<void> => {
    if (governing) return
    const op = operatorApi()
    const call = action === 'promote' ? op?.promote : op?.veto
    setGoverning(action)
    try {
      const why = reason.trim()
      await invoke(`${action} belief`, call ? () => call(factId, why || undefined) : undefined)
      // promoteFact is the HUMAN gate: it puts the fact on PROBATION (provisional); the govern
      // loop's dual verifier is what confirms it to 'promoted'. Say so.
      toast.success(action === 'promote' ? 'Endorsed — on probation until the govern loop confirms' : 'Vetoed')
      setReason('')
      // onChanged also fires, but refresh eagerly so the chips move NOW.
      if (anchor) void load(anchor, depth)
    } catch (e) {
      toast.error(describeError(e, `Could not ${action} that belief`))
    } finally {
      setGoverning(null)
    }
  }

  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph]
  )

  const { flowNodes, flowEdges } = useMemo(() => {
    if (!graph) return { flowNodes: [] as Node<RelNodeData>[], flowEdges: [] as Edge[] }
    const pos = layoutPositions(graph)
    const flowNodes: Node<RelNodeData>[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'relNode',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      draggable: false,
      data: {
        label: n.label,
        kind: n.kind,
        beliefCount: n.beliefCount,
        isAnchor: n.id === graph.anchor,
        highlight: n.id === hoverId
      }
    }))
    const xOf = (id: string): number => pos.get(id)?.x ?? 0
    const flowEdges: Edge[] = graph.edges
      // An edge whose endpoint was clipped out of `nodes` cannot render.
      .filter((e) => nodeById.has(e.src) && nodeById.has(e.dst))
      .map((e, i) => {
        const ltr = xOf(e.src) <= xOf(e.dst)
        return {
          id: `e${i}:${e.src}->${e.dst}`,
          source: e.src,
          target: e.dst,
          sourceHandle: ltr ? 's-r' : 's-l',
          targetHandle: ltr ? 't-l' : 't-r',
          label: e.type,
          labelStyle: { fill: '#b9b9d0', fontSize: 11 },
          labelBgStyle: { fill: 'var(--panel-bg)', fillOpacity: 0.85 }
        }
      })
    return { flowNodes, flowEdges }
  }, [graph, hoverId, nodeById])

  // Type tabs: the kinds actually present (largest population first) + Beliefs.
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const n of graph?.nodes ?? []) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [graph])
  const beliefs = graph?.beliefs ?? []
  const activeTab =
    tab !== null && (tab === 'beliefs' || kinds.some(([k]) => `kind:${k}` === tab))
      ? tab
      : kinds.length > 0
        ? `kind:${kinds[0][0]}`
        : 'beliefs'

  // Drawer selection, resolved against the CURRENT payload — a belief vetoed away
  // or a node re-anchored out simply falls back to the tab list.
  const selectedNode =
    selected?.type === 'node' ? (graph?.nodes.find((n) => n.id === selected.id) ?? null) : null
  const selectedBelief =
    selected?.type === 'belief'
      ? (graph?.beliefs.find((b) => b.factId === selected.factId) ?? null)
      : null

  // The selected node's connection lists, labels resolved through `nodeById`.
  const inboundEdges =
    selectedNode && graph ? graph.edges.filter((e) => e.dst === selectedNode.id) : []
  const outboundEdges =
    selectedNode && graph ? graph.edges.filter((e) => e.src === selectedNode.id) : []

  const tabButton = (id: string, label: string, count: number): ReactElement => {
    const active = id === activeTab
    return (
      <button
        key={id}
        role="tab"
        aria-selected={active}
        onClick={() => {
          setSelected(null)
          setTab(id)
        }}
        className={
          'shrink-0 rounded-md px-2 py-1 text-[12px] transition-colors ' +
          (active
            ? 'bg-[var(--accent)] font-medium text-white'
            : 'text-[var(--text-secondary)] hover:bg-[var(--panel-border)]/40 hover:text-[var(--text-primary)]')
        }
      >
        {label}
        <span
          className={
            'ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ' +
            (active ? 'bg-white/20 text-white' : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]')
          }
        >
          {count}
        </span>
      </button>
    )
  }

  const edgeRow = (key: string, otherId: string, type: string): ReactElement => {
    const other = nodeById.get(otherId)
    return (
      <button
        key={key}
        type="button"
        onClick={() => reanchor(otherId)}
        onMouseEnter={() => setHoverId(otherId)}
        onMouseLeave={() => setHoverId((h) => (h === otherId ? null : h))}
        title={`Re-anchor on ${other?.label ?? otherId}`}
        className="flex w-full items-center gap-2 px-1 py-1 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
      >
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
          {other?.label ?? otherId}
        </span>
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{type}</span>
      </button>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      {/* xyflow ships a light-themed control cluster; scope the override here so
          it travels with the component (same treatment as CanvasEditor). */}
      <style>{`
        .rel-flow .react-flow__controls{box-shadow:none}
        .rel-flow .react-flow__controls-button{background:var(--panel-bg);border-bottom:1px solid var(--panel-border);fill:var(--text-secondary)}
        .rel-flow .react-flow__controls-button:hover{background:var(--bg-tertiary)}
        .rel-flow .react-flow__attribution{background:transparent;color:var(--text-muted);opacity:.35;font-size:10px}
      `}</style>

      {/* Anchor picker + depth dial */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
        <input
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAnchor()
          }}
          placeholder={t('Entity id or label…')}
          aria-label={t('Anchor entity')}
          disabled={!available}
          className="h-7 min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--app-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-50"
        />
        <div
          role="group"
          aria-label={t('Neighborhood depth')}
          className="flex shrink-0 items-center overflow-hidden rounded-md border border-[var(--panel-border)]"
        >
          {DEPTHS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={depth === d}
              title={`Depth ${d}`}
              onClick={() => setDepth(d)}
              className={
                'px-2 py-1 text-[11px] transition-colors ' +
                (depth === d
                  ? 'bg-[var(--accent)] font-medium text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]')
              }
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="mx-3 mt-2 shrink-0 rounded-md border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[12px] text-[var(--error)]"
        >
          Couldn&rsquo;t load relations: {error}
          <button
            type="button"
            onClick={() => {
              if (anchor) void load(anchor, depth)
            }}
            className="ml-2 underline hover:opacity-80"
          >
            {t('Retry')}
          </button>
        </div>
      )}

      {graph && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-1 text-[11px] text-[var(--text-muted)]">
          <span>
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </span>
          {graph.stats.truncated && (
            <span
              title={t("The neighborhood was clipped by the fan-out/total caps — not everything is shown. Re-anchor closer to what you're after.")}
              className="rounded-full bg-[var(--warning,#d97706)]/15 px-1.5 py-px text-[10px] font-medium text-[var(--warning,#d97706)]"
            >
              clipped
            </span>
          )}
          {loading && <span>refreshing…</span>}
        </div>
      )}

      {/* Ego canvas */}
      <div className="min-h-0 flex-1">
        {!available ? (
          <PanelEmptyState
            title={t('Relations backend not available')}
            body="This build has no entity-graph handler yet. Once the brain exposes it, this surface lights up on its own."
          />
        ) : !anchor ? (
          <PanelEmptyState
            title={t('Pick an entity')}
            body="Type an entity name or id above and press Enter — the canvas re-forms around it: inbound on the left, outbound on the right."
          />
        ) : !graph ? (
          <div className="p-3 text-[12px] text-[var(--text-muted)]">
            {error ? 'Nothing to show.' : 'Loading relations…'}
          </div>
        ) : (
          <ReactFlow
            // Remount per anchor/depth so the initial fitView re-fits each new ego
            // view; belief-only refreshes keep the viewport where the user put it.
            key={`${graph.anchor}|${depth}`}
            className="rel-flow"
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            onNodeClick={onNodeClick}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            minZoom={0.15}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed, color: '#5a5a7a' },
              style: { stroke: '#5a5a7a', strokeWidth: 1.5 }
            }}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>

      {/* Bottom strip: type tabs + population list, or the detail drawer. */}
      {graph && (
        <div className="flex max-h-[280px] shrink-0 flex-col border-t border-[var(--panel-border)]">
          {selectedNode || selectedBelief ? (
            <div className="flex min-h-0 flex-col">
              <div className="flex shrink-0 items-start gap-2 px-3 pb-1 pt-2">
                <div className="min-w-0 flex-1">
                  {selectedNode ? (
                    <>
                      <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
                        {selectedNode.label}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className={kindChip}>{selectedNode.kind}</span>
                        <span className="text-[11px] text-[var(--text-muted)]">
                          source: {selectedNode.source}
                        </span>
                        {typeof selectedNode.beliefCount === 'number' && (
                          <span className="text-[11px] text-[var(--text-muted)]">
                            · {selectedNode.beliefCount} belief
                            {selectedNode.beliefCount === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    selectedBelief && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-[var(--text-primary)]">
                          {t('Belief')}
                        </span>
                        <span className={kindChip}>{selectedBelief.kind}</span>
                        <span className={statusChip(selectedBelief.status)}>
                          {selectedBelief.status}
                        </span>
                      </div>
                    )
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null)
                    setReason('')
                  }}
                  title={t('Close details')}
                  aria-label={t('Close details')}
                  className="shrink-0 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              <div className="min-h-0 overflow-y-auto px-3 pb-3">
                {selectedNode && (
                  <>
                    <div className="mb-0.5 mt-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      Inbound ({inboundEdges.length})
                    </div>
                    {inboundEdges.length === 0 && (
                      <p className="px-1 py-0.5 text-[11px] text-[var(--text-muted)]">none</p>
                    )}
                    <div className="divide-y divide-[var(--panel-border)]">
                      {inboundEdges.map((e, i) => edgeRow(`in${i}`, e.src, e.type))}
                    </div>
                    <div className="mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      Outbound ({outboundEdges.length})
                    </div>
                    {outboundEdges.length === 0 && (
                      <p className="px-1 py-0.5 text-[11px] text-[var(--text-muted)]">none</p>
                    )}
                    <div className="divide-y divide-[var(--panel-border)]">
                      {outboundEdges.map((e, i) => edgeRow(`out${i}`, e.dst, e.type))}
                    </div>
                  </>
                )}

                {selectedBelief && (
                  <>
                    <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text-primary)]">
                      {selectedBelief.text}
                    </p>
                    {/* GOVERN block — adjudication goes THROUGH the loop: promote/veto
                        → seam hook → auto-reconcile → this panel's own data refreshes. */}
                    <div className="mt-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder={t('Reason (optional)')}
                        aria-label={t('Govern reason')}
                        className="mb-2 h-7 w-full rounded border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                      />
                      <div className="flex items-center gap-1.5">
                        {selectedBelief.status !== 'promoted' && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={governing !== null}
                            onClick={() => void govern('promote', selectedBelief.factId)}
                          >
                            {governing === 'promote' ? 'Promoting…' : 'Promote'}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={governing !== null || selectedBelief.status === 'vetoed'}
                          onClick={() => void govern('veto', selectedBelief.factId)}
                        >
                          {governing === 'veto' ? 'Vetoing…' : 'Veto'}
                        </Button>
                        <span className="text-[11px] text-[var(--text-muted)]">
                          {selectedBelief.status === 'promoted'
                            ? 'Already a governing rule — veto retracts it.'
                            : selectedBelief.status === 'provisional'
                              ? 'On probation — endorse again or veto to retract.'
                              : 'Endorse onto probation, or veto to retract.'}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div
                role="tablist"
                aria-label={t('Relations population')}
                className="flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5"
              >
                {kinds.map(([kind, count]) => tabButton(`kind:${kind}`, kind, count))}
                {tabButton('beliefs', 'Beliefs', beliefs.length)}
              </div>
              <div className="min-h-0 overflow-y-auto">
                {activeTab === 'beliefs' ? (
                  beliefs.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] text-[var(--text-muted)]">
                      {t('No operator beliefs touch this entity yet.')}
                    </p>
                  ) : (
                    <div className="divide-y divide-[var(--panel-border)]">
                      {beliefs.map((b) => (
                        <button
                          key={b.factId}
                          type="button"
                          onClick={() => {
                            setReason('')
                            setSelected({ type: 'belief', factId: b.factId })
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                            {b.text}
                          </span>
                          <span className={statusChip(b.status)}>{b.status}</span>
                        </button>
                      ))}
                    </div>
                  )
                ) : (
                  <div className="divide-y divide-[var(--panel-border)]">
                    {graph.nodes
                      .filter((n) => `kind:${n.kind}` === activeTab)
                      .map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() =>
                            n.id === graph.anchor
                              ? setSelected({ type: 'node', id: n.id })
                              : reanchor(n.id)
                          }
                          onMouseEnter={() => setHoverId(n.id)}
                          onMouseLeave={() => setHoverId((h) => (h === n.id ? null : h))}
                          title={n.id === graph.anchor ? 'Show details' : `Re-anchor on ${n.label}`}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">
                            {n.label}
                          </span>
                          {n.id === graph.anchor && (
                            <span className="rounded-full bg-[var(--accent)]/15 px-1.5 py-px text-[10px] font-medium text-[var(--accent)]">
                              anchor
                            </span>
                          )}
                          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
                            {n.source}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function RelationsPanel(): ReactElement {
  return (
    <ReactFlowProvider>
      <RelationsPanelInner />
    </ReactFlowProvider>
  )
}
