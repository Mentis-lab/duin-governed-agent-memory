import { t } from '@/lib/i18n'
import { useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { useUiStore, type ToolId } from '@/stores/ui-store'
import { useAutomationsStore } from '@/stores/automations-store'
import { useWorkflowsStore } from '@/stores/workflows-store'
import { useNoticesStore } from '@/stores/notices-store'
import { useSkillsStore } from '@/stores/skills-store'
import { SurfaceIcon } from '@/components/icons/SurfaceIcon'
import { RightPanelHeader } from '@/components/layout/RightPanelHeader'

// Icons for the "Recent" strip's three item kinds (automation / workflow / skill).
const KIND_ICON: Record<'automation' | 'workflow' | 'skill', React.ReactNode> = {
  // clock — a scheduled automation
  automation: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  // branching nodes — a workflow run
  workflow: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M6 8v1a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8M12 15v-3" />
    </>
  ),
  // spark — a skill
  skill: <path d="M12 3l1.8 5L19 9.8l-5.2 1.6L12 16l-1.8-4.6L5 9.8l5.2-1.8z" />
}

// Two co-equal rooms: Brain (the mind — comprehension surfaces) and Workbench
// (the hands — the agent/dev tools you act through). Both first-class and always
// visible; the "Recent" strip above is the usage layer on top. Any pill id
// not named in a room falls through to Workbench (never silently dropped).
type Room = 'Brain' | 'Workbench'

const ROOM_MEMBERS: Record<Room, ToolId[]> = {
  Brain: [
    // Status leads the room because it is the ONLY pill that can demand something:
    // renderPill gives `homeStatus` alone a waiting state ("3 waiting on you" / "2 new
    // since you looked") with an accent dot. Sitting eighth, the one surface that knows
    // when it needs you was the last thing you'd read — a notice inbox below the fold is
    // a notice inbox nobody opens. Everything under it is browsable at leisure; this one
    // is not, so it goes where the eye lands first.
    'homeStatus',
    'brain',
    'relations',
    'library',
    'artifacts',
    'decisions',
    'learning',
    'graphReport'
  ],
  // Surface rationalization: connections → Settings; status/calibration/loop/orgs were
  // retired once their panels became hub tabs; browser/environment/people went with the
  // panels only they could open. `files` opens from QuickOpen and `plan` opens itself on
  // a plan-gate transition, so neither wants a pill. `review` is the one thing left
  // reachable only by a chord — give it a pill or retire it, but don't leave it there.
  // Graph Report (brain-analytics) is a Brain-room pill; After Action is a Workbench
  // pill — the Explorer lens bar only filters node lists, so it can't host these.
  Workbench: [
    'terminal',
    'automations',
    'background',
    'afterAction'
  ]
}
const ROOM_ORDER: Room[] = ['Brain', 'Workbench']

interface Pill {
  id: ToolId
  label: string
  description: string
}

