// entity-enrich — the MODEL pass that turns an entity card's material into a description,
// a few attributes and any other names, grounded in that material only.
//
// Shape chosen on purpose: ONE small prompt per entity (the card's facts, relations and note
// sentences, ~1-2k tokens in, ≤ 400 tokens out) instead of widening the 40-note construction
// prompt. That keeps the local Ollama path viable (short context, no truncation, JSON a small
// model can hold), makes the pass incremental (an entity is re-described only when its material
// hash changes) and never re-runs the whole extraction. The result is persisted per vault in
// `.brain/state/entity-enrichment.json` and served on the card + as `desc` on the graph node.
//
// Routing: the free local model first when one is detected (DUIN_ENRICH_PREFER_LOCAL, default on),
// else the extraction role's policy chain. DUIN_DISABLE_ENRICH=1 turns the pass off entirely.

import { existsSync, readFileSync, statSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { brainRootPath, BRAIN_STATE_DIR } from './brain-root'
import { atomicWriteDurable } from './durable-write'
import { extractFirstJsonObject } from './extraction-util'
import { chatStream, getOllamaModels, routeModel } from '../providers/registry'
import type { EntityCard } from './entity-card'

export interface EntityEnrichment {
  id: string
  /** One or two sentences in the language of the material. */
  description: string
  attributes: { key: string; value: string }[]
  /** Other names for the entity found in the material (never invented). */
  aliases: string[]
  /** Model id that wrote it, e.g. `ollama:qwen3:8b` or `deepseek-v4-flash`. */
  model: string
  /** Hash of the card material it was grounded in; a different hash on the card = stale. */
  materialHash: string
  /** ISO time written. */
  at: string
}

export const ENRICHMENT_FILE = 'entity-enrichment.json'
export const ENRICH_MAX_FACTS = 30
export const ENRICH_MAX_RELATIONS = 30
export const ENRICH_MAX_SOURCES = 8
export const ENRICH_MAX_DESCRIPTION = 320
export const ENRICH_MAX_ATTRIBUTES = 6
export const ENRICH_MAX_ALIASES = 6
/** Output budget. The JSON itself is ~200 tokens; a local reasoning model (qwen3) thinks for
 *  ~500 more before it, and the `/no_think` soft switch is not honoured by every Ollama build,
 *  so the budget covers both. Measured 2026-09-03: 600 truncated the answer, 1500 does not. */
export const ENRICH_MAX_TOKENS = 1500

interface EnrichmentFile {
  version: 1
  entities: Record<string, EntityEnrichment>
}

export function enrichmentPath(vaultDir: string | null | undefined): string | null {
  const root = brainRootPath(vaultDir)
  return root ? join(root, BRAIN_STATE_DIR, ENRICHMENT_FILE) : null
}

const memo = new Map<string, { key: string; data: Map<string, EntityEnrichment> }>()

/** Every stored enrichment for the vault (memoized on the file's mtime+size). */
export function readEnrichments(vaultDir: string | null | undefined): Map<string, EntityEnrichment> {
  const path = enrichmentPath(vaultDir)
  if (!path || !existsSync(path)) return new Map()
  let key: string
  try {
    const st = statSync(path)
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return new Map()
  }
  const hit = memo.get(path)
  if (hit && hit.key === key) return hit.data
  const data = new Map<string, EntityEnrichment>()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EnrichmentFile>
    for (const [id, e] of Object.entries(parsed.entities ?? {})) {
      if (e && typeof e.description === 'string' && typeof e.materialHash === 'string') data.set(id, { ...e, id })
    }
  } catch {
    /* a corrupt file reads as empty; the next write replaces it */
  }
  memo.set(path, { key, data })
  return data
}

export function writeEnrichment(vaultDir: string, e: EntityEnrichment): void {
  const path = enrichmentPath(vaultDir)
  if (!path) return
  const all = new Map(readEnrichments(vaultDir))
  all.set(e.id, e)
  const file: EnrichmentFile = { version: 1, entities: Object.fromEntries(all) }
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteDurable(path, JSON.stringify(file, null, 1))
  memo.delete(path)
}

