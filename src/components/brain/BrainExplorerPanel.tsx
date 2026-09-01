import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useBrainStore, type BrainGraphNode } from '@/stores/brain-store'
import { useChatStore } from '@/stores/chat-store' // Sessions lens opens the matched conversation
import { useSettingsStore } from '@/stores/settings-store'
import { fetchDoc, saveDoc, deleteDoc, deleteNode, resolveWiki } from '@/duin/lib/state'
import { useDirtyGuard, useDraftMirror, dropDraft } from '@/hooks/useDirtyGuard'
import { draftMirrorReady } from './draft-mirror-ready'
import { draftKey, readDraft } from '@/lib/dirty-guard'
import { linkifyWikilinks, wikilinkTarget } from '@/lib/wikilinks'
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor'
import { toast } from '@/stores/toast-store'
import { forLight } from '@/duin/lib/light-color'
import '@/styles/markdown.css' // .markdown-body prose styles for the read view

// Native lamprey Brain Explorer — the navigation for the center brain graph,
// rebuilt in lamprey's design (NOT DUIN's chrome). Lens chips + a folder/file
// tree (and per-lens lists) read the shared brain-store and drive the graph:
// click an item → the graph focuses that node. The "in-between" of options
// 2 (lives in the right Workspace panel) and 3 (reuses lamprey UI patterns).

// THREE TIERS, PARTITIONED ON `layer`.
//
// The organising principle, stated once so every later question has an answer:
//   Memory files = authored by the operator.
//   Brain nodes  = derived by the machine.
//   Work         = the operator's committed structure.
//
// The tiers used to be two (Memory / Concepts) and to partition on overlapping
// `kind` SETS — `person`, `org` and `decision` were listed under both. So a vault
// person note rendered in BOTH tiers. That was not a data problem; the tiers were
// not a partition. `layer` already is one, and it was sitting on every node
// unused: 1,056 vault · 6,213 construction · 139 product · 53 folder · 1 core on
// the live graph. Tiering on it makes them disjoint by construction.
//
// THE DERIVED LENSES ARE GONE (Meetings / Outputs / Mental Models). They were
// populated by `isMentalModel()` & co in derive-knowledge.ts: a disjunction of a
// frontmatter type, a tag, a folder named `Mental Models` or `Frameworks`, and an
// LLM classification. A vault organised by WORKSTREAM rather than by those folder
// names — which is the common case, and was the case on the vault this was
// measured against — fires none of the first three, leaving the bucket a per-note
// LLM guess that did not even exclude person notes (`isPersonNote` sits 340 lines
// above `isMentalModel` in the same file and is never consulted).
//
// A category worth having is one the operator declared. So they are TAGS now,
// authored and pinned, not a classifier's opinion about prose.
type Tier = 'memory' | 'brain'

const TIERS: { id: Tier; label: string; hint: string }[] = [
  { id: 'memory', label: 'Memory files', hint: 'Notes you wrote, your work, and your session logs' },
  { id: 'brain', label: 'Brain nodes', hint: 'Entities the extractor derived from your notes' }
]

/** Which `layer` values belong to each tier. Total over the live vocabulary, so no node is
 *  unreachable.
 *
 *  `product` (cards / KRs / moves) sits under Memory files rather than in a tier of its own. It is
 *  the operator's committed structure — authored, not derived — so it belongs on the same side of
 *  the one line this split is actually drawing. A third tier for 139 nodes bought a permanent
 *  extra click on the two tiers that hold the other 7,300.
 *
 *  `folder` and `core` are scaffolding and ride with the files they organise. */
/** One reused ICU collator for every label comparison (bare localeCompare pays an ICU
 *  lookup per call — over 6.2k labels that was the dominant term of the mount stall). */
const LABEL_COLLATOR = new Intl.Collator()

/** Sorted tier partitions, cached across mounts keyed on the store's nodes-array identity
 *  (brain-store data survives unmount; a graph reload replaces the array, which retires the
 *  cache entry with it). See the tierNodes memo for the full reasoning. */
const _tierSortCache = new WeakMap<object, Map<string, BrainGraphNode[]>>()

const TIER_LAYERS: Record<Tier, Set<string>> = {
  memory: new Set(['vault', 'folder', 'core', 'product']),
  brain: new Set(['construction'])
}

/** `sessions` is not graph-backed at all — it lists conversations from the SQLite store. It sits
 *  under Memory files because a session log is something the operator recorded, not something the
 *  machine derived. */
const TIER_LENSES: Record<Tier, { id: string; label: string }[]> = {
  memory: [
    { id: 'all', label: 'All' },
    { id: 'notes', label: 'Notes' },
    { id: 'work', label: 'Work' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'tags', label: 'Tags' }
  ],
  brain: [
    { id: 'brain-all', label: 'All' },
    { id: 'entities', label: 'Entities' },
    { id: 'brain-tags', label: 'Tags' }
  ]
}

/** Which tier a lens belongs to — so restoring a persisted lens selects the
 *  right tier instead of showing an empty list under the wrong one. */
