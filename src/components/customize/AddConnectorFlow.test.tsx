import { describe, it, expect } from 'vitest'

// The Custom tab's "Add remote connector" decision, unit-tested. There is no jsdom
// in this repo, so renderer behaviour is pinned through pure exported helpers — the
// same convention as ChannelsSettings.test.tsx / LoopSettings.test.tsx.
//
// AddConnectorFlow reaches window.api through the mcp store -> lib/ipc-client, which
// captures `const api = window.api` at MODULE scope. The suite is node-only, so the
// global has to exist before that module graph is evaluated; a dynamic import after
// the assignment orders it correctly without fighting ESM import hoisting.
;(globalThis as unknown as { window?: unknown }).window ??= { api: {} }

const { remoteConnectorAuthFields } = await import('./AddConnectorFlow')

describe('remote connector auth — credentials are optional, OAuth is not conditional on them', () => {
  // THE load-bearing case. The Advanced panel tells the user to leave both fields
  // blank unless the server handed them credentials, and that instruction used to
  // persist auth:'none' — which makes connectHttp build an anonymous transport with
  // no McpOAuthProvider, so connectWithRetry's `if (oauthProvider && ... )` recovery
  // can never fire and a hosted OAuth server lands permanently red on "Unauthorized".
  it('still arms OAuth when the user leaves both optional fields blank', () => {
    expect(remoteConnectorAuthFields('', '').auth).toBe('oauth')
  })

  it('is not fooled by whitespace typed into the client id', () => {
    expect(remoteConnectorAuthFields('   ', '  ').auth).toBe('oauth')
  })

  it('sends no client credentials at all when none were given, so the SDK registers dynamically', () => {
    expect(remoteConnectorAuthFields('', '')).toEqual({ auth: 'oauth' })
  })

  it('passes a pre-registered client id through as optional pre-registration', () => {
    expect(remoteConnectorAuthFields(' abc123 ', '')).toEqual({
      auth: 'oauth',
      oauthClientId: 'abc123'
    })
  })

  it('carries the secret too when the server issued a confidential client', () => {
    expect(remoteConnectorAuthFields('abc123', ' s3cret ')).toEqual({
      auth: 'oauth',
      oauthClientId: 'abc123',
      oauthClientSecret: 's3cret'
    })
  })

  // A secret with no id is not a usable client registration; it must not be stored
  // (ipc/mcp.ts only writes the keychain entry when a client id is present anyway).
  it('ignores a lone secret with no client id', () => {
    expect(remoteConnectorAuthFields('', 'orphan-secret')).toEqual({ auth: 'oauth' })
  })
})
