import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '@/lib/i18n'
import { IconButton } from '@/components/ui/IconButton'
import { ShortcutKeys } from '@/components/ui/ShortcutKeys'
import { useChatStore } from '@/stores/chat-store'
import { useUiStore, SIDEBAR_BOUNDS, sidebarDragMax } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectsStore } from '@/stores/projects-store'
import { useSidebarStore, SIDEBAR_DEFAULT_LIMIT } from '@/stores/sidebar-store'
import { useMediaQuery, NARROW_VIEWPORT_QUERY } from '@/hooks/useMediaQuery'
import { useDragResize } from '@/hooks/useDragResize'
import type { Conversation, Project } from '@/lib/types'
import { PopoverMenu } from '@/components/ui/PopoverMenu'
import { ActivityDashboard } from '@/components/activity/ActivityDashboard'
import { SessionsSidebar } from '@/components/layout/SessionsSidebar'
import { NewProjectModal } from '@/components/projects/NewProjectModal'

// Clean inline nav icons (Lucide/Claude style, currentColor) — replace the old
// Lamprey PNG art. Keyed by name; consistent 1.75 stroke, rounded.
const NAV_PATHS: Record<string, React.ReactNode> = {
  newChat: (
    <>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  customize: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="2" y1="14" x2="6" y2="14" />
      <line x1="10" y1="8" x2="14" y2="8" />
      <line x1="18" y1="16" x2="22" y2="16" />
    </>
  ),
  sessions: (
    <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </>
  ),
  automations: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
}
function NavGlyph({
  name,
  className = 'h-[18px] w-[18px]'
}: {
  name: keyof typeof NAV_PATHS
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
      {NAV_PATHS[name]}
    </svg>
  )
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString()
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
      : false
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    try {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch {
      // Older browsers
      mq.addListener(onChange)
      return () => mq.removeListener(onChange)
    }
  }, [])
  return reduced
}

interface NavRowProps {
  icon?: string
  iconNode?: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
  active?: boolean
  ariaLabel?: string
}

function NavRow({ icon, iconNode, label, shortcut, onClick, active, ariaLabel }: NavRowProps) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel ?? label}
      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-[14px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {icon ? (
        <img src={icon} alt="" aria-hidden className="icon-asset themed-variant-light h-[25px] w-[25px] shrink-0 object-contain" />
      ) : (
        <span aria-hidden className="flex h-5 w-5 shrink-0 items-center justify-center">
          {iconNode}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <ShortcutKeys combo={shortcut} />}
    </button>
  )
}

interface ChevronProps {
  direction: 'right' | 'down' | 'left'
  size?: number
}
function Chevron({ direction, size = 12 }: ChevronProps) {
  const points =
    direction === 'down' ? '6 9 12 15 18 9' : direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points={points} />
    </svg>
  )
}

interface ProjectGroup {
  project: Project | null
  conversations: Conversation[]
}

interface OrphanGroup {
  label: string
  items: Conversation[]
}

