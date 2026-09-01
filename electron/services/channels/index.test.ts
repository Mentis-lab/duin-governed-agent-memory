import { describe, it, expect } from 'vitest'
import { makeChannelRegistry, listChannels, getChannel } from './index'
import type { ChannelAdapter } from './channel-adapter'

const fakeChannel = (id: string): ChannelAdapter => ({
  id,
  label: id.toUpperCase(),
  isConfigured: () => false,
  start: async () => {},
  stop: async () => {},
  send: async () => {},
  authorizeUser: async () => 'denied'
})

describe('makeChannelRegistry', () => {
  it('lists its adapters and looks them up by id', () => {
    const a = fakeChannel('telegram')
    const b = fakeChannel('sms')
    const reg = makeChannelRegistry([a, b])
    expect(reg.list()).toEqual([a, b])
    expect(reg.get('telegram')).toBe(a)
    expect(reg.get('sms')).toBe(b)
    expect(reg.get('nope')).toBeUndefined()
  })

  it('an empty registry looks up to undefined without throwing', () => {
    const reg = makeChannelRegistry([])
    expect(reg.list()).toEqual([])
    expect(reg.get('x')).toBeUndefined()
  })
})

describe('default channel registry (index.ts)', () => {
  it('exposes an array with unique ids and consistent get()', () => {
    const all = listChannels()
    expect(Array.isArray(all)).toBe(true)
    const ids = all.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length) // no duplicate channel ids
    for (const c of all) expect(getChannel(c.id)).toBe(c)
    expect(getChannel('definitely-not-a-channel')).toBeUndefined()
  })
})
