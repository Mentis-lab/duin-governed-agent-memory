// agui-search.ts — first-class web_search for the /agui brain loop (Capabilities S1). The brain's
// web_search was a hand-rolled DuckDuckGo HTML scrape (executeWebSearch) — the blind panel dinged
// it as "a DDG scrape" on Capabilities. This routes it through the SAME tested provider cascade the
// coder path and deep-research use (adapter-cascade.ts::searchCascade — Brave/Tavily/… keyed via
// the OS keychain), formatting the top hits as title/url/snippet blocks with a `[via …]` provenance
// footer.
//
// Non-breaking BY CONSTRUCTION: with no API keys configured the cascade returns nothing, and we
// fall back to the built-in DDG scrape — so web_search behaves exactly as before until a provider
// key exists, then returns real ranked results. `DUIN_AGUI_WEB_CASCADE=0` forces the DDG path (a
// one-flag revert if the cascade ever misbehaves live).

import { searchCascade } from '../research/adapter-cascade'
import type { WebSearchResult } from '../web-search-adapters'
import { executeWebSearch } from './agui-executors'
import { messageOf } from '../guarded'
// Foundation 2 (bounded-context): when an embedder is threaded in, relevance-bound the assembled
// search output to the search query instead of a blind head-slice. Fail-open (no embed / cold /
// throw ⇒ today's head-slice), so byte-identical until a warm embedder is supplied.
import { boundToBudget } from './output-bound'
import type { EmbedFn } from '../brain/claim-entities'

export interface AguiWebSearchOpts {
  count?: number
  freshness?: 'day' | 'week' | 'month' | 'year'
}

// The per-tool timeout used to live here, because web_search was the only tool that had one.
// It is now the DISPATCHER-wide backstop (every tool gets a bound, not just this one), so the
// implementation moved to agui-timeout.ts and this module consumes it. Two copies would mean two
// readers of DUIN_TOOL_TIMEOUT_MS that could silently drift apart. Re-exported because
// `executeAguiWebSearch` below is not the only historical consumer of these names.
import { toolTimeoutMs, withToolTimeout } from './agui-timeout'
export { toolTimeoutMs, withToolTimeout }

/** PURE: render cascade hits as ordered `title\nurl\nsnippet` blocks + a `[via provider,…]` footer,
 *  truncated to maxChars. Extracted from the I/O path so the model-facing formatting is unit-tested. */
export function formatCascadeResults(results: WebSearchResult[], providersUsed: string[], maxChars = 8000): string {
  const blocks = results.map((r) => `${r.title}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}`)
  let out = blocks.join('\n\n')
  if (providersUsed.length) out += `\n\n[via ${providersUsed.join(', ')}]`
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n\n[…truncated…]'
  return out
}

/**
 * Run web_search through the provider cascade, falling back to the built-in DDG scrape on an empty
 * cascade, a throw, or when disabled. Returns the same `{ok, results|error}` shape as the DDG
 * executor so the /agui dispatch rewire is a one-line swap.
 */
export async function executeAguiWebSearch(
  queryArg: unknown,
  opts: AguiWebSearchOpts = {},
  maxChars = 8_000,
  signal?: AbortSignal,
  embed?: EmbedFn
): Promise<{ ok: true; results: string } | { ok: false; error: string }> {
  const q = String(queryArg ?? '').trim()
  if (!q) return { ok: false, error: 'query is required' }
  if (signal?.aborted) return { ok: false, error: 'web_search aborted (turn ended)' }
  const budget = toolTimeoutMs()
  // R4/Phase-2 — race the (otherwise unbounded) cascade + DDG fallback against the tool budget /
  // the turn signal so a stalled provider can never hang the round loop past the deadline.
  // F2: when an embedder is supplied, gather the full result set (no inner head-slice) and
  // relevance-bound it to the query afterward; otherwise the inner path head-slices as before.
  const raw = await withToolTimeout(
    runAguiWebSearch(q, opts, embed ? Number.MAX_SAFE_INTEGER : maxChars),
    budget,
    signal,
    () => ({ ok: false, error: `web_search timed out after ${budget}ms` }) as { ok: false; error: string }
  )
  if (embed && raw.ok) return { ok: true, results: await boundToBudget(raw.results, q, maxChars, embed) }
  return raw
}

/** The actual cascade → DDG-fallback work, extracted so executeAguiWebSearch can wrap it in the
 *  timeout/abort race. Behaviour is unchanged from before the R4 wrap. */
async function runAguiWebSearch(
  q: string,
  opts: AguiWebSearchOpts,
  maxChars: number
): Promise<{ ok: true; results: string } | { ok: false; error: string }> {
  if (process.env.DUIN_AGUI_WEB_CASCADE !== '0') {
    try {
      const { results, providersUsed } = await searchCascade(q, { count: opts.count ?? 8, freshness: opts.freshness })
      if (results.length) {
        return { ok: true, results: formatCascadeResults(results.slice(0, opts.count ?? 8), providersUsed, maxChars) }
      }
    } catch (e) { console.debug('[agui-search] transient/config error  the honest built-in fallback below:', messageOf(e)) }
  }
  // Empty cascade (no keys / all providers empty), a throw, or DUIN_AGUI_WEB_CASCADE=0 → DDG scrape,
  // which preserves the honest "No results / provider changed its format" messaging.
  return executeWebSearch(q, maxChars)
}
