// The high-stakes cascade creators — a new PROJECT proposes the TRACKS it carries; a made
// DECISION detects the STREAMS it affects. Both propose → adversarial-judge → STAGE for review
// (cascade-pending.jsonl) rather than auto-landing (the operator's final soft gate). Port of
// cascade_project (server.py:1724) + cascade_decision (server.py:1746). Background + never throws;
// the route handlers (create_project / make_decision) fire these fire-and-forget after their
// deterministic write. Model call injected; composes the cascade foundation (proposeThenJudge +
// stageCascade).

import { readFileSync } from 'fs'
import { join } from 'path'
import { loadTrackRegistry } from './tracks-native'
import { LANG_RULE } from './stream-sync-write-native'
import { proposeThenJudge, stageCascade, type GenerateFn, type StageDeps } from './cascade-native'
import { messageOf } from '../guarded'

const futuresPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'future-nodes.jsonl')

function loadFutureNodes(vaultDir: string): Record<string, unknown>[] {
  let txt: string
  try {
    txt = readFileSync(futuresPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const rows: Record<string, unknown>[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch (e) { console.debug('[cascade-creators-native] skip malformed:', messageOf(e)) }
  }
  return rows
}

/** cascade_project generator prompt — verbatim from server.py:1731-1736. Exported for diffing. */
export function buildCascadeProjectPrompt(name: string, existingTracks: string[]): string {
  return (
    'You are the PROJECTION ENGINE. A new PROJECT was just created. Propose 2-4 durable TRACKS (lanes ' +
    'of work) it carries — each a long-running thread the project advances along. Ground them in the ' +
    'project\'s likely scope; do NOT duplicate existing tracks. If you can\'t ground a track, omit it.\n' +
    `${LANG_RULE}\nPROJECT: ${JSON.stringify(name)}` +
    '\nEXISTING TRACKS (do NOT duplicate):\n' + JSON.stringify(existingTracks) +
    '\nOutput ONLY a JSON array: [{"label","goal","keywords":["..."]}].'
  )
}

/** cascade_decision generator prompt — verbatim from server.py:1756-1762. `streams` is the
 *  compact {id,title,track} projection, `decisionJson` the {title,call,rationale} JSON. */
export function buildCascadeDecisionPrompt(decisionJson: string, streams: unknown[]): string {
  return (
    'A DECISION was just made. From the STREAMS below, identify ONLY those the decision genuinely ' +
    'AFFECTS, and the concrete change to each (resolves a fork / raises or lowers risk / unblocks / ' +
    'supersedes / changes the deadline). Be strict — most streams are unaffected.\n' +
    `${LANG_RULE}\nDECISION: ${decisionJson}` +
    '\nSTREAMS:\n' + JSON.stringify(streams) +
    '\nOutput ONLY a JSON array: [{"stream_id","title","change":"<=80 chars"}].'
  )
}

export interface CascadeCreatorDeps extends StageDeps {
  generate: GenerateFn
}

/** New PROJECT → propose the tracks it carries → judge → STAGE for review. Returns count staged.
 *  Port of cascade_project (server.py:1724). Never throws (background). */
export async function runCascadeProject(vaultDir: string, name: string, deps: CascadeCreatorDeps): Promise<number> {
  try {
    if (!vaultDir) return 0
    const existing = loadTrackRegistry(vaultDir).map((t) => t.label ?? '')
    const gen = buildCascadeProjectPrompt(name, existing)
    const surv = await proposeThenJudge(gen, `TRACKS for the project «${name}»`, { generate: deps.generate })
    return surv.length ? stageCascade(vaultDir, 'project-track', name, surv, deps) : 0
  } catch {
    return 0
  }
}

/** A DECISION was made → detect the streams it affects → judge → STAGE for review. Returns count
 *  staged. Port of cascade_decision (server.py:1746). Never throws (background). */
export async function runCascadeDecision(
  vaultDir: string,
  decision: Record<string, unknown>,
  deps: CascadeCreatorDeps
): Promise<number> {
  try {
    if (!vaultDir) return 0
    const streams = loadFutureNodes(vaultDir)
      .filter((s) => s.status === 'open' || s.status === 'engaged' || s.status === 'synced')
      .slice(0, 40)
      .map((s) => ({ id: s.id, title: String(s.title ?? '').slice(0, 60), track: s.track ?? '' }))
    if (!streams.length) return 0
    const decisionJson = JSON.stringify({ title: decision.title, call: decision.call, rationale: decision.rationale })
    const gen = buildCascadeDecisionPrompt(decisionJson, streams)
    const surv = await proposeThenJudge(gen, 'affected streams from a decision', { generate: deps.generate })
    return surv.length ? stageCascade(vaultDir, 'decision-affected', String(decision.title ?? ''), surv, deps) : 0
  } catch {
    return 0
  }
}
