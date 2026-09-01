import { safeStorage } from 'electron'
import { app } from 'electron'
import { BrowserWindow } from 'electron'
import { chmodSync } from 'fs'
import { atomicWriteFileSync } from './atomic-write'
import { quarantineCorruptSettings, readSettingsFile } from './settings-file'
import { join } from 'path'
import { recordEvent } from './event-log'

// Local credential store. Keys live in JSON at userData/keys.json, each value
// either base64-encoded electron safeStorage ciphertext or a `plain:`-prefixed
// fallback when safeStorage is unavailable (Linux without libsecret).
//
// SEC-10: the plaintext fallback is gated on EXPLICIT consent — either a
// per-call `{ allowPlaintext: true }` flag or a session-level consent flag
// the renderer flips after surfacing a confirm dialog. `setKey` THROWS
// `PlaintextConsentRequiredError` when encryption is off and neither
// signal is present, so an IPC handler that quietly calls setKey can't
// silently land a plaintext key. The error is surfaced back through the
// IPC as a clean reason string the renderer can show.
//
// Background paths (e.g. mcp-manager OAuth token refresh) get implicit
// consent via the `getKey` re-grant below: if a `plain:` row already exists
// on disk it means the user consented to plaintext at some earlier point
// on this device, so the session-consent flag flips on the first such read
// and subsequent in-session writes succeed without re-prompting.

const getKeysPath = (): string => join(app.getPath('userData'), 'keys.json')

// File mode for the on-disk keystore. 0o600 = read/write owner only.
// On Windows the POSIX mode bit is best-effort; the OS-level ACL still
// inherits from the userData directory, which is per-user. The chmod call
// is a no-op on Windows but does not throw.
const KEYS_FILE_MODE = 0o600

// Session-scoped consent, PER PROVIDER. Reset on app restart. The renderer records it
// through `grantPlaintextConsent()` after surfacing a confirm dialog; `getKey` records it
// implicitly for a provider whose `plain:` row already exists on disk (that row could only
// have been written if the user consented for THAT provider at some earlier point).
//
// This was a single module-global boolean. Reading one legacy plaintext row therefore
// authorised plaintext writes for EVERY provider for the rest of the session — consent
// given once for one key silently became consent for keys the user had never been asked
// about. Consent is about a specific secret, so it is now keyed by one.
/** Sentinel for an explicit, user-dialog grant that covers the whole session. */
const SESSION_WIDE_CONSENT = '*'
const sessionPlaintextConsent = new Set<string>()

export class PlaintextConsentRequiredError extends Error {
  readonly provider: string
  constructor(provider: string) {
    super(
      `Refusing to write '${provider}' key as plaintext: encryption is ` +
        'unavailable on this system and the caller has not recorded ' +
        'explicit plaintext-storage consent. Surface a confirm dialog and ' +
        'call settings.grantPlaintextConsent() first.'
    )
    this.name = 'PlaintextConsentRequiredError'
    this.provider = provider
  }
}

export interface SetKeyOptions {
  /**
   * When safeStorage is unavailable, allow writing this single key as
   * `plain:`. The caller is responsible for having obtained explicit
   * user consent (typically via `window.confirm`). Has no effect when
   * encryption IS available — the key is still encrypted.
   */
  allowPlaintext?: boolean
}

/**
 * Raised when keys.json is present but unparseable AND could not be moved
 * aside. Overwriting it would destroy the only recoverable copy of every
 * provider key plus the wrapped DB-encryption passphrase, so we refuse.
 */
export class CorruptKeysFileError extends Error {
  constructor(path: string) {
    super(
      `Refusing to overwrite unreadable keys.json at ${path}: it could not be ` +
        'moved aside, and overwriting it would destroy the only recoverable ' +
        'copy of your provider API keys and the database-encryption passphrase.'
    )
    this.name = 'CorruptKeysFileError'
  }
}

/**
 * Read + classify keys.json, reusing the settings-file choke point so this
 * file gets the SAME 'absent' | 'ok' | 'corrupt' discrimination.
 *
 * The distinction is load-bearing. 'absent' means there is nothing to lose and
 * a fresh whole-file write is correct. 'corrupt' means content EXISTS on disk —
 * a torn write (see db-encryption.ts's non-atomic clearStoredPassphrase), an
 * ENOSPC, a crash, or an unreadable file under AV lock — and that content is
 * hand-recoverable ciphertext. Collapsing the two into `{}` and then writing
 * the whole object back is exactly what converts recoverable-partial into
 * unrecoverable-total: every provider key gone, and the `encryption` row gone
 * while isDatabaseEncrypted() still returns true, i.e. lamprey.db permanently
 * undecryptable. This is the identical amplifier settings-file.ts was built to
 * close for the strictly less valuable settings.json.
 */
function readKeysFile(): { state: 'absent' | 'ok' | 'corrupt'; keys: Record<string, string> } {
  const { state, data } = readSettingsFile(getKeysPath())
  return { state, keys: data as Record<string, string> }
}

