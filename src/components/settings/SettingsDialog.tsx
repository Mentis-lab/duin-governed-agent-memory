import { lazy, Suspense, useState } from 'react'
import { t } from '@/lib/i18n'
import { IconButton } from '@/components/ui/IconButton'
// ConnectionsPanel's lazy import is gone with its tab. Left as a comment rather than
// silently dropped: the component and its IPC still exist and are now unreferenced, so
// the reachability lint will count them as dead surface — which is the accurate reading,
// not a regression to paper over.
const ChannelsSettings = lazy(() => import('./ChannelsSettings').then((m) => ({ default: m.ChannelsSettings })));
const AgentsSettings = lazy(() => import('./AgentsSettings').then((m) => ({ default: m.AgentsSettings })));
const NotificationsSettings = lazy(() => import('./NotificationsSettings').then((m) => ({ default: m.NotificationsSettings })));
const GeneralSettings = lazy(() => import('./GeneralSettings').then((m) => ({ default: m.GeneralSettings })));
const PersonalitySettings = lazy(() => import('./PersonalitySettings').then((m) => ({ default: m.PersonalitySettings })));
const FoundationsSettings = lazy(() => import('./FoundationsSettings').then((m) => ({ default: m.FoundationsSettings })));
const AppearanceSettings = lazy(() => import('./AppearanceSettings').then((m) => ({ default: m.AppearanceSettings })));
const KeyboardShortcutsSettings = lazy(() => import('./KeyboardShortcutsSettings').then((m) => ({ default: m.KeyboardShortcutsSettings })));
const ModelSettings = lazy(() => import('./ModelSettings').then((m) => ({ default: m.ModelSettings })));
const BrainSettings = lazy(() => import('./BrainSettings').then((m) => ({ default: m.BrainSettings })));
const ApiKeySettings = lazy(() => import('./ApiKeySettings').then((m) => ({ default: m.ApiKeySettings })));
const AgenticCodingSettings = lazy(() => import('./AgenticCodingSettings').then((m) => ({ default: m.AgenticCodingSettings })));
const HooksSettings = lazy(() => import('./HooksSettings').then((m) => ({ default: m.HooksSettings })));
const WorkflowsSettings = lazy(() => import('./WorkflowsSettings').then((m) => ({ default: m.WorkflowsSettings })));
const WebToolsSettings = lazy(() => import('./WebToolsSettings').then((m) => ({ default: m.WebToolsSettings })));
const CurrentInfoSettings = lazy(() => import('./CurrentInfoSettings').then((m) => ({ default: m.CurrentInfoSettings })));
const ImageGenSettings = lazy(() => import('./ImageGenSettings').then((m) => ({ default: m.ImageGenSettings })));
const PermissionsSettings = lazy(() => import('./PermissionsSettings').then((m) => ({ default: m.PermissionsSettings })));
const PlanGoalSettings = lazy(() => import('./PlanGoalSettings').then((m) => ({ default: m.PlanGoalSettings })));
const GitHubSettings = lazy(() => import('./GitHubSettings').then((m) => ({ default: m.GitHubSettings })));
const RagSettings = lazy(() => import('./RagSettings').then((m) => ({ default: m.RagSettings })));
const SnipSettings = lazy(() => import('./SnipSettings').then((m) => ({ default: m.SnipSettings })));
const PersistenceSettings = lazy(() => import('./PersistenceSettings').then((m) => ({ default: m.PersistenceSettings })));
const ExecutorSettings = lazy(() => import('./ExecutorSettings').then((m) => ({ default: m.ExecutorSettings })));
// Engine wraps the three former single-knob tabs (Streaming & Timeouts,
// Reasoning Audit, Seed budget) into one Advanced tab.
const EngineSettings = lazy(() => import('./EngineSettings').then((m) => ({ default: m.EngineSettings })));
import { useUiStore, type SettingsTabId } from '@/stores/ui-store'

interface SettingsDialogProps {
  onClose: () => void
}

