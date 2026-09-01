// Prompt LAYOUT — the byte-stable-prefix split (efficiency campaign §5.1).
//
// WHY: every provider DUIN talks to (one OpenAI-compatible SDK, registry.ts) reuses a PREFILL CACHE
// keyed on the longest byte-identical PREFIX of the request. DeepSeek/OpenAI/Grok/Qwen/GLM do it
// automatically with no markers; Claude-via-OpenRouter needs explicit cache_control breakpoints
// (providers/prefill-cache.ts); llama.cpp/Ollama reuse the KV cache for a matching prefix in-slot.
//
// The legacy layout defeats that cache completely: message[0] is ONE concatenated system string
// carrying per-turn-volatile content. The first volatile byte lands only ~25 tokens in — it is
// `retrievalNote`, spliced into the middle of the preamble, which flips between its agentic and
// fallback wordings from turn to turn — so the byte-stable prefix is effectively ZERO, and the
// otherwise-stable multi-turn history that FOLLOWS message[0] can never cache either, because
// caching is prefix-anchored. A long thread therefore re-prefills everything, every turn.
//
// THE SPLIT: message[0] becomes the STABLE CORE (static preamble + `.brain/` identity + the durable
// memory index) — byte-identical turn over turn. Everything per-turn-volatile moves to the VOLATILE
// TAIL, prepended to the LAST user message. The cacheable prefix is then [core, ...prior history],
// which grows as the thread lengthens.
//
// WHY THE TAIL RIDES THE LAST USER MESSAGE (not its own system message): a trailing or interleaved
// system message is accepted unevenly across OpenAI-compatible providers, and Anthropic in
// particular takes a top-level system and wants alternating user/assistant — Claude being the one
// provider needing explicit markers. Prepending keeps the wire shape EXACTLY as today (one leading
// system message, then strictly alternating history) for every provider, and places retrieved
// evidence adjacent to the question it was retrieved for.
//
// KNOWN COST OF THAT CHOICE (measured, not hidden): the tail is applied at request-build time and
// never persisted — the client stores the user's typed text — so next turn re-sends that message
// WITHOUT its tail. The previous user question therefore re-prefills once. Reuse still grows
// monotonically, and the legacy layout reused nothing at all, but this is not maximal caching.
//
// STABILITY DISCIPLINE (what may live in the core): a block belongs in the core ONLY if it is
// invariant across turns of a thread. `retrievalNote` is NOT (it describes THIS turn's retriever).
// The operator whole-dump is NOT (it is included only on turns where recall did not run). The
// memory index IS — always included, changing only when the memory store changes. Getting this
// wrong does not corrupt answers, it silently destroys the cache hit, which is why `stableCoreOf`
// is pure and asserted byte-equal across turns by both the unit test and the efficiency instrument.
//
// PURE ESM + PROD-IMPORTED (the campaign's hybrid contract, same pattern as markdown-blocks.mjs):
// no electron/fs/env imports, so scripts/efficiency-benchmark.mjs can import this module and VERIFY
// the stability property by EXECUTING it, rather than trusting a grep. agui-grounding.ts imports
// the same functions for the real request path. Types live in prompt-layout.d.mts.

/** Header for the memory index, preserved from the legacy operator block. */
const MEMORY_HEADER = 'WHAT YOU KNOW ABOUT THE OPERATOR:'

/**
 * The byte-stable system core (message[0]). PURE: identical inputs produce identical bytes.
 * Empty blocks are dropped so an absent `.brain/` or empty memory store emits no dead separators.
 */
export function stableCoreOf(blocks) {
  const parts = [
    // Turn-invariant reply-language directive (empty unless the operator picked a language). First
    // so it colours the whole reply; empty parts are dropped below, so the auto/absent default keeps
    // the core byte-identical to today's.
    blocks.languageDirective,
    blocks.preamble,
    blocks.brainGrounding,
    blocks.memoryIndex ? MEMORY_HEADER + '\n' + blocks.memoryIndex : ''
  ]
  return parts.filter((s) => s && s.trim()).join('\n\n')
}

