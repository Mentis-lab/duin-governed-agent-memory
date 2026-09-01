import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/lamprey-test', isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false, macOS: false, windows: true, linux: false } }))
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  mapVerdictToCorrection,
  forwardCorrection,
  drainLearnBridge,
  backfillFromFacts,
  readLearnLedger,
  learnBridgeStatus,
  __setLearnBridgeLedgerDir,
  __setLearnBridgeOrigin,
  __setLearnBridgeFetch
} from './learn-bridge'

// Minimal OperatorFact shape for the tests.
const fact = (id: string, status: string, text = `fact ${id}`) =>
  ({ id, fact: text, kind: 'context', status, ts: 0 }) as never

let dir: string

function okFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, total: 1 }), { status: 200 })
  ) as unknown as typeof fetch
}
function rejectFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 400 })
  ) as unknown as typeof fetch
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'learn-bridge-test-'))
  __setLearnBridgeLedgerDir(dir)
  __setLearnBridgeOrigin(() => 'http://127.0.0.1:8765')
  __setLearnBridgeFetch(okFetch())
})
afterEach(() => {
  __setLearnBridgeLedgerDir(null)
  __setLearnBridgeOrigin(null)
  __setLearnBridgeFetch(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('mapVerdictToCorrection (pure)', () => {
  it('promote → positive row with candidate_rule, no source key', () => {
    const row = mapVerdictToCorrection({ fact: 'Prefers concise answers', kind: 'preference' }, 'promote', '2026-06-29')
    expect(row.polarity).toBe('positive')
    expect(row.candidate_rule).toBe('Prefers concise answers')
    expect(row.ts).toBe('2026-06-29')
    expect(row.skill).toBe('operator-model')
    expect('source' in row).toBe(false) // operator-only contract
  })
  it('veto → correction row naming the rejected inference', () => {
    const row = mapVerdictToCorrection({ fact: 'Lives in Tokyo', kind: 'context' }, 'veto', '2026-06-29')
    expect(row.polarity).toBe('correction')
    expect(row.correction).toContain('Lives in Tokyo')
    expect(row.candidate_rule).toBe('')
    expect('source' in row).toBe(false)
  })

  // #1 learn-loop: a real human reason must flow into `why` (the reasoning that
  // models judgment). The invariant is that `why` is the genuine reason or EMPTY —
  // never a fixed/boilerplate phrase (which would pollute reflect()'s clustering).
  it('forwards a human reason into `why` on promote', () => {
    const row = mapVerdictToCorrection(
      { fact: 'Ship on Fridays', kind: 'preference' },
      'promote',
      '2026-06-29',
      'confirmed after the release retro — Friday ships gave us the weekend buffer'
    )
    expect(row.why).toBe('confirmed after the release retro — Friday ships gave us the weekend buffer')
    expect(row.candidate_rule).toBe('Ship on Fridays')
  })
  it('forwards a human reason into `why` on veto', () => {
    const row = mapVerdictToCorrection(
      { fact: 'Lives in Tokyo', kind: 'context' },
      'veto',
      '2026-06-29',
      'stale — relocated to Shanghai in May'
    )
    expect(row.why).toBe('stale — relocated to Shanghai in May')
    expect(row.correction).toContain('Lives in Tokyo')
  })
  it('leaves `why` EMPTY (never boilerplate) when no reason is given', () => {
    expect(mapVerdictToCorrection({ fact: 'X', kind: 'preference' }, 'promote', '2026-06-29').why).toBe('')
    // whitespace-only reason trims to empty — no fixed phrase enters the cluster stream
    expect(mapVerdictToCorrection({ fact: 'X', kind: 'preference' }, 'promote', '2026-06-29', '   ').why).toBe('')
  })
})

describe('forwardCorrection', () => {
  it('delivers when the engine is up and records the row', async () => {
    const state = await forwardCorrection(fact('a', 'promoted'), 'promote')
    expect(state).toBe('delivered')
    const led = readLearnLedger()
    expect(led.get('a:promote')?.delivery).toBe('delivered')
  })

  it('is idempotent — a delivered verdict never re-POSTs', async () => {
    const f = okFetch()
    __setLearnBridgeFetch(f)
    await forwardCorrection(fact('a', 'promoted'), 'promote')
    await forwardCorrection(fact('a', 'promoted'), 'promote')
    // one /learn/correction POST (the reflect debounce never fires synchronously)
    const correctionPosts = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => String(c[0]).endsWith('/learn/correction')
    )
    expect(correctionPosts.length).toBe(1)
  })

  it('stages as pending (keyless) when the engine is down', async () => {
    __setLearnBridgeOrigin(() => '')
    const state = await forwardCorrection(fact('b', 'vetoed'), 'veto')
    expect(state).toBe('pending')
    expect(readLearnLedger().get('b:veto')?.delivery).toBe('pending')
  })

  it('marks failed on engine rejection', async () => {
    __setLearnBridgeFetch(rejectFetch())
    const state = await forwardCorrection(fact('c', 'promoted'), 'promote')
    expect(state).toBe('failed')
  })
})

describe('drainLearnBridge', () => {
  it('retries a pending row once the engine is up', async () => {
    __setLearnBridgeOrigin(() => '')
    await forwardCorrection(fact('d', 'vetoed'), 'veto')
    expect(readLearnLedger().get('d:veto')?.delivery).toBe('pending')

    __setLearnBridgeOrigin(() => 'http://127.0.0.1:8765')
    const summary = await drainLearnBridge()
    expect(summary.delivered).toBe(1)
    expect(readLearnLedger().get('d:veto')?.delivery).toBe('delivered')
  })

  it('no-op when engine down, reports stillPending', async () => {
    __setLearnBridgeOrigin(() => '')
    await forwardCorrection(fact('e', 'promoted'), 'promote')
    const summary = await drainLearnBridge()
    expect(summary.engineConnected).toBe(false)
    expect(summary.stillPending).toBe(1)
    expect(summary.retried).toBe(0)
  })
})

describe('backfillFromFacts', () => {
  it('forwards only promoted+vetoed, writes a marker, and is idempotent', async () => {
    const facts = [
      fact('p1', 'promoted'),
      fact('v1', 'vetoed'),
      fact('c1', 'candidate') // ignored
    ]
    const n = await backfillFromFacts(facts)
    expect(n).toBe(2)
    expect(existsSync(join(dir, 'backfilled.json'))).toBe(true)
    const led = readLearnLedger()
    expect(led.get('p1:promote')?.delivery).toBe('delivered')
    expect(led.get('v1:veto')?.delivery).toBe('delivered')
    expect(led.has('c1:promote')).toBe(false)

    // second call is a no-op (marker guard)
    const again = await backfillFromFacts(facts)
    expect(again).toBe(0)
  })
})

describe('learnBridgeStatus', () => {
  it('counts by delivery state', async () => {
    await forwardCorrection(fact('a', 'promoted'), 'promote')
    __setLearnBridgeOrigin(() => '')
    await forwardCorrection(fact('b', 'vetoed'), 'veto')
    const st = learnBridgeStatus()
    expect(st.total).toBe(2)
    expect(st.byDelivery.delivered).toBe(1)
    expect(st.byDelivery.pending).toBe(1)
  })
})
