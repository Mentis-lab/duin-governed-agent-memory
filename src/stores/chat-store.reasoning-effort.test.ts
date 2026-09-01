import { beforeEach, describe, expect, it, vi } from 'vitest'

// Both stores reach for `window.api`. The suite runs under the node environment
// (no jsdom), so stub the global BEFORE importing either module.
//
// settings.get returns a persisted reasoningEffort:'high' — the value a user
// saved in a previous session. settings.set is the persist sink that
// setReasoningEffort/updateSettings write to.
const settingsGet = vi.fn(async () => ({ success: true, data: { reasoningEffort: 'high' as const } }))
const settingsSet = vi.fn(async () => ({ success: true }))
;(globalThis as unknown as { window: unknown }).window = {
  api: {
    chat: { cancel: vi.fn() },
    settings: { get: settingsGet, set: settingsSet }
  }
}

// Import order matters only in that the subscription installed by chat-store must
// be live before loadSettings runs; importing both here guarantees that.
const { useChatStore } = await import('./chat-store')
const { useSettingsStore } = await import('./settings-store')

beforeEach(() => {
  settingsGet.mockClear()
  settingsSet.mockClear()
})

describe('chat-store — reasoningEffort survives restart via settings hydration', () => {
  it('starts at the fallback default before settings load', () => {
    // create() ran at import, before loadSettings — settings-store still held
    // defaultSettings (no reasoningEffort key), so the init read collapsed to 'low'.
    // This is the pre-fix observable state; the bug was that it NEVER changed.
    expect(useChatStore.getState().reasoningEffort).toBe('low')
  })

  it('adopts the persisted value once loadSettings resolves (the boot path)', async () => {
    // This is exactly what App's init effect does: it awaits loadSettings, which
    // merges the persisted reasoningEffort:'high' into settings-store. Before the
    // fix nothing pushed that back into chat-store, so the composer stayed 'low'
    // and every turn sent 'low', ignoring the saved preference.
    await useSettingsStore.getState().loadSettings()

    expect(useSettingsStore.getState().settings.reasoningEffort).toBe('high')
    expect(useChatStore.getState().reasoningEffort).toBe('high')
  })
})
