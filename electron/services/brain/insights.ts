// Insights engine — the ANALYTICAL half of DUIN's generate_insights()
// (server.py:3791), ported deterministically so it works with NO provider key:
// cross-cutting patterns/tensions/opportunities read off the causal field +
// prediction layer + per-track situation. Pure logic — no LLM, no vault.
//
// The GENERATIVE half — ideas / inspiration / questions via one LLM pass — is
// implemented below (generativeInsights): KEY-GATED and ADDITIVE. With a provider
// key or local Ollama it appends higher-level insights on TOP of the analytical
// ones; with no model it returns [] so the analytical insights stand on their own
// (exactly as before). Ranking mirrors DUIN's list_insights(): tensions/risks
// float above patterns/opportunities.

import type { Insight, CausalGraph } from './types'
import { substrateCausalGraph } from './causal-substrate'
import { worldState as worldStateNative } from './world-state-native'
import { predictedRisks as predictedRisksNative } from './predicted-risks-native'
import { chatStream, routeModel, detectOllama } from '../providers/registry'
import { extractFirstJsonObject } from './extraction-util'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { createHash } from 'crypto'

const MAX_INSIGHTS = 6
const RANK: Record<Insight['type'], number> = { tension: 0, risk: 1, insight: 2, opportunity: 3 }

// Signature cache for the generative LLM pass — see insightsFromVaultWithGenerative.
const GEN_CACHE_TTL_MS = 5 * 60_000
let _genCache: { sig: string; generative: Insight[]; t: number } | null = null
/** Test hook — clears the generative-pass cache. */
export function __resetGenerativeCache(): void {
  _genCache = null
}
/** Normalize insight text for stable content-hash ids (case/whitespace-insensitive). */
function normInsightText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

interface InsightTrack {
  key: string
  label: string
  risks: number
}

/** PURE insight derivation over ANY causal graph + tracks + risk count — shared by the Stack-A
 *  (store) and Stack-B (vault) readers so the analytical logic lives once. */
export function deriveInsights(g: CausalGraph, wsTracks: InsightTrack[], riskCount: number): Insight[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]))
  const out: Insight[] = []

  // (1) Convergence bottleneck — the node the most paths funnel into.
  const converge = g.nodes
    .filter((n) => (n.in_degree ?? 0) >= 2)
    .sort((a, b) => (b.in_degree ?? 0) - (a.in_degree ?? 0))[0]
  if (converge) {
    out.push({
      id: `conv::${converge.id}`,
      type: 'tension',
      headline: `${converge.label} is a convergence point`,
      why: `${converge.in_degree} paths funnel into it. If it slips, everything downstream waits.`,
      sources: [converge.id],
      confidence: 0.7
    })
  }

  // (2) Risk concentration — the lane carrying the most foreseen risk.
  const riskyTrack = [...wsTracks].filter((t) => t.risks > 0).sort((a, b) => b.risks - a.risks)[0]
  if (riskyTrack && riskCount > 0) {
    out.push({
      id: `riskconc::${riskyTrack.key}`,
      type: 'risk',
      headline: `Most foreseen risk sits in ${riskyTrack.label}`,
      why: `This lane holds ${riskyTrack.risks} of ${riskCount} foreseen ${riskCount === 1 ? 'risk' : 'risks'}, the most of any lane.`,
      sources: [riskyTrack.key],
      confidence: 0.65
    })
  }

  // (3) Cross-lane coupling — a node that feeds work in 2+ different lanes.
  const targetTracks = new Map<string, Set<string>>()
  for (const e of g.edges) {
    const t = byId.get(e.target)?.track
    if (!t) continue
    const s = targetTracks.get(e.source) ?? new Set<string>()
    s.add(t)
    targetTracks.set(e.source, s)
  }
  for (const [src, tracks] of targetTracks) {
    if (tracks.size >= 2) {
      const n = byId.get(src)
      if (n) {
        out.push({
          id: `couple::${src}`,
          type: 'insight',
          headline: `${n.label} couples ${[...tracks].sort().join(' & ')}`,
          why: `It feeds work in ${tracks.size} different lanes, so a change here ripples across them.`,
          sources: [src],
          confidence: 0.6
        })
        break // one coupling insight is enough signal
      }
    }
  }

  // (4) Decision pressure — multiple decision windows open at once.
  const decisions = g.nodes.filter((n) => n.decide_by)
  if (decisions.length >= 2) {
    out.push({
      id: 'decpress',
      type: 'tension',
      headline: `${decisions.length} decision windows are open`,
      why: `Several calls are due in the same stretch, so clustering them risks rushed decisions.`,
      sources: decisions.map((n) => n.id),
      confidence: 0.6
    })
  }

  // (5) Disconnected node — present but linked to nothing yet.
  const linked = new Set<string>()
  for (const e of g.edges) {
    linked.add(e.source)
    linked.add(e.target)
  }
  const orphan = g.nodes.find((n) => !linked.has(n.id))
  if (orphan) {
    out.push({
      id: `orphan::${orphan.id}`,
      type: 'opportunity',
      headline: `${orphan.label} isn't connected yet`,
      why: `It links to no cause or outcome. Connect it to the field or prune it.`,
      sources: [orphan.id],
      confidence: 0.55
    })
  }

  out.sort((a, b) => RANK[a.type] - RANK[b.type])
  return out.slice(0, MAX_INSIGHTS)
}

