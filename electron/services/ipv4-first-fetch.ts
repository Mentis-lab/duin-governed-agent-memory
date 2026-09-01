import dns from 'dns'
import { Agent } from 'undici'

// Why this exists, measured on 2026-08-26 under Electron 43.2.0 / Node 24.18.0:
//
//   geocoding-api.open-meteo.com  ->  UND_ERR_CONNECT_TIMEOUT after 10,676ms
//   api.open-meteo.com            ->  HTTP 200 in 1,408ms
//
// The difference is an AAAA record. The geocoding host publishes one; its IPv6
// route black-holes from some networks (no answer at all, not a refusal), and
// Node's fetch picks that address and stalls until the connect timeout. Happy
// Eyeballs did not rescue it even with autoSelectFamily forced on. A raw
// net.connect to the SAME host's IPv4 address completes in 310ms. The sibling
// host publishes no AAAA, which is the only reason it works.
//
// So: attempt the request over IPv4 first, and fall back to the default
// dispatcher if that fails. The fallback is what keeps IPv6-only hosts working
// — a family-4 lookup for one of those fails at DNS resolution, which is fast
// and unambiguous, not a 10-second hang.
//
// Deliberately NOT done globally (dns.setDefaultResultOrder / setDefaultAutoSelectFamily):
// those change every request the main process makes, including the model
// providers, to fix a fault seen on two hosts.

const ipv4Agent = new Agent({
  connect: {
    lookup: (hostname, options, cb) =>
      dns.lookup(hostname, { ...options, family: 4 }, cb as never)
  }
})

/** True for the failure this helper exists to route around: the connection
 *  never completed. A 404 or a TLS rejection is a real answer and must NOT be
 *  retried — retrying those would just double the latency of a genuine error. */
export function isConnectFailure(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code
  return (
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH' ||
    code === 'ECONNREFUSED'
  )
}

/**
 * fetch(), but tried over IPv4 before the runtime's default address selection.
 *
 * Falls back to a plain fetch when the IPv4 attempt cannot connect, so a host
 * that is genuinely IPv6-only still resolves. An AbortSignal that has already
 * fired is honoured rather than retried — a caller-cancelled request must stay
 * cancelled.
 */
export async function ipv4FirstFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, dispatcher: ipv4Agent } as RequestInit)
  } catch (err) {
    if (init.signal?.aborted) throw err
    if (!isConnectFailure(err)) throw err
    return await fetch(url, init)
  }
}
