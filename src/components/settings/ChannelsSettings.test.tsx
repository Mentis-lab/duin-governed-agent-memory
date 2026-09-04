import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'

// The pane reads through query() and writes through invoke(), and ipc-client reads
// `window.api` at module scope. This env is node-only (no jsdom), so the import alone
// would throw before a single assertion runs. Only the pure helpers below are under test
// (same guard as PermissionsSettings.test.tsx).
vi.mock('@/lib/ipc-client', () => ({ query: vi.fn(), invoke: vi.fn() }))

import {
  channelStatusLine,
  showsPairingControls,
  hidesLegacyChannel,
  orderChannelsForDisplay,
  setupGuideOpenByDefault,
  type ChannelSummary
} from './ChannelsSettings'

// The Channels pane. Renderer render tests need jsdom, which this repo's node-only
// vitest env does not provide, so the pane's behaviour is factored into pure
// exported helpers and unit-tested here — the same convention as
// LoopSettings.test.tsx / FoundationsSettings.test.tsx.
//
// What this pane exists for: setChannelEnabled + restartChannel were written and
// had zero callers, so the only enable path was hand-editing
// userData/channels.json — a file that does not exist on a default install.
//
// The load-bearing assertion in here is the ENABLED-vs-RUNNING distinction. A
// channel with no credentials never starts however hard the operator toggles it,
// and a status line that reads "on" in that state is a lie the operator only
// discovers when no message ever arrives.

// Pinned so a translated dictionary cannot silently move an assertion.
beforeEach(() => setUiLanguage('en'))

const chan = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: 'telegram',
  label: 'Telegram',
  configured: true,
  enabled: false,
  lastError: null,
  startedAt: null,
  ...over
})

describe('channel status line — enabled is not the same as running', () => {
  it('says off, and that credentials are ready, when it is merely not switched on', () => {
    const line = channelStatusLine(chan({ enabled: false, configured: true }))
    expect(line).toMatch(/^Off/)
    expect(line).toMatch(/Credentials are in place/i)
  })

  it('warns, while still off, that turning it on will not connect it without credentials', () => {
    const line = channelStatusLine(chan({ enabled: false, configured: false }))
    expect(line).toMatch(/^Off/)
    expect(line).toMatch(/will not connect/i)
  })

  // The one an operator would otherwise mis-read: the switch is on, and nothing
  // is listening.
  it('does not claim a credential-less channel is connected just because it is enabled', () => {
    const line = channelStatusLine(chan({ enabled: true, configured: false }))
    expect(line).toMatch(/waiting for credentials/i)
    expect(line).not.toMatch(/Connected since/)
  })

  it('surfaces the adapter start failure rather than a generic "on"', () => {
    const line = channelStatusLine(
      chan({ enabled: true, configured: true, lastError: 'ECONNREFUSED' })
    )
    expect(line).toContain('ECONNREFUSED')
  })

  it('reports the connection time once the gateway records a start', () => {
    const started = Date.UTC(2026, 7, 3, 12, 0, 0)
    const line = channelStatusLine(chan({ enabled: true, configured: true, startedAt: started }))
    expect(line).toMatch(/^Connected since /)
    expect(line).toContain(new Date(started).toLocaleString())
  })

  // enabled + configured + no startedAt + no error is the window between the
  // toggle and the gateway's recordChannelStarted. Saying "connecting" beats
  // saying "connected" and beats saying nothing.
  it('says connecting in the gap between the toggle and the adapter coming up', () => {
    expect(channelStatusLine(chan({ enabled: true, configured: true }))).toMatch(/connecting/i)
  })
})

describe('pairing controls — the second gate, shown only when there is something to pair with', () => {
  it('shows for a channel that can actually receive a message', () => {
    expect(showsPairingControls(chan({ enabled: true, configured: true }))).toBe(true)
  })

  it('stays hidden while the channel is off', () => {
    expect(showsPairingControls(chan({ enabled: false, configured: true }))).toBe(false)
  })

  it('stays hidden while the channel cannot connect', () => {
    expect(showsPairingControls(chan({ enabled: true, configured: false }))).toBe(false)
  })
})

// The lark-cli Feishu adapter is tagged in its own definition as being replaced by the
// app-credential version. Main keeps it registered (a live bridge depends on it); the
// pane's job is to stop presenting it as a peer of the current channels.
describe('the legacy lark-cli Feishu row — last, and gone once it is retired', () => {
  it('sinks the legacy channel below every current one without reordering the rest', () => {
    const rows = [
      chan({ id: 'feishu', label: 'Feishu / Lark (via lark-cli)', enabled: true, configured: true }),
      chan({ id: 'telegram' }),
      chan({ id: 'feishu-app', label: 'Feishu / Lark (app)' })
    ]
    expect(orderChannelsForDisplay(rows).map((c) => c.id)).toEqual(['telegram', 'feishu-app', 'feishu'])
  })

  it('hides it entirely when it is off and has nothing configured', () => {
    const retired = chan({ id: 'feishu', enabled: false, configured: false })
    expect(hidesLegacyChannel(retired)).toBe(true)
    expect(orderChannelsForDisplay([retired, chan({ id: 'telegram' })]).map((c) => c.id)).toEqual(['telegram'])
  })

  it('keeps it while it is on, or still holds credentials', () => {
    expect(hidesLegacyChannel(chan({ id: 'feishu', enabled: true, configured: false }))).toBe(false)
    expect(hidesLegacyChannel(chan({ id: 'feishu', enabled: false, configured: true }))).toBe(false)
  })

  it('never hides a current channel, whatever its state', () => {
    expect(hidesLegacyChannel(chan({ id: 'telegram', enabled: false, configured: false }))).toBe(false)
    expect(hidesLegacyChannel(chan({ id: 'feishu-app', enabled: false, configured: false }))).toBe(false)
  })
})

// Eight always-expanded guides made the page four screens tall. A guide is now a closed
// disclosure except in the one state where the operator needs it without asking.
describe('setup guide — open only when the operator owes the channel something', () => {
  it('opens for a channel that is on but not yet configured', () => {
    expect(setupGuideOpenByDefault(chan({ enabled: true, configured: false }))).toBe(true)
  })

  it('stays closed while off, and once configured', () => {
    expect(setupGuideOpenByDefault(chan({ enabled: false, configured: false }))).toBe(false)
    expect(setupGuideOpenByDefault(chan({ enabled: false, configured: true }))).toBe(false)
    expect(setupGuideOpenByDefault(chan({ enabled: true, configured: true }))).toBe(false)
  })
})
