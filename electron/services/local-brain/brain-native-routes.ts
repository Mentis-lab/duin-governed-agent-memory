// Native brain HTTP routes (part 1 of 2) — relocated verbatim from server.ts (pure move).
// The brain-graph adapter (toBrainGraph/derivedGraphWithConstruction + BrainGraph types)
// and the first half of handleRequestNativeImpl's route chain. Falls through to
// handleRequestNativeImpl2 (brain-native-routes-2.ts) when no route here matched.
import { type IncomingMessage, type ServerResponse } from 'http'
import { readSettings, readBody, docAbspath, writeSettings, HOST, handleAgui } from './server'
import { handleRequestNativeImpl2 } from './brain-native-routes-2'
import { brainAssetsDir } from '../brain-paths'
import { buildInfo, formatBuildStamp } from '../../build-info'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { reindex, isReindexing, search, indexedCount } from './index-store'
import { brainGraphCache } from './brain-graph-cache'
import { getStalls } from '../main-stall-monitor'
import { readRecentTurns } from './agui-journal'
import { globalSearch } from './global-search'
import { mergedGraph } from '../brain/merged-graph'
import { readGraphNative, nativeGraphMtime } from '../brain/graph-native'
import { buildBrainGraph } from '../brain/brain-graph-native'
import { deriveGraph, deriveNodeMtimes } from './graph-derive'
import { detectCommunities } from '../brain/graph-insight'
import { deriveTopicTracks, materializeTracks } from '../brain/topic-tracks'
import { conceptMemoryDir } from '../brain/concept-materialize'
import { liveEntityEgoGraph } from '../brain/entity-ego'
import { listFutures } from '../brain/futures-native'
import { listSchedules, listIntel, listDocuments, readDocumentBytes, scheduleAction } from '../brain/loop-artifacts-native'
import { runLoopAgentic } from '../loop-agent'
import { listTasks } from '../brain/list-tasks-native'
import { worldGraph } from '../brain/world-graph-native'
import { runGenerateStrategy, runGenerateModel } from '../brain/generate-strategy-native'
import { saveStrategy, saveMentalModel } from '../brain/strategy-save-native'
import { draftReply } from '../brain/draft-reply-native'
import { saveToRaw, autoTrackRisks, inferDrivers, saveUpload, learnLoopStatus } from '../brain/misc-routes-native'
import { dialog, BrowserWindow } from 'electron'
import { meetingScan } from '../brain/meeting-scan-native'
import { pullFeishuMessages, sendFeishuMessage } from '../brain/feishu-comms-native'
import { larkExec } from '../lark-exec'
import { recordVerdict } from '../brain/decision-verdict-native'
import { saveProjectLogo, clearProjectLogo } from '../brain/project-logo-native'
import { runEmbedderEval } from './embedder-eval'
import type { LabeledQuery } from '../rag/embeddings/_eval/scoring'
import { detectGapsLive } from '../brain/capability-gap-live'
import { causalGraph } from '../brain/causal-substrate'
import { predictedRisks } from '../brain/predicted-risks-native'
import { worldState, revealedRisks } from '../brain/world-state-native'
import { forecastRecord } from '../brain/forecast-record-native'
import { scenarioForks } from '../brain/scenario-forks-native'
import { calibration } from '../brain/calibration-native'
import { scoreResolvedLedger } from '../brain/calibration-scoring'
import { syntheticReplayScore } from '../brain/calibration-replay'
import { buildAutonomyState } from '../ans/autonomy-report'
import { listActions, revertAction } from '../ans/action-ledger'
import { runCalibration } from '../brain/calibration-store'
import { getMoatHealth } from '../brain/moat-health'
import { runShadowMetabolism, runLiveMetabolism, applyClaimResolution, loadPersistedLedger, claimMetabolismLive, type ResolveAction } from '../brain/claim-extract'
import { parseDateMs } from '../brain/claim-ledger'
import { claimsAsOf } from '../brain/claim-metabolism'
import { runLearningShadow, runLearningDeep } from '../brain/learning-metabolism'
import { runCalibrationMetabolism } from '../brain/calibration-metabolism'
import { runMeasurePass } from '../brain/judgment-measure-live'
import { getImprovementProposals } from '../brain/improvement-proposer'
import { runReflect } from '../brain/learn-store'
import { getTaste } from '../brain/learn-native'
import { listSpacesWrapped } from '../brain/spaces-native'
import { resolveCascade } from '../brain/cascade-apply-native'
import { generateOnce } from '../brain/generate-once-native'
import { captureWork } from '../brain/capture-work-write-native'
import { autoRevealPersist } from '../brain/reveal-persist'
import { messageOf } from '../guarded'
import { createHash } from 'node:crypto'
import { runScout } from '../brain/scout-active-work-native'
import { runStreamNudge } from '../brain/stream-nudge-write-native'
import { actWorldUpdate } from '../brain/world-update-act-write-native'
import { actRevealedRisk } from '../brain/revealed-risk-write-native'
import { seedFromVault } from '../brain/cold-start-seed'
import { bindCandidate } from '../brain/binding-ledger'
import { loadBindings, appendBinding } from '../brain/binding-store'
import { anchors } from '../brain/anchors-native'
import { eventPrep } from '../brain/event-prep-native'
import { decisionLoop } from '../brain/decision-loop-native'
import { listProfile } from '../brain/profile-native'
import { listDetectors } from '../brain/detectors-native'
import { streamVerdicts, forecastOwed, cascadePending, listMeetings } from '../brain/simple-reads-native'
import { listTracks } from '../brain/tracks-native'
import { listProblems } from '../brain/problems-native'
import { listStrategies, listMentalModels } from '../brain/strategies-native'
import { buildGraph } from '../brain/build-graph-native'
import { futuresGraph } from '../brain/futures-graph-native'
import { listEntities } from '../brain/entities-native'
import { listConversations } from '../brain/conversations-native'
import { listWorkflows } from '../brain/workflows-native'
import { prepareMethodRun } from '../brain/method-run'
import { installedSkillNames } from '../skill-loader'
import { listProjectsWrapped } from '../brain/projects-native'
import { projectDetail } from '../brain/project-detail-native'
import { runProjectFutures } from '../brain/project-futures-native'
import { listDecisions } from '../brain/decisions-native'
import { buildStyleFingerprint } from '../brain/style-fingerprint-service'
import { docResponse, resolveResponse } from '../brain/doc-native'
import { listOutputs } from '../brain/outputs-native'
import { listValue } from '../brain/value-native'
import { conversationThreads } from '../brain/conversation-threads-native'
import { listExperts } from '../brain/experts-native'
import { decisionConnections } from '../brain/decision-connections-native'
import { generateForecasts } from '../brain/forecast-generator'
import { logForecastsToLedger } from '../brain/forecast-ledger'
import type { CausalGraph } from '../brain/types'
import { runPropagate, getInsights, getDecisionLoop, buildBrain, resetExtractionBreaker } from '../brain'
import { chatOnce, routeModel } from '../providers/registry'
import { buildOperatorBlock, pruneCandidatesFromStore, buildGovernAudit, efficacySummary } from '../brain/operator-model'
import { runTransferAB, makeTransferDeps, DEFAULT_TRANSFER_QUERIES } from '../brain/transfer-ab'
import { getSuccesses } from '../brain/success-miner'
import { distillToSkill } from '../brain/named-skill'
import { loadNamedSkills, appendNamedSkill } from '../brain/named-skill-store'
import { turnBeatsEnabled, turnBeatReport } from './turn-beats'
import { handleDecision, handleInsightVerdict, handleProjectCreate, handleTrackAdd, handleTrackAssign, handleStreamUpdate, handleStreamSync, handleWorldUpdate, handleFutureAct, handlePredictionFeedback, handleAnchorDismiss, handleTaskBind, handleMeetingAction, handleMakeDecision, handleDecisionMeta, handleResolveNode, handleTaskAction, handleTaskMove, handleForecastVerdict, handleLogForecast, handleLearnCorrection } from './brain-state-routes'

