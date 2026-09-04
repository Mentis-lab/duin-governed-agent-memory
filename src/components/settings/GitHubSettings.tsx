import { useCallback, useEffect, useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { PRODUCT_REPO_URL } from '@/lib/brand'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { PanelState } from '@/components/ui/PanelState'
import {
  SecretField,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { github as githubClient, invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import type {
  GitHubConnectionStatus,
  GitHubProjectRelease,
  GitHubRepository,
  OAuthLoginResult
} from '@/lib/github-types'
import { toast } from '@/stores/toast-store'
import { useGitHubStore } from '@/stores/github-store'
import { bugReportUrl, canStar, isNewerVersion, repoSlug } from './github-project'

// GitHub — first DUIN's own repository (the release you are on, the bug form, a star), then
// the account DUIN can use to READ the repositories you link as sources (the Sources panel's
// repo link is the one consumer of the token today) and to star as you. The main side owns
// the token; the renderer only ever sees the typed status.
//
// Sign-in paths: the OAuth App bundled into official builds, your own OAuth App (client id +
// secret; callback on localhost:9876 with 9877/9878 as fallbacks — github-service.ts), or the
// gh command-line tool's login. Every github:* handler for clone / push / pull requests still
// exists, but no surface in the app calls them, so the copy here does not promise them.

const SETUP_GUIDE_URL = 'https://github.com/Mentis-lab/duin-governed-agent-memory/blob/main/docs/github-setup.md'
const DEVELOPER_SETTINGS_URL = 'https://github.com/settings/developers'
/** Mirrors CALLBACK_PORTS in electron/services/github-service.ts. */
const CALLBACK_PORTS = [9876, 9877, 9878]
const LINK = 'text-[var(--accent)] underline-offset-2 hover:underline'
const FIELD_LABEL = 'block text-[11px] font-medium text-[var(--text-secondary)]'

function openExternal(url: string): void {
  void githubClient.openInBrowser(url).catch(() => {
    /* the main side toasts when it refuses */
  })
}

/** The version the build pipeline stamped into this bundle, when it did; the main process's
 *  own answer (app.getVersion()) replaces it as soon as the release read lands. */
function buildVersion(): string | null {
  const v = window.api?.app?.build?.version
  return typeof v === 'string' && v && v !== 'unknown' ? v : null
}

export function GitHubSettings(): React.ReactElement {
  const { status, loadingStatus, refreshStatus, refreshRepos, repos, loadingRepos, reposError } = useGitHubStore()
  // The store paints `status: null` both before the first read and after a failed one; `asked`
  // tells the two apart so a failed read renders as a failure, not as a flash of "not connected".
  const [asked, setAsked] = useState(false)
  const [hasClient, setHasClient] = useState<PanelStatus<boolean>>(panelLoading())
  const [hasBundled, setHasBundled] = useState<PanelStatus<boolean>>(panelLoading())
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [savingClient, setSavingClient] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [editingClient, setEditingClient] = useState(false)
  const [release, setRelease] = useState<PanelStatus<GitHubProjectRelease>>(panelLoading())
  const [checking, setChecking] = useState(false)
  const [starred, setStarred] = useState<PanelStatus<boolean>>(panelLoading())
  const [starBusy, setStarBusy] = useState(false)

  useDirtyGuard(
    'settings:github:oauth-app',
    t('the GitHub OAuth App form'),
    clientId.trim() !== '' || clientSecret.trim() !== ''
  )

  const loadStatus = useCallback(async () => {
    await refreshStatus()
    setAsked(true)
  }, [refreshStatus])

  const loadClientFacts = useCallback(async () => {
    const api = window.api?.github
    const [client, bundled] = await Promise.all([
      query<boolean>(t('your GitHub OAuth App'), api?.hasOAuthClient),
      query<boolean>(t('the built-in GitHub app'), api?.hasBundledClient)
    ])
    setHasClient(panelFromResult(client))
    setHasBundled(panelFromResult(bundled))
  }, [])

  // The main side caches the release for ten minutes; `force` is the Check-now button, and the
  // previous answer stays on screen while the new one is on its way.
  const loadRelease = useCallback(async (force: boolean) => {
    if (force) setChecking(true)
    const r = await query<GitHubProjectRelease>(t('the latest release'), () => githubClient.projectRelease(force))
    setRelease(panelFromResult(r))
    if (force) setChecking(false)
  }, [])

  const loadStarred = useCallback(async () => {
    setStarred(panelLoading())
    const r = await query<boolean>(t('the star'), () => githubClient.projectStarred())
    setStarred(panelFromResult(r))
  }, [])

  useEffect(() => {
    void loadStatus()
    void loadClientFacts()
    void loadRelease(false)
  }, [loadStatus, loadClientFacts, loadRelease])

  const connected = status?.connected === true
  useEffect(() => {
    if (connected) void loadStarred()
  }, [connected, loadStarred])

  const handleCheck = async (): Promise<void> => {
    await loadRelease(true)
    // Wake the updater too, so a packaged build with a newer release shows its Download banner.
    // Its answer is not this row's to report: a dev build refuses by design.
    void window.api?.update?.check?.().catch(() => {
      /* logged main-side */
    })
  }

  const handleStar = async (next: boolean): Promise<void> => {
    setStarBusy(true)
    try {
      const value = await invoke<boolean>(next ? t('star the repository') : t('remove the star'), () =>
        githubClient.starProject(next)
      )
      setStarred(panelReady(value))
      toast.success(value ? t('Starred. Thank you.') : t('Star removed.'))
    } catch (e) {
      toast.error(describeError(e, t('Could not change the star.')))
    } finally {
      setStarBusy(false)
    }
  }

  const handleSaveClient = async (): Promise<void> => {
    const id = clientId.trim()
    const secret = clientSecret.trim()
    if (!id || !secret) {
      toast.warning(t('Both the client ID and the client secret are required.'))
      return
    }
    const ok = await ensurePlaintextConsentIfNeeded()
    if (!ok) return
    setSavingClient(true)
    try {
      await invoke(t('save the GitHub OAuth App'), () => githubClient.saveOAuthClient(id, secret))
      toast.success(t('GitHub OAuth App saved.'))
      setHasClient(panelReady(true))
      setClientId('')
      setClientSecret('')
      setEditingClient(false)
    } catch (e) {
      toast.error(describeError(e, t('Could not save the OAuth App.')))
    } finally {
      setSavingClient(false)
    }
  }

  const handleConnect = async (): Promise<void> => {
    setConnecting(true)
    try {
      const result = await invoke<OAuthLoginResult>(t('connect GitHub'), () => githubClient.connect())
      toast.success(tf('Connected as {login}', { login: result.login }))
      await refreshStatus()
      await refreshRepos()
    } catch (e) {
      toast.error(describeError(e, t('GitHub connect failed.')))
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!window.confirm(t('Disconnect GitHub? Git on this computer keeps working.'))) return
    try {
      await invoke(t('disconnect GitHub'), () => githubClient.disconnect())
      toast.success(t('GitHub disconnected.'))
      await refreshStatus()
    } catch (e) {
      toast.error(describeError(e, t('Disconnect failed.')))
    }
  }

  const handleUseGhCli = async (): Promise<void> => {
    try {
      await invoke(t('switch to the gh tool'), () => githubClient.setMode('gh-cli'))
    } catch (e) {
      toast.error(describeError(e, t('Could not switch to the gh tool.')))
      return
    }
    await refreshStatus()
    const st = useGitHubStore.getState().status
    if (st?.connected) {
      toast.success(tf('Using the gh tool as {login}', { login: st.login ?? t('unknown') }))
    } else {
      toast.warning(t('Switched to the gh tool, but it has no login. Run "gh auth login" in a terminal first.'))
    }
  }

  const clientSaved = hasClient.phase === 'ready' && hasClient.data === true
  const bundled = hasBundled.phase === 'ready' ? hasBundled.data : null
  const showByo = showAdvanced || bundled === false
  // A private fork ships with an empty PRODUCT_REPO_URL, and then there is no project section.
  const slug = repoSlug(PRODUCT_REPO_URL)
  const currentVersion = release.phase === 'ready' ? release.data.current : buildVersion()

  return (
    <SettingsPage
      purpose={t('Where DUIN lives on GitHub: the release you are on, the bug form, and a star. A connected account lets DUIN read the repositories you link as sources and star the project as you. Pushing branches and opening pull requests are not part of DUIN today.')}
      actions={
        <Button size="sm" variant="ghost" onClick={() => openExternal(SETUP_GUIDE_URL)}>
          {t('Setup guide')} →
        </Button>
      }
    >
      {slug && (
        <SettingsSection label={t('DUIN on GitHub')}>
          <ReleaseRow
            release={release}
            currentVersion={currentVersion}
            checking={checking}
            onCheck={() => void handleCheck()}
            onRetry={() => void loadRelease(false)}
          />
          <SettingsRow
            label={t('The DUIN repository')}
            hint={
              <>
                <span className="font-mono">{slug}</span> · {t('Source code, releases and the issue tracker.')}
              </>
            }
            control={
              <Button size="sm" onClick={() => openExternal(PRODUCT_REPO_URL)}>
                {t('Open on GitHub')}
              </Button>
            }
          />
          {status?.connected && (
            <StarRow
              starred={starred}
              busy={starBusy}
              allowed={canStar(status.scopes)}
              onToggle={(next) => void handleStar(next)}
              onRetry={() => void loadStarred()}
            />
          )}
          <SettingsRow
            label={t('Report a bug')}
            hint={t('Opens the bug form on GitHub with your DUIN version and platform filled in. Nothing is sent until you submit it there.')}
            control={
              <Button
                size="sm"
                onClick={() => {
                  const url = bugReportUrl(currentVersion, window.api?.app?.platform)
                  if (url) openExternal(url)
                }}
              >
                {t('Report a bug')}
              </Button>
            }
          />
        </SettingsSection>
      )}

      <SettingsSection label={t('Your GitHub account')}>
        {status ? (
          <StatusCard
            status={status}
            loading={loadingStatus}
            onDisconnect={() => void handleDisconnect()}
            onRefresh={() => {
              void loadStatus()
              void refreshRepos()
            }}
          />
        ) : !asked || loadingStatus ? (
          <SettingsLoading what={t('the GitHub connection')} />
        ) : (
          <SettingsLoadError
            what={t('the GitHub connection')}
            message={t('The main process did not answer.')}
            onRetry={() => void loadStatus()}
          />
        )}

        {status?.connected && (
          <RepoCounter repos={repos} loading={loadingRepos} error={reposError} onRefresh={() => void refreshRepos()} />
        )}
      </SettingsSection>

      {status && !status.connected && (
        <SettingsSection label={t('Connect')}>
          {/* Nothing about sign-in paths renders until the main side has said whether this build
              carries a bundled OAuth App; the notice and the BYO form used to flash before it. */}
          <PanelState
            state={hasBundled}
            loading={<SettingsLoading what={t('the sign-in options')} />}
            error={(message, retry) => <SettingsLoadError what={t('the sign-in options')} message={message} onRetry={retry} />}
            empty={null}
            onRetry={() => void loadClientFacts()}
          >
            {(isBundled) =>
              isBundled ? (
                <ConnectWithBundled
                  connecting={connecting}
                  onConnect={() => void handleConnect()}
                  onUseGhCli={() => void handleUseGhCli()}
                  advancedOpen={showAdvanced}
                  onToggleAdvanced={() => setShowAdvanced((v) => !v)}
                />
              ) : (
                <SettingsRow
                  label={t('This copy of DUIN has no built-in GitHub app.')}
                  hint={t('Connect with your own OAuth App below, or use the gh command-line tool if you are signed in there.')}
                  control={
                    <Button size="sm" onClick={() => void handleUseGhCli()}>
                      {t('Use the gh tool')}
                    </Button>
                  }
                />
              )
            }
          </PanelState>

          {showByo && (
            <SettingsRow
              label={t('Bring your own OAuth App')}
              hint={
                <>
                  {t('Register one on GitHub, then paste its client ID and client secret here.')}{' '}
                  <button type="button" className={LINK} onClick={() => openExternal(DEVELOPER_SETTINGS_URL)}>
                    github.com/settings/developers
                  </button>
                </>
              }
            >
              <div className="space-y-3">
                <div>
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {t('Add all three callback URLs to the app; DUIN uses the next port when one is busy:')}
                  </p>
                  <ul className="mt-1 font-mono text-[11px] text-[var(--text-secondary)]">
                    {CALLBACK_PORTS.map((port) => (
                      <li key={port}>{`http://localhost:${port}/callback`}</li>
                    ))}
                  </ul>
                </div>

                {hasClient.phase === 'error' && (
                  <SettingsLoadError
                    what={t('your GitHub OAuth App')}
                    message={hasClient.error}
                    onRetry={() => void loadClientFacts()}
                  />
                )}

                {clientSaved && !editingClient ? (
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-[var(--text-secondary)]">{t('Client credentials saved.')}</span>
                    <Button size="sm" onClick={() => setEditingClient(true)}>
                      {t('Replace')}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label htmlFor="github-client-id" className={FIELD_LABEL}>
                        {t('Client ID')}
                      </label>
                      <Input
                        id="github-client-id"
                        className="font-mono"
                        autoComplete="off"
                        spellCheck={false}
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder={t('Client ID')}
                        disabled={savingClient}
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="github-client-secret" className={FIELD_LABEL}>
                        {t('Client secret')}
                      </label>
                      <SecretField
                        id="github-client-secret"
                        aria-label={t('Client secret')}
                        value={clientSecret}
                        onChange={setClientSecret}
                        onSubmit={() => void handleSaveClient()}
                        placeholder={t('Client secret')}
                        disabled={savingClient}
                      />
                    </div>
                    <p className="text-[11px] text-[var(--text-muted)]">
                      {t('Stored encrypted on this computer and sent only to that provider.')}
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleSaveClient()}
                        disabled={savingClient || !clientId.trim() || !clientSecret.trim()}
                      >
                        {savingClient ? t('Saving…') : t('Save client')}
                      </Button>
                      {clientSaved && (
                        <Button
                          size="sm"
                          onClick={() => {
                            setEditingClient(false)
                            setClientId('')
                            setClientSecret('')
                          }}
                        >
                          {t('Cancel')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-[var(--panel-border)] pt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleConnect()}
                    disabled={connecting || !clientSaved}
                    title={clientSaved ? t('Opens GitHub in your browser to authorize DUIN') : t('Save the OAuth App first')}
                  >
                    {connecting ? t('Waiting for the browser…') : t('Connect with your OAuth App')}
                  </Button>
                </div>
              </div>
            </SettingsRow>
          )}
        </SettingsSection>
      )}
    </SettingsPage>
  )
}

interface ReleaseRowProps {
  release: PanelStatus<GitHubProjectRelease>
  currentVersion: string | null
  checking: boolean
  onCheck: () => void
  onRetry: () => void
}

/** The version you are on beside the latest published release, and the way to re-check. */
function ReleaseRow({ release, currentVersion, checking, onCheck, onRetry }: ReleaseRowProps): React.ReactElement {
  return (
    <SettingsRow
      label={t('Version')}
      hint={
        currentVersion
          ? tf('You are on DUIN v{version}.', { version: currentVersion })
          : t('This build does not report its version.')
      }
      control={
        <Button size="sm" onClick={onCheck} disabled={checking || release.phase === 'loading'}>
          {checking ? t('Checking…') : t('Check now')}
        </Button>
      }
    >
      <PanelState
        state={release}
        loading={<SettingsLoading what={t('the latest release')} />}
        error={(message, retry) => <SettingsLoadError what={t('the latest release')} message={message} onRetry={retry} />}
        empty={null}
        onRetry={onRetry}
      >
        {(latest) => <LatestReleaseLine latest={latest} />}
      </PanelState>
    </SettingsRow>
  )
}

/** One line: is there something newer, when it was published, and the way to its notes. */
function LatestReleaseLine({ latest }: { latest: GitHubProjectRelease }): React.ReactElement {
  const newer = isNewerVersion(latest.current, latest.tag)
  const sentence =
    newer === true
      ? tf('{tag} is available.', { tag: latest.tag })
      : newer === false
        ? t('This is the latest release.')
        : tf('The latest release is {tag}.', { tag: latest.tag })
  const date = latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString() : null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
      <span className={newer === true ? 'font-medium text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>
        {sentence}
      </span>
      {date && <span className="font-mono text-[11px] text-[var(--text-muted)]">{tf('Published {date}', { date })}</span>}
      <button type="button" className={LINK} onClick={() => openExternal(latest.htmlUrl)}>
        {t('Release notes')} →
      </button>
    </div>
  )
}

interface StarRowProps {
  starred: PanelStatus<boolean>
  busy: boolean
  /** False when the token's scopes are known and name neither repo nor public_repo. */
  allowed: boolean
  onToggle: (next: boolean) => void
  onRetry: () => void
}

/** The star, given as the connected account; rendered only while one is connected. */
function StarRow({ starred, busy, allowed, onToggle, onRetry }: StarRowProps): React.ReactElement {
  const control =
    starred.phase === 'ready' ? (
      <Button
        size="sm"
        variant={starred.data ? 'secondary' : 'primary'}
        onClick={() => onToggle(!starred.data)}
        disabled={busy || !allowed}
        aria-pressed={starred.data}
        title={allowed ? undefined : t('The connected token cannot star repositories.')}
      >
        {busy ? t('Saving…') : starred.data ? `★ ${t('Starred')}` : `☆ ${t('Star')}`}
      </Button>
    ) : starred.phase === 'loading' ? (
      <Button size="sm" disabled>
        {t('Checking…')}
      </Button>
    ) : null
  return (
    <SettingsRow
      label={t('Star the repository')}
      hint={
        allowed
          ? t('A star on GitHub helps other people find DUIN. It is given as the account below.')
          : t('The connected token cannot star: it needs the repo or public_repo scope.')
      }
      control={control}
    >
      {starred.phase === 'error' && (
        <SettingsLoadError what={t('the star')} message={starred.error} onRetry={onRetry} />
      )}
    </SettingsRow>
  )
}

function modeLabel(mode: GitHubConnectionStatus['mode']): string {
  if (mode === 'oauth') return t('OAuth token')
  if (mode === 'github_app') return t('GitHub App')
  if (mode === 'gh-cli') return t('gh command-line tool')
  return ''
}

interface StatusCardProps {
  status: GitHubConnectionStatus
  loading: boolean
  onDisconnect: () => void
  onRefresh: () => void
}

/** The one card for the connection: who is signed in (or that nobody is), how, and the way out. */
function StatusCard({ status, loading, onDisconnect, onRefresh }: StatusCardProps): React.ReactElement {
  const dot = status.connected ? 'bg-[var(--success)]' : status.reason ? 'bg-[var(--warning)]' : 'bg-[var(--text-muted)]'
  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-3">
          {status.avatarUrl ? (
            <img
              src={status.avatarUrl}
              alt=""
              width={32}
              height={32}
              className="rounded-full border border-[var(--panel-border)]"
            />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--panel-border)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              <GitHubGlyph />
            </span>
          )}
          <span className="flex items-center gap-2">
            <span aria-hidden className={`inline-block h-2 w-2 rounded-full ${dot}`} />
            <span className="font-mono">{status.connected ? `@${status.login}` : t('Not connected')}</span>
            {status.connected && (
              <span className="font-mono text-[11px] font-normal text-[var(--text-muted)]">{modeLabel(status.mode)}</span>
            )}
          </span>
        </span>
      }
      hint={
        <>
          {status.connected && status.scopes.length > 0 && (
            <span className="block font-mono text-[11px]">{tf('Access: {scopes}', { scopes: status.scopes.join(', ') })}</span>
          )}
          {!status.connected && status.reason && <span className="block text-[var(--warning)]">{status.reason}</span>}
          {status.connected && <span className="block">{t('Stored encrypted on this computer and sent only to that provider.')}</span>}
        </>
      }
      control={
        <>
          <Button size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? t('Refreshing…') : t('Refresh')}
          </Button>
          {status.connected && (
            <Button size="sm" variant="danger" onClick={onDisconnect}>
              {t('Disconnect')}
            </Button>
          )}
        </>
      }
    />
  )
}

interface RepoCounterProps {
  repos: GitHubRepository[]
  loading: boolean
  error: string | null
  onRefresh: () => void
}

function RepoCounter({ repos, loading, error, onRefresh }: RepoCounterProps): React.ReactElement {
  return (
    <SettingsRow
      label={t('Accessible repositories')}
      hint={loading ? t('Loading…') : error ? error : tf('{n} repositories visible to this account', { n: repos.length })}
      control={
        <Button size="sm" onClick={onRefresh} disabled={loading}>
          {t('Refresh repo list')}
        </Button>
      }
    />
  )
}

interface ConnectWithBundledProps {
  connecting: boolean
  onConnect: () => void
  onUseGhCli: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
}

function ConnectWithBundled({
  connecting,
  onConnect,
  onUseGhCli,
  advancedOpen,
  onToggleAdvanced
}: ConnectWithBundledProps): React.ReactElement {
  return (
    <SettingsRow
      label={t('Connect with DUIN')}
      hint={t('Authorize in your browser. DUIN asks for read:user and repo access.')}
      control={
        <>
          <Button variant="primary" size="sm" onClick={onConnect} disabled={connecting}>
            {connecting ? t('Waiting for the browser…') : t('Connect GitHub')}
          </Button>
          <Button size="sm" onClick={onUseGhCli}>
            {t('Use the gh tool')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onToggleAdvanced} aria-expanded={advancedOpen}>
            {advancedOpen ? t('Hide advanced') : t('Advanced')}
          </Button>
        </>
      }
    />
  )
}

function GitHubGlyph(): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  )
}