const TIER_OF_LENS: Record<string, Tier> = Object.fromEntries(
  (Object.entries(TIER_LENSES) as [Tier, { id: string }[]][]).flatMap(([tier, ls]) =>
    ls.map((l) => [l.id, tier] as const)
  )
) as Record<string, Tier>

/** Every lens that shows the tag cloud rather than a node list. One per tier, because a tag is
 *  scoped to the tier you are in — the tags on your notes are not the tags on derived entities. */
const TAG_LENSES = new Set(['tags', 'brain-tags'])

/** Additional kind narrowing WITHIN a tier. `null` = the whole tier. The tier's `layer` filter
 *  runs first and does the real partitioning; these only sharpen it. */
const LENS_KINDS: Record<string, Set<string> | null> = {
  all: null,
  notes: new Set(['note', 'card']),
  work: new Set(['card', 'kr', 'move', 'track', 'goal']),
  'brain-all': null,
  entities: new Set(['entity', 'topic', 'person', 'org', 'decision', 'event', 'project'])
}
// Strip a leading YAML frontmatter block so the read view renders formatted prose
// instead of dumping `type: … tags: …` as raw text. The editor still shows it
// (it's part of the source); only the rendered read view hides it.
function stripFrontmatter(md: string): string {
  // Drop a leading BOM first (charCode 0xFEFF) so we don't need it in the regex.
  const s = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md
  const m = /^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(s)
  return m ? s.slice(m[0].length) : s
}

const KIND_DOT: Record<string, string> = {
  goal: '#fde047', kr: '#fde68a', event: '#fbbf24', milestone: '#fbbf24', release: '#fbbf24',
  project: '#38bdf8', track: '#2dd4bf', move: '#34d399', decision: '#c084fc', card: '#bef264',
  person: '#94a3b8', org: '#818cf8', note: '#9ca3af', folder: '#9ca3af',
  // Without these two the majority of the graph rendered dotless.
  entity: '#a1a1aa', topic: '#f0abfc'
}

