import { describe, it, expect, beforeEach } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'
import { capabilityLabel } from './ChannelCapabilities'
import type { ChannelCapability } from './channel-types'

// Node-only vitest env, no jsdom — the chip row's judgement is a pure helper and is
// tested here rather than by rendering (ChannelsSettings.test.tsx set the convention).

beforeEach(() => setUiLanguage('en'))

// `satisfies` makes ADDING a member to ChannelCapability a compile error right here, so
// a new capability cannot ship as an unlabelled chip.
const ALL_CAPS = Object.keys({
  threads: 0,
  reactions: 0,
  typing: 0,
  files: 0,
  directory: 0,
  edit: 0
} satisfies Record<ChannelCapability, number>) as ChannelCapability[]

describe('capabilityLabel — covers the union', () => {
  it('labels every member', () => {
    expect(ALL_CAPS).toHaveLength(6)
    for (const c of ALL_CAPS) expect(capabilityLabel(c).trim(), c).not.toBe('')
  })

  it('never leaks the raw wire id into a chip', () => {
    for (const c of ALL_CAPS) expect(capabilityLabel(c), c).not.toBe(c)
  })

  it('keeps every label distinct', () => {
    expect(new Set(ALL_CAPS.map(capabilityLabel)).size).toBe(ALL_CAPS.length)
  })

  it('maps each id to its human words', () => {
    expect(capabilityLabel('threads')).toBe('Threads')
    expect(capabilityLabel('reactions')).toBe('Reactions')
    expect(capabilityLabel('typing')).toBe('Typing indicator')
    expect(capabilityLabel('files')).toBe('File uploads')
    expect(capabilityLabel('directory')).toBe('Browse conversations')
    expect(capabilityLabel('edit')).toBe('Edit messages')
  })
})

describe('the ids that do not survive title-casing', () => {
  // The one a naive `cap[0].toUpperCase() + cap.slice(1)` would get wrong. 'directory'
  // means "can enumerate the conversations it is in"; rendered as "Directory" it reads
  // as a filesystem path, which is a different feature entirely.
  it('does not render directory as a folder', () => {
    expect(capabilityLabel('directory')).not.toMatch(/director/i)
  })

  // 'typing' and 'edit' are verbs on the wire and states in the UI: the channel does not
  // let YOU type, it shows the other side that you are.
  it('says what typing and edit actually mean rather than echoing the verb', () => {
    expect(capabilityLabel('typing')).toMatch(/indicator/i)
    expect(capabilityLabel('edit')).toMatch(/message/i)
  })
})
