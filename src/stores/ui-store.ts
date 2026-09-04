import { startTransition } from 'react'
import { create } from 'zustand'
import {
  applyUserToggle,
  getConvState,
  tryAutoOpen,
  type RightPanelConvState
} from '@/lib/right-panel-state'
import { addDirty, removeDirty, shouldDiscard, type DirtyPanes } from '@/lib/dirty-guard'

const SIDEBAR_WIDTH_KEY = 'lamprey.ui.sidebarWidth'
const SIDEBAR_COLLAPSED_KEY = 'lamprey.ui.sidebarCollapsed'
const RIGHT_WIDTH_KEY = 'lamprey.ui.rightPanelWidth'
const RIGHT_COLLAPSED_KEY = 'lamprey.ui.rightPanelCollapsed'
const PERMISSIONS_KEY = 'lamprey.ui.permissionsMode'
const CONV_FILTERS_KEY = 'lamprey.ui.convFilters'
const ACTIVE_SHELL_KEY = 'lamprey.ui.activeShell'
// Fluidity J11: per-conversation right-panel state. Persisted as a single
// JSON blob so the panel remembers each conv's last expand/collapse state
// across reloads + tracks the dismissed-trigger set so an auto-open
// doesn't re-pop after the user closes it.
const RIGHT_PANEL_BY_CONV_KEY = 'lamprey.ui.rightPanelByConv'
const RECENT_TOOLS_KEY = 'lamprey.ui.recentTools'
const MAX_RECENT_TOOLS = 8

export type PermissionsMode = 'default' | 'auto-review' | 'full'

export type ToolId =
  | 'files'
  | 'review'
  | 'terminal'
  | 'sources'
  | 'artifacts'
  | 'plan'
  | 'background'
  | 'afterAction'
  | 'brain'
  | 'learning'
  | 'automations'
  | 'graphReport'
  | 'decisions'
  | 'library'
  // Consolidation hub (surface rationalization 2026-07-07): owns a launcher
  // pill and wraps the existing folded panels as tabs.
  | 'homeStatus'
  | 'home'
  // Relations (seam-edges surface, 2026-08-13): ego-centric entity/belief view
  // over the persistent entity plane, with govern actions in its drawer.
  | 'relations'

export type ShellKind = 'powershell' | 'cmd' | 'git-bash' | 'wsl'

function readShell(): ShellKind {
  if (typeof window === 'undefined') return 'powershell'
  const raw = window.localStorage?.getItem(ACTIVE_SHELL_KEY)
  if (raw === 'powershell' || raw === 'cmd' || raw === 'git-bash' || raw === 'wsl') return raw
  return 'powershell'
}

export type ConvStatus = 'active' | 'all'
export type ConvProject = 'all'
export type ConvEnvironment = 'all'
export type ConvLastActivity = 'all' | 'today' | 'week' | 'month'
export type ConvGroupBy = 'none' | 'date' | 'model'
export type ConvSortBy = 'recency' | 'created' | 'az' | 'za'

export interface ConvFilters {
  status: ConvStatus
  project: ConvProject
  environment: ConvEnvironment
  lastActivity: ConvLastActivity
  groupBy: ConvGroupBy
  sortBy: ConvSortBy
}

const DEFAULT_CONV_FILTERS: ConvFilters = {
  status: 'active',
  project: 'all',
  environment: 'all',
  lastActivity: 'all',
  groupBy: 'date',
  sortBy: 'recency'
}

function readConvFilters(): ConvFilters {
  if (typeof window === 'undefined') return DEFAULT_CONV_FILTERS
  try {
    const raw = window.localStorage?.getItem(CONV_FILTERS_KEY)
    if (!raw) return DEFAULT_CONV_FILTERS
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_CONV_FILTERS, ...parsed }
  } catch {
    return DEFAULT_CONV_FILTERS
  }
}

