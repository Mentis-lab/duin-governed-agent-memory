import { useSettingsStore } from '@/stores/settings-store'
import { t } from '@/lib/i18n'
import { THEME_PRESETS } from '@/styles/theme-presets'
import type { ThemePreset } from '@/lib/types'
import { BRAIN_GRAPH_SCHEMES } from '@/duin/lib/graph-schemes'

// Base font-size (px) presets. 14 = 100% UI scale; applied via Electron native page
// zoom (webFrame.setZoomFactor) so the WHOLE interface scales — chrome, sidebar, panels,
// and content alike (see applyFontScale in styles/apply-theme).
const FONT_SIZE_OPTIONS: ReadonlyArray<{ label: string; px: number }> = [
  { label: 'S', px: 12 },
  { label: 'M', px: 14 },
  { label: 'L', px: 16 },
  { label: 'XL', px: 18 },
  { label: 'XXL', px: 20 }
]

// Chat transcript reading size (px), applied as the `--chat-font-size` CSS var that
// markdown.css's `.chat-md` and the composer both read.
//
// This is NOT the control above. That one is page zoom, so it scales chrome and content
// together and cannot change how large the transcript reads RELATIVE to its own menus —
// which is precisely what people mean when they say the chat text is too small. The var
// existed but was a hardcoded constant with no writer, so nothing could move it.
const CHAT_FONT_SIZE_OPTIONS: ReadonlyArray<{ label: string; px: number }> = [
  { label: 'S', px: 12 },
  { label: 'M', px: 14 },
  { label: 'L', px: 16 },
  { label: 'XL', px: 18 },
  { label: 'XXL', px: 20 }
]

export function AppearanceSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const handleSelect = async (preset: ThemePreset) => {
    if (settings.themePreset === preset.id) return
    await updateSettings({ themePreset: preset.id })
  }

  const isDark = settings.themeMode === 'dark'

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Appearance')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Color presets affect interface tokens only. Layout and accessibility structure remain
          unchanged.
        </p>
      </div>

      <div>
        <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('Mode')}
        </div>
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]">
          <button
            onClick={() => updateSettings({ themeMode: 'light' })}
            aria-pressed={!isDark}
            className={`px-3 py-1.5 text-[12px] transition-colors ${
              !isDark
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            {t('Light')}
          </button>
          <button
            onClick={() => updateSettings({ themeMode: 'dark' })}
            aria-pressed={isDark}
            className={`px-3 py-1.5 text-[12px] transition-colors ${
              isDark
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
          >
            {t('Dark')}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {THEME_PRESETS.map((preset) => {
          const active = settings.themePreset === preset.id
          return (
            <button
              key={preset.id}
              onClick={() => handleSelect(preset)}
              aria-pressed={active}
              className={`flex flex-col items-stretch gap-2 rounded border bg-[var(--bg-primary)] p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                active
                  ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                  : 'border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]'
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono text-[12px] font-medium text-[var(--text-primary)]">
                  {preset.name}
                </span>
                {active && (
                  <span className="rounded bg-[var(--accent-dim)] px-1.5 py-0.5 text-[12px] uppercase tracking-wider text-[var(--accent)]">
                    {t('Active')}
                  </span>
                )}
              </div>
              <span className="text-[12px] text-[var(--text-muted)]">{preset.source}</span>
              <div className="flex items-center gap-1">
                {preset.swatch.map((color, idx) => (
                  <span
                    key={`${preset.id}-${idx}`}
                    title={color}
                    className="block h-4 w-4 rounded-full border border-black/40"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </button>
          )
        })}
      </div>

      <div>
        <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('Font size')}
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          {t('Scales the entire interface — menu, sidebar, and panels included.')}
        </p>
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]">
          {FONT_SIZE_OPTIONS.map((opt) => {
            const active = (settings.fontSize ?? 14) === opt.px
            return (
              <button
                key={opt.px}
                onClick={() => {
                  if (!active) updateSettings({ fontSize: opt.px })
                }}
                aria-pressed={active}
                title={`${opt.px}px base`}
                className={`px-3 py-1.5 text-[12px] transition-colors ${
                  active
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('Chat text size')}
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Sizes the conversation only — what you type, what streams back, and the stored
          reply, all at one size.
        </p>
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]">
          {CHAT_FONT_SIZE_OPTIONS.map((opt) => {
            const active = (settings.chatFontSize ?? 12) === opt.px
            return (
              <button
                key={opt.px}
                onClick={() => {
                  if (!active) updateSettings({ chatFontSize: opt.px })
                }}
                aria-pressed={active}
                title={`${opt.px}px transcript`}
                className={`px-3 py-1.5 text-[12px] transition-colors ${
                  active
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('Brain graph')}
        </div>
        <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Color scheme for the home brain graph. Recolors node + link palette
          live; layout is unchanged.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {BRAIN_GRAPH_SCHEMES.map((scheme) => {
            const active = (settings.brainGraphScheme ?? 'default') === scheme.id
            return (
              <button
                key={scheme.id}
                onClick={() => {
                  if (active) return
                  updateSettings({ brainGraphScheme: scheme.id })
                }}
                aria-pressed={active}
                className={`flex flex-col items-stretch gap-2 rounded border bg-[var(--bg-primary)] p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                  active
                    ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                    : 'border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-mono text-[12px] font-medium text-[var(--text-primary)]">
                    {scheme.name}
                  </span>
                  {active && (
                    <span className="rounded bg-[var(--accent-dim)] px-1.5 py-0.5 text-[12px] uppercase tracking-wider text-[var(--accent)]">
                      {t('Active')}
                    </span>
                  )}
                </div>
                <span className="text-[12px] text-[var(--text-muted)]">{scheme.source}</span>
                <div className="flex items-center gap-1">
                  {scheme.swatch.map((color, idx) => (
                    <span
                      key={`${scheme.id}-${idx}`}
                      title={color}
                      className="block h-4 w-4 rounded-full border border-black/40"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
