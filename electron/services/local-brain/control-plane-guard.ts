// control-plane-guard.ts — the pure request-admission predicate for the in-process brain's
// control plane (:8799). SECURITY.md named this module and the guarantee it makes long before it
// existed as a file — the logic lived inline in server.ts and, critically, did LESS than the doc
// claimed: it checked Origin but never Host, so a DNS-rebinding page (a hostile domain resolved to
// 127.0.0.1) could drive a state change with an absent or same-looking Origin. Extracted here,
// pure (no `electron`/`http` import), so the decision that defines the boundary is unit-testable
// directly — the same split window-guard.ts uses.
//
// THE THREAT. :8799 is localhost-bound with no auth. The exposure is a browser the operator has
// open on some other page reaching 127.0.0.1:8799 and driving a mutation (Feishu send, config
// write, upload). Two browser vectors, two checks:
//   1. Cross-site write — a page at https://evil.example fetches http://127.0.0.1:8799/... The
//      browser attaches Origin: https://evil.example. Reject a mutating verb whose Origin is an
//      EXTERNAL http(s) origin.
//   2. DNS rebinding — evil.example is made to resolve to 127.0.0.1, so the page's own origin IS
//      loopback-by-IP but the request's Host header carries the attacker's domain. Reject ANY
//      request whose Host header is present and NOT a loopback name.
//
// WHAT IS DELIBERATELY ALLOWED, so legitimate callers are not broken:
//   • No Origin at all (the Electron renderer's file://app:// origin is not http(s); the Feishu
//     bridge and CLI are non-browser and send none) — allowed. A browser cannot suppress Origin
//     on a cross-origin mutating request, so "no Origin" is not a browser-attack shape.
//   • No Host header (HTTP/1.0, some non-browser clients) — allowed; only a PRESENT non-loopback
//     Host is a rebinding signal.
// Read routes (GET/HEAD) are not admission-checked here beyond the Host rule: they set no
// Access-Control-Allow-Origin, so a cross-origin page can fire one but never read the reply. The
// Host rule still applies to reads because a rebinding page CAN read a same-host reply.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// Effectful compatibility GETs (F5 residual): the set lives in shared/control-plane-policy so the
// renderer's token-attach helper and this guard can never drift apart. Still electron/http-free.
import { isControlledGetPath } from '../../shared/control-plane-policy'


/** hostname from a Host header value (strips the :port), lowercased. '' when absent. */
function hostOnly(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase()
  if (!h) return ''
  // IPv6 literal in brackets: [::1]:8799 → [::1]
  if (h.startsWith('[')) {
    const close = h.indexOf(']')
    return close >= 0 ? h.slice(0, close + 1) : h
  }
  const colon = h.lastIndexOf(':')
  return colon >= 0 ? h.slice(0, colon) : h
}

export interface ControlPlaneRequestShape {
  method: string
  /** Request path (query string tolerated); used only for the controlled-GET set. */
  url?: string
  /** Case-insensitive header bag (node lowercases incoming header names). */
  headers: {
    origin?: string | string[]
    host?: string | string[]
    'x-duin-control'?: string | string[]
    'x-duin-exec'?: string | string[]
  }
}

/** The per-launch tokens a mutation may authenticate with. Both null = fail closed on mutations. */
export interface ControlPlaneTokens {
  /** The control token minted by the server at start, handed to the renderer over IPC and to the
   *  in-process bridge directly — never written to disk. */
  control: string | null
  /** The host-exec token (agui-guard). Strictly MORE privileged than control, so presenting it
   *  also satisfies the control requirement: the external Feishu bridge and the bench harness
   *  authenticate with exactly this token (via the opt-in exec-token file) and must not need a
   *  second, weaker credential they have no way to read. */
  exec: string | null
}

/** Constant-time string compare (same shape as agui-guard's execAuthorized; duplicated locally so
 *  this module keeps its zero-import purity — the property its tests rely on). */
function tokenMatches(headerToken: string | string[] | undefined, serverToken: string | null): boolean {
  const supplied = Array.isArray(headerToken) ? undefined : headerToken
  if (!serverToken || typeof supplied !== 'string' || supplied.length === 0) return false
  if (supplied.length !== serverToken.length) return false
  let diff = 0
  for (let i = 0; i < serverToken.length; i++) diff |= supplied.charCodeAt(i) ^ serverToken.charCodeAt(i)
  return diff === 0
}

const headerStr = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '')

export interface ControlPlaneVerdict {
  ok: boolean
  /** Short machine reason when denied; undefined when allowed. */
  reason?: 'dns-rebind-host' | 'cross-origin-write' | 'control-token-required'
}

/** The admission decision. Deny reasons are distinct so the caller (and tests) can tell a
 *  rebinding attempt from a cross-site write from a missing credential.
 *
 *  CONTRACT CHANGE (2026-08-25, lands the gap-plan f8e15bc design on the trunk guard): a mutating
 *  verb — and each controlled effectful GET — now requires a per-launch token: `x-duin-control`
 *  (renderer/in-process bridge) or the stronger `x-duin-exec` (external bridge, bench). A
 *  tokenless local POST that the old guard admitted is now refused: the Origin/Host rules only
 *  ever excluded BROWSER attack shapes, and left every non-browser local process free to mutate
 *  the brain. Reads stay tokenless so status probes and diagnostics keep working. */
export function admitControlPlaneRequest(
  req: ControlPlaneRequestShape,
  tokens: ControlPlaneTokens
): ControlPlaneVerdict {
  const method = (req.method || 'GET').toUpperCase()

  // Host rule — applies to EVERY method. A present, non-loopback Host is a DNS-rebinding signal.
  const host = hostOnly(headerStr(req.headers.host))
  if (host && !LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: 'dns-rebind-host' }
  }

  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'

  // Token rule — mutations and the controlled effectful GETs. Either credential admits; with no
  // token minted at all the plane fails CLOSED for mutations (a state only tests and torn startup
  // can produce — the server mints both at start).
  const path = (req.url ?? '').split('?')[0]
  if (mutating || isControlledGetPath(path)) {
    const controlOk = tokenMatches(req.headers['x-duin-control'], tokens.control)
    const execOk = tokenMatches(req.headers['x-duin-exec'], tokens.exec)
    if (!controlOk && !execOk) {
      return { ok: false, reason: 'control-token-required' }
    }
  }

  // Origin rule — mutating verbs only. A cross-origin GET is already SOP-safe (unreadable reply).
  if (mutating) {
    const origin = headerStr(req.headers.origin).trim()
    if (/^https?:\/\//i.test(origin)) {
      const originHost = ((): string => {
        try {
          return new URL(origin).hostname.toLowerCase()
        } catch {
          return 'invalid'
        }
      })()
      if (!LOOPBACK_HOSTS.has(originHost)) {
        return { ok: false, reason: 'cross-origin-write' }
      }
    }
  }

  return { ok: true }
}