/** The enrichment for the card when one exists AND its material hash still matches. */
export function currentEnrichment(vaultDir: string, card: Pick<EntityCard, 'id' | 'materialHash'>): EntityEnrichment | null {
  const e = readEnrichments(vaultDir).get(card.id)
  return e && e.materialHash === card.materialHash ? e : null
}

/** The prompt: the card's material, then the JSON contract. Grounding is stated three times
 *  (only the material, thin material admitted, aliases only from the material) because a small
 *  local model needs the rule repeated near the output spec. */
export function buildEnrichPrompt(card: EntityCard): string {
  const lines: string[] = []
  lines.push('You describe ONE entity from a personal knowledge base, using ONLY the material below.')
  lines.push('Never add facts, dates, roles or names that are not in the material. If the material is thin, say what little is known.')
  lines.push('')
  lines.push(`Entity: ${card.label}`)
  lines.push(`Kind: ${card.kind}`)
  if (card.aliases.length) lines.push(`Other names already known: ${card.aliases.join(', ')}`)
  const facts = card.facts.slice(0, ENRICH_MAX_FACTS)
  if (facts.length) {
    lines.push('')
    lines.push('Facts (* = no longer current):')
    for (const f of facts) {
      const s = f.direction === 'subject' ? `${card.label} ${f.relation} ${f.other}` : `${f.other} ${f.relation} ${card.label}`
      const when = f.validFrom ? ` (since ${f.validFrom}${f.validUntil ? `, until ${f.validUntil}` : ''})` : ''
      lines.push(`- ${f.current ? '' : '* '}${s}${when}`)
    }
  }
  const rels = card.relations.slice(0, ENRICH_MAX_RELATIONS)
  if (rels.length) {
    lines.push('')
    lines.push('Relations:')
    for (const r of rels) lines.push(`- ${r.dir === 'out' ? `${card.label} ${r.type} ${r.label}` : `${r.label} ${r.type} ${card.label}`} (${r.kind})`)
  }
  const srcs = card.sources.filter((s) => s.snippet).slice(0, ENRICH_MAX_SOURCES)
  if (srcs.length) {
    lines.push('')
    lines.push('Sentences from the notes that mention it:')
    for (const s of srcs) lines.push(`- ${s.title}: "${s.snippet}"`)
  }
  lines.push('')
  lines.push(
    `Return ONLY a JSON object, no prose: {"description": "<one or two sentences, at most ${ENRICH_MAX_DESCRIPTION} characters, written in the same language as the material, saying what this ${card.kind} is and why it matters here>", "attributes": [{"key": "<short noun such as role, status, owner, date, location, type>", "value": "<value stated in the material>"}], "aliases": ["<other names for the entity that appear in the material>"]}`
  )
  lines.push(`At most ${ENRICH_MAX_ATTRIBUTES} attributes and ${ENRICH_MAX_ALIASES} aliases. Empty arrays when the material states none.`)
  return lines.join('\n')
}

