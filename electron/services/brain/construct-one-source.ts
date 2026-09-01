// construct-one-source.ts — the SCOPED single-source construction pass for "live node reveal".
//
// constructBrain() (construct.ts) is a WHOLE-VAULT pass: it reads allChunks(), groups by file, and
// batches 40 notes per LLM call on a ~15-min debounce. The live-node-reveal feature needs the SAME
// extraction machinery run over ONE freshly-dropped source, IMMEDIATELY, so its entities/edges can
// stream into the reveal instead of waiting for that whole-vault pass. This is that scoped entry.
//
// It reuses the exact PURE pieces verbatim — buildConstructionPrompt (a one-source corpus),
// parseConstruction (tolerant JSON), and resolveEntityIdentity (dedup/merge: fuse a duplicate onto
// its canonical id + rewire edges, so a re-mentioned entity does NOT spawn a twin). The LLM call is
// INJECTED (ExtractionChat) so this composition is unit-tested without a key; the default wraps
// chatStream with the SAME maxTokens/truncation handling as constructBrain's batch worker.
//
// SCOPE (deliberate): this is the fast, synchronous half only — extract → parse → resolve. It does
// NOT persist, supersede, decay, or cascade-invalidate; those stay on the whole-vault metabolism
// tick (claim-metabolism-tick.ts). A reveal-born node is a CANDIDATE the metabolism later earns or
// retires — see PLANNING/DUIN_LIVE_NODE_REVEAL_DESIGN.md.

import type { ConstructedData } from './types'
import { parseConstruction } from './construct'
import { entityResolverEnabled, resolveEntityIdentity } from './entity-resolver'
import { applyAliasOverlay, type AliasOverlay } from './operator-alias-overlay'
import { looksInjected } from './injection-guard'
import { chatStream, routeModel } from '../providers/registry'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

export interface ScopedSource {
  /** stable source id — the vault relpath / capture opid; becomes the note-node id in the graph */
  id: string
  text: string
}

/** A REVEAL-tuned extraction prompt for ONE freshly-dropped source. Unlike the corpus prompt
 *  (buildConstructionPrompt, deliberately conservative for a whole-vault batch — "omit anything
 *  uncertain"), this favours RECALL: the reveal is operator-REVIEWED, so a wrong edge is a one-click
 *  veto but a MISSED connection is invisible. Extract EVERY named entity + relationship. Same JSON
 *  shape as parseConstruction expects, same `<kind>:<slug>` id convention so a mentioned entity fuses
 *  onto its existing canonical node (a live test showed the corpus prompt pulled 1 of ~8 concepts). */
export function buildRevealPrompt(source: ScopedSource): string {
  const id = source.id
  const text = (source.text || '').slice(0, 4000)
  return (
    'Extract a KNOWLEDGE GRAPH from ONE freshly-written note. Read it (id below) and pull EVERY concrete ' +
    'thing it names and how they relate. Output ONLY a JSON object — no prose, no code fence — of the form:\n' +
    `{"entities":[{"id":"<kind>:<slug>","kind":"person|decision|event|org|topic","label":"<short name>","note":"${id}"}],` +
    `"edges":[{"source":"<entity id or the note id>","target":"<entity id or the note id>","type":"owns|depends_on|blocks|attends|affects|mentions|about"}],` +
    `"classifications":[{"note":"${id}","type":"meeting|output|mental_model|decision|note"}],` +
    `"triples":[{"subject":"<thing>","relation":"<any natural relation phrase>","object":"<thing or value>","note":"${id}","validFrom":null,"validUntil":null}]}\n` +
    'Rules — this note is REVIEWED by the operator, so favour RECALL (capture candidate connections; a ' +
    'wrong one is a one-click veto, a MISSED one is invisible):\n' +
    '- Extract EVERY named person, project, org, decision, event, and salient topic/concept — INCLUDING ' +
    'multi-word concepts (e.g. "usage-based pricing", "walled data garden", "calibration ledger").\n' +
    '- id MUST be a stable `<kind>:<slug>` (lowercase kind + short hyphenated slug); the SAME real thing ' +
    'MUST get the SAME id every time (so it merges onto the existing node, not a duplicate).\n' +
    '- edges: connect the note to each entity (`about`/`mentions`) AND entities to each other wherever the ' +
    'prose implies a relationship. Prefer MORE edges over fewer.\n' +
    `- every \`note\` field MUST be exactly "${id}".\n` +
    '- triples: the concrete claims stated, subject–relation–object with a natural relation phrase.\n' +
    '- Do NOT invent things the prose does not mention — but DO surface everything it does.\n\n' +
    `=== NOTE (id: ${id}) ===\n${text}`
  )
}

/** The injected LLM seam. Returns the raw completion text + finishReason so the caller can drop a
 *  TRUNCATED extraction (a cut-off JSON body is not trustworthy — same rule as the batch worker). */
export type ExtractionChat = (prompt: string, model: string) => Promise<{ text: string; finishReason: string | null }>

/** A duplicate the resolver fused onto an existing canonical node — `rawId` (as the model emitted it)
 *  was rewritten to `into`. Surfaced so the reveal can animate the merge ("recognized as existing X"). */
export interface RevealMerge {
  rawId: string
  into: string
}

export interface ConstructOneResult {
  /** resolved (deduped) construction for this one source, or null when key-gated / failed / truncated */
  data: ConstructedData | null
  /** entities the resolver merged onto an existing canonical id (empty when resolve is off / nothing fused) */
  merges?: RevealMerge[]
  /** 'built' = a model ran and produced a (possibly empty) parse; 'no-model' = key-gated off;
   *  'model-error' = a model was routed but threw or truncated (distinct so the UI can differentiate). */
  status: 'built' | 'no-model' | 'model-error'
}

