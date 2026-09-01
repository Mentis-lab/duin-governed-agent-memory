// State-mutation route handlers — relocated verbatim from server.ts (pure move).
// Each POST /state/* (and /learn/correction) handler owns its native write path.
// readSettings/readBody are shared server infra, imported back from ./server.
import { type IncomingMessage, type ServerResponse } from 'http'
import { readSettings, readBody } from './server'
import type { DecisionOutcome } from '../brain/types'
import { recordDecision, recordInsightVerdict } from '../brain'
import { createProject, recordPredictionFeedback, dismissAnchorCandidate } from '../brain/tier2-writes-native'
import { cascadeProject, cascadeTrack, cascadeDecision } from '../brain/cascade-engine-native'
import { setTrackProject, addTrack } from '../brain/track-write-native'
import { updateStream, bindTask, unbindTask, actFuture, extractStream } from '../brain/stream-write-native'
import { extractWorldUpdate } from '../brain/world-update-native'
import { meetingAction } from '../brain/meeting-write-native'
import { setDecisionMeta, resolveNode, makeDecision } from '../brain/decision-write-native'
import { taskAction, moveTask } from '../brain/task-write-native'
import { setForecastVerdict, logForecast } from '../brain/forecast-write-native'
import { appendCorrection } from '../brain/learn-store'
import { toks, type Correction } from '../brain/learn-native'
import { loadBindings, writeBindings } from '../brain/binding-store'
import { correctionFailsBindings } from '../brain/binding-ledger'
import { revertByBindingId, recordFacts, autoPromoteCandidates } from '../brain/operator-model'
import { endorsementFact } from './endorsement-fact'
import { messageOf } from '../guarded'

export async function handleDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const parsed = JSON.parse(body || '{}') as { nodeId?: unknown; choice?: unknown; note?: unknown }
    const nodeId = typeof parsed.nodeId === 'string' ? parsed.nodeId : ''
    const OUTCOMES = ['cleared', 'blocked', 'done', 'dismissed', 'cancelled'] as const
    const choice =
      typeof parsed.choice === 'string' && (OUTCOMES as readonly string[]).includes(parsed.choice)
        ? (parsed.choice as DecisionOutcome)
        : null
    if (!nodeId || !choice) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error:
            'nodeId and choice ("cleared"|"blocked"|"done"|"dismissed"|"cancelled") required'
        })
      )
      return
    }
    const note = typeof parsed.note === 'string' && parsed.note ? parsed.note : undefined
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(recordDecision(nodeId, choice, note, (readSettings().localBrainNotesDir as string) || null)))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error)?.message ?? 'decision error' }))
  }
}

// POST /state/insight-verdict {id, verdict} — HTTP parity for the
// brain:insightVerdict IPC. Records the verdict on the SAME in-process brain
// getInsights() reads (so ids match), fixing the read-brain ≠ write-brain split.
export async function handleInsightVerdict(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const parsed = JSON.parse(body || '{}') as { id?: unknown; verdict?: unknown }
    const id = typeof parsed.id === 'string' ? parsed.id : ''
    const VERDICTS = ['useful', 'dismissed', 'acted', 'inaccurate'] as const
    const verdict =
      typeof parsed.verdict === 'string' && (VERDICTS as readonly string[]).includes(parsed.verdict)
        ? (parsed.verdict as 'useful' | 'dismissed' | 'acted' | 'inaccurate')
        : null
    if (!id || !verdict) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: 'id and verdict ("useful"|"dismissed"|"acted"|"inaccurate") required'
        })
      )
      return
    }
    recordInsightVerdict(id, verdict)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error)?.message ?? 'insight-verdict error' }))
  }
}

// POST /state/track-assign — assign a track to a project, native (was proxied to Python
// set_track_project). Always 200 (ok field carries success). Owns tracks.json.
// POST /state/project-create — create a project folder + hub note + fire the generative cascade
// (propose tracks → judge → stage), native (was proxied to Python create_project). Always 200.
export async function handleProjectCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = createProject(notesDir, String(p.name ?? ''))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    if (out.ok && out.name) void cascadeProject(notesDir, out.name).catch(() => {}) // fire-and-forget, mirrors Python
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'project-create error' }))
  }
}

// POST /state/track-add — create a track + fire the generative cascade (propose moves → judge →
// auto-land), native (was proxied to Python add_track). Always 200 (ok field carries success).
export async function handleTrackAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = addTrack(notesDir, p)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out.ok ? { ok: true, id: out.id } : out))
    if (out.ok && out.track) void cascadeTrack(notesDir, out.track).catch(() => {}) // fire-and-forget, mirrors Python
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'track-add error' }))
  }
}

export async function handleTrackAssign(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = setTrackProject(notesDir, String(p.id ?? ''), String(p.project ?? ''))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'track-assign error' }))
  }
}