/** Latin tokens (≥3 chars) and CJK bigrams of `s`, lowercased, for the grounding check. */
function tokensOf(s: string): string[] {
  const low = s.toLowerCase()
  const out: string[] = []
  for (const m of low.matchAll(/[a-z0-9][a-z0-9.'-]{2,}/g)) out.push(m[0])
  const cjk = low.match(/[㐀-鿿豈-﫿]+/g) ?? []
  for (const run of cjk) {
    if (run.length === 1) out.push(run)
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

/** True when at least one token of `value` occurs in the prompt material. */
export function groundedIn(material: string, value: string): boolean {
  const toks = tokensOf(value)
  if (!toks.length) return false
  const low = material.toLowerCase()
  return toks.some((t) => low.includes(t))
}

/** Parse + validate the model's answer. Attributes and aliases that do not occur in the material
 *  are dropped (the hallucination guard); the description is only length-capped. Null when no
 *  JSON object with a description came back. */
export function parseEnrichment(
  text: string,
  material: string,
  label: string,
  /** Names that are NOT aliases of this entity: the other entities on the card (a small model
   *  likes to list them), checked case-insensitively. */
  notAliases: ReadonlyArray<string> = []
): Pick<EntityEnrichment, 'description' | 'attributes' | 'aliases'> | null {
  const obj = extractFirstJsonObject(text)
  if (!obj) return null
  const desc = typeof obj.description === 'string' ? obj.description.replace(/\s+/g, ' ').trim() : ''
  if (!desc) return null
  const description = desc.length > ENRICH_MAX_DESCRIPTION ? `${desc.slice(0, ENRICH_MAX_DESCRIPTION - 1).trimEnd()}…` : desc
  const attributes: { key: string; value: string }[] = []
  if (Array.isArray(obj.attributes)) {
    for (const a of obj.attributes) {
      if (!a || typeof a !== 'object') continue
      const key = String((a as { key?: unknown }).key ?? '').trim().toLowerCase()
      const value = String((a as { value?: unknown }).value ?? '').replace(/\s+/g, ' ').trim()
      if (!key || !value || key.length > 32 || value.length > 160) continue
      if (!groundedIn(material, value)) continue
      if (attributes.some((x) => x.key === key)) continue
      attributes.push({ key, value })
      if (attributes.length >= ENRICH_MAX_ATTRIBUTES) break
    }
  }
  const aliases: string[] = []
  const labelLow = label.trim().toLowerCase()
  const excluded = new Set(notAliases.map((n) => n.trim().toLowerCase()).filter(Boolean))
  if (Array.isArray(obj.aliases)) {
    for (const a of obj.aliases) {
      if (typeof a !== 'string') continue
      const v = a.replace(/\s+/g, ' ').trim()
      if (!v || v.length > 80 || v.toLowerCase() === labelLow) continue
      const low = v.toLowerCase()
      // another entity's name, or the label with words bolted on ("Winter Campaign forecast")
      if (excluded.has(low) || (labelLow && low.includes(labelLow) && low !== labelLow)) continue
      if (!material.toLowerCase().includes(v.toLowerCase())) continue
      // A latin phrase that starts lowercase is a descriptor ("localisation vendor"), not a name.
      if (/^[a-z]/u.test(v)) continue
      if (aliases.some((x) => x.toLowerCase() === v.toLowerCase())) continue
      aliases.push(v)
      if (aliases.length >= ENRICH_MAX_ALIASES) break
    }
  }
  return { description, attributes, aliases }
}

export function enrichDisabled(): boolean {
  return process.env.DUIN_DISABLE_ENRICH === '1'
}

/** The model the pass runs on: the first detected local model when preferred (default) and
 *  routable, else whatever the extraction role resolves to. Null when nothing is callable. */
export function pickEnrichModel(): string | null {
  const preferLocal = process.env.DUIN_ENRICH_PREFER_LOCAL !== '0'
  const local = getOllamaModels()
  if (preferLocal && local.length) {
    const m = routeModel('extraction', `ollama:${local[0]}`)
    if (m) return m
  }
  return routeModel('extraction')
}

export interface EnrichOpts {
  /** Test seam: replaces the model call. Receives the prompt + model id, returns the raw text. */
  call?: (prompt: string, model: string) => Promise<string>
  model?: string | null
  timeoutMs?: number
  /** Re-describe even when a stored enrichment matches the material (the operator asked). */
  force?: boolean
}

const inFlight = new Map<string, Promise<EntityEnrichment | null>>()

export const OLLAMA_CHAT_URL = 'http://127.0.0.1:11434/api/chat'

/** The local path: Ollama's native chat API with thinking switched OFF. The OpenAI-compatible
 *  stream the cloud path uses cannot turn a hybrid reasoner's thinking off, so qwen3 spent its
 *  budget thinking (measured 2026-09-03: 600 tokens, no JSON), and a concurrent construction
 *  call starves the stream past its inactivity watchdog. Native + `think:false` answers in 2-6s
 *  warm with clean JSON; an older Ollama ignores `think` and the budget still covers a think
 *  block, whose JSON extractFirstJsonObject finds after it. */
async function callOllamaNative(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const name = model.slice('ollama:'.length)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: name,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: ENRICH_MAX_TOKENS }
      }),
      signal: ac.signal
    })
    if (!res.ok) throw new Error(`ollama ${res.status}`)
    const j = (await res.json()) as { message?: { content?: string } }
    return j.message?.content ?? ''
  } finally {
    clearTimeout(timer)
  }
}

