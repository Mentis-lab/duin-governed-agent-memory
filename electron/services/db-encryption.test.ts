import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let userDataDir: string

// Fault injection for the keys.json durability tests below. Both default to
// off, so every pre-existing test in this file sees the real fs.
//
// `tornWriteArmed` makes fs.writeFileSync behave like a real O_TRUNC write that
// dies mid-flight (ENOSPC / SIGKILL): the target is truncated FIRST, then the
// call throws. That is precisely what a non-atomic writer does to keys.json.
// atomicWriteFileSync never calls fs.writeFileSync, so correct code is immune.
let tornWriteArmed = false
// `atomicOpenFailArmed` makes the atomic writer's temp-file open fail, so we
// can assert what happens when the durable write itself cannot proceed.
let atomicOpenFailArmed = false

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  const enospc = (op: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOSPC: no space left on device, ${op}`), { code: 'ENOSPC' })
  const shim = {
    ...real,
    writeFileSync: ((...args: Parameters<typeof real.writeFileSync>) => {
      const [path] = args
      if (tornWriteArmed && typeof path === 'string' && path.endsWith('keys.json')) {
        // O_TRUNC lands, the data pages never do.
        real.writeFileSync(path, '')
        throw enospc('write')
      }
      return real.writeFileSync(...args)
    }) as typeof real.writeFileSync,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      const [path] = args
      if (atomicOpenFailArmed && typeof path === 'string' && path.includes('.atomic-')) {
        throw enospc('open')
      }
      return real.openSync(...args)
    }) as typeof real.openSync
  }
  return { ...shim, default: shim }
})

// Keychain-denial injection for the macOS path below. Both default to the
// behaviour every pre-existing test in this file was written against
// (isEncryptionAvailable false, decrypt succeeds), so nothing above changes.
//
// The pairing matters and is the whole point: on macOS the Keychain EXISTS —
// so isEncryptionAvailable() is true — while access to this particular item is
// refused, because a Keychain ACL is bound to the app's code signature and an
// unsigned rebuild is a different identity. `keychainAvailable = true` with
// `decryptThrowsArmed = true` is that exact state, and it is unreachable with a
// single "available?" boolean.
let keychainAvailable = false
let decryptThrowsArmed = false

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return userDataDir
      throw new Error(`unexpected app.getPath(${key})`)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => keychainAvailable,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => {
      // errSecInteractionNotAllowed — what macOS actually returns when it
      // declines to release a Keychain item to the running binary.
      if (decryptThrowsArmed) throw new Error('User interaction is not allowed.')
      return b.toString('utf8')
    }
  }
}))

import {
  getEncryptionStatus,
  isDatabaseEncrypted,
  enableEncryption,
  disableEncryption,
  changePassphrase,
  readStoredPassphrase,
  __clearStoredPassphraseForTest,
  __commitEncryptedSwapForTest
} from './db-encryption'

// Persistence Phase / PS9 — encryption module tests.
//
// We focus on the binding-absent path because the CI/dev environment
// here does not ship better-sqlite3-multiple-ciphers. The contract:
//   - getEncryptionStatus reports bindingAvailable=false + a useful
//     error string.
//   - enableEncryption refuses with a clear message.
//   - isDatabaseEncrypted reads the flag file (no binding needed).
//   - readStoredPassphrase reads/writes the keys.json shape we use for
//     other provider keys (plain: prefix when safeStorage unavailable).
//
// The binding-present path is exercised by smoke + integration when
// the native dep is installed; pure-binding-present tests would tie us
// to the cipher binary which is out of scope for unit tests.

describe('db-encryption (PS9, binding-absent path)', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-ps9-'))
    keychainAvailable = false
    decryptThrowsArmed = false
  })

  afterEach(() => {
    keychainAvailable = false
    decryptThrowsArmed = false
    if (userDataDir && existsSync(userDataDir)) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('getEncryptionStatus reports bindingAvailable=false when the package is missing', () => {
    const status = getEncryptionStatus()
    expect(status.bindingAvailable).toBe(false)
    expect(status.bindingError).toBeTruthy()
    expect(status.databaseEncrypted).toBe(false)
    expect(status.passphraseStored).toBe(false)
  })

  it('isDatabaseEncrypted returns false when no flag file exists', () => {
    expect(isDatabaseEncrypted()).toBe(false)
  })

  it('isDatabaseEncrypted returns true when flag file is present', () => {
    writeFileSync(join(userDataDir, 'encryption.flag'), '1')
    expect(isDatabaseEncrypted()).toBe(true)
  })

  it('enableEncryption refuses with a clear message when the binding is unavailable', () => {
    expect(() => enableEncryption('correct-horse-battery-staple')).toThrowError(
      /SQLCipher binding unavailable/
    )
  })

  it('enableEncryption refuses short passphrases regardless of binding', () => {
    // Even if the binding error fires first, we want to validate that
    // short passphrases get rejected — call with a length<8 passphrase.
    expect(() => enableEncryption('short')).toThrowError(
      /SQLCipher binding unavailable|at least 8 characters/
    )
  })

  it('disableEncryption refuses when DB is not encrypted', () => {
    expect(() => disableEncryption('any-passphrase-long-enough')).toThrowError(
      /SQLCipher binding unavailable|not encrypted/
    )
  })

  it('changePassphrase refuses when DB is not encrypted', () => {
    expect(() => changePassphrase('old-passphrase', 'new-passphrase-12')).toThrowError(
      /SQLCipher binding unavailable|not encrypted/
    )
  })

  it('readStoredPassphrase returns null when keys.json does not exist', () => {
    expect(readStoredPassphrase()).toBeNull()
  })

  it('readStoredPassphrase reads plain: prefix when safeStorage unavailable', () => {
    writeFileSync(
      join(userDataDir, 'keys.json'),
      JSON.stringify({ encryption: 'plain:my-passphrase-here' })
    )
    expect(readStoredPassphrase()).toBe('my-passphrase-here')
  })

  // F6 — macOS Keychain refuses to release an item written by a differently-signed
  // build. The entry is PRESENT and the Keychain is available; only access to it is
  // denied, so the isEncryptionAvailable() guard cannot catch this.
  it('readStoredPassphrase throws, and never returns null, when the keychain refuses to decrypt', () => {
    writeFileSync(
      join(userDataDir, 'keys.json'),
      JSON.stringify({ encryption: Buffer.from('real-passphrase', 'utf8').toString('base64') })
    )
    keychainAvailable = true
    decryptThrowsArmed = true

    // Returning null here would be read downstream as "no passphrase stored"
    // (database.ts), which sends the operator to recreate a passphrase that is
    // still on disk and intact. Throwing is the contract; null is the data-loss path.
    expect(() => readStoredPassphrase()).toThrowError()
    expect(readStoredPassphrase).toThrowError(/could not be decrypted by the OS keychain/)
  })

  it('the keychain-refusal error says the passphrase is intact and names the mac cause', () => {
    writeFileSync(
      join(userDataDir, 'keys.json'),
      JSON.stringify({ encryption: Buffer.from('real-passphrase', 'utf8').toString('base64') })
    )
    keychainAvailable = true
    decryptThrowsArmed = true

    // The diagnosis is the fix: a bare OS string ("User interaction is not allowed.")
    // tells the operator nothing about whether their data is recoverable.
    expect(readStoredPassphrase).toThrowError(/do NOT delete it or recreate one/)
    expect(readStoredPassphrase).toThrowError(/code-signature/)
    // and it must carry the underlying OS reason, not swallow it
    expect(readStoredPassphrase).toThrowError(/User interaction is not allowed/)
  })

  it('a decryptable entry still returns the passphrase when the keychain cooperates', () => {
    writeFileSync(
      join(userDataDir, 'keys.json'),
      JSON.stringify({ encryption: Buffer.from('real-passphrase', 'utf8').toString('base64') })
    )
    keychainAvailable = true
    decryptThrowsArmed = false
    // Guards the catch from becoming a blanket failure path.
    expect(readStoredPassphrase()).toBe('real-passphrase')
  })

  it('readStoredPassphrase returns null for an entry that does not exist', () => {
    writeFileSync(
      join(userDataDir, 'keys.json'),
      JSON.stringify({ deepseek: 'plain:some-other-key' })
    )
    expect(readStoredPassphrase()).toBeNull()
  })
})

// Regression: clearStoredPassphrase must never destroy provider API keys.
//
// It is the only writer of keys.json that ever used a bare writeFileSync,
// while its sibling writeStoredPassphrase 13 lines above and keychain.ts's
// writeKeys both used atomicWriteFileSync — the guard already existed in the
// same file (imported at line 3) and exactly one call site skipped it. These
// tests pin the durability contract behaviorally, not by grepping for an
// identifier, so a future refactor back to writeFileSync fails here.
describe('db-encryption — clearStoredPassphrase keys.json durability', () => {
  const KEYS = {
    anthropic: 'plain:sk-ant-user-entered',
    openai: 'plain:sk-openai-user-entered',
    gemini: 'plain:sk-gemini-user-entered',
    encryption: 'plain:correct-horse-battery-staple'
  }
  let errorSpy: ReturnType<typeof vi.spyOn>

  const keysPath = (): string => join(userDataDir, 'keys.json')
  const seedKeys = (): void => writeFileSync(keysPath(), JSON.stringify(KEYS, null, 2))

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-ps9-keys-'))
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    tornWriteArmed = false
    atomicOpenFailArmed = false
    errorSpy.mockRestore()
    if (userDataDir && existsSync(userDataDir)) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('drops only the encryption row and leaves every provider key intact', () => {
    seedKeys()
    __clearStoredPassphraseForTest()

    const after = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>
    expect(after.encryption).toBeUndefined()
    expect(after.anthropic).toBe(KEYS.anthropic)
    expect(after.openai).toBe(KEYS.openai)
    expect(after.gemini).toBe(KEYS.gemini)
  })

  // THE POWER-CONTROL TEST. With the O_TRUNC fault armed, a non-atomic writer
  // truncates keys.json and dies, leaving a zero-length file; the catch logs at
  // debug and disableEncryption still reports success. An atomic writer never
  // opens the target for writing at all, so the fault cannot reach it.
  it('survives a mid-write ENOSPC without truncating keys.json', () => {
    seedKeys()
    tornWriteArmed = true

    __clearStoredPassphraseForTest()

    const raw = readFileSync(keysPath(), 'utf8')
    expect(raw.length).toBeGreaterThan(0)
    const after = JSON.parse(raw) as Record<string, string>
    // Whatever happened to the passphrase row, the user-entered API keys —
    // which exist nowhere else on disk and are in no backup path — survive.
    expect(after.anthropic).toBe(KEYS.anthropic)
    expect(after.openai).toBe(KEYS.openai)
    expect(after.gemini).toBe(KEYS.gemini)
  })

  it('preserves the whole prior file and reports loudly when the durable write fails', () => {
    seedKeys()
    atomicOpenFailArmed = true

    __clearStoredPassphraseForTest()

    // Nothing destroyed: the atomic write failed before the rename, so the
    // previous bytes are still there — including the encryption row.
    const after = JSON.parse(readFileSync(keysPath(), 'utf8')) as Record<string, string>
    expect(after).toEqual(KEYS)
    // And the failure is not indistinguishable from success: the IPC handler
    // returns {success:true} regardless, so this log is the only signal that a
    // stale passphrase row was left behind.
    expect(errorSpy).toHaveBeenCalled()
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/failed to clear the stored passphrase/)
  })

  it('leaves no .atomic- temp files behind', () => {
    seedKeys()
    __clearStoredPassphraseForTest()
    const strays = readdirSync(userDataDir).filter((f) => f.includes('.atomic-'))
    expect(strays).toEqual([])
  })
})

// Regression: enableEncryption must persist the passphrase BEFORE the
// irreversible file swap.
//
// The original code swapped the SQLCipher-encrypted file into place FIRST and
// only then called writeStoredPassphrase()+stampEncryptionFlag(). Because
// writeStoredPassphrase() can throw (corrupt keys.json, safeStorage failure,
// ENOSPC on the atomic write), a throw at that instant left lamprey.db already
// encrypted while the keychain held no passphrase and no flag was stamped — the
// next boot's isDatabaseEncrypted() returned false, opened the ciphertext as
// plain better-sqlite3 ("file is not a database"), and getDb() threw for every
// consumer, unrecoverable without a hand-restore of the .preencrypt backup.
//
// The commit sequence is exercised through __commitEncryptedSwapForTest because
// the full enableEncryption() path requires the native SQLCipher binding to
// produce the encrypted temp file, and that binding is absent in CI/dev. The
// binding only PRODUCES encPath; the ordering bug lives entirely in the commit.
describe('db-encryption — enableEncryption persists passphrase before the swap', () => {
  const PLAINTEXT = 'ORIGINAL-PLAINTEXT-DB-BYTES'
  const CIPHERTEXT = 'ENCRYPTED-CIPHERTEXT-DB-BYTES'

  const dbPath = (): string => join(userDataDir, 'lamprey.db')
  const encPath = (): string => join(userDataDir, 'lamprey-enc.db')
  const backupPath = (): string => `${dbPath()}.preencrypt-fixed-ts`
  const flagPath = (): string => join(userDataDir, 'encryption.flag')
  const keysPath = (): string => join(userDataDir, 'keys.json')

  const seedFiles = (): void => {
    // The live plaintext DB, and the already-exported encrypted temp file that
    // the (mocked-away) binding would have produced.
    writeFileSync(dbPath(), PLAINTEXT)
    writeFileSync(encPath(), CIPHERTEXT)
  }

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'lamprey-ps9-enable-'))
  })

  afterEach(() => {
    if (userDataDir && existsSync(userDataDir)) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  it('happy path: swaps ciphertext into place, stores passphrase, stamps flag', () => {
    seedFiles()
    __commitEncryptedSwapForTest({
      sourcePath: dbPath(),
      encPath: encPath(),
      sourceBackupPath: backupPath(),
      passphrase: 'correct-horse-battery-staple'
    })
    expect(readFileSync(dbPath(), 'utf8')).toBe(CIPHERTEXT)
    expect(readFileSync(backupPath(), 'utf8')).toBe(PLAINTEXT)
    expect(existsSync(flagPath())).toBe(true)
    expect(readStoredPassphrase()).toBe('correct-horse-battery-staple')
  })

  // THE ORDERING TEST. keys.json is corrupt, so writeStoredPassphrase() throws.
  // With persist-BEFORE-swap the throw aborts while the plaintext DB is still in
  // place: lamprey.db is untouched, no flag, no backup. With the old
  // persist-AFTER-swap ordering the ciphertext would already be lamprey.db and a
  // .preencrypt backup would exist — an encrypted DB with no recoverable key.
  it('aborts with the plaintext DB intact when the keychain write fails', () => {
    seedFiles()
    // Corrupt keys.json → writeStoredPassphrase() throws 'keys.json is
    // unreadable; refusing to write passphrase'.
    writeFileSync(keysPath(), '{ this is not valid json')

    expect(() =>
      __commitEncryptedSwapForTest({
        sourcePath: dbPath(),
        encPath: encPath(),
        sourceBackupPath: backupPath(),
        passphrase: 'correct-horse-battery-staple'
      })
    ).toThrow(/keys\.json is unreadable/)

    // The live DB is still the untouched plaintext — recoverable, openable as
    // plain better-sqlite3 on next boot.
    expect(readFileSync(dbPath(), 'utf8')).toBe(PLAINTEXT)
    // No flag was stamped, so the next boot correctly treats the DB as plain.
    expect(existsSync(flagPath())).toBe(false)
    // No irreversible swap happened: no .preencrypt backup was created.
    expect(existsSync(backupPath())).toBe(false)
  })
})

