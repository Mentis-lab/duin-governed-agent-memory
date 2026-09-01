import { app, BrowserWindow } from 'electron'
import { readSettings } from './settings-helper'
import { messageOf } from './guarded'

/** The leading segment electron-builder gives every DUIN artifact
 *  (`artifactName: ${productName}-${arch}.${ext}` → `DUIN-x64.exe`). */
export const EXPECTED_ARTIFACT_PREFIX = 'DUIN-'

/** Does this update manifest describe DUIN's OWN build?
 *
 *  P0 (2026-07-25): the shipped feed pointed at the repo DUIN's branch lives in rather than the
 *  one it releases from, and that repo publishes a different product on its own version line
 *  (Lamprey 0.27.1 vs DUIN 0.8.0). electron-updater compares versions, not identities, so it read
 *  a foreign product as an upgrade — and with autoDownload on and errors suppressed from the UI,
 *  nothing anywhere would have told the operator. Repointing the feed fixes that instance; this
 *  fixes the class.
 *
 *  FAILS CLOSED: a manifest with no artifact names to check is refused. Refusing costs a missed
 *  update, which the operator can resolve with a manual check; accepting cost the whole product.
 *  Matches on the `DUIN-` PREFIX of the file's basename, not a substring, so `Lamprey-DUIN-x64.exe`
 *  cannot slip through. PURE — no IO, so the guard is testable without a packaged app. */
export function updateIsOwnProduct(
  info: { version?: string; path?: string; files?: { url?: string }[] } | null | undefined,
  expectedPrefix: string = EXPECTED_ARTIFACT_PREFIX
): boolean {
  const names = [info?.path, ...(info?.files ?? []).map((f) => f?.url)].filter(
    (n): n is string => typeof n === 'string' && n.trim().length > 0
  )
  if (names.length === 0) return false
  const prefix = expectedPrefix.toLowerCase()
  return names.every((n) => {
    const base = n.split(/[\\/]/).pop() ?? ''
    return base.toLowerCase().startsWith(prefix)
  })
}

/** How often the background check repeats while DUIN stays open.
 *
 *  Six hours: frequent enough that a session running for days learns about a release the same day,
 *  slow enough that a feed check is never a load concern. The regression test drives this same
 *  constant so the cadence and its cover cannot drift apart. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

let periodicCheckTimer: NodeJS.Timeout | null = null

let getWindowRef: (() => BrowserWindow | null) | null = null

/** Set ONLY when a download completed AND `updateIsOwnProduct` passed on it.
 *
 *  quitAndInstall() takes no argument and cannot re-inspect what electron-updater has staged, so
 *  without this it would install whatever is sitting in the cache — including an artifact left by
 *  an earlier build under a bad feed. Gating on a flag we set ourselves means the install path is
 *  reachable only via a download this process verified. Resets on restart, which is correct: a
 *  fresh launch re-runs the check and re-verifies before offering anything. */
let verifiedDownloadReady = false

/** Set when THIS session saw an `update-available` that passed the identity guard. downloadUpdate()
 *  below refuses without it, so a download can only follow a verified offer — the same shape as
 *  verifiedDownloadReady for the install step. Resets on restart. */
let verifiedUpdateOffered = false

function send(channel: string, payload: unknown): void {
  const win = getWindowRef ? getWindowRef() : BrowserWindow.getAllWindows()[0]
  win?.webContents.send(channel, payload)
}

