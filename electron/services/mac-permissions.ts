// mac-permissions — Full Disk Access on macOS: detect it, explain it, open the pane.
//
// THE PROBLEM THIS SOLVES. A tester reported DUIN never appearing in
// System Settings → Privacy & Security → Full Disk Access, so there was nothing to
// switch on and anything reading a TCC-protected path failed. Three separate facts
// combine into that, and only the first two are ours to fix:
//
//  1. An app is added to that list when it ATTEMPTS a protected read, or when the user
//     adds it by hand with "+". DUIN never touched a protected path during a normal
//     session, so macOS had no reason to list it.
//  2. The Info.plist must carry NSSystemAdministrationUsageDescription. Without it the
//     request is refused rather than prompted — indistinguishable from never asking.
//     (Added in electron-builder.yml `mac.extendInfo`.)
//  3. TCC keys a grant to the app's CODE SIGNATURE. An ad-hoc signature carries no Team
//     ID and its cdhash changes on every build, so a grant will not reliably survive an
//     update. Only a Developer ID certificate fixes that, and no code here can.
//
// THERE IS NO API TO REQUEST FULL DISK ACCESS. Apple exposes none — unlike camera or
// microphone, which have askForMediaAccess. Every app that offers a "grant access"
// button, including node-mac-permissions, does the same thing: opens the pane and asks
// the user to flip the switch. This module does that too, without pulling in a native
// module to do it.

import { shell } from 'electron'
import { open } from 'fs/promises'

/** Deep link to Privacy & Security → Full Disk Access. Still the `.preference` schema
 *  on Ventura+ even though the app is now called System Settings. */
const FULL_DISK_ACCESS_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

/**
 * Paths readable ONLY with Full Disk Access.
 *
 * More than one, deliberately: TCC's protections differ by OS version and by whether the
 * user has ever used the app in question, so a single probe reports "denied" on a machine
 * that simply has no Mail data. Any success means the grant is in place.
 */
const PROBE_PATHS = [
  // Present on every install and TCC-protected since Mojave.
  '/Library/Preferences/com.apple.TimeMachine.plist',
  // The canonical probe; absent only if Mail has never been configured.
  `${process.env.HOME ?? ''}/Library/Mail`,
  // TCC's own database — readable with FDA and nothing else.
  `${process.env.HOME ?? ''}/Library/Application Support/com.apple.TCC/TCC.db`
]

export type FullDiskAccessState = 'granted' | 'denied' | 'not-applicable'

/**
 * Is Full Disk Access granted?
 *
 * By probing, because there is no API to ask. A read that succeeds proves the grant; a
 * read that fails with EPERM/EACCES proves TCC refused. ENOENT is NOT a denial — the file
 * simply is not there — which is why several paths are tried before reporting denied.
 *
 * The probe has a second job: ATTEMPTING a protected read is what makes macOS list the
 * app under Full Disk Access at all. Calling this at boot is what puts DUIN in the list
 * so there is a switch to turn on.
 */
export async function getFullDiskAccessState(): Promise<FullDiskAccessState> {
  if (process.platform !== 'darwin') return 'not-applicable'
  let sawDenial = false
  for (const path of PROBE_PATHS) {
    // HOME-relative probes are unusable when HOME is unset (a bare launchd context).
    if (!path || path.includes('/undefined/')) continue
    try {
      // OPEN, not read: TCC gates the open, and the contents are irrelevant — reading
      // them would pull a whole database into memory to learn one boolean.
      const handle = await open(path, 'r')
      await handle.close()
      return 'granted'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EISDIR means the open SUCCEEDED and the target is a directory — TCC let us in.
      if (code === 'EISDIR') return 'granted'
      if (code === 'EPERM' || code === 'EACCES') sawDenial = true
      // ENOENT and anything else are inconclusive: the file may simply not exist on
      // this Mac (Mail never configured), which is not the same as being refused.
    }
  }
  // Only report denied on an ACTUAL refusal. Reporting it because every probe was
  // missing would tell the user to fix a permission that was never the problem.
  return sawDenial ? 'denied' : 'granted'
}

/**
 * Open System Settings at the Full Disk Access pane.
 *
 * This is the whole of what any app can do. Returns false when the deep link could not be
 * opened so the caller can fall back to telling the user the path in words rather than
 * silently appearing to do nothing.
 */
export async function openFullDiskAccessSettings(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    await shell.openExternal(FULL_DISK_ACCESS_PANE)
    return true
  } catch {
    return false
  }
}

/**
 * Touch a protected path at boot so macOS registers DUIN under Full Disk Access.
 *
 * Fire-and-forget and best-effort: the point is the ATTEMPT, not the result. Without it
 * the app is absent from the list and the user has to know to add it by hand with "+",
 * which is the exact confusion this was reported as.
 */
export function registerForFullDiskAccessListing(): void {
  if (process.platform !== 'darwin') return
  void getFullDiskAccessState().catch(() => undefined)
}

/** Exported for the settings surface — the honest caveat, in one place. */
export const AD_HOC_SIGNATURE_CAVEAT =
  'This build is ad-hoc signed rather than signed with an Apple Developer ID. macOS ties a ' +
  'Full Disk Access grant to an app’s code signature, so the grant may need to be ' +
  're-applied after an update.'
