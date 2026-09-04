import { useSettingsStore } from '@/stores/settings-store'
import { t, tf } from '@/lib/i18n'
import { toast } from '@/stores/toast-store'
import { cn } from '@/duin/lib/utils'
import { Button } from '@/components/ui/Button'
import { SettingsPage, SettingsSection, SettingsRow, ToggleRow, SettingsLink } from '@/components/ui/settings'
import { flashWhenSaved, useSavedFlash } from '@/components/ui/settings/useSavedFlash'
import { FullDiskAccessRow } from './FullDiskAccessRow'

/** Native single-folder picker (same one the brain-folder setting uses). Returns the chosen
 *  absolute path, or null on cancel. Present only in the desktop app. */
function pickFolder(): Promise<{ success: boolean; data?: string | null; error?: string }> | undefined {
  const api = (window as unknown as {
    api?: { brain?: { pickFolder?: () => Promise<{ success: boolean; data?: string | null; error?: string }> } }
  }).api?.brain
  return api?.pickFolder?.()
}

// Labels resolve lazily (inside render, via label()): 'Auto' translates to the
// follow-the-OS reading (跟随系统/システムに従う); the language names label
// themselves in their own script and never translate.
const LANGUAGE_OPTIONS: { value: 'auto' | 'en' | 'zh' | 'ja'; label: () => string }[] = [
  { value: 'auto', label: () => t('Auto') },
  { value: 'en', label: () => 'English' },
  { value: 'zh', label: () => '中文' },
  { value: 'ja', label: () => '日本語' }
]

