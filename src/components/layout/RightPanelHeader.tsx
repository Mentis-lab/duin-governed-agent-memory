// The one title row every right-panel state renders.
//
// The panel has two header render paths — a surface (ToolsPanel) and the All
// Surfaces launcher (RightPanelHome) — and before this component only the
// surface path drew a title row. Navigating between them therefore changed the
// height of the panel chrome (36px of SecondaryToolbar on the launcher, 36 + 48
// on a surface), so the bar visibly jumped. Both paths now render through here,
// which is the only place the height is written down: it cannot drift again
// without moving. `shrink-0` pins it, so a tall body can never squeeze it either.
interface RightPanelHeaderProps {
  icon: React.ReactNode
  label: string
  // Trailing controls (e.g. a surface's close button). Omitted where the state
  // has nothing to act on — the row keeps its height regardless.
  actions?: React.ReactNode
}

export function RightPanelHeader({
  icon,
  label,
  actions
}: RightPanelHeaderProps): React.ReactElement {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between pl-3 pr-[28px] text-[16px] font-medium text-[var(--text-secondary)]">
      <span className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center text-[var(--text-secondary)]">
          {icon}
        </span>
        {label}
      </span>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  )
}
