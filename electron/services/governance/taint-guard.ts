/**
 * Taint-bit dispatcher — the injection-containment invariant for computer-use (Phase 2).
 *
 * CaMeL's central rule, shippable without a full information-flow lattice:
 *   "If any argument to an irreversible / exfiltrating tool derives from untrusted content
 *    (a screenshot, a scraped page, a file read), block it — require human ratification."
 *
 * Untrusted content (tool results from computer-use / browser / web / external MCP reads) is
 * recorded in a per-conversation {@link TaintStore}. Before an irreversible/outward tool runs,
 * {@link taintFloorForDescriptor} checks whether any string arg was lifted from that content.
 *
 * This is a structural backstop, not a model-level filter: it catches an injected instruction
 * copied verbatim (the common case) into a shell/send/delete/navigate argument. Paraphrase can
 * slip it — which is why the human ratify gate, not detection, is the real containment (the
 * floor forces the gate; it does not claim to detect all attacks).
 */

export type TaintRisk = 'read' | 'write' | 'network' | 'destructive' | 'secret' | 'sandboxBypass'

export interface TaintFloorDescriptor {
  name: string
  providerKind?: 'native' | 'mcp' | 'plugin'
  providerId?: string
  risks?: readonly string[]
}

export interface TaintStore {
  /** Record a tool result / content chunk as untrusted (screen, web, file, external MCP). */
  markUntrusted(text: string): void
  /** Does `value` appear to have been lifted from recorded untrusted content? */
  isTainted(value: string): boolean
  /** Count of untrusted fragments held (for diagnostics/tests). */
  size(): number
}

/** Risk classes that make a tool irreversible or exfiltrating — the taint-sensitive set. */
const EXFIL_OR_IRREVERSIBLE = new Set<string>(['network', 'destructive', 'secret', 'sandboxBypass'])

/** A normalized arg fragment shorter than this can't be meaningfully "lifted" — avoids FP noise. */
const MIN_TAINT_FRAGMENT = 12
/** Cap on retained untrusted fragments (ring buffer) to bound memory. */
const DEFAULT_MAX_FRAGMENTS = 512

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function createTaintStore(opts?: { maxFragments?: number }): TaintStore {
  const max = opts?.maxFragments ?? DEFAULT_MAX_FRAGMENTS
  const fragments: string[] = []
  return {
    markUntrusted(text: string) {
      if (typeof text !== 'string') return
      const n = normalize(text)
      if (n.length === 0) return
      fragments.push(n)
      if (fragments.length > max) fragments.splice(0, fragments.length - max)
    },
    isTainted(value: string): boolean {
      if (typeof value !== 'string') return false
      const v = normalize(value)
      if (v.length < MIN_TAINT_FRAGMENT) return false
      return fragments.some((frag) => frag.includes(v))
    },
    size() {
      return fragments.length
    }
  }
}

/** A tool whose result carries external / on-screen content — its output must be marked untrusted. */
export function isUntrustedSource(descriptor: TaintFloorDescriptor): boolean {
  if (descriptor.providerKind === 'mcp') return true // any external MCP result is untrusted
  const name = descriptor.name
  if (/^(browser_|preview_|web_)/.test(name)) return true
  if (name === 'frontend_qa' || name === 'view_image' || name === 'fetch') return true
  // any native tool that reaches the network returns untrusted content
  return (descriptor.risks ?? []).includes('network')
}

/** Is this tool irreversible/exfiltrating, i.e. taint-sensitive on its arguments? */
export function isTaintSensitive(descriptor: TaintFloorDescriptor): boolean {
  return (descriptor.risks ?? []).some((r) => EXFIL_OR_IRREVERSIBLE.has(r))
}

/** Recursively collect string leaves from an args object. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, out)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out)
  }
}

export interface TaintFloorResult {
  blocked: true
  reason: string
  taintedValue: string
}

/**
 * The floor. Returns null to allow; a {@link TaintFloorResult} to refuse (require human ratify).
 * Only taint-sensitive tools are checked; read-only / reversible-write tools always pass.
 */
export function taintFloorForDescriptor(
  descriptor: TaintFloorDescriptor,
  args: Record<string, unknown>,
  store: TaintStore | undefined
): TaintFloorResult | null {
  if (!store || store.size() === 0) return null
  if (!isTaintSensitive(descriptor)) return null
  const leaves: string[] = []
  stringLeaves(args, leaves)
  for (const leaf of leaves) {
    if (store.isTainted(leaf)) {
      const preview = leaf.length > 60 ? `${leaf.slice(0, 57)}…` : leaf
      return {
        blocked: true,
        reason:
          `Blocked: an argument to '${descriptor.name}' (an irreversible/outward action) was ` +
          `derived from untrusted content read earlier this session. Requires human ratification. ` +
          `Tainted value: "${preview}"`,
        taintedValue: leaf
      }
    }
  }
  return null
}

// Per-conversation taint stores, so the interactive/loop chat path (chat.ts) and the headless
// executeToolCall path can share one untrusted-content view per conversation without threading
// a store through every signature.
const conversationStores = new Map<string, TaintStore>()
// Bound the number of live conversation stores (LRU by insertion order) so the Map can't grow
// without limit when clearConversationTaintStore isn't called on every conversation teardown.
const MAX_CONVERSATION_STORES = 64

export function getConversationTaintStore(conversationId: string): TaintStore {
  let s = conversationStores.get(conversationId)
  if (!s) {
    s = createTaintStore()
    conversationStores.set(conversationId, s)
    while (conversationStores.size > MAX_CONVERSATION_STORES) {
      const oldest = conversationStores.keys().next().value
      if (oldest === undefined) break
      conversationStores.delete(oldest)
    }
  }
  return s
}

export function clearConversationTaintStore(conversationId: string): void {
  conversationStores.delete(conversationId)
}

export const __testing = { normalize, MIN_TAINT_FRAGMENT, EXFIL_OR_IRREVERSIBLE, conversationStores }
