import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Shared reactive state for the electron mock. `vi.hoisted` keeps the
// declaration order consistent with `vi.mock`, so the mock factory can close
// over `state` even though both are hoisted above the imports.
const state = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
  // When true, the side-car rename is simulated as impossible (read-only
  // directory, EPERM under AV lock, ...). Portable stand-in for a
  // platform-specific unmovable-file setup.
  quarantineFails: false,
  // Every webContents.send() the keychain broadcast made, so a test can
  // assert renderers were told the keystore changed.
  sent: [] as { channel: string; payload: unknown }[],
  // Fake renderer windows. `destroyed` covers the teardown race where a
  // window is closing while a key is written.
  windowDestroyed: false
}))

// Real settings-file behaviour, except that quarantining can be forced to
// fail so the refuse-if-unmovable branch is reachable on every platform.
vi.mock('./settings-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-file')>()
  return {
    ...actual,
    quarantineCorruptSettings: (path: string) =>
      state.quarantineFails ? null : actual.quarantineCorruptSettings(path)
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return state.userDataDir
      throw new Error(`unexpected app.getPath(${name})`)
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => state.windowDestroyed,
        webContents: {
          send: (channel: string, payload: unknown) => state.sent.push({ channel, payload })
        }
      }
    ]
  },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    // Cheap reversible "encryption" so the round-trip path is observable
    // without depending on real safeStorage (which would not work in the
    // test environment anyway).
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf-8'),
    decryptString: (b: Buffer) => {
      const decoded = b.toString('utf-8')
      if (!decoded.startsWith('enc:')) throw new Error('bad ciphertext')
      return decoded.slice(4)
    }
  }
}))

// Import after the mock is set up.
import {
  __KEYS_FILE_MODE_FOR_TEST,
  __resetPlaintextConsentForTest,
  CorruptKeysFileError,
  deleteKey,
  getKey,
  grantPlaintextConsent,
  hasKey,
  hasPlaintextConsent,
  isEncryptionAvailable,
  PlaintextConsentRequiredError,
  setKey
} from './keychain'

const isWin32 = process.platform === 'win32'

function keysPath(): string {
  return join(state.userDataDir, 'keys.json')
}

function readRawKeys(): Record<string, string> {
  if (!existsSync(keysPath())) return {}
  return JSON.parse(readFileSync(keysPath(), 'utf-8'))
}

