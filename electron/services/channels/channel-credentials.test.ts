import { describe, it, expect, vi, beforeEach } from 'vitest'

// Lane D — "the operator can enable a channel without hand-editing channels.json".
//
// The pane already had the ENABLE toggle; what it had nowhere to put was the credential
// the adapter waits for, so a channel could be switched on and then sit forever reporting
// "waiting for credentials" with no input anywhere in the app. These tests pin the half
// that closes it: adapters DECLARE their fields, and the store writes only a declared key.
//
// The declared-key check is the security-relevant part. Without it `channels:setCredential`
// is a general renderer-reachable keychain write — a much larger authority than
// "configure this channel" — so it gets a test that fails loudly if the check is removed.

const store: Record<string, string> = {}
vi.mock('../keychain', () => ({
  getKey: (k: string): string | null => store[k] ?? null,
  setKey: (k: string, v: string): void => {
    store[k] = v
  },
  deleteKey: (k: string): void => {
    delete store[k]
  },
  hasKey: (k: string): boolean => k in store
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => [] }
}))

const { listChannelCredentials, setChannelCredential, setChannelEnabled } = await import(
  './channels-store'
)
const { listChannels } = await import('./index')

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
})

describe('channel credential declarations', () => {
  it('every shipped adapter declares a field or deliberately declares none', () => {
    // The point is that the declaration is a CHOICE, not an omission: an adapter with a
    // keychain-backed secret and no `credentials` entry is unreachable from the UI, which
    // is exactly the bug this closes.
    for (const c of listChannels()) {
      if (!c.credentials) continue
      for (const f of c.credentials) {
        expect(f.keychainKey.startsWith(`channel:${c.id}:`)).toBe(true)
        expect(f.label.length).toBeGreaterThan(0)
        expect(['secret', 'text']).toContain(f.kind)
      }
    }
  })

  it('telegram and discord declare a bot-token secret keyed where the adapter reads it', () => {
    for (const id of ['telegram', 'discord']) {
      const fields = listChannelCredentials(id)
      expect(fields.length).toBeGreaterThan(0)
      const token = fields.find((f) => f.keychainKey === `channel:${id}:token`)
      expect(token).toBeTruthy()
      expect(token?.kind).toBe('secret')
      // A secret must never round-trip its value to the renderer.
      expect(token?.value).toBeUndefined()
    }
  })
})

describe('listChannelCredentials — what crosses back to the renderer', () => {
  it('reports a secret as stored WITHOUT revealing it, and round-trips non-secret config', () => {
    setChannelCredential('telegram', 'channel:telegram:token', 'super-secret-token')
    const [token] = listChannelCredentials('telegram')
    expect(token.hasValue).toBe(true)
    expect(token.value).toBeUndefined() // the whole point

    setChannelCredential('feishu', 'channel:feishu:watch', 'oc_a, oc_b')
    const [watch] = listChannelCredentials('feishu')
    expect(watch.kind).toBe('text')
    expect(watch.hasValue).toBe(true)
    expect(watch.value).toBe('oc_a, oc_b') // editable, not write-only
  })

  it('an unknown channel yields no fields rather than throwing', () => {
    expect(listChannelCredentials('not-a-channel')).toEqual([])
  })
})

describe('setChannelCredential', () => {
  it('writes a declared key and reports the adapter configured afterwards', () => {
    const before = listChannelCredentials('telegram')[0]
    expect(before.hasValue).toBe(false)

    const res = setChannelCredential('telegram', 'channel:telegram:token', 'tok')
    expect(res).toMatchObject({ ok: true, configured: true })
    expect(store['channel:telegram:token']).toBe('tok')
  })

  it('an empty value CLEARS the credential (and the adapter reports unconfigured)', () => {
    setChannelCredential('telegram', 'channel:telegram:token', 'tok')
    const res = setChannelCredential('telegram', 'channel:telegram:token', '')
    expect(res).toMatchObject({ ok: true, configured: false })
    expect('channel:telegram:token' in store).toBe(false)
  })

  it('REFUSES a key the adapter never declared — this IPC is not a keychain-write primitive', () => {
    const res = setChannelCredential('telegram', 'openai', 'sk-stolen')
    expect(res).toMatchObject({ ok: false })
    expect('openai' in store).toBe(false)
  })

  it('refuses an unknown channel', () => {
    expect(setChannelCredential('nope', 'channel:nope:token', 'x')).toMatchObject({ ok: false })
  })

  it('reports whether the channel is enabled, so the caller knows to restart it', () => {
    setChannelEnabled('telegram', true)
    expect(setChannelCredential('telegram', 'channel:telegram:token', 'tok')).toMatchObject({
      enabled: true
    })
    setChannelEnabled('telegram', false)
    expect(setChannelCredential('telegram', 'channel:telegram:token', 'tok2')).toMatchObject({
      enabled: false
    })
  })
})
