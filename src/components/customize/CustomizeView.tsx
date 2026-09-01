import { t } from '@/lib/i18n'
import { useState, type ReactNode } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { useUiStore, type CustomizeColumnId } from '@/stores/ui-store'
import { SkillsColumn } from './SkillsColumn'
import { MethodsColumn } from './MethodsColumn'
import { ConnectorsColumn } from './ConnectorsColumn'
import { PluginsColumn } from './PluginsColumn'
import { NewSkillWizard } from './NewSkillWizard'

interface ColumnDef {
  id: CustomizeColumnId
  label: string
  description: string
}

const COLUMNS: ColumnDef[] = [
  { id: 'skills', label: 'Skills', description: 'Your authored Markdown skills' },
  { id: 'methods', label: 'Methods', description: 'Skill compositions from your brain (type: method)' },
  { id: 'connectors', label: 'Connectors', description: 'MCP servers DUIN can call' },
  { id: 'plugins', label: 'Plugins', description: 'Bundled skill + connector packs' }
]

const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c])) as Record<CustomizeColumnId, ColumnDef>

// Row 1 = the capability surfaces you author (skills, then the methods that compose
// them); row 2 = the external plumbing (connectors, plugins). The scripting engine
// behind Settings → Workflows is a separate, developer-facing surface and is not
// part of this grid.
const ROWS: CustomizeColumnId[][] = [
  ['skills', 'methods'],
  ['connectors', 'plugins']
]

function renderColumnBody(id: CustomizeColumnId): ReactNode {
  switch (id) {
    case 'skills':
      return <SkillsColumn />
    case 'methods':
      return <MethodsColumn />
    case 'connectors':
      return <ConnectorsColumn />
    case 'plugins':
      return <PluginsColumn />
    default:
      return null
  }
}

export function CustomizeView() {
  const closeCustomize = useUiStore((s) => s.closeCustomize)
  const initialColumn = useUiStore((s) => s.customizeInitialColumn)
  const [wizardOpen, setWizardOpen] = useState(false)

  // Highlighting only — every column renders all the time so the panel
  // shows the full surface at a glance, matching the Claude Code layout.
  const focusColumn: CustomizeColumnId = initialColumn ?? 'skills'

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[var(--bg-primary)]">
      {/* Breadcrumb / close row */}
      <div className="app-full-window-top-row flex h-12 shrink-0 items-center gap-2 px-4">
        <button
          onClick={closeCustomize}
          aria-label={t('Back to chat')}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[14px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{t('Customize')}</span>
        </button>
        <div className="flex-1" />
        <IconButton
          onClick={closeCustomize}
          aria-label={t('Close')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </IconButton>
      </div>

      {/* Page heading */}
      <div className="shrink-0 px-6 pt-6">
        <h1 className="font-serif text-[26px] font-semibold tracking-tight text-[var(--text-primary)]">
          {t('Customize DUIN')}
        </h1>
        <p className="mt-1 text-[14px] text-[var(--text-secondary)]">
          Skills are what DUIN knows how to do, and methods compose them into a way of
          working. Connectors and plugins are what it can reach.
        </p>
        <div className="mt-3 rounded-md border border-[var(--accent-dim)] bg-[var(--accent-dim)]/10 px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
          New here? Try{' '}
          <button
            onClick={() => setWizardOpen(true)}
            className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {t('Create new skills')}
          </button>{' '}
          to scaffold your first skill in three steps, or browse the bundled plugins below.
        </div>
      </div>

      {/* Two-by-two body — Skills/Methods, then Connectors/Plugins. The whole area
          scrolls vertically when the rows get tall; each column also scrolls internally.
          Every column owns its own New/Add/Install/Import action, so no bottom CTA row. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
        {ROWS.map((row, rowIdx) => (
          <div key={rowIdx} className="flex shrink-0 gap-4">
            {row.map((id) => {
              const col = COLUMN_BY_ID[id]
              return (
                <section
                  key={id}
                  aria-label={col.label}
                  className={`flex h-[44vh] min-h-[280px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-[var(--bg-secondary)] ${
                    focusColumn === id ? 'border-[var(--accent)]' : 'border-[var(--panel-border)]'
                  }`}
                >
                  <header className="shrink-0 px-4 py-3">
                    <div className="text-[14px] font-semibold text-[var(--text-primary)]">
                      {col.label}
                    </div>
                    <div className="text-[12px] text-[var(--text-secondary)]">{col.description}</div>
                  </header>
                  <div className="min-h-0 flex-1 overflow-y-auto">{renderColumnBody(id)}</div>
                </section>
              )
            })}
          </div>
        ))}
      </div>

      {wizardOpen && <NewSkillWizard onClose={() => setWizardOpen(false)} />}
    </div>
  )
}