export function BrainExplorerPanel(): React.ReactElement {
  const data = useBrainStore((s) => s.data)
  const lens = useBrainStore((s) => s.lens)
  const isLight = useSettingsStore((s) => s.settings.themeMode) === 'light'
  const setLens = useBrainStore((s) => s.setLens)
  // A tag lens is `tag:<name>` and MUST stay that shape: brain-shell.tsx parses it with
  // `lensId.slice(4)` to filter the graph, so encoding the tier into the id would hand the graph
  // a tag that does not exist. The tier a tag was picked from is therefore component-local —
  // which is also honest, since the same tag can legitimately appear in more than one tier.
  const [tagTier, setTagTier] = useState<Tier>('memory')
  // Derived, not stored: the lens already determines the tier, and a second
  // source of truth could disagree with it (a restored lens showing the wrong
  // tier's chips).
  const tier: Tier = lens.startsWith('tag:') ? tagTier : (TIER_OF_LENS[lens] ?? 'memory')
  const activeTag = lens.startsWith('tag:') ? lens.slice(4) : null
  const focusNode = useBrainStore((s) => s.focusNode)
  const detailNode = useBrainStore((s) => s.detailNode)
  const setDetail = useBrainStore((s) => s.setDetail)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  // Pinned tags, per tier, persisted. The operator's own categories — the replacement for the
  // retired LLM-classified lenses. A pinned tag sorts to the top of the cloud so the handful that
  // matter are not lost among 610 others.
  const [pinnedTags, setPinnedTags] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('brainPinnedTags')
      return new Set(raw ? (JSON.parse(raw) as string[]) : [])
    } catch {
      return new Set()
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('brainPinnedTags', JSON.stringify(Array.from(pinnedTags)))
    } catch {
      /* a full or disabled localStorage must not break the panel */
    }
  }, [pinnedTags])
  // The Sessions lens LISTS conversations, and filters them when the box has a term. It used to
  // call `sessions.search`, which returns FTS snippets and therefore showed nothing at all until
  // you typed — a search box wearing a list's label. `sessions.list` does both: no query returns
  // the recent conversations, a query runs the same FTS index and returns the matching ones, with
  // real titles and timestamps rather than fragments of message body.
  const [sessions, setSessions] = useState<
    { id: string; title?: string; updatedAt?: number; messageCount?: number }[]
  >([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsErr, setSessionsErr] = useState<string | null>(null)
  // Read-view state for the focused node. `hasDoc` = a real .md backs this node
  // (vault note, card, action, or doc-backed project) → render/edit its body;
  // false = a pure graph entity (person/org/decision/…) → show the info card.
  // `path` is the RESOLVED vault path the body loaded from (slug→path for non-.md
  // ids), so save/delete target the real file, not the slug. `nodeId` tags which
  // node this state describes, so render can detect a stale carry-over (the effect
  // runs after paint) and show Loading instead of the previous node's body.
  const [doc, setDoc] = useState<{
    nodeId: string | null
    loading: boolean
    text: string
    err: boolean
    path: string | null
    hasDoc: boolean
  }>({
    nodeId: null,
    loading: false,
    text: '',
    err: false,
    path: null,
    hasDoc: false
  })
  // In-app markdown editing of the focused note.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  // U3. The effect below fires setEditing(false) UNCONDITIONALLY on every
  // detailNode change, so clicking a [[wikilink]] inside your own unsaved
  // paragraph discarded it — no autosave, no dirty check, no draft retention, and
  // Edit re-seeds from doc.text. Two independent protections now: the pane
  // registers as dirty (setDetail asks before switching) and the text is mirrored
  // into sessionStorage under the node id (survives a reload, which no confirm can).
  const editorDirty = editing && draft !== doc.text
  const noteDraftKey = draftKey('note', doc.nodeId ?? '')
  useDirtyGuard('brain:note-editor', 'the note editor', editorDirty)
  // ready = this doc is the one selected, has finished loading, AND actually loaded.
  // Before that, draft and doc.text are both '' and the mirror would clear the stored draft.
  //
  // `!doc.err` is part of that condition, not a nicety. A failed re-fetch sets
  // `{ loading: false, text: '', err: true }`, which reproduces the exact empty-equals-empty
  // collapse this guard was written for: syncDraft sees draft === saved === '' and clears the
  // mirror. That deletes the only copy of an unsaved edit on any transient reload or
  // reconnect glitch — the precise case the sessionStorage belt exists to survive. A load
  // failure means we do not KNOW what is saved, and not knowing must never authorise a delete.
  useDraftMirror(
    noteDraftKey,
    editing ? draft : doc.text,
    doc.text,
    draftMirrorReady(doc, detailNode?.id)
  )
  // Delete (soft) — two-step confirm so a stray click can't drop a note.
  const setData = useBrainStore((s) => s.setData)
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Backlinks/outlinks section — collapsed by default (session-local); the toggle
  // header still shows the counts so links are discoverable without expanding.
  const [linksOpen, setLinksOpen] = useState(false)

  // When a node is picked (graph click → store), try to load a backing .md for it.
  // The read view is RESOLVE-DRIVEN, not kind-gated: any node whose id resolves to
  // a real vault file renders (and edits) that file — vault notes, cards, actions,
  // and doc-backed projects all go through the same path. A node that resolves to
  // nothing is a pure graph entity (person/org/decision/event/…) and falls back to
  // the info card. This fixes the class of bug where doc-backed non-card kinds
  // (actions, some projects) showed an empty info card instead of their body.
  useEffect(() => {
    setEditing(false) // never carry an open editor across notes
    setConfirmDel(false) // and never carry a primed delete across notes
    setLinksOpen(false) // links section starts collapsed for each note
    if (!detailNode) {
      setDoc({ nodeId: null, loading: false, text: '', err: false, path: null, hasDoc: false })
      return
    }
    const nodeId = detailNode.id
    setDoc({ nodeId, loading: true, text: '', err: false, path: null, hasDoc: true })
    let alive = true
    void (async () => {
      try {
        // Vault notes carry a .md path directly. Every other node id is a bare slug
        // (e.g. card C260618-…, action T260509-…, product concept) — resolve it to a
        // vault path. A hit → a real file backs it; a miss (null) → doc-less entity.
        const path = /\.md$/i.test(nodeId) ? nodeId : await resolveWiki(nodeId)
        if (!path) {
          if (alive) setDoc({ nodeId, loading: false, text: '', err: false, path: null, hasDoc: false })
          return
        }
        const text = await fetchDoc(path)
        if (!alive) return
        setDoc({ nodeId, loading: false, text, err: false, path, hasDoc: true })
        // Reopening a node you were mid-edit on (after a reload, or after leaving
        // and coming back) reopens the editor on your text, not the file's.
        const saved = readDraft(draftKey('note', nodeId))
        if (saved !== null && saved !== text) {
          setDraft(saved)
          setEditing(true)
          toast.info('Restored your unsaved draft for this note')
        }
      } catch {
        // Resolved to a file but the fetch failed — keep hasDoc so the doc pane can
        // show a load error rather than silently masquerading as an entity.
        if (alive) setDoc({ nodeId, loading: false, text: '', err: true, path: null, hasDoc: true })
      }
    })()
    return () => {
      alive = false
    }
  }, [detailNode])

  // Sessions lens — list conversations, filtered by the box when it has a term. Debounced, because
  // a term change is a real SQLite query. Surfaces a failure rather than rendering as "no
  // sessions": an empty list and a broken store must not look identical.
  useEffect(() => {
    if (lens !== 'sessions') {
      setSessions([])
      setSessionsLoading(false)
      setSessionsErr(null)
      return
    }
    const term = filter.trim()
    let alive = true
    setSessionsLoading(true)
    setSessionsErr(null)
    const t = window.setTimeout(
      () => {
        const api = window.api?.sessions
        if (!api?.list) {
          if (alive) {
            setSessionsErr('Session store unavailable in this build.')
            setSessionsLoading(false)
          }
          return
        }
        void api
          .list({ tab: 'recent', query: term || undefined, limit: ROW_CAP })
          .then((r: { success?: boolean; data?: unknown; error?: string }) => {
            if (!alive) return
            if (r?.success === false) {
              setSessions([])
              setSessionsErr(r.error ?? 'Could not read the session store.')
            } else {
              setSessions(
                (r?.data as { id: string; title?: string; updatedAt?: number; messageCount?: number }[]) ?? []
              )
            }
            setSessionsLoading(false)
          })
          .catch((e: unknown) => {
            if (!alive) return
            setSessions([])
            setSessionsErr((e as Error)?.message ?? 'Could not read the session store.')
            setSessionsLoading(false)
          })
      },
      term ? 200 : 0
    )
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [lens, filter])

  const nodes = data?.nodes ?? []
  const q = filter.trim().toLowerCase()
  const isFiles = lens === 'all' || lens === 'notes'

  /** How many rows any one list renders at once.
   *
   *  The Concepts lens used to render its whole result set into one scroll container: 6,286 rows
   *  built synchronously on the tier toggle, and rebuilt on every keystroke in the filter box.
   *  That, not the filtering, was the lag — Memory rendered 58 collapsed folder rows for the same
   *  graph, a ~108x difference in DOM nodes.
   *
   *  A cap rather than a windowing library, deliberately: it is one number, it cannot desync from
   *  the scroll position, and the honest UI for "6,286 matches" is not 6,286 rows — it is the
   *  first 300 and a line telling you to filter. The count is always shown, so the cap can never
   *  masquerade as the whole answer. */
  const ROW_CAP = 300

  /** The nodes this tier owns, LABEL-SORTED. Every later filter narrows THIS, so the tiers
   *  cannot overlap — and since Array.filter is stable, every downstream list inherits this
   *  order and the per-keystroke sort that used to live in the list memo is gone.
   *
   *  Cached across mounts on the store's nodes-array identity: this is the DEFAULT surface,
   *  it holds no cross-mount state of its own, and the uncached version re-ran an ICU
   *  localeCompare sort over ~6.2k labels inside a thrown-away memo chain on every open —
   *  a measured renderer main-thread stall. The WeakMap entry dies with the array, so a
   *  graph reload (new array from the store) can never serve stale order. Collator, not
   *  bare localeCompare: one reused ICU instance instead of one lookup per comparison. */
  const tierNodes = useMemo(() => {
    let byTier = _tierSortCache.get(nodes)
    if (!byTier) {
      byTier = new Map()
      _tierSortCache.set(nodes, byTier)
    }
    const hit = byTier.get(tier)
    if (hit) return hit
    const layers = TIER_LAYERS[tier]
    const sorted = nodes
      .filter((n) => layers.has(String((n as { layer?: string }).layer ?? 'vault')))
      .sort((a, b) => LABEL_COLLATOR.compare(String(a.label ?? ''), String(b.label ?? '')))
    byTier.set(tier, sorted)
    return sorted
  }, [nodes, tier])

  // Folder → files tree (for All / Notes), grouped by node.group.
  const tree = useMemo(() => {
    const byFolder = new Map<string, { id: string; label: string; kind: string }[]>()
    for (const n of tierNodes) {
      if (n.kind === 'folder' || n.kind === 'core') continue
      // Internal index nodes (`__projidx__…`) are graph plumbing, not files. Left in,
      // each one rendered as a subfolder row whose badge said "1" while the folder held
      // 17 real notes — a lying count over machine bookkeeping (QA 2026-08-24, F8).
      if (typeof n.id === 'string' && n.id.startsWith('__')) continue
      const allowed = LENS_KINDS[lens]
      if (allowed && !allowed.has(n.kind)) continue
      if (q && !String(n.label || '').toLowerCase().includes(q)) continue
      const folder = n.group || 'Other'
      if (!byFolder.has(folder)) byFolder.set(folder, [])
      byFolder.get(folder)!.push({ id: n.id, label: n.label, kind: n.kind })
    }
    return [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [tierNodes, lens, q])

  /** Flat list for every non-tree, non-tag lens — and for a `tag:` lens, which slices the tier by
   *  one tag. `total` is the true match count; `rows` is what actually renders. */
  const { rows: list, total: listTotal } = useMemo(() => {
    const allowed = LENS_KINDS[lens] ?? null
    // No sort here: tierNodes is already label-sorted and filter is stable, so
    // this memo — the one that re-runs on every keystroke — is filters only.
    const matched = tierNodes
      .filter((n) => n.kind !== 'folder' && n.kind !== 'core')
      .filter((n) => !(typeof n.id === 'string' && n.id.startsWith('__')))
      .filter((n) => !allowed || allowed.has(n.kind))
      .filter((n) => !activeTag || ((n as { tags?: string[] }).tags ?? []).includes(activeTag))
      .filter((n) => !q || String(n.label || '').toLowerCase().includes(q))
    return { rows: matched.slice(0, ROW_CAP), total: matched.length }
  }, [tierNodes, lens, q, activeTag])

  /** Tag cloud for the active tier. Pinned tags sort to the top; the rest by frequency.
   *
   *  Bare numerics are dropped. The live vault has `1` on 63 nodes and `2` on 23 — the tag parser
   *  is picking up list markers and `#1`-style prose, and a tag that means nothing crowds out the
   *  ones that do. Filtering here rather than in the parser is deliberate: this is a display
   *  decision, and the parser bug is a separate fix that should not be masked by silently
   *  discarding its output upstream. */
  const { rows: tags, total: tagTotal } = useMemo(() => {
    const c = new Map<string, number>()
    for (const n of tierNodes) {
      for (const t of (n as { tags?: string[] }).tags ?? []) {
        if (!t || /^\d+$/.test(t)) continue
        c.set(t, (c.get(t) ?? 0) + 1)
      }
    }
    const matched = [...c.entries()]
      .filter(([t]) => !q || t.toLowerCase().includes(q))
      .sort((a, b) => {
        const pa = pinnedTags.has(a[0]) ? 1 : 0
        const pb = pinnedTags.has(b[0]) ? 1 : 0
        if (pa !== pb) return pb - pa
        return b[1] - a[1]
      })
    // Capped like the node list, and for the same reason — measured on the live vault the cloud
    // was 578 tags, and each row carries a pin control, so it rendered 1,156 buttons in one
    // container. Pinned tags sort first, so the cap can never hide one the operator chose.
    return { rows: matched.slice(0, ROW_CAP), total: matched.length }
  }, [tierNodes, q, pinnedTags])

  const setChatContext = useBrainStore((s) => s.setChatContext)
  const openNode = (id: string): void => {
    focusNode(id)
    const n = nodes.find((x) => x.id === id)
    if (n) {
      setDetail(n)
      setChatContext({ id: n.id, label: n.label, kind: n.kind }) // scope the chat to this node
    }
  }
  // P4+ — vault note titles for the editor's [[wikilink]] autocomplete.
  const noteTitles = useMemo(
    () =>
      Array.from(
        new Set(
          nodes
            .filter((n) => (n as { layer?: string }).layer === 'vault' && n.label)
            .map((n) => String(n.label))
        )
      ),
    [nodes]
  )
  // Resolve a clicked [[wikilink]] to a node and open it (name/alias/#section →
  // exact label, then contains, then basename-of-path).
  const openWikilink = (target: string): void => {
    const name = target.split('|')[0].split('#')[0].trim().toLowerCase()
    if (!name) return
    const n =
      nodes.find((x) => String(x.label).toLowerCase() === name) ??
      nodes.find((x) => String(x.id).toLowerCase().split('/').pop()?.replace(/\.md$/, '') === name) ??
      nodes.find((x) => String(x.label).toLowerCase().includes(name))
    if (n) openNode(n.id)
    else toast.info(`No note matches [[${target}]]`)
  }
  // P4++ — backlinks + outgoing links for the open note, derived from the graph
  // edges the store already holds (no backend call). d3-force mutates link
  // source/target from id-strings into node-object refs, so accept both.
  const linkRefs = useMemo(() => {
    const d = data as { links?: unknown[]; edges?: unknown[] } | null
    const raw = (d?.links ?? d?.edges ?? []) as Array<{ source?: unknown; target?: unknown }>
    const idOf = (x: unknown): string | undefined =>
      x && typeof x === 'object' ? (x as { id?: string }).id : (x as string | undefined)
    const labelById = new Map(nodes.map((n) => [n.id, String(n.label ?? n.id)]))
    const back: { id: string; label: string }[] = []
    const out: { id: string; label: string }[] = []
    const cur = detailNode?.id
    if (cur) {
      const seenB = new Set<string>()
      const seenO = new Set<string>()
      for (const e of raw) {
        const s = idOf(e.source)
        const t = idOf(e.target)
        if (t === cur && s && s !== cur && !seenB.has(s)) {
          seenB.add(s)
          back.push({ id: s, label: labelById.get(s) ?? s })
        }
        if (s === cur && t && t !== cur && !seenO.has(t)) {
          seenO.add(t)
          out.push({ id: t, label: labelById.get(t) ?? t })
        }
      }
    }
    return { back, out }
  }, [data, nodes, detailNode])
  const row = (id: string, label: string, kind: string): React.ReactElement => (
    <button
      key={id}
      // Stable hook for the node id. Without it a row is only identifiable by its
      // visible label, which collides (two nodes can share a label) and is unusable
      // for UI automation or QA.
      data-node-id={id}
      data-node-kind={kind}
      onClick={() => openNode(id)}
      title={label}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: (c => (isLight ? forLight(c) : c))(KIND_DOT[kind] || '#9ca3af') }} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )

  // Native node detail (replaces DUIN's Sheet slide-over). Markdown for any node
  // backed by a real .md; an info card for pure graph entities.
  if (detailNode) {
    // `doc` is loaded asynchronously by the effect above, which runs AFTER this
    // render. `docFresh` guards against showing the PREVIOUS node's body for one
    // frame right after the selection changes. `docReady` = a backing file is
    // loaded and editable → gate Edit/Save/Delete on it, never on kind.
    const docFresh = doc.nodeId === detailNode.id
    const docReady = docFresh && !doc.loading && !doc.err && doc.hasDoc && !!doc.path
    // A resolved-to-nothing node: real in the graph, backed by no file. Folders and
    // the core node are structural, not user content, so they stay undeletable.
    const deletableNode =
      docFresh &&
      !doc.loading &&
      !doc.hasDoc &&
      !!detailNode &&
      detailNode.kind !== 'folder' &&
      detailNode.kind !== 'core'
    return (
      <div className="flex h-full flex-col overflow-hidden text-[12px]">
        <div className="flex items-center gap-2 border-b border-[var(--panel-border)] px-2 py-2">
          <button
            onClick={() => setDetail(null)}
            className="rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            ← Back
          </button>
          <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]" title={detailNode.label}>
            {detailNode.label}
          </span>
          {docReady && !editing && (
            <button
              onClick={() => {
                setDraft(doc.text)
                setEditing(true)
              }}
              title={t('Edit this note')}
              className="rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              {t('Edit')}
            </button>
          )}
          {editing && (
            <>
              <Button variant="primary"
                disabled={saving}
                onClick={async () => {
                  if (!detailNode || !doc.path) return
                  setSaving(true)
                  try {
                    // Save to the RESOLVED path — editing is only reachable when a
                    // real file backs the node (docReady requires doc.path), so this
                    // never mints a stray file at a bare slug.
                    await saveDoc(doc.path, draft)
                    dropDraft(noteDraftKey)
                    setDoc({ nodeId: detailNode.id, loading: false, text: draft, err: false, path: doc.path, hasDoc: true })
                    setEditing(false)
                    toast.success('Note saved')
                  } catch {
                    toast.error('Could not save note')
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <button
                disabled={saving}
                onClick={() => {
                  if (editorDirty && !window.confirm('Discard your unsaved changes to this note?')) return
                  dropDraft(noteDraftKey)
                  setEditing(false)
                }}
                className="rounded-md px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                {t('Cancel')}
              </button>
            </>
          )}
          {/* Delete is offered for a doc-backed note AND for a doc-less graph node.
              It used to be gated on `docReady` alone, so the ~74% of the graph that
              resolves to no file — entity/topic/person/org — had no delete
              affordance at all and stale extraction leftovers could not be removed
              from the UI. */}
          {(docReady || deletableNode) && !editing && (
            <button
              disabled={deleting}
              onClick={async () => {
                if (!detailNode) return
                if (!doc.path && !deletableNode) return
                if (!confirmDel) {
                  setConfirmDel(true)
                  return
                }
                setDeleting(true)
                try {
                  const id = detailNode.id
                  // A note deletes its RESOLVED file; a doc-less node retires the
                  // graph row. Both then prune the same in-memory graph by node id.
                  if (doc.path) await deleteDoc(doc.path)
                  else await deleteNode(id)
                  // Prune from the in-memory graph for instant feedback (the file is
                  // now in <vault>/.trash; any reload confirms it).
                  const cur = useBrainStore.getState().data as
                    | { nodes?: unknown[]; links?: unknown[]; edges?: unknown[] }
                    | null
                  if (cur) {
                    const ref = (l: { source?: unknown; target?: unknown }): boolean => {
                      const s = typeof l.source === 'object' ? (l.source as { id?: string })?.id : l.source
                      const t = typeof l.target === 'object' ? (l.target as { id?: string })?.id : l.target
                      return s !== id && t !== id
                    }
                    const next = { ...cur } as Record<string, unknown>
                    next.nodes = (cur.nodes ?? []).filter((n) => (n as { id?: string }).id !== id)
                    if (Array.isArray(cur.links)) next.links = cur.links.filter((l) => ref(l as never))
                    if (Array.isArray(cur.edges)) next.edges = cur.edges.filter((l) => ref(l as never))
                    setData(next as never)
                  }
                  setDetail(null)
                  toast.success(doc.path ? 'Note moved to .trash' : 'Node removed')
                } catch {
                  toast.error(doc.path ? 'Could not delete note' : 'Could not remove node')
                } finally {
                  setDeleting(false)
                  setConfirmDel(false)
                }
              }}
              title={
                confirmDel
                  ? 'Click again to confirm'
                  : doc.path
                    ? 'Delete this note (moves to .trash)'
                    : 'Remove this node from the graph (reversible — the row is retired, not dropped)'
              }
              className={`rounded-md px-2 py-1 text-[12px] transition-colors disabled:opacity-50 ${
                confirmDel
                  ? 'bg-[var(--error)] font-medium text-white hover:opacity-90'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--error)]'
              }`}
            >
              {deleting ? 'Deleting…' : confirmDel ? 'Confirm delete' : 'Delete'}
            </button>
          )}
          {/* Open in its own window. Replaces the old "focus in graph" ◎: the side
              panel is too narrow to read or edit a note in, and focusing the graph
              behind it did not help with either. */}
          <button
            onClick={async () => {
              const res = await window.api?.artifact?.openDetached?.('node', detailNode.id)
              if (res && !res.success) toast.error(`Couldn't open window: ${res.error}`)
            }}
            title={t('Open in a separate window')}
            className="rounded-md px-1.5 py-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            ⧉
          </button>
        </div>
        <div className="brain-md min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {!docFresh || doc.loading ? (
            <p className="text-[var(--text-muted)]">Loading…</p>
          ) : doc.hasDoc ? (
            doc.err ? (
              <p className="text-[var(--text-muted)]">{t('Couldn’t load this note.')}</p>
            ) : editing ? (
              <CodeMirrorEditor
                value={draft}
                onChange={setDraft}
                autoFocus
                noteTitles={noteTitles}
                onOpenWikilink={openWikilink}
              />
            ) : (
              // Read view uses the app's canonical markdown prose styles
              // (.markdown-body — same as chat), so a viewed note is formatted
              // (headings, lists, bold, code, tables) and unified with the editor,
              // not raw text.
              <div className="markdown-body">
                {/* Wikilinks are rewritten to `wikilink:` hrefs before rendering and
                    intercepted here, so a VIEWED note has working [[links]] — they
                    previously rendered as literal bracket text, since markdown has no
                    notion of them and only the editor understood them. */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children, ...rest }) => {
                      const target = wikilinkTarget(href)
                      if (!target) {
                        // Not a wikilink — hand it to the shell. A bare <a href> here is a dead
                        // click: the renderer has nowhere to navigate, and only the global
                        // navigation guard stops it becoming worse. Same handoff the artifact
                        // MarkdownRenderer uses, so every markdown surface behaves alike.
                        return (
                          <a
                            href={href}
                            {...rest}
                            onClick={(e) => {
                              if (!href) return
                              e.preventDefault()
                              if (window.api?.artifact?.openExternal) {
                                window.api.artifact.openExternal(href)
                              } else {
                                window.open(href, '_blank', 'noreferrer')
                              }
                            }}
                          >
                            {children}
                          </a>
                        )
                      }
                      return (
                        <a
                          href={href}
                          title={`Open [[${target}]]`}
                          onClick={(e) => {
                            e.preventDefault()
                            openWikilink(target)
                          }}
                          {...rest}
                        >
                          {children}
                        </a>
                      )
                    }
                  }}
                >
                  {linkifyWikilinks(stripFrontmatter(doc.text))}
                </ReactMarkdown>
              </div>
            )
          ) : (
            // Pure graph entity (resolved to no file) — person, org, topic, entity…
            //
            // This used to render the kind, an optional body and "ask the brain",
            // which for the ~74% of the graph that is doc-less read as an empty
            // panel. A graph node's CONTENT is its identity plus what it connects
            // to, so show that inline rather than hiding it behind the collapsed
            // links section below.
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: KIND_DOT[detailNode.kind] ?? '#9ca3af' }}
                />
                <span className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                  {detailNode.kind}
                </span>
              </div>
              {detailNode.body ? <p>{String(detailNode.body)}</p> : null}
              <div className="rounded-md border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-2">
                <div className="text-[11px] text-[var(--text-muted)]">id</div>
                <div className="break-all font-mono text-[11px] text-[var(--text-secondary)]">
                  {detailNode.id}
                </div>
              </div>
              {linkRefs.out.length + linkRefs.back.length > 0 ? (
                <div className="space-y-1.5">
                  <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    Connected to ({linkRefs.out.length + linkRefs.back.length})
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[...linkRefs.out, ...linkRefs.back].slice(0, 40).map((l) => (
                      <button
                        key={`${l.id}-inline`}
                        onClick={() => openNode(l.id)}
                        title={l.id}
                        className="max-w-full truncate rounded-full border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                      >
                        {l.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-[12px] text-[var(--text-muted)]">
                  {t('Nothing links to this yet — it may be left over from an earlier extraction run.')}
                </p>
              )}
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('Ask the brain about this from the composer below.')}
              </p>
            </div>
          )}
        </div>
        {(linkRefs.back.length > 0 || linkRefs.out.length > 0) && (
          <div className="shrink-0 border-t border-[var(--panel-border)] px-3 py-2">
            <button
              onClick={() => setLinksOpen((v) => !v)}
              title={linksOpen ? 'Hide links' : 'Show links in and out'}
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              <span className="text-[var(--text-muted)]">{linksOpen ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1 truncate">
                Links ({linkRefs.back.length} in · {linkRefs.out.length} out)
              </span>
            </button>
            {linksOpen && (
              <div className="mt-1.5 space-y-1.5">
                {linkRefs.back.length > 0 && (
                  <LinkChips title={`Linked from (${linkRefs.back.length})`} items={linkRefs.back} onOpen={openNode} />
                )}
                {linkRefs.out.length > 0 && (
                  <LinkChips title={`Links to (${linkRefs.out.length})`} items={linkRefs.out} onOpen={openNode} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-2 text-[12px]">
      {/* Tier switch — authored / derived / committed. Above the chips because it changes WHICH
          chips apply, not which subset of one list you see. */}
      <div className="mb-2 flex gap-0.5 rounded-md border border-[var(--panel-border)] p-0.5">
        {TIERS.map((t) => (
          <button
            key={t.id}
            title={t.hint}
            onClick={() => {
              // Land on the tier's first lens rather than keeping a lens that
              // belongs to another tier and would render an empty list.
              if (tier !== t.id) {
                setTagTier(t.id)
                setLens(TIER_LENSES[t.id][0].id)
              }
            }}
            className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
              tier === t.id
                ? 'bg-[var(--accent)]/15 text-[var(--text-primary)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Lens chips — scoped to the active tier */}
      <div className="mb-2 flex flex-wrap gap-1">
        {TIER_LENSES[tier].map((l) => (
          <button
            key={l.id}
            onClick={() => setLens(l.id)}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
              lens === l.id || (TAG_LENSES.has(l.id) && activeTag !== null)
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text-primary)]'
                : 'border-[var(--panel-border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t('Filter…')}
        className="mb-2 w-full rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
            {t('Open the Brain to load your knowledge graph.')}
          </p>
        ) : lens === 'sessions' ? (
          <div className="space-y-0.5">
            {sessionsErr ? (
              // A store failure is NOT an empty list. Saying so is the whole point.
              <p className="px-2 py-3 text-[12px] text-[var(--error)]">{sessionsErr}</p>
            ) : sessionsLoading && sessions.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">Loading sessions…</p>
            ) : sessions.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                {filter.trim() ? `No sessions match “${filter.trim()}”.` : 'No sessions recorded yet.'}
              </p>
            ) : (
              sessions.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void useChatStore.getState().selectConversation(c.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                  title={t('Open this conversation')}
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-secondary)]">
                    {c.title?.trim() || 'Untitled session'}
                  </span>
                  {typeof c.messageCount === 'number' && (
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">
                      {c.messageCount}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        ) : TAG_LENSES.has(lens) ? (
          <div className="space-y-0.5">
            {tags.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                Nothing in {TIERS.find((t) => t.id === tier)?.label} carries a tag yet.
              </p>
            ) : (
              tags.map(([t, c]) => {
                const pinned = pinnedTags.has(t)
                return (
                  <div
                    key={t}
                    className="group flex w-full items-center gap-1 rounded-md pr-1 transition-colors hover:bg-[var(--bg-tertiary)]"
                  >
                    <button
                      onClick={() => {
                        setTagTier(tier)
                        setLens(activeTag === t ? TIER_LENSES[tier][0].id : `tag:${t}`)
                      }}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] ${
                        activeTag === t ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'
                      }`}
                    >
                      {/* No `#`. The hash was decoration — every row in this list is a tag, so it
                          carried no information and cost width on the CJK labels that need it. */}
                      <span className="min-w-0 flex-1 truncate">{t}</span>
                      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{c}</span>
                    </button>
                    <button
                      onClick={() =>
                        setPinnedTags((prev) => {
                          const next = new Set(prev)
                          if (next.has(t)) next.delete(t)
                          else next.add(t)
                          return next
                        })
                      }
                      title={pinned ? `Unpin ${t}` : `Pin ${t} to the top`}
                      aria-label={pinned ? `Unpin ${t}` : `Pin ${t} to the top`}
                      aria-pressed={pinned}
                      className={`shrink-0 rounded px-1 text-[11px] transition-opacity ${
                        pinned
                          ? 'text-[var(--accent)] opacity-100'
                          : 'text-[var(--text-muted)] opacity-0 group-hover:opacity-100 focus:opacity-100'
                      }`}
                    >
                      ★
                    </button>
                  </div>
                )
              })
            )}
            {tagTotal > tags.length && (
              <p className="px-2 py-2 text-[11px] text-[var(--text-muted)]">
                Showing {tags.length.toLocaleString()} of {tagTotal.toLocaleString()} tags — filter
                to narrow.
              </p>
            )}
          </div>
        ) : isFiles ? (
          <div className="space-y-0.5">
            {tree.map(([folder, items]) => {
              const open = expanded.has(folder)
              return (
                <div key={folder}>
                  <button
                    onClick={() =>
                      setExpanded((prev) => {
                        const n = new Set(prev)
                        if (n.has(folder)) n.delete(folder)
                        else n.add(folder)
                        return n
                      })
                    }
                    className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    <span className="text-[var(--text-muted)]">{open ? '▾' : '▸'}</span>
                    <span className="min-w-0 flex-1 truncate">{folder}</span>
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-muted)]">{items.length}</span>
                  </button>
                  {open && (
                    <div className="ml-3 border-l border-[var(--panel-border)] pl-1.5">
                      {items.map((it) => row(it.id, it.label, it.kind))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-0.5">
            {list.map((n) => row(n.id, n.label, n.kind))}
            {listTotal === 0 && (
              <p className="px-2 py-3 text-[12px] text-[var(--text-muted)]">
                {q ? `Nothing here matches “${filter.trim()}”.` : 'Nothing in this view yet.'}
              </p>
            )}
            {/* Never let the cap masquerade as the whole answer. */}
            {listTotal > list.length && (
              <p className="px-2 py-2 text-[11px] text-[var(--text-muted)]">
                Showing {list.length.toLocaleString()} of {listTotal.toLocaleString()} — filter to
                narrow.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// P4++ — a labelled row of clickable link chips (backlinks / outgoing) shown
// under the open note. Opening a chip navigates to that node's detail.
function LinkChips({
  title,
  items,
  onOpen
}: {
  title: string
  items: { id: string; label: string }[]
  onOpen: (id: string) => void
}): React.ReactElement {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{title}</div>
      <div className="flex flex-wrap gap-1">
        {items.map((it) => (
          <Button variant="secondary" className="max-w-[180px] truncate hover:border-[var(--accent)]"
            key={it.id}
            onClick={() => onOpen(it.id)}
            title={it.label}
          >
            {it.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
