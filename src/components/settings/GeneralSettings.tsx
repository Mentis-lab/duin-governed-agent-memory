import { useSettingsStore } from '@/stores/settings-store'
import { t } from '@/lib/i18n'
import { toast } from '@/stores/toast-store'
import { Toggle } from '@/components/ui/Toggle'
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

  const writePaths = settings.sandboxWritePaths ?? []

  const addWritePath = async (): Promise<void> => {
    const picking = pickFolder()
    if (!picking) {
      toast.error('Folder picker is only available in the desktop app.')
      return
    }
    const r = await picking
    if (!r.success) {
      toast.error(r.error ?? 'Folder picker failed')
      return
    }
    if (r.data == null) return // cancelled
    if (writePaths.some((p) => p === r.data)) return // already listed
    // The main process re-vets this list (operator-write-paths.ts refuses your home
    // folder and system roots), so a bad pick fails closed there; here we just persist
    // the operator's intent through the same updateSettings path every field uses.
    await updateSettings({ sandboxWritePaths: [...writePaths, r.data] })
  }

  const removeWritePath = async (target: string): Promise<void> => {
    await updateSettings({ sandboxWritePaths: writePaths.filter((p) => p !== target) })
  }

  return (
    <div className="space-y-5">
      <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('General')}</h3>

      <section className="space-y-3">
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Language')}
        </h4>
        {/* This one setting drives BOTH the interface language and the reply directive.
            The old copy ("Reply language … Auto leaves it to the model") described only
            the reply half — while zh.json's `Auto` entry (跟随系统) had already committed
            to the follow-the-system reading. Say what actually happens. */}
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          {t('The language of DUIN’s interface and replies. Auto follows your system language for the interface and lets replies match the language you write in. Pin English, 中文, or 日本語 to fix both. Code, file paths, and identifiers always stay as written.')}
        </p>
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]">
          {LANGUAGE_OPTIONS.map((opt) => {
            const active = (settings.language ?? 'auto') === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => {
                  if (!active) updateSettings({ language: opt.value })
                }}
                aria-pressed={active}
                className={`px-3 py-1.5 text-[12px] transition-colors ${
                  active
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                {opt.label()}
              </button>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Conversation titles')}
        </h4>
        <label className="flex cursor-pointer items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]">
          <Toggle
            checked={settings.aiGeneratedTitles}
            onChange={(v) => updateSettings({ aiGeneratedTitles: v })}
            aria-label={t('AI-generated titles')}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="block font-medium text-[var(--text-primary)]">{t('AI-generated titles')}</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">
              After the first response, ask your active model for a 3-5 word title. Without it
              we use the first 40 characters of your opening message.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Application')}
        </h4>
        <label className="flex cursor-pointer items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]">
          <Toggle
            checked={settings.minimizeToTray}
            onChange={(v) => updateSettings({ minimizeToTray: v })}
            aria-label={t('Minimize to tray when closing')}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="block font-medium text-[var(--text-primary)]">{t('Minimize to tray on close')}</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">
              Closing the window hides DUIN to the system tray instead of quitting, so it keeps
              running in the background. Quit from the tray menu.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]">
          <Toggle
            checked={settings.autoCheckUpdates}
            onChange={(v) => updateSettings({ autoCheckUpdates: v })}
            aria-label={t('Automatically check for updates')}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="block font-medium text-[var(--text-primary)]">{t('Automatically check for updates')}</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t('Periodically check for a newer DUIN release in the background. Off leaves updates manual.')}
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Computer access')}
        </h4>
        <label className="flex cursor-pointer items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]">
          <Toggle
            checked={settings.fullComputerAccess === true}
            onChange={(v) => updateSettings({ fullComputerAccess: v })}
            aria-label={t('Full computer access')}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="block font-medium text-[var(--text-primary)]">{t('Full computer access')}</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">
              Off by default. When on, DUIN acts as a general computer-use agent: it can read,
              write, move, and delete files anywhere on this computer — Desktop, Documents, other
              drives — with no folders to add, and run shell commands without asking, on every turn
              including messages from connected channels. Deletes and moves are reversible (they go
              to your vault&apos;s .trash), and OS-destroying commands (format, rm -rf /) are always
              blocked. Leave it off to confine DUIN to your vault, active workspace, and the specific
              folders you list below, with a prompt before commands and destructive file changes.
            </span>
          </span>
        </label>
        {settings.fullComputerAccess !== true && (
          <div className="space-y-2">
            <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
              Confined mode: folders outside your vault that DUIN may act in. The same allowlist
              governs the file browser, the agent&apos;s file tools, and the sandboxed shell. Your
              home folder and system directories cannot be added.
            </p>
            {writePaths.length === 0 ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('No folders added — DUIN can act only inside your vault.')}
              </p>
            ) : (
              writePaths.map((p) => (
                <div
                  key={p}
                  className="flex items-center gap-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2"
                >
                  <span
                    className="flex-1 truncate font-mono text-[12px] text-[var(--text-secondary)]"
                    title={p}
                  >
                    {p}
                  </span>
                  <button
                    onClick={() => removeWritePath(p)}
                    aria-label={`Remove ${p}`}
                    className="rounded px-2 py-0.5 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  >
                    {t('Remove')}
                  </button>
                </div>
              ))
            )}
            <button
              onClick={addWritePath}
              className="rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              + Add folder…
            </button>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Hooks')}
        </h4>
        {/* Release M11 (A4 F8): `enableHooks` existed as a setting (default ON — the three seeded
            hooks are audit logs + a destructive-command guard, hooks-seed.ts) but had no switch
            anywhere in the UI. hooks-runner reads `enableHooks === false` as the hard-disable. */}
        <label className="flex cursor-pointer items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)]">
          <Toggle
            checked={settings.enableHooks !== false}
            onChange={(v) => updateSettings({ enableHooks: v })}
            aria-label={t('Run lifecycle hooks')}
            className="mt-0.5"
          />
          <span className="flex-1">
            <span className="block font-medium text-[var(--text-primary)]">{t('Run lifecycle hooks')}</span>
            <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">
              {t('Small scripts that run at session start, before and after each tool call, and when an agent stops. The three DUIN ships are read-only audit logs plus a guard that blocks obviously destructive shell commands; they run in a locked-down JavaScript sandbox with no file or network access. Creating or editing a hook always asks you first. Turn this off to disable every hook, including your own.')}
            </span>
          </span>
        </label>
      </section>

      {/* macOS only — renders nothing elsewhere. */}
      <FullDiskAccessRow />
    </div>
  )
}