export async function initializeUpdater(opts: {
  getWindow: () => BrowserWindow | null
}): Promise<void> {
  getWindowRef = opts.getWindow
  if (!app.isPackaged) return

  const settings = readSettings()
  if (settings.autoCheckUpdates === false) return

  try {
    const { autoUpdater } = await import('electron-updater')
    // autoDownload stays OFF so the identity guard runs BEFORE 300 MB lands on disk. We start
    // the download ourselves once the artifact is confirmed ours.
    autoUpdater.autoDownload = false
    // autoInstallOnAppQuit OFF (2026-07-27, operator request, and a near-miss).
    //
    // It was on, and a staged `pending/Lamprey-x64.exe` (287.9 MB, from the pre-guard feed
    // misconfiguration) was found sitting in the updater cache armed to install. With this true,
    // simply QUITTING DUIN would have replaced it with a different product — no prompt, no
    // confirmation, nothing to click. An install is a decision; it now requires an explicit
    // quitAndInstall() from the Restart action, which is itself identity-guarded below.
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('update-available', (info) => {
      if (!updateIsOwnProduct(info)) {
        // A foreign artifact on our feed is a release-configuration failure, not a user problem —
        // but unlike the errors below it is NOT safe to swallow quietly, because the failure mode
        // is installing someone else's product over DUIN. Loud in the log, and refused.
        console.error(
          `[updater] REFUSED update ${info?.version ?? '<unknown>'}: artifact ` +
            `${info?.path ?? '<none>'} is not a ${EXPECTED_ARTIFACT_PREFIX}* build. ` +
            'Check the publish feed in electron-builder.yml.'
        )
        return
      }
      verifiedUpdateOffered = true
      send('update:available', {
        version: info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes:
          typeof info?.releaseNotes === 'string' ? info.releaseNotes : null
      })
      // NOTIFY-ONLY (release M11, A4 F4). This used to call autoUpdater.downloadUpdate() here,
      // so a verified offer became a ~100-300 MB fetch with nobody asking. Windows builds are
      // unsigned and electron-updater skips signature verification for unsigned artifacts
      // (NsisUpdater.js), which means the feed's publisher — anyone holding RELEASES_TOKEN —
      // could stage code onto every install; the operator's Restart click was the only human
      // step. Now the banner offers Download, downloadUpdate() below runs it, and Restart stays
      // gated on the verified-download flag. Re-enable auto-download only once builds are
      // signed and verified.
    })
    autoUpdater.on('update-downloaded', (info) => {
      // GUARD HERE TOO. The `update-available` check alone was not enough: an artifact
      // downloaded by an EARLIER build (before that guard existed, or under a different feed)
      // still fires `update-downloaded` on the next launch, and this handler used to announce
      // it unconditionally. That is what put "Update available (v0.27.1) — restart to install"
      // in front of the operator: v0.27.1 is upstream Lamprey's version line, not DUIN's 0.8.0.
      // Clicking Restart would have installed it. The banner must never offer a foreign build.
      if (!updateIsOwnProduct(info)) {
        console.error(
          `[updater] REFUSED downloaded update ${info?.version ?? '<unknown>'}: artifact ` +
            `${info?.path ?? '<none>'} is not a ${EXPECTED_ARTIFACT_PREFIX}* build. ` +
            'A stale artifact may be staged in the updater cache; it will not be installed.'
        )
        return
      }
      verifiedDownloadReady = true
      send('update:downloaded', { version: info?.version ?? null })
    })
    autoUpdater.on('error', (err) => {
      // Log only. Auto-update errors are never actionable for the end user:
      // they mean "no release manifest at the configured GitHub repo right
      // now," "transient network failure," or "version is already current and
      // some internal heuristic tripped." Pushing them as a renderer toast
      // spammed users on every startup whenever the repo lacked a published
      // latest.yml. Manual "Check for updates" still returns the error via
      // the IPC return value of update:check, where it IS surfaced.
      console.warn('[updater] background check error (suppressed from UI):', messageOf(err) ?? err)
    })

    // PERIODIC, not once-per-launch. `autoCheckUpdates` ships ON (default-app-settings.ts) and the
    // toggle promises "Periodically check for a newer DUIN release in the background"
    // (GeneralSettings.tsx), but this function used to run a single check — at the moment
    // app.whenReady() resolved — and nothing here or in any caller re-armed it.
    //
    // What made it invisible: that one check is real and works, so every restart-to-verify looks
    // correct. The gap only opens for a session that never quits, which is precisely the session
    // DUIN is built for (tray icon, minimizeToTray, hourly/daily background monitors) — leave it
    // running for days and it would never notice a release, while the setting claimed otherwise.
    //
    // Armed BEFORE the first check on purpose: checkForUpdates() rejects on a network failure, so
    // arming after the await would mean a launch with no connectivity — the case where re-checking
    // matters most — falls into the catch below having scheduled nothing.
    if (periodicCheckTimer) clearInterval(periodicCheckTimer)
    periodicCheckTimer = setInterval(() => {
      // Re-read per tick: the launch-time read above cannot see a toggle flipped mid-session, and
      // turning the setting off has to stop the background checks now, not at the next restart.
      if (readSettings().autoCheckUpdates === false) return
      void autoUpdater.checkForUpdates().catch(() => {
        // checkForUpdates rejects AND emits 'error', which the handler above already logs. This
        // catch exists only so a failed background check is not an unhandled rejection.
      })
    }, UPDATE_CHECK_INTERVAL_MS)
    periodicCheckTimer.unref?.()

    // checkForUpdates, not checkForUpdatesAndNotify: the latter's notification fires on a
    // DOWNLOADED update, and downloading is now our decision to make after the identity guard.
    // The renderer still learns about both events through the handlers above.
    await autoUpdater.checkForUpdates()
  } catch (err) {
    console.error('[updater] initialization failed:', (err as Error).message)
  }
}

