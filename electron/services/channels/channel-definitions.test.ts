import { describe, it, expect } from 'vitest'
import {
  CHANNEL_DEFINITIONS,
  defineChannel,
  getChannelDefinition,
  ingressNeedsPublicUrl
} from './channel-definitions'
import { channelCapabilities, type ChannelAdapter } from './channel-adapter'
import { listChannels } from './index'

// P0 of the channels rebuild: capabilities and definitions, and specifically the two
// places where a surface could assert something the code does not do.
//
// The pane's whole job is telling the operator what a channel is and what it will do.
// Every test here is about that claim being TRUE — a declaration without an
// implementation, or a "no setup needed" on a channel that needs a tunnel, is worse
// than no information, because the operator acts on it.

const stub = (over: Partial<ChannelAdapter> = {}): ChannelAdapter => ({
  id: 'x',
  label: 'X',
  isConfigured: () => true,
  start: async () => {},
  stop: async () => {},
  send: async () => {},
  authorizeUser: async () => 'approved',
  ...over
})

describe('channelCapabilities — claimed AND implemented, never claimed alone', () => {
  it('reports nothing for an adapter that declares nothing (the three that predate this)', () => {
    expect(channelCapabilities(stub())).toEqual([])
  })

  // The defect this exists to prevent: a pane rendering a target picker it cannot
  // populate, which the operator reads as "I have no conversations" rather than "this
  // was never wired".
  it('DROPS a capability that is declared but not implemented', () => {
    const lying = stub({ capabilities: () => ['directory', 'typing', 'reactions'] })
    expect(channelCapabilities(lying)).toEqual([])
  })

  it('keeps a capability that is both declared and implemented', () => {
    const honest = stub({
      capabilities: () => ['directory'],
      listTargets: async () => []
    })
    expect(channelCapabilities(honest)).toEqual(['directory'])
  })

  it('drops the unimplemented half of a mixed claim', () => {
    const partial = stub({
      capabilities: () => ['directory', 'typing'],
      listTargets: async () => []
    })
    expect(channelCapabilities(partial)).toEqual(['directory'])
  })

  // 'files' is the exception: sendFile IS the implementation, so its presence is the
  // claim. Requiring a separate declaration would let an adapter ship a working
  // sendFile that the UI never surfaces.
  // WAS: "infers 'files' from sendFile without needing a declaration".
  //
  // That inference was correct while every adapter was hand-written — the method WAS the
  // implementation. It became false the moment `adapterFromTransport` started defining
  // `sendFile` unconditionally: it falls back to plain send() for a transport that cannot
  // upload, which is the right DELIVERY behaviour and a worthless capability signal.
  //
  // Measured on the first deploy of the five Tier-A channels: Slack, WeCom, DingTalk and
  // Email all advertised file uploads, and not one of their transports implements
  // sendFile. Each transport had been scrupulous — WeCom's own comment says a fallback
  // "drops the file honestly instead of reporting an upload that never happened" — and
  // the derivation was overruling them.
  it("does NOT infer 'files' from a sendFile that may only be a text fallback", () => {
    expect(channelCapabilities(stub({ sendFile: async () => {} }))).toEqual([])
  })

  it("keeps 'files' when it is both declared and implemented", () => {
    const honest = stub({ capabilities: () => ['files'], sendFile: async () => {} })
    expect(channelCapabilities(honest)).toEqual(['files'])
  })

  it("drops a declared 'files' when there is no sendFile at all", () => {
    expect(channelCapabilities(stub({ capabilities: () => ['files'] }))).toEqual([])
  })

  it('threads and edit are claim-only — they have no method to check', () => {
    expect(channelCapabilities(stub({ capabilities: () => ['threads'] }))).toEqual(['threads'])
  })
})

describe('needsPublicUrl is derived, never typed by hand', () => {
  // The operator most needs this BEFORE choosing a channel. A hand-set boolean that
  // contradicted its own ingress would be a lie the pane renders faithfully.
  it('only a webhook ingress needs a public endpoint', () => {
    expect(ingressNeedsPublicUrl('webhook')).toBe(true)
    expect(ingressNeedsPublicUrl('websocket')).toBe(false)
    expect(ingressNeedsPublicUrl('poll')).toBe(false)
    expect(ingressNeedsPublicUrl('local')).toBe(false)
  })

  it('defineChannel derives it, so it cannot disagree with ingress', () => {
    const d = defineChannel({
      id: 't',
      label: 'T',
      description: '',
      region: 'global',
      authMode: 'credentials',
      ingress: 'webhook',
      capabilities: [],
      credentials: [],
      setupSteps: [],
      status: 'planned'
    })
    expect(d.needsPublicUrl).toBe(true)
  })

  it('every shipped definition agrees with its own ingress', () => {
    for (const d of CHANNEL_DEFINITIONS) {
      expect(d.needsPublicUrl, d.id).toBe(ingressNeedsPublicUrl(d.ingress))
    }
  })
})

describe('definitions and adapters must not drift apart', () => {
  // A definition without an adapter would render as connectable, accept a token, and
  // then do nothing — the "engine built, never connected" failure, this time visible to
  // the operator. A definition marked `planned` is the honest way to list one.
  it('every AVAILABLE definition has a registered adapter', () => {
    const adapterIds = new Set(listChannels().map((a) => a.id))
    for (const d of CHANNEL_DEFINITIONS.filter((x) => x.status === 'available')) {
      expect(adapterIds.has(d.id), `definition '${d.id}' has no adapter`).toBe(true)
    }
  })

  it('every registered adapter has a definition, or the pane cannot describe it', () => {
    const defIds = new Set(CHANNEL_DEFINITIONS.map((d) => d.id))
    for (const a of listChannels()) {
      expect(defIds.has(a.id), `adapter '${a.id}' has no definition`).toBe(true)
    }
  })

  it('ids are unique', () => {
    const ids = CHANNEL_DEFINITIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a credential-auth channel actually declares credentials to collect', () => {
    // Otherwise the pane shows an empty form and the operator has no way to connect —
    // the exact split that made isConfigured() report "waiting for credentials" while
    // offering nowhere to put one.
    for (const d of CHANNEL_DEFINITIONS.filter((x) => x.authMode === 'credentials')) {
      expect(d.credentials.length, d.id).toBeGreaterThan(0)
    }
  })

  it('every definition tells the operator how to set it up', () => {
    for (const d of CHANNEL_DEFINITIONS) {
      expect(d.setupSteps.length, d.id).toBeGreaterThan(0)
      expect(d.description.length, d.id).toBeGreaterThan(0)
    }
  })
})

describe('getChannelDefinition', () => {
  it('finds a known channel and returns undefined for an unknown one', () => {
    expect(getChannelDefinition('telegram')?.label).toBe('Telegram')
    expect(getChannelDefinition('nope')).toBeUndefined()
  })
})
