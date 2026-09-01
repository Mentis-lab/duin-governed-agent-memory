// skills-store.persistence.test.ts — "the toggle survives a restart" is a claim, so it gets a test.
//
// Before 2026-07-21 activeSkillIds was in-memory only: enable a skill, quit, reopen, and it was off
// again with no indication anything had been forgotten. Once the toggle was correctly wired to the
// engine that became the remaining reason it was unusable for real work.
//
// The store hydrates at MODULE LOAD, so every case here installs its localStorage before a dynamic
// import and resets the module registry in between.

import { describe, it, expect, beforeEach, vi } from 'vitest'

const KEY = 'duin.skills.activeIds.v1'

function installStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  const localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k)
  }
  ;(globalThis as unknown as { window: unknown }).window = { localStorage }
  return data
}

async function freshStore() {
  vi.resetModules()
  const mod = await import('./skills-store')
  return mod.useSkillsStore
}

beforeEach(() => {
  vi.resetModules()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('skills-store — enabled skills persist across launches', () => {
  it('hydrates the enabled set from storage at startup (the restart case)', async () => {
    installStorage({ [KEY]: JSON.stringify(['direct-voice']) })
    const store = await freshStore()
    expect(store.getState().activeSkillIds).toEqual(['direct-voice'])
  })

  it('writes on toggle, so the next launch sees it', async () => {
    const data = installStorage()
    const store = await freshStore()
    store.getState().toggleSkill('direct-voice')
    expect(store.getState().activeSkillIds).toEqual(['direct-voice'])
    expect(JSON.parse(data.get(KEY)!)).toEqual(['direct-voice'])
  })

  it('toggling off persists the removal (not just the addition)', async () => {
    const data = installStorage({ [KEY]: JSON.stringify(['direct-voice']) })
    const store = await freshStore()
    store.getState().toggleSkill('direct-voice')
    expect(store.getState().activeSkillIds).toEqual([])
    expect(JSON.parse(data.get(KEY)!)).toEqual([])
  })

  it('setActiveSkillIds persists too', async () => {
    const data = installStorage()
    const store = await freshStore()
    store.getState().setActiveSkillIds(['a', 'b'])
    expect(JSON.parse(data.get(KEY)!)).toEqual(['a', 'b'])
  })

  it('a DELETED skill is pruned from the persisted set, not left as a phantom enable', async () => {
    const data = installStorage({ [KEY]: JSON.stringify(['gone', 'kept']) })
    const store = await freshStore()
    store.getState().setSkillsFromEvent([
      { id: 'kept', name: 'Kept', description: '', content: '' } as never
    ])
    expect(store.getState().activeSkillIds).toEqual(['kept'])
    expect(JSON.parse(data.get(KEY)!)).toEqual(['kept'])
  })

  it('corrupt storage degrades to empty instead of throwing at store construction', async () => {
    installStorage({ [KEY]: '{not json' })
    const store = await freshStore()
    expect(store.getState().activeSkillIds).toEqual([])
  })

  it('non-string entries are filtered out rather than reaching the chat payload', async () => {
    installStorage({ [KEY]: JSON.stringify(['ok', 42, null, { id: 'x' }]) })
    const store = await freshStore()
    expect(store.getState().activeSkillIds).toEqual(['ok'])
  })

  it('no window (main-process import / SSR) is safe — empty, no throw', async () => {
    const store = await freshStore()
    expect(store.getState().activeSkillIds).toEqual([])
    expect(() => store.getState().toggleSkill('x')).not.toThrow()
  })
})