describe('keychain', () => {
  beforeEach(() => {
    state.userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-keychain-test-'))
    state.encryptionAvailable = true
    state.quarantineFails = false
    state.sent = []
    state.windowDestroyed = false
    __resetPlaintextConsentForTest()
  })

  afterEach(() => {
    // Best-effort cleanup. EPERM on Windows when a sibling fs handle is
    // still being released by the runtime; suppress so subsequent tests
    // (which use a fresh mkdtempSync) aren't poisoned by the exception.
    try {
      if (state.userDataDir && existsSync(state.userDataDir)) {
        rmSync(state.userDataDir, { recursive: true, force: true })
      }
    } catch { /* Windows file-handle race; ignore */ }
  })

  describe('round-trip', () => {
    it('stores then retrieves an encrypted key when safeStorage is available', () => {
      state.encryptionAvailable = true
      setKey('deepseek', 'sk-test-1234')
      expect(getKey('deepseek')).toBe('sk-test-1234')

      // On-disk shape must be the base64-encoded ciphertext — NOT a
      // `plain:` row — when encryption is on.
      const raw = readRawKeys()
      expect(raw.deepseek).toBeDefined()
      expect(raw.deepseek.startsWith('plain:')).toBe(false)
      expect(Buffer.from(raw.deepseek, 'base64').toString('utf-8')).toBe('enc:sk-test-1234')
    })

    it('stores then retrieves a key via the plain: fallback when safeStorage is unavailable AND consent is granted', () => {
      state.encryptionAvailable = false
      grantPlaintextConsent()
      setKey('deepseek', 'sk-test-1234')
      expect(getKey('deepseek')).toBe('sk-test-1234')

      const raw = readRawKeys()
      expect(raw.deepseek).toBe('plain:sk-test-1234')
    })

    it('stores via plain: when the per-call allowPlaintext flag is passed', () => {
      state.encryptionAvailable = false
      // No session consent granted — but the per-call flag is enough.
      setKey('deepseek', 'sk-test-1234', { allowPlaintext: true })
      const raw = readRawKeys()
      expect(raw.deepseek).toBe('plain:sk-test-1234')
    })

    it('reads an existing plain: row even after encryption becomes available (mixed state)', () => {
      state.encryptionAvailable = false
      grantPlaintextConsent()
      setKey('legacy', 'plain-stored-1')
      state.encryptionAvailable = true
      // The plain: row predates the encryption flip — it must still decode
      // (we know nothing about whether the user re-saved).
      expect(getKey('legacy')).toBe('plain-stored-1')
    })

    it('returns null when no key is stored', () => {
      expect(getKey('not-present')).toBe(null)
    })

    it('hasKey reflects whether the row exists', () => {
      expect(hasKey('deepseek')).toBe(false)
      setKey('deepseek', 'abc')
      expect(hasKey('deepseek')).toBe(true)
    })

    it('deleteKey removes the row', () => {
      setKey('deepseek', 'abc')
      expect(hasKey('deepseek')).toBe(true)
      deleteKey('deepseek')
      expect(hasKey('deepseek')).toBe(false)
      expect(getKey('deepseek')).toBe(null)
    })

    it('returns null on a corrupt ciphertext rather than throwing', () => {
      // Simulate an on-disk row that won't decrypt cleanly.
      writeFileSync(keysPath(), JSON.stringify({ broken: 'not-valid-base64' }), 'utf-8')
      state.encryptionAvailable = true
      expect(getKey('broken')).toBe(null)
    })
  })

  describe('file permissions (SEC-3)', () => {
    it('exposes the documented mode constant', () => {
      expect(__KEYS_FILE_MODE_FOR_TEST).toBe(0o600)
    })

    it.skipIf(isWin32)('persists keys.json with mode 0o600 on POSIX', () => {
      setKey('deepseek', 'abc')
      const mode = statSync(keysPath()).mode & 0o777
      expect(mode).toBe(0o600)
    })

    it.skipIf(isWin32)('upgrades a previously-loose 0o644 file to 0o600 on next write', () => {
      // Simulate a pre-Prompt-10 install: file exists with the default mode.
      writeFileSync(keysPath(), JSON.stringify({}), { encoding: 'utf-8', mode: 0o644 })
      chmodSync(keysPath(), 0o644)
      const before = statSync(keysPath()).mode & 0o777
      expect(before).toBe(0o644)

      // Any setKey triggers a writeKeys, which chmods opportunistically.
      setKey('deepseek', 'abc')
      const after = statSync(keysPath()).mode & 0o777
      expect(after).toBe(0o600)
    })
  })

  describe('plaintext consent gate (SEC-10)', () => {
    it('setKey THROWS PlaintextConsentRequiredError when encryption is off and no consent is recorded', () => {
      state.encryptionAvailable = false
      expect(() => setKey('deepseek', 'abc')).toThrow(PlaintextConsentRequiredError)
      // The on-disk file must NOT contain the row — the throw happened
      // before write.
      expect(readRawKeys().deepseek).toBeUndefined()
    })

    it('encrypts normally when encryption is available, ignoring the flag', () => {
      state.encryptionAvailable = true
      setKey('deepseek', 'abc') // no consent, no flag — fine, encryption is on
      const raw = readRawKeys()
      expect(raw.deepseek).toBeDefined()
      expect(raw.deepseek.startsWith('plain:')).toBe(false)
    })

    it('an implicit re-grant from one legacy plain: row does NOT authorise other providers', () => {
      // The leak: reading a legacy plaintext row flipped a module-global flag, so consent
      // recorded once for one key silently became consent for keys the user was never
      // asked about. Implicit consent is now scoped to the provider it was inferred from.
      state.encryptionAvailable = false
      setKey('zhipu', 'legacy-key', { allowPlaintext: true })
      __resetPlaintextConsentForTest() // simulate the next app session

      expect(getKey('zhipu')).toBe('legacy-key') // implicit re-grant fires here
      expect(hasPlaintextConsent('zhipu')).toBe(true)

      // ...and stops there.
      expect(hasPlaintextConsent('openai')).toBe(false)
      expect(() => setKey('openai', 'should-not-land')).toThrow(PlaintextConsentRequiredError)
      expect(readRawKeys().openai).toBeUndefined()

      // The provider it WAS inferred for still writes without re-prompting, which is the
      // background-refresh path the re-grant exists to serve.
      setKey('zhipu', 'refreshed')
      expect(readRawKeys().zhipu).toBe('plain:refreshed')
    })

    it('session consent unlocks subsequent writes for ALL providers', () => {
      state.encryptionAvailable = false
      grantPlaintextConsent()
      setKey('deepseek', 'k1')
      setKey('google-client-id', 'k2')
      setKey('web_search:brave', 'k3')
      expect(readRawKeys().deepseek).toBe('plain:k1')
      expect(readRawKeys()['google-client-id']).toBe('plain:k2')
      expect(readRawKeys()['web_search:brave']).toBe('plain:k3')
    })

    it('getKey on an existing plain: row implicitly re-grants session consent', () => {
      // Pre-seed a plain: row to simulate a relaunch after a previous
      // session granted consent. (Setup: temporarily enable encryption to
      // bypass the gate, then back to off; OR use the allowPlaintext flag.)
      state.encryptionAvailable = false
      setKey('google-access-token', 'token-a', { allowPlaintext: true })
      // New session — reset consent.
      __resetPlaintextConsentForTest()
      expect(hasPlaintextConsent()).toBe(false)
      // Background caller reads the existing token...
      expect(getKey('google-access-token')).toBe('token-a')
      // ...and the read implicitly grants consent so a downstream
      // background write (e.g. OAuth refresh) goes through without a
      // re-prompt.
      expect(hasPlaintextConsent()).toBe(true)
      setKey('google-access-token', 'refreshed-token')
      expect(getKey('google-access-token')).toBe('refreshed-token')
    })

    it('hasPlaintextConsent reflects grant + reset state', () => {
      expect(hasPlaintextConsent()).toBe(false)
      grantPlaintextConsent()
      expect(hasPlaintextConsent()).toBe(true)
      __resetPlaintextConsentForTest()
      expect(hasPlaintextConsent()).toBe(false)
    })

    it('PlaintextConsentRequiredError carries the provider id', () => {
      state.encryptionAvailable = false
      try {
        setKey('google-refresh-token', 'rt-1')
        expect.unreachable('setKey should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(PlaintextConsentRequiredError)
        expect((err as PlaintextConsentRequiredError).provider).toBe('google-refresh-token')
        expect((err as Error).message).toMatch(/google-refresh-token/)
        expect((err as Error).message).toMatch(/grantPlaintextConsent/i)
      }
    })

    it('a getKey on an encrypted row does NOT grant consent (only plain: rows imply it)', () => {
      state.encryptionAvailable = true
      setKey('deepseek', 'enc-only')
      // Flip to no-encryption to simulate a subsequent session — the
      // encrypted row can't decrypt now, but it shouldn't grant consent
      // either.
      state.encryptionAvailable = false
      __resetPlaintextConsentForTest()
      // The read returns null (can't decrypt without safeStorage); consent
      // stays off.
      expect(getKey('deepseek')).toBe(null)
      expect(hasPlaintextConsent()).toBe(false)
    })
  })

  // A torn write leaves a valid-JSON PREFIX of the real file on disk. These
  // bytes are hand-recoverable ciphertext for EVERY provider key plus the
  // wrapped DB-encryption passphrase, so the next whole-file write must not
  // silently replace them.
  const TORN_KEYS_PREFIX =
    '{\n  "anthropic": "ZW5jOnNrLWFudC1yZWFsLXNlY3JldA==",\n' +
    '  "openai": "ZW5jOnNrLW9wZW5haS1yZWFsLXNlY3JldA==",\n' +
    '  "encryption": "ZW5jOndyYXBwZWQtZGItcGFzc3'

  function sidecars(): string[] {
    return readdirSync(state.userDataDir).filter((f) => /^keys\.corrupt-.*\.json$/.test(f))
  }

  describe('corrupt keys.json is never silently overwritten', () => {
    it('side-cars the torn bytes before setKey writes a fresh keystore', () => {
      writeFileSync(keysPath(), TORN_KEYS_PREFIX, 'utf-8')

      // The exact live scenario: user opens Settings and pastes a Gemini key.
      setKey('gemini', 'sk-gemini-new')

      // The prior bytes must still exist, verbatim, in a timestamped side-car.
      const found = sidecars()
      expect(found).toHaveLength(1)
      const preserved = readFileSync(join(state.userDataDir, found[0]), 'utf-8')
      expect(preserved).toBe(TORN_KEYS_PREFIX)
      // Every destroyed secret is recoverable from it — including the
      // `encryption` row, without which lamprey.db can never be opened again.
      expect(preserved).toContain('anthropic')
      expect(preserved).toContain('openai')
      expect(preserved).toContain('encryption')

      // ...and the app stays usable: the new key landed.
      expect(getKey('gemini')).toBe('sk-gemini-new')
    })

    it('side-cars before deleteKey writes too (the other whole-file writer)', () => {
      writeFileSync(keysPath(), TORN_KEYS_PREFIX, 'utf-8')
      deleteKey('anthropic')
      expect(sidecars()).toHaveLength(1)
      expect(readFileSync(join(state.userDataDir, sidecars()[0]), 'utf-8')).toBe(TORN_KEYS_PREFIX)
    })

    it('refuses the write entirely when the corrupt file cannot be moved aside', () => {
      writeFileSync(keysPath(), TORN_KEYS_PREFIX, 'utf-8')
      state.quarantineFails = true

      expect(() => setKey('gemini', 'sk-gemini-new')).toThrow(CorruptKeysFileError)

      // Nothing quarantined, and the only copy of the residue is untouched.
      expect(sidecars()).toHaveLength(0)
      expect(readFileSync(keysPath(), 'utf-8')).toBe(TORN_KEYS_PREFIX)
    })

    it('treats a present-but-unreadable / non-object file as corrupt as well', () => {
      // A top-level array is valid JSON but not a keystore; spreading it would
      // silently produce garbage.
      writeFileSync(keysPath(), '["anthropic","openai"]', 'utf-8')
      setKey('gemini', 'sk-gemini-new')
      expect(sidecars()).toHaveLength(1)
    })

    it('does NOT quarantine when the file is merely absent (nothing to lose)', () => {
      expect(existsSync(keysPath())).toBe(false)
      setKey('gemini', 'sk-gemini-new')
      expect(sidecars()).toHaveLength(0)
      expect(getKey('gemini')).toBe('sk-gemini-new')
    })

    it('does NOT quarantine a healthy file, and preserves its other rows', () => {
      setKey('anthropic', 'sk-ant-1')
      setKey('encryption', 'wrapped-passphrase')
      setKey('gemini', 'sk-gemini-new')

      expect(sidecars()).toHaveLength(0)
      expect(getKey('anthropic')).toBe('sk-ant-1')
      expect(getKey('encryption')).toBe('wrapped-passphrase')
      expect(getKey('gemini')).toBe('sk-gemini-new')
    })
  })

  describe('isEncryptionAvailable', () => {
    it('returns the safeStorage value when encryption is available', () => {
      state.encryptionAvailable = true
      expect(isEncryptionAvailable()).toBe(true)
    })

    it('returns the safeStorage value when encryption is unavailable', () => {
      state.encryptionAvailable = false
      expect(isEncryptionAvailable()).toBe(false)
    })
  })

  // Key entry is spread across Settings, the in-chat unlock prompt and the
  // onboarding card, but they all land here. Renderers cache `hasKey`, so
  // without this broadcast a key added at one surface leaves the others
  // showing "no key" — which is what made a key look like it had to be
  // entered twice. These tests pin the notification to the write itself so a
  // future surface cannot forget to refresh.
  describe('keychain:changed broadcast', () => {
    const changed = (): { channel: string; payload: unknown }[] =>
      state.sent.filter((s) => s.channel === 'keychain:changed')

    it('notifies renderers when a key is saved, naming the provider', () => {
      setKey('openai', 'sk-openai-1')

      expect(changed()).toHaveLength(1)
      expect(changed()[0].payload).toBe('openai')
    })

    it('never puts the key VALUE on the wire', () => {
      setKey('openai', 'sk-super-secret')

      expect(JSON.stringify(state.sent)).not.toContain('sk-super-secret')
    })

    it('notifies again when the same provider key is replaced', () => {
      setKey('openai', 'sk-openai-1')
      setKey('openai', 'sk-openai-2')

      expect(changed()).toHaveLength(2)
    })

    it('notifies on delete so surfaces re-lock', () => {
      setKey('openai', 'sk-openai-1')
      state.sent = []

      deleteKey('openai')

      expect(changed()).toHaveLength(1)
      expect(changed()[0].payload).toBe('openai')
    })

    it('stays quiet when deleting a provider that had no key', () => {
      deleteKey('never-set')

      expect(changed()).toHaveLength(0)
    })

    it('does not notify when the write is REFUSED for lack of consent', () => {
      state.encryptionAvailable = false

      expect(() => setKey('openai', 'sk-openai-1')).toThrow(PlaintextConsentRequiredError)
      expect(changed()).toHaveLength(0)
    })

    it('skips a destroyed window instead of throwing mid-write', () => {
      state.windowDestroyed = true

      expect(() => setKey('openai', 'sk-openai-1')).not.toThrow()
      expect(changed()).toHaveLength(0)
      // The key itself must still have landed — the notification is
      // best-effort, the write is not.
      expect(getKey('openai')).toBe('sk-openai-1')
    })
  })
})