async function callModel(prompt: string, model: string, timeoutMs: number): Promise<string> {
  if (model.startsWith('ollama:')) return callOllamaNative(prompt, model, timeoutMs)
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: prompt }]
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await new Promise<string>((resolve, reject) => {
      let acc = ''
      chatStream(
        messages,
        model,
        undefined,
        {
          onChunk: (c: string) => {
            acc += c
          },
          onDone: () => resolve(acc),
          onError: (e: string) => reject(new Error(e))
        },
        ac.signal,
        { maxTokens: ENRICH_MAX_TOKENS, temperature: 0 }
      ).catch(reject)
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Describe one entity from its card and persist the result. Returns the stored enrichment when
 *  the current one already matches the material (no model call), the new one after a successful
 *  call, or null when the pass is off, no model is callable, or the model's answer did not parse.
 *  Concurrent calls for the same id share one in-flight promise. */
export async function enrichEntity(vaultDir: string, card: EntityCard, opts: EnrichOpts = {}): Promise<EntityEnrichment | null> {
  if (enrichDisabled()) return null
  const existing = currentEnrichment(vaultDir, card)
  if (existing && !opts.force) return existing
  const key = `${vaultDir}\n${card.id}`
  const running = inFlight.get(key)
  if (running) return running
  const p = (async (): Promise<EntityEnrichment | null> => {
    const model = opts.model ?? pickEnrichModel()
    if (!model) return null
    const prompt = buildEnrichPrompt(card)
    let text: string
    try {
      text = opts.call ? await opts.call(prompt, model) : await callModel(prompt, model, opts.timeoutMs ?? 120_000)
    } catch (err) {
      console.warn('[entity-enrich] model call failed:', (err as Error)?.message)
      return null
    }
    const others = [...card.relations.map((r) => r.label), ...card.facts.map((f) => f.other), ...card.mergeCandidates.map((m) => m.label), ...card.sources.map((s) => s.title)]
    const parsed = parseEnrichment(text, prompt, card.label, others)
    if (!parsed) return null
    const e: EntityEnrichment = { id: card.id, ...parsed, model, materialHash: card.materialHash, at: new Date().toISOString() }
    try {
      writeEnrichment(vaultDir, e)
    } catch (err) {
      console.warn('[entity-enrich] persist failed:', (err as Error)?.message)
    }
    return e
  })()
  inFlight.set(key, p)
  try {
    return await p
  } finally {
    inFlight.delete(key)
  }
}

/** Stamp `desc` (and `descBy`) on served construction nodes that have a stored description.
 *  Applied post-fold like operator labels, so a description never changes graph structure. */
export function applyEntityDescriptions<N extends { id: string; layer?: unknown; desc?: unknown; descBy?: unknown }>(
  nodes: N[],
  enrichments: ReadonlyMap<string, EntityEnrichment>
): N[] {
  if (!enrichments.size) return nodes
  for (const n of nodes) {
    if (n.layer !== 'construction') continue
    const e = enrichments.get(n.id)
    if (!e) continue
    n.desc = e.description
    n.descBy = e.model
  }
  return nodes
}
