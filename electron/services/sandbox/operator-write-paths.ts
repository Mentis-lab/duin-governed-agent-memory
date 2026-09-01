// operator-write-paths — the operator's opt-in widening of the shell sandbox.
//
// The sandbox is deny-by-default and allows writes only to the workspace root and
// $TMPDIR. That is right for a tool an agent drives, and it is also why "write me a
// script into ~/code" failed with EPERM on macOS and had no fix short of
// DUIN_SANDBOX=0 — turning the whole sandbox off to gain one directory.
//
// This is the middle setting that was missing: named paths, chosen by the operator,
// added to the write allowlist and nothing else.

import { isAbsolute, resolve, normalize } from 'path'
import { homedir } from 'os'
import { readSettings } from '../settings-helper'

/** Paths that must never be handed to a sandboxed shell as writable, whatever the
 *  settings file says. Granting these does not "widen the sandbox", it removes the
 *  machine's own protection — and a settings file is editable by anything that already
 *  has the disk, so this list is enforced here rather than trusted upstream. */
const REFUSED_ROOTS = [
  '/',
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/Library',
  '/Applications',
  'C:/',
  'C:/Windows',
  'C:/Program Files'
]

/** `~` expansion, because an operator typing a path types `~/code`. */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  const winSep = String.fromCharCode(92)
  if (p.startsWith('~/') || p.startsWith('~' + winSep)) return resolve(homedir(), p.slice(2))
  return p
}

/**
 * Normalize + vet the operator's list.
 *
 * Refuses relative paths (meaningless to a sandbox profile, which needs absolutes),
 * the machine roots above, and the home directory itself — allowing `~` wholesale is
 * indistinguishable from no sandbox, and someone reaching for it almost certainly meant
 * one project directory inside it.
 */
export function resolveOperatorWritePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const home = resolve(homedir())
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const expanded = expandHome(entry.trim())
    if (!isAbsolute(expanded)) continue
    const abs = normalize(resolve(expanded))
    const cmp = process.platform === 'win32' ? abs.toLowerCase() : abs
    if (cmp === home.toLowerCase() || cmp === home) continue
    if (REFUSED_ROOTS.some((r) => cmp === normalize(resolve(r)).toLowerCase() || cmp === normalize(resolve(r)))) continue
    if (!out.includes(abs)) out.push(abs)
  }
  return out
}

/** Read the vetted list from persisted settings. Never throws: a broken settings file
 *  must narrow the sandbox to its default, never widen or break the shell. */
export function operatorWritePaths(): string[] {
  try {
    // STATIC import, not require(). A bare require of a sibling source module does not
    // survive bundling — electron-vite copies the call verbatim into out/main/index.js
    // where the relative path cannot resolve, so it throws on every call (the failure
    // documented at length in act/external-action.ts). settings-helper already degrades
    // to "no settings" when electron's app is unavailable, so importing it up front is
    // safe in tests too.
    return resolveOperatorWritePaths(readSettings().sandboxWritePaths)
  } catch {
    return []
  }
}

/**
 * Full computer access — the operator's opt-in to run DUIN as an UNCONFINED general
 * computer-use agent. OFF BY DEFAULT (public build): only an explicit `true` in settings.json
 * turns it on; a MISSING value, any other value, and a settings-read failure all read as OFF,
 * so a fresh install — and a torn or unreadable settings file — is confined. When on, the
 * caller (file tools, file browser, shell sandbox, and the agui gate) drops the vault/workspace
 * jail and authorizes every turn — the catastrophic-command floor and .trash reversibility are
 * enforced elsewhere and are NOT this function's concern.
 *
 * Polarity follows the house "unset = secure" rule (cf. DUIN_SANDBOX, where unset = confined).
 * The earlier `!== false` / catch-to-true reading (operator directive 2026-08-22) made a fresh
 * install and a broken settings file both UNCONFINED; the owner's own install keeps full access
 * through the persisted `true`, not through this default.
 */
export function fullComputerAccess(): boolean {
  try {
    return readSettings().fullComputerAccess === true
  } catch {
    return false
  }
}