// ──────────────────── brain-graph adapter ────────────────────

// The renderer's BrainGraph contract (mirrored from src/duin/lib/state.ts — the
// electron tsconfig project can't import across the src/ boundary; same
// precedent as graph-derive.ts mirroring CausalGraph). Keep in lockstep.
interface BrainNode {
  id: string
  kind: string
  label: string
  layer: 'core' | 'product' | 'vault' | 'folder'
  declared?: number
  group?: string
  tags?: string[]
  date?: string
  mtime?: number
}
interface BrainLink {
  source: string
  target: string
  type: string
}
interface BrainGraph {
  nodes: BrainNode[]
  links: BrainLink[]
  core: string
  stats: { nodes: number; edges: number }
}

/**
 * Adapt deriveGraph()'s CausalGraph to the renderer's BrainGraph contract.
 * - edges → links (source/target/type carry over verbatim)
 * - the field anchor becomes the pinned CORE node; synthesized if absent so the
 *   graph still has a centre and the renderer's core treatment applies
 * - every derived note is a "vault"-layer node; its lane → `group` (the file
 *   tree groups + colours vault notes by group)
 * - declared defaults to 1 (real notes draw solid), tags to [] (deriveGraph
 *   doesn't surface per-node tags — Tags lens is empty locally; graph renders)
 */
function toBrainGraph(g: CausalGraph): BrainGraph {
  const CORE_ID = '__duin_core__'
  const nodes: BrainNode[] = g.nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    layer: 'vault',
    declared: 1,
    group: n.track ?? 'notes',
    tags: [],
    ...(n.date ? { date: n.date } : {}),
    ...(n.mtime ? { mtime: n.mtime } : {})
  }))

  // Resolve the centre: prefer deriveGraph's anchor if it's a real node, else
  // synthesize a CORE node and link the top notes to it so the field coheres.
  const links: BrainLink[] = g.edges.map((e) => ({
    source: e.source,
    target: e.target,
    type: e.type
  }))

  let core = typeof g.anchor === 'string' && g.anchor ? g.anchor : ''
  const hasAnchorNode = core !== '' && nodes.some((n) => n.id === core)
  if (!hasAnchorNode) {
    core = CORE_ID
    nodes.unshift({ id: CORE_ID, kind: 'core', label: 'DUIN', layer: 'core', declared: 1 })
    // Anchor the unlinked field: attach roots (no outgoing edge) to the core so
    // there are no floating islands around an empty centre.
    const hasOut = new Set(links.map((l) => l.source))
    for (const n of nodes) {
      if (n.id === CORE_ID) continue
      if (!hasOut.has(n.id)) links.push({ source: CORE_ID, target: n.id, type: 'core' })
    }
  }

  return {
    nodes,
    links,
    core,
    stats: { nodes: nodes.length, edges: links.length }
  }
}

/**
 * The structural graph from the indexed notes, MERGED with the cached "Build my
 * brain" construction (LLM-inferred entities + edges + note classifications)
 * when one exists for the current notes dir. Union/dedup is handled by
 * applyConstruction; absent a construction this is just deriveGraph().
 */
function derivedGraphWithConstruction(): CausalGraph {
  return mergedGraph()
}

// M1 — proxy the vault-state surface to the python sidecar (the FULL surface)
// when it's up; fall through to the local handlers when it's not. `onUnavailable`
// only fires if the sidecar can't be reached BEFORE any byte is written, so a
// dropped/absent sidecar degrades gracefully to the local engine.

// /state/brain-graph memo (relocated with its route from server.ts).
//
// The 30s TTL that used to live here forced a full rebuild every half minute of
// idle, and the module-level variable meant every launch started cold. Both are
// now handled by SwrJsonCache: the entry survives restarts on disk, and an aged
// entry triggers a background rebuild instead of a blocking one. See that file
// for why the mtime key, not the timer, is what makes this correct.
// Counts for /state/brain-graph/summary, memoized per cache key. Set directly
// inside the SWR build (where the graph object is in hand, so the counts are
// free); a warm process serving the DISK cache without having built this boot
// parses the served JSON exactly once and memoizes. Without this, the Status
// panel fetched and JSON.parsed the full ~1.5MB graph on every open — on the
// renderer main thread — to display two integers (renderer audit finding #1;
// brain-shell.tsx:531 fixed the same cost for window focus and this call site
// never got the treatment).
let _brainGraphSummary: { servedKey: string; nodes: number; links: number } | null = null