export function GeneralSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const languageFlash = useSavedFlash()

  const language = settings.language ?? 'auto'
  const fullAccess = settings.fullComputerAccess === true
  const writePaths = settings.sandboxWritePaths ?? []

  const addWritePath = async (): Promise<void> => {
    const picking = pickFolder()
    if (!picking) {
      toast.error(t('The folder picker is only available in the desktop app.'))
      return
    }
    const r = await picking
    if (!r.success) {
      toast.error(r.error ?? t('The folder picker failed'))
      return
    }
    if (r.data == null) return // cancelled
    if (writePaths.some((p) => p === r.data)) return // already listed
    // The main process re-vets this list (operator-write-paths.ts skips your home
    // folder and system roots at read time), so a bad pick fails closed there; here we
    // just persist the operator's intent through the same updateSettings path every
    // field uses.
    await updateSettings({ sandboxWritePaths: [...writePaths, r.data] })
  }

  const removeWritePath = (target: string): Promise<boolean> =>
    updateSettings({ sandboxWritePaths: writePaths.filter((p) => p !== target) })

  return (
    <SettingsPage purpose={t('Language, window behaviour, and how much of this computer DUIN may touch.')}>
      <SettingsSection label={t('Language')}>
        {/* This one setting drives BOTH the interface language and the reply directive.
            The old copy ("Reply language … Auto leaves it to the model") described only
            the reply half — while zh.json's `Auto` entry (跟随系统) had already committed
            to the follow-the-system reading. Say what actually happens. */}
        <SettingsRow
          label={t('Interface and reply language')}
          hint={t('The language of DUIN’s interface and replies. Auto follows your system language for the interface and lets replies match the language you write in. Pin English, 中文, or 日本語 to fix both. Code, file paths, and identifiers always stay as written.')}
          saved={languageFlash.saved}
          control={
            <div
              role="radiogroup"
              aria-label={t('Interface and reply language')}
              className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]"
            >
              {LANGUAGE_OPTIONS.map((opt) => {
                const active = language === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      if (!active) flashWhenSaved(updateSettings({ language: opt.value }), languageFlash.flash)
                    }}
                    className={cn(
                      'px-3 py-1.5 text-[12px] transition-colors',
                      active
                        ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                        : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                    )}
                  >
                    {opt.label()}
                  </button>
                )
              })}
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection label={t('Conversation titles')}>
        <ToggleRow
          label={t('AI-generated titles')}
          hint={t('After the first reply, DUIN asks your active model for a 3–5 word title. Off uses the first 40 characters of your opening message.')}
          checked={settings.aiGeneratedTitles}
          onChange={(v) => updateSettings({ aiGeneratedTitles: v })}
        />
      </SettingsSection>

      <SettingsSection label={t('Application')}>
        <ToggleRow
          label={t('Minimize to tray on close')}
          hint={t('Closing the window hides DUIN in the system tray and keeps it running in the background. Quit from the tray menu.')}
          checked={settings.minimizeToTray}
          onChange={(v) => updateSettings({ minimizeToTray: v })}
        />
        <ToggleRow
          label={t('Automatically check for updates')}
          hint={t('Periodically check for a newer DUIN release in the background. Off leaves updates manual.')}
          checked={settings.autoCheckUpdates}
          onChange={(v) => updateSettings({ autoCheckUpdates: v })}
        />
      </SettingsSection>

      <SettingsSection label={t('Computer access')}>
        {/* The hint describes what is on screen in EACH state: the folder list below only
            exists while access is off, so the "on" copy must not point at it. */}
        <ToggleRow
          label={t('Full computer access')}
          tone={fullAccess ? 'warning' : 'default'}
          checked={fullAccess}
          onChange={(v) => updateSettings({ fullComputerAccess: v })}
          hint={
            <>
              {fullAccess
                ? t('DUIN can read, write, move and delete files anywhere on this computer and run commands without asking, on every turn, including messages from connected channels. Deleted and moved files go to your vault’s .trash, and commands that could destroy the operating system are always blocked. Turn it off to confine DUIN to your vault, workspace and the folders you choose.')
                : t('Off: DUIN acts only inside your vault, your workspace and the folders listed below, and asks before running commands or making destructive file changes. On: it can read, write, move and delete files anywhere on this computer and run commands without asking, on every turn, including messages from connected channels. Deleted files still go to your vault’s .trash, and commands that could destroy the operating system are always blocked.')}{' '}
              <SettingsLink tab="permissions">{t('Tool permissions')}</SettingsLink>
            </>
          }
        />
        {!fullAccess && (
          <SettingsRow
            label={t('Folders DUIN may act in')}
            hint={t('Folders outside your vault that DUIN may read and change. The same list governs the file browser, DUIN’s file tools and the shell. Your home folder and system folders cannot be added; choose a folder inside them.')}
            control={<Button onClick={() => void addWritePath()}>{t('Add folder…')}</Button>}
          >
            {writePaths.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('No folders added. DUIN acts only inside your vault and workspace.')}
              </p>
            ) : (
              <ul className="space-y-1">
                {writePaths.map((p) => (
                  <li
                    key={p}
                    className="flex items-center gap-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-1.5"
                  >
                    <span className="flex-1 truncate font-mono text-[12px] text-[var(--text-secondary)]" title={p}>
                      {p}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={tf('Remove {path}', { path: p })}
                      onClick={() => void removeWritePath(p)}
                    >
                      {t('Remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection label={t('Hooks')}>
        {/* `enableHooks` defaults ON (the three seeded hooks are audit logs + a destructive-
            command guard, hooks-seed.ts); hooks-runner reads `enableHooks === false` as the
            hard-disable. */}
        <ToggleRow
          label={t('Run lifecycle hooks')}
          hint={
            <>
              {t('Small scripts that run at session start, around each tool call, and when an agent stops. DUIN ships three: two audit logs and a guard that blocks obviously destructive commands. Off disables every hook, including your own.')}{' '}
              <SettingsLink tab="hooks">{t('Manage hooks')}</SettingsLink>
            </>
          }
          checked={settings.enableHooks !== false}
          onChange={(v) => updateSettings({ enableHooks: v })}
        />
      </SettingsSection>

      {/* macOS only — renders nothing elsewhere. */}
      <FullDiskAccessRow />
    </SettingsPage>
  )
}