function readPermissions(): PermissionsMode {
  if (typeof window === 'undefined') return 'default'
  const raw = window.localStorage?.getItem(PERMISSIONS_KEY)
  if (raw === 'auto-review' || raw === 'full' || raw === 'default') return raw
  return 'default'
}

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 400
const SIDEBAR_DEFAULT = 240
const RIGHT_MIN = 280
// Raised from 640: the right panel is where HTML artifacts are previewed and
// edited, and 640 was below what the surface itself asks for — ArtifactPanel's
// Visual mode requests 760 on entry and was silently clamped back to 640, so
// "drag to expand" hit a wall well before the page was readable. The viewport
// clamp below still guarantees the center column keeps CENTER_MIN.
const RIGHT_MAX = 1100
const RIGHT_DEFAULT = 420

// The center column (brain graph + composer / chat) is the focal surface; it
// must never be starved below this by a wide sidebar + right panel. Panel widths
// are clamped against the viewport so `sidebar + center(min) + right + chrome`
// always fits. CHROME ≈ 3 × --panel-gap (8) + the chat column's p-2 (16).
const CENTER_MIN = 400
const PANEL_CHROME = 40

/** Max width one panel may take given the OTHER panel's width and the viewport,
 *  keeping the center column ≥ CENTER_MIN. Falls back to the static cap when
 *  there's no window (SSR) or plenty of room. */
function viewportPanelMax(staticMax: number, otherWidth: number): number {
  if (typeof window === 'undefined') return staticMax
  const room = window.innerWidth - otherWidth - CENTER_MIN - PANEL_CHROME
  return Math.max(SIDEBAR_MIN, Math.min(staticMax, room))
}

function readNumber(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage?.getItem(key)
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function readRightPanelByConv(): Record<string, RightPanelConvState> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage?.getItem(RIGHT_PANEL_BY_CONV_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, RightPanelConvState>
  } catch {
    return {}
  }
}

function writeRightPanelByConv(byConv: Record<string, RightPanelConvState>): void {
  try {
    window.localStorage?.setItem(RIGHT_PANEL_BY_CONV_KEY, JSON.stringify(byConv))
  } catch {
    // ignore quota / unavailable
  }
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback
  const raw = window.localStorage?.getItem(key)
  if (raw === null || raw === undefined) return fallback
  return raw === '1' || raw === 'true'
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value)
  } catch {
    // ignore quota / unavailable
  }
}

/** Recently-opened surfaces, most-recent-first — powers the dashboard's "Recent"
 *  strip and lets the launcher lean on actual usage. Persisted as a JSON id list. */
function loadRecentTools(): ToolId[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage?.getItem(RECENT_TOOLS_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as ToolId[]) : []
  } catch {
    return []
  }
}

function pushRecent(list: ToolId[], tool: ToolId): ToolId[] {
  const next = [tool, ...list.filter((t) => t !== tool)].slice(0, MAX_RECENT_TOOLS)
  writeLocal(RECENT_TOOLS_KEY, JSON.stringify(next))
  return next
}

export type SettingsTabId =
  | 'general'
  | 'personality'
  | 'foundations'
  | 'shortcuts'
  | 'models'
  | 'agenticCoding'
  | 'executors'
  | 'api'
  | 'github'
  | 'appearance'
  | 'webTools'
  | 'currentInfo'
  | 'imageGen'
  | 'permissions'
  | 'planGoal'
  | 'hooks'
  | 'notifications'
  | 'brain'
  | 'channels'
  | 'agents'
  | 'rag'
  | 'snip'
  | 'engine'
  | 'persistence'
  | 'automations'
  | 'loops'
  | 'workflows'
  | 'timeouts'
  | 'seedBudget'

export type CustomizeColumnId = 'skills' | 'methods' | 'connectors' | 'plugins'

