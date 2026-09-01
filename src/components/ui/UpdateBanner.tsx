import { t, tf } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { invoke } from '@/lib/ipc-client'
import { describeError, type IpcEnvelope } from '@/lib/result'

interface UpdateInfo {
  version: string | null
  releaseNotes: string | null
}

/** Fallback for a refusal that arrived without a reason of its own. */
export const RESTART_NOT_READY =
  'The update is not ready to install yet. Try Restart again in a moment.'

/** Fallback for a refused download (no verified offer in this session, or a failed fetch). */
export const DOWNLOAD_FAILED = 'The update could not be downloaded. Run "Check for updates" and try again.'

/** Which action the banner offers. `available` → Download (release M11: the updater is
 *  notify-only until builds are signed, so fetching is the operator's click); `downloaded` →
 *  Restart. PURE, exported for the node-only test. */
export type UpdatePhase = 'available' | 'downloading' | 'downloaded'
export function bannerAction(phase: UpdatePhase): 'download' | 'downloading' | 'restart' {
  if (phase === 'downloaded') return 'restart'
  if (phase === 'downloading') return 'downloading'
  return 'download'
}

/** The Download click with React taken out (same convention as attemptRestart). Resolves to the
 *  phase the banner should show next: 'downloading' when the main process accepted the request
 *  (update-downloaded will move it on), 'available' again on a refusal — with the reason shown. */
export async function attemptDownload(
  download: (() => Promise<IpcEnvelope<unknown> | undefined>) | undefined,
  setNotice: (message: string | null) => void
): Promise<UpdatePhase> {
  setNotice(null)
  try {
    await invoke('download update', download)
    return 'downloading'
  } catch (cause) {
    setNotice(describeError(cause, DOWNLOAD_FAILED))
    return 'available'
  }
}

/** The Restart click with React taken out, so it can be tested.
 *
 *  This banner goes up on `update-available`, which fires the moment the feed confirms a release —
 *  the ~100-300 MB artifact has only just started downloading behind it. updater.ts's
 *  quitAndInstall() refuses to install until THIS session verified a completed download, so a
 *  Restart click during that window is refused, and the refusal used to end in a main-process
 *  console line: the handler answered success:true regardless and `onClick={() => restart()}`
 *  discarded the answer anyway. Nothing on screen changed, which is precisely what a restart that
 *  is *about* to happen also looks like — so the operator had no way to learn the click did
 *  nothing, and clicking again did nothing again.
 *
 *  invoke() throws on success:false, so the refusal cannot be dropped silently a second time.
 *
 *  Exported rather than inlined because this repo's vitest env is node-only: renderer behaviour is
 *  covered through pure exported helpers (same convention as LoopSettings.tsx / ChannelsSettings.tsx). */
export async function attemptRestart(
  restart: (() => Promise<IpcEnvelope<unknown> | undefined>) | undefined,
  setNotice: (message: string | null) => void
): Promise<void> {
  setNotice(null)
  try {
    await invoke('install update', restart)
  } catch (cause) {
    setNotice(describeError(cause, RESTART_NOT_READY))
  }
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<UpdatePhase>('available')
  const [dismissed, setDismissed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!window.api) return
    window.api.update.onAvailable((payload) => {
      setInfo(payload as UpdateInfo)
      setPhase('available')
      setDismissed(false)
      // Both handlers clear the notice: the background check re-fires every 6h while an update is
      // pending, so a "not ready yet" line from an earlier click must not ride along with a fresh
      // banner — and by `update-downloaded` the install is genuinely possible, which makes that
      // same line actively wrong.
      setNotice(null)
    })
    window.api.update.onDownloaded((payload) => {
      setInfo((prev) => prev ?? { version: (payload as { version: string | null }).version, releaseNotes: null })
      setPhase('downloaded')
      setDismissed(false)
      setNotice(null)
    })
  }, [])

  if (!info || dismissed) return null
  const action = bannerAction(phase)

  return (
    <div className="border-b border-[var(--accent)] bg-[var(--accent-dim)] px-4 py-2 text-[12px] text-[var(--text-primary)]">
      <div className="flex items-center justify-between gap-3">
        <span>
          {action === 'restart'
            ? tf('Update downloaded{version} - restart to install.', { version: info.version ? ` (v${info.version})` : '' })
            : tf('Update available{version} - download it when you are ready. This build is unsigned; the release notes list its SHA-256.', { version: info.version ? ` (v${info.version})` : '' })}
        </span>
        <div className="flex items-center gap-2">
          {action === 'restart' ? (
            <Button
              onClick={() => void attemptRestart(() => window.api.update.restart(), setNotice)}
              variant="primary"
              size="sm"
            >
              {t('Restart')}
            </Button>
          ) : (
            <Button
              onClick={() => {
                setPhase('downloading')
                void attemptDownload(() => window.api.update.download(), setNotice).then(setPhase)
              }}
              variant="primary"
              size="sm"
              disabled={action === 'downloading'}
            >
              {action === 'downloading' ? t('Downloading…') : t('Download')}
            </Button>
          )}
          <button
            onClick={() => setDismissed(true)}
            title={t('Dismiss')}
            className="rounded p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      {notice ? (
        <div role="status" className="mt-1 pr-6 text-[var(--text-muted)]">
          {notice}
        </div>
      ) : null}
    </div>
  )
}