function readKeys(): Record<string, string> {
  return readKeysFile().keys
}

function writeKeys(keys: Record<string, string>): void {
  const path = getKeysPath()
  // Preserve + record + stamp before any whole-file replacement. Re-classified
  // HERE, at the single write choke point, rather than at each caller — a guard
  // that lives at the call sites is a guard exactly one call site will skip.
  if (readSettingsFile(path).state === 'corrupt') {
    const sidecar = quarantineCorruptSettings(path)
    if (!sidecar) {
      emitKeychainEvent({
        action: 'keys-file-quarantine-failed',
        outcome: 'refused-corrupt-keystore',
        severity: 'warning'
      })
      throw new CorruptKeysFileError(path)
    }
    console.error(
      `[keychain] ${path} was present but unparseable (likely a torn write). ` +
        `Preserved the previous bytes at ${sidecar} before writing a fresh keystore. ` +
        'Recover your provider API keys and the `encryption` passphrase row from ' +
        'that file — without the `encryption` row an encrypted lamprey.db cannot ' +
        'be opened.'
    )
    emitKeychainEvent({
      action: 'keys-file-quarantined',
      outcome: 'quarantined',
      severity: 'warning'
    })
  }
  // SEC-3: persist with 0o600. `writeFileSync` only honors `mode` on FILE
  // CREATION; existing files keep their old mode. For the upgrade path
  // (older builds wrote with the default 0o644) we chmod opportunistically
  // after the write so subsequent reads come from a hardened file.
  // Atomic + fsync: a torn write to keys.json loses every provider key AND the
  // DB-encryption passphrase at once (unrecoverable DB). Never a plain write.
  atomicWriteFileSync(path, JSON.stringify(keys, null, 2), KEYS_FILE_MODE)
  try {
    chmodSync(path, KEYS_FILE_MODE)
  } catch {
    // Windows can reject chmod for ACL-controlled paths; the mode bit is
    // advisory there. We've already done what we can.
  }
}

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Record that the user has explicitly consented to plaintext-on-disk
 * storage for this session. The flag survives until the app restarts;
 * subsequent `setKey` calls succeed without `allowPlaintext`.
 *
 * The renderer must call this only AFTER surfacing a `window.confirm`
 * dialog the user has accepted.
 */
export function grantPlaintextConsent(provider?: string): void {
  // An EXPLICIT grant stays session-wide when no provider is named, because that is
  // exactly what the confirm dialog promises the user ("applies for the rest of this
  // DUIN session"). Narrowing it here would break that promise in the other direction.
  const scope = provider?.trim() || SESSION_WIDE_CONSENT
  const alreadyGranted = sessionPlaintextConsent.has(scope)
  sessionPlaintextConsent.add(scope)
  if (!alreadyGranted) {
    emitKeychainEvent({
      action: 'plaintext-consent-granted',
      outcome: 'granted',
      ...(provider ? { provider } : {})
    })
  }
}

/** Whether plaintext storage is authorised — for `provider` specifically, or at all. */
export function hasPlaintextConsent(provider?: string): boolean {
  if (sessionPlaintextConsent.has(SESSION_WIDE_CONSENT)) return true
  return provider ? sessionPlaintextConsent.has(provider) : sessionPlaintextConsent.size > 0
}

/** Test-only: clear recorded consent between cases. */
export function __resetPlaintextConsentForTest(): void {
  sessionPlaintextConsent.clear()
}

export function setKey(provider: string, key: string, opts: SetKeyOptions = {}): void {
  const keys = readKeys()
  const wasNewProvider = !(provider in keys)
  let storageMode: 'encrypted' | 'plaintext'
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(key)
    keys[provider] = encrypted.toString('base64')
    storageMode = 'encrypted'
  } else if (opts.allowPlaintext || hasPlaintextConsent(provider)) {
    // The renderer is expected to have confirmed plaintext storage before
    // reaching this code path (either via the per-call flag or via the
    // session-consent IPC). The warning log remains as a backstop for
    // callers that bypass that flow.
    console.warn('[keychain] safeStorage unavailable — storing key as plaintext (consent recorded)')
    keys[provider] = `plain:${key}`
    storageMode = 'plaintext'
  } else {
    emitKeychainEvent({
      action: 'key-set-refused',
      provider,
      outcome: 'refused-no-consent',
      severity: 'warning'
    })
    throw new PlaintextConsentRequiredError(provider)
  }
  writeKeys(keys)
  emitKeychainEvent({
    action: wasNewProvider ? 'key-created' : 'key-updated',
    provider,
    outcome: 'persisted',
    storageMode
  })
  broadcastKeychainChanged(provider)
}

