// Notes extraction — lift a plain notes folder into TEMPORAL structure so the
// foresight engines work on real notes (not just the structural wikilink
// graph). One LLM pass reads the notes and returns dated commitments, decisions
// (with decide-by + a cleared/blocked fork), and risks; `applyExtraction` then
// enriches the structural graph with that temporal data → propagation gains
// dates, the prediction layer gets decision-windows + risks, calibration
// accrues. parse + merge are PURE (unit-tested); the LLM call is KEY-GATED — no
// provider key → returns null → structural-only, exactly as before.

import type { CausalGraph, CausalNode, ExtractedData, ExtractedRisk, RiskLevel } from './types'
import { allChunks } from '../local-brain/index-store'
import { groupChunksByFile, extractFirstJsonObject, buildCorpus } from './extraction-util'
import { contentLanguageDirective } from './content-language'
import { chatStream, routeModel, routeDistinctModel, routeWithinProvider, getProviderForModel } from '../providers/registry'
import { isModelNotFoundError, isProviderFailoverError } from '../providers/quota-error'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const MAX_NOTES = 40
const MAX_NOTE_CHARS = 1500
const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Build the extraction prompt from a note corpus (id + text). */
export function buildExtractionPrompt(notes: { id: string; text: string }[]): string {
  const corpus = buildCorpus(notes, MAX_NOTES, MAX_NOTE_CHARS)
  // Pin the free-text fields (risk labels, cleared/blocked outcomes) to the notes' language, so a
  // CN/JP vault doesn't accrue English artifacts that no longer lexically match its notes. '' for
  // English → prompt unchanged.
  const langPin = contentLanguageDirective(corpus)
  return (
    'You extract TEMPORAL STRUCTURE from a user\'s notes for a planning graph. ' +
    'Read the notes below (each headed by its id) and output ONLY a JSON object — no prose, no code fence — of the form:\n' +
    '{"commitments":[{"note":"<exact note id>","date":"YYYY-MM-DD"}],' +
    '"decisions":[{"note":"<exact note id>","decide_by":"YYYY-MM-DD","cleared":"<short outcome if proceed>","blocked":"<short outcome if not>"}],' +
    '"risks":[{"id":"risk:<slug>","label":"<short>","severity":"red|amber|green","about":"<note id it threatens, optional>"}]}\n' +
    'Rules: dates MUST be YYYY-MM-DD and only when a real date/deadline is stated or clearly implied; ' +
    'note ids MUST match exactly one of the headings; omit anything uncertain; empty arrays are fine.\n\n' +
    '=== NOTES ===\n' +
    corpus +
    (langPin ? '\n\n' + langPin : '')
  )
}

function coerceDate(v: unknown): string | undefined {
  return typeof v === 'string' && ISO.test(v.trim()) ? v.trim() : undefined
}
function coerceSeverity(v: unknown): RiskLevel | undefined {
  return v === 'red' || v === 'amber' || v === 'green' ? v : undefined
}

/**
 * Parse the LLM's extraction output into validated ExtractedData. Tolerant: a
 * fenced block, leading prose, or malformed items don't throw — bad items are
 * dropped, the rest kept. Returns empty arrays on total failure.
 */
