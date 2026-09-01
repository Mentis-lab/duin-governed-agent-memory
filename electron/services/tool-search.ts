// Tool search + tag derivation. Extracted from `tool-registry.ts` so the
// scoring logic can be exercised without standing up the full registry.
//
// Track 2 / Prompt C1 introduces lazy tool schemas: `tools:list` returns
// stubs (name + description + tags, no `inputSchema`), and the renderer
// expands them on demand via `tools:resolve(names[])` or `tools:search({ query })`.
// The MCP catalog can grow to several hundred tools across Gmail / Drive /
// Chrome / etc.; sending the full JSON Schemas to the renderer on every
// list call is wasteful. The lazy-schema split here is the IPC-payload
// optimization. The main process still has the full schemas in memory —
// chat.ts continues to call `toolRegistry.getOpenAITools()` and gets every
// tool's full schema — so the model surface is unchanged.
//
// Tag taxonomy (used by tools:search ranking and by the renderer for
// filter chips):
//
//   provider kind:   'native' | 'mcp' | 'plugin'
//   risk classes:    'read' | 'write' | 'network' | 'destructive' | 'secret'
//   schema sourcing: 'lazy'                      (MCP/plugin)
//   approval gate:   'approval-required'         (requiresApproval=true)
//   parallelism:     'parallelizable'            (parallelizable=true)
//
// Tags are derived from the descriptor at read time. They are not stored
// in any persisted column — adding a new tag class only requires editing
// `computeToolTags` and the renderer chip palette.

import type { LampreyToolDescriptor } from './tool-registry'

/**
 * Compute the tag list for a descriptor. Deterministic — same descriptor
 * always yields the same tag set. Order is provider-kind first, then risk
 * classes in catalog order, then meta tags.
 */
export function computeToolTags(
  d: Pick<LampreyToolDescriptor, 'providerKind' | 'risks' | 'requiresApproval'> & {
    parallelizable?: boolean
    /** Optional at compute time — when omitted the 'lazy' tag is skipped. The
     *  registry passes the explicit boolean; ad-hoc callers (tests, scripts)
     *  can leave it off. */
    lazy?: boolean
    /** Track 2 / C3 — optional at compute time; emits the 'mutates' meta-tag
     *  used by the renderer's plan-mode filter and surfaced to the model via
     *  the OpenAI tools array description. */
    mutates?: boolean
  }
): string[] {
  const tags: string[] = [d.providerKind]
  for (const r of d.risks) tags.push(r)
  if (d.requiresApproval) tags.push('approval-required')
  if (d.parallelizable === true) tags.push('parallelizable')
  if (d.lazy === true) tags.push('lazy')
  if (d.mutates === true) tags.push('mutates')
  return tags
}

/**
 * `tools:search({ query })` accepts two forms:
 *
 *   1. `select:<name>[,<name>...]` — direct, ordered selection by exact
 *      `name`. Whitespace around commas is tolerated; unknown names are
 *      silently dropped (the renderer should reflect this to the caller).
 *   2. Anything else — keyword search. Tokens are scored against name
 *      (×3), tags (×2), and description (×1). Tie-broken by insertion
 *      order.
 *
 * `maxResults` defaults to 10. Pass `Infinity` to disable the cap (used by
 * the meta-tool `select:` path so the renderer can pull arbitrary fan-outs).
 */
export interface ToolSearchQuery {
  query: string
  maxResults?: number
}

export interface ScoredDescriptor<T> {
  descriptor: T
  score: number
}

/** Tokenize a query string into lowercase non-empty tokens. */
export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,/]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Parse a `select:` query into the comma-separated name list. Returns null
 *  when the query is not in `select:` form. */
export function parseSelectQuery(query: string): string[] | null {
  const trimmed = query.trim()
  if (!trimmed.toLowerCase().startsWith('select:')) return null
  const rest = trimmed.slice('select:'.length)
  return rest
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// Minimum token length for SUBSTRING matching. Shorter tokens must match a
// whole word instead.
//
// WHY (gate finding F6): the meta-tool tells the model to search by what it
// wants to do, so queries arrive as sentences — "take a screenshot of a web
// page". With no length floor, the 1-character token "a" scored +3 for every
// tool whose NAME merely contains the letter, and did so twice (the query has
// two "a"s). That is +6 of pure noise for most of the catalog, while
// `browser_screenshot` — which has no "a" in its name at all — collected none
// of it and fell out of the top 8. The meta-tool's own recommended phrasing
// could not find the tool it recommends.
//
// A flat "ignore short tokens" cutoff would throw away real signal ("qa" in
// `frontend_qa`, "vm", "ci"), so the rule is boundary-aware instead: a short
// token still counts, but only as a WHOLE WORD.
const SUBSTRING_MIN_TOKEN_LEN = 3

/** Single characters carry no keyword signal; only an exact name match counts. */
const SIGNAL_MIN_TOKEN_LEN = 2

/** Split an identifier or sentence into lowercase alphanumeric words. */
function wordsOf(text: string): Set<string> {
  return new Set(text.split(/[^a-z0-9]+/).filter(Boolean))
}

/**
 * Does `token` match `haystack`? Tokens at or above
 * {@link SUBSTRING_MIN_TOKEN_LEN} match as substrings (today's behaviour);
 * shorter ones must match a whole word.
 */
function fieldMatches(haystack: string, words: Set<string>, token: string): boolean {
  return token.length >= SUBSTRING_MIN_TOKEN_LEN ? haystack.includes(token) : words.has(token)
}

/**
 * Score a single descriptor against the parsed token list. Returns 0 when
 * no tokens match (callers should filter those out before sorting). Field
 * weights: name 3, tags 2, description 1.
 */
export function scoreDescriptor<
  T extends Pick<LampreyToolDescriptor, 'name' | 'description' | 'tags'>
>(descriptor: T, tokens: string[]): number {
  if (tokens.length === 0) return 0

  const name = descriptor.name.toLowerCase()
  const description = (descriptor.description ?? '').toLowerCase()
  const tagSet = new Set((descriptor.tags ?? []).map((t) => t.toLowerCase()))
  const nameWords = wordsOf(name)
  const descriptionWords = wordsOf(description)

  let score = 0
  // A word repeated in the query is still one signal — dedupe so "a … a" (or
  // "page … page") cannot double a descriptor's score.
  for (const tok of new Set(tokens)) {
    if (name === tok) {
      score += 6
    } else if (tok.length >= SIGNAL_MIN_TOKEN_LEN && fieldMatches(name, nameWords, tok)) {
      score += 3
    }
    if (tagSet.has(tok)) score += 2
    if (
      tok.length >= SIGNAL_MIN_TOKEN_LEN &&
      fieldMatches(description, descriptionWords, tok)
    ) {
      score += 1
    }
  }
  return score
}

/**
 * Run a search over a stable list of descriptors. Returns up to `maxResults`
 * matches, with the original list order preserved on ties (relies on
 * `Array.prototype.sort` being stable in V8, which has been guaranteed
 * since Node 12). Empty token list returns an empty array.
 */
export function searchDescriptors<
  T extends Pick<LampreyToolDescriptor, 'name' | 'description' | 'tags'>
>(all: T[], query: string, maxResults = 10): T[] {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []
  const scored: ScoredDescriptor<T>[] = []
  for (const d of all) {
    const score = scoreDescriptor(d, tokens)
    if (score > 0) scored.push({ descriptor: d, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const cap = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : scored.length
  return scored.slice(0, cap).map((s) => s.descriptor)
}
