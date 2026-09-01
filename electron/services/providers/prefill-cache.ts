// Provider prefill-cache breakpoints (efficiency campaign §5.1, the Claude half).
//
// DUIN speaks to every provider through ONE OpenAI-compatible SDK (registry.ts). Most of them
// (DeepSeek / OpenAI / Grok / Qwen / GLM) run prefix caching AUTOMATICALLY and need no markers at
// all — for those, the byte-stable prompt layout (local-brain/prompt-layout.ts) is the entire fix.
// Anthropic is the exception: its cache is EXPLICIT, so a Claude request only caches where the
// request carries `cache_control: {type:'ephemeral'}` breakpoints. DUIN reaches Claude solely via
// OpenRouter (registry.ts — there is no direct Anthropic adapter), and OpenRouter forwards
// `cache_control` verbatim to Anthropic, so marking here is sufficient and needs no registry
// plumbing: the `as any` on the create() params already carries content-part arrays through.
//
// Ollama (the local last-resort fallback) needs no markers either, but is NOT excluded from the
// benefit: llama.cpp reuses the KV cache for a matching prompt prefix in the same slot, so a
// byte-stable prefix cuts local prefill too — and since local prefill is the slowest of any path
// here, that is plausibly where the largest wall-clock saving lands.
//
// KNOWN NON-BENEFICIARY: Claude Haiku 4.5 has a 4096-token minimum cacheable prefix, which is
// above DUIN's typical stable core (~1500-3000 tokens on a populated vault), so the Haiku path
// realistically caches nothing. A fresh vault with no `.brain/` and no memories is ~170 tokens and
// clears no provider's minimum at all — the win arrives only once the operator's identity and
// memory index have accrued.
//
// TWO BREAKPOINTS, matching the two things that stay byte-stable across turns:
//   1. the end of the STABLE SYSTEM CORE (message[0]) — invariant for the whole thread;
//   2. the end of the STABLE HISTORY PREFIX (the message just before the final user message) —
//      grows monotonically as the thread lengthens, so each turn reuses the previous turn's
//      cached prefix and extends it.
// Anthropic permits up to 4 breakpoints and caches the longest matching prefix, so the pair
// yields a hit both on the invariant core and on the growing conversation.
//
// PURE: no SDK/electron imports, no mutation of the caller's array — the marked copy is built
// fresh, so a retry that re-marks an already-marked array is impossible by construction.

/**
 * Anthropic-via-OpenRouter model ids look like `anthropic/claude-…`.
 *
 * The `stableLayout` gate is NOT optional politeness — marking without it is a COST REGRESSION.
 * Anthropic bills a cache WRITE at ~1.25x base input and only refunds it on a later READ. Under the
 * legacy layout message[0] is the volatile concat (it carries `CONTEXT (retrieved for: ${query})`),
 * so its prefix hash differs every turn: each request would write a fresh entry that no later
 * request can ever match. That is a permanent ~25% surcharge on the system prompt for every Claude
 * user, bought in exchange for zero cache hits. So the markers ship only when the byte-stable
 * layout that gives them something reusable to point at is actually active.
 */
export function needsExplicitCacheMarkers(apiModelId: string, stableLayout: boolean): boolean {
  return stableLayout && apiModelId.startsWith('anthropic/')
}

/** Whether the byte-stable prompt layout (local-brain/prompt-layout.mjs) is the active layout. */
export function stableLayoutActive(): boolean {
  return process.env.DUIN_STABLE_PREFIX === '1'
}

// Structural only — deliberately NO index signature, so the SDK's ChatCompletionMessageParam
// union (whose members are closed object types) stays assignable.
type AnyMessage = { role?: string; content?: unknown }

function markable(m: AnyMessage | undefined): boolean {
  // Only plain-string content is markable. A message whose content is already a part-array is
  // left alone (nothing to convert, and re-marking would risk a duplicate breakpoint).
  return !!m && typeof m.content === 'string' && m.content.length > 0
}

function marked(m: AnyMessage): AnyMessage {
  return {
    ...m,
    content: [{ type: 'text', text: m.content as string, cache_control: { type: 'ephemeral' } }]
  }
}

/**
 * Return a copy of `messages` with Anthropic cache breakpoints applied, or the ORIGINAL array
 * for any provider that caches automatically (or needs no cache at all). Never mutates.
 */
export function withPrefillCacheMarkers<T extends AnyMessage>(
  messages: T[],
  apiModelId: string,
  stableLayout: boolean = stableLayoutActive()
): T[] {
  if (!needsExplicitCacheMarkers(apiModelId, stableLayout) || messages.length === 0) return messages

  const out = messages.slice() as AnyMessage[]

  // (1) the end of the leading SYSTEM run — not blindly index 0. Other features may prepend their
  // own system block ahead of the stable core (server.ts unshifts one under DUIN_FORWARD_NOTES),
  // and hardcoding out[0] would then place the breakpoint mid-preamble, cutting the cached region
  // short of the core it exists to cache. Marking the LAST leading system message keeps the
  // breakpoint at the end of the whole system section however many blocks compose it.
  let sysEnd = -1
  while (sysEnd + 1 < out.length && out[sysEnd + 1]?.role === 'system') sysEnd++
  if (sysEnd >= 0 && markable(out[sysEnd])) out[sysEnd] = marked(out[sysEnd])

  // (2) the end of the stable history prefix — the message immediately before the final user
  // message. Skipped when the final user message is the only/first message (turn 1 has no prefix
  // to cache yet) or when it is not string-content.
  let lastUserIdx = -1
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]?.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  const prefixEnd = lastUserIdx - 1
  if (prefixEnd > 0 && markable(out[prefixEnd])) out[prefixEnd] = marked(out[prefixEnd])

  return out as T[]
}
