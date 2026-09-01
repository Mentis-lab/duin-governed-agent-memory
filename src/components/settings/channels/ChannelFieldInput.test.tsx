import { describe, it, expect, beforeEach } from 'vitest'
import { setUiLanguage } from '@/lib/i18n'
import { fieldPlaceholder } from './ChannelFieldInput'
import type { ChannelCredential } from './channel-types'

// Node-only vitest env, no jsdom — the field's one judgement is a pure helper and is
// tested here rather than by rendering (ChannelsSettings.test.tsx set the convention).

beforeEach(() => setUiLanguage('en'))

const cred = (over: Partial<ChannelCredential> = {}): ChannelCredential => ({
  keychainKey: 'telegram.botToken',
  label: 'Bot token',
  kind: 'secret',
  hasValue: false,
  ...over
})

describe('a stored secret — the empty box that reads as a bug', () => {
  // The value never leaves the main process, so an empty box is all the component CAN
  // render. Next to a row saying "credentials are in place" that box looks broken, and
  // the operator clears a token that was working and re-pastes it.
  it('says a value is already stored', () => {
    expect(fieldPlaceholder(cred({ hasValue: true }))).toMatch(/stored/i)
  })

  it('says typing replaces it rather than appends to it', () => {
    expect(fieldPlaceholder(cred({ hasValue: true }))).toMatch(/replace/i)
  })

  it('is never blank when something is stored', () => {
    expect(fieldPlaceholder(cred({ hasValue: true, placeholder: undefined })).trim()).not.toBe('')
  })

  it('outranks the spec placeholder', () => {
    // The spec placeholder describes what to paste. Once something IS pasted that is no
    // longer the question being asked, so the stored fact wins the one line available.
    const f = cred({ hasValue: true, placeholder: 'paste the bot token' })
    expect(fieldPlaceholder(f)).not.toBe('paste the bot token')
  })
})

describe('an empty secret — nothing to explain, so get out of the way', () => {
  it('shows the spec placeholder', () => {
    expect(fieldPlaceholder(cred({ hasValue: false, placeholder: '123456:ABC-DEF' }))).toBe(
      '123456:ABC-DEF'
    )
  })

  it('shows nothing when the spec offers no placeholder', () => {
    expect(fieldPlaceholder(cred({ hasValue: false, placeholder: undefined }))).toBe('')
  })
})

describe('a text field — it renders its own value, so it needs none of this', () => {
  it('keeps the spec placeholder even when a value is stored', () => {
    // A text credential comes back WITH its value (ChannelCredential.value), so the box
    // is not empty and there is no missing fact to explain in the placeholder.
    const f = cred({ kind: 'text', hasValue: true, value: 'my-workspace', placeholder: 'workspace' })
    expect(fieldPlaceholder(f)).toBe('workspace')
    expect(fieldPlaceholder(f)).not.toMatch(/stored/i)
  })

  it('shows nothing when the spec offers no placeholder', () => {
    expect(fieldPlaceholder(cred({ kind: 'text', hasValue: true, placeholder: undefined }))).toBe('')
  })
})
