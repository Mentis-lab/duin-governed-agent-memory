/**
 * Shared machinery for the live retrieval evals. ONE owner for the pieces that were copy-pasted
 * across four eval files — property 1.
 *
 * WHY THIS EXISTS, and it is not tidiness. `runFourStages` existed in three eval files, and by
 * 2026-08-02 two of them had ALREADY DIVERGED on the load-bearing line: `aggregation-arms` passed
 * `Math.max(8, hits.length + 4)` to the neighbour merge while `prolong-arms` passed the literal
 * `8` — and `prolong-arms`'s own docblock still promised the stages were "called EXACTLY as
 * server.ts calls them, so the arm measured and the code shipped cannot drift." The instrument had
 * drifted from itself while asserting it could not. That is property 1's falsifier verbatim: a
 * shared definition with no test that fails when a consumer drifts.
 *
 * The neighbour cap is now an explicit PARAMETER rather than a constant someone edits in one copy,
 * so an arm that deliberately differs (D30) has to say so at the call site.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'
import {
  mergeGraphNeighbors,
  rerankHits,
  snippetForFile,
  embedForRecall,
  type SearchHit
} from '../../local-brain/index-store'
import { graphNeighbors, type toGraphView } from '../retrieve-agent'
import { tasteRerank } from '../../local-brain/personalization-recall'
import { applyClaimFreshness, claimRecallEnabled } from '../claim-recall'
import type { loadLedger } from '../claim-ledger'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import type { ToolCallAccumulator } from '../../providers/registry'

export interface StageCtx {
  gview: ReturnType<typeof toGraphView>
  judgmentTexts: string[]
  ledger: ReturnType<typeof loadLedger>
  rerankOn: boolean
}

export interface StageOpts {
  /** Skip stage 1 entirely (an arm measuring the other three in isolation). */
  skipNeighbourMerge?: boolean
  /**
   * Cap handed to `mergeGraphNeighbors`. Defaults to `PRODUCTION_NEIGHBOUR_CAP`, which mirrors
   * what `server.ts` does today. Pass a function to model an arm at a different breadth — but say
   * WHY at the call site, because a different cap means the arm is no longer the shipped path.
   */
  neighbourCap?: (poolSize: number) => number
}

/** server.ts uses `hits.length + NEIGHBOUR_SLOTS` with NEIGHBOUR_SLOTS = 2, which is 8 at the
 *  searchK=6 default — the value the hardcoded constant used to be. */
export const PRODUCTION_NEIGHBOUR_CAP = (poolSize: number): number => poolSize + 2

/** The four downstream ranking stages, called as `server.ts` calls them. */
export async function runFourStages(
  query: string,
  input: SearchHit[],
  ctx: StageCtx,
  opts: StageOpts = {}
): Promise<SearchHit[]> {
  let hits = input
  const cap = opts.neighbourCap ?? PRODUCTION_NEIGHBOUR_CAP

  // 1. 1-hop graph-neighbour merge
  if (!opts.skipNeighbourMerge && hits.length > 0 && ctx.gview.nodes.length > 0) {
    const seen = new Set(hits.map((h) => h.file))
    const neighborFiles: string[] = []
    for (const h of hits.slice(0, 3)) {
      for (const nb of graphNeighbors(ctx.gview, h.file)) {
        if (!seen.has(nb.id) && !neighborFiles.includes(nb.id)) neighborFiles.push(nb.id)
      }
    }
    const neighborHits = neighborFiles
      .slice(0, 4)
      .map((f) => {
        const snip = snippetForFile(f)
        return snip ? { file: f, snippet: `(linked) ${snip}`, score: 0.25 } : null
      })
      .filter((h): h is SearchHit => h !== null)
    if (neighborHits.length > 0) hits = mergeGraphNeighbors(hits, neighborHits, cap(hits.length))
  }

  // 2. cross-encoder rerank
  if (hits.length > 1 && ctx.rerankOn) hits = await rerankHits(query, hits)

  // 3. taste-rerank
  if (hits.length > 1 && ctx.judgmentTexts.length > 0) {
    const reranked = await tasteRerank(query, hits, ctx.judgmentTexts, embedForRecall)
    if (reranked) hits = reranked
  }

  // 4. claim-freshness demotion
  if (hits.length > 1 && claimRecallEnabled()) hits = applyClaimFreshness(hits, ctx.ledger, Date.now())

  return hits
}

