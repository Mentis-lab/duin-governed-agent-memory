import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  Handle,
  MarkerType,
  Position,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { parseCanvas } from '../../../electron/services/canvas/canvas-outline'
import {
  BLOCK_NODE,
  GROUP_NODE,
  type FlowNodeData,
  fromFlow,
  newId,
  serializeCanvas,
  toFlowEdges,
  toFlowNodes
} from '@/lib/canvas-flow'

// In-app JSON Canvas editor. Lives in the RENDERER (like VisualHtmlEditor), not
// in the artifact sandbox — the sandbox is a separate WebContentsView with no
// channel back to the app, which is what made editing there look expensive.
// Here we have normal React state and IPC.
//
// The file on disk stays JSON Canvas 1.0, so a blueprint edited here is still
// read by the outline serializer, the retriever, and any other JSON Canvas tool.

const PRESET_COLORS: Record<string, string> = {
  '1': '#e5534b',
  '2': '#d9863b',
  '3': '#d9c04b',
  '4': '#4bb563',
  '5': '#3fb0c9',
  '6': '#a970d1'
}
const SWATCHES = ['', '1', '2', '3', '4', '5', '6']

function accentOf(data: FlowNodeData): string {
  const c = (data.color ?? '').trim()
  if (PRESET_COLORS[c]) return PRESET_COLORS[c]
  if (/^#[0-9a-f]{3,8}$/i.test(c)) return c
  return 'var(--panel-border)'
}

/** What a bound block shows. Mirrors the read-only renderer's labelling so the
 *  editor and the preview never disagree about what a block IS. */
function blockLabel(data: FlowNodeData): string {
  if (data.canvasType === 'file') return `note ${data.file ?? ''}${data.subpath ?? ''}`
  if (data.canvasType === 'link') {
    const url = data.url ?? ''
    const m = /^duin:\/\/(skill|tool|node|entity)\/(.+)$/i.exec(url)
    if (m) return `${m[1].toLowerCase() === 'node' ? 'entity' : m[1].toLowerCase()} ${m[2]}`
    return url
  }
  return data.text ?? ''
}

/** Connection points. WITHOUT THESE xyflow renders no edges at all and offers no
 *  way to draw one — the edge data survives the round trip but the diagram looks
 *  disconnected. Every side carries both a source and a target so a blueprint can
 *  flow in any direction, which is how people actually arrange boxes. */
const SIDES = [
  { pos: Position.Top, key: 'top' },
  { pos: Position.Right, key: 'right' },
  { pos: Position.Bottom, key: 'bottom' },
  { pos: Position.Left, key: 'left' }
] as const

function NodeHandles(): ReactElement {
  return (
    <>
      {SIDES.map(({ pos, key }) => (
        <span key={key}>
          <Handle
            type="target"
            id={`t-${key}`}
            position={pos}
            className="!h-2 !w-2 !border-none !bg-[var(--text-muted)] opacity-40"
          />
          <Handle
            type="source"
            id={`s-${key}`}
            position={pos}
            className="!h-2 !w-2 !border-none !bg-[var(--accent)] opacity-60"
          />
        </span>
      ))}
    </>
  )
}

function BlockNode({ id, data, selected }: NodeProps): ReactElement {
  const d = data as FlowNodeData
  // EVERY block kind is editable — a `file` block with no path and no way to
  // set one is the state the first build shipped in, and it made the binding
  // kinds useless. text edits `text`; file edits `file`; link edits `url`.
  const field: 'text' | 'file' | 'url' =
    d.canvasType === 'file' ? 'file' : d.canvasType === 'link' ? 'url' : 'text'
  const current = (field === 'file' ? d.file : field === 'url' ? d.url : d.text) ?? ''
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  return (
    <div
      className="h-full w-full overflow-hidden rounded-lg border bg-[var(--panel-bg)] p-2.5 text-[13px] leading-snug text-[var(--text-primary)]"
      style={{ borderColor: accentOf(d), outline: selected ? '2px solid var(--accent)' : 'none' }}
      onDoubleClick={() => setEditing(true)}
    >
      {d.canvasType !== 'text' && (
        <span className="mb-1 inline-block rounded-full bg-[var(--bg-tertiary)] px-1.5 py-px text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
          {d.canvasType === 'file' ? 'note' : 'link'}
        </span>
      )}
      {editing ? (
        <textarea
          ref={ref}
          defaultValue={current}
          placeholder={
            field === 'file'
              ? 'vault path, e.g. 05 Decisions/x.md'
              : field === 'url'
                ? 'https://… or duin://skill/name or duin://tool/id'
                : ''
          }
          onBlur={(e) => {
            setEditing(false)
            window.dispatchEvent(
              new CustomEvent('canvas-node-field', {
                detail: { id, field, value: e.target.value }
              })
            )
          }}
          className="h-full w-full resize-none bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
      ) : (
        <div className="whitespace-pre-wrap break-words">
          {blockLabel(d) || <span className="text-[var(--text-muted)]">double-click to set</span>}
        </div>
      )}
      <NodeHandles />
    </div>
  )
}

function GroupNode({ data, selected }: NodeProps): ReactElement {
  const d = data as FlowNodeData
  const accent = accentOf(d)
  return (
    <div
      className="h-full w-full rounded-xl border border-dashed bg-white/[0.02]"
      style={{ borderColor: accent, outline: selected ? '2px solid var(--accent)' : 'none' }}
    >
      <span
        className="absolute -top-2.5 left-3 bg-[var(--app-bg)] px-1.5 text-[11px] font-semibold"
        style={{ color: accent }}
      >
        {d.label || 'group'}
      </span>
    </div>
  )
}

const NODE_TYPES = { [BLOCK_NODE]: BlockNode, [GROUP_NODE]: GroupNode }

/** What the "+" buttons can create. `note` and `link` are the BINDING kinds —
 *  they are what makes a block point at a vault note, a skill, or a capability
 *  rather than just carry prose. */
export type BlockKind = 'text' | 'note' | 'link' | 'group'

interface CanvasEditorProps {
  /** Canvas JSON. */
  value: string
  /** Fires on every structural edit with the new canvas JSON. */
  onChange: (next: string) => void
  /** When this editor is bound to an existing vault file, Save writes BACK to
   *  that path instead of filing a new blueprint by name under Canvases/.
   *  Editing one file in two places must not fork it into two. */
  fileRel?: string
}

function CanvasEditorInner({ value, onChange, fileRel }: CanvasEditorProps): ReactElement {
  const initial = useMemo(() => {
    try {
      return parseCanvas(value)
    } catch {
      return { nodes: [], edges: [] }
    }
  }, [value])

  const [nodes, setNodes] = useState<Node<FlowNodeData>[]>(() => toFlowNodes(initial))
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(initial))
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)
  /** Set once an unsaved blueprint has been filed, so "Open window" — which
   *  addresses a canvas by PATH — has something to open. */
  const [savedRel, setSavedRel] = useState<string | null>(null)

  // Push every edit up as canvas JSON so Preview and Download stay in sync with
  // what is on screen.
  const emit = useCallback(
    (ns: Node<FlowNodeData>[], es: Edge[]) => onChange(serializeCanvas(fromFlow(ns, es))),
    [onChange]
  )

  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((cur) => {
        const next = applyNodeChanges(changes, cur) as Node<FlowNodeData>[]
        emit(next, edges)
        return next
      }),
    [edges, emit]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((cur) => {
        const next = applyEdgeChanges(changes, cur)
        emit(nodes, next)
        return next
      }),
    [nodes, emit]
  )

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((cur) => {
        const next = addEdge({ ...c, id: newId('e') }, cur)
        emit(nodes, next)
        return next
      }),
    [nodes, emit]
  )

  // Inline text edits arrive from the node component by event rather than a
  // callback prop, because xyflow memoizes nodeTypes and a changing prop
  // identity would remount every node on each keystroke.
  useEffect(() => {
    const handler = (e: Event): void => {
      const { id, field, value } = (
        e as CustomEvent<{ id: string; field: 'text' | 'file' | 'url'; value: string }>
      ).detail
      setNodes((cur) => {
        const next = cur.map((n) =>
          n.id === id ? { ...n, data: { ...n.data, [field]: value } } : n
        )
        emit(next, edges)
        return next
      })
    }
    window.addEventListener('canvas-node-field', handler)
    return () => window.removeEventListener('canvas-node-field', handler)
  }, [edges, emit])

  const addBlock = (kind: BlockKind): void => {
    const id = newId(kind === 'group' ? 'g' : 'n')
    const data: FlowNodeData =
      kind === 'group'
        ? { canvasType: 'group', label: 'New group' }
        : kind === 'note'
          ? { canvasType: 'file', file: '' }
          : kind === 'link'
            ? { canvasType: 'link', url: '' }
            : { canvasType: 'text', text: 'New block' }
    const node: Node<FlowNodeData> = {
      id,
      type: kind === 'group' ? GROUP_NODE : BLOCK_NODE,
      position: { x: 40 + nodes.length * 24, y: 40 + nodes.length * 18 },
      zIndex: kind === 'group' ? 0 : 1,
      style: kind === 'group' ? { width: 420, height: 260 } : { width: 240, height: 100 },
      data
    }
    setNodes((cur) => {
      const next = [...cur, node]
      emit(next, edges)
      return next
    })
  }

  const setColor = (color: string): void => {
    setNodes((cur) => {
      const next = cur.map((n) =>
        n.selected ? { ...n, data: { ...n.data, color: color || undefined } } : n
      )
      emit(next, edges)
      return next
    })
  }

  const save = async (): Promise<void> => {
    const json = serializeCanvas(fromFlow(nodes, edges))
    setSaving(true)
    try {
      if (fileRel) {
        const res = await window.api.artifact.saveCanvasAt(fileRel, json)
        if (res.success) toast.success(`Saved ${fileRel}`)
        else toast.error(`Couldn't save: ${res.error}`)
        return
      }
      const name = saveName.trim()
      if (!name) {
        toast.error('Name the blueprint before saving')
        return
      }
      const res = await window.api.artifact.saveCanvas(name, json)
      if (res.success) {
        const rel = (res.data as { rel?: string } | undefined)?.rel
        toast.success(`Saved to ${rel ?? 'the vault'}`)
        // Now that the blueprint has a home, offer the roomier window.
        if (rel) setSavedRel(rel)
      } else {
        toast.error(`Couldn't save: ${res.error}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const openWindow = async (): Promise<void> => {
    const rel = fileRel ?? savedRel
    if (!rel) return
    const res = await window.api.artifact.openCanvasWindow(rel)
    if (!res.success) toast.error(`Couldn't open window: ${res.error}`)
  }

  const selectedEdge = edges.find((e) => e.selected)

  const setEdgeLabel = (label: string): void => {
    setEdges((cur) => {
      const next = cur.map((e) => (e.selected ? { ...e, label: label || undefined } : e))
      emit(nodes, next)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* xyflow ships a light-themed control cluster; without this it renders as
          a white box on the dark canvas. Scoped here rather than in a global
          stylesheet so the override travels with the component. */}
      <style>{`
        .cv-flow .react-flow__controls{box-shadow:none}
        .cv-flow .react-flow__controls-button{background:var(--panel-bg);border-bottom:1px solid var(--panel-border);fill:var(--text-secondary)}
        .cv-flow .react-flow__controls-button:hover{background:var(--bg-tertiary)}
        .cv-flow .react-flow__attribution{background:transparent;color:var(--text-muted);opacity:.35;font-size:10px}
      `}</style>
      {/* Single non-wrapping row: at panel width the previous flex-wrap pushed
          "Save to vault" onto a second line, where it overlapped the canvas. */}
      <div className="flex min-w-0 flex-nowrap items-center gap-1 overflow-x-auto border-b border-[var(--panel-border)] px-2 py-1.5">
        {(
          [
            ['text', '+ Block', 'A note you type into'],
            ['note', '+ Note', 'Binds to a vault note'],
            ['link', '+ Link', 'A URL, or duin://skill/… duin://tool/…'],
            ['group', '+ Group', 'A container drawn behind blocks']
          ] as [BlockKind, string, string][]
        ).map(([kind, label, title]) => (
          <Button
            key={kind}
            variant="ghost"
            title={title}
            className="h-7 shrink-0 px-2 text-[12px]"
            onClick={() => addBlock(kind)}
          >
            {label}
          </Button>
        ))}
        <div className="mx-1 flex shrink-0 items-center gap-1">
          {SWATCHES.map((c) => (
            <button
              key={c || 'none'}
              onClick={() => setColor(c)}
              title={c ? `Colour ${c} (selected blocks)` : 'No colour'}
              className="h-4 w-4 rounded-full border border-[var(--panel-border)]"
              style={{ background: c ? PRESET_COLORS[c] : 'transparent' }}
            />
          ))}
        </div>
        <input
          value={typeof selectedEdge?.label === 'string' ? selectedEdge.label : ''}
          onChange={(e) => setEdgeLabel(e.target.value)}
          disabled={!selectedEdge}
          placeholder={selectedEdge ? 'Arrow label' : 'select an arrow'}
          title={t('Label the selected arrow')}
          className="h-7 w-28 shrink-0 rounded border border-[var(--panel-border)] bg-[var(--app-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none disabled:opacity-40"
        />
        <span className="ml-auto" />
        {!fileRel && (
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder={t('Blueprint name')}
            className="h-7 w-32 shrink-0 rounded border border-[var(--panel-border)] bg-[var(--app-bg)] px-2 text-[12px] text-[var(--text-primary)] outline-none"
          />
        )}
        {(fileRel || savedRel) && !fileRel && (
          <Button
            variant="ghost"
            title={t('Open this blueprint in its own window')}
            className="h-7 shrink-0 whitespace-nowrap px-2 text-[12px]"
            onClick={openWindow}
          >
            ⧉ Window
          </Button>
        )}
        <Button
          variant="primary"
          className="h-7 shrink-0 whitespace-nowrap px-2 text-[12px]"
          onClick={save}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ReactFlow
          className="cv-flow"
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          // Arrowheads: a blueprint edge is directional ("A grounds B"), and an
          // unmarked line does not say which way it reads.
          defaultEdgeOptions={{
            markerEnd: { type: MarkerType.ArrowClosed, color: '#5a5a7a' },
            style: { stroke: '#5a5a7a', strokeWidth: 2 }
          }}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  )
}

export function CanvasEditor(props: CanvasEditorProps): ReactElement {
  return (
    <ReactFlowProvider>
      <CanvasEditorInner {...props} />
    </ReactFlowProvider>
  )
}