/** Drop entities whose label carries prompt-injection signatures (+ edges to them, + injected triples),
 *  so a poisoned extraction can't plant a steering node in the graph — the graph-path analogue of the
 *  operator-fact store's write gate (looksInjected does not otherwise sit on this path). Fast-path:
 *  returns the input unchanged when nothing is injected. */
function stripInjected(data: ConstructedData): ConstructedData {
  const bad = new Set<string>()
  const entities = data.entities.filter((e) => {
    if (looksInjected(e.label)) {
      bad.add(e.id)
      return false
    }
    return true
  })
  const triplesInjected = (data.triples ?? []).some((t) => looksInjected(t.subject) || looksInjected(t.relation) || looksInjected(t.object))
  if (!bad.size && !triplesInjected) return data
  const edges = data.edges.filter((e) => !bad.has(e.source) && !bad.has(e.target))
  const triples = (data.triples ?? []).filter((t) => !looksInjected(t.subject) && !looksInjected(t.relation) && !looksInjected(t.object))
  return { ...data, entities, edges, triples }
}

/** Detect which raw entity ids the resolver rewrote (label-keyed, matching how resolveEntityIdentity
 *  collapses aliases): a raw entity whose label resolves to a DIFFERENT id was fused onto that id. */
function computeMerges(raw: ConstructedData, resolved: ConstructedData): RevealMerge[] {
  const canonByLabel = new Map<string, string>()
  for (const e of resolved.entities) canonByLabel.set(e.label.trim().toLowerCase(), e.id)
  const out: RevealMerge[] = []
  for (const e of raw.entities) {
    const into = canonByLabel.get(e.label.trim().toLowerCase())
    if (into && into !== e.id) out.push({ rawId: e.id, into })
  }
  return out
}

/** Default extraction chat — wraps chatStream exactly like constructBrain's batch worker
 *  (maxTokens 8192 so a real construction JSON isn't truncated mid-object; /no_think for Ollama
 *  reasoning models, which otherwise "think" silently and trip the stream-stall timeout). */
const defaultExtractionChat: ExtractionChat = (prompt, model) => {
  const content = model.startsWith('ollama:') ? `${prompt}\n\n/no_think` : prompt
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content }]
  return new Promise((resolve, reject) => {
    let acc = ''
    chatStream(
      messages,
      model,
      undefined,
      {
        onChunk: (c: string) => {
          acc += c
        },
        onDone: (_full, _tools, _reasoning, completion) =>
          resolve({ text: acc, finishReason: completion?.finishReason ?? null }),
        onError: (e: string) => reject(new Error(e))
      },
      undefined,
      { maxTokens: 8192 }
    ).catch(reject)
  })
}

export interface ConstructOneOptions {
  /** override the LLM seam (tests inject a fake; default wraps chatStream) */
  chat?: ExtractionChat
  /** override the model (default: routeModel('extraction')) */
  model?: string | null
  /** run identity resolution (dedup/merge) — default: entityResolverEnabled() */
  resolve?: boolean
  /** operator-confirmed merges (loadAliasOverlay(vault)), folded in AFTER the whitelist pass */
  aliasOverlay?: AliasOverlay
}

/**
 * Run the construction extraction over ONE source and return its RESOLVED (deduped) entities+edges.
 * Never throws — returns { data:null } on no-model / provider error / truncation. This is the
 * synchronous, fast half of the live-node-reveal pipeline; the slow metabolism (supersession, decay,
 * cascade, promotion) is deferred to the whole-vault tick.
 */
export async function constructOneSource(
  source: ScopedSource,
  opts: ConstructOneOptions = {}
): Promise<ConstructOneResult> {
  // `undefined` = use the default route; an explicit `null` = caller means "no model" (don't route).
  // (`??` would conflate the two and call routeModel on an explicit null — which needs electron.)
  const model = opts.model === undefined ? routeModel('extraction') : opts.model
  if (!model) return { data: null, status: 'no-model' }

  const chat = opts.chat ?? defaultExtractionChat
  let out: { text: string; finishReason: string | null }
  try {
    out = await chat(buildRevealPrompt(source), model)
  } catch (err) {
    console.warn('[construct-one] extraction failed:', (err as Error)?.message)
    return { data: null, status: 'model-error' }
  }

  // A truncated body (finish_reason:'length') is a cut-off JSON object — not a trustworthy
  // extraction; drop it rather than emit a half-parsed graph (mirrors constructBrain's batch worker).
  if (out.finishReason === 'length') {
    console.warn('[construct-one] extraction truncated (finish_reason=length) — dropped')
    return { data: null, status: 'model-error' }
  }

  // Injection-isolate BEFORE resolution/persistence so a poisoned entity never enters the graph.
  const parsed = stripInjected(parseConstruction(out.text))
  const doResolve = opts.resolve ?? entityResolverEnabled()
  // resolveEntityIdentity fuses duplicate entities onto their canonical ids + rewires edges; it
  // returns null when disabled/empty → fall back to the raw parse so the graph is never dropped.
  const whitelistResolved = doResolve ? resolveEntityIdentity(parsed) ?? parsed : parsed
  // Operator-confirmed merges compose AFTER the whitelist pass (operator has the final say).
  const resolved = opts.aliasOverlay?.size ? applyAliasOverlay(whitelistResolved, opts.aliasOverlay) : whitelistResolved
  // Merges = every raw id the resolution (whitelist + operator overlay) rewrote — cheap; [] when nothing moved.
  const merges = computeMerges(parsed, resolved)
  return { data: resolved, merges, status: 'built' }
}