interface UiState {
  /** U3 — panes holding unsaved edits, id → human label. Consulted by every
   *  dismissal path (closeSettings, Settings tab buttons, brain setDetail, the
   *  titlebar close button). Before this, the app had NO dirty-state guard at all. */
  dirtyPanes: DirtyPanes
  markDirty: (id: string, label: string) => void
  clearDirty: (id: string) => void
  /** True when it is safe to proceed. `scope` is an id prefix (e.g. 'settings:')
   *  so one surface's dismissal does not prompt about another's draft. */
  confirmDiscard: (scope?: string) => boolean
  searchQuery: string
  searchFocusToken: number
  settingsOpen: boolean
  settingsInitialTab: SettingsTabId | null
  /** Customize Phase C1: a top-level full-window surface (Skills /
   *  Connectors / Plugins) reachable from the sidebar. Replaces the
   *  legacy "Plugins" sidebar shortcut that used to deep-link into
   *  Settings → MCP. */
  customizeOpen: boolean
  customizeInitialColumn: CustomizeColumnId | null
  projectViewId: string | null
  memoryOpen: boolean
  composeDraft: string
  composeSeedToken: number
  /** Fluidity J4: when ChatInput opens the memory modal via the `#…`
   *  shortcut, it seeds the description here and bumps the token. The
   *  MemoryPanel reads + clears the seed on the first matching render. */
  memorySeedDescription: string
  memorySeedToken: number
  sidebarCollapsed: boolean
  sidebarWidth: number
  rightPanelCollapsed: boolean
  rightPanelWidth: number
  // Fluidity J11: per-conversation right-panel state. The mirrored global
  // `rightPanelCollapsed` above reflects the active conv's collapsed
  // value; the map preserves every other conv's last state so switching
  // back restores it.
  rightPanelByConv: Record<string, RightPanelConvState>
  /** Conversation whose right-panel state is mirrored to the global flag.
   *  App.tsx updates this in lockstep with the active conversation. */
  activeRightPanelConvId: string | null
  permissionsMode: PermissionsMode
  activeTool: ToolId | null
  /** Recently-opened surfaces, most-recent-first (capped, persisted). */
  recentTools: ToolId[]
  setActiveTool: (tool: ToolId | null) => void
  closeActiveTool: () => void
  toggleTool: (tool: ToolId) => void
  activeShell: ShellKind
  setActiveShell: (kind: ShellKind) => void
  quickOpenVisible: boolean
  openQuickOpen: () => void
  closeQuickOpen: () => void
  toggleQuickOpen: () => void
  workflowPaletteVisible: boolean
  openWorkflowPalette: () => void
  closeWorkflowPalette: () => void
  toggleWorkflowPalette: () => void
  /** Cmd/Ctrl+K global search command palette (Phase 2: search-only). */
  globalSearchVisible: boolean
  openGlobalSearch: () => void
  closeGlobalSearch: () => void
  toggleGlobalSearch: () => void
  worktreeModalOpen: boolean
  openWorktreeModal: () => void
  closeWorktreeModal: () => void
  planMode: boolean
  togglePlanMode: () => void
  setPlanMode: (v: boolean) => void
  requestedOpenFilePath: string | null
  requestedOpenFileToken: number
  requestOpenFile: (path: string) => void
  convFilters: ConvFilters
  setConvFilters: (partial: Partial<ConvFilters>) => void
  resetConvFilters: () => void
  setSearchQuery: (q: string) => void
  requestSearchFocus: () => void
  openSettings: (tab?: SettingsTabId) => void
  closeSettings: () => void
  toggleSettings: () => void
  openCustomize: (column?: CustomizeColumnId) => void
  closeCustomize: () => void
  openProjectView: (projectId: string) => void
  closeProjectView: () => void
  openMemory: () => void
  closeMemory: () => void
  toggleMemory: () => void
  seedComposeDraft: (text: string) => void
  consumeComposeDraft: () => string
  /** Seed the memory editor's description slot + open the modal. */
  seedMemoryDescription: (text: string) => void
  /** Read + clear the seed atomically. */
  consumeMemorySeedDescription: () => string
  setSidebarCollapsed: (v: boolean) => void
  toggleSidebar: () => void
  setSidebarWidth: (w: number) => void
  setRightPanelCollapsed: (v: boolean) => void
  toggleRightPanel: () => void
  setRightPanelWidth: (w: number) => void
  /** Re-clamp both panel widths to the viewport so the center keeps its floor. */
  reclampPanelWidths: () => void
  /** Fluidity J11: hydrate the global collapsed flag from the per-conv
   *  map when the active conversation changes. New conversations (no
   *  entry in the map) seed to collapsed=true. */
  hydrateRightPanelForConv: (conversationId: string | null) => void
  /** Fluidity J11: auto-open driven by an artifact emit or tool launch.
   *  `triggerKey` identifies the source (artifact URL, tool id) so the
   *  same trigger won't re-pop after the user dismisses it. */
  autoOpenRightPanel: (conversationId: string, triggerKey: string) => void
  setPermissionsMode: (mode: PermissionsMode) => void
}

