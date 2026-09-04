interface SettingsPageProps {
  /** One or two plain sentences on what this page controls. Rendered under the tab title. */
  purpose?: React.ReactNode
  /** Page-level actions (a Refresh, a Clear all), right-aligned on the purpose line. */
  actions?: React.ReactNode
  children: React.ReactNode
}

/**
 * The page frame. The title itself is NOT here: SettingsDialog draws the tab label as the
 * heading, which is what guarantees the heading and the tab never disagree again.
 */
export function SettingsPage({ purpose, actions, children }: SettingsPageProps): React.ReactElement {
  return (
    <div className="space-y-5">
      {(purpose || actions) && (
        <div className="flex items-start justify-between gap-4">
          {purpose ? (
            <p className="max-w-2xl text-[12px] leading-relaxed text-[var(--text-muted)]">{purpose}</p>
          ) : (
            <span />
          )}
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
