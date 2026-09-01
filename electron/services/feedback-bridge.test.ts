import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import {
  routeFor,
  drainFeedbackBridge,
  feedbackBridgeStatus,
  readLedger,
  type BridgeDeps
} from './feedback-bridge'

// The bridge reads events through an injected listEvents and forwards through an
// injected engineOrigin, so these tests need neither SQLite nor Electron. The
// HTTP path is exercised against a REAL throwaway server (not a mocked fetch) so
// we prove the actual POST shape the engine's /state/* handlers parse.

interface FakeEvent {
  id: string
  createdAt: number
  payload: Record<string, unknown>
}

function ev(id: string, createdAt: number, payload: Record<string, unknown>): FakeEvent {
  return { id, createdAt, payload }
}

/** A listEvents stand-in over a fixed array, honoring sinceMs + asc order. */
function fakeListEvents(all: FakeEvent[]): BridgeDeps['listEvents'] {
  return ((filter: any = {}) => {
    let rows = all.slice()
    if (typeof filter.sinceMs === 'number') rows = rows.filter((r) => r.createdAt >= filter.sinceMs)
    rows.sort((a, b) =>
      filter.order === 'asc' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt
    )
    return rows as any
  }) as BridgeDeps['listEvents']
}

let DIR = ''
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'fb-bridge-'))
})
afterEach(() => {
  try {
    rmSync(DIR, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// A real engine stub: records every POST (path + parsed body), answers {ok:true}.
async function withEngine(
  fn: (origin: string, received: Array<{ path: string; body: any }>) => Promise<void>,
  responder?: (path: string, body: any) => { status: number; json: unknown }
): Promise<void> {
  const received: Array<{ path: string; body: any }> = []
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: any = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        /* leave {} */
      }
      received.push({ path: req.url || '', body })
      const r = responder ? responder(req.url || '', body) : { status: 200, json: { ok: true } }
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(r.json))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  try {
    await fn(`http://127.0.0.1:${port}`, received)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('routeFor — the translation table', () => {
  it('maps insight verdicts to /state/insight-verdict', () => {
    const r = (a: any) => routeFor(a, { kind: 'insight', id: 'i1' })
    expect(r('act')).toEqual({ endpoint: '/state/insight-verdict', body: { id: 'i1', verdict: 'acted' } })
    expect(r('dismiss')).toEqual({ endpoint: '/state/insight-verdict', body: { id: 'i1', verdict: 'dismissed' } })
    expect(r('not-relevant')).toEqual({ endpoint: '/state/insight-verdict', body: { id: 'i1', verdict: 'inaccurate' } })
  })

  it('maps prediction act/not-relevant to /state/prediction-feedback, stages dismiss', () => {
    const r = (a: any) => routeFor(a, { kind: 'prediction', id: 'p1', domain: 'ops' })
    expect(r('act')).toEqual({ endpoint: '/state/prediction-feedback', body: { id: 'p1', domain: 'ops', mark: 'correct' } })
    expect(r('not-relevant')).toEqual({ endpoint: '/state/prediction-feedback', body: { id: 'p1', domain: 'ops', mark: 'false_alarm' } })
    expect(r('dismiss')).toBeNull()
  })

  it('never forwards forecast / cascade / snooze', () => {
    expect(routeFor('act', { kind: 'forecast', id: 'f1' })).toBeNull()
    expect(routeFor('not-relevant', { kind: 'forecast', id: 'f1' })).toBeNull()
    expect(routeFor('act', { kind: 'cascade', id: 'c1' })).toBeNull()
    expect(routeFor('snooze', { kind: 'insight', id: 'i1' })).toBeNull()
  })
})

describe('drainFeedbackBridge', () => {
  const base = (over: Partial<BridgeDeps>): Partial<BridgeDeps> => ({
    now: () => 1000,
    ledgerDir: DIR,
    engineOrigin: () => '',
    ...over
  })

  it('stages a no-engineRef seed locally (never forwarded) and advances the cursor', async () => {
    const events = [ev('e1', 100, { action: 'dismiss', detectorClass: 'nudge', seedType: 'correction-seed' })]
    const s = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    expect(s.newlyConsumed).toBe(1)
    expect(s.staged).toBe(1)
    expect(s.delivered).toBe(0)
    expect(s.cursorAt).toBe(100)
    const ledger = readLedger(DIR)
    expect(ledger.get('e1')?.delivery).toBe('staged')
  })

  it('marks a mappable seed pending when the engine is offline', async () => {
    const events = [ev('e1', 100, { action: 'act', detectorClass: 'insight', engineRef: { kind: 'insight', id: 'i1' } })]
    const s = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    expect(s.pending).toBe(1)
    expect(readLedger(DIR).get('e1')?.delivery).toBe('pending')
  })

  it('forwards a mappable seed to a real engine and marks it delivered', async () => {
    await withEngine(async (origin, received) => {
      const events = [ev('e1', 100, { action: 'not-relevant', detectorClass: 'risk', engineRef: { kind: 'prediction', id: 'p1', domain: 'ops' } })]
      const s = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events), engineOrigin: () => origin }))
      expect(s.delivered).toBe(1)
      expect(received).toEqual([
        { path: '/state/prediction-feedback', body: { id: 'p1', domain: 'ops', mark: 'false_alarm' } }
      ])
      expect(readLedger(DIR).get('e1')?.delivery).toBe('delivered')
    })
  })

  it('retries a pending seed once the engine comes up — no double-consume', async () => {
    const events = [ev('e1', 100, { action: 'act', detectorClass: 'insight', engineRef: { kind: 'insight', id: 'i1' } })]
    // First drain: offline → pending.
    const off = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    expect(off.pending).toBe(1)
    // Second drain: engine up → the SAME event is not re-consumed, but the
    // pending row is retried and delivered.
    await withEngine(async (origin, received) => {
      const on = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events), engineOrigin: () => origin }))
      expect(on.newlyConsumed).toBe(0)
      expect(on.retried).toBe(1)
      expect(on.delivered).toBe(1)
      expect(received).toEqual([
        { path: '/state/insight-verdict', body: { id: 'i1', verdict: 'acted' } }
      ])
      expect(readLedger(DIR).get('e1')?.delivery).toBe('delivered')
    })
  })

  it('is idempotent: a second drain over the same events consumes nothing new', async () => {
    const events = [ev('e1', 100, { action: 'dismiss', detectorClass: 'nudge' })]
    await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    const again = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    expect(again.newlyConsumed).toBe(0)
  })

  it('stages a forecast verdict even when the engine is up (resolution loop owns hit/miss)', async () => {
    await withEngine(async (origin, received) => {
      const events = [ev('e1', 100, { action: 'act', detectorClass: 'forecast', engineRef: { kind: 'forecast', id: 'f1' } })]
      const s = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events), engineOrigin: () => origin }))
      expect(s.staged).toBe(1)
      expect(s.delivered).toBe(0)
      expect(received).toEqual([]) // nothing POSTed
    })
  })

  it('marks delivery failed when the engine rejects, and status reflects it', async () => {
    await withEngine(
      async (origin) => {
        const events = [ev('e1', 100, { action: 'act', detectorClass: 'insight', engineRef: { kind: 'insight', id: 'missing' } })]
        const s = await drainFeedbackBridge(base({ listEvents: fakeListEvents(events), engineOrigin: () => origin }))
        expect(s.failed).toBe(1)
        const st = feedbackBridgeStatus(base({ engineOrigin: () => origin }) as Partial<BridgeDeps>)
        expect(st.byDelivery.failed).toBe(1)
        expect(st.total).toBe(1)
      },
      () => ({ status: 400, json: { ok: false, error: 'not found' } })
    )
  })

  it('writes the ledger file as JSONL on disk', async () => {
    const events = [ev('e1', 100, { action: 'snooze', detectorClass: 'nudge' })]
    await drainFeedbackBridge(base({ listEvents: fakeListEvents(events) }))
    const p = join(DIR, 'consumed-seeds.jsonl')
    expect(existsSync(p)).toBe(true)
    const lines = readFileSync(p, 'utf-8').trim().split('\n')
    expect(JSON.parse(lines[0]).eventId).toBe('e1')
  })
})
