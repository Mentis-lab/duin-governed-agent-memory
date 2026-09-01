// Cascade engine (native) — the generative graph-elaboration on create/change: a GENERATOR
// proposes dependent/affected nodes, an adversarial JUDGE (default-kill) keeps only the real/
// distinct/grounded ones, and survivors either auto-land (low-stakes: track→moves) or STAGE for
// review (high-stakes: project→tracks, decision→affected). Port of the CASCADE section of
// server.py (_propose_then_judge @1546, the cascade-pending store @1615-1654).
//
// This module is the FOUNDATION the cascade routes rest on:
//  - the deterministic cascade-pending STORE (pure fs/json — unit-testable, no model), and
//  - proposeThenJudge (the two-pass model layer; the model call is injected as `generate`).
// The creators (cascade_project/decision/track), _apply_cascade, and resolve_cascade build ON
// this — ported in follow-ups (they also need add_track / capture_work, per the plan's
// dependency sequencing).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { extractFirstJsonArray } from './extraction-util'
import { messageOf } from '../guarded'

const cascadePendingPath = (vaultDir: string): string =>
  join(vaultDir, '.duin', '_state', 'cascade-pending.jsonl')

export interface CascadePendingItem {
  id: string
  kind: string
  source: string
  proposal: Record<string, unknown>
  status: string
  created: string
}

export function loadCascadePending(vaultDir: string): CascadePendingItem[] {
  let txt: string
  try {
    txt = readFileSync(cascadePendingPath(vaultDir), 'utf-8')
  } catch {
    return []
  }
  const out: CascadePendingItem[] = []
  for (const ln of txt.split(/\r?\n/)) {
    const s = ln.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as CascadePendingItem)
    } catch (e) { console.debug('[cascade-native] skip malformed:', messageOf(e)) }
  }
  return out
}

export function saveCascadePending(vaultDir: string, items: CascadePendingItem[]): void {
  const path = cascadePendingPath(vaultDir)
  mkdirSync(dirname(path), { recursive: true })
  const body = items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, 'utf-8')
  renameSync(tmp, path)
}

// Local-time ISO seconds — matches Python datetime.now().isoformat(timespec='seconds').
export function localIsoSeconds(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export interface StageDeps {
  now?: () => Date
  uid?: () => string
}

/** Stage proposals into the review tray as status:'pending'. Returns the count staged. Port of
 *  _stage_cascade (server.py:1640). */
export function stageCascade(
  vaultDir: string,
  kind: string,
  source: string,
  proposals: Record<string, unknown>[],
  deps: StageDeps = {}
): number {
  const now = localIsoSeconds((deps.now ?? (() => new Date()))())
  const mkId = deps.uid ?? (() => randomUUID().replace(/-/g, '').slice(0, 8))
  const items = loadCascadePending(vaultDir)
  for (const p of proposals) {
    items.push({ id: mkId(), kind, source, proposal: p, status: 'pending', created: now })
  }
  saveCascadePending(vaultDir, items)
  return proposals.length
}

/** The review tray: staged-but-unresolved cascades awaiting approve/dismiss. Port of
 *  list_cascade_pending (server.py:1652). */
export function listCascadePending(vaultDir: string): { pending: CascadePendingItem[] } {
  return { pending: loadCascadePending(vaultDir).filter((i) => i.status === 'pending') }
}

export type GenerateFn = (prompt: string) => Promise<string>

const candName = (c: Record<string, unknown>): string =>
  String(c.title ?? c.label ?? c.change ?? '').trim()

/** Build the adversarial-judge prompt for a candidate set. Verbatim from server.py:1557-1562.
 *  The embedded candidate list is JSON.stringify'd (compact; Python json.dumps's `, `/`: `
 *  spacing differs only in prompt whitespace). Exported for string-diffing. */
export function buildJudgePrompt(what: string, cands: Record<string, unknown>[]): string {
  const rows = cands.map((c, i) => ({
    idx: i,
    title: candName(c),
    objective: String(c.objective ?? c.goal ?? '').slice(0, 120)
  }))
  return (
    `You are the ADVERSARIAL JUDGE of a second brain. Below are proposed ${what}. Default to KILL. Keep one ` +
    'ONLY if it is REAL and grounded in the operator\'s actual work (not generic or speculative), DISTINCT ' +
    '(not a duplicate of an existing node), and genuinely belongs. Output ONLY a JSON array aligned BY INDEX: ' +
    '[{"idx":<int>,"keep":<bool>,"reason":"<=80 chars"}].\n\nCANDIDATES:\n' +
    JSON.stringify(rows)
  )
}

/**
 * Two role-separated model passes: a GENERATOR proposes candidates, an adversarial JUDGE
 * (default-kill) keeps only the real/distinct/grounded ones. Returns surviving candidate dicts.
 * Port of _propose_then_judge (server.py:1546). Named candidates only, capped at 6; if the judge
 * is unavailable (empty), keep all (they land soft/provisional anyway). The model call is
 * injected as `generate` — no /agui grounding, no chat-turn learn ticks.
 */
export async function proposeThenJudge(
  genPrompt: string,
  what: string,
  deps: { generate: GenerateFn }
): Promise<Record<string, unknown>[]> {
  const raw0 = extractFirstJsonArray(await deps.generate(genPrompt)) ?? []
  const cands = raw0
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c) && !!candName(c as Record<string, unknown>))
    .slice(0, 6)
  if (!cands.length) return []

  const verdicts = extractFirstJsonArray(await deps.generate(buildJudgePrompt(what, cands))) ?? []
  if (!verdicts.length) return cands // judge unavailable → keep (provisional anyway)
  const keep = new Set<number>()
  for (const v of verdicts) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const vo = v as Record<string, unknown>
      if (vo.keep && typeof vo.idx === 'number') keep.add(vo.idx)
    }
  }
  return cands.filter((_, i) => keep.has(i))
}
