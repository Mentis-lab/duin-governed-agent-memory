import { describe, it, expect, beforeEach } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'
import { stateLabel, stateTone } from './ChannelStatusBadge'
import type { ChannelState } from './channel-types'

// Renderer render tests need jsdom, which this repo's node-only vitest env does not
// provide, so the badge's judgement lives in pure helpers and is tested here — the same
// convention as ChannelsSettings.test.tsx.
//
// The badge is colour first, word second: an operator scanning the pane triages on tone
// long before reading a label. That makes the tone assertions below the load-bearing
// ones, not decoration.

// Pinned so a translated dictionary cannot silently move an assertion. Same guard
// i18n.test.ts uses.
beforeEach(() => setUiLanguage('en'))

// `satisfies` makes ADDING a member to ChannelState a compile error right here, so a new
// state cannot ship with an untested label and tone.
const ALL_STATES = Object.keys({
  off: 0,
  'needs-setup': 0,
  connecting: 0,
  live: 0,
  failed: 0
} satisfies Record<ChannelState, number>) as ChannelState[]

describe('stateLabel — every state says something, and says something different', () => {
  it('covers every member of the union with non-empty copy', () => {
    for (const s of ALL_STATES) expect(stateLabel(s).trim(), s).not.toBe('')
  })

  it('never renders the raw wire id at the operator', () => {
    for (const s of ALL_STATES) expect(stateLabel(s), s).not.toBe(s)
  })

  it('gives each state a distinct word', () => {
    const labels = ALL_STATES.map(stateLabel)
    expect(new Set(labels).size).toBe(ALL_STATES.length)
  })
})

// The whole reason this helper is exported. 'needs-setup' sits between two wrong
// readings and must not drift into either.
describe('needs-setup is the operator’s next action, not a fault', () => {
  it('does not read as an error', () => {
    // Nothing has gone wrong — the token has simply not been pasted yet. Copy that
    // reads as a fault sends the operator hunting for a problem that does not exist.
    expect(stateLabel('needs-setup')).not.toMatch(/error|fail|broken|invalid|problem|unavailable/i)
  })

  it('does not read as connected', () => {
    // An enabled channel with no secret never starts, and a badge implying it did is a
    // lie found out only when no message ever arrives.
    expect(stateLabel('needs-setup')).not.toMatch(/\b(connected|live|running|ready|active|on)\b/i)
  })

  it('names the thing that is missing, so the next step is obvious without a click', () => {
    expect(stateLabel('needs-setup')).toMatch(/credential/i)
  })
})

describe('stateTone — colour triage', () => {
  it('gives every state a tone', () => {
    for (const s of ALL_STATES) expect(stateTone(s).trim(), s).not.toBe('')
  })

  it('uses theme vars only, so the pill follows light/dark', () => {
    // A literal Tailwind colour (bg-amber-500) would look right in one theme and wrong
    // in the other, and would stop tracking styles/index.css.
    for (const s of ALL_STATES) expect(stateTone(s), s).not.toMatch(/-(red|green|amber|yellow)-\d/)
  })

  it('paints off as muted grey with no status colour at all', () => {
    const tone = stateTone('off')
    expect(tone).toContain('--text-muted')
    expect(tone).not.toMatch(/--success|--warning|--error/)
  })

  it('paints needs-setup amber and NOT red', () => {
    // The colour carries more than the word does. Red here means "the token was
    // rejected"; amber means "there is no token yet". Confusing the two is the failure
    // this test exists to prevent.
    expect(stateTone('needs-setup')).toContain('--warning')
    expect(stateTone('needs-setup')).not.toContain('--error')
    expect(stateTone('needs-setup')).not.toBe(stateTone('failed'))
  })

  it('never paints needs-setup as connected', () => {
    expect(stateTone('needs-setup')).not.toContain('--success')
    expect(stateTone('needs-setup')).not.toBe(stateTone('live'))
  })

  it('pulses only while connecting', () => {
    // Two amber states share a colour on purpose (neither is running, neither is
    // broken). Motion is what separates "coming up" from "waiting on you", so it must
    // belong to exactly one of them.
    expect(stateTone('connecting')).toContain('animate-pulse')
    for (const s of ALL_STATES.filter((x) => x !== 'connecting')) {
      expect(stateTone(s), s).not.toContain('animate-pulse')
    }
  })

  it('paints live green and failed red', () => {
    expect(stateTone('live')).toContain('--success')
    expect(stateTone('failed')).toContain('--error')
  })
})