export function parseExtraction(text: string): ExtractedData {
  const empty: ExtractedData = { commitments: [], decisions: [], risks: [] }
  if (!text) return empty
  // Pull the first {...} block (handles ```json fences / leading prose).
  const obj = extractFirstJsonObject(text)
  if (!obj) return empty

  const commitments = (Array.isArray(obj.commitments) ? obj.commitments : [])
    .map((c) => c as Record<string, unknown>)
    .filter((c) => typeof c.note === 'string' && coerceDate(c.date))
    .map((c) => ({ note: c.note as string, date: coerceDate(c.date) as string }))

  const decisions = (Array.isArray(obj.decisions) ? obj.decisions : [])
    .map((d) => d as Record<string, unknown>)
    .filter((d) => typeof d.note === 'string' && coerceDate(d.decide_by))
    .map((d) => ({
      note: d.note as string,
      decide_by: coerceDate(d.decide_by) as string,
      cleared: typeof d.cleared === 'string' ? d.cleared : undefined,
      blocked: typeof d.blocked === 'string' ? d.blocked : undefined
    }))

  const risks: ExtractedRisk[] = (Array.isArray(obj.risks) ? obj.risks : [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.id === 'string' && typeof r.label === 'string')
    .map((r) => ({
      id: r.id as string,
      label: r.label as string,
      severity: coerceSeverity(r.severity),
      about: typeof r.about === 'string' ? r.about : undefined
    }))

  return { commitments, decisions, risks }
}

/**
 * Enrich a structural graph with extracted temporal data (PURE). Commitments
 * set a node's date; decisions add a decide-by + cleared/blocked fork (and make
 * the node a gate); risks become new risk nodes with a 'threatens' edge to the
 * node they concern. Items referencing unknown node ids are kept where they
 * stand alone (risks) and skipped where they must attach (commitments/decisions).
 */
export function applyExtraction(base: CausalGraph, ex: ExtractedData): CausalGraph {
  const byId = new Map(base.nodes.map((n) => [n.id, n]))
  const nodes = base.nodes.map((n) => ({ ...n }))
  const edges = base.edges.map((e) => ({ ...e }))
  const liveById = new Map(nodes.map((n) => [n.id, n]))

  for (const c of ex.commitments) {
    const n = liveById.get(c.note)
    if (n) n.date = c.date
  }
  for (const d of ex.decisions) {
    const n = liveById.get(d.note)
    if (!n) continue
    n.decide_by = d.decide_by
    if (n.kind === 'stream' || n.kind === 'anchor') n.kind = 'gate'
    if (d.cleared && d.blocked) n.fork = { cleared: d.cleared, blocked: d.blocked }
  }
  for (const r of ex.risks) {
    if (byId.has(r.id)) continue // don't clobber a real node
    const target = r.about && liveById.has(r.about) ? r.about : undefined
    nodes.push({
      id: r.id,
      kind: 'risk',
      label: r.label,
      risk: r.severity ?? 'amber',
      track: target ? liveById.get(target)?.track : undefined
    } as CausalNode)
    if (target) edges.push({ source: r.id, target, type: 'threatens', confidence: 0.5 })
  }

  return { ...base, nodes, edges }
}

// ── Orchestration (NOT unit-tested — needs a callable model: a BYO key or a
//    local Ollama). Verified once a provider key or Ollama model is present. ──

/** Run the extraction LLM pass over the indexed notes. Returns null when no
 *  callable model is available (no BYO key AND no local Ollama) or on any
 *  failure (→ structural-only, as before). */
export async function extractTemporal(): Promise<ExtractedData | null> {
  const model = routeModel('extraction') // cheap/fast model for structured JSON
  if (!model) return null
  const chunks = allChunks()
  if (chunks.length === 0) return null
  const notes = groupChunksByFile(chunks).map(({ file, text }) => ({ id: file, text }))

  const prompt = buildExtractionPrompt(notes)
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]

  const runOnce = (activeModel: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let acc = ''
      chatStream(messages, activeModel, undefined, {
        onChunk: (c: string) => {
          acc += c
        },
        onDone: () => resolve(acc),
        onError: (e: string) => reject(new Error(e))
      }).catch(reject)
    })

  // Failover (mirror the /agui answer path): a dry/rate-capped OR stale-id primary must not silently
  // drop ALL temporal extraction — that leaves the brain structural-only with no entity/temporal graph.
  // On a quota/billing error, jump to a DISTINCT keyed provider; on a stale/unknown model id
  // (model_not_found/404 — the shipped extraction default may be a speculative catalog id), exhaust the
  // SAME provider's other ids first (a single-key operator has no distinct provider to fall to).
  const tried = new Set<string>()
  let activeModel: string | null = model
  let lastErr = ''
  while (activeModel && !tried.has(activeModel)) {
    tried.add(activeModel)
    try {
      return parseExtraction(await runOnce(activeModel))
    } catch (err) {
      lastErr = (err as Error)?.message ?? ''
      if (!isProviderFailoverError(lastErr)) break
      const prov = getProviderForModel(activeModel)
      const staleId = isModelNotFoundError(lastErr)
      const next = staleId
        ? routeWithinProvider(prov, 'extraction', tried) ?? routeDistinctModel(prov, 'extraction')
        : routeDistinctModel(prov, 'extraction')
      if (next && !tried.has(next)) {
        console.warn(`[notes-extract] ${activeModel} unavailable (${staleId ? 'unknown model' : 'quota'}); retrying on ${next}`)
      }
      activeModel = next
    }
  }
  if (lastErr) console.warn('[notes-extract] extraction failed:', lastErr)
  return null
}