// Grouped for non-coders: plain-language essentials + workspace first;
// developer tooling tucked under a collapsed "Advanced" disclosure so the
// 20-odd panels don't read as a wall of jargon on day one.
const GROUPS = [
  {
    title: 'Essentials',
    tabs: [
      { id: 'general', label: 'General' },
      { id: 'personality', label: 'Personality' },
      { id: 'foundations', label: 'Foundations' },
      { id: 'brain', label: 'Brain' },
      // 'sources' (Connections) was removed from this list on the operator's call.
      // The panel component still exists and is NOT deleted here — deleting a working
      // surface is a separate decision from taking it off the menu. Note the
      // consequence honestly: Settings was its ONLY route, so it is now unreachable.
      // Restore the row here to bring it back, or delete ConnectionsPanel and its IPC
      // in a change that says so.
      { id: 'channels', label: 'Channels' },
      // Channels runs a two-way turn out; Agents is something else DRIVING DUIN —
      // another agent borrowing its judgment. The reason Agents sits in this run rather
      // than under Advanced: everything in Advanced is a knob, this is an authority
      // surface, deciding who may act as you.
      { id: 'agents', label: 'Agents' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'models', label: 'Models' },
      { id: 'api', label: 'API Keys' }
    ]
  },
  {
    title: 'Workspace',
    tabs: [
      { id: 'appearance', label: 'Appearance' },
      { id: 'shortcuts', label: 'Shortcuts' },
      { id: 'workflows', label: 'Workflows' },
      { id: 'permissions', label: 'Permissions' }
    ]
  },
  {
    title: 'Advanced',
    tabs: [
      { id: 'agenticCoding', label: 'Coding Mode' },
      { id: 'executors', label: 'Executors' },
      { id: 'github', label: 'GitHub' },
      { id: 'hooks', label: 'Hooks' },
      { id: 'webTools', label: 'Web Tools' },
      { id: 'currentInfo', label: 'Current Info' },
      { id: 'imageGen', label: 'Image Gen' },
      { id: 'planGoal', label: 'Plans & Goals' },
      { id: 'rag', label: 'RAG' },
      { id: 'snip', label: 'Snip' },
      { id: 'engine', label: 'Engine' },
      { id: 'persistence', label: 'Persistence' }
    ]
  }
] as const

