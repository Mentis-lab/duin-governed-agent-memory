import { describe, it, expect } from 'vitest'
import { channelState, type ChannelSummary } from './channel-types'

// `channelState` collapses four booleans into one value, and the reason it exists is the
// distinction the pane already refuses to blur: ENABLED is not RUNNING. A channel with no
// credentials never starts however hard the operator toggles it, and a badge reading "on"
// in that state is a lie discovered only when no message ever arrives.
//
// Making it a type rather than a sentence means the badge and the status line cannot
// disagree about it — they now read the same value instead of each deciding for itself.

const chan = (over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: 'x',
  label: 'X',
  configured: true,
  enabled: true,
  lastError: null,
  startedAt: null,
  ...over
})

describe('channelState', () => {
  it('off when disabled, regardless of how well configured it is', () => {
    expect(channelState(chan({ enabled: false, configured: true, startedAt: Date.now() }))).toBe('off')
    expect(channelState(chan({ enabled: false, configured: false }))).toBe('off')
  })

  // THE ONE THAT MATTERS. Enabled + unconfigured is the state that used to read as "on".
  // It is neither running nor broken — it is waiting for the operator, and it must say so.
  it('needs-setup when switched on with no credentials — never "live", never "failed"', () => {
    const s = channelState(chan({ enabled: true, configured: false }))
    expect(s).toBe('needs-setup')
    expect(s).not.toBe('live')
    expect(s).not.toBe('failed')
  })

  it('connecting when enabled and configured but not yet up', () => {
    expect(channelState(chan({ startedAt: null }))).toBe('connecting')
  })

  it('live only once it has actually started', () => {
    expect(channelState(chan({ startedAt: Date.now() }))).toBe('live')
  })

  it('failed when the last attempt errored', () => {
    expect(channelState(chan({ lastError: 'bad token' }))).toBe('failed')
  })

  // An error is about a connection that was attempted. Missing credentials mean none
  // was — so the unconfigured state wins, or the operator is sent to debug a token
  // they never entered.
  it('a stale error on an unconfigured channel still reads as needs-setup', () => {
    expect(channelState(chan({ enabled: true, configured: false, lastError: 'old failure' }))).toBe(
      'needs-setup'
    )
  })

  it('an error outranks a previous successful start', () => {
    expect(channelState(chan({ lastError: 'dropped', startedAt: Date.now() }))).toBe('failed')
  })
})