// POST /state/stream-update — edit a stream's fields, native (was proxied to Python
// update_stream). Always 200. Owns future-nodes.jsonl (dedicated single-file loader).
export async function handleStreamUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const patch = p.patch && typeof p.patch === 'object' && !Array.isArray(p.patch) ? (p.patch as Record<string, unknown>) : {}
    const out = updateStream(notesDir, String(p.id ?? ''), patch)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'stream-update error' }))
  }
}

// POST /state/stream-sync — structure a free-text strategic stream into ONE stream node
// (model-backed, generateOnce), appended to future-nodes.jsonl. Native (was proxied to Python
// extract_stream). Always 200 (ok field carries success).
export async function handleStreamSync(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  try {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    const out = await extractStream(notesDir, String(p.text ?? ''))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'stream-sync error' }))
  }
}

// POST /state/world-update — extract a structured world-state delta from free text (model-backed,
// generateOnce), logged as a proposed draft. Native (was proxied to Python extract_world_update).
// Contract: empty text → 400; else {ok:true, delta}. The human-gated apply (world-update-act) is
// ALSO native: brain-native-routes.ts routes it to world-update-act-write-native.ts's
// actWorldUpdate, which carries the reproject + promote_belief port. No Python remains.
export async function handleWorldUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const txt = String(p.text ?? '').trim()
  if (!txt) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'empty' }))
    return
  }
  try {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    const delta = await extractWorldUpdate(notesDir, txt)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, delta }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'world-update error' }))
  }
}

// POST /state/future-act — disposition a stream (engage/pass/keep/delete/reset), native (was
// proxied to Python act_future). Always 200. Owns future-nodes.jsonl.
export async function handleFutureAct(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = actFuture(notesDir, String(p.id ?? ''), String(p.action ?? 'pass'))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'future-act error' }))
  }
}

// POST /state/prediction-feedback — human verdict on a prediction, native (was proxied to Python
// record_prediction_feedback). 200/400. Owns prediction-feedback.jsonl.
export async function handlePredictionFeedback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = recordPredictionFeedback(notesDir, String(p.id ?? ''), String(p.domain ?? ''), String(p.mark ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'prediction-feedback error' }))
  }
}

// POST /state/anchor-dismiss — reject an anchor candidate, native (was proxied to Python
// dismiss_anchor_candidate). 200/400. Owns anchor-dismissed.json.
export async function handleAnchorDismiss(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = dismissAnchorCandidate(notesDir, String(p.referent ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'anchor-dismiss error' }))
  }
}

// POST /state/task-bind — bind/unbind a task to the stream (move) it advances, native (was
// proxied to Python bind_task/unbind_task). Routes on `unbind`. {ok,...} + 200/400.
export async function handleTaskBind(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = p.unbind
      ? unbindTask(notesDir, String(p.task_id ?? ''), String(p.stream_id ?? ''))
      : bindTask(notesDir, String(p.task_id ?? ''), String(p.stream_id ?? ''), String(p.due ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'task-bind error' }))
  }
}

// POST /state/meeting-action — confirm/dismiss a meeting, native (was proxied to Python
// meeting_action). {ok,...} + 200/400. Owns meetings.jsonl.
export async function handleMeetingAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = meetingAction(notesDir, String(p.id ?? ''), String(p.action ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'meeting-action error' }))
  }
}

// POST /state/make-decision — record a decision note + close the originating node, native (was
// proxied to Python make_decision). Deterministic core; 200/400. NB the model-backed
// cascade_decision ("propose what's affected → stage") is deferred (follow-on port).
export async function handleMakeDecision(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = makeDecision(notesDir, {
      nodeId: String(p.nodeId ?? ''),
      title: String(p.title ?? ''),
      call: String(p.call ?? ''),
      rationale: String(p.rationale ?? ''),
      reversibility: String(p.reversibility ?? 'reversible'),
      layer: String(p.layer ?? ''),
      domain: String(p.domain ?? ''),
      consequences: String(p.consequences ?? '')
    })
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
    // Fire-and-forget the cascade (decision → affected streams → judge → stage), mirroring the
    // Python background thread. Best-effort; must not affect the response.
    if (out.ok) {
      void cascadeDecision(notesDir, { title: String(p.title ?? ''), call: String(p.call ?? ''), rationale: String(p.rationale ?? '') }).catch(() => {})
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'make-decision error' }))
  }
}

// POST /state/decision-meta — classify a decision (layer/domain frontmatter), native (was
// proxied to Python set_decision_meta). Mirrors the contract: {ok:bool}, 200/400.
export async function handleDecisionMeta(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const layer = p.layer == null ? undefined : String(p.layer)
    const domain = p.domain == null ? undefined : String(p.domain)
    const ok = setDecisionMeta(notesDir, String(p.id ?? ''), layer, domain)
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'decision-meta error' }))
  }
}

