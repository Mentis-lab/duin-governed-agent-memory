import { t } from '@/lib/i18n'
import { ShortcutKeys } from '@/components/ui/ShortcutKeys'
import { SettingsPage, SettingsSection } from '@/components/ui/settings'

// A single, discoverable reference for every keyboard shortcut in the app. These
// are currently FIXED (bound in hooks/shortcut-resolver.ts + the chat composer)
// — this pane makes them visible in one place with readable key-caps, so no one
// has to guess what "Ctrl +" (the near-invisible Ctrl+`) means again.
//
// Labels resolve lazily (inside render) so they follow the UI language.

interface Shortcut {
  combo: string
  label: () => string
}
interface Section {
  id: string
  title: () => string
  items: Shortcut[]
}

const SECTIONS: Section[] = [
  {
    id: 'general',
    title: () => t('General'),
    items: [
      { combo: 'Ctrl+N', label: () => t('New conversation') },
      // Ctrl+K is the global vault + graph search; the workflow palette moved to
      // Ctrl+Shift+K to free it (shortcut-resolver.ts).
      { combo: 'Ctrl+K', label: () => t('Search your brain') },
      { combo: 'Ctrl+Shift+K', label: () => t('Workflow palette') },
      { combo: 'Ctrl+B', label: () => t('Toggle sidebar') },
      { combo: 'Ctrl+,', label: () => t('Open settings') }
    ]
  },
  {
    id: 'panels',
    title: () => t('Panels & tools'),
    items: [
      { combo: 'Ctrl+P', label: () => t('Quick-open files') },
      { combo: 'Ctrl+T', label: () => t('Toggle Browser') },
      { combo: 'Ctrl+`', label: () => t('Toggle Terminal') },
      { combo: 'Ctrl+Shift+G', label: () => t('Toggle Review (git)') },
      { combo: 'Ctrl+Shift+M', label: () => t('Memory browser') },
      { combo: 'Ctrl+Shift+E', label: () => t('Environment panel') },
      { combo: 'Ctrl+Shift+S', label: () => t('Sources panel') }
    ]
  },
  {
    id: 'composer',
    title: () => t('Chat composer'),
    items: [
      { combo: 'Enter', label: () => t('Send message') },
      { combo: 'Shift+Enter', label: () => t('New line') },
      { combo: 'Ctrl+U', label: () => t('Attach a file') },
      { combo: 'ArrowUp', label: () => t('Previous prompt (history)') },
      { combo: 'ArrowDown', label: () => t('Next prompt (history)') },
      { combo: 'Shift+Tab', label: () => t('Cycle mode (permissions / plan)') },
      { combo: 'Ctrl+G', label: () => t('Jump to a chapter') },
      { combo: 'Esc', label: () => t('Cancel / dismiss') }
    ]
  }
]

export function KeyboardShortcutsSettings() {
  return (
    <SettingsPage purpose={t('Every shortcut in one place. Rebinding is not available yet.')}>
      {SECTIONS.map((section) => (
        <SettingsSection key={section.id} label={section.title()}>
          <div className="overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)]">
            {section.items.map((s, i) => (
              <div
                key={s.combo}
                className={`flex items-center justify-between gap-4 px-3 py-2 ${
                  i > 0 ? 'border-t border-[var(--panel-border)]' : ''
                }`}
              >
                <span className="text-[12px] text-[var(--text-secondary)]">{s.label()}</span>
                <ShortcutKeys combo={s.combo} className="shrink-0" />
              </div>
            ))}
          </div>
        </SettingsSection>
      ))}
    </SettingsPage>
  )
}