/** Stack-B reader (fs-native substrate) — analytical insights over the SAME graph the UI renders. */
export function insightsFromVault(vaultDir: string | null): { insights: Insight[] } {
  return {
    insights: deriveInsights(
      substrateCausalGraph(vaultDir),
      worldStateNative(vaultDir).tracks as unknown as InsightTrack[],
      predictedRisksNative(vaultDir).risks.length
    )
  }
}

// ─────────────────── GENERATIVE half (LLM, key-gated, additive) ───────────────────

const MAX_GENERATIVE = 3

/** Build the generative-insight prompt from the analytical signal already computed.
 *  Grounds the model in the real tracks/risks and tells it NOT to repeat the
 *  analytical findings. PURE + unit-tested. */
interface PromptTrack {
  label: string
  risks: number
  due_soon: number
}
interface PromptRisk {
  title: string
  due?: string
}

export function buildGenerativePrompt(analytical: Insight[], wsTracks: PromptTrack[], risks: PromptRisk[]): string {
  const tracks = wsTracks.map((t) => `- ${t.label}: ${t.risks} risk(s), ${t.due_soon} due soon`).join('\n')
  const riskList = risks.slice(0, 5).map((r) => `- ${r.title} (${r.due || 'no date'})`).join('\n')
  const seen = analytical.map((i) => `- [${i.type}] ${i.headline}: ${i.why}`).join('\n')
  return (
    'You are the generative half of a second-brain insight engine. The analytical engine ' +
    'already surfaced the structural patterns below. Add 1-3 HIGHER-LEVEL, non-obvious ' +
    'insights, open questions, or opportunities a sharp chief-of-staff would raise — things ' +
    'NOT already stated. Ground them in the tracks/risks shown; do not invent facts.\n' +
    'Output ONLY a JSON object — no prose, no code fence — of the form:\n' +
    '{"insights":[{"type":"insight|opportunity","headline":"<short>","why":"<one sentence>","confidence":0.0-1.0}]}\n' +
    'Rules: omit anything already in the analytical list; headlines under 12 words; ' +
    'confidence reflects how grounded it is; an empty array is fine.\n\n' +
    '=== TRACKS ===\n' + (tracks || '(none)') +
    '\n\n=== FORESEEN RISKS ===\n' + (riskList || '(none)') +
    '\n\n=== ANALYTICAL INSIGHTS (do not repeat) ===\n' + (seen || '(none)')
  )
}

/** Parse the generative LLM output into Insight[] (each flagged `generative`).
 *  Tolerant: a fenced block / leading prose / malformed items don't throw — bad
 *  items are dropped. Returns [] on total failure. PURE + unit-tested. */
