// Native brain HTTP routes (part 2 of 2) — relocated verbatim from server.ts (pure move).
// The second half of handleRequestNativeImpl's route chain, called as a fallthrough by
// handleRequestNativeImpl (brain-native-routes.ts) when no earlier route matched.
import { type IncomingMessage, type ServerResponse } from 'http'
import { readSettings, readBody, docAbspath, writeSettings, HOST, handleAgui } from './server'
import { brainAssetsDir } from '../brain-paths'
import { withPhase } from '../main-stall-monitor'
import { tombstoneToTrash } from './vault-trash'
import { saveVaultDoc } from './doc-save'
import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { reindex, isReindexing, search, indexedCount, embedForRecall } from './index-store'
import { runRetrievalProbes, type RetrievalProbe, type SearchFn } from './retrieval-probe'
import {
  ACTIVE_RETRIEVAL_CONTEXT,
  CONSTANT_REGISTRY,
  auditConstants
} from '../brain/calibration-registry'
import { sweepRetrievalConfig, sweepWithHoldout } from './retrieval-search'
import { isNodeLive, retireNode, nodeTimestamps } from '../brain/entity-graph-store'
import { recordNodeTombstone } from '../brain/node-tombstones'
import { recordNodeLabel } from '../brain/node-labels'
import { createFolder, createNote, moveNote, renameFolder, renameNote } from './vault-organize'
import { invalidateBrainGraphCache } from './brain-graph-cache'
import {
  clampRetrievalTunables,
  readRetrievalTunables,
  type RetrievalTunables
} from './retrieval-tunables'
import { deriveGraph } from './graph-derive'
import { restartNotesWatcher, scheduleReindex } from './notes-watcher'
import {
  conceptMemoryDir,
  exportBrainBundle,
  seamEnabled,
  seamEntityEdgesEnabled
} from '../brain/concept-materialize'
import { runSeamReconcileNow, makeProductionSeamDeps, seamReconcileStatus } from '../brain/seam-reconcile'
import { getConstruction, applyConstruction } from '../brain/construct'
import { revealForSource } from '../brain/reveal-service'
import type { GraphFrame, EdgeSource } from '../brain/reveal-frames'
import { applyEdgeJudgment, applyMergeJudgment } from '../brain/edge-judgment'
import { computeAliasCandidatesReport, activeAliasGroups } from '../brain/entity-resolver'
import { buildBrainGraph } from '../brain/brain-graph-native'
import { runSelfImproveBench } from '../brain/self-improve-bench'
import { registerCapability } from '../ans/capability-ledger'
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
import { computeBrainHealthLive } from '../brain/brain-health-live'
import { computeCompoundingHealthLive } from '../brain/compounding-health-live'
import { computeCoherenceHealthLive } from '../brain/coherence-health-live'
import { readLastEntry as readLastBackendHealth } from '../backend-health-monitor'
import { causalGraph } from '../brain/causal-substrate'
import { predictedRisks } from '../brain/predicted-risks-native'
import { worldState, revealedRisks } from '../brain/world-state-native'
import { forecastRecord } from '../brain/forecast-record-native'
import { scenarioForks } from '../brain/scenario-forks-native'
import { calibration } from '../brain/calibration-native'
import { scoreResolvedLedger } from '../brain/calibration-scoring'
import { syntheticReplayScore } from '../brain/calibration-replay'
import { buildAutonomyState } from '../ans/autonomy-report'
import { rearmCapability } from '../ans/governor'
import { rebuildEntityGraph } from '../brain/entity-graph-rebuild'
import { kgQuery } from '../brain/kg-query'
import { transitionScore } from '../brain/transition-delta'
import { loadLedger } from '../brain/claim-ledger'
import { decisionUtility } from '../brain/decision-utility'
import { calibrationTrend, readForecastLedgerRows } from '../brain/calibration-trend'
import { mineErrorRules } from '../brain/error-miner'
import { listActions, revertAction, implicitUndoTarget } from '../ans/action-ledger'
import { runCalibration } from '../brain/calibration-store'
import { getMoatHealth } from '../brain/moat-health'
import { runShadowMetabolism, runLiveMetabolism, applyClaimResolution, loadPersistedLedger, claimMetabolismLive, type ResolveAction } from '../brain/claim-extract'
import { parseDateMs } from '../brain/claim-ledger'
import { claimsAsOf } from '../brain/claim-metabolism'
import { runLearningShadow, runLearningDeep, gatherTopics, matchStale } from '../brain/learning-metabolism'
import { scoreStaleness, templatedStaleFacts, type EvalFact } from '../brain/grounding-eval'
import {
  scoreStalenessJudged,
  appendJudgeLabels,
  loadAdjudicatedLabels,
  outcomesFromScore,
  recordGroundingStalenessOutcomes,
  stalenessTrust,
  type JudgedFact
} from '../brain/grounding-eval-live'
import { runCalibrationMetabolism } from '../brain/calibration-metabolism'
import { runMeasurePass, createJudgeDeps, selectMeasureModelLocalFirst } from '../brain/judgment-measure-live'
import { getImprovementProposals } from '../brain/improvement-proposer'
import { runReflect } from '../brain/learn-store'
import { getTaste } from '../brain/learn-native'
import { listSpacesWrapped } from '../brain/spaces-native'
import { resolveCascade } from '../brain/cascade-apply-native'
import { generateOnce } from '../brain/generate-once-native'
import { captureWork } from '../brain/capture-work-write-native'
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
import { listProjectsWrapped } from '../brain/projects-native'
import { projectDetail } from '../brain/project-detail-native'
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
import { runPropagate, getInsights, getDecisionLoop, buildBrain } from '../brain'
import { chatOnce, routeModel, getProviderForModel } from '../providers/registry'
import { readLogTail, mainLogStatus, MAX_TAIL_LINES } from '../main-log'
import { buildCostLedger, parseCostWindow } from '../cost-ledger'
import { readRecentTurns } from './agui-journal'
import { buildOperatorBlock, pruneCandidatesFromStore, buildGovernAudit, efficacySummary, recordBoundRule, recordFacts, listByStatus, autoPromoteCandidates } from '../brain/operator-model'
import { contrastPair, contrastiveAbstraction, type ContrastChat, type CorrectionTraceLike } from '../brain/contrast-extraction'
import { runTransferAB, makeTransferDeps, DEFAULT_TRANSFER_QUERIES } from '../brain/transfer-ab'
import { recordTransferRun } from '../brain/transfer-ab-store'
import { getSuccesses } from '../brain/success-miner'
import { distillToSkill } from '../brain/named-skill'
import { loadNamedSkills, appendNamedSkill } from '../brain/named-skill-store'
import { turnBeatsEnabled, turnBeatReport } from './turn-beats'
import { handleDecision, handleInsightVerdict, handleProjectCreate, handleTrackAdd, handleTrackAssign, handleStreamUpdate, handleStreamSync, handleWorldUpdate, handleFutureAct, handlePredictionFeedback, handleAnchorDismiss, handleTaskBind, handleMeetingAction, handleMakeDecision, handleDecisionMeta, handleResolveNode, handleTaskAction, handleTaskMove, handleForecastVerdict, handleLogForecast, handleLearnCorrection } from './brain-state-routes'
import { messageOf } from '../guarded'
import { loadAliasOverlay } from '../brain/operator-alias-overlay'
import { assembleEntityCard, type CardGraphLink, type CardGraphNode } from '../brain/entity-card'
import { enrichEntity, enrichDisabled, pickEnrichModel } from '../brain/entity-enrich'
import { cachedBrainGraph } from './brain-native-routes'

// /debug/brain-health TTL cache — the computation is a measured 2.16s main-thread stall.
const BRAIN_HEALTH_TTL_MS = 5 * 60_000
let brainHealthCache: { at: number; body: string } | null = null