export function getKey(provider: string): string | null {
  const keys = readKeys()
  const stored = keys[provider]
  if (!stored) return null

  if (stored.startsWith('plain:')) {
    // Implicit consent re-grant: an existing `plain:` row could only have
    // been written if the user previously consented (the `setKey` gate
    // rejects unauthorized plaintext writes). Treating that as session
    // consent lets background callers — most importantly the mcp-manager
    // OAuth token refresh — re-save refreshed tokens without forcing the
    // user to re-confirm at every relaunch.
    // Scoped to THIS provider only. Inferring blanket consent from one legacy row is
    // how consent for a single key silently became consent for every key.
    sessionPlaintextConsent.add(provider)
    return stored.slice(6)
  }

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[keychain] safeStorage unavailable — cannot decrypt key')
    return null
  }

  try {
    const buffer = Buffer.from(stored, 'base64')
    return safeStorage.decryptString(buffer)
  } catch {
    console.error('[keychain] Failed to decrypt key for', provider)
    return null
  }
}

export function deleteKey(provider: string): void {
  const keys = readKeys()
  const existed = provider in keys
  delete keys[provider]
  writeKeys(keys)
  if (existed) {
    emitKeychainEvent({
      action: 'key-deleted',
      provider,
      outcome: 'deleted'
    })
    broadcastKeychainChanged(provider)
  }
}

export function hasKey(provider: string): boolean {
  const keys = readKeys()
  return provider in keys
}

// Test-only: re-export the file-mode constant so the test suite can assert
// the value without re-deriving it. The mode is documented in the source
// comment above; this export is the contract.
export const __KEYS_FILE_MODE_FOR_TEST = KEYS_FILE_MODE

interface KeychainEventDetail {
  /** What the caller attempted. Discrete strings so the timeline UI can
   *  group "set" vs "delete" vs "consent" without parsing free-form copy. */
  action:
    | 'key-created'
    | 'key-updated'
    | 'key-deleted'
    | 'key-set-refused'
    | 'plaintext-consent-granted'
    /** keys.json was present-but-unparseable; its bytes were side-cared to
     *  keys.corrupt-<ts>.json before the fresh keystore was written. */
    | 'keys-file-quarantined'
    /** keys.json was present-but-unparseable and could NOT be moved aside;
     *  the write was refused so the recoverable bytes survive. */
    | 'keys-file-quarantine-failed'
  /** Which provider's key moved. Optional for consent events that aren't
   *  tied to a single provider. NEVER a value. */
  provider?: string
  /** Outcome flag — a short status string. NEVER includes the key value. */
  outcome:
    | 'persisted'
    | 'deleted'
    | 'refused-no-consent'
    | 'granted'
    | 'quarantined'
    | 'refused-corrupt-keystore'
  /** Distinguishes safeStorage-encrypted writes from plaintext-fallback
   *  writes. Refused / consent events leave this undefined. */
  storageMode?: 'encrypted' | 'plaintext'
  severity?: 'info' | 'warning'
}

/**
 * Mirror a keychain mutation into the event spine. CRITICAL: this helper
 * never receives the key VALUE — only the provider id and an outcome flag.
 * That contract is enforced at the call sites: callers pass discrete
 * metadata, not the key string. A future refactor that adds a `key?: string`
 * field to KeychainEventDetail breaks the audit contract and must be
 * caught in review.
 *
 * Failures here are swallowed: the keychain write itself is the load-bearing
 * side-effect, and the event-log already owns its memory fallback.
 */
function emitKeychainEvent(detail: KeychainEventDetail): void {
  try {
    recordEvent({
      type: 'security.decision',
      actorKind: 'user',
      severity: detail.severity ?? 'info',
      entityKind: 'keychain',
      entityId: detail.provider,
      payload: {
        action: detail.action,
        provider: detail.provider,
        outcome: detail.outcome,
        storageMode: detail.storageMode
      }
    })
  } catch (err) {
    console.error('[keychain] security.decision event failed:', err)
  }
}

/**
 * Tell every renderer that the keystore changed.
 *
 * Key ENTRY is spread across surfaces — Settings → API Keys, the in-chat
 * unlock prompt, the onboarding "connect a model" card — but key STORAGE has
 * always been this one file. What drifted was each renderer's CACHED `hasKey`
 * snapshot: a surface only saw a new key if its own call site remembered to
 * re-fetch, so a key added in Settings left the chat composer still showing
 * the model locked and asking for the same key a second time. Broadcasting
 * from the single mutation choke point makes that impossible to get wrong
 * from a call site that hasn't been written yet.
 *
 * Carries only the provider id — never a key value — matching the audit
 * contract on emitKeychainEvent above.
 *
 * Failures are swallowed for the same reason as emitKeychainEvent: the
 * on-disk write is the load-bearing side-effect, not the notification. The
 * guard also keeps this inert under unit tests, whose `electron` mock has no
 * BrowserWindow.
 */
function broadcastKeychainChanged(provider: string): void {
  try {
    if (typeof BrowserWindow?.getAllWindows !== 'function') return
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('keychain:changed', provider)
    }
  } catch (err) {
    console.error('[keychain] keychain:changed broadcast failed:', err)
  }
}
