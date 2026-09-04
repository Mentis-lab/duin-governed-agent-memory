import type { ToolId } from '@/stores/ui-store'

// One clean, distinct line icon per workspace surface — Lucide/Claude style
// (1.75 stroke, round caps, currentColor so it inherits theme + hover color and
// stays crisp at any size). Replaces the reused baked-in Lamprey PNG assets,
// where ~6 images covered 19 surfaces. Each surface now has a semantically
// distinct glyph. Shared by the Workspace launcher (RightPanelHome) and the
// docked tool header (ToolsPanel) so the icon language is consistent.

const PATHS: Partial<Record<ToolId, React.ReactNode>> = {
  // Library — an open book (dropped docs → searchable brain nodes).
  library: (
    <>
      <path d="M12 6.5C10.5 5.2 8.5 4.5 6 4.5a1 1 0 0 0-1 1V17a1 1 0 0 0 1 1c2.5 0 4.5.7 6 2" />
      <path d="M12 6.5C13.5 5.2 15.5 4.5 18 4.5a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1c-2.5 0-4.5.7-6 2" />
      <line x1="12" y1="6.5" x2="12" y2="20" />
    </>
  ),
  // Automations hub — control sliders (the place you tune background behavior).
  automations: (
    <>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="9" cy="6" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="18" r="2" />
    </>
  ),
  // Explorer — the brain graph: connected nodes (share/network).
  brain: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="10.7" x2="15.4" y2="6.3" />
      <line x1="8.6" y1="13.3" x2="15.4" y2="17.7" />
    </>
  ),
  // Relations — ego view: anchor node, inbound satellites left, outbound right.
  relations: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="4.5" cy="6.5" r="2" />
      <circle cx="4.5" cy="17.5" r="2" />
      <circle cx="19.5" cy="6.5" r="2" />
      <circle cx="19.5" cy="17.5" r="2" />
      <line x1="6.2" y1="7.6" x2="9.5" y2="10.4" />
      <line x1="6.2" y1="16.4" x2="9.5" y2="13.6" />
      <line x1="14.5" y1="10.4" x2="17.8" y2="7.6" />
      <line x1="14.5" y1="13.6" x2="17.8" y2="16.4" />
    </>
  ),
  // Graph Report — connected nodes (network).
  graphReport: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="8" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M7 7l10 1M6.5 8l5 8M17.5 9.5l-4.5 7" />
    </>
  ),
  // Decisions — two diverging paths (a fork in the road; the call you make).
  decisions: (
    <>
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  // Learning — graduation cap.
  learning: (
    <>
      <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
      <path d="M6 12v5c3 3 9 3 12 0v-5" />
    </>
  ),
  // Files — folder.
  files: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  // Artifacts — code.
  artifacts: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </>
  ),
  // Terminal — prompt.
  terminal: (
    <>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </>
  ),
  // Review — git branch.
  review: (
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  // Plan — checklist.
  plan: (
    <>
      <path d="M11 12H3M16 6H3M16 18H3" />
      <path d="m17 9 2 2 4-4" />
    </>
  ),
  // Background tasks — cpu.
  background: (
    <>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
    </>
  ),
  // After action — history (rewind clock).
  afterAction: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  // Sources — stacked layers.
  sources: (
    <>
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </>
  ),
  // Status hub — a house (where things stand).
  // Home — the house: the one surface you come back to.
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </>
  ),
  // Status (folded into Home) — a pulse line: the machine's vitals in detail.
  homeStatus: (
    <>
      <polyline points="3 12 7 12 10 20 14 4 17 12 21 12" />
    </>
  )
}

export function SurfaceIcon({
  id,
  className = 'h-5 w-5'
}: {
  id: ToolId
  className?: string
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {PATHS[id] ?? <circle cx="12" cy="12" r="9" />}
    </svg>
  )
}