/** Both graph endpoints must populate the shared cache with identical bytes.
 * If the counts route wins the first-request race, the later full route must
 * still receive the recency metadata. */
export function cachedBrainGraph(vault: string) {
  const logoDir = join(brainAssetsDir(), 'web', 'public', 'project-logos')
  const key = `${vault}:${nativeGraphMtime(vault)}`
  return brainGraphCache.get(
    key,
    () => {
      const g = buildBrainGraph(vault, { prod: readGraphNative(vault), logoDir, now: new Date() })
      try {
        // deriveNodeMtimes, not deriveGraph: this needs id→mtime, and deriveGraph
        // structuredClones the entire causal graph to hand it over safely. The clone
        // was the whole cost of the call and none of its value — it was read once and
        // dropped — inside a rebuild that blocks main for seconds.
        const mt = deriveNodeMtimes(vault)
        for (const node of g.nodes as Array<{ id: string; mtime?: number }>) {
          if (node.mtime == null) {
            const value = mt.get(node.id)
            if (value != null) node.mtime = value
          }
        }
      } catch { /* recency is best-effort -- never break the graph */ }
      _brainGraphSummary = { servedKey: key, nodes: g.nodes.length, links: g.links.length }
      // Demo provenance stamping died with the demo vault (removed 2026-08-22): no vault can be
      // a demo any more, so the payload carries no `demo` flag and the renderer reads none.
      return JSON.stringify(g)
    },
    { scope: vault }
  )
}