// GROUPS is `as const`, so each `g.tabs` is a distinct readonly tuple; spreading
// them into a single array gives flatMap a shared element type to infer from.
const TABS = GROUPS.flatMap((g) => [...g.tabs])
// The active tab can be any panel id in GROUPS, plus the legacy deep-link
// aliases ('automations' / 'loops') that the ui-store may pass in as the
// initial tab — both resolve to the Workflows panel below.
type TabId = (typeof TABS)[number]['id'] | SettingsTabId
const ADVANCED_IDS = new Set<string>([
  ...GROUPS.flatMap((g) => (g.title === 'Advanced' ? g.tabs.map((t) => t.id) : [])),
  // Legacy deep-link ids that now resolve into the Advanced "Engine" tab.
  'timeouts',
  'seedBudget'
])

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const initialTab = useUiStore((s) => s.settingsInitialTab)
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? 'general')
  const confirmDiscard = useUiStore((s) => s.confirmDiscard)
  const clearDirty = useUiStore((s) => s.clearDirty)
  const dirtyPanes = useUiStore((s) => s.dirtyPanes)

  // U3. Every page below is mounted CONDITIONALLY, so switching tabs UNMOUNTS the
  // current one — which is how a BRAIN.md / SOUL.md / ME.md / GOALS.md draft was
  // destroyed by a single click on another tab, with no confirm. Ask first, and on
  // discard drop the registrations for the tab being left (the draft mirror in
  // sessionStorage still holds the text either way).
  const selectTab = (id: TabId): void => {
    if (id === activeTab) return
    if (!confirmDiscard('settings:')) return
    for (const paneId of Object.keys(dirtyPanes)) {
      if (paneId.startsWith('settings:')) clearDirty(paneId)
    }
    setActiveTab(id)
  }
  // Open the Advanced group automatically when settings is opened straight to
  // an advanced tab (e.g. via a deep link); otherwise it starts collapsed.
  const [showAdvanced, setShowAdvanced] = useState<boolean>(
    initialTab ? ADVANCED_IDS.has(initialTab) : false
  )

  return (
    // Full-screen view matching the Customize surface (fixed inset-0,
    // flex column, opaque app background) rather than a centered modal
    // overlay. The previous centered black/60 dialog is replaced by a
    // full-window panel with a top breadcrumb/close row.
    <div className="fixed inset-0 z-30 flex flex-col bg-[var(--bg-primary)]">
      {/* Breadcrumb / close row — mirrors CustomizeView's header so the
          back affordance returns to the previous view. */}
      <div className="app-full-window-top-row flex h-12 shrink-0 items-center gap-2 px-4">
        <button
          onClick={onClose}
          aria-label={t('Back to chat')}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[14px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>{t('Settings')}</span>
        </button>
        <div className="flex-1" />
        <IconButton
          onClick={onClose}
          aria-label={t('Close')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </IconButton>
      </div>

      {/* Body — sidebar (grouped tabs) + content, filling the full window. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Sidebar — grouped, with developer tooling under a collapsed
            "Advanced" disclosure so non-coders aren't met with a tab wall. */}
        <div className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-[var(--panel-border)] bg-[var(--bg-secondary)] py-2">
          {GROUPS.map((group) => {
            const advanced = group.title === 'Advanced'
            const open = !advanced || showAdvanced
            return (
              <div key={group.title} className="mb-1">
                {advanced ? (
                  <button
                    onClick={() => setShowAdvanced((v) => !v)}
                    className="flex w-full items-center justify-between px-4 py-1.5 text-left font-mono text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                  >
                    <span>{t(group.title)}</span>
                    <span aria-hidden>{showAdvanced ? '▾' : '▸'}</span>
                  </button>
                ) : (
                  <div className="px-4 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                    {t(group.title)}
                  </div>
                )}
                {open &&
                  group.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => selectTab(tab.id)}
                      className={`block w-full px-4 py-2 text-left font-mono text-[12px] transition-colors ${
                        activeTab === tab.id
                          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {t(tab.label)}
                    </button>
                  ))}
              </div>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-6 py-6">
            {/* Settings pages are code-split; each loads when its tab is opened. */}
            <Suspense fallback={<div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}>
            {activeTab === 'general' && <GeneralSettings />}
            {activeTab === 'personality' && <PersonalitySettings />}
            {activeTab === 'foundations' && <FoundationsSettings />}
            {activeTab === 'shortcuts' && <KeyboardShortcutsSettings />}
            {activeTab === 'models' && <ModelSettings />}
            {activeTab === 'brain' && <BrainSettings />}
            {activeTab === 'channels' && <ChannelsSettings />}
            {activeTab === 'agents' && <AgentsSettings />}
            {activeTab === 'notifications' && <NotificationsSettings />}
            {activeTab === 'agenticCoding' && <AgenticCodingSettings />}
            {activeTab === 'executors' && <ExecutorSettings />}
            {activeTab === 'api' && <ApiKeySettings />}
            {activeTab === 'github' && <GitHubSettings />}
            {activeTab === 'appearance' && <AppearanceSettings />}
            {activeTab === 'webTools' && <WebToolsSettings />}
            {activeTab === 'currentInfo' && <CurrentInfoSettings />}
            {activeTab === 'imageGen' && <ImageGenSettings />}
            {activeTab === 'permissions' && <PermissionsSettings />}
            {activeTab === 'planGoal' && <PlanGoalSettings />}
            {activeTab === 'hooks' && <HooksSettings />}
            {(activeTab === 'workflows' || activeTab === 'automations' || activeTab === 'loops') && (
              <WorkflowsSettings />
            )}
            {activeTab === 'rag' && <RagSettings />}
            {activeTab === 'snip' && <SnipSettings />}
            {/* Engine wraps the three former single-knob tabs; the legacy
                'timeouts'/'seedBudget' deep-link ids resolve here too. */}
            {(activeTab === 'engine' || activeTab === 'timeouts' || activeTab === 'seedBudget') && (
              <EngineSettings />
            )}
            {activeTab === 'persistence' && <PersistenceSettings />}
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  )
}
