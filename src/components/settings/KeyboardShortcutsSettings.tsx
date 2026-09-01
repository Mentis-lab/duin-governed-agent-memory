import { t } from '@/lib/i18n'
import { ShortcutKeys } from '@/components/ui/ShortcutKeys'

// A single, discoverable reference for every keyboard shortcut in the app. These
// are currently FIXED (bound in hooks/useKeyboardShortcuts.ts + the chat composer)
// — this pane makes them visible in one place with readable key-caps, so no one
// has to guess what "Ctrl +" (the near-invisible Ctrl+`) means again.

interface Shortcut {
  combo: string
  label: string
}
interface Section {
  title: string
  items: Shortcut[]
}

const SECTIONS: Section[] = [
  {
    title: 'General',
    items: [
      { combo: 'Ctrl+N', label: 'New conversation' },
      { combo: 'Ctrl+K', label: 'Command palette' },
      { combo: 'Ctrl+B', label: 'Toggle sidebar' },
      { combo: 'Ctrl+,', label: 'Open settings' }
    ]
  },
  {
    title: 'Panels & tools',
    items: [
      { combo: 'Ctrl+P', label: 'Quick-open files' },
      { combo: 'Ctrl+T', label: 'Toggle Browser' },
      { combo: 'Ctrl+`', label: 'Toggle Terminal' },
      { combo: 'Ctrl+Shift+G', label: 'Toggle Review (git)' },
      { combo: 'Ctrl+Shift+M', label: 'Memory browser' },
      { combo: 'Ctrl+Shift+E', label: 'Environment panel' },
      { combo: 'Ctrl+Shift+S', label: 'Sources panel' }
    ]
  },
  {
    title: 'Chat composer',
    items: [
      { combo: 'Enter', label: 'Send message' },
      { combo: 'Shift+Enter', label: 'New line' },
      { combo: 'Ctrl+U', label: 'Attach a file' },
      { combo: 'ArrowUp', label: 'Previous prompt (history)' },
      { combo: 'ArrowDown', label: 'Next prompt (history)' },
      { combo: 'Shift+Tab', label: 'Cycle mode (permissions / plan)' },
      { combo: 'Ctrl+G', label: 'Jump to a chapter' },
      { combo: 'Esc', label: 'Cancel / dismiss' }
    ]
  }
]

export function KeyboardShortcutsSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{t('Keyboard shortcuts')}</h2>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          Every shortcut in one place. These are fixed for now — custom rebinding isn&apos;t
          available yet.
        </p>
      </div>
      {SECTIONS.map((section) => (
        <div key={section.title}>
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {section.title}
          </div>
          <div className="overflow-hidden rounded-lg border border-[var(--panel-border)]">
            {section.items.map((s, i) => (
              <div
                key={s.combo + s.label}
                className={`flex items-center justify-between gap-4 px-3 py-2 ${
                  i > 0 ? 'border-t border-[var(--panel-border)]' : ''
                }`}
              >
                <span className="text-[12px] text-[var(--text-secondary)]">{s.label}</span>
                <ShortcutKeys combo={s.combo} className="shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