export const useUiStore = create<UiState>((set, get) => ({
  searchQuery: '',
  searchFocusToken: 0,
  settingsOpen: false,
  settingsInitialTab: null,
  customizeOpen: false,
  customizeInitialColumn: null,
  projectViewId: null,
  memoryOpen: false,
  composeDraft: '',
  composeSeedToken: 0,
  memorySeedDescription: '',
  memorySeedToken: 0,
  sidebarCollapsed: readBool(SIDEBAR_COLLAPSED_KEY, false),
  sidebarWidth: readNumber(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  // Fluidity J11: legacy global collapsed flag still seeds from the old
  // localStorage key, but the source of truth on render is the per-conv
  // map below. The global flag stays mirrored for components that read
  // it directly during a render pass.
  rightPanelCollapsed: readBool(RIGHT_COLLAPSED_KEY, true),
  rightPanelWidth: readNumber(RIGHT_WIDTH_KEY, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
  rightPanelByConv: readRightPanelByConv(),
  activeRightPanelConvId: null,
  permissionsMode: readPermissions(),
  // The right panel opens on the EXPLORER, not the surface launcher. Landing on a grid of
  // pills made choosing a surface the first action of every session, when the answer is the
  // Explorer nearly every time. `null` is no longer "nothing selected" — it is the explicit
  // All-Surfaces view, reached from the toolbar toggle (see SecondaryToolbar).
  // Home leads: what needs you, what is alive, what changed. Explorer is one tap away.
  activeTool: 'home',
  recentTools: loadRecentTools(),
  activeShell: readShell(),
  quickOpenVisible: false,
  workflowPaletteVisible: false,
  globalSearchVisible: false,
  requestedOpenFilePath: null,
  requestedOpenFileToken: 0,
  worktreeModalOpen: false,
  planMode: false,
  convFilters: readConvFilters(),
  dirtyPanes: {},
  markDirty: (id: string, label: string) =>
    set((s) => ({ dirtyPanes: addDirty(s.dirtyPanes, id, label) })),
  clearDirty: (id: string) => set((s) => ({ dirtyPanes: removeDirty(s.dirtyPanes, id) })),
  confirmDiscard: (scope?: string) =>
    shouldDiscard(get().dirtyPanes, scope, (message) =>
      // No window.confirm (detached surface, test host) means we CANNOT ask — and
      // an unanswerable question must not be auto-answered "discard".
      typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(message)
        : false
    ),
  setSearchQuery: (q: string) => set({ searchQuery: q }),
  requestSearchFocus: () =>
    set((s) => ({ searchFocusToken: s.searchFocusToken + 1, searchQuery: get().searchQuery })),
  openSettings: (tab?: SettingsTabId) =>
    set({ settingsOpen: true, settingsInitialTab: tab ?? null }),
  // U3: Esc / backdrop / the X all land here, and all of them used to destroy an
  // unsaved BRAIN.md / SOUL.md / ME.md / GOALS.md draft without asking.
  closeSettings: () => {
    if (!get().confirmDiscard('settings:')) return
    // Drop only the settings entries — a dirty Brain note in another surface is
    // not covered by the confirm the operator just answered.
    set((s) => ({
      settingsOpen: false,
      settingsInitialTab: null,
      dirtyPanes: Object.fromEntries(
        Object.entries(s.dirtyPanes).filter(([id]) => !id.startsWith('settings:'))
      )
    }))
  },
  toggleSettings: () => {
    // Toggling CLOSED is a dismissal like any other (Cmd+, while an editor is dirty).
    if (get().settingsOpen) {
      get().closeSettings()
      return
    }
    set({ settingsOpen: true })
  },
  openCustomize: (column?: CustomizeColumnId) =>
    set({ customizeOpen: true, customizeInitialColumn: column ?? null }),
  closeCustomize: () => set({ customizeOpen: false, customizeInitialColumn: null }),
  openProjectView: (projectId: string) => set({ projectViewId: projectId }),
  closeProjectView: () => set({ projectViewId: null }),
  openMemory: () => set({ memoryOpen: true }),
  closeMemory: () => set({ memoryOpen: false }),
  toggleMemory: () => set((s) => ({ memoryOpen: !s.memoryOpen })),
  seedComposeDraft: (text: string) =>
    set((s) => ({ composeDraft: text, composeSeedToken: s.composeSeedToken + 1 })),
  consumeComposeDraft: () => {
    const text = get().composeDraft
    set({ composeDraft: '' })
    return text
  },
  seedMemoryDescription: (text: string) =>
    set((s) => ({
      memorySeedDescription: text,
      memorySeedToken: s.memorySeedToken + 1,
      memoryOpen: true
    })),
  consumeMemorySeedDescription: () => {
    const text = get().memorySeedDescription
    set({ memorySeedDescription: '' })
    return text
  },
  setSidebarCollapsed: (v: boolean) => {
    writeLocal(SIDEBAR_COLLAPSED_KEY, v ? '1' : '0')
    set({ sidebarCollapsed: v })
  },
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed
    writeLocal(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0')
    set({ sidebarCollapsed: next })
  },
  setSidebarWidth: (w: number) => {
    const other = get().rightPanelCollapsed ? 0 : get().rightPanelWidth
    const dynMax = viewportPanelMax(SIDEBAR_MAX, other)
    const clamped = Math.max(SIDEBAR_MIN, Math.min(dynMax, Math.round(w)))
    writeLocal(SIDEBAR_WIDTH_KEY, String(clamped))
    set({ sidebarWidth: clamped })
  },
  setRightPanelCollapsed: (v: boolean) => {
    // Mirror to legacy global storage so apps that read the flag directly
    // still work. When a conversation is active, also update the per-conv
    // map — including marking the current trigger as dismissed when the
    // user is collapsing.
    writeLocal(RIGHT_COLLAPSED_KEY, v ? '1' : '0')
    const convId = get().activeRightPanelConvId
    if (convId) {
      const cur = get().rightPanelByConv
      const prev = getConvState(cur, convId)
      const nextState = applyUserToggle(prev, v)
      const nextMap = { ...cur, [convId]: nextState }
      writeRightPanelByConv(nextMap)
      set({ rightPanelCollapsed: v, rightPanelByConv: nextMap })
      return
    }
    set({ rightPanelCollapsed: v })
  },
  toggleRightPanel: () => {
    const next = !get().rightPanelCollapsed
    // Route through setRightPanelCollapsed so the per-conv bookkeeping
    // and trigger-dismissal logic stays in one place.
    get().setRightPanelCollapsed(next)
  },
  hydrateRightPanelForConv: (conversationId) => {
    const state = getConvState(get().rightPanelByConv, conversationId)
    writeLocal(RIGHT_COLLAPSED_KEY, state.collapsed ? '1' : '0')
    set({
      rightPanelCollapsed: state.collapsed,
      activeRightPanelConvId: conversationId
    })
  },
  autoOpenRightPanel: (conversationId, triggerKey) => {
    const cur = get().rightPanelByConv
    const prev = getConvState(cur, conversationId)
    const next = tryAutoOpen(prev, triggerKey)
    if (next === prev) return
    const nextMap = { ...cur, [conversationId]: next }
    writeRightPanelByConv(nextMap)
    writeLocal(RIGHT_COLLAPSED_KEY, next.collapsed ? '1' : '0')
    set({ rightPanelByConv: nextMap, rightPanelCollapsed: next.collapsed })
  },
  setRightPanelWidth: (w: number) => {
    const dynMax = viewportPanelMax(RIGHT_MAX, get().sidebarCollapsed ? 0 : get().sidebarWidth)
    const clamped = Math.max(RIGHT_MIN, Math.min(dynMax, Math.round(w)))
    writeLocal(RIGHT_WIDTH_KEY, String(clamped))
    set({ rightPanelWidth: clamped })
  },

  // Re-clamp both panels to the current viewport (call on mount + window resize)
  // so a stored oversized width or a window shrink can't starve the center.
  reclampPanelWidths: () => {
    if (typeof window === 'undefined') return
    const st = get()
    const sCollapsed = st.sidebarCollapsed
    const rCollapsed = st.rightPanelCollapsed
    // Effective rendered widths, capped at their static maxima.
    const sw0 = sCollapsed ? 0 : Math.min(st.sidebarWidth, SIDEBAR_MAX)
    const rw0 = rCollapsed ? 0 : Math.min(st.rightPanelWidth, RIGHT_MAX)
    const avail = window.innerWidth - CENTER_MIN - PANEL_CHROME // room both panels may share
    let sw = sw0
    let rw = rw0
    const total = sw0 + rw0
    if (total > avail && total > 0) {
      // Shrink PROPORTIONALLY — preserve the panels' relative split instead of
      // snapping both to their minimums — then repay any min-clamp overshoot from
      // whichever panel still has slack above its floor.
      const scale = avail / total
      sw = sCollapsed ? 0 : Math.max(SIDEBAR_MIN, Math.round(sw0 * scale))
      rw = rCollapsed ? 0 : Math.max(RIGHT_MIN, Math.round(rw0 * scale))
      let over = sw + rw - avail
      if (over > 0 && !rCollapsed) {
        const cut = Math.min(over, rw - RIGHT_MIN)
        rw -= cut
        over -= cut
      }
      if (over > 0 && !sCollapsed) {
        sw -= Math.min(over, sw - SIDEBAR_MIN)
      }
    }
    if (!sCollapsed && sw !== st.sidebarWidth) {
      writeLocal(SIDEBAR_WIDTH_KEY, String(sw))
      set({ sidebarWidth: sw })
    }
    if (!rCollapsed && rw !== st.rightPanelWidth) {
      writeLocal(RIGHT_WIDTH_KEY, String(rw))
      set({ rightPanelWidth: rw })
    }
  },
  setPermissionsMode: (mode: PermissionsMode) => {
    writeLocal(PERMISSIONS_KEY, mode)
    set({ permissionsMode: mode })
  },
  setActiveTool: (tool: ToolId | null) => {
    if (tool && get().rightPanelCollapsed) {
      writeLocal(RIGHT_COLLAPSED_KEY, '0')
      set({ rightPanelCollapsed: false })
    }
    // TRANSITION, deliberately — the panel-collapse write above stays synchronous
    // (instant chrome feedback) while the surface swap renders concurrently. Every
    // surface switch is a full unmount + lazy-chunk mount + refetch, and with no
    // transition anywhere React committed all of it synchronously: the window
    // could not paint (or take input) until the new surface finished mounting —
    // the amplifier that turned each mount cost into a hard freeze. Under a
    // transition React keeps the old surface interactive, streams the Suspense
    // fallback for a still-loading chunk, and yields to input between units.
    startTransition(() => {
      set({
        activeTool: tool,
        ...(tool ? { recentTools: pushRecent(get().recentTools, tool) } : {})
      })
    })
  },
  closeActiveTool: () => startTransition(() => set({ activeTool: null })),
  setActiveShell: (kind: ShellKind) => {
    writeLocal(ACTIVE_SHELL_KEY, kind)
    set({ activeShell: kind })
  },
  toggleTool: (tool: ToolId) => {
    const current = get().activeTool
    if (current === tool) {
      startTransition(() => set({ activeTool: null }))
    } else {
      if (get().rightPanelCollapsed) {
        writeLocal(RIGHT_COLLAPSED_KEY, '0')
        set({ rightPanelCollapsed: false })
      }
      // Same transition rationale as setActiveTool above.
      startTransition(() => set({ activeTool: tool, recentTools: pushRecent(get().recentTools, tool) }))
    }
  },
  openQuickOpen: () => set({ quickOpenVisible: true }),
  closeQuickOpen: () => set({ quickOpenVisible: false }),
  toggleQuickOpen: () => set((s) => ({ quickOpenVisible: !s.quickOpenVisible })),
  openWorkflowPalette: () => set({ workflowPaletteVisible: true }),
  closeWorkflowPalette: () => set({ workflowPaletteVisible: false }),
  toggleWorkflowPalette: () => set((s) => ({ workflowPaletteVisible: !s.workflowPaletteVisible })),
  openGlobalSearch: () => set({ globalSearchVisible: true }),
  closeGlobalSearch: () => set({ globalSearchVisible: false }),
  toggleGlobalSearch: () => set((s) => ({ globalSearchVisible: !s.globalSearchVisible })),
  openWorktreeModal: () => set({ worktreeModalOpen: true }),
  closeWorktreeModal: () => set({ worktreeModalOpen: false }),
  togglePlanMode: () => set((s) => ({ planMode: !s.planMode })),
  setPlanMode: (v: boolean) => set({ planMode: v }),
  requestOpenFile: (path: string) => {
    if (get().rightPanelCollapsed) {
      writeLocal(RIGHT_COLLAPSED_KEY, '0')
      set({ rightPanelCollapsed: false })
    }
    set((s) => ({
      activeTool: 'files',
      requestedOpenFilePath: path,
      requestedOpenFileToken: s.requestedOpenFileToken + 1,
      quickOpenVisible: false
    }))
  },
  setConvFilters: (partial: Partial<ConvFilters>) => {
    const next = { ...get().convFilters, ...partial }
    writeLocal(CONV_FILTERS_KEY, JSON.stringify(next))
    set({ convFilters: next })
  },
  resetConvFilters: () => {
    writeLocal(CONV_FILTERS_KEY, JSON.stringify(DEFAULT_CONV_FILTERS))
    set({ convFilters: { ...DEFAULT_CONV_FILTERS } })
  }
}))

export const SIDEBAR_BOUNDS = { min: SIDEBAR_MIN, max: SIDEBAR_MAX, default: SIDEBAR_DEFAULT }
export const RIGHT_PANEL_BOUNDS = { min: RIGHT_MIN, max: RIGHT_MAX, default: RIGHT_DEFAULT }

/** The ceiling a right-panel DRAG may reach right now — identical to the one
 *  `setRightPanelWidth` commits with. A drag that clamps to the static max while
 *  the commit clamps to the viewport-aware one snaps the panel back on release;
 *  callers pass this so what you drag to is what you get. */
export function rightPanelDragMax(): number {
  const s = useUiStore.getState()
  return viewportPanelMax(RIGHT_MAX, s.sidebarCollapsed ? 0 : s.sidebarWidth)
}

/** Same, for the sidebar. */
export function sidebarDragMax(): number {
  const s = useUiStore.getState()
  return viewportPanelMax(SIDEBAR_MAX, s.rightPanelCollapsed ? 0 : s.rightPanelWidth)
}

// Panel widths are consumed as CSS variables (`width: var(--sidebar-width)`),
// so a drag can update layout by writing the variable alone — no React
// re-render per frame. Seed them synchronously at import (before first paint)
// from the persisted store values, then keep them in sync on every change.
if (typeof document !== 'undefined') {
  const root = document.documentElement
  const writeWidthVars = (s: Pick<UiState, 'sidebarWidth' | 'rightPanelWidth'>) => {
    root.style.setProperty('--sidebar-width', `${s.sidebarWidth}px`)
    root.style.setProperty('--right-panel-width', `${s.rightPanelWidth}px`)
  }
  writeWidthVars(useUiStore.getState())
  useUiStore.subscribe(writeWidthVars)
}
