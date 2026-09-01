import { describe, it, expect, beforeEach } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'
import { ingressLabel } from './ChannelSetupSteps'
import type { ChannelIngress } from './channel-types'

// Node-only vitest env, no jsdom — the setup block's judgement is a pure helper and is
// tested here rather than by rendering (ChannelsSettings.test.tsx set the convention).

beforeEach(() => setUiLanguage('en'))

// `satisfies` makes ADDING a member to ChannelIngress a compile error right here, so a
// new transport cannot ship without an answer to the public-URL question.
const ALL_INGRESS = Object.keys({
  websocket: 0,
  poll: 0,
  webhook: 0,
  local: 0
} satisfies Record<ChannelIngress, number>) as ChannelIngress[]

describe('ingressLabel — covers the union in plain words', () => {
  it('labels every member', () => {
    for (const i of ALL_INGRESS) expect(ingressLabel(i).trim(), i).not.toBe('')
  })

  it('keeps every label distinct', () => {
    expect(new Set(ALL_INGRESS.map(ingressLabel)).size).toBe(ALL_INGRESS.length)
  })

  it('drops the transport jargon', () => {
    // 'websocket' and 'webhook' are implementation words. An operator deciding whether
    // they can run this channel from a laptop does not need either of them, and telling
    // them apart by name is exactly the confusion the copy has to remove.
    for (const i of ALL_INGRESS) expect(ingressLabel(i), i).not.toMatch(/websocket|webhook/i)
  })
})

describe('the question every ingress label has to answer: do I need a public URL?', () => {
  it('says no for the two transports that dial outward', () => {
    expect(ingressLabel('websocket')).toMatch(/no public URL needed/i)
    expect(ingressLabel('poll')).toMatch(/no public URL needed/i)
  })

  it('distinguishes dialling out from asking repeatedly', () => {
    // Both need no public URL, but they behave differently enough on a flaky network
    // that collapsing them into one string would be a lie of omission.
    expect(ingressLabel('websocket')).not.toBe(ingressLabel('poll'))
    expect(ingressLabel('poll')).toMatch(/poll/i)
  })

  it('makes webhook the only one demanding a public HTTPS endpoint', () => {
    expect(ingressLabel('webhook')).toMatch(/public HTTPS endpoint/i)
    for (const i of ALL_INGRESS.filter((x) => x !== 'webhook')) {
      expect(ingressLabel(i), i).not.toMatch(/public HTTPS/i)
    }
  })

  it('says local reads a local source rather than talking to a network at all', () => {
    expect(ingressLabel('local')).toMatch(/local/i)
    expect(ingressLabel('local')).not.toMatch(/URL|HTTPS/i)
  })
})