/** Read a vault off DISK as raw markdown. Deliberately NOT `allChunks()`: an arm whose premise is
 *  "no indexing step has happened" must not inherit the chunk index, which is also known to
 *  accumulate stale files across reindexes (retrieve-agent.ts). */
export function rawVaultCorpus(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (name.endsWith('.md')) {
        try {
          out[relative(root, full).split(sep).join('/')] = readFileSync(full, 'utf8')
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  walk(root, 0)
  return out
}

/** Parse a JSONL state file, tolerating partial/corrupt lines the way the brain ledgers do. */
export function readJsonl(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null)
  } catch {
    return []
  }
}

// ──────────────────── the provider transport (the ONE substituted piece) ────────────────────

export const ZHIPU_BASE = 'https://open.bigmodel.cn/api/paas/v4/'

/** Read the plaintext zhipu key out of a scratch userData copy. Returns null when absent so an
 *  eval can degrade to its local-only arms instead of throwing. */
export function zhipuKey(userDataDir: string): string | null {
  try {
    const keys = JSON.parse(readFileSync(join(userDataDir, 'keys.json'), 'utf8')) as Record<string, string>
    const v = keys.zhipu
    return typeof v === 'string' && v.startsWith('plain:') ? v.slice(6) : null
  } catch {
    return null
  }
}

export interface TurnOpts {
  tools?: ChatCompletionTool[]
  model?: string
  maxTokens?: number
  /** Minimum gap between calls. glm-4.5-airx trips this account's rate limit under rapid bursts. */
  minGapMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let lastCallAt = 0
let calls = 0

/** Total provider calls this process has made — evals report it so a run's cost is visible. */
export const apiCallCount = (): number => calls

/**
 * One turn against the live provider, mirroring chatStream's `{content, toolCalls}` contract.
 *
 * A provider BALANCE error surfaces immediately rather than burning five backoffs: Zhipu returns
 * 429 for "out of credit" (code 1113) exactly as it does for rate-limiting, which is a property-8
 * collapse on the provider's side and cost a real run before it was special-cased.
 */
export function makeTurn(key: string, opts: TurnOpts = {}) {
  const model = opts.model ?? 'glm-4.5-airx'
  const gap = opts.minGapMs ?? 700
  return async (
    messages: ChatCompletionMessageParam[],
    toolsOverride?: ChatCompletionTool[]
  ): Promise<{ content: string; toolCalls: ToolCallAccumulator[] }> => {
    const tools = toolsOverride ?? opts.tools
    let lastErr = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      const wait = lastCallAt + gap - Date.now()
      if (wait > 0) await sleep(wait)
      lastCallAt = Date.now()
      calls++
      try {
        const body: Record<string, unknown> = {
          model,
          messages,
          thinking: { type: 'disabled' },
          max_tokens: opts.maxTokens ?? 8192
        }
        if (tools && tools.length) body.tools = tools
        const res = await fetch(`${ZHIPU_BASE}chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(body)
        })
        if (!res.ok) {
          const text = await res.text()
          lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`
          if (/1113|余额不足|insufficient/i.test(text)) throw new Error(`PROVIDER OUT OF CREDIT — ${lastErr}`)
          if (res.status === 429 || res.status >= 500) {
            await sleep(3000 * 2 ** attempt)
            continue
          }
          throw new Error(lastErr)
        }
        const json = (await res.json()) as {
          choices?: { message?: { content?: string; reasoning_content?: string; tool_calls?: unknown[] } }[]
        }
        const msg = json.choices?.[0]?.message ?? {}
        const raw = (msg.tool_calls ?? []) as { id?: string; function?: { name?: string; arguments?: string } }[]
        return {
          content: msg.content || msg.reasoning_content || '',
          toolCalls: raw.map((t, i) => ({
            id: t.id ?? `call_${i}`,
            type: 'function' as const,
            function: { name: t.function?.name ?? '', arguments: t.function?.arguments ?? '{}' }
          }))
        }
      } catch (err) {
        lastErr = (err as Error).message
        if (/OUT OF CREDIT/.test(lastErr)) throw err
        await sleep(1500 * (attempt + 1))
      }
    }
    throw new Error(`provider failed after retries: ${lastErr}`)
  }
}
