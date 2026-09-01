import { describe, it, expect } from 'vitest'
import { channelStatusLine, showsPairingControls, type ChannelSummary } from './ChannelsSettings'

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