function bucketConversations(
  conversations: Conversation[],
  projects: Project[]
): { groups: ProjectGroup[]; orphans: Conversation[] } {
  const byProject = new Map<string, Conversation[]>()
  const orphans: Conversation[] = []
  for (const c of conversations) {
    if (c.projectId) {
      const arr = byProject.get(c.projectId) ?? []
      arr.push(c)
      byProject.set(c.projectId, arr)
    } else {
      orphans.push(c)
    }
  }
  // Preserve the project sort order from projects-store (pinned first, then
  // by lastActivityAt) and append any conversations whose project has been
  // archived/deleted into the orphan bucket so they don't disappear.
  const groups: ProjectGroup[] = []
  const known = new Set(projects.map((p) => p.id))
  for (const p of projects) {
    const items = (byProject.get(p.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
    groups.push({ project: p, conversations: items })
  }
  for (const [pid, items] of byProject.entries()) {
    if (!known.has(pid)) orphans.push(...items)
  }
  orphans.sort((a, b) => b.updatedAt - a.updatedAt)
  return { groups, orphans }
}

function groupOrphansByDate(conversations: Conversation[]): OrphanGroup[] {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const yesterday = today - 86400000
  const thisWeek = today - 7 * 86400000
  const groups: OrphanGroup[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'This Week', items: [] },
    { label: 'Older', items: [] }
  ]
  for (const c of conversations) {
    if (c.updatedAt >= today) groups[0].items.push(c)
    else if (c.updatedAt >= yesterday) groups[1].items.push(c)
    else if (c.updatedAt >= thisWeek) groups[2].items.push(c)
    else groups[3].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

interface ConversationRowProps {
  conv: Conversation
  active: boolean
  onSelect: () => void
  onDelete: () => void
}
function ConversationRow({ conv, active, onSelect, onDelete }: ConversationRowProps) {
  return (
    <button
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[14px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      <NavGlyph name="chat" className="h-5 w-5 shrink-0 text-[var(--text-muted)] opacity-80" />
      {conv.kind && conv.kind !== 'local' && (
        <span
          className={`shrink-0 rounded px-1 py-0 text-[11px] font-mono uppercase tracking-wider ${
            conv.kind === 'worktree'
              ? 'bg-[var(--accent-dim)] text-[var(--accent)]'
              : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
          }`}
          title={conv.worktreePath ?? conv.kind}
        >
          {conv.kind === 'worktree' ? 'wt' : 'cl'}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{conv.title}</span>
      <span className="font-mono text-[12px] text-[var(--text-muted)] group-hover:hidden">
        {formatRelativeTime(conv.updatedAt)}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        title={t('Delete conversation')}
        aria-label={t('Delete conversation')}
        className="hidden rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--error)] group-hover:block"
      >
        ×
      </button>
    </button>
  )
}

interface ProjectMenuItem {
  label: string
  onSelect: () => void
  destructive?: boolean
  disabled?: boolean
}

interface ProjectMenuProps {
  open: boolean
  anchorRef: React.RefObject<HTMLButtonElement | null>
  items: ProjectMenuItem[]
  onClose: () => void
}
function ProjectMenu({ open, anchorRef, items, onClose }: ProjectMenuProps) {
  return (
    <PopoverMenu
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      align="bottom-start"
      role="menu"
      ariaLabel="Project actions"
      minWidth={180}
    >
      {items.map((item, i) => (
        <button
          key={i}
          role="menuitem"
          disabled={item.disabled}
          aria-disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return
            onClose()
            item.onSelect()
          }}
          className={`block w-full px-3 py-1.5 text-left text-[12px] transition-colors ${
            item.disabled
              ? 'cursor-not-allowed text-[var(--text-muted)] opacity-60'
              : item.destructive
                ? 'text-[var(--error)] hover:bg-[var(--bg-tertiary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {item.label}
        </button>
      ))}
    </PopoverMenu>
  )
}

interface ProjectSectionProps {
  group: ProjectGroup
  expanded: boolean
  onToggleExpanded: () => void
  visibleLimit: number
  onShowMore: () => void
  onShowLess: () => void
  activeConversationId: string | null
  activeProjectId: string | null
  onSelectProject: (id: string) => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string, title: string) => void
  onRename: (p: Project) => void
  onTogglePin: (p: Project) => void
  onArchive: (p: Project) => void
  onOpenFolder: (p: Project) => void
  onCopyPath: (p: Project) => void
  onNewChatInProject: (p: Project) => void
}
function ProjectSection({
  group,
  expanded,
  onToggleExpanded,
  visibleLimit,
  onShowMore,
  onShowLess,
  activeConversationId,
  activeProjectId,
  onSelectProject,
  onSelectConversation,
  onDeleteConversation,
  onRename,
  onTogglePin,
  onArchive,
  onOpenFolder,
  onCopyPath,
  onNewChatInProject
}: ProjectSectionProps) {
  const project = group.project
  const conversations = group.conversations
  const hasMore = conversations.length > visibleLimit
  const visible = conversations.slice(0, visibleLimit)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchorRef = useRef<HTMLButtonElement>(null)
  const rowId = project ? `project-row-${project.id}` : 'project-row-unassigned'
  const isActive = project ? activeProjectId === project.id : false

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!project) return
    e.preventDefault()
    setMenuOpen(true)
  }

  const handleClick = () => {
    if (project) onSelectProject(project.id)
    onToggleExpanded()
  }

  return (
    <div className="mb-2" data-project-id={project?.id}>
      <button
        ref={menuAnchorRef}
        id={rowId}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        aria-expanded={expanded}
        aria-controls={`${rowId}-list`}
        className={`group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[14px] transition-colors hover:bg-[var(--bg-tertiary)] ${
          isActive
            ? 'text-[var(--text-primary)] bg-[var(--bg-tertiary)] font-semibold'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--text-muted)]">
          <Chevron direction={expanded ? 'down' : 'right'} />
        </span>
        <NavGlyph name="folder" className="h-[18px] w-[18px] shrink-0 text-[var(--text-muted)]" />
        <span className="flex-1 truncate font-medium" title={project?.name}>{project?.name ?? 'Unassigned'}</span>
        {project?.pinned && (
          <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
            pin
          </span>
        )}
        {conversations.length > 0 && (
          <span className="font-mono text-[12px] text-[var(--text-muted)]">
            {conversations.length}
          </span>
        )}
        {project && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setMenuOpen((v) => !v)
              }
            }}
            title={t('Project actions')}
            aria-label={t('Project actions')}
            className="hidden rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] group-hover:inline-flex"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </svg>
          </span>
        )}
      </button>

      {project && (
        <ProjectMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={menuAnchorRef}
          items={[
            { label: 'New chat in project', onSelect: () => onNewChatInProject(project) },
            { label: 'Rename…', onSelect: () => onRename(project) },
            {
              label: project.pinned ? 'Unpin project' : 'Pin project',
              onSelect: () => onTogglePin(project)
            },
            {
              label: 'Open folder',
              onSelect: () => onOpenFolder(project),
              disabled: !project.path
            },
            {
              label: 'Copy path',
              onSelect: () => onCopyPath(project),
              disabled: !project.path
            },
            { label: 'Archive', onSelect: () => onArchive(project), destructive: true }
          ]}
        />
      )}

      {expanded && (
        <div className="ml-4 mt-0.5" id={`${rowId}-list`} role="group">
          {visible.length === 0 ? (
            <p className="px-3 py-1.5 text-[12px] italic text-[var(--text-muted)]">
              {t('No conversations yet.')}
            </p>
          ) : (
            visible.map((conv) => (
              <ConversationRow
                key={conv.id}
                conv={conv}
                active={activeConversationId === conv.id}
                onSelect={() => onSelectConversation(conv.id)}
                onDelete={() => onDeleteConversation(conv.id, conv.title)}
              />
            ))
          )}
          {hasMore && (
            <button
              onClick={onShowMore}
              className="block w-full px-3 py-1 text-left text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              Show more ({conversations.length - visibleLimit})
            </button>
          )}
          {!hasMore && visibleLimit > SIDEBAR_DEFAULT_LIMIT && conversations.length > SIDEBAR_DEFAULT_LIMIT && (
            <button
              onClick={onShowLess}
              className="block w-full px-3 py-1 text-left text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
            >
              {t('Show less')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  // Per-field selectors (actions are referentially stable in Zustand): the
  // sidebar re-renders only when the conversation list or active id changes,
  // NOT on every streaming token as the bare `useChatStore()` did.
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const searchQuery = useUiStore((s) => s.searchQuery)
  const setSearchQuery = useUiStore((s) => s.setSearchQuery)
  const searchFocusToken = useUiStore((s) => s.searchFocusToken)
  const requestSearchFocus = useUiStore((s) => s.requestSearchFocus)
  const openSettings = useUiStore((s) => s.openSettings)
  const openCustomize = useUiStore((s) => s.openCustomize)
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed)
  const sidebarWidth = useUiStore((s) => s.sidebarWidth)
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed)
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [filterVisible, setFilterVisible] = useState(false)
  const [sessionsVisible, setSessionsVisible] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  const projects = useProjectsStore((s) => s.projects)
  const loadProjects = useProjectsStore((s) => s.loadProjects)
  const createProject = useProjectsStore((s) => s.createProject)
  const renameProject = useProjectsStore((s) => s.renameProject)
  const pinProject = useProjectsStore((s) => s.pinProject)
  const archiveProject = useProjectsStore((s) => s.archiveProject)
  const openFolder = useProjectsStore((s) => s.openFolder)
  const copyPath = useProjectsStore((s) => s.copyPath)
  const assignConversation = useProjectsStore((s) => s.assignConversation)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const selectProject = useProjectsStore((s) => s.selectProject)

  const isProjectExpanded = useSidebarStore((s) => s.isProjectExpanded)
  const toggleProjectExpanded = useSidebarStore((s) => s.toggleProjectExpanded)
  const visibleLimitFor = useSidebarStore((s) => s.visibleLimitFor)
  const showMore = useSidebarStore((s) => s.showMore)
  const showLess = useSidebarStore((s) => s.showLess)

  // (No nav-history subscriptions here any more — the duplicate back/forward
  //  buttons that used them are gone, and six live store subscriptions would
  //  re-render the whole sidebar on every navigation for nothing. The titlebar
  //  subscribes for the pair that survived.)

  const reduced = usePrefersReducedMotion()
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY)

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // Width is driven through the `--sidebar-width` CSS variable during the drag
  // (see useDragResize) so tracking the cursor costs no React re-render; the
  // store + localStorage are updated once on release via setSidebarWidth.
  const handleResizeStart = useDragResize({
    getStartWidth: () => useUiStore.getState().sidebarWidth,
    edge: 'right',
    min: SIDEBAR_BOUNDS.min,
    max: SIDEBAR_BOUNDS.max,
    // Same ceiling setSidebarWidth commits with — otherwise a drag past the
    // viewport-aware limit springs back on release.
    getMax: sidebarDragMax,
    cssVar: '--sidebar-width',
    onCommit: setSidebarWidth,
    onDragChange: (d: boolean) => setDragging(d),
  })

  // Ctrl+K (and the Search nav row) toggle the filter. If it's already
  // open AND the input has keyboard focus, the same chord dismisses it.
  // IMPORTANT: this effect must depend ONLY on searchFocusToken — putting
  // filterVisible in the deps would loop (closing re-runs and re-opens).
  const filterVisibleRef = useRef(filterVisible)
  filterVisibleRef.current = filterVisible
  useEffect(() => {
    if (searchFocusToken === 0) return
    const inputHasFocus = document.activeElement === searchRef.current
    if (filterVisibleRef.current && inputHasFocus) {
      setSearchQuery('')
      setFilterVisible(false)
      searchRef.current?.blur()
      return
    }
    setFilterVisible(true)
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      searchRef.current?.select()
    })
  }, [searchFocusToken])

  useEffect(() => {
    if (!filterVisible) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target && searchRef.current && searchRef.current.contains(target)) return
      const navRow = (e.target as HTMLElement)?.closest('[data-sidebar-search-row]')
      if (navRow) return
      setSearchQuery('')
      setFilterVisible(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [filterVisible, setSearchQuery])

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.title?.toLowerCase().includes(q))
  }, [conversations, searchQuery])

  const { groups, orphans } = useMemo(
    () => bucketConversations(filtered, projects),
    [filtered, projects]
  )
  const orphanGroups = useMemo(() => groupOrphansByDate(orphans), [orphans])

  const handleDelete = async (id: string, title: string) => {
    if (!confirm(`Delete "${title || 'this conversation'}"? The transcript is archived first.`)) return
    // The success/failure toast (including where the transcript was archived) is raised by the store,
    // which is the only layer that sees the handler's result — this used to claim success even when
    // the delete failed.
    await deleteConversation(id)
  }

  const handleSearchClick = () => {
    requestSearchFocus()
  }

  const handleNewChat = async () => {
    await createConversation()
  }

  const handleNewChatInProject = async (project: Project) => {
    const newId = await createConversation()
    if (newId) {
      await assignConversation(newId, project.id)
      // Reload so the new conversation reflects the projectId in the UI.
      await useChatStore.getState().loadConversations()
    }
  }

  const handleAddProject = async () => {
    setNewProjectOpen(true)
  }

  const handleRename = async (project: Project) => {
    const next = prompt('Rename project', project.name)
    if (!next?.trim() || next === project.name) return
    await renameProject(project.id, next.trim())
  }

  const handleTogglePin = async (project: Project) => {
    await pinProject(project.id, !project.pinned)
  }

  const handleArchive = async (project: Project) => {
    if (!confirm(`Archive "${project.name}"? Conversations stay; the project disappears from the list.`)) return
    await archiveProject(project.id, true)
  }

  // The conversation back/forward handlers lived here to drive a pair of buttons
  // in the sidebar header that duplicated the titlebar's. With those buttons
  // removed nothing called them, and no keyboard binding did either — so they
  // are gone rather than left threaded through two call sites as props that look
  // wired but render nothing. The titlebar owns this navigation and has its own
  // goBack/goForward against the same nav-history store.

  const transitionStyle = reduced
    ? undefined
    : { transition: 'width 200ms ease-out, min-width 200ms ease-out' }

  // Drawer on narrow viewports — slide-over from the left when expanded.
  if (isNarrow && !sidebarCollapsed) {
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
          onClick={() => setSidebarCollapsed(true)}
          aria-hidden
        />
        <aside
          role="dialog"
          aria-label={t('Navigation')}
          className="fixed bottom-0 left-0 top-0 z-50 flex flex-col overflow-hidden rounded-r-[var(--panel-radius)] bg-[var(--panel-bg)] shadow-2xl"
          style={{
            width: Math.min(sidebarWidth, window.innerWidth - 48),
            transform: 'translateX(0)',
            transition: reduced ? 'none' : 'transform 200ms ease-out'
          }}
        >
          <SidebarBody
            sidebarWidth={sidebarWidth}
            collapsed={false}
            setSidebarCollapsed={setSidebarCollapsed}
            handleNewChat={handleNewChat}
            handleSearchClick={handleSearchClick}
            openSettings={openSettings}
            openCustomize={openCustomize}
            sessionsVisible={sessionsVisible}
            setSessionsVisible={setSessionsVisible}
            filterVisible={filterVisible}
            setFilterVisible={setFilterVisible}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            searchRef={searchRef}
            handleAddProject={handleAddProject}
            groups={groups}
            orphanGroups={orphanGroups}
            isProjectExpanded={isProjectExpanded}
            toggleProjectExpanded={toggleProjectExpanded}
            visibleLimitFor={visibleLimitFor}
            showMore={showMore}
            showLess={showLess}
            activeConversationId={activeConversationId}
            selectConversation={(id) => {
              void selectConversation(id)
              setSidebarCollapsed(true)
            }}
            handleDelete={handleDelete}
            handleRename={handleRename}
            handleTogglePin={handleTogglePin}
            handleArchive={handleArchive}
            openFolder={(p) => openFolder(p.id)}
            copyPath={(p) => copyPath(p.id)}
            handleNewChatInProject={handleNewChatInProject}
            activeProjectId={activeProjectId}
            selectProject={(id) => void selectProject(id)}
            conversationsCount={conversations.length}
          />
        </aside>
      </>
    )
  }

  if (sidebarCollapsed) {
    return (
      <div
        className="panel-shadow relative flex h-full w-12 flex-col items-center overflow-hidden rounded-[var(--panel-radius)] bg-[var(--panel-bg)] py-3"
        style={transitionStyle}
      >
        <IconButton
          onClick={() => setSidebarCollapsed(false)}
          title={t('Expand sidebar (Ctrl+B)')}
          aria-label={t('Expand sidebar')}
        >
          <Chevron direction="right" size={14} />
        </IconButton>
        <button
          onClick={handleNewChat}
          title={t('New chat (Ctrl+N)')}
          aria-label={t('New chat')}
          className="mt-2 rounded-md p-1.5 transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          <NavGlyph name="newChat" className="h-[22px] w-[22px] text-[var(--text-secondary)]" />
        </button>
        {/* No search icon on the COLLAPSED rail. Ctrl+K opens the search palette from
            anywhere, and the expanded sidebar still has its Search row, so the rail
            icon was a third route to the same place — in the one layout with the least
            room for it. */}
        <button
          onClick={() => openCustomize()}
          title={t('Customize')}
          aria-label={t('Customize')}
          className="mt-1 rounded-md p-1.5 transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          <NavGlyph name="customize" className="h-[22px] w-[22px] text-[var(--text-secondary)]" />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => openSettings()}
          title={t('Settings (Ctrl+,)')}
          aria-label={t('Settings')}
          className="rounded-md p-1.5 transition-colors hover:bg-[var(--bg-tertiary)]"
        >
          <NavGlyph name="settings" className="h-[22px] w-[22px] text-[var(--text-secondary)]" />
        </button>
      </div>
    )
  }

  return (
    <div
      className="panel-shadow relative flex h-full flex-col overflow-hidden rounded-[var(--panel-radius)] bg-[var(--panel-bg)]"
      style={{
        width: 'var(--sidebar-width, 240px)',
        minWidth: 'var(--sidebar-width, 240px)',
        // Disable the width transition while dragging so the panel tracks the
        // cursor 1:1 instead of chasing it with 200ms easing.
        ...(dragging ? undefined : transitionStyle ?? {}),
      }}
    >
      <SidebarBody
        sidebarWidth={sidebarWidth}
        collapsed={false}
        setSidebarCollapsed={setSidebarCollapsed}
        handleNewChat={handleNewChat}
        handleSearchClick={handleSearchClick}
        openSettings={openSettings}
        openCustomize={openCustomize}
        sessionsVisible={sessionsVisible}
        setSessionsVisible={setSessionsVisible}
        filterVisible={filterVisible}
        setFilterVisible={setFilterVisible}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchRef={searchRef}
        handleAddProject={handleAddProject}
        groups={groups}
        orphanGroups={orphanGroups}
        isProjectExpanded={isProjectExpanded}
        toggleProjectExpanded={toggleProjectExpanded}
        visibleLimitFor={visibleLimitFor}
        showMore={showMore}
        showLess={showLess}
        activeConversationId={activeConversationId}
        selectConversation={(id) => void selectConversation(id)}
        handleDelete={handleDelete}
        handleRename={handleRename}
        handleTogglePin={handleTogglePin}
        handleArchive={handleArchive}
        openFolder={(p) => openFolder(p.id)}
        copyPath={(p) => copyPath(p.id)}
        handleNewChatInProject={handleNewChatInProject}
        activeProjectId={activeProjectId}
        selectProject={(id) => {
          void selectProject(id)
          useUiStore.getState().openProjectView(id)
        }}
        conversationsCount={conversations.length}
      />

      <div
        onPointerDown={handleResizeStart}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_BOUNDS.default)}
        title={t('Drag to resize · double-click to reset')}
        role="separator"
        aria-orientation="vertical"
        className={`resize-handle-v resize-handle-v-right ${dragging ? 'dragging' : ''}`}
      />
      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </div>
  )
}