// Rounded pill subpanels, each one an entry point into the docked mode
// of the same name. Visual language matches the chat column (rounded-xl +
// border + bg-primary). Removed Memory and Add file cards entirely — the
// user has the chat composer + Skills sidebar + Memory modal for those.
export function RightPanelHome(): React.ReactElement {
  const setActiveTool = useUiStore((s) => s.setActiveTool)
  const openCustomize = useUiStore((s) => s.openCustomize)
  // NOT what the panel opens on — that is the Explorer. This launcher is reached
  // through the titlebar's "Show all surfaces" toggle, so treat it as the overflow
  // drawer it is. The "Recent" strip re-enters the skills / workflows / automations
  // you most recently used; the two rooms (Brain / Workbench) sit below.
  const automations = useAutomationsStore((s) => s.automations)
  const refreshAutomations = useAutomationsStore((s) => s.refresh)
  const workflowRuns = useWorkflowsStore((s) => s.runs)
  const noticeCounts = useNoticesStore((s) => s.counts)
  const skills = useSkillsStore((s) => s.skills)
  const activeSkillIds = useSkillsStore((s) => s.activeSkillIds)
  // Populate automation run-recency (lastRunAt) on mount so the strip has data even
  // before the Automations hub is opened. Skills load at startup; workflow runs
  // accumulate from live progress events — neither needs a fetch here.
  useEffect(() => {
    void refreshAutomations()
  }, [refreshAutomations])

  const pills: Pill[] = [
    {
      // The flagship browsing surface, and first in the room among the surfaces you
      // GO to. Only Status sits above it, because Status is the one that comes to you
      // (see ROOM_MEMBERS). Render order is ROOM_MEMBERS, not this array.
      id: 'brain',
      label: 'Explorer',
      description: 'Folders, files & lenses: navigate your brain graph'
    },
    {
      // Ego-centric relations view — pick an entity and the canvas re-forms
      // around it (inbound left, outbound right); beliefs about it are
      // adjudicated inline (promote/veto) in the drawer.
      id: 'relations',
      label: 'Relations',
      description: 'Ego view of an entity: who connects to what & its beliefs'
    },
    {
      // Document library — drop PDFs / Office docs, they become searchable
      // brain nodes you can view and cite.
      id: 'library',
      label: 'Library',
      description: 'Drop docs: PDFs & Office files become searchable brain nodes'
    },
    {
      // Generated files the assistant authored — HTML pages and Markdown docs —
      // to open, inspect, and save. (Sibling to Library, which holds docs you drop in.)
      id: 'artifacts',
      label: 'Artifacts',
      description: 'HTML & Markdown files the assistant created — open, inspect, save'
    },
    {
      id: 'decisions',
      label: 'Decisions',
      description: 'Make the call: record, resolve & review decisions'
    },
    // 'activeWork' RETIRED 2026-07-27. It was a queue the operator had to open and resolve by
    // hand, and its only real output — closing an owed decision — now happens unattended in
    // brain/decision-loop.ts on the calibration tick. Task tracking is not a surface to check;
    // if something needs a human, it should arrive as a nudge, not wait in a list.
    {
      // What DUIN has learned about you. Learning is automatic now — this is the
      // auditable record of what it promoted, not a review queue.
      id: 'learning',
      label: 'Learning',
      description: 'What DUIN has learned about you — the audit trail'
    },
    {
      // Structural graph analytics — clusters, surprising bridges, hubs, and
      // suggested links across your brain.
      id: 'graphReport',
      label: 'Graph Report',
      description: 'Structure of your brain: clusters, bridges & suggested links'
    },
    {
      // Consolidation hub — machine health (Brain status) + the foresight
      // scoreboard (Calibration), one glanceable surface.
      id: 'homeStatus',
      label: 'Status',
      description: "The machine's health & the foresight scoreboard"
    },
    {
      // One home for every background behavior — schedules, loops, hooks, activity.
      id: 'automations',
      label: 'Automations',
      description: 'Automations, loops, hooks & what fired'
    },
    {
      id: 'terminal',
      label: 'Terminal',
      description: 'PowerShell, Git Bash, WSL, or cmd'
    },
    {
      id: 'background',
      label: 'Background tasks',
      description: 'Live agents, tool calls, wakeups, and scheduled jobs'
    },
    {
      // Per-turn recap — what ran, the signals, and what to fix next.
      id: 'afterAction',
      label: 'After Action',
      description: 'Per-turn recap: what ran, the signals & what to fix'
    }
  ]

  const pillById = new Map(pills.map((p) => [p.id, p]))

  // Two rooms. Brain gets its named members (in order); Workbench gets its named
  // members PLUS any pill not claimed by Brain — so a new/unassigned surface
  // lands in the workbench rather than vanishing.
  const brainIds = new Set<ToolId>(ROOM_MEMBERS.Brain)
  const roomItems: Record<Room, Pill[]> = {
    Brain: ROOM_MEMBERS.Brain.map((id) => pillById.get(id)).filter((p): p is Pill => Boolean(p)),
    Workbench: [
      ...ROOM_MEMBERS.Workbench.map((id) => pillById.get(id)).filter((p): p is Pill => Boolean(p)),
      ...pills.filter((p) => !brainIds.has(p.id) && !ROOM_MEMBERS.Workbench.includes(p.id))
    ]
  }
  const groupedPills = ROOM_ORDER.map((room) => ({ group: room, items: roomItems[room] })).filter(
    (section) => section.items.length > 0
  )

  const SectionHeader = ({ label }: { label: string }) => (
    <div className="mt-2 px-1 text-[12px] font-medium uppercase tracking-wide text-[var(--text-muted)] first:mt-0">
      {label}
    </div>
  )

  const renderPill = (pill: Pill): React.ReactElement => {
    // The pill says WHAT is waiting, not just that something is. A bare count makes
    // the user open the surface to find out whether it mattered.
    const waiting =
      pill.id === 'homeStatus'
        ? noticeCounts.needsDecision > 0
          ? `${noticeCounts.needsDecision} waiting on you`
          : noticeCounts.unread > 0
            ? `${noticeCounts.unread} new since you looked`
            : null
        : null
    return (
      <button
        key={pill.id}
        type="button"
        onClick={() => setActiveTool(pill.id)}
        className="group flex min-h-[58px] shrink-0 items-center gap-3 rounded-xl border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]"
        aria-label={pill.label}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors group-hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] group-hover:text-[var(--accent)]">
          <SurfaceIcon
            id={pill.id}
            className="h-[18px] w-[18px] transition-transform group-hover:scale-110"
          />
          {waiting && (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--bg-primary)] bg-[var(--accent)]"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium text-[var(--text-primary)]">
            {pill.label}
          </span>
          <span
            className={
              'truncate text-[12px] leading-tight ' +
              (waiting ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]')
            }
          >
            {waiting ?? pill.description}
          </span>
        </span>
        <span className="shrink-0 text-[var(--text-muted)] transition-transform group-hover:translate-x-0.5">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
    )
  }

  // "Recent" = the skills / workflows / automations you most recently used.
  // Automations + workflows carry real run-recency; skills have none, so the
  // currently-active ones are appended (ts 0 → they sort after timestamped items).
  const automationItems = automations
    .filter((a) => a.lastRunAt != null)
    .map((a) => ({
      key: `a:${a.id}`,
      kind: 'automation' as const,
      label: a.label,
      ts: a.lastRunAt as number,
      open: () => setActiveTool('automations')
    }))
  const seenWorkflow = new Set<string>()
  const workflowItems = workflowRuns
    // runs is most-recent-first — keep only the latest run per workflow name.
    .filter((r) => (seenWorkflow.has(r.name) ? false : (seenWorkflow.add(r.name), true)))
    .map((r) => ({
      key: `w:${r.runId}`,
      kind: 'workflow' as const,
      label: r.name,
      ts: r.finishedAt ?? r.startedAt,
      open: () => setActiveTool('automations')
    }))
  const skillItems = activeSkillIds.flatMap((id) => {
    const s = skills.find((sk) => sk.id === id)
    return s
      ? [{ key: `s:${s.id}`, kind: 'skill' as const, label: s.name, ts: 0, open: () => openCustomize() }]
      : []
  })
  const recentItems = [...automationItems, ...workflowItems, ...skillItems]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8)

  return (
    <>
      {/* Same title row a surface draws (RightPanelHeader), so the panel chrome
          is the same height whether you are on All Surfaces or inside a surface
          — the bar no longer jumps as you navigate between them. The grid glyph
          matches the SecondaryToolbar control that gets you here. */}
      <RightPanelHeader
        icon={
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
        }
        label={t('All Surfaces')}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
        {recentItems.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <SectionHeader label={t('Recent')} />
            <div className="flex flex-wrap gap-1.5">
              {recentItems.map((item) => (
                <Button variant="secondary" className="flex hover:border-[var(--accent)]"
                  key={item.key}
                  onClick={item.open}
                  title={`${item.kind}: ${item.label}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]">
                    {KIND_ICON[item.kind]}
                  </svg>
                  <span className="max-w-[160px] truncate">{item.label}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
        {groupedPills.map((section) => (
          <div key={section.group} className="flex flex-col gap-2">
            <SectionHeader label={section.group} />
            {section.items.map((pill) => renderPill(pill))}
          </div>
        ))}
      </div>
    </>
  )
}