// POST /state/resolve-node — close/advance an owed-decision loop node, native (was proxied to
// Python resolve_node). Mirrors the contract: {ok,...}, 200/400. (schedule_recompute deferred.)
export async function handleResolveNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = resolveNode(notesDir, String(p.id ?? ''), String(p.action ?? ''), String(p.note ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'resolve-node error' }))
  }
}

// POST /state/task-action — board task edit (complete/reopen/priority/due/estimate/delete),
// native (was proxied to Python task_action). Writes the task line in the vault Kanban md.
// Mirrors the Python contract: 200 if ok else 400. (schedule_recompute deferred — see
// task-write-native header.)
export async function handleTaskAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const out = taskAction(notesDir, String(p.id ?? ''), String(p.action ?? ''), String(p.value ?? ''))
    res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'task-action error' }))
  }
}

// POST /state/task-move — drag a task to a new column, native (was proxied to Python
// move_task). Rewrites {{status}} + checkbox. Mirrors the Python contract: {ok:bool}, 200/400.
export async function handleTaskMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  try {
    const ok = moveTask(notesDir, String(p.id ?? ''), String(p.status ?? ''))
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok }))
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'task-move error' }))
  }
}

// POST /state/forecast-verdict — operator adjudicates a forecast, then resolve+rescore in
// the same call (native; was proxied to Python set_forecast_verdict). Completes TS ownership
// of risk-predictions.jsonl. Mirrors the Python contract: 200 if ok else 400.
export async function handleForecastVerdict(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: { id?: unknown; resolution?: unknown }
  try {
    p = JSON.parse(raw || '{}') as { id?: unknown; resolution?: unknown }
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  const out = setForecastVerdict(notesDir, String(p.id ?? ''), String(p.resolution ?? ''))
  res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(out))
}

// POST /state/forecast — author a bare probabilistic forecast (native; was proxied to
// Python log_forecast). Mirrors the Python contract: 201 if ok else 400.
export async function handleLogForecast(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let p: Record<string, unknown>
  try {
    p = JSON.parse(raw || '{}') as Record<string, unknown>
  } catch {
    p = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  const out = logForecast(notesDir, {
    predicted: String(p.predicted ?? ''),
    confidence: p.confidence,
    evalBy: String(p.eval_by ?? ''),
    track: String(p.track ?? ''),
    id: String(p.id ?? '')
  })
  res.writeHead(out.ok ? 201 : 400, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(out))
}

// POST /learn/correction — the learn loop's CAPTURE arrow, now native (was proxied to
// the Python sidecar's learn.append_correction). Mirrors the Python handler contract:
// malformed JSON degrades to {} (not a 400); appendCorrection throws on a machine
// `source` row (operator-only stream) → 400, matching Python's ValueError→400.
// Native TS is now the single writer of corrections.jsonl on this path.
export async function handleLearnCorrection(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req)
  let payload: Correction
  try {
    payload = JSON.parse(raw || '{}') as Correction
  } catch {
    payload = {}
  }
  const notesDir = (readSettings().localBrainNotesDir as string) || null
  // Compute BEFORE writeHead: appendCorrection throws on a machine `source` row. Writing
  // the 200 header first would leave the catch unable to send 400 (headers already sent →
  // second writeHead throws → the response hangs half-open). Bug found in live QA.
  try {
    const result = appendCorrection(notesDir, payload)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    // FINISH WS3.2: a recurring OPERATOR correction fails an open binding's "won't recur"
    // guarantee (the held-out test). Best-effort side-effect AFTER the response — a failure
    // here must never break correction capture. Operator-only: skip machine (`source`) rows.
    try {
      if (!payload.source) {
        const all = loadBindings(notesDir)
        const failed = correctionFailsBindings(all, payload, toks, Date.now())
        if (failed.length) {
          writeBindings(notesDir, all)
          // Phase 1 unification: the binding's held-out "won't recur" prediction failed, so
          // revert the operator fact minted from that binding — the recurring-wrong rule must
          // stop grounding. Ties the binding-ledger's falsification to the grounding store.
          for (const b of failed) revertByBindingId(b.id)
        }
      }
    } catch (e) { console.debug('[brain-state-routes] best-effort  binding bookkeeping must not affect capture:', messageOf(e)) }
    // Positive-governed capture: fold a genuine operator endorsement into the governed lifecycle.
    // Best-effort, after the response — a failure here must never break correction capture.
    try {
      const ef = endorsementFact(payload)
      // Learning is automated: record the endorsement as a candidate, then auto-endorse it onto
      // probation (no human gate). autoPromoteCandidates skips external-sourced rows; an endorsement
      // is operator-sourced, so it advances to provisional.
      if (ef && recordFacts([ef])) autoPromoteCandidates()
    } catch (e) { console.debug('[brain-state-routes] positive-governed capture is best-effort:', messageOf(e)) }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: (err as Error)?.message ?? 'correction error' }))
  }
}
