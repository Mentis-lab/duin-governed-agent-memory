interface SettingsSectionProps {
  /** Already-translated, sentence case; rendered as a small uppercase label. */
  label: string
  description?: React.ReactNode
  /** Right-aligned on the label line (a Probe all, a count). */
  actions?: React.ReactNode
  children: React.ReactNode
}

export function SettingsSection({ label, description, actions, children }: SettingsSectionProps): React.ReactElement {
  return (
    <section className="space-y-2" aria-label={label}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">{description}</p>}
      <div className="space-y-2">{children}</div>
    </section>
  )
}
