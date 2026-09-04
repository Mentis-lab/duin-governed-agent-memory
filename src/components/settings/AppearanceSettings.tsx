import { useSettingsStore } from '@/stores/settings-store'
import { t, tf } from '@/lib/i18n'
import { cn } from '@/duin/lib/utils'
import { THEME_PRESETS } from '@/styles/theme-presets'
import type { ThemePresetId } from '@/lib/types'
import { BRAIN_GRAPH_SCHEMES, type BrainGraphSchemeId } from '@/duin/lib/graph-schemes'
import { SettingsPage, SettingsSection, SettingsRow } from '@/components/ui/settings'
import { flashWhenSaved, useSavedFlash } from '@/components/ui/settings/useSavedFlash'

// The three text sizes share one step list but are three different settings:
//
//   fontSize     — base size (px); 14 = 100%. Applied as Electron page zoom
//                  (webFrame.setZoomFactor), so the WHOLE interface scales.
//   chatFontSize — the transcript only, via the `--chat-font-size` CSS var
//                  (markdown.css `.chat-md` + the composer). Page zoom cannot change
//                  how large the transcript reads RELATIVE to its own menus, which is
//                  what people mean when they say the chat text is too small.
//   docFontSize  — a document being READ, via `--doc-font-size` (`.doc-md`: the note
//                  read view, a note in its own window, the Library reader, the
//                  artifact markdown viewer). Runs one size larger than chat by
//                  default: a document is read, not scanned.
const SIZE_OPTIONS: ReadonlyArray<{ label: string; px: number }> = [
  { label: 'S', px: 12 },
  { label: 'M', px: 14 },
  { label: 'L', px: 16 },
  { label: 'XL', px: 18 },
  { label: 'XXL', px: 20 }
]

// What each colour preset looks like, in the operator's words. `preset.source` is
// provenance ("ArcGIS Blue 3") and is not user copy.
const PRESET_DESCRIPTION: Record<ThemePresetId, () => string> = {
  'duin-warm': () => t('Warm paper with a clay accent'),
  'arcgis-blue': () => t('Cool blue'),
  'lamprey-mint': () => t('Forest green with a mint accent'),
  'lamprey-default': () => t('Blue on black')
}

const SCHEME_DESCRIPTION: Record<BrainGraphSchemeId, () => string> = {
  default: () => t('The original DUIN palette'),
  aurora: () => t('Blue, purple and teal'),
  ember: () => t('Red, orange and amber'),
  mono: () => t('Grayscale, minimal')
}

interface Choice<V extends string | number> {
  value: V
  label: string
  title?: string
}

