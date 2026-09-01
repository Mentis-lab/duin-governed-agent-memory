import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchSpaces,
  fetchForecastRecord,
  fetchStreamVerdicts,
  fetchEventPrep,
  setAutoTrack,
  runAutoTrack,
  runProjection,
  nudgeStreams,
  resolveWiki,
  actFuture,
  readState,
  StateReadError
} from './state'

// U1 — the transport must not be able to express failure as a successful empty
// value. Every case below USED TO RESOLVE, handing the panel a value it then
// asserted out loud ("no decisions", "no spaces", "0 graduated"). They must now
// reject, so <PanelState> can render an error branch instead.

function respond(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      })
    )
  )
}

/** The brain is not listening at all — fetch rejects rather than returning a status. */
function refuseConnection(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('state.ts readers reject on a failed read', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['fetchSpaces', () => fetchSpaces()],
    ['fetchForecastRecord', () => fetchForecastRecord()],
    ['fetchStreamVerdicts', () => fetchStreamVerdicts()],
    ['fetchEventPrep', () => fetchEventPrep('evt-1')],
    ['runAutoTrack', () => runAutoTrack()],
    ['runProjection', () => runProjection()],
    ['nudgeStreams', () => nudgeStreams('x')],
    ['actFuture', () => actFuture('s-1', 'engage')]
  ]

  for (const [name, run] of cases) {
    it(`${name} rejects on HTTP 500 instead of resolving empty`, async () => {
      respond(500, { error: 'boom' })
      await expect(run()).rejects.toBeInstanceOf(StateReadError)
    })
  }

  it('setAutoTrack does NOT echo the requested value back on failure', async () => {
    // The worst instance: a failed write returned `on`, so the toggle moved and
    // reported the new state while the engine never heard the request.
    respond(500)
    await expect(setAutoTrack(true)).rejects.toBeInstanceOf(StateReadError)
  })

  it('setAutoTrack returns the ENGINE value on success, not the requested one', async () => {
    respond(200, { auto_track: false })
    await expect(setAutoTrack(true)).resolves.toBe(false)
  })
})

describe('404 keeps its meaning where absence is a real answer', () => {
  it('resolveWiki returns null for a genuinely missing note', async () => {
    respond(404)
    await expect(resolveWiki('Nope')).resolves.toBeNull()
  })

  it('resolveWiki rejects on 500 — "brain down" is not "note missing"', async () => {
    respond(500)
    await expect(resolveWiki('Nope')).rejects.toBeInstanceOf(StateReadError)
  })
})

describe('successful empty payloads stay successful', () => {
  it('an actually-empty spaces list still resolves to []', async () => {
    respond(200, { spaces: [] })
    await expect(fetchSpaces()).resolves.toEqual([])
  })
})

describe('readState — the Result face of the chokepoint', () => {
  it('a refused connection becomes ok:false, never a fallback value', async () => {
    refuseConnection()
    const r = await readState('spaces', (s) => fetchSpaces(s))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('spaces')
  })

  it('an HTTP failure becomes ok:false naming the route', async () => {
    respond(503)
    const r = await readState('forecast record', () => fetchForecastRecord())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/forecast-record failed \(HTTP 503\)/)
  })

  it('success passes the data through untouched', async () => {
    respond(200, { spaces: [{ name: 'Work', notes: 1, decisions: 0, people: 0, desc: '' }] })
    const r = await readState('spaces', (s) => fetchSpaces(s))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toHaveLength(1)
  })

  it('an aborted read is NOT reported as a failure', async () => {
    const ac = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      })
    )
    ac.abort()
    await expect(readState('spaces', (s) => fetchSpaces(s), ac.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})