export function parseGenerativeInsights(text: string): Insight[] {
  if (!text) return []
  const obj = extractFirstJsonObject(text)
  const items = obj && Array.isArray((obj as Record<string, unknown>).insights)
    ? ((obj as Record<string, unknown>).insights as unknown[])
    : []
  const out: Insight[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Record<string, unknown>
    const headline = typeof it.headline === 'string' ? it.headline.trim() : ''
    const why = typeof it.why === 'string' ? it.why.trim() : ''
    if (!headline || !why) continue
    const type: Insight['type'] = it.type === 'opportunity' ? 'opportunity' : 'insight'
    const confRaw = typeof it.confidence === 'number' ? it.confidence : 0.5
    const confidence = Math.max(0, Math.min(1, confRaw))
    // Stable content-hash id: the SAME idea keeps its id across regenerations, so a
    // user dismiss sticks. The old `gen::${i}::${headline}` churned every pass — the
    // array index and reworded headline both shifted, so a dismissed idea returned
    // under a fresh id. featureOf() still buckets these under 'gen' (prefix before ::).
    const idHash = createHash('sha1')
      .update(normInsightText(headline) + '|' + normInsightText(why))
      .digest('hex')
      .slice(0, 12)
    out.push({
      id: `gen::${idHash}`,
      type,
      headline,
      why,
      sources: [],
      confidence,
      generative: true
    })
  }
  return out.slice(0, MAX_GENERATIVE)
}

/** Run the generative insight LLM pass. Returns [] when no callable model is
 *  available (no BYO key AND no local Ollama) or on any failure → analytical-only,
 *  exactly as before. Orchestration is key-gated (mirrors notes-extract.extractTemporal). */
/** The generative LLM pass over a prepared prompt. Keyless-safe (probes Ollama once). Shared by
 *  the Stack-A (store) and Stack-B (vault) generative readers. Returns [] with no model / on error. */
async function runGenerativePass(prompt: string): Promise<Insight[]> {
  let model = routeModel('extraction') // cheap/fast tier; grounded, low-temp output
  if (!model) {
    // Keyless turnkey: a fresh launch may not have probed local Ollama yet, so
    // routeModel can't see it. Probe once, then retry before giving up.
    await detectOllama()
    model = routeModel('extraction')
  }
  if (!model) return []
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]
  try {
    const text = await new Promise<string>((resolve, reject) => {
      let acc = ''
      chatStream(messages, model, undefined, {
        onChunk: (c: string) => {
          acc += c
        },
        onDone: () => resolve(acc),
        onError: (e: string) => reject(new Error(e))
      }).catch(reject)
    })
    return parseGenerativeInsights(text)
  } catch (err) {
    console.warn('[insights] generative pass failed:', (err as Error)?.message)
    return []
  }
}

/** Stack-B: analytical + generative insights over the fs-native substrate (same data the UI renders). */
export async function insightsFromVaultWithGenerative(vaultDir: string | null): Promise<{ insights: Insight[] }> {
  const analytical = insightsFromVault(vaultDir).insights
  const tracks = worldStateNative(vaultDir).tracks as unknown as PromptTrack[]
  const risks = predictedRisksNative(vaultDir).risks as unknown as PromptRisk[]
  const prompt = buildGenerativePrompt(analytical, tracks, risks)
  // Cache the expensive LLM pass on the prompt signature. `brain:updated` fires on
  // every reindex stage / connector sync / no-op enrichment tick; without this a
  // fresh LLM call ran on EACH, even when nothing the prompt depends on changed. A
  // real content change alters the prompt → new signature → cache miss, so this only
  // suppresses redundant passes, never stale ones. Caching also stops insight churn:
  // unchanged inputs now return the SAME generative set (stable ids) tick-to-tick.
  const sig = createHash('sha1').update((vaultDir ?? '') + '\u0000' + prompt).digest('hex')
  const now = Date.now()
  let generative: Insight[]
  if (_genCache && _genCache.sig === sig && now - _genCache.t < GEN_CACHE_TTL_MS) {
    generative = _genCache.generative
  } else {
    generative = await runGenerativePass(prompt)
    // Only cache a NON-EMPTY pass. runGenerativePass returns [] both for a legitimate
    // empty result AND when no model is available yet (keyless turnkey / Ollama still
    // pulling / a BYO key added mid-session). Caching [] would suppress insights for the
    // whole TTL once a model comes online with the prompt unchanged. The no-model path
    // returns [] cheaply WITHOUT an LLM call, so not caching it costs nothing.
    if (generative.length > 0) _genCache = { sig, generative, t: now }
  }
  const merged = [...analytical, ...generative].sort((a, b) => RANK[a.type] - RANK[b.type])
  return { insights: merged.slice(0, MAX_INSIGHTS + MAX_GENERATIVE) }
}