/** Fetch the offered update — the operator's explicit step (banner → Download). Same `{ ok, error }`
 *  shape as checkNow(). Refuses unless THIS session saw an identity-verified `update-available`:
 *  a Download click with no verified offer behind it (a stale banner, a foreign artifact refused
 *  above) must not fetch anything. Never installs — that stays behind quitAndInstall()'s own
 *  verified-download gate. */
export async function downloadUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return { ok: false, error: 'Updater only runs in packaged builds.' }
  if (!verifiedUpdateOffered) {
    return {
      ok: false,
      error: 'No verified update has been offered in this session. Run "Check for updates" first.'
    }
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (err) {
    console.warn('[updater] download failed:', messageOf(err) ?? err)
    return { ok: false, error: messageOf(err) ?? String(err) }
  }
}

/** Install the staged update — or REPORT why not. Same `{ ok, error }` shape as checkNow().
 *
 *  This returned `void`. Every refusal below went to the main-process console and then a bare
 *  `return`, and the only caller (`ipcMain.handle('update:restart')` in main.ts) answered
 *  `{ success: true }` unconditionally, so nothing downstream could distinguish a refused install
 *  from one about to happen. The Restart button was therefore a real, reachable silent no-op.
 *
 *  What made it invisible: the refusal is LOUD — in a console no user reads — and the window is
 *  not exotic. `update-available` above sends the renderer its banner and only THEN starts
 *  fetching a ~100-300 MB artifact, so Restart sits on screen, enabled, and guaranteed to refuse
 *  for the whole download. Nothing on screen changed either way, so a click looked identical to a
 *  restart that was simply about to happen. */
export async function quitAndInstall(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return { ok: false, error: 'Updater only runs in packaged builds.' }
  if (!verifiedDownloadReady) {
    // Refuse rather than install blind. Reaching here without the flag means the staged artifact
    // was not verified by THIS process — a stale foreign build in the cache, or a Restart click
    // against a banner from a previous session. Installing the wrong product is unrecoverable
    // from inside the app; a refused install costs one manual "Check for updates".
    console.error(
      '[updater] REFUSED quitAndInstall: no verified DUIN download in this session. ' +
        'Run "Check for updates" and let it complete before restarting to install.'
    )
    return {
      ok: false,
      error:
        'The update is not ready to install yet. It may still be downloading, or it was not ' +
        'verified in this session. Wait for the download to finish, then press Restart again.'
    }
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.quitAndInstall()
    return { ok: true }
  } catch (err) {
    console.error('[updater] quitAndInstall failed:', (err as Error).message)
    return { ok: false, error: (err as Error).message }
  }
}

export async function checkNow(): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) {
    return { ok: false, error: 'Updater only runs in packaged builds.' }
  }
  try {
    const { autoUpdater } = await import('electron-updater')
    await autoUpdater.checkForUpdates()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
