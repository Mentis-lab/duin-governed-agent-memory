// The gap this closes: /state/brain-graph had no behavioural test at all —
// server-load.test.ts only asserts the module evaluates, and
// renderer-route-parity.test.ts greps source text. So the route's new
// conditional-GET contract (ETag + 304 + stale-while-revalidate) was landing
// unexercised, and its failure mode is silent and permanent rather than loud.
//
// The bug being pinned: the first wiring minted the ETag from the key the
// request ASKED for. On a stale serve the cache hands back the PREVIOUS graph,
// so the client would store the old body under the new graph's identity — and
// on its next request that identity matches, it gets a 304, and it is pinned to
// a graph the server already replaced. It never recovers on its own, because
// nothing about the client's state is wrong from the client's point of view.
//
// POWER CONTROL: mint the ETag from `key` instead of `built.servedKey` in the
// /state/brain-graph handler and "a stale serve tags the body it actually sent"
// fails.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'
import { createHash } from 'node:crypto'

// This file pins the ROUTE's stale-while-revalidate contract: a key change is served
// stale and the rebuild lands behind it. brainGraphCache separately rate-limits how
// OFTEN it will schedule that rebuild (60s in production — the graph costs ~3s of main
// thread and its key moves on every channel-ingest write). That policy has its own tests
// in swr-json-cache.test.ts; here it would simply suppress the rebuilds these cases exist
// to observe, so it is switched off. freshRoute() re-imports the module per test and the
// cache reads this at construction, so setting it once here covers every case.
process.env.DUIN_BRAIN_GRAPH_MIN_REBUILD_MS = '0'

const VAULT = 'D:\\test-vault'

/** The one input to the cache key, so a test can move the vault under the route. */
let mtime = 1000
/** How many times the expensive build actually ran. */
let builds = 0

vi.mock('../brain/graph-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/graph-native')>()),
  nativeGraphMtime: (): number => mtime,
  readGraphNative: (): { nodes: unknown[]; edges: unknown[] } => ({ nodes: [], edges: [] })
}))

vi.mock('../brain/brain-graph-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/brain-graph-native')>()),
  // The body names the vault state it was built from, so an assertion says
  // "this is the 1000 graph" rather than "this is the Nth build" — the latter
  // shifts if a previous test leaves a rebuild timer in flight.
  buildBrainGraph: (): unknown => {
    builds++
    return { nodes: [{ id: `graph-at-${mtime}` }], links: [], core: 'core', stats: { nodes: 1, edges: 0 } }
  }
}))

// Both derive entry points come from ONE definition here. The route reads recency via
// deriveNodeMtimes (deriveGraph deep-clones the whole causal graph to hand over two
// fields per node, which is the cost the rebuild could not afford); mocking only
// deriveGraph would leave the route calling the real one against an unmocked index and
// silently attach no mtimes at all.
const derivedNodes = (): Array<{ id: string; mtime: number }> => [
  { id: `graph-at-${mtime}`, mtime: mtime + 5000 }
]

vi.mock('./graph-derive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./graph-derive')>()),
  deriveGraph: (): { nodes: unknown[]; edges: unknown[] } => ({
    nodes: derivedNodes(),
    edges: []
  }),
  deriveNodeMtimes: (): Map<string, number> =>
    new Map(derivedNodes().map((n) => [n.id, n.mtime]))
}))


interface Reply {
  status: number
  headers: Record<string, string>
  body: string
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** GET a route (default /state/brain-graph), capturing status AND headers. */
function getGraph(
  handler: Handler,
  headers: Record<string, string> = {},
  url = '/state/brain-graph'
): Promise<Reply> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage
    req.method = 'GET'
    req.url = url
    req.headers = headers

    let status = 0
    let sent: Record<string, string> = {}
    const res = {
      writeHead: (code: number, h?: Record<string, string>) => {
        status = code
        sent = h ?? {}
        return res
      },
      end: (chunk?: string) => {
        resolve({ status, headers: sent, body: String(chunk ?? '') })
        return res
      },
      setHeader: () => res,
      write: () => true
    } as unknown as ServerResponse

