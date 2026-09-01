// channel-foresight-bridge — the CHANNEL→FORESIGHT bridge (the two-brain merge for
// the on-ramp). Channel data is ingested into the local-brain index and LLM-extracted
// into {commitments, decisions, risks} (notes-extract), but that only reaches the
// keyless answer — NOT the `.duin/_state` foresight (causalGraph/forecasts/world-state)
// that is the moat. This maps extracted decisions/commitments into foresight STREAMS
// and writes them to a SEPARATE channel-futures.jsonl (TS is the sole writer — no
// two-writer race on the operator's authored future-nodes.jsonl). `loadFutures` reads both, so a
// connected channel now produces real forecasts — the on-ramp payoff.
import { writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { ExtractedData } from './types'
import type { FutureStream, AnchorDecl } from './causal-substrate'
import { CJK_CLASS } from './cjk-tokens'

/** A resolver from an extracted note id → its display fields (title/track/date),
 *  supplied by the caller (from the index). Keeps the mapper pure + testable. */
export type DocResolver = (noteId: string) => { title: string; track?: string } | null

/** Map LLM-extracted temporal structure → foresight streams. A DECISION (decide_by +
 *  cleared/blocked fork) is foresight-gold → a stream the causal graph turns into a
 *  decision + decision-window + convergence. A COMMITMENT (dated) → a stream with a
 *  target. Channel-sourced ids are namespaced `src:` so they never collide with
 *  authored streams + are trivially prunable. Pure. */
export function extractedToStreams(ex: ExtractedData, resolveDoc: DocResolver): FutureStream[] {
  const out: FutureStream[] = []
  const seen = new Set<string>()
  for (const d of ex.decisions) {
    const doc = resolveDoc(d.note)
    if (!doc) continue
    const id = `src:${d.note}`
    seen.add(id)
    out.push({
      id,
      title: doc.title,
      objective: doc.title,
      track: doc.track ?? '',
      status: 'open',
      decide_by: d.decide_by,
      decision: doc.title,
      cleared: d.cleared || undefined,
      blocked: d.blocked || undefined,
      target: d.decide_by,
      anchor_id: ''
    })
  }
  for (const c of ex.commitments) {
    const id = `src:${c.note}`
    if (seen.has(id)) continue // a decision for this note already made the richer stream
    const doc = resolveDoc(c.note)
    if (!doc) continue
    out.push({ id: `src:commit:${c.note}`, title: doc.title, objective: doc.title, track: doc.track ?? '', status: 'open', target: c.date })
  }
  return out
}

// ──────────────────── channel EVENTS → anchors (KEYLESS — structural, no LLM) ────────────────────
// A synthetic channel note (synthNoteText) is `---\ntype:..\ndate:..\ntags:..\n---\n# Title\nbody`.
// A dated event/milestone → a foresight ANCHOR (a milestone on the timeline). This is keyless — it
// gives a newcomer's calendar a foresight timeline with NO model, unlike the decision→stream path.
const STOP_TOK = new Set('the a an and or of to in for on with is are be this that it at by from'.split(' '))

export function parseSynthMeta(text: string): { type?: string; date?: string; title?: string } {
  const lines = (text || '').split(/\r?\n/)
  const meta: { type?: string; date?: string; title?: string } = {}
  let inFm = false
  for (const l of lines) {
    const t = l.trim()
    if (t === '---') {
      inFm = !inFm // enter on the first ---, exit on the closing --- (then the H1 follows)
      continue
    }
    if (inFm) {
      const i = t.indexOf(':')
      if (i > 0) {
        const k = t.slice(0, i).trim()
        const v = t.slice(i + 1).trim()
        if (k === 'type') meta.type = v
        else if (k === 'date') meta.date = v
      }
    } else if (t.startsWith('# ') && !meta.title) meta.title = t.slice(2).trim().slice(0, 120)
  }
  return meta
}
// The token class is the tokenizer's full CJK set (kanji + KANA), not the bare ideograph
// range — a kana title yielded no binds_keywords, so its anchor could never be fed.
const TITLE_TOK_RE = new RegExp(`[a-z0-9${CJK_CLASS}]+`, 'g')
const titleTokens = (title: string): string[] =>
  [...new Set((title || '').toLowerCase().match(TITLE_TOK_RE) ?? [])].filter((t) => t.length > 1 && !STOP_TOK.has(t)).slice(0, 6)

/** Dated channel events/milestones → anchor decls. `binds_keywords` = title tokens, so
 *  channel streams whose labels overlap auto-feed the anchor (the fuzzy feeds pass) →
 *  convergence emerges from channels. Track resolver supplied by the caller (pure). */
export function channelEventsToAnchors(
  docs: { file: string; text: string }[],
  resolveTrack: (text: string) => string = () => ''
): AnchorDecl[] {
  const out: AnchorDecl[] = []
  for (const d of docs) {
    const m = parseSynthMeta(d.text)
    if ((m.type === 'event' || m.type === 'milestone') && m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
      const name = m.title || d.file
      out.push({
        id: `src:${d.file}`,
        name,
        kind: m.type,
        date: m.date,
        window_end: '',
        immovable: false,
        track: resolveTrack(d.text),
        attendees: [],
        binds_contexts: [],
        binds_tags: [],
        binds_keywords: titleTokens(name),
        binds_ids: [],
        depends_on: [],
        exclude_contexts: [],
        aliases: [],
        builds_toward: '',
        confidential: false,
        doc: d.file
      })
    }
  }
  return out
}

const channelFuturesPath = (vaultDir: string): string => join(vaultDir, '.duin', '_state', 'channel-futures.jsonl')

function atomicWriteJsonl(path: string, items: unknown[]): number {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, items.map((s) => JSON.stringify(s)).join('\n') + (items.length ? '\n' : ''), 'utf-8')
  renameSync(tmp, path)
  return items.length
}

/** Channel-derived anchors store (TS sole writer). readAnchorDecls merges it. */
export function writeChannelAnchors(vaultDir: string | null, decls: AnchorDecl[]): number {
  if (!vaultDir) return 0
  return atomicWriteJsonl(join(vaultDir, '.duin', '_state', 'channel-anchors.jsonl'), decls)
}

/** Overwrite the channel-derived futures store (TS sole writer → safe full rewrite,
 *  atomic temp+rename). Each sync recomputes it from the current channel corpus. */
export function writeChannelFutures(vaultDir: string | null, streams: FutureStream[]): number {
  if (!vaultDir) return 0
  const path = channelFuturesPath(vaultDir)
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, streams.map((s) => JSON.stringify(s)).join('\n') + (streams.length ? '\n' : ''), 'utf-8')
  renameSync(tmp, path)
  return streams.length
}
