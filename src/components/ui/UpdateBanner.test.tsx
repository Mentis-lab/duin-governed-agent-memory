import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The renderer half of "the Restart button can silently no-op".
//
// The banner appears on `update-available` — which updater.ts fires BEFORE the ~100-300 MB artifact
// has downloaded — and its Restart button was `onClick={() => window.api.update.restart()}`: the
// IPC answer was discarded, so a refused install and an imminent restart were indistinguishable on
// screen. Nothing appeared, nothing spun, nothing errored. Clicking again did nothing again.
//
// Renderer render tests need jsdom, which this repo's node-only vitest env does not provide, so the
// click is factored into an exported helper and driven here — the same convention as
// LoopSettings.test.tsx / ChannelsSettings.test.tsx.
//
// ipc-client.ts reads `window.api` at MODULE LOAD, so the stub has to exist before the dynamic
// import below (see ipc-query.test.ts).

beforeEach(() => {
  vi.stubGlobal('window', { api: {} })
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function load(): Promise<typeof import('./UpdateBanner')> {
  return import('./UpdateBanner')
}

/** Collects what the banner would render under the Restart row. */
function noticeSink(): { calls: (string | null)[]; set: (m: string | null) => void } {
  const calls: (string | null)[] = []
  return { calls, set: (m) => calls.push(m) }
}

describe('Restart click — a refused install becomes something the operator can see', () => {
  it('surfaces the refusal reason the main process sent', async () => {
    const { attemptRestart } = await load()
    const sink = noticeSink()

    // What update:restart answers while quitAndInstall is still waiting on the download.
    await attemptRestart(
      async () => ({ success: false, error: 'The update is not ready to install yet.' }),
      sink.set
    )

    const shown = sink.calls[sink.calls.length - 1]
    expect(shown).toBeTruthy()
    expect(shown).toContain('not ready to install yet')
  })

  it('shows SOMETHING even when the refusal arrives with no reason attached', async () => {
    const { attemptRestart, RESTART_NOT_READY } = await load()
    const sink = noticeSink()

    await attemptRestart(async () => ({ success: false }), sink.set)

    expect(sink.calls[sink.calls.length - 1]).toBeTruthy()
    expect(RESTART_NOT_READY).not.toBe('')
  })

  // A dead main process is the other way the click can do nothing at all.
  it('treats a missing answer as a failure rather than as consent', async () => {
    const { attemptRestart } = await load()
    const sink = noticeSink()

    await attemptRestart(async () => undefined, sink.set)

    expect(sink.calls[sink.calls.length - 1]).toBeTruthy()
  })

  it('leaves no notice when the install is actually going ahead', async () => {
    const { attemptRestart } = await load()
    const sink = noticeSink()

    await attemptRestart(async () => ({ success: true, data: null }), sink.set)

    // Only the clear-on-click. The app is about to quit; a message would be noise.
    expect(sink.calls).toEqual([null])
  })

  it('clears the stale refusal before retrying, so a second click cannot show an old message', async () => {
    const { attemptRestart } = await load()
    const sink = noticeSink()

    await attemptRestart(async () => ({ success: false, error: 'still downloading' }), sink.set)
    sink.calls.length = 0
    await attemptRestart(async () => ({ success: true, data: null }), sink.set)

    expect(sink.calls).toEqual([null])
  })
})

// Release M11 — the updater is NOTIFY-ONLY until builds are signed. The banner's first action is
// Download (the operator's explicit step); Restart appears only once `update-downloaded` fires.
describe('notify-only banner — Download before Restart', () => {
  it('offers Download on an available update and Restart only once it is downloaded', async () => {
    const { bannerAction } = await load()
    expect(bannerAction('available')).toBe('download')
    expect(bannerAction('downloading')).toBe('downloading')
    expect(bannerAction('downloaded')).toBe('restart')
  })

  it('a refused download is shown, and the banner falls back to offering Download again', async () => {
    const { attemptDownload } = await load()
    const sink = noticeSink()
    const next = await attemptDownload(
      async () => ({ success: false, error: 'No verified update has been offered in this session.' }),
      sink.set
    )
    expect(next).toBe('available')
    expect(sink.calls[sink.calls.length - 1]).toContain('No verified update')
  })

  it('an accepted download moves the banner to the downloading state with no notice', async () => {
    const { attemptDownload } = await load()
    const sink = noticeSink()
    const next = await attemptDownload(async () => ({ success: true, data: null }), sink.set)
    expect(next).toBe('downloading')
    expect(sink.calls).toEqual([null])
  })

  it('treats a missing handler or answer as a failure, never as a download in flight', async () => {
    const { attemptDownload, DOWNLOAD_FAILED } = await load()
    const sink = noticeSink()
    expect(await attemptDownload(undefined, sink.set)).toBe('available')
    expect(await attemptDownload(async () => undefined, sink.set)).toBe('available')
    expect(sink.calls.filter(Boolean).length).toBe(2)
    expect(DOWNLOAD_FAILED).not.toBe('')
  })
})