    handler(req, res)
  })
}

function postConfig(handler: Handler, payload: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage
    req.method = 'POST'
    req.url = '/state/config'
    req.headers = {}
    let status = 0
    let sent: Record<string, string> = {}
    const res = {
      writeHead: (code: number, headers?: Record<string, string>) => {
        status = code
        sent = headers ?? {}
        return res
      },
      end: (chunk?: string) => {
        resolve({ status, headers: sent, body: String(chunk ?? '') })
        return res
      },
      setHeader: () => res,
      write: () => true
    } as unknown as ServerResponse

    handler(req, res)
    setImmediate(() => {
      req.emit('data', JSON.stringify(payload))
      req.emit('end')
    })
  })
}

const etagFor = (key: string): string => `"${createHash('sha1').update(key).digest('hex')}"`
const keyFor = (m: number): string => `${VAULT}:${m}`

/** The cache is a module singleton, so each test gets a freshly-evaluated module. */
async function freshRoute(): Promise<Handler> {
  vi.resetModules()
  const server = await import('./server')
  server.setLocalBrainSettingsReader(() => ({ localBrainNotesDir: VAULT }))
  const routes = await import('./brain-native-routes')
  return routes.handleRequestNativeImpl
}

/** Let the scheduled (macrotask) rebuild land. */
const flushRebuild = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('/state/brain-graph conditional GET', () => {
  beforeEach(async () => {
    // Let any rebuild a previous test scheduled land against its own (now
    // discarded) module instance BEFORE the counters reset, so a stray timer
    // cannot be miscounted against this test.
    await flushRebuild()
    mtime = 1000
    builds = 0
  })

  it('tags the graph with an ETag and asks the client to revalidate', async () => {
    const handler = await freshRoute()
    const r = await getGraph(handler)

    expect(r.status).toBe(200)
    expect(r.headers.ETag).toBe(etagFor(keyFor(1000)))
    // no-cache is store-and-always-revalidate. Without it the freshness of a
    // validator-only response is left to Chromium's heuristic, and the
    // conditional request the 304 below depends on may never be sent.
    expect(r.headers['Cache-Control']).toBe('no-cache')
    expect(r.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(r.body).nodes).toEqual([{ id: 'graph-at-1000', mtime: 6000 }])
  })

  it('rejects vault-directory changes outside the native picker transaction', async () => {
    const handler = await freshRoute()
    const server = await import('./server')
    const writeSettings = vi.fn()
    server.setLocalBrainSettingsWriter(writeSettings)

    const r = await postConfig(handler, { dir: 'D:\\renderer-chosen-vault' })

    expect(r.status).toBe(409)
    expect(JSON.parse(r.body)).toMatchObject({ ok: false })
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it('answers an unchanged graph with 304 and no body', async () => {
    const handler = await freshRoute()
    const first = await getGraph(handler)

    const second = await getGraph(handler, { 'if-none-match': first.headers.ETag })
    expect(second.status).toBe(304)
    expect(second.body).toBe('')
    expect(second.headers.ETag).toBe(first.headers.ETag)
    // The 1.5MB payload is the whole point: it must not have been rebuilt or resent.
    expect(builds).toBe(1)
  })

  it('a stale serve tags the body it actually sent, not the one requested', async () => {
    // THE REGRESSION. The vault moves, so the request's key is now 1001 — but
    // the cache still holds the 1000 graph and serves it while rebuilding. The
    // ETag must describe the 1000 graph that is going out, because that is what
    // the client will store under it.
    const handler = await freshRoute()
    await getGraph(handler)
    expect(builds).toBe(1)

    mtime = 1001
    const stale = await getGraph(handler)

    expect(stale.status).toBe(200)
    expect(JSON.parse(stale.body).nodes).toEqual([{ id: 'graph-at-1000', mtime: 6000 }]) // the OLD graph
    expect(stale.headers.ETag).toBe(etagFor(keyFor(1000))) // ...tagged as the OLD graph
    expect(stale.headers.ETag).not.toBe(etagFor(keyFor(1001))) // NOT as the one asked for
  })

  it('a client holding the previous graph is not pinned to it once the rebuild lands', async () => {
    // The other half of the same bug. Under the broken wiring the client's
    // stored tag would already equal the new key's tag, so this request would
    // 304 forever and the operator would keep seeing a graph the server had
    // replaced.
    const handler = await freshRoute()
    const first = await getGraph(handler)

    mtime = 1001
    // Mid-rebuild: the client and the server agree on the old graph, so 304 is
    // correct here — it is holding exactly what is being served.
    const during = await getGraph(handler, { 'if-none-match': first.headers.ETag })
    expect(during.status).toBe(304)

    await flushRebuild()

    const after = await getGraph(handler, { 'if-none-match': first.headers.ETag })
    expect(after.status).toBe(200)
    expect(after.headers.ETag).toBe(etagFor(keyFor(1001)))
    expect(JSON.parse(after.body).nodes).toEqual([{ id: 'graph-at-1001', mtime: 6001 }])
  })

  it('never rebuilds on the request path once something is cached', async () => {
    // The all-day cost the SWR change exists to remove: the old 30s TTL made
    // every request after an idle gap pay a full rebuild inline.
    const handler = await freshRoute()
    await getGraph(handler)
    expect(builds).toBe(1)

    for (let i = 1; i <= 5; i++) {
      mtime = 1000 + i
      const r = await getGraph(handler)
      expect(r.status).toBe(200)
      // Served immediately from whatever was held — the rebuild is scheduled.
      expect(r.headers.ETag).toBe(etagFor(keyFor(1000 + i - 1)))
      await flushRebuild()
    }
  })
})

describe('/state/brain-graph/summary', () => {
  beforeEach(async () => {
    await flushRebuild()
    mtime = 1000
    builds = 0
  })

  it('serves counts, not the payload — and is not swallowed by the startsWith graph route', async () => {
    // ORDER IS THE CONTRACT UNDER TEST: the full route matches
    // startsWith('/state/brain-graph'), so if the summary branch ever moves
    // below it, this request silently comes back as the 1.5MB graph — the
    // exact cost the summary exists to remove — and only this assertion
    // notices (a number, not an array).
    const handler = await freshRoute()
    const r = await getGraph(handler, {}, '/state/brain-graph/summary')
    expect(r.status).toBe(200)
    const body = JSON.parse(r.body) as { nodes: unknown; links: unknown }
    expect(typeof body.nodes).toBe('number')
    expect(typeof body.links).toBe('number')
    expect(body.nodes).toBe(1)
    expect(r.body.length).toBeLessThan(200) // counts, never the graph
  })

  it('shares the graph cache: a summary after the graph fetch does not rebuild', async () => {
    const handler = await freshRoute()
    await getGraph(handler)
    expect(builds).toBe(1)
    const r = await getGraph(handler, {}, '/state/brain-graph/summary')
    expect(JSON.parse(r.body).nodes).toBe(1)
    expect(builds).toBe(1) // the memo answered; no second build, no payload parse cost
  })

  it('a summary-first request caches the canonical full graph with its recency metadata', async () => {
    const handler = await freshRoute()
    const summary = await getGraph(handler, {}, '/state/brain-graph/summary')
    expect(summary.status).toBe(200)
    expect(builds).toBe(1)

    const full = await getGraph(handler)
    const body = JSON.parse(full.body) as {
      nodes: Array<{ id: string; mtime?: number }>
    }
    expect(body.nodes).toEqual([{ id: 'graph-at-1000', mtime: 6000 }])
    expect(builds).toBe(1)
  })

  it('stale counts converge after the rebuild lands, same SWR contract as the graph', async () => {
    const handler = await freshRoute()
    await getGraph(handler, {}, '/state/brain-graph/summary')
    await flushRebuild()
    mtime = 1001
    const stale = await getGraph(handler, {}, '/state/brain-graph/summary')
    expect((JSON.parse(stale.body) as { stale: boolean }).stale).toBe(true)
    await flushRebuild()
    const fresh = await getGraph(handler, {}, '/state/brain-graph/summary')
    expect((JSON.parse(fresh.body) as { stale: boolean }).stale).toBe(false)
  })
})