export function handleRequestNativeImpl2(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'

  // Helper: run an async native write handler with the standard notesDir-guard + body-parse + errors.
  // (Identical to the closure in handleRequestNativeImpl part 1 — the route chain was split across
  // two files, so each half carries its own copy of this req/res-scoped helper.)
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

  // /state/verdict — native decision_verdict (frontmatter + ## Updates + ledger row).
  if (method === 'POST' && url.split('?')[0] === '/state/verdict') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        let b: Record<string, unknown> = {}
        try {
          b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        } catch {
          b = {}
        }
        const did = String(b.id ?? '')
        const verdict = String(b.verdict ?? '')
        const note = String(b.note ?? '').trim() || 'recorded in DUIN'
        if (!did || !['right', 'wrong', 'partial', 'unobserved'].includes(verdict) || !notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'bad id or verdict' }))
          return
        }
        const r = recordVerdict(notesDir, did, verdict, note)
        res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: r.ok, msg: r.msg ?? r.error ?? '' }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'verdict error' }))
      }
    })()
    return
  }
  // /state/project-logo — store/clear a project's PNG logo (raw bytes body).
  // /state/upload — store an uploaded file (+ optional contacts→entities).
  if (method === 'POST' && url.split('?')[0] === '/state/upload') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no notes dir' }))
          return
        }
        const q = new URLSearchParams(url.split('?')[1] ?? '')
        const filename = q.get('filename') ?? 'upload.txt'
        const parse = q.get('parse') ?? ''
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(saveUpload(notesDir, filename, Buffer.concat(chunks), parse)))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'upload error' }))
      }
    })()
    return
  }

  // /state/project-logo — store/clear a project's PNG logo (raw bytes body).
  if (method === 'POST' && url.split('?')[0] === '/state/project-logo') {
    void (async () => {
      try {
        const q = new URLSearchParams(url.split('?')[1] ?? '')
        const project = q.get('project') ?? ''
        const logoDir = join(brainAssetsDir(), 'web', 'public', 'project-logos')
        if (q.get('clear')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(clearProjectLogo(logoDir, project)))
          return
        }
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(saveProjectLogo(logoDir, project, Buffer.concat(chunks))))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'project-logo error' }))
      }
    })()
    return
  }

  if (method === 'POST' && url.split('?')[0] === '/state/upload-raw') {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no notes dir' }))
          return
        }
        const filename = new URLSearchParams(url.split('?')[1] ?? '').get('filename') ?? 'upload'
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(saveToRaw(notesDir, filename, Buffer.concat(chunks))))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'upload-raw error' }))
      }
    })()
    return
  }

  if (method === 'GET' && url.startsWith('/state/stream-verdicts')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(streamVerdicts(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'stream-verdicts error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/forecast-owed')) {
    try {
      // NOTE: Python resolve-on-read (resolve_risk_ledger) is owned by calibration-store,
      // deferred to the coordinated flip. This serves the current ledger state.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(forecastOwed(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'forecast-owed error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/forecasts')) {
    try {
      // NET-NEW native capability (no Python equivalent): graph-DERIVED forecasts
      // (driver/convergence/cascade) over the migrated causalGraph() — the
      // non-obvious, grounded foresight that replaces deadline-clock decision-windows.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const fc = generateForecasts(notesDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ forecasts: fc }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'forecasts error' }))
    }
    return
  }

  if (method === 'POST' && url.split('?')[0] === '/state/forecasts/refresh') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const forecasts = generateForecasts(notesDir)
      // Explicit command boundary for generate -> log -> resolve. The GET above
      // remains a pure projection so browser prefetch and polling cannot advance
      // calibration state.
      logForecastsToLedger(notesDir, forecasts)
      runCalibration(notesDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ forecasts }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'forecast refresh error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/world-state')) {
    try {
      // Native-always (flipped): byte-parity with Python world_state (per-track
      // rollup + revealed_risks + edges/deltas), verified live.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(worldState(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'world-state error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/revealed-risks')) {
    try {
      // Native-always (flipped): byte-parity with Python revealed_risks (tasks that
      // READ as risks — near-term hard deadlines + risk language), verified live EXACT
      // vs :8765 on 2026-07-01. Already ported as a world-state helper; now its own route.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(revealedRisks(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'revealed-risks error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/forecast-record')) {
    try {
      // Native-always (flipped): byte-parity with Python forecast_record (pass-through
      // read of .duin/_state/forecast-track-record.json + empty fallback), verified live
      // EXACT vs :8765 on the dogfood vault 2026-07-01.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(forecastRecord(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'forecast-record error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/scenario-forks')) {
    try {
      // Native-always (flipped): byte-parity with Python scenario_forks (Layer-3
      // conditional futures — streams with cleared+blocked+decide_by), verified live
      // EXACT vs the sidecar on the dogfood vault 2026-07-01.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(scenarioForks(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'scenario-forks error' }))
    }
    return
  }

  // boundary-aware so it doesn't swallow '/state/calibration-metabolism' (a distinct route)
  if (method === 'GET' && (url === '/state/calibration' || url.startsWith('/state/calibration?') || url.startsWith('/state/calibration/'))) {
    try {
      // Native-always (flipped): structural parity with Python calibration (federated
      // scorecard over risk/decision-window/stream/plan-adherence/promotion state files
      // + Wilson/smoothing/gating), verified live EXACT vs the sidecar on the dogfood vault
      // 2026-07-01.
      //
      // PURE READ (reconciled 2026-07-02 during the UI↔brain merge): the resolve+score
      // write is owned by the /state/forecasts handler's runCalibration (the second-brain-iso
      // design — generate → log → resolve — which deliberately keeps this read pure to avoid
      // resolve-churn on every calibration dashboard poll). My earlier resolve-on-read here
      // (fb795dd) was superseded by that approach; removed to avoid a double-wire.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      // World-model Stage 2(d): surface the PROPER score on the golden payload. The scorecard is
      // efficacy-based, and the only probabilistic score lived one route away at
      // /state/calibration-score — so the operator-facing panel could read "No Brier" while a Brier
      // existed. It is additive (existing keys untouched) and best-effort: a scoring failure must
      // not take down the scorecard.
      let properScore: unknown = null
      try {
        properScore = scoreResolvedLedger(notesDir)
      } catch (e) {
        console.debug('[calibration] proper score unavailable:', messageOf(e))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...calibration(notesDir), properScore }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'calibration error' }))
    }
    return
  }

  // A4 (Evidence Threshold): PROPER scoring over resolved probabilistic forecasts — Brier +
  // log-loss + base-rate baseline + Murphy skill + reliability/ECE. Kept SEPARATE from the
  // golden-locked /state/calibration payload so it can't break that parity test; returns nulls
  // until probabilistic forecasts resolve (signal-mode decision-window excluded).
  if (method === 'GET' && (url === '/state/calibration-score' || url.startsWith('/state/calibration-score?'))) {
    try {
      // Opt-in labeled synthetic replay — demonstrates the Brier instrument NOW without touching
      // the real ledger; the organic path (default) is unchanged (operator decision 4).
      if (new URL(url, `http://${HOST}`).searchParams.get('replay') === 'synthetic') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(syntheticReplayScore()))
        return
      }
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(scoreResolvedLedger(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'calibration-score error' }))
    }
    return
  }

  // Phase-1 A1 (moat sprint): the FAST self-resolving signal. Turn-beats resolve in one turn, so
  // this Brier accrues in a session vs weeks for the slow forecast ledger. Kept in its OWN
  // namespace (turn-beats.jsonl) so it never pollutes the /state/calibration-score convergence
  // north-star. `calibration` is null until beats are graded; `trackMatch` is the structural rate.
  if (method === 'GET' && (url === '/state/turn-beats' || url.startsWith('/state/turn-beats?'))) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ enabled: turnBeatsEnabled(), ...turnBeatReport(notesDir) }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'turn-beats error' }))
    }
    return
  }

  if (method === 'GET' && (url === '/state/govern-audit' || url.startsWith('/state/govern-audit?'))) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildGovernAudit()))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'govern-audit error' }))
    }
    return
  }

  if (method === 'GET' && (url === '/state/autonomy' || url.startsWith('/state/autonomy?'))) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildAutonomyState(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'autonomy error' }))
    }
    return
  }

  // The entity graph's only DELETE path — operator-triggered, never on a tick.
  //
  // The store is retire-not-delete, which is right for incremental identity work but left the table
  // unable to shed anything: 3,999 of 6,124 nodes still carried the generic `entity` kind on
  // 2026-07-31, frozen there because the polluter was fixed but its output never could be. The
  // construction layer is clean now, so a rebuild finally has correct input to rebuild FROM.
  //
  // Refuses on a thin construction, refuses if it cannot back the graph up first, and re-applies
  // operator tombstones after the sync. See entity-graph-rebuild.ts for why each guard exists.
  if (method === 'POST' && url.split('?')[0] === '/state/graph/rebuild') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const result = rebuildEntityGraph(notesDir)
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result, null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'graph rebuild error' }))
    }
    return
  }

  // The operator half of the breaker. runGovernorPass trips capabilities automatically; this
  // is the only way one ever comes back, and it restores the floor rung in one step. Deliberately
  // POST-only and never invoked by a tick.
  //
  // `/state/autonomy/promote` is kept as an alias: it was the documented name and had no callers
  // to break, but a stale script pointing at it should still work rather than 404 silently.
  if (
    method === 'POST' &&
    ['/state/autonomy/rearm', '/state/autonomy/promote'].includes(url.split('?')[0])
  ) {
    try {
      const id = new URL(url, `http://${HOST}`).searchParams.get('id')
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'id is required' }))
        return
      }
      const result = rearmCapability(id)
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'autonomy rearm error' }))
    }
    return
  }

  if (method === 'POST' && url.split('?')[0] === '/state/undo') {
    try {
      const actionId = new URL(url, `http://${HOST}`).searchParams.get('actionId')
      // A bare undo skips machine-originated RSI records — see implicitUndoTarget's docblock for
      // why (reverting one fires a demote the operator never asked for). An explicit ?actionId=
      // still reaches them.
      const target = actionId ?? implicitUndoTarget()
      if (!target) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'no applied action to undo' }))
        return
      }
      const r = revertAction(target)
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'undo error' }))
    }
    return
  }

  if (method === 'GET' && (url === '/state/efficacy' || url.startsWith('/state/efficacy?'))) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ facts: efficacySummary() }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'efficacy error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/spaces')) {
    try {
      // Native-always (flipped 2026-07-02): top-level arena spaces + cross-type rollup.
      // Last unblocked pure read — closes the read surface. Parity-EXACT vs the sidecar.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(listSpacesWrapped(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'spaces error' }))
    }
    return
  }

  // World-model Stage 4: per-domain proper scores + a REAL improvement slope, and the
  // error->rule miner's shadow candidates. Read-only; the candidates go to the same human-gated
  // funnel as every other proposal and are never applied here.
  if (method === 'GET' && url.split('?')[0] === '/state/calibration-trend') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || ''
      const rows = readForecastLedgerRows(notesDir)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ...calibrationTrend(rows),
          errorCandidates: mineErrorRules(rows),
          shadow: true
        })
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'calibration-trend error' }))
    }
    return
  }

  // World-model Stage 3: the foresight axis scored (M1/M2/M3). M1/M2 report `awaiting-data`
  // rather than 0 — rankOptions exists, but no ranked rollout has been persisted to score over.
  if (method === 'GET' && url.split('?')[0] === '/state/decision-utility') {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const decisions = (listDecisions(notesDir ?? '')?.decisions ?? []) as unknown as Parameters<
        typeof decisionUtility
      >[1]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(decisionUtility(notesDir, decisions)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'decision-utility error' }))
    }
    return
  }

  // World-model Stage 2(c): the TRANSITION function scored. Replays each decision as a
  // counterfactual through runVerdicts and diffs the predicted claim-delta against what the live
  // metabolism actually retired. Deterministic and LLM-free — same ledger in, same score out.
  if (method === 'GET' && url.split('?')[0] === '/state/transition-score') {
    try {
      const q = new URL(url, `http://${HOST}`).searchParams
      const notesDir = (readSettings().localBrainNotesDir as string) || ''
      const claims = loadLedger(notesDir)
      const only = q.get('decisionId')
      const ids = only
        ? [only]
        : (listDecisions(notesDir)?.decisions ?? []).map((d: { id: string }) => d.id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(transitionScore(claims, ids, Date.now())))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'transition-score error' }))
    }
    return
  }

  // World-model Stage 1: the entity graph's READ-BACK surface. Multi-hop traversal from a seed
  // entity, answered with the claims that were true AT `asOf` (bitemporal point-in-time). This is
  // what turns entity_nodes/entity_edges from a write-only sink into the multi-hop substrate.
  if (method === 'GET' && url.split('?')[0] === '/state/kg-query') {
    try {
      const q = new URL(url, `http://${HOST}`).searchParams
      const seed = q.get('seed')
      if (!seed) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'seed is required' }))
        return
      }
      const asOfRaw = q.get('asOf')
      const asOfMs = asOfRaw ? Date.parse(asOfRaw) : NaN
      const notesDir = (readSettings().localBrainNotesDir as string) || ''
      const result = kgQuery(notesDir, {
        seed,
        hops: q.get('hops') ? Number(q.get('hops')) : undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
        asOf: Number.isFinite(asOfMs) ? asOfMs : null
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'kg-query error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/anchors')) {
    try {
      // Native-always (flipped): structural parity with Python anchors (branch/converge
      // view — tasks bound to (C) anchor decls, branch risk rollup, critical path, and
      // DECLARED cross-anchor convergence), verified live EXACT vs the sidecar on
      // the dogfood vault 2026-07-01 (6 anchors / 15 convergences). Skips the
      // _log_anchor_predictions() ledger write (side effect, no body impact). NB: this
      // does NOT intercept /state/anchor-candidates — no handler exists anywhere (the
      // lark-cli-backed Python one was retired with the sidecar), so that URL 404s.
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(anchors(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'anchors error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/insights')) {
    try {
      const ins = getInsights((readSettings().localBrainNotesDir as string) || null)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // {count, insights} — byte-parity with the Python sidecar's shape (the UI reads .count).
      res.end(JSON.stringify({ count: ins.insights.length, insights: ins.insights }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'insights error' }))
    }
    return
  }

  // Judgment-measure — run the A/B behavioral prune over promoted + provisional facts ON-DEMAND
  // (expensive: several model calls per fact). Returns keep / prune-candidate verdicts and PERSISTS
  // an additive efficacy signal per fact (no status change, no prune). Native, key-gated.
  if (method === 'POST' && url.startsWith('/state/measure-facts')) {
    // Item 13 — turn-safe: respond immediately (202) + run the (slow, many-model-call) A/B pass in
    // the background. Results are readable via GET /state/efficacy once persisted. A bulk measure
    // never blocks the HTTP turn.
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'started' }))
    void runMeasurePass().catch(() => {})
    return
  }

  // Improvement proposals — the self-improvement meta-loop, SHADOW-only (read the loop
  // stores → propose retire/prune/sharpen; never applies). Native, no Python counterpart.
  if (method === 'GET' && url.startsWith('/state/improvements')) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ shadow: true, proposals: getImprovementProposals(pruneCandidatesFromStore()) }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'improvements error' }))
    }
    return
  }

  // Calibration-metabolism (SHADOW) — the THIRD client: the currency axis on calibration. Which
  // per-kind useful-rates are built on RECENT vs stale evidence (a lifetime average hides drift).
  // Annotates only; live gating unchanged.
  if (method === 'GET' && url.startsWith('/state/calibration-metabolism')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(runCalibrationMetabolism(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'calibration-metabolism error' }))
    }
    return
  }

  // Learning-metabolism (Phase 1, SHADOW) — the SECOND client of the world-state judge: which
  // active (promoted/provisional) operator facts WOULD archive as stale because they mention a
  // resolved decision / passed stream. Currency axis, orthogonal to the govern loop; grounding
  // untouched (surface before it ever gates buildOperatorBlock).
  if (method === 'GET' && url.split('?')[0] === '/state/learning-metabolism') {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(runLearningShadow(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'learning-metabolism error' }))
    }
    return
  }

  // Model-backed residue evaluation is an explicit authenticated command, not
  // a query parameter on a read route.
  if (method === 'POST' && url.split('?')[0] === '/state/learning-metabolism/deep') {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    void runLearningDeep(notesDir).then((out) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'learning-metabolism error' }))
    })
    return
  }

  // FILL (cold-start): seed the operator-fact store from the vault's human-authored Rules cards so
  // grounding warms and the govern loop gets provisional fuel. Idempotent (deduped). POST, no body.
  if (method === 'POST' && url.startsWith('/state/cold-start-seed')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(seedFromVault(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'cold-start-seed error' }))
    }
    return
  }

  // FINISH (self-evolution Move 3, WS3.1+WS3.2): the recurrence→bind closing arrow. GET surfaces the
  // ledger; POST is the HUMAN-CONFIRM bind (nothing auto-binds). Text-rule only — records the rule +
  // opens a falsifiable "won't recur" guarantee; does NOT auto-apply the rule to grounding.
  // WS4.1 (BUILD / Voyager): distill a success-verified trace into a named, retrievable skill. POST
  // is the human/success trigger (nothing auto-distills); the model does the distillation. GET lists.
  if (method === 'GET' && url.startsWith('/state/named-skills')) {
    try {
      const nd = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ skills: loadNamedSkills(nd) }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'named-skills error' }))
    }
    return
  }
  if (method === 'POST' && url.startsWith('/state/skill-distill')) {
    void (async () => {
      try {
        const nd = (readSettings().localBrainNotesDir as string) || null
        const parsed = JSON.parse((await readBody(req)) || '{}') as { traceId?: unknown }
        const traceId = typeof parsed.traceId === 'string' ? parsed.traceId : ''
        const trace = getSuccesses().find((t) => t.id === traceId)
        if (!trace) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'skill-distill requires a valid traceId (an endorsed success trace)' }))
          return
        }
        const model = routeModel('reason')
        if (!model) {
          res.writeHead(503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no model configured — cannot distill' }))
          return
        }
        const sys =
          'Distill the successful exchange below into a reusable named skill. Reply as JSON only: {"name": a short imperative name, "description": one line on when to use it, "procedure": the repeatable steps that worked}.'
        const user = `REQUEST:\n${trace.query}\n\nWHAT WORKED (the endorsed answer):\n${trace.answer}`
        const distilled = { name: '', description: '', procedure: '' }
        try {
          const r = await chatOnce(
            [
              { role: 'system', content: sys },
              { role: 'user', content: user }
            ],
            model,
            undefined,
            { purpose: 'other', role: 'skill-distill' }
          )
          const m = /\{[\s\S]*\}/.exec(r.content || '')
          if (m) {
            const j = JSON.parse(m[0]) as { name?: string; description?: string; procedure?: string }
            distilled.name = j.name ?? ''
            distilled.description = j.description ?? ''
            distilled.procedure = j.procedure ?? ''
          }
        } catch (e) { console.debug('[brain-native-routes-2] fall through to the guard:', messageOf(e)) }
        if (!distilled.name.trim() && !distilled.procedure.trim()) {
          res.writeHead(502, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'distillation produced no usable skill' }))
          return
        }
        const skill = distillToSkill(trace, distilled, Date.now())
        const added = appendNamedSkill(nd, skill)
        // Phase 3a (self-improve bridge): skill↔capability. A distilled skill registers a
        // capability so it can EARN autonomy over time (before this, only the 3 seeded engine
        // caps existed — no skill was ever a governed capability). Registered at 'stage' with a
        // 'stage' floor: a skill runs a procedure, so it NEVER earns silent (reflexive) autonomy.
        // classify() actually gating it is the operator-activated Phase 3b wire.
        if (added) {
          try {
            registerCapability({ id: `named-skill:${skill.id}`, title: `skill: ${skill.name}`, rung: 'stage', floorRung: 'stage' })
          } catch (e) { console.debug('[brain-native-routes-2] skill capability register skipped:', messageOf(e)) }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, added, skill }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'skill-distill error' }))
      }
    })()
    return
  }
  if (method === 'GET' && url.startsWith('/state/bindings')) {
    try {
      const nd = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ bindings: loadBindings(nd) }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'bindings error' }))
    }
    return
  }
  if (method === 'POST' && url.startsWith('/state/bind-candidate')) {
    void (async () => {
      try {
        const nd = (readSettings().localBrainNotesDir as string) || null
        const parsed = JSON.parse((await readBody(req)) || '{}') as {
          candidate?: { theme?: unknown; count?: unknown; sample?: unknown }
          rule?: unknown
        }
        const theme = Array.isArray(parsed.candidate?.theme)
          ? (parsed.candidate!.theme as unknown[]).filter((t): t is string => typeof t === 'string')
          : []
        const rule = typeof parsed.rule === 'string' ? parsed.rule : ''
        if (theme.length === 0 || !rule.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'bind-candidate requires candidate.theme[] and a rule' }))
          return
        }
        const candidate = {
          theme,
          count: typeof parsed.candidate?.count === 'number' ? (parsed.candidate!.count as number) : theme.length,
          sample: typeof parsed.candidate?.sample === 'string' ? (parsed.candidate!.sample as string) : ''
        }
        const row = bindCandidate(candidate, rule, Date.now())
        appendBinding(nd, row)
        // Phase 1 unification: apply the bound rule to grounding through the operator-model
        // lifecycle. The binding-ledger records + falsifies the rule but (per its own header)
        // never grounded it; this lands it as a provisional fact so it reaches the prompt, and
        // the govern pass earns it 'promoted' (rerank inclusion). Best-effort — a failure here
        // must not break the bind response.
        try {
          // null (not a throw) means the rule failed the fact guards (e.g. question-form) —
          // the binding is recorded but won't ground; surface it rather than silently dropping.
          if (recordBoundRule(row.rule, row.id) === null) {
            console.warn('[brain-native-routes-2] bound rule did not reach grounding (failed fact guards):', row.id)
          }
        } catch (e) {
          console.debug('[brain-native-routes-2] bound-rule grounding is best-effort:', (e as Error)?.message)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, binding: row }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'bind-candidate error' }))
      }
    })()
    return
  }

  // Claim-metabolism (Phase 1, SHADOW) — the world-state-gated graph metabolism's verdict pass.
  // Reports what WOULD be verdicted (stale/contradicted/orphaned) against the live world-state
  // WITHOUT persisting retirements or changing retrieval (spot-check before auto-penalize).
  // `?includeLedger=1` also returns the persisted ledger rows for audit (empty until persist lands).
  // Matched by exact base path so the POST /resolve subroute below is not swallowed.
  if (method === 'GET' && url.split('?')[0] === '/state/claim-metabolism') {
    void (async () => {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      // Point-in-time ("as-of T") bitemporal query: ?asOf=<ISO date or epoch ms> returns the claims
      // whose valid interval (validFrom ≤ T < validTo) contains T — "what was true at time T", the
      // temporal read the stored validFrom/validTo exist to serve. Reads the durable ledger.
      const asOfMatch = /[?&]asOf=([^&]+)/.exec(url)
      if (asOfMatch) {
        const raw = decodeURIComponent(asOfMatch[1])
        const t = /^\d+$/.test(raw) ? Number(raw) : parseDateMs(raw)
        if (t === null || !isFinite(t)) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'asOf must be an ISO date (YYYY-MM-DD) or epoch ms' }))
          return
        }
        const ledger = loadPersistedLedger(notesDir)
        const asOf = claimsAsOf(ledger, t)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ asOf: new Date(t).toISOString(), t, count: asOf.length, ledgerSize: ledger.length, claims: asOf }))
        return
      }
      const includeLedger = /[?&]includeLedger=1(&|$)/.test(url)
      const shadow = await runShadowMetabolism(notesDir)
      const payload = includeLedger ? { ...shadow, ledger: loadPersistedLedger(notesDir) } : shadow
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'claim-metabolism error' }))
    }
    })()
    return
  }

  // Reversibility/audit surface (the moat-safety guarantee): a govern/operator durably undoes a
  // wrong verdict ('revert' → unretire → pinned) or ratifies the current state ('confirm' →
  // pinned). Once pinned, the deterministic pass + rebuild-merge both leave it alone, so the human
  // decision survives every tick. Matched by exact path (method+path) to avoid the startsWith
  // footgun where the GET base route above would otherwise swallow this subroute.
  if (method === 'POST' && url.split('?')[0] === '/state/claim-metabolism/resolve') {
    nativeWrite('claim-metabolism-resolve', (nd, b) => {
      const claimId = String(b.claimId ?? '').trim()
      const action = String(b.action ?? '') as ResolveAction
      if (!claimId) return { ok: false, error: 'claimId required' }
      if (action !== 'confirm' && action !== 'revert') return { ok: false, error: "action must be 'confirm' or 'revert'" }
      const res2 = applyClaimResolution(nd, claimId, action)
      return res2.ok
        ? { ok: true, claim: res2.claim }
        : { ok: false, error: res2.reason ?? 'resolve failed' }
    })
    return
  }

  // On-demand LIVE metabolism commit — extract→merge→judge→persist deterministic verdicts (the
  // same pass the periodic tick runs). Persists ONLY when DUIN_CLAIM_METABOLISM_LIVE is on; off ⇒
  // a shadow compute (persists nothing), so the route is safe to call either way. `live` echoes
  // whether the write happened, so a caller/verifier can tell shadow from committed.
  if (method === 'POST' && url.split('?')[0] === '/state/claim-metabolism/run') {
    nativeWrite('claim-metabolism-run', async (nd) => ({ ok: true, live: claimMetabolismLive(), result: await runLiveMetabolism(nd) }))
    return
  }

  // Moat-health — the "is the moat compounding?" instrument over the loop stores (native,
  // no Python counterpart; a new surface).
  if (method === 'GET' && url.startsWith('/state/moat-health')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getMoatHealth(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'moat-health error' }))
    }
    return
  }

  // POST /state/insight-verdict {id, verdict} — HTTP parity for the
  // brain:insightVerdict IPC. Writes the SAME in-process brain getInsights()
  // reads, so it works even when the proxied (sidecar) logic falls through.
  if (method === 'POST' && url.startsWith('/state/insight-verdict')) {
    void handleInsightVerdict(req, res)
    return
  }
  // /state/conversation-delete — brain no-op (the app DB owns Recents), native
  // was proxied to Python @7947. Wire-only tombstone, no module.
  if (method === 'POST' && url.startsWith('/state/conversation-delete')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Learn loop — native, single-writer TS (was proxied to the Python sidecar). The
  // proxy gate only forwards /state and /graph, so /learn/* already falls through
  // here; these handlers make it write via learn-store/learn-native instead of Python.
  if (method === 'POST' && url.startsWith('/state/project-create')) {
    void handleProjectCreate(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/track-add')) {
    void handleTrackAdd(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/track-assign')) {
    void handleTrackAssign(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/stream-sync')) {
    void handleStreamSync(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/world-update') && !url.startsWith('/state/world-update-act')) {
    void handleWorldUpdate(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/future-act')) {
    void handleFutureAct(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/prediction-feedback')) {
    void handlePredictionFeedback(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/anchor-dismiss')) {
    void handleAnchorDismiss(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/task-bind')) {
    void handleTaskBind(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/stream-update')) {
    void handleStreamUpdate(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/meeting-action')) {
    void handleMeetingAction(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/make-decision')) {
    void handleMakeDecision(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/decision-meta')) {
    void handleDecisionMeta(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/resolve-node')) {
    void handleResolveNode(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/task-action')) {
    void handleTaskAction(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/task-move')) {
    void handleTaskMove(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/state/forecast-verdict')) {
    void handleForecastVerdict(req, res).catch((e) => {
      console.error('[local-brain] forecast-verdict threw:', (e as Error)?.message ?? e)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false }))
        } else res.end()
      } catch (e) { console.debug('[brain-native-routes-2] socket already gone:', messageOf(e)) }
    })
    return
  }
  if (method === 'POST' && (url === '/state/forecast' || url.startsWith('/state/forecast?'))) {
    void handleLogForecast(req, res).catch((e) => {
      console.error('[local-brain] log-forecast threw:', (e as Error)?.message ?? e)
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false }))
        } else res.end()
      } catch (e) { console.debug('[brain-native-routes-2] socket already gone:', messageOf(e)) }
    })
    return
  }

  if (method === 'POST' && url.startsWith('/learn/correction')) {
    void handleLearnCorrection(req, res)
    return
  }
  if (method === 'POST' && url.startsWith('/learn/reflect')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(runReflect(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'reflect error' }))
    }
    return
  }
  if (method === 'GET' && url.startsWith('/learn/taste')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getTaste(notesDir)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'taste error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/decision-loop')) {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getDecisionLoop((readSettings().localBrainNotesDir as string) || null)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'decision-loop error' }))
    }
    return
  }

  // Note read — load a vault note's raw markdown for the side panel / DocView.
  // In-process so notes load even when the renderer is on the local-brain base.
  if (method === 'POST' && url.startsWith('/state/doc/save')) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}') as { path?: string; content?: string }
        const full = docAbspath(String(parsed.path ?? ''))
        if (!full) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'invalid path' }))
          return
        }
        // Create OR overwrite — docAbspath has already vault-sandboxed the path, so
        // authoring a new note (e.g. a new Output) is safe. But an overwrite here can
        // destroy a hand-authored body: OutputsPanel derives BOTH the path (slugified
        // title) and the body (fresh stub) with no prior read, so re-saving the same
        // title clobbered the grown note. Preserve the prior bytes to <vault>/.trash
        // first — same guard the sibling /state/doc/delete route uses, same guard
        // memory-store already applies to its own slug-derived write.
        const vaultDir = (readSettings().localBrainNotesDir as string) || ''
        const saved = saveVaultDoc(vaultDir, full, String(parsed.content ?? ''), 'ui:doc-save', String(parsed.path ?? ''))
        if (!saved.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: saved.error }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...(saved.replaced ? { replaced: saved.replaced } : {}) }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'save failed' }))
      }
    })()
    return
  }
  // Note soft-delete — move a vault note to <vault>/.trash (matches the retired
  // server.py soft-delete semantics). Ported alongside /state/doc/save during
  // arch-unify but originally dropped, so the renderer's Delete button 404'd. The
  // GET /state/doc read below is method-gated, so this POST can't fall through to
  // it; and /state/doc/delete never matches the /state/doc/save prefix above.
  if (method === 'POST' && url.startsWith('/state/doc/delete')) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}') as { path?: string }
        const full = docAbspath(String(parsed.path ?? ''))
        if (!full || !existsSync(full)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'not found' }))
          return
        }
        const vaultDir = (readSettings().localBrainNotesDir as string) || ''
        // Shared with the model-driven delete_file executor (agui-executors.ts) — one
        // tombstone implementation so the agent path and this UI path cannot drift apart.
        const t = tombstoneToTrash(vaultDir, full, 'ui:doc-delete')
        if (!t.ok) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: t.error }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, trashed: t.trashRel }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'delete failed' }))
      }
    })()
    return
  }
  // DELETE A GRAPH NODE. The sibling route above deletes a NOTE (a file); this
  // removes a doc-less graph entity — a person/org/topic/entity that exists only
  // in the entity graph and so had no delete affordance at all: the Explorer's
  // Delete button is gated on a resolved file, which these never have.
  //
  // RETIRE, NOT DROP: retireNode stamps `valid_to`, matching the store's
  // retire-not-delete contract everywhere else. That makes this reversible, and
  // it makes it FAST — one indexed UPDATE, no cascade walk, no table rewrite —
  // which is what lets the UI treat the click as instant.
  if (method === 'POST' && url.startsWith('/state/node/delete')) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}') as { id?: string }
        const id = String(parsed.id ?? '').trim()
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'id required' }))
          return
        }
        if (!isNodeLive(id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no live node with that id' }))
          return
        }
        retireNode(id, new Date().toISOString())
        // Journal it vault-side, and note this is now the ONLY reason it matters.
        //
        // The original comment here said `entity_nodes` "has no rebuild path" — true when written,
        // false since 4b73f25 added POST /state/graph/rebuild. It is still absent from
        // DURABLE_TABLES and moat-backup, and that is CORRECT rather than a gap: the Brain plane is
        // derived by constitutional definition, and both of the graph's inputs are already durable
        // vault-side (the construction cache in .brain/state, the claim ledger in .duin/_state), so
        // every node is reconstructible. Backing up derived rows would write megabytes into a synced
        // vault every moat flush to protect something we can recompute.
        //
        // A deletion is the one thing in there that is NOT derived — nothing can recompute a
        // judgement like this — so it is the one thing that must be journalled. Without this line
        // the operator's deletion lives in exactly one place and a rebuild resurrects the node;
        // reapplyNodeTombstones is what puts it back, proven end-to-end in
        // node-tombstones-integration.test.ts.
        recordNodeTombstone((readSettings().localBrainNotesDir as string) || null, id)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, retired: id }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'delete failed' }))
      }
    })()
    return
  }

  // ── Entity card ─────────────────────────────────────────────────────────────────────
  // Everything the brain already knows about ONE derived entity, joined in entity-card.ts from
  // the construction cache (triples by raw label), the claim ledger (by canonical id), alias
  // groups + the operator overlay, the served graph (typed relations, mentions) and the notes
  // (one sentence per source). `enrich=1` also runs the model pass (entity-enrich.ts): a short
  // grounded prompt per entity, local model first, persisted per material hash.
  if (method === 'GET' && url.split('?')[0] === '/state/entity') {
    void (async () => {
      try {
        const q = new URL(url, `http://${HOST}`).searchParams
        const id = (q.get('id') ?? '').trim()
        const vault = (readSettings().localBrainNotesDir as string) || ''
        if (!id || !vault) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: id ? 'no brain folder' : 'id is required' }))
          return
        }
        const graph = JSON.parse(cachedBrainGraph(vault).json) as { nodes: CardGraphNode[]; links: CardGraphLink[] }
        const readNote = (rel: string): string | null => {
          const abs = docAbspath(rel)
          if (!abs || !existsSync(abs)) return null
          try {
            if (statSync(abs).size > 512 * 1024) return null
            return readFileSync(abs, 'utf-8')
          } catch {
            return null
          }
        }
        const card = assembleEntityCard({
          id,
          graph,
          construction: getConstruction(),
          claims: loadLedger(vault),
          aliasGroups: activeAliasGroups(),
          overlay: loadAliasOverlay(vault),
          readNote,
          timestamps: nodeTimestamps(id)
        })
        if (!card) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no such entity' }))
          return
        }
        const enrichAvailable = !enrichDisabled() && !!pickEnrichModel()
        // Without enrich=1 only a stored, still-matching description is returned (no model call).
        card.enrichment = await enrichEntity(vault, card, q.get('enrich') === '1' ? { force: q.get('force') === '1' } : { model: null })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ card, enrichAvailable }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'entity card error' }))
      }
    })()
    return
  }


  // ORGANIZE THE VAULT BY HAND — rename / move a note, rename / create a folder, create a note,
  // name a derived entity. The Explorer had edit and delete and nothing between: no way to
  // rename a note without breaking every [[link]] to it, no way to move one, no way to correct
  // the extractor's name for an entity. vault-organize.ts owns the file side (vault-confined,
  // no clobber, links rewritten, prior bytes preserved to .trash, every act journalled);
  // node-labels.ts owns the entity side (an append-only ledger the served graph applies after
  // its build pipeline). Each route re-indexes through the same path the watcher uses, so the
  // graph, the index and every Brain surface follow the change without a manual rebuild.
  const ORGANIZE_ROUTES: Record<string, string> = {
    '/state/organize/rename-note': 'rename-note',
    '/state/organize/move-note': 'move-note',
    '/state/organize/rename-folder': 'rename-folder',
    '/state/organize/create-folder': 'create-folder',
    '/state/organize/create-note': 'create-note',
    '/state/organize/label-node': 'label-node'
  }
  const organizeOp = method === 'POST' ? ORGANIZE_ROUTES[url.split('?')[0]] : undefined
  if (organizeOp) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>
        const str = (k: string): string => (typeof parsed[k] === 'string' ? (parsed[k] as string) : '')
        const vaultDir = (readSettings().localBrainNotesDir as string) || ''
        if (!vaultDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no brain folder is set' }))
          return
        }
        const actor = 'ui:organize'
        const op = organizeOp
        type OrganizeRouteResult = { ok: boolean; error?: string; path?: string }
        let result: OrganizeRouteResult
        let touched: string | undefined
        switch (op) {
          case 'rename-note':
            result = renameNote(vaultDir, str('path'), str('newName'), { actor, updateLinks: parsed.updateLinks !== false })
            touched = result.ok ? join(vaultDir, String(result.path)) : undefined
            break
          case 'move-note':
            result = moveNote(vaultDir, str('path'), str('toFolder'), { actor })
            touched = result.ok ? join(vaultDir, String(result.path)) : undefined
            break
          case 'rename-folder':
            result = renameFolder(vaultDir, str('path'), str('newName'), { actor })
            break
          case 'create-folder':
            result = createFolder(vaultDir, str('path'), { actor })
            break
          case 'create-note':
            result = createNote(vaultDir, str('folder'), str('name'), { actor })
            touched = result.ok ? join(vaultDir, String(result.path)) : undefined
            break
          case 'label-node': {
            const id = str('id').trim()
            if (!id) {
              result = { ok: false, error: 'id required' }
              break
            }
            const ok = recordNodeLabel(vaultDir, id, str('label'))
            result = ok ? ({ ok: true, id, label: str('label').trim() } as OrganizeRouteResult) : { ok: false, error: 'could not write the label ledger' }
            if (ok) {
              invalidateBrainGraphCache()
              for (const w of BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed()) w.webContents.send('brain:updated', { count: -1 })
              }
            }
            break
          }
          default:
            result = { ok: false, error: `unknown organize op: ${op}` }
        }
        if (result.ok && op !== 'label-node') {
          // Same path a chokidar event takes: debounced reindex, vault-version bump, then the
          // gated extraction/construction tail. The watcher will also see the rename, so this
          // only makes the change visible sooner, never twice.
          scheduleReindex(vaultDir, touched)
          invalidateBrainGraphCache()
        }
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'organize failed' }))
      }
    })()
    return
  }

  if (method === 'GET' && url.startsWith('/state/doc')) {
    try {
      const rel = new URL(url, `http://${HOST}`).searchParams.get('path') ?? ''
      const full = docAbspath(rel)
      const content = full && existsSync(full) ? readFileSync(full, 'utf8') : null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ content }))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'doc read error' }))
    }
    return
  }

  if (method === 'GET' && url.startsWith('/state/event-prep')) {
    try {
      // Native-always (flipped): byte-parity with Python event_prep (prep view for one
      // milestone — bound tasks over the full corpus + feeding moves), verified live EXACT
      // vs the sidecar on the dogfood vault (6 anchor ids + not-found). Pure read.
      const id = new URL(url, `http://${HOST}`).searchParams.get('id') ?? ''
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(eventPrep(notesDir, id)))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'event-prep error' }))
    }
    return
  }

  if (method === 'POST' && url.startsWith('/state/decision')) {
    void handleDecision(req, res)
    return
  }

  if (method === 'POST' && url.startsWith('/agui')) {
    // The http: withScope wrapper around the router cannot see this turn: the
    // route returns immediately and every expensive stage runs afterwards, off
    // the awaits. A phase spans that, so a main-thread block during the turn is
    // reported as phase:agui-turn instead of 'unattributed'.
    void withPhase('agui-turn', () => handleAgui(req, res))
    return
  }

  // Embedder A/B eval (Spec §C) — fire-and-forget; result lands in
  // userData/embedder-eval-result.json. Reindexes the dogfood vault under each
  // candidate, so it's a deliberate operator action, not a hot-path route.
  if (method === 'POST' && url.startsWith('/debug/embedder-eval')) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = (body ? JSON.parse(body) : {}) as {
          candidates?: string[]
          labeled?: LabeledQuery[]
        }
        const candidates =
          Array.isArray(parsed.candidates) && parsed.candidates.length
            ? parsed.candidates
            : ['bge-small-en-v1.5', 'multilingual-e5-small']
        const labeled = Array.isArray(parsed.labeled) ? parsed.labeled : []
        const notesDir = (readSettings().localBrainNotesDir as string) || ''
        if (!notesDir || labeled.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'need a notes dir + a non-empty labeled set' }))
          return
        }
        void runEmbedderEval(notesDir, candidates, labeled, new Date().toISOString())
        res.writeHead(202, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ started: true, candidates, resultFile: 'embedder-eval-result.json' }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Index-status — lets an external caller (benchmark harness) wait for the search index to settle
  // after a vault repoint (POST /state/config → debounced reindex) instead of racing it: poll until
  // `indexing:false` and `docCount` reaches the expected note count. Read-only.
  if (method === 'GET' && url.startsWith('/state/index-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ indexing: isReindexing(), docCount: indexedCount(),
                             dir: (readSettings().localBrainNotesDir as string) || '' }))
    return
  }

  // Capability-gap detector (Spec #2 §1) — read-only ranked "where am I weak" list.
  if (method === 'GET' && url.startsWith('/debug/gaps')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ gaps: detectGapsLive(notesDir) }, null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Self-improvement BRIDGE benchmark (4-axis) — read-only scorer over the .duin/_state
  // ledgers + moat stores (connectedness · efficacy · safety · compounding). Appends each
  // run to self-improve-bench-history.jsonl so the build is diffable across phases.
  // See PLANNING/DUIN_SELF_IMPROVE_BRIDGE_PLAN.md. Mirrors /debug/gaps.
  if (method === 'GET' && url.startsWith('/debug/self-improve-bench')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          notesDir ? runSelfImproveBench(notesDir, new Date().toISOString()) : { error: 'no vault configured' },
          null,
          2
        )
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Main-process log tail — the always-on warn-level sink main-log.ts keeps at
  // <userData>/logs/main.log (wired from debug-trace.ts). The instance evaluated on 2026-09-02
  // had no main-process log at all (L7 F3); this is how a stall warning, a breaker line or a
  // provider error becomes readable without a terminal. Token-gated (control-plane-policy:
  // the log can name files, models and error text — more than a tokenless probe should get).
  // `?n=` lines (default 200, capped at MAX_TAIL_LINES). Publishes the sink's own limits.
  if (method === 'GET' && url.split('?')[0] === '/debug/log-tail') {
    try {
      const raw = Number(new URLSearchParams(url.split('?')[1] ?? '').get('n'))
      const n = Number.isFinite(raw) && raw > 0 ? Math.min(MAX_TAIL_LINES, Math.floor(raw)) : 200
      const lines = readLogTail(n) // flushes the buffer first, so the status below is current
      const status = mainLogStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          {
            lines,
            n,
            limits: { maxLines: MAX_TAIL_LINES, ...status }
          },
          null,
          2
        )
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error)?.message ?? 'log-tail error' }))
    }
    return
  }

  // Cost ledger — spend per role and per provider over `?window=24h|7d` (cost-ledger.ts):
  // model.request.completed payloads (background roles) plus the turn journal's TURN_END.costUsd
  // (chat turns, whose streaming calls emit no spine event). Says `estimated: true` whenever a
  // fallback price or a historically redacted counter is involved, and publishes its window,
  // sources and caps. Token-gated like the log tail. Async: the journal reader is.
  if (method === 'GET' && url.split('?')[0] === '/debug/cost') {
    void (async () => {
      try {
        const window = parseCostWindow(new URLSearchParams(url.split('?')[1] ?? '').get('window'))
        const turns = await readRecentTurns(500)
        const ledger = buildCostLedger({
          window,
          journalTurns: turns.map((t) => ({ at: t.at, model: t.model, end: t.end })),
          providerOf: (id) => {
            try {
              return getProviderForModel(id)
            } catch {
              return 'unknown'
            }
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(ledger, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? 'cost ledger error' }))
      }
    })()
    return
  }

  // Retrieval probe — measure retrieval ALONE against labelled gold notes. Read-only: it runs the
  // real search stack under a caller-supplied config and returns the ranked retrieved set plus
  // recall@k / MRR / hit-rate. No answer model, no judge, no tokens — which is what makes sweeping
  // a config affordable. Body: { probes: [{id, query, gold[]}], config?: Partial<RetrievalTunables> }.
  // The config is CLAMPED before use, so this route cannot push retrieval outside the safe envelope.
  if (method === 'POST' && url.startsWith('/debug/retrieval-probe')) {
    void (async () => {
      try {
        const raw = await readBody(req)
        const body = (raw ? JSON.parse(raw) : {}) as {
          probes?: RetrievalProbe[]
          config?: Partial<RetrievalTunables>
        }
        const probes = Array.isArray(body.probes) ? body.probes : []
        if (probes.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ error: 'body.probes must be a non-empty array of {id, query, gold[]}' })
          )
          return
        }
        // Start from the vault's stored config so an omitted field means "what the vault runs
        // today", not "the shipped default" — otherwise a partial sweep would silently reset the
        // knobs it did not mention.
        const base = readRetrievalTunables((readSettings().localBrainNotesDir as string) || null)
        const config = clampRetrievalTunables({ ...base, ...(body.config ?? {}) })
        const run = await runRetrievalProbes(probes, (q, k, cfg) => search(q, k, cfg), config)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(run, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Retrieval CONFIG SEARCH. The probe route above scores ONE config; this runs
  // the coordinate sweep over the probe objective and reports the winner.
  //
  // Held-out by DEFAULT (`holdout: false` opts out): a sweep scored on the same
  // probes it optimised is grading its own homework, and the resulting "gain" is
  // partly memorisation. `sweepWithHoldout` splits the probe set, sweeps on
  // train, and re-scores the winner on test — the verdict callers should read.
  //
  // READ-ONLY: this never writes the vault's tunables. Adopting a winning config
  // stays a human decision, consistent with every other promotion in the brain.
  if (method === 'POST' && url.startsWith('/debug/retrieval-sweep')) {
    void (async () => {
      try {
        const raw = await readBody(req)
        const body = (raw ? JSON.parse(raw) : {}) as {
          probes?: RetrievalProbe[]
          config?: Partial<RetrievalTunables>
          holdout?: boolean
          every?: number
          maxEvals?: number
          maxPasses?: number
          sigmas?: number
          minDelta?: number
        }
        const probes = Array.isArray(body.probes) ? body.probes : []
        if (probes.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({ error: 'body.probes must be a non-empty array of {id, query, gold[]}' })
          )
          return
        }
        const base = readRetrievalTunables((readSettings().localBrainNotesDir as string) || null)
        const start = clampRetrievalTunables({ ...base, ...(body.config ?? {}) })
        const searchFn: SearchFn = (q, k, cfg) => search(q, k, cfg)
        const opts = {
          maxEvals: body.maxEvals,
          maxPasses: body.maxPasses,
          sigmas: body.sigmas,
          minDelta: body.minDelta
        }
        const result =
          body.holdout === false
            ? await sweepRetrievalConfig(probes, searchFn, start, opts)
            : await sweepWithHoldout(probes, searchFn, start, { ...opts, every: body.every })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        // No `applied` field: there is no writeRetrievalTunables() in the repo
        // (retrieval-tunables.ts exports read + clamp only), so this route can
        // never adopt a sweep result. A hardcoded `applied: false` reads as a
        // runtime outcome when it is a structural fact — property 8.
        res.end(JSON.stringify(result, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Constant calibration audit — which gating constants were ever measured against the real corpus,
  // which were measured somewhere else, and which physically cannot fire given the range of the
  // signal they are compared to. Read-only; reports, never enforces.
  if (method === 'GET' && url.startsWith('/debug/constant-audit')) {
    try {
      const findings = auditConstants(CONSTANT_REGISTRY, {
        today: new Date().toISOString().slice(0, 10),
        activeContext: ACTIVE_RETRIEVAL_CONTEXT
      })
      const bySeverity = { high: 0, medium: 0, none: 0 } as Record<string, number>
      for (const f of findings) bySeverity[f.severity]++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          { registered: CONSTANT_REGISTRY.length, needsAttention: findings.length - bySeverity.none, bySeverity, findings },
          null,
          2
        )
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Brain Health benchmark (4-axis) — read-only scorer over the live brain graph
  // (coherence · grounding · freshness · purity). Deterministic core; model-backed
  // signals are opt-in (default off) so the route stays cheap. Mirrors /debug/gaps.
  //
  // TTL-cached: the live computation measured 2.16s ON THE MAIN THREAD (QA 2026-08-24, F6) —
  // every poll of this route was a two-second input freeze. Serve the cached report for 5
  // minutes; `?fresh=1` forces a recompute for anyone who genuinely needs this second's truth.
  if (method === 'GET' && url.startsWith('/debug/brain-health')) {
    try {
      const fresh = new URLSearchParams(url.split('?')[1] ?? '').get('fresh') === '1'
      const now = Date.now()
      if (fresh || !brainHealthCache || now - brainHealthCache.at > BRAIN_HEALTH_TTL_MS) {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        brainHealthCache = { at: now, body: JSON.stringify(computeBrainHealthLive(notesDir), null, 2) }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(brainHealthCache.body)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // LIVE-NODE-REVEAL debug trigger — run the scoped reveal over a supplied text with the REAL model,
  // collect the emitted graph frames (no SSE), and return them so the whole pipeline (scoped extraction
  // -> injection gate -> dedup/merge -> governance accept annotation) can be exercised end-to-end against
  // the live vault. The renderer / capture-birth wiring is separate; this is the backend test surface.
  if (method === 'POST' && url.startsWith('/debug/reveal')) {
    void (async () => {
      try {
        const b = JSON.parse((await readBody(req)) || '{}') as { text?: unknown; title?: unknown; id?: unknown }
        const text = typeof b.text === 'string' ? b.text : ''
        if (!text.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'text required' }))
          return
        }
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no vault configured (localBrainNotesDir)' }))
          return
        }
        const id = typeof b.id === 'string' && b.id ? b.id : 'debug:reveal'
        const title = typeof b.title === 'string' ? b.title : 'Debug drop'
        const frames: GraphFrame[] = []
        const result = await revealForSource(notesDir, { id, text }, { emit: (f) => frames.push(f), rootLabel: title })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: result.status, emitted: result.emitted, frames }, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // LIVE-NODE-REVEAL operator judgment — endorse/veto a proposed edge. Persists the edge-verdict
  // (suppresses a vetoed edge on the next read) + a per-(source,edge-type) calibration sample, and
  // returns the /learn/correction payload for the renderer to forward to the learning loop.
  if (method === 'POST' && url.startsWith('/reveal/judge')) {
    void (async () => {
      try {
        const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const from = typeof b.from === 'string' ? b.from : ''
        const to = typeof b.to === 'string' ? b.to : ''
        const edgeType = typeof b.edgeType === 'string' ? b.edgeType : ''
        const verdict = b.verdict === 'veto' ? 'veto' : b.verdict === 'endorse' ? 'endorse' : ''
        if (!notesDir || !from || !to || !edgeType || !verdict) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'from, to, edgeType, verdict(endorse|veto) required' }))
          return
        }
        const source: EdgeSource = ['wiki', 'alias', 'sim', 'llm'].includes(b.source as string) ? (b.source as EdgeSource) : 'llm'
        const eff = applyEdgeJudgment(notesDir, {
          from,
          to,
          edgeType,
          source,
          confidence: typeof b.confidence === 'number' ? b.confidence : 0.6,
          verdict,
          why: typeof b.why === 'string' ? b.why : undefined,
          candidateRule: typeof b.candidateRule === 'string' ? b.candidateRule : undefined,
          ts: new Date().toISOString()
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, learn: eff.learn }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // LIVE-NODE-REVEAL operator merge decision — confirm/reject that a proposed entity IS an existing one.
  if (method === 'POST' && url.startsWith('/reveal/merge')) {
    void (async () => {
      try {
        const b = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const label = typeof b.label === 'string' ? b.label : ''
        const canonicalId = typeof b.canonicalId === 'string' ? b.canonicalId : ''
        const verdict = b.verdict === 'confirm' ? 'confirm' : b.verdict === 'reject' ? 'reject' : ''
        if (!notesDir || !label || !canonicalId || !verdict) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'label, canonicalId, verdict(confirm|reject) required' }))
          return
        }
        applyMergeJudgment(notesDir, { label, canonicalId, verdict, ts: new Date().toISOString() })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Compounding Health benchmark (4-axis) — the VALUE-CORE analog of /debug/brain-health: a
  // read-only "learning-liveness monitor" over the compounding loop (stability · metabolism ·
  // compounding · grounding). Deterministic PURE core; the route reflects the RUNNING app's own
  // grounding env flags (process-level). Mirrors /debug/brain-health.
  if (method === 'GET' && url.startsWith('/debug/compounding-health')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(computeCompoundingHealthLive(notesDir), null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // The SEAM — backfill: materialize a portable OKF concept for every currently-promoted fact.
  // Routes through the SAME runner the auto-reconcile uses (seam-reconcile.ts) so there is ONE
  // projection code path and the /debug/seam-status surface reflects manual runs too. The
  // deliberate flag-override stays: this manual route works even with DUIN_SEAM_MATERIALIZE
  // unset (ignoreFlag), unlike the automatic paths.
  if (method === 'POST' && url.startsWith('/debug/materialize-backfill')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const memoryDir = conceptMemoryDir(notesDir)
      if (!memoryDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no vault (localBrainNotesDir) configured' }))
        return
      }
      const deps = makeProductionSeamDeps(
        () => notesDir,
        (dir) => {
          try { scheduleReindex(dir) } catch { /* semantic index optional (seam 3b) */ }
        }
      )
      const promotedCount = deps.getPromoted().length
      const r = runSeamReconcileNow('backfill-route', deps, { ignoreFlag: true })
      if (!r.ok) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: r.error ?? r.skipped ?? 'reconcile failed' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, memoryDir, promotedCount, ...r.result }, null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // The SEAM — observability for the auto-fire: when it last ran, what it did, whether one is
  // pending. This is how "does not break" stays checkable from outside the process.
  if (method === 'GET' && url.startsWith('/debug/seam-status')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify(
        {
          ...seamReconcileStatus(),
          seamEnabled: seamEnabled(),
          entityEdgesEnabled: seamEntityEdgesEnabled()
        },
        null,
        2
      )
    )
    return
  }

  // The SEAM — export a portable .brain bundle (offboarding / device migration / IP custody).
  if (method === 'POST' && url.startsWith('/debug/export-brain-bundle')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const r = exportBrainBundle(notesDir)
      res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(r, null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Coherence Health META-benchmark (4-axis) — the APEX of the benchmark pattern: it scores the WHOLE
  // system's wiring (design→code→runtime) over the checked-in Coherence Map, NESTS the three subsystem
  // benchmarks' overalls into its LIVENESS axis (read from their history ledgers), and folds a cheap
  // deterministic coherence-lint pass. Read-only + deterministic PURE core. Mirrors /debug/brain-health.
  if (method === 'GET' && url.startsWith('/debug/coherence-health')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(computeCoherenceHealthLive(notesDir), null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Backend Health monitor (backend-hardening B2) — returns the LATEST persisted backend-health
  // check (DB integrity · backup freshness · failure_ledger spike · stuck/leaked runs · orphans).
  // Reads the `.duin/_state/backend-health-history.jsonl` ledger from disk so it works regardless
  // of which process asks; null when the hourly monitor hasn't run yet. Mirrors /debug/brain-health.
  if (method === 'GET' && url.startsWith('/debug/backend-health')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(readLastBackendHealth(notesDir), null, 2))
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  // Duplicate-entity SURFACER (identity-spine P7a) — embedding-clusters the RAW construction's entity
  // labels and PROPOSES near-duplicate groups NOT already in the ENTITY_ALIAS whitelist, so silent
  // drift (a rebuild inventing a new entity in variant spellings) gets caught for human review.
  // Confirmed groups land in <vault>/.duin/_state/entity-aliases.json (NOT in source — ENTITY_ALIAS
  // ships empty since cold-start A1). This route only proposes, but note that runEntityAutoMergeTick
  // separately appends the containment-spine subset of these same candidates unattended.
  // Human-pull, off the hot path (like /debug/brain-health). Async: awaits the on-device embedder.
  if (method === 'GET' && url.startsWith('/debug/alias-candidates')) {
    void (async () => {
      try {
        const report = await computeAliasCandidatesReport(getConstruction(), embedForRecall)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(report, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Whole-brain A/B litmus (transfer pilot #4b) — does operator-2's accumulated brain make
  // outputs fit operator-2 better than the same model COLD? MEASUREMENT-ONLY (writes no moat
  // state). Body may supply { queries?: string[] }; defaults to DEFAULT_TRANSFER_QUERIES.
  // Returns per-query verdicts + the aggregate fitLift (honest-null below the sample floor).
  if (method === 'POST' && url.startsWith('/debug/transfer-ab')) {
    void (async () => {
      try {
        const body = await readBody(req)
        const parsed = (body ? JSON.parse(body) : {}) as { queries?: string[] }
        const queries =
          Array.isArray(parsed.queries) && parsed.queries.length ? parsed.queries : DEFAULT_TRANSFER_QUERIES
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const result = await runTransferAB(queries, makeTransferDeps(notesDir))
        // Record it: the bench's named-skill-lift slot reads the freshest run back, so a manual
        // probe now feeds the same signal the daily tick does instead of evaporating in the reply.
        if (notesDir) recordTransferRun(notesDir, result, new Date().toISOString())
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // Contrastive delta abstraction (MetaEvo CDA) — exercise the contrast-extraction backend end-to-end:
  // pair GOOD endorsed answers (success-miner) against BAD corrections (.duin/_state/corrections.jsonl)
  // by topic overlap, run the key-gated LLM contrast → durable candidate rules (recordFacts, human-gated).
  // This is the production entry that keeps brain/contrast-extraction.ts in the bundle (else tree-shaken)
  // and lets one HTTP call validate the whole path headless — same pattern as /debug/reveal.
  if (method === 'POST' && url.startsWith('/debug/contrast')) {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        const successes = getSuccesses().map((s) => ({ query: s.query, answer: s.answer }))
        // Read corrections.jsonl for the rich BAD triad (ai_output / correction / why); best-effort.
        const corrections: CorrectionTraceLike[] = []
        if (notesDir) {
          try {
            for (const line of readFileSync(join(notesDir, '.duin', '_state', 'corrections.jsonl'), 'utf-8').split('\n')) {
              const t = line.trim()
              if (!t) continue
              try {
                const o = JSON.parse(t) as { ai_output?: string; correction?: string; why?: string }
                if (o.correction || o.ai_output) {
                  corrections.push({ aiOutput: o.ai_output ?? '', correction: o.correction ?? '', why: o.why ?? '' })
                }
              } catch { /* skip a malformed line */ }
            }
          } catch { /* no corrections yet */ }
        }
        const pairs = contrastPair(successes, corrections)
        const model = routeModel('extraction')
        const chat: ContrastChat = async (prompt, m) => ({ text: (await chatOnce([{ role: 'user', content: prompt }], m)).content, finishReason: null })
        const result = await contrastiveAbstraction(pairs, { chat, model })
        // Rules land as candidate facts (recordFacts' verifyCandidate + dedup gate), then learning
        // automation auto-endorses them onto probation (no human gate); they still earn 'promoted'
        // only via the govern loop.
        const recorded = result.rules.length ? recordFacts(result.rules.map((r) => ({ fact: r, kind: 'correction' as const, source: 'machine' as const }))) : 0
        if (recorded) autoPromoteCandidates()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ successes: successes.length, corrections: corrections.length, pairs: pairs.length, rules: result.rules, recorded, status: result.status }, null, 2))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // GROUNDING-EVAL-LIVE (Foundation 1-b) — the OPERATOR-ATTENDED, REAL-LABEL upgrade to option-(a).
  // Foundation 1 assumed a promoted fact is valid (by-construction gold); this asks a local-first LLM
  // JUDGE the load-bearing question — for each fact the REAL matchStale signal flags, is it GENUINELY
  // obsolete or a still-VALID operator preference that merely mentions a resolved topic? Precision/recall/
  // fpRate are then measured on REAL labels. Every judge label is persisted to the operator-adjudication
  // queue (grounding-eval-labels.jsonl, operatorLabel overrides later), and the flag-precision is recorded
  // as the `grounding-staleness` calibration domain (Wilson lower bound). Blocks on the judge (fine for a
  // debug route). KEYLESS-SAFE: no model ⇒ the judge abstains ⇒ labeled:0, empty result, HTTP 200.
  if (method === 'POST' && url.startsWith('/debug/grounding-eval-live')) {
    void (async () => {
      try {
        const notesDir = (readSettings().localBrainNotesDir as string) || null
        if (!notesDir) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'no vault (localBrainNotesDir) configured' }))
          return
        }
        const now = Date.now()
        const topics = gatherTopics(notesDir, now) // real resolved decisions + passed streams
        // The ACTIVE grounding set (promoted + provisional) — the facts the fusion could down-weight.
        const facts: JudgedFact[] = [...listByStatus('promoted'), ...listByStatus('provisional')].map((f) => ({
          id: f.id,
          text: f.fact
        }))
        const judge = createJudgeDeps(() => selectMeasureModelLocalFirst()) // local-first, keyless-safe
        const score = await scoreStalenessJudged(facts, (text) => matchStale(text, topics), judge, now)
        // Persist: the adjudication queue + the calibration domain (both no-ops when nothing was labeled).
        // Record calibration from the ADJUDICATED labels so a prior operator confirm/veto (loaded from the
        // queue, operator OVERRIDES judge) flows into the measured precision — the operator-attended loop.
        const queued = appendJudgeLabels(notesDir, score.labels)
        const adjudicated = loadAdjudicatedLabels(notesDir)
        const recorded = recordGroundingStalenessOutcomes(notesDir, outcomesFromScore(score, adjudicated))
        const trust = stalenessTrust(notesDir) // Wilson-lo retrieval precision across all accrued samples
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            {
              eval: 'staleness-precision-judged',
              corpus: { resolvedTopics: topics.length, activeFacts: facts.length },
              labeled: score.labeled,
              flagged: score.flagged,
              headline: { precision: score.precision, recall: score.recall, fpRate: score.fpRate },
              flaggedValid: score.flaggedValid,
              score,
              persisted: { queued, calibrationSamples: recorded },
              calibration: { domain: 'grounding-staleness', trust },
              verdict:
                score.labeled === 0
                  ? 'insufficient-data (no judge engine / no flagged facts) — no precision claimed'
                  : score.fpRate != null && score.fpRate <= 0.05
                    ? 'LOW buried-preference rate — the staleness signal is precise on real labels'
                    : 'HIGH buried-preference rate — the signal buries valid preferences; adjudicate before default-on'
            },
            null,
            2
          )
        )
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })()
    return
  }

  // GROUNDING-EVAL (Foundation 1) — the honest, headless retrieval-quality signal DUIN lacks. Runs the
  // REAL staleness signal (matchStale) over the dogfood vault's REAL data: PROMOTED operator facts (label=valid,
  // since the operator endorsed them) + templated-stale positives from REAL resolved decisions, against
  // the REAL resolved topics. Headline = fpRate: the fraction of endorsed preferences the fusion would
  // wrongly bury. Low ⇒ the store.implicit-conflict-live default-on flip is honestly justified; high ⇒ it
  // is not (no flag-flip should claim the +15). Measurement-only; writes nothing.
  if (method === 'GET' && url.startsWith('/debug/grounding-eval')) {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      if (!notesDir) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'no vault (localBrainNotesDir) configured' }))
        return
      }
      const now = Date.now()
      const topics = gatherTopics(notesDir, now) // real resolved decisions + passed streams
      // Valid corpus = the ACTIVE grounding set (promoted + provisional) — the facts the fusion could
      // actually down-weight. Both are operator-endorsed-enough to enter grounding, so a flag on either
      // is a false positive. (Widened from promoted-only to strengthen the fpRate sample.)
      const validFacts: EvalFact[] = [...listByStatus('promoted'), ...listByStatus('provisional')].map((f) => ({
        id: f.id,
        text: f.fact,
        label: 'valid'
      }))
      const staleFacts = templatedStaleFacts(topics.map((t) => ({ id: t.id, title: t.label })))
      const score = scoreStaleness([...validFacts, ...staleFacts], (text) => matchStale(text, topics))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify(
          {
            eval: 'staleness-precision',
            corpus: { resolvedTopics: topics.length, promotedFacts: validFacts.length, templatedStale: staleFacts.length },
            headline: { fpRate: score.fpRate, recall: score.recall, precision: score.precision },
            score,
            verdict:
              score.fpRate === null
                ? 'insufficient-data (no promoted facts / resolved topics)'
                : score.fpRate <= 0.05
                  ? 'LOW false-positive rate — default-on fusion is honestly justifiable'
                  : 'HIGH false-positive rate — default-on would bury valid preferences; do NOT flip (build the conservatism guard first)'
          },
          null,
          2
        )
      )
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
}