interface SidebarBodyProps {
  sidebarWidth: number
  collapsed: boolean
  setSidebarCollapsed: (v: boolean) => void
  handleNewChat: () => Promise<void> | void
  handleSearchClick: () => void
  openSettings: (tab?: 'automations') => void
  openCustomize: () => void
  sessionsVisible: boolean
  setSessionsVisible: (visible: boolean) => void
  filterVisible: boolean
  setFilterVisible: (v: boolean) => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  handleAddProject: () => void
  groups: ProjectGroup[]
  orphanGroups: OrphanGroup[]
  isProjectExpanded: (id: string) => boolean
  toggleProjectExpanded: (id: string) => void
  visibleLimitFor: (id: string) => number
  showMore: (id: string) => void
  showLess: (id: string) => void
  activeConversationId: string | null
  selectConversation: (id: string) => void
  handleDelete: (id: string, title: string) => void
  handleRename: (p: Project) => void
  handleTogglePin: (p: Project) => void
  handleArchive: (p: Project) => void
  openFolder: (p: Project) => void
  copyPath: (p: Project) => void
  handleNewChatInProject: (p: Project) => void
  activeProjectId: string | null
  selectProject: (id: string) => void
  conversationsCount: number
}
function SidebarBody(props: SidebarBodyProps) {
  // Coding chrome (git worktrees) only in Coding Mode — knowledge-worker default is clean.
  const codingMode = useSettingsStore((s) => s.settings.agenticCodingMode)
  // Opens the unified Automations hub surface (was: openSettings('automations')).
  const setActiveTool = useUiStore((s) => s.setActiveTool)
  const {
    setSidebarCollapsed,
    handleNewChat,
    handleSearchClick,
    openSettings,
    openCustomize,
    sessionsVisible,
    setSessionsVisible,
    filterVisible,
    setFilterVisible,
    searchQuery,
    setSearchQuery,
    searchRef,
    handleAddProject,
    groups,
    orphanGroups,
    isProjectExpanded,
    toggleProjectExpanded,
    visibleLimitFor,
    showMore,
    showLess,
    activeConversationId,
    selectConversation,
    handleDelete,
    handleRename,
    handleTogglePin,
    handleArchive,
    openFolder,
    copyPath,
    handleNewChatInProject,
    activeProjectId,
    selectProject,
    conversationsCount
  } = props

  return (
    <>
      {/* Top chrome row — collapse only.
          The conversation back/forward pair that used to live here was a SECOND
          copy of the titlebar's: same nav-history store, same goBack/goForward,
          rendered a few pixels apart under different names ("Back"/"Forward"
          here vs "Previous/Next conversation" there). Two identical controls
          with two vocabularies read as unexplained glyphs rather than as
          navigation. The titlebar keeps them — better labels, conventional
          position. The handlers stay wired for the keyboard path. */}
      <div className="flex items-center gap-1 px-3 pt-3">
        <IconButton
          onClick={() => setSidebarCollapsed(true)}
          title={t('Collapse sidebar (Ctrl+B)')}
          aria-label={t('Collapse sidebar')}
        >
          <Chevron direction="left" size={14} />
        </IconButton>
      </div>

      <div className="space-y-0.5 px-2 pt-2">
        <NavRow
          iconNode={<NavGlyph name="newChat" />}
          label={t('New chat')}
          shortcut="Ctrl+N"
          onClick={() => void handleNewChat()}
        />
        <div data-sidebar-search-row>
          <NavRow iconNode={<NavGlyph name="search" />} label={t('Search')} onClick={handleSearchClick} />
        </div>
        <NavRow
          iconNode={<NavGlyph name="customize" />}
          label={t('Customize')}
          onClick={() => openCustomize()}
        />
        <NavRow
          iconNode={<NavGlyph name="sessions" />}
          label={t('Sessions')}
          onClick={() => setSessionsVisible(!sessionsVisible)}
          active={sessionsVisible}
        />
      </div>

      {filterVisible && (
        <div className="px-3 pt-3">
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] opacity-70">
              <NavGlyph name="search" className="h-5 w-5" />
            </span>
            <input
              ref={searchRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setSearchQuery('')
                  setFilterVisible(false)
                  searchRef.current?.blur()
                }
              }}
              onBlur={() => {
                if (!searchQuery.trim()) setFilterVisible(false)
              }}
              placeholder={t('Filter conversations…')}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 pl-7 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
          </div>
        </div>
      )}

      <ActivityDashboard />

      {sessionsVisible ? (
        <div className="mt-2 min-h-0 flex-1">
          <SessionsSidebar embedded />
        </div>
      ) : (
        <>

      <div className="mt-4 flex items-center justify-between px-3">
        <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
          {t('Projects')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleAddProject}
            title={t('New project')}
            aria-label={t('New project')}
            className="rounded px-1 py-0.5 text-[14px] leading-none text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            +
          </button>
          {codingMode && (
            <button
              type="button"
              onClick={() => useUiStore.getState().openWorktreeModal()}
              className="rounded px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title={t('Manage git worktrees')}
            >
              worktrees
            </button>
          )}
        </div>
      </div>

      <div className="mx-3 mt-2 flex-1 overflow-y-auto pl-1 pr-1 scrollbar-visible">
        {groups.length === 0 && conversationsCount === 0 && (
          <p className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
            No projects yet. Click + to create one.
          </p>
        )}

        {groups.map((group) =>
          group.project ? (
            <ProjectSection
              key={group.project.id}
              group={group}
              expanded={isProjectExpanded(group.project.id)}
              onToggleExpanded={() => toggleProjectExpanded(group.project!.id)}
              visibleLimit={visibleLimitFor(group.project.id)}
              onShowMore={() => showMore(group.project!.id)}
              onShowLess={() => showLess(group.project!.id)}
              activeConversationId={activeConversationId}
              activeProjectId={activeProjectId}
              onSelectProject={selectProject}
              onSelectConversation={selectConversation}
              onDeleteConversation={handleDelete}
              onRename={handleRename}
              onTogglePin={handleTogglePin}
              onArchive={handleArchive}
              onOpenFolder={openFolder}
              onCopyPath={copyPath}
              onNewChatInProject={handleNewChatInProject}
            />
          ) : null
        )}

        {orphanGroups.length > 0 && (
          <>
            <div className="mt-4 mb-1 flex items-center justify-between px-2">
              <span className="text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {t('Chats')}
              </span>
            </div>
            {orphanGroups.map((group) => (
              <div key={group.label} className="mb-1">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  {group.label}
                </div>
                {group.items.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    active={activeConversationId === conv.id}
                    onSelect={() => selectConversation(conv.id)}
                    onDelete={() => handleDelete(conv.id, conv.title)}
                  />
                ))}
              </div>
            ))}
          </>
        )}

        {groups.length > 0 && orphanGroups.length === 0 && conversationsCount === 0 && (
          <p className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
            {t('Start your first conversation.')}
          </p>
        )}

        {searchQuery && groups.every((g) => g.conversations.length === 0) && orphanGroups.length === 0 && (
          <p className="px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
            No matches for "{searchQuery}".
          </p>
        )}
      </div>

        </>
      )}

      <div className="mt-1 px-2 pb-2 pt-2">
        <NavRow
          iconNode={<NavGlyph name="settings" />}
          label={t('Settings')}
          shortcut="Ctrl+,"
          onClick={() => openSettings()}
        />
      </div>
    </>
  )
}