/** A single-choice setting as a segmented control on the right of its row. Auto-applies. */
function SegmentedRow<V extends string | number>({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string
  hint?: React.ReactNode
  value: V
  options: ReadonlyArray<Choice<V>>
  onChange: (next: V) => Promise<boolean | void> | boolean | void
}): React.ReactElement {
  const { saved, flash } = useSavedFlash()
  return (
    <SettingsRow
      label={label}
      hint={hint}
      saved={saved}
      control={
        <div
          role="radiogroup"
          aria-label={label}
          className="inline-flex overflow-hidden rounded-md border border-[var(--panel-border)]"
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={String(opt.value)}
                type="button"
                role="radio"
                aria-checked={active}
                title={opt.title}
                onClick={() => {
                  if (!active) flashWhenSaved(onChange(opt.value), flash)
                }}
                className={cn(
                  'px-3 py-1.5 text-[12px] transition-colors',
                  active
                    ? 'bg-[var(--accent)] text-[var(--on-accent)]'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      }
    />
  )
}

/** One palette card: name, plain description, swatch row. */
function PaletteCard({
  name,
  description,
  swatch,
  active,
  onSelect
}: {
  name: string
  description: string
  swatch: string[]
  active: boolean
  onSelect: () => void
}): React.ReactElement {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        'flex flex-col items-stretch gap-2 rounded-lg border bg-[var(--bg-primary)] p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        active ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]' : 'border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]'
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">{name}</span>
        {active && (
          <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--accent)]">
            {t('Active')}
          </span>
        )}
      </div>
      <span className="text-[12px] text-[var(--text-muted)]">{description}</span>
      <div className="flex items-center gap-1" aria-hidden>
        {swatch.map((color, idx) => (
          <span
            key={`${name}-${idx}`}
            className="block h-4 w-4 rounded-full border border-[var(--panel-border)]"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
    </button>
  )
}

const sizeChoices = (title: (px: number) => string): Choice<number>[] =>
  SIZE_OPTIONS.map((opt) => ({ value: opt.px, label: opt.label, title: title(opt.px) }))

export function AppearanceSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const presetFlash = useSavedFlash()
  const schemeFlash = useSavedFlash()

  const mode: 'light' | 'dark' = settings.themeMode === 'dark' ? 'dark' : 'light'
  const activeScheme = settings.brainGraphScheme ?? 'default'

  return (
    <SettingsPage purpose={t('Colours, light or dark, and text sizes.')}>
      <SettingsSection label={t('Colours')}>
        <SegmentedRow
          label={t('Mode')}
          value={mode}
          options={[
            { value: 'light', label: t('Light') },
            { value: 'dark', label: t('Dark') }
          ]}
          onChange={(next) => updateSettings({ themeMode: next })}
        />
        <SettingsRow label={t('Colour preset')} saved={presetFlash.saved}>
          <div role="radiogroup" aria-label={t('Colour preset')} className="grid grid-cols-2 gap-3">
            {THEME_PRESETS.map((preset) => (
              <PaletteCard
                key={preset.id}
                name={t(preset.name)}
                description={PRESET_DESCRIPTION[preset.id]?.() ?? ''}
                swatch={preset.swatch}
                active={settings.themePreset === preset.id}
                onSelect={() => {
                  if (settings.themePreset === preset.id) return
                  flashWhenSaved(updateSettings({ themePreset: preset.id }), presetFlash.flash)
                }}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label={t('Text size')}>
        <SegmentedRow
          label={t('Font size')}
          hint={t('Scales the entire interface — menu, sidebar, and panels included.')}
          value={settings.fontSize ?? 14}
          options={sizeChoices((px) => tf('{px}px base', { px }))}
          onChange={(px) => updateSettings({ fontSize: px })}
        />
        <SegmentedRow
          label={t('Chat text size')}
          hint={t('Sizes the conversation only: what you type, what streams back, and the stored reply, all at one size.')}
          value={settings.chatFontSize ?? 12}
          options={sizeChoices((px) => tf('{px}px chat text', { px }))}
          onChange={(px) => updateSettings({ chatFontSize: px })}
        />
        <SegmentedRow
          label={t('Document text size')}
          hint={t(
            'Sizes documents you read — a note, a note in its own window, a Library document, an artifact. Headings, code and tables scale with it.'
          )}
          value={settings.docFontSize ?? 16}
          options={sizeChoices((px) => tf('{px}px document text', { px }))}
          onChange={(px) => updateSettings({ docFontSize: px })}
        />
      </SettingsSection>

      <SettingsSection label={t('Brain graph')}>
        <SettingsRow
          label={t('Graph colours')}
          hint={t('The colour scheme of the brain graph on Home. Nodes and links recolour live; the layout does not change.')}
          saved={schemeFlash.saved}
        >
          <div role="radiogroup" aria-label={t('Graph colours')} className="grid grid-cols-2 gap-3">
            {BRAIN_GRAPH_SCHEMES.map((scheme) => (
              <PaletteCard
                key={scheme.id}
                name={t(scheme.name)}
                description={SCHEME_DESCRIPTION[scheme.id]?.() ?? ''}
                swatch={scheme.swatch}
                active={activeScheme === scheme.id}
                onSelect={() => {
                  if (activeScheme === scheme.id) return
                  flashWhenSaved(updateSettings({ brainGraphScheme: scheme.id }), schemeFlash.flash)
                }}
              />
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPage>
  )
}
