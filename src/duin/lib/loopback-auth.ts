const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
import { isControlledGetPath } from '../../../electron/shared/control-plane-policy'

export function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

export async function rendererToken(
  name: 'execToken' | 'controlToken'
): Promise<string> {
  try {
    const api = (
      window as unknown as {
        api?: {
          execToken?: () => Promise<string | null>
          controlToken?: () => Promise<string | null>
        }
      }
    ).api
    // Called by NAME, not by a computed key. A dynamic `api[name]()` reads identically at
    // runtime but makes both bridges invisible to scripts/preload-surface-lint.mjs, whose
    // whole job is to catch a preload binding no renderer code reaches — and a capability
    // that only LOOKS unreachable trains the next person to allowlist a real finding.
    const token = await (name === 'execToken' ? api?.execToken?.() : api?.controlToken?.())
    return typeof token === 'string' ? token : ''
  } catch {
    return ''
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function requiresControl(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') return true
  try {
    return isControlledGetPath(new URL(requestUrl(input)).pathname)
  } catch {
    return false
  }
}

/** Fetch wrapper for the renderer's local-brain state surface. */
export async function duinFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const rawUrl = requestUrl(input)
  if (!isLoopbackHttpUrl(rawUrl) || !requiresControl(input, init)) {
    return globalThis.fetch(input, init)
  }
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  )
  const token = await rendererToken('controlToken')
  if (token) headers.set('x-duin-control', token)
  return globalThis.fetch(input, { ...init, headers, redirect: 'error' })
}
