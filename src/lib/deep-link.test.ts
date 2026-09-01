import { describe, it, expect } from 'vitest'
import { parseDeepLink, toolLink } from './deep-link'

describe('parseDeepLink — the thing that was silently broken', () => {
  it('routes a tool link to its surface', () => {
    // CONTRACT CORRECTION (was: 'calibration' and 'loop'). Both of those ToolIds were
    // retired by the 2026-07-07 surface consolidation, so this test was asserting that
    // the parser resolves ids that name nothing — the exact behaviour the docstring
    // forbids. The two cases moved to the retired-surfaces test below; these are two
    // ids that still exist.
    expect(parseDeepLink('duin://tool/automations')).toEqual({
      kind: 'tool',
      toolId: 'automations'
    })
    expect(parseDeepLink('duin://tool/brain')).toEqual({ kind: 'tool', toolId: 'brain' })
  })

  it('refuses every surface the consolidation retired, rather than opening a blank panel', () => {
    // These seven were left behind in the allow-list when they were deleted from the
    // ToolId union. Resolving one made followDeepLink return true, which force-opened
    // the right panel onto a surface ToolsPanel has no case for AND suppressed the
    // caller's "no longer available" toast: a blank panel with no explanation.
    // 'calibration' and 'loop' are not hypothetical — two production emitters were
    // still sending them (proactive/watchers.ts, loop-controller.ts).
    for (const retired of [
      'browser',
      'environment',
      'loop',
      'status',
      'people',
      'orgs',
      'calibration'
    ]) {
      expect(parseDeepLink(`duin://tool/${retired}`)).toBeNull()
    }
  })

  it('does not resolve a prototype-chain property as a surface', () => {
    // The allow-list is an object now, so membership must be an own-property check;
    // `value in TOOL_IDS` would hand back a `toolId` of 'toString'.
    expect(parseDeepLink('duin://tool/toString')).toBeNull()
    expect(parseDeepLink('duin://tool/constructor')).toBeNull()
  })

  it('routes a customize column', () => {
    expect(parseDeepLink('duin://customize/skills')).toEqual({
      kind: 'customize',
      column: 'skills'
    })
  })

  it('routes an allowlisted settings tab, and refuses one that is not', () => {
    // The executor keep/discard notice deep-links here so the operator lands on the buttons.
    expect(parseDeepLink('duin://settings/executors')).toEqual({ kind: 'settings', tab: 'executors' })
    // Not on the allowlist → null, not a blank settings pane (the TOOL_IDS hazard).
    expect(parseDeepLink('duin://settings/general')).toBeNull()
    expect(parseDeepLink('duin://settings/toString')).toBeNull()
  })

  it('still understands both legacy conversation forms', () => {
    // The notify tool documents `conversation:<id>`, and pre-rename links used
    // `lamprey://`. Breaking either would strand notifications already in flight.
    expect(parseDeepLink('conversation:abc-123')).toEqual({
      kind: 'conversation',
      conversationId: 'abc-123'
    })
    expect(parseDeepLink('lamprey://conversation/abc-123')).toEqual({
      kind: 'conversation',
      conversationId: 'abc-123'
    })
  })

  it('routes the duin-scheme conversation form the old regex could not match', () => {
    expect(parseDeepLink('duin://conversation/abc-123')).toEqual({
      kind: 'conversation',
      conversationId: 'abc-123'
    })
  })

  it('returns null for a surface that does not exist rather than guessing', () => {
    // `duin://home-digest` was the ONLY link the app ever emitted, and it names no
    // surface. Guessing a nearby one would be worse than doing nothing visibly.
    expect(parseDeepLink('duin://home-digest')).toBeNull()
    expect(parseDeepLink('duin://tool/not-a-tool')).toBeNull()
    expect(parseDeepLink('duin://customize/nope')).toBeNull()
    expect(parseDeepLink('duin://mystery/thing')).toBeNull()
  })

  it('is null-safe on the empty and malformed cases', () => {
    expect(parseDeepLink(null)).toBeNull()
    expect(parseDeepLink(undefined)).toBeNull()
    expect(parseDeepLink('')).toBeNull()
    expect(parseDeepLink('   ')).toBeNull()
    expect(parseDeepLink('https://example.com')).toBeNull()
    expect(parseDeepLink('duin://tool/')).toBeNull()
  })

  it('decodes an encoded id and ignores a trailing slash', () => {
    expect(parseDeepLink('duin://conversation/a%20b/')).toEqual({
      kind: 'conversation',
      conversationId: 'a b'
    })
  })

  it('round-trips a link built by toolLink', () => {
    expect(parseDeepLink(toolLink('homeStatus'))).toEqual({
      kind: 'tool',
      toolId: 'homeStatus'
    })
  })
})