export function handleRequestNativeImpl(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'

  if (method === 'GET' && url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', brain: 'local', indexed: indexedCount() }))
    return
  }

  // Main-thread stall attribution (main-stall-monitor.ts): every recorded
  // freeze ≥100ms with its scope, plus per-scope totals since launch. The
  // instrument the page-open-freeze report was missing — read this before
  // theorizing about a hitch.
  if (method === 'GET' && url.split('?')[0] === '/debug/stalls') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(getStalls()))
    return
  }

  // Recent turns, newest first, from the durable turn journal. The turn loop's history used to be
  // memory-only and was dropped on abort, so "what did that turn actually do before I stopped it?"
  // had no answer at all. `incomplete: true` marks a turn with no TURN_END record — the app died
  // mid-turn — which is the case worth looking at first. `?limit=` (default 20).
  if (method === 'GET' && url.split('?')[0] === '/debug/turns') {
    void (async () => {
      try {
        const raw = Number(new URLSearchParams(url.split('?')[1] ?? '').get('limit'))
        const turns = await readRecentTurns(Number.isFinite(raw) && raw > 0 ? raw : 20)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ turns }, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'turns error' }))
      }
    })()
    return
  }

  // Build provenance — "which commit is this running app?" without correlating
  // app.asar mtimes. Exact-match (not startsWith) so it can never shadow a
  // future /state/build-* route. Reads nothing but a compile-time constant, so
  // it answers even when the vault/index is unavailable.
  if (method === 'GET' && url.split('?')[0] === '/state/build') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...buildInfo(), stamp: formatBuildStamp() }))
    return
  }

  // Tier-1 parity — the home Brain MAP. The renderer (src/duin/lib/state.ts
  // fetchBrainGraph + brain-shell.tsx) consumes a BrainGraph:
  //   { nodes: BrainNode[], links: BrainLink[], core: string,
  //     stats: { nodes, edges } }
  // with BrainNode = { id, kind, label, layer: "core"|"product"|"vault"|"folder",
  //                    declared?, group?, tags? }
  // and BrainLink = { source, target, type }.
  // We REUSE deriveGraph() (the wikilink/vault field) and adapt its CausalGraph
  // shape to this contract: edges→links (same source/target/type), the field
  // anchor becomes the pinned CORE node (synthesized if deriveGraph returns
  // none), every note is a "vault"-layer node, and its lane (top-level folder)
  // becomes `group` so the renderer's file tree + colour-by-folder work. Fields
  // the local field can't populate are given sensible defaults: declared=1 (real
  // notes draw solid) and tags=[] (deriveGraph doesn't surface per-node tags, so
  // the Tags lens is empty locally — the graph still renders fully).
  // /state/store-graph — the raw DUIN PRODUCT graph read straight from SQLite
  // (duin.db), native at EXACT parity with Python graph.read_graph(). This is
  // the store the brain-graph merge overlays onto the vault cloud.
  if (method === 'GET' && url.startsWith('/state/store-graph')) {
    try {
      const vault = (readSettings().localBrainNotesDir as string) || ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(readGraphNative(vault)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'store-graph error' }))
    }
    return
  }

  // Counts-only view of the same SWR cache — MUST precede the startsWith
  // branch below or it would swallow this path. Runs the identical cache.get,
  // so staleness still schedules the idle rebuild; on a memo miss (disk-cache
  // serve on a boot that has not built yet) the served JSON is parsed ONCE and
  // the counts memoized per servedKey.
  if (method === 'GET' && url.split('?')[0] === '/state/brain-graph/summary') {
    try {
      const vault = (readSettings().localBrainNotesDir as string) || ''
      const built = cachedBrainGraph(vault)
      if (!_brainGraphSummary || _brainGraphSummary.servedKey !== built.servedKey) {
        const g = JSON.parse(built.json) as { nodes?: unknown[]; links?: unknown[] }
        _brainGraphSummary = {
          servedKey: built.servedKey,
          nodes: g.nodes?.length ?? 0,
          links: g.links?.length ?? 0
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          nodes: _brainGraphSummary.nodes,
          links: _brainGraphSummary.links,
          stale: built.stale
        })
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'brain-graph summary error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/brain-graph')) {
    try {
      // Native build_brain_graph (brain-graph-native): the combined product-store +
      // vault-cloud second-brain graph. Verified CONTENT-EXACT vs the Python sidecar
      // on the live dogfood vault (1263 nodes / 5065 edges, every attribute + every
      // undirected typed edge identical). The store read (readGraph) is the same
      // SQLite path already proven byte-exact for /state/store-graph. logoDir mirrors
      // the legacy _LOGO_DIR (brainAssetsDir()/web/public/project-logos) so the
      // project-logo dir is stable by construction. Array
      // order intentionally differs (Python emits cluster edges in hash-seed order;
      // this port sorts them) — content, not order, is the parity bar.
      const vault = (readSettings().localBrainNotesDir as string) || ''
      const built = cachedBrainGraph(vault)

      // The renderer refetches this on every window focus and visibilitychange,
      // and the payload is ~1.5MB. Answer the unchanged case with a 304 so
      // alt-tabbing back into the app stops re-downloading and re-parsing a
      // graph the client already has.
      //
      // The ETag is minted from `built.servedKey` — the key of the body we are
      // actually about to send — and NOT from `key`, the one the request asked
      // for. On a stale serve those differ, and using `key` would hand the
      // client the previous graph under the current graph's name; on its next
      // request that name would match and it would be told 304, pinning it to a
      // graph the server had already replaced. Deriving the tag from the served
      // key means the comparison below is exact by construction: same tag, same
      // bytes.
      const etag = `"${createHash('sha1').update(built.servedKey).digest('hex')}"`
      // `no-cache` is store-and-always-revalidate, not don't-store. Without any
      // Cache-Control the freshness of a validator-only response is left to
      // Chromium's heuristic, which decides whether we ever see the conditional
      // request this 304 depends on. Say it instead of inferring it.
      const cacheHeaders = { ETag: etag, 'Cache-Control': 'no-cache' }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, cacheHeaders)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...cacheHeaders })
      res.end(built.json)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'brain-graph error' }))
    }
    return
  }

  // /state/search?q= — grouped global search (notes via the hybrid retriever +
  // degree-ranked graph nodes). Curl-debuggable mirror of the brain:search IPC;
  // both call globalSearch() so the two surfaces never drift.
  if (method === 'GET' && url.split('?')[0] === '/state/search') {
    void (async () => {
      try {
        const q = new URL(url, `http://${HOST}`).searchParams.get('q') ?? ''
        const vault = (readSettings().localBrainNotesDir as string) || ''
        const result = await globalSearch(q, vault)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'search error' }))
      }
    })()
    return
  }

  if (method === 'GET' && url.startsWith('/graph')) {
    try {
      const graph = derivedGraphWithConstruction()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(graph))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'graph error' }))
    }
    return
  }

  // Topic-track layer — the mid-level of the memory pyramid. Derives themed tracks from the brain
  // graph's Louvain communities and writes them as machine-owned OKF files beside the concept lane,
  // each carrying its FULL membership as provenance so a query can land on a theme and descend to
  // evidence. Deterministic and model-free; reconciles (retires dissolved tracks) on every run.
  if (method === 'POST' && url.startsWith('/debug/topic-tracks')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const memoryDir = conceptMemoryDir(notesDir)
      if (!memoryDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no vault (localBrainNotesDir) configured' }))
        return
      }
      const graph = derivedGraphWithConstruction()
      const communities = detectCommunities(graph)
      const tracks = deriveTopicTracks(
        // A note node's id IS its vault relpath (build-duin-graph anchors notes to themselves), so
        // that is the provenance link retrieval can cite.
        graph.nodes.map((n) => ({
          id: n.id,
          label: n.label,
          note: n.id.endsWith('.md') ? n.id : undefined
        })),
        graph.edges.map((e) => ({ source: e.source, target: e.target })),
        communities,
        { laneOf: (n) => graph.nodes.find((g) => g.id === n.id)?.track }
      )
      const dry = url.includes('dry=1')
      const result = dry
        ? { written: [], unchanged: [], retired: [] }
        : materializeTracks(tracks, memoryDir, {
            list: (d) => (existsSync(d) ? readdirSync(d) : []),
            read: (p) => (existsSync(p) ? readFileSync(p, 'utf-8') : null),
            write: (p, b) => writeFileSync(p, b, 'utf-8'),
            remove: (p) => rmSync(p, { force: true }),
            join: (a, b) => join(a, b)
          })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          {
            ok: true,
            dry,
            memoryDir,
            graphNodes: graph.nodes.length,
            communities: new Set([...communities.values()]).size,
            tracks: tracks.length,
            ...result,
            top: tracks.slice(0, 10).map((t) => ({ id: t.id, size: t.size, notes: t.notes.length }))
          },
          null,
          2
        )
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'topic-tracks error' }))
    }
    return
  }

  // ── Brain engine surface (Phase A: causal graph + propagation) ──
  // Curl-debuggable mirrors of the IPC fast-path; same engine functions.
  if (method === 'GET' && url.startsWith('/state/causal-graph')) {
    try {
      const anchor = new URL(url, `http://${HOST}`).searchParams.get('anchor') ?? ''
      // Native-always (flipped): the TS causal-substrate is byte-parity with the
      // Python route (verified live), so this no longer proxies to the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(causalGraph(notesDir, anchor)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'causal-graph error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/propagate')) {
    try {
      const q = new URL(url, `http://${HOST}`).searchParams
      const node = q.get('node') ?? ''
      // Robust parse: '' → 0, non-numeric/Infinity → 0, floats truncated. The
      // engine still clamps the value to [0, 3650]; this just avoids passing NaN.
      const rawShift = Number(q.get('shift_days') ?? '0')
      const shift = Number.isFinite(rawShift) ? Math.trunc(rawShift) : 0
      const decision = q.get('decision') ?? ''
      // Validate at the boundary, same contract as the IPC handler (the engine
      // also ignores unknown values, but reject explicitly for parity).
      if (decision && decision !== 'cleared' && decision !== 'blocked') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'decision must be "cleared" or "blocked"' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(runPropagate((readSettings().localBrainNotesDir as string) || null, node, shift, decision)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'propagate error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/predicted-risks')) {
    try {
      // Native-always (flipped): byte-parity with the Python predicted_risks
      // route (deadline-collision + decision-window over the same loaders),
      // verified live. Returns {risks, throughput}.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(predictedRisks(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'predicted-risks error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/loops')) {
    try {
      // Native-always (flipped): byte-parity with Python list_loops (learnings +
      // routine pulse), verified live. This is the path the renderer calls.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(decisionLoop(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'loops error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/profile')) {
    try {
      // Native-always (flipped): byte-parity with Python list_profile (foundation
      // files + agents + parsed me.md), verified vs the standalone sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listProfile(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'profile error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/detectors')) {
    try {
      // Native-always (flipped): byte-parity with Python list_detectors (routine
      // findings surfaced), verified vs the standalone sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listDetectors(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'detectors error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/strategies')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listStrategies(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'strategies error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/models')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listMentalModels(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'models error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/graph') {
    try {
      // Native-always (flipped): byte-parity with Python build_graph (structural wikilink
      // graph over the vault walk), verified EXACT vs the standalone sidecar (1000 nodes).
      // Exact-match kept deliberately: it stops /state/graph swallowing any
      // /state/graph-* sibling. (The one that existed, /state/graph-diff, died
      // with the Python sidecar in 1ce3c534 and has no native replacement.)
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildGraph(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'graph error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/value')) {
    try {
      // Native-always (flipped): byte-parity with Python list_value (value-digest scorecard +
      // decisions due for verdict), verified EXACT vs the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listValue(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'value error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/outputs') {
    try {
      // Native-always (flipped): byte-parity with Python list_outputs (deliverables under
      // <vault>/_agui_outputs, newest first, optional decisionId filter), verified EXACT.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const did = new URLSearchParams(url.split('?')[1] ?? '').get('decisionId')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listOutputs(notesDir, did)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'outputs error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/doc') {
    try {
      // Native-always (flipped): byte-parity with Python read_doc (raw vault file, traversal-
      // safe), verified EXACT (found + 404) vs the sidecar. Exact-match so it never captures
      // /state/documents or /state/document-raw.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const rel = new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? ''
      const r = docResponse(notesDir, rel)
      res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'doc error' }))
    }
    return
  }

  // §4e loop-artifact reads — native (loop_runner --list shell removed). Verified
  // BYTE-EXACT vs the sidecar on the live vault (schedules/intel/documents).
  // /state/world-graph — native world_graph (temporal causal graph: per-track
  // trajectories dipping at risks + addressed/unaddressed forks). Pure transform of
  // native world_state; verified BYTE-EXACT vs the sidecar.
  if (method === 'GET' && url.split('?')[0] === '/state/world-graph') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(worldGraph(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'world-graph error' }))
    }
    return
  }

  // /state/drivers — native infer_drivers. Always a cached latent-driver read
  // (deterministic, byte-exact vs sidecar); model refresh is an explicit POST.
  if (method === 'GET' && url.split('?')[0] === '/state/drivers') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const out = notesDir ? await inferDrivers(notesDir, false, { generate: generateOnce }) : { drivers: [] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'drivers error' }))
      }
    })()
    return
  }

  if (method === 'POST' && url.split('?')[0] === '/state/drivers/refresh') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const out = notesDir ? await inferDrivers(notesDir, true, { generate: generateOnce }) : { drivers: [] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'drivers refresh error' }))
      }
    })()
    return
  }

  // /state/learn-loop/run (POST) — kick the native learn pass. Python spawned the
  // Claude-CLI drain→distill→stage job (dead: DUIN is Claude-Code-free); native runs
  // learn-store.runReflect (corrections → taste), the real native learn action.
  if (method === 'POST' && url.split('?')[0] === '/state/learn-loop/run') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const r = notesDir ? runReflect(notesDir) : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // Non-fatal taste warning (unreadable/non-object taste-engine.json was quarantined, or the
      // taste write was skipped to avoid clobbering bytes we could not preserve) must reach the
      // caller — a silent 200 is exactly how a seeded-values loss goes unnoticed.
      res.end(JSON.stringify({ ok: true, status: 'done', ...(r?.warning ? { warning: r.warning } : {}), ...(r?.quarantined ? { quarantined: r.quarantined } : {}), ...(r?.taste_write_skipped ? { taste_write_skipped: true } : {}) }))
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, status: 'error', error: (err as Error)?.message ?? 'learn-run error' }))
    }
    return
  }

  // /state/learn-loop (GET) — self-improvement backlog status (deterministic file
  // counts). The `run` state is always idle: the native app is Claude-Code-free,
  // so there is no learn-CLI job (native learning is learn-store.runReflect).
  if (method === 'GET' && url.split('?')[0] === '/state/learn-loop') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const status = notesDir ? learnLoopStatus(notesDir) : { queued: 0, corrections_new: 0, proposals_pending: 0, distill_due: false, debt: 0 }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...status, run: { status: 'idle', summary: '', started: '', finished: '' } }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'learn-loop error' }))
    }
    return
  }

  // /state/tasks — native list_tasks (full Kanban corpus w/ 60-per-status cap +
  // feeds/grounded provenance). Verified BYTE-EXACT vs the sidecar (88 tasks).
  if (method === 'GET' && url.split('?')[0] === '/state/tasks') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listTasks(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'tasks error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/schedules') {
    try {
      const settings = readSettings()
      const notesDir = (settings.localBrainNotesDir as string) || null
      // The loop runner fires only when BOTH gates are on (loop-scheduler.ts requires
      // backgroundAutonomy; agentic execution additionally requires loopsEnabled). Without
      // this flag the Status panel showed loops as "due" for MONTHS while the runner could
      // never fire them (QA 2026-08-24, F10) — "due" read as "will run soon" and was a lie.
      const runnerEnabled = settings.backgroundAutonomy === true && settings.loopsEnabled === true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...listSchedules(notesDir), runnerEnabled }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'schedules error' }))
    }
    return
  }
  if (method === 'GET' && url.split('?')[0] === '/state/intel') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listIntel(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'intel error' }))
    }
    return
  }
  if (method === 'GET' && url.split('?')[0] === '/state/documents') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listDocuments(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'documents error' }))
    }
    return
  }
  if (method === 'GET' && url.split('?')[0] === '/state/document-raw') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const rel = new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? ''
      const r = readDocumentBytes(notesDir, rel)
      if (!r) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      } else {
        res.writeHead(200, { 'Content-Type': r.contentType, 'Content-Length': String(r.bytes.length) })
        res.end(r.bytes)
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'document-raw error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/resolve') {
    try {
      // Native-always (flipped): byte-parity with Python resolve_wikilink, verified EXACT vs sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const name = new URLSearchParams(url.split('?')[1] ?? '').get('name') ?? ''
      const r = resolveResponse(notesDir, name)
      res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r.body))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'resolve error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/decisions')) {
    try {
      // Native-always (flipped): byte-parity with Python list_decisions (dashboard rows,
      // legacy-pillar / type:decision discovery, newest first), verified EXACT vs the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listDecisions(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'decisions error' }))
    }
    return
  }

  if (method === 'GET' && (url === '/state/style-fingerprint' || url.startsWith('/state/style-fingerprint?'))) {
    try {
      // Descriptive operator self-model (plan §6 Surface A): how you ACTUALLY decide, as
      // Wilson-gated histograms + the prescribed-vs-actual divergence mirror. Read-only,
      // loopback-local; never injected into chat grounding (that's a discoverability pointer, P6).
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildStyleFingerprint(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'style-fingerprint error' }))
    }
    return
  }

  if (method === 'GET' && (url === '/state/project' || url.startsWith('/state/project?'))) {
    try {
      // Native-always (flipped): byte-parity with Python project_detail — a project's
      // tracks (its folder notes) + categorized wikilink connections (people/orgs/
      // decisions/projects/refs). Verified EXACT vs the sidecar across all live projects
      // + not-found. Guard excludes /state/projects and /state/project-logo (distinct).
      const name = new URL(url, `http://${HOST}`).searchParams.get('name') ?? ''
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(projectDetail(notesDir, name)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'project error' }))
    }
    return
  }

  if (method === 'POST' && (url === '/state/project' || url.startsWith('/state/project?'))) {
    // Schema-graft (dead-projection fix): re-expose the forward projection. runProjectFutures
    // exists but was only fired as a world-update side-effect; the 2026-07-15 decouple left
    // POST /state/project a 404, so future-nodes stopped refreshing (future-meta went stale).
    // Fire in the background (it's an LLM call) and ack immediately.
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const force = !!body.force
        if (notesDir) void runProjectFutures(notesDir, { generate: generateOnce, force }).catch(() => {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: !!notesDir }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'project-refresh error' }))
      }
    })()
    return
  }

  if (method === 'GET' && url.startsWith('/state/projects')) {
    try {
      // Native-always (flipped): byte-parity with Python list_projects (arena-first / legacy
      // project dashboard), verified EXACT vs the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listProjectsWrapped(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'projects error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/workflows')) {
    try {
      // The capability layer: skills + agents + method notes with classified wires
      // (now incl. calls-skills frontmatter + task-kind/deliverable). Consumed by the
      // Methods Customize panel.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listWorkflows(notesDir, installedSkillNames())))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'workflows error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/prepare-method-run') {
    try {
      // The CONSUME half of Methods: resolve a `type: method` note into its wired
      // skills + a grounded run prompt. The renderer activates the skills and sends
      // the prompt through the normal chat/agent loop.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const p = new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? ''
      const run = prepareMethodRun(notesDir, p, installedSkillNames())
      if (!run) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not a method note' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(run))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'prepare-method-run error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/decision-connections') {
    try {
      // Native-always (flipped): byte-parity with Python decision_connections (categorized
      // wikilink graph), verified EXACT vs the sidecar. Exact-match: distinct from /state/decisions.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const id = new URLSearchParams(url.split('?')[1] ?? '').get('id') ?? ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(decisionConnections(notesDir, id)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'decision-connections error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/experts')) {
    try {
      // Native-always (flipped): byte-parity with Python load_experts (the 5 default lens
      // personas), verified EXACT vs the sidecar.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listExperts()))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'experts error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/conversation-threads')) {
    try {
      // Native-always (flipped): byte-parity with Python conversation_threads (channel-centric
      // swept-comms view), verified EXACT vs the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(conversationThreads(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'conversation-threads error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/conversations')) {
    try {
      // Native-always (flipped): byte-parity with Python list_conversations (people ×
      // referencing follow-ups, most-owed first), verified EXACT vs the sidecar (48 convos).
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listConversations(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'conversations error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/entities')) {
    try {
      // Native-always (flipped): byte-parity with Python vault_entities()+load_entities()
      // (vault person/org walk + manual merge), verified EXACT vs the sidecar (80 entities).
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listEntities(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'entities error' }))
    }
    return
  }

  // Relations surface — hydrated, CAPPED ego graph over the persistent entity plane (the plane
  // had no read route; neighborsOf returns bare ids). ?anchor=<id|label>&depth=<1..3>.
  if (method === 'GET' && url.startsWith('/state/entity-graph')) {
    try {
      const u = new URL(url, 'http://local')
      const anchor = u.searchParams.get('anchor') ?? ''
      const depth = Number.parseInt(u.searchParams.get('depth') ?? '1', 10)
      if (!anchor.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'anchor is required (?anchor=<id|label>)' }))
        return
      }
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(liveEntityEgoGraph(notesDir, anchor, Number.isFinite(depth) ? depth : 1)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'entity-graph error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/meetings')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listMeetings(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'meetings error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/futures-graph')) {
    try {
      // Native-always (flipped): byte-parity with Python futures_graph (the future
      // constellation), verified EXACT vs the standalone sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(futuresGraph(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'futures-graph error' }))
    }
    return
  }

  // /state/futures — native list_futures (convergence-weighted streams grouped into
  // objectives). Verified BYTE-EXACT vs the Python sidecar on the live dogfood vault
  // vault. Exact-match so it never swallows /state/futures-graph. calibrate_streams
  // runs inside (its ledger-append self-correction side-effect is replicated).
  if (method === 'GET' && url.split('?')[0] === '/state/futures') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const body = JSON.stringify(listFutures(notesDir))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'futures error' }))
    }
    return
  }

  if (method === 'GET' && url.split('?')[0] === '/state/folders') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ folders: buildGraph(notesDir).folders }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'folders error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/problems')) {
    try {
      // Native-always (flipped): byte-parity with Python list_problems (open-loop
      // register: problems/risks/owed), verified vs the standalone sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listProblems(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'problems error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/tracks')) {
    try {
      // Native-always (flipped): byte-parity with Python list_tracks (Goal>Track>Move
      // lanes w/ streams bucketed by keyword), verified vs the standalone sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listTracks(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'tracks error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/cascade-pending')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(cascadePending(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'cascade-pending error' }))
    }
    return
  }

  // FINISH (brain-unification): the cascade tray's APPROVE leg, native. stage (cascade-engine) +
  // list (cascade-pending) were already native; this is the missing approve/dismiss verb — the
  // human-gated apply → per-kind side effects. Body: {cid, action:'approve'|'dismiss'}.
  if (method === 'POST' && url.startsWith('/state/cascade-resolve')) {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no notes dir' }))
          return
        }
        const raw = await readBody(req)
        let p: Record<string, unknown>
        try {
          p = JSON.parse(raw || '{}') as Record<string, unknown>
        } catch {
          p = {}
        }
        const out = await resolveCascade(notesDir, String(p.cid ?? p.id ?? ''), String(p.action ?? ''), { generate: generateOnce })
        res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'cascade-resolve error' }))
      }
    })()
    return
  }

  // ─── Last Python write-verbs, now native. Each: parse body → native fn (generateOnce) → JSON. ───
  // Helper: run an async native write handler with the standard notesDir-guard + body-parse + errors.
  const nativeWrite = (
    name: string,
    run: (notesDir: string, body: Record<string, unknown>) => Promise<unknown> | unknown
  ): void => {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no notes dir' }))
          return
        }
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        } catch {
          body = {}
        }
        const out = await run(notesDir, body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out ?? { ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? `${name} error` }))
      }
    })()
  }

  if (method === 'POST' && url.split('?')[0] === '/state/capture-work') {
    nativeWrite('capture-work', async (nd, b) => {
      const text = String(b.text ?? '')
      const result = await captureWork(nd, text, { generate: generateOnce })
      // Auto-reveal (replaces the manual Reveal surface): connect the just-dropped thought into the
      // entity graph in the background, persisting ONLY auto-accepted edges. Fire-and-forget +
      // best-effort so it never delays or breaks capture; gated by DUIN_AUTO_REVEAL.
      if (text.trim()) {
        void autoRevealPersist(nd, { id: `capture:${createHash('md5').update(text).digest('hex').slice(0, 12)}`, text })
          .catch((e) => console.debug('[brain-native-routes] auto-reveal best-effort:', messageOf(e)))
      }
      return result
    })
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/scout-work') {
    // Fire-and-forget (matches Python): scout does 2 model calls (propose+judge); don't block the
    // HTTP response on them. Respond immediately, run the scout in the background.
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, started: !!notesDir }))
    if (notesDir) void runScout(notesDir, { generate: generateOnce }).catch(() => {})
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/stream-nudge') {
    nativeWrite('stream-nudge', (nd, b) => runStreamNudge(nd, String(b.text ?? ''), { generate: generateOnce }))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/world-update-act') {
    nativeWrite('world-update-act', (nd, b) =>
      actWorldUpdate(nd, String(b.id ?? b.uid ?? ''), String(b.action ?? ''), { generate: generateOnce })
    )
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/revealed-risk') {
    nativeWrite('revealed-risk', (nd, b) =>
      actRevealedRisk(nd, String(b.id ?? b.task_id ?? ''), String(b.action ?? ''), String(b.title ?? ''))
    )
    return
  }
  // Batch A — model-backed generate + pure saves (native modules already existed + tested).
  if (method === 'POST' && url.split('?')[0] === '/state/strategy-generate') {
    nativeWrite('strategy-generate', (_nd, b) => runGenerateStrategy(b, { generate: generateOnce }))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/model-generate') {
    nativeWrite('model-generate', (_nd, b) => runGenerateModel(b, { generate: generateOnce }))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/strategy-save') {
    nativeWrite('strategy-save', (nd, b) => saveStrategy(nd, b))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/model-save') {
    nativeWrite('model-save', (nd, b) => saveMentalModel(nd, b))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/draft-reply') {
    nativeWrite('draft-reply', (nd, b) =>
      draftReply(nd, String(b.profile ?? ''), String(b.person ?? ''), String(b.owed ?? ''), String(b.thread ?? ''), {
        generate: generateOnce
      })
    )
    return
  }
  // /state/pull-messages — read a contact's recent Feishu thread via lark-cli (user
  // identity). Native (feishu-comms-native) + the lark-exec provider.
  if (method === 'POST' && url.split('?')[0] === '/state/pull-messages') {
    void (async () => {
      try {
        const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const out = await pullFeishuMessages(String(b.query ?? ''), { exec: larkExec() })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'pull-messages error', messages: [] }))
      }
    })()
    return
  }
  // /state/send-message — send a Feishu message via lark-cli (dry validates without
  // sending). Outward action — the UI gates it behind explicit confirm.
  if (method === 'POST' && url.split('?')[0] === '/state/send-message') {
    void (async () => {
      try {
        const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const out = await sendFeishuMessage(String(b.query ?? ''), String(b.text ?? ''), !!b.dry, { exec: larkExec() })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'send-message error' }))
      }
    })()
    return
  }

  // /state/config — persist auto-track to native settings (was proxied to Python, which
  // set the SIDECAR's dir — leaving the in-process brain on the old vault). Returns the
  // current dir/auto_track. `dir` is owned by the picker-backed settings IPC (409) and
  // `model` is no longer a setting at all (400): the brain resolves roles from the
  // provider policy, and the only stored model id is a per-conversation pin.
  if (method === 'POST' && url.split('?')[0] === '/state/config') {
    void (async () => {
      try {
        let b: Record<string, unknown> = {}
        try {
          b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        } catch {
          b = {}
        }
        if ('dir' in b) {
          // Vault adoption is deliberately owned by the picker-backed settings IPC.
          // This HTTP route cannot prove path provenance or execute the full switch
          // contract, so retaining a second mutation owner is unsafe.
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            error: 'Vault changes require the native folder picker in Brain settings'
          }))
          return
        }
        if ('model' in b) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            error: 'model is not a setting: DUIN resolves roles from the provider policy; pin a model per conversation instead'
          }))
          return
        }
        if ('auto_track' in b) writeSettings({ autoTrack: !!b.auto_track })
        const s = readSettings()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, dir: s.localBrainNotesDir ?? '', auto_track: s.autoTrack === true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'config error' }))
      }
    })()
    return
  }

  // /state/meeting-scan — mine recent chat logs for arranged meetings via the model,
  // merge into meetings.jsonl (preserving confirm/dismiss). LLM route (generateOnce).
  if (method === 'POST' && url.split('?')[0] === '/state/meeting-scan') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no notes dir' }))
          return
        }
        const now = new Date()
        const p = (n: number): string => String(n).padStart(2, '0')
        const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
        const r = await meetingScan(notesDir, { generate: generateOnce }, today)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(r))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'meeting-scan error' }))
      }
    })()
    return
  }

  // /state/resync — manual recompute. Python fired vault .py routines as subprocesses
  // (sys.executable, which re-launches the server in a frozen build → broken in prod);
  // those routines run on the vault's OWN scheduler now, so DUIN no longer shells them.
  if (method === 'POST' && url.split('?')[0] === '/state/resync') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, fired: [] }))
    return
  }
  // /state/build-brain — "build my brain": (re)run the key-gated construction LLM pass over the
  // indexed notes (entities + edges + OPEN-VOCAB triples), cached. HTTP parity for the settings IPC,
  // so a rebuild is curl-triggerable once the index is loaded (the boot auto-build can race ahead of
  // indexing → empty). No-op status when key-gated off.
  if (method === 'POST' && url.split('?')[0] === '/state/build-brain') {
    void (async () => {
      try {
        resetExtractionBreaker('explicit build (HTTP)')
        const result = await buildBrain()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'build-brain error' }))
      }
    })()
    return
  }
  // /state/loop-run — kick a named loop through the native agentic executor (fire-
  // and-report). The Python arbitrary-prompt-via-Claude path is Claude-Code-free-dead;
  // native runs the loop's configured prompt by name. 0 renderer refs.
  if (method === 'POST' && url.split('?')[0] === '/state/loop-run') {
    void (async () => {
      let b: Record<string, unknown>
      try {
        b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
      } catch {
        b = {}
      }
      const prompt = String(b.prompt ?? '')
      const name = String(b.name ?? '') || 'loop'
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'prompt required' }))
        return
      }
      void runLoopAgentic(name).catch(() => {}) // fire-and-report
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'running', name }))
    })()
    return
  }
  // /state/pick-folder — native OS folder dialog via Electron (Python used a tkinter
  // subprocess). Returns the chosen absolute path, or '' if cancelled.
  if (method === 'POST' && url.split('?')[0] === '/state/pick-folder') {
    void (async () => {
      try {
        const win = BrowserWindow.getAllWindows()[0]
        const dlg = win
          ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] })
        const p = dlg.canceled || dlg.filePaths.length === 0 ? '' : dlg.filePaths[0]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: p }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ path: '', error: (err as Error)?.message ?? 'pick-folder error' }))
      }
    })()
    return
  }
  // /state/loop-tick — legacy sidecar ping. The native loop scheduler
  // (startLoopScheduler in main.ts) owns loop firing now, so this is a no-op that
  // just acknowledges (double-firing is what the single-scheduler design prevents).
  if (method === 'POST' && url.split('?')[0] === '/state/loop-tick') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, fired: '', note: 'native scheduler owns ticking' }))
    return
  }
  // Batch B/C — trivial + deterministic writes.
  if (method === 'POST' && url.split('?')[0] === '/state/prewarm') {
    // No-op: warm SDK sessions were removed (DUIN is Claude-Code-free). Matches Python.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
    return
  }
  if (method === 'POST' && url.split('?')[0] === '/state/auto-track') {
    nativeWrite('auto-track', (nd) => autoTrackRisks(nd, readSettings().autoTrack === true))
    return
  }
  // /state/schedule-action — native loops.yaml CRUD (finishes loop_runner removal);
  // "run" fires the loop through the native agentic executor.
  if (method === 'POST' && url.split('?')[0] === '/state/schedule-action') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        let b: Record<string, unknown> = {}
        try {
          b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        } catch {
          b = {}
        }
        const action = String(b.action ?? '').trim()
        const name = String(b.name ?? '').trim()
        if (!['add', 'edit', 'remove', 'pause', 'resume', 'run'].includes(action)) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: `bad action '${action}'` }))
          return
        }
        if (!name || !notesDir) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'name required' }))
          return
        }
        let out: { ok: boolean; message?: string; error?: string }
        if (action === 'run') {
          const o = await runLoopAgentic(name)
          // `ok` must follow `o.ran`. It was hard-coded true, so a loop that did NOT run still
          // returned ok — and the caller (BrainStatusPanel) branches on `r.ok`, so the operator
          // got a GREEN SUCCESS toast whose text read "'<name>' did not run". A success signal
          // that fires on failure is worse than no signal: it trains you to stop reading it.
          //
          // Report the REAL reason, and treat ran-but-failed as failure:
          //  · runLoopAgentic already returns a precise `reason` for each of its five non-run
          //    paths ("backgroundAutonomy is off", "loop 'x' not in loops.yaml", "loop disabled",
          //    "no vault", "executor 'x' is not agentic"). An earlier version of this fix
          //    discarded it for an invented "not due, disabled, or no work" — of which "not due"
          //    is not even a real path; runLoopAgentic has no due-date check. Surfacing the count
          //    was the point of the sibling Rebuild fix; throwing away the reason here repeated
          //    the same mistake one screen over.
          //  · `ran: true` is returned even when result.status !== 'ok' (the same function logs
          //    that path at level 'warn' and emits loop.agentic.failed at severity 'error'), so
          //    keying only on `o.ran` still reported a green success for a loop that ran and
          //    failed. Both halves of "did this actually work" are now checked.
          const failedInFlight = o.ran && o.result && o.result.status !== 'ok'
          out = o.ran && !failedInFlight
            ? { ok: true, message: `ran '${name}'` }
            : {
                ok: false,
                error: failedInFlight
                  ? `'${name}' ran but failed: ${o.result?.error || o.result?.status || 'unknown error'}`
                  : `'${name}' did not run — ${o.reason ?? 'no reason reported'}`
              }
        } else {
          out = scheduleAction(notesDir, b)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: out.ok, message: out.message ?? out.error ?? '' }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'schedule-action error' }))
      }
    })()
    return
  }

  handleRequestNativeImpl2(req, res)
}