/**
 * Lay out the request as [stableCore, ...history] with `volatileTail` prepended to the LAST user
 * message, so everything before that message stays byte-stable across turns.
 *
 * Falls back to appending the tail as a trailing system message when history holds no user message
 * (a degenerate shape DUIN does not produce today — server.ts derives the query FROM the last user
 * message — but dropping the turn's retrieved CONTEXT would be a correctness bug, not a nicety).
 */
export function layoutStablePrefixMessages(core, history, volatileTail) {
  const msgs = [{ role: 'system', content: stableCoreOf(core) }]
  const lastUserIdx = lastUserIndex(history)
  const tail = volatileTail.trim()

  if (lastUserIdx === -1) {
    for (const m of history) msgs.push({ role: m.role, content: m.content })
    if (tail) msgs.push({ role: 'system', content: tail })
    return msgs
  }

  history.forEach((m, i) => {
    const withTail = i === lastUserIdx && tail
    msgs.push({ role: m.role, content: withTail ? prependTail(tail, m.content) : m.content })
  })
  return msgs
}

/**
 * Prepend the volatile retrieved-context tail to a message's content. String content is joined
 * directly; multimodal (vision) content gets the tail injected as a leading text part so the image
 * parts survive — a plain `tail + content` concat would coerce the array to '[object Object]' and
 * silently drop the attachment.
 */
function prependTail(tail, content) {
  if (typeof content === 'string') return tail + '\n\n' + content
  return [{ type: 'text', text: tail }, ...content]
}

/** Deterministic text projection of possibly-multimodal content, for the cache-prefix key. Image
 *  parts fold to a URL-bearing marker so two different images never collapse to the same prefix. */
function contentToText(content) {
  if (typeof content === 'string') return content
  return content.map((p) => (p.type === 'text' ? p.text : `[image:${p.image_url?.url ?? ''}]`)).join('\n')
}

function lastUserIndex(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return i
  }
  return -1
}

/**
 * The cacheable prefix: every message that must stay byte-identical across turns for the provider
 * prefill cache to hit. Exported so both the test and the instrument assert on exactly what the
 * cache keys on, rather than on message[0] alone.
 */
export function cacheablePrefixOf(msgs) {
  const lastUserIdx = lastUserIndex(msgs)
  const end = lastUserIdx === -1 ? msgs.length : lastUserIdx
  return msgs
    .slice(0, end)
    .map((m) => m.role + ': ' + contentToText(m.content))
    .join('\n')
}

/**
 * SELF-VERIFICATION for the efficiency instrument (the hybrid contract's "measure it" half).
 *
 * Builds two consecutive turns of one thread with genuinely different grounding and checks the four
 * properties the layout exists to provide. Lives HERE, beside the implementation, so the instrument
 * proves the property by RUNNING the real prod core instead of grepping a test file's source text —
 * a grep only proves a string exists, and would still pass if the assertion were commented out or
 * inverted. Returns a per-property report so the instrument can report WHICH property failed.
 *
 * Deliberately checks `delivered` too: a "layout" that achieved a perfectly stable prefix by
 * dropping the turn's grounding would satisfy every cache property and be useless.
 */
export function verifyStableLayout() {
  const core = { preamble: 'P', brainGrounding: 'B', memoryIndex: 'M' }
  const t1 = layoutStablePrefixMessages(core, [{ role: 'user', content: 'q1' }], 'TAIL1 ctx-for-q1')
  const t2 = layoutStablePrefixMessages(
    core,
    [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }
    ],
    'TAIL2 ctx-for-q2'
  )
  const coreStable = t1[0].content === t2[0].content
  const grows = cacheablePrefixOf(t2).startsWith(cacheablePrefixOf(t1))
  const noLeak = !cacheablePrefixOf(t2).includes('TAIL2')
  const delivered = t2.some((m) => String(m.content).includes('TAIL2 ctx-for-q2'))
  return { pass: coreStable && grows && noLeak && delivered, coreStable, grows, noLeak, delivered }
}
