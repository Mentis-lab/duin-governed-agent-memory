import { t } from '@/lib/i18n'
import { useEffect, useRef, useState, useCallback } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Sidebar } from '@/components/layout/Sidebar'
import { Titlebar, SecondaryToolbar } from '@/components/layout/Titlebar'
import { ChatView } from '@/components/chat/ChatView'
import { ArtifactPanel } from '@/components/artifacts/ArtifactPanel'
import { RightPanelHome } from '@/components/artifacts/RightPanelHome'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ToolsPanel } from '@/components/tools/ToolsPanel'
import { QuickOpenPalette } from '@/components/tools/QuickOpenPalette'
import { WorkflowPalette } from '@/components/workflows/WorkflowPalette'
import { GlobalSearchPalette } from '@/components/brain/GlobalSearchPalette'
import { WorktreeManagerModal } from '@/components/worktree/WorktreeManagerModal'
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow'
import { NoBrainFolderBanner } from '@/components/onboarding/NoBrainFolderBanner'
import { isOnboarded, loadSeed } from '@/lib/brain-seed'
import { SettingsDialog } from '@/components/settings/SettingsDialog'
import { CustomizeView } from '@/components/customize/CustomizeView'
import { ProjectHome } from '@/components/projects/ProjectHome'
import { ToolApprovalModal } from '@/components/tools/ToolApprovalModal'
import { approvalKey, routeApproval } from '@/lib/approval-routing'
import { useInlineApprovalsStore } from '@/stores/inline-approvals-store'
import { MemoryModal } from '@/components/memory/MemoryModal'
import { ToastContainer } from '@/components/ui/Toast'
import { useChatStore } from '@/stores/chat-store'
import { useModelStore } from '@/stores/model-store'
import { useSettingsStore } from '@/stores/settings-store'
import { usePlanStore } from '@/stores/plan-store'
import { useProvidersStore, type ProviderEntry } from '@/stores/providers-store'
import { useUiStore, RIGHT_PANEL_BOUNDS, rightPanelDragMax } from '@/stores/ui-store'
import { toast } from '@/stores/toast-store'
import { useChat } from '@/hooks/useChat'
import { useMcp } from '@/hooks/useMcp'
import { useSkills } from '@/hooks/useSkills'
import { useMemory } from '@/hooks/useMemory'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useShellSignals } from '@/hooks/useShellSignals'
import { useMediaQuery, NARROW_VIEWPORT_QUERY } from '@/hooks/useMediaQuery'
import { useDragResize } from '@/hooks/useDragResize'
import { UpdateBanner } from '@/components/ui/UpdateBanner'
import { SecurityBanner } from '@/components/ui/SecurityBanner'
import { IntegrityBanner } from '@/components/persistence/IntegrityBanner'
import { ReasoningOffBanner } from '@/components/chat/ReasoningOffBanner'
import { AsyncEventToast } from '@/components/chat/AsyncEventToast'
import { StatusLine } from '@/components/layout/StatusLine'
import { AskUserModal } from '@/components/chat/AskUserModal'
import { useResearchProgressSubscription } from '@/hooks/useResearchProgress'
import type { ToolApprovalRequest } from '@/lib/types'
import { followDeepLink } from '@/lib/follow-deep-link'
import { useNoticesStore } from '@/stores/notices-store'
import { settleBootstrap, type BootstrapState } from '@/app-bootstrap'

function App(): React.ReactElement {
  const uiLang = useSettingsStore((s) => s.settings.language)
  const [bootstrap, setBootstrap] = useState<BootstrapState>({ status: 'loading' })
  // First-run onboarding interview (skippable). localStorage-backed so it shows
  // once; on every boot we re-push any saved seed to the in-process brain.
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !isOnboarded())
  useEffect(() => {
    const seed = loadSeed()
    if (seed && seed.nodes.length > 0 && window.api?.brain?.setSeed) {
      void window.api.brain.setSeed(seed.nodes, seed.edges)
    }
  }, [])
  const [artifactOpen, setArtifactOpen] = useState(false)
  const [artifactType, setArtifactType] = useState<string | null>(null)
  const [artifactSource, setArtifactSource] = useState<string | null>(null)
  const [approvalRequest, setApprovalRequest] = useState<ToolApprovalRequest | null>(null)
  // Fluidity J5: inline approval chips for previously-approved,
  // non-destructive tool calls. The set tracks (server, tool) pairs we've
  // seen approved at least once this session — first sighting still gets
  // the heavyweight modal so the user reads the descriptor + args once.
  const approvedSeenRef = useRef<Set<string>>(new Set())
  const pushInlineApproval = useInlineApprovalsStore((s) => s.push)
  const loadConversations = useChatStore((s) => s.loadConversations)
  const loadModels = useModelStore((s) => s.loadModels)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const settingsOpen = useUiStore((s) => s.settingsOpen)
  const closeSettings = useUiStore((s) => s.closeSettings)
  const openSettings = useUiStore((s) => s.openSettings)
  const customizeOpen = useUiStore((s) => s.customizeOpen)
  const projectViewId = useUiStore((s) => s.projectViewId)
  const closeProjectView = useUiStore((s) => s.closeProjectView)
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed)
  // NOTE: intentionally NOT subscribing to rightPanelWidth — the panel sizes
  // itself via the --right-panel-width CSS variable, so width changes never
  // re-render App. Reads for drag/reset go through useUiStore.getState().
  const setRightPanelCollapsed = useUiStore((s) => s.setRightPanelCollapsed)
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth)
  const activeTool = useUiStore((s) => s.activeTool)
  const isNarrow = useMediaQuery(NARROW_VIEWPORT_QUERY)

  // D12 — subscribe the renderer to research:progress / completed / failed
  // event streams. Mounted once at App root; banner subscribers read
  // snapshots from the resulting Zustand store.
  useResearchProgressSubscription()

  // Keep the panels from starving the center column: re-clamp their widths to the
  // viewport on mount and whenever the window resizes, so a stored oversized width
  // or a shrink can't crush the graph/composer/chat below CENTER_MIN.
  useEffect(() => {
    const reclamp = (): void => useUiStore.getState().reclampPanelWidths()
    reclamp()
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [])

  // Width is driven through the `--right-panel-width` CSS variable during the
  // drag (see useDragResize), so App does NOT subscribe to rightPanelWidth and
  // the drag re-renders nothing — the chat tree stays untouched. The store +
  // localStorage are updated once on release via setRightPanelWidth. Pointer
  // capture keeps moves locked to the handle even over the force-graph canvas.
  const handleRightResizeStart = useDragResize({
    getStartWidth: () => useUiStore.getState().rightPanelWidth,
    edge: 'left',
    min: RIGHT_PANEL_BOUNDS.min,
    max: RIGHT_PANEL_BOUNDS.max,
    // Drag to the SAME ceiling setRightPanelWidth commits with, so the panel
    // stops where the pointer stops instead of springing back on release.
    getMax: rightPanelDragMax,
    cssVar: '--right-panel-width',
    onCommit: setRightPanelWidth,
    // (No onDragChange: the graph canvas is window-pinned now — a panel drag costs it
    // nothing, so nothing needs to be told a drag is happening.)
  })

  // Wire IPC event listeners + shortcuts
  useChat()
  useMcp()
  useSkills()
  useMemory()
  useKeyboardShortcuts()
  useShellSignals()

  const autoOpenRightPanel = useUiStore((s) => s.autoOpenRightPanel)
  const hydrateRightPanelForConv = useUiStore((s) => s.hydrateRightPanelForConv)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // The expanded chat overlay lives inside the chat column and cannot widen past
  // the column's own inset, so App gives that inset up while the chat is expanded.
  const chatExpanded = useChatStore((s) => s.chatExpanded)

  const handleArtifactOpen = useCallback(
    (type: string, source: string) => {
      setArtifactType(type)
      setArtifactSource(source)
      setArtifactOpen(true)
      // Record it in the per-conversation list here — the single choke point for
      // ALL artifact opens (render_artifact via chat:artifact, HTML code-block
      // clicks, brain-shell) — so the Artifacts panel lists every one. Deduped by
      // source, so re-opening from the list doesn't create duplicates.
      if (source) {
        useChatStore.getState().addArtifact({
          id: (crypto as { randomUUID?: () => string }).randomUUID?.() ?? `art-${source.length}`,
          type: type || 'html',
          source,
          createdAt: Date.now()
        })
        // Durable copy: html/md artifacts become files under userData/artifacts so
        // the Artifacts surface lists them across sessions. Idempotent per content;
        // non-html/md types are ignored main-side. Fire-and-forget.
        void window.api?.artifacts?.persist?.(type || 'html', source)
      }
      // Fluidity J11: artifact emit is a trigger that should auto-open
      // the right panel. The trigger key combines type + source so two
      // different artifacts each get one auto-open attempt.
      const convId = useChatStore.getState().activeConversationId
      if (convId) {
        autoOpenRightPanel(convId, `artifact:${type}:${source}`)
      } else {
        // No conversation to hang the per-conv trigger state on — a fresh
        // window, the brain shell, or the Artifacts panel. Without this the
        // artifact opens INVISIBLY: the state above is set and main renders the
        // content, but the panel that would show it never mounts, because App
        // gates it on `!rightPanelCollapsed`. Opening was always the intent
        // here; the per-conv path just had nowhere to record it.
        useUiStore.getState().setRightPanelCollapsed(false)
      }
    },
    [autoOpenRightPanel]
  )

  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__openArtifact = handleArtifactOpen
    return () => {
      delete (window as unknown as Record<string, unknown>).__openArtifact
    }
  }, [handleArtifactOpen])

  // The right panel is ONE slot. Switching to a tool therefore ends the artifact
  // session rather than leaving it parked behind the tool: the artifact branch
  // below now outranks `activeTool` (see the render), so without this the panel
  // would keep showing the artifact after a tool launch. Also hide the native
  // view, since an OS-level WebContentsView has no DOM stacking and would
  // otherwise stay pinned on top of the tool that took the slot.
  //
  // NOTE this fires on a CHANGE of activeTool only. Opening an artifact from
  // inside the Artifacts surface does not change activeTool, so it does not
  // clobber the artifact the user just clicked.
  const prevToolRef = useRef(activeTool)
  useEffect(() => {
    if (prevToolRef.current === activeTool) return
    prevToolRef.current = activeTool
    if (!activeTool) return
    setArtifactOpen(false)
    if (window.api) void window.api.artifact?.hide?.()
  }, [activeTool])

  // Fluidity J11: a tool launch is a trigger that should auto-open the
  // right panel — same one-pop-per-trigger rule the artifact emit uses.
  useEffect(() => {
    if (!activeTool) return
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    autoOpenRightPanel(convId, `tool:${activeTool}`)
  }, [activeTool, autoOpenRightPanel])

  // Plan-mode gate engages → surface the Plan card immediately so the
  // user can't miss the approval requirement. Tracks the previous value
  // in a ref so the effect only fires on the *transition* into the
  // gated state; subsequent renders while gated don't re-pop the panel
  // if the user has manually moved off the Plan card. The plan-store
  // already enforces plan-mode at the dispatcher level — this is purely
  // a UI nudge.
  const planModeActive = usePlanStore((s) => s.planModeActive)
  const setActiveTool = useUiStore((s) => s.setActiveTool)
  const prevPlanGateRef = useRef<boolean | null>(null)
  useEffect(() => {
    const wasGated = prevPlanGateRef.current === true
    prevPlanGateRef.current = planModeActive
    if (planModeActive !== true || wasGated) return
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    autoOpenRightPanel(convId, 'plan:gated')
    setActiveTool('plan')
  }, [planModeActive, autoOpenRightPanel, setActiveTool])

  // Fluidity J11: hydrate the global collapsed flag from the per-conv map
  // every time the active conversation changes. New conversations seed
  // to collapsed; existing ones restore their last manual / auto state.
  useEffect(() => {
    hydrateRightPanelForConv(activeConversationId)
  }, [activeConversationId, hydrateRightPanelForConv])

  // Narrow-viewport drawer: Esc closes (collapses the right panel) so the
  // chat takes the full width back. Only active while the drawer is open.
  useEffect(() => {
    if (!isNarrow || rightPanelCollapsed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target
        if (target instanceof HTMLElement) {
          const tag = target.tagName
          if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
        }
        e.preventDefault()
        setRightPanelCollapsed(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isNarrow, rightPanelCollapsed, setRightPanelCollapsed])

  useEffect(() => {
    if (!window.api) return
    const unsubscribe = window.api.tools.onApprovalRequired((e: unknown) => {
      const req = e as ToolApprovalRequest
      const surface = routeApproval(
        { serverId: req.serverId, name: req.name, risks: req.risks ?? [], dangerous: req.dangerous },
        { approvedSeen: approvedSeenRef.current }
      )
      if (surface === 'chip') {
        pushInlineApproval(req)
      } else {
        setApprovalRequest(req)
      }
    })
    // The other half: main cancels pending approvals when a chat round is aborted, but
    // nothing used to tell the window — so the full-screen modal stayed up over a turn
    // that had already been cancelled, and answering it did nothing at all.
    const unsubCancel = window.api.tools.onApprovalCancelled?.(({ callId }) => {
      setApprovalRequest((cur) => (cur && cur.callId === callId ? null : cur))
    })
    return () => {
      unsubscribe()
      unsubCancel?.()
    }
  }, [pushInlineApproval])

  useEffect(() => {
    if (!window.api) return
    // NOTE: chat errors are surfaced by the chat hook (useChat's chat.onError),
    // which has the turn/conversation context + message truncation. A second
    // toast here double-fired on every chat error — removed.
    const offError = window.api.app.onError((e: { message: string }) => {
      toast.error(e.message)
    })
    const offWarning = window.api.app.onWarning((e: { message: string }) => {
      toast.warning(e.message)
    })
    // Cold-start: the brain couldn't build its entity graph because no extraction model
    // is configured. Prompt the user to add an API key (warning toast, held longer).
    const offNeedsKey = window.api.brain?.onNeedsKey?.((e: { message: string }) => {
      toast.warning(e.message, 12000)
    })
    return () => {
      offError?.()
      offWarning?.()
      offNeedsKey?.()
    }
  }, [])

  // RAG ingest progress → forwarded to chat-store so rag-pending attachment
  // chips update live (queued → loading → chunking → embedding → ready).
  // The Library UI subscribes to the same channel separately; both
  // subscribers are independent, no fan-in conflict.
  useEffect(() => {
    if (!window.api?.rag?.document?.onProgress) return
    const unsubscribe = window.api.rag.document.onProgress((e: unknown) => {
      const evt = e as {
        jobId?: unknown
        documentId?: unknown
        phase?: unknown
        progress?: unknown
        chunkCount?: unknown
        error?: unknown
      }
      if (typeof evt?.jobId !== 'string' || typeof evt?.phase !== 'string') return
      useChatStore.getState()._updateRagAttachmentProgress({
        jobId: evt.jobId,
        documentId: typeof evt.documentId === 'string' ? evt.documentId : '',
        phase: evt.phase,
        progress: typeof evt.progress === 'number' ? evt.progress : 0,
        chunkCount: typeof evt.chunkCount === 'number' ? evt.chunkCount : undefined,
        error: typeof evt.error === 'string' ? evt.error : undefined
      })
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!window.api?.loops?.onFired) return
    const unsubscribe = window.api.loops.onFired((e: unknown) => {
      const event = e as { wakeup?: { conversationId?: string } }
      const conversationId = event?.wakeup?.conversationId
      const chat = useChatStore.getState()
      if (conversationId && chat.activeConversationId === conversationId) {
        void window.api.conversation.getMessages(conversationId).then((result) => {
          if (result.success) useChatStore.setState({ messages: result.data })
        })
      }
      void chat.loadConversations()
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!window.api?.notifications?.onClicked) return
    const unsubscribe = window.api.notifications.onClicked((e: unknown) => {
      const event = e as { deepLink?: unknown }
      followDeepLink(typeof event.deepLink === 'string' ? event.deepLink : '')
    })
    return unsubscribe
  }, [])

  // Inbox counts live at app level so the Status pill can show what is waiting whether
  // or not the panel has ever been opened.
  useEffect(() => {
    void useNoticesStore.getState().refreshCounts()
    if (!window.api?.notices?.onChanged) return
    return window.api.notices.onChanged((counts) => {
      useNoticesStore.getState().setCounts(counts)
    })
  }, [])

  useEffect(() => {
    if (!window.api?.sessionsMessaging?.onIncoming) return
    const unsubscribe = window.api.sessionsMessaging.onIncoming((e: unknown) => {
      const event = e as { targetSessionId?: string }
      const chat = useChatStore.getState()
      if (event.targetSessionId && chat.activeConversationId === event.targetSessionId) {
        toast.info('Incoming session message queued for the next turn')
      }
    })
    return unsubscribe
  }, [])

  const startBootstrap = useCallback(async (): Promise<void> => {
    setBootstrap({ status: 'loading' })
    if (!window.api) {
      setBootstrap({ status: 'degraded', message: 'The desktop bridge is unavailable.' })
      return
    }
    setBootstrap(await settleBootstrap([
      // loadConversations takes no AbortSignal (chat-store never grew one), so it gets the
      // timeout race but no early-abort courtesy — passing one was a type error the source
      // branch shipped. The other two accept it and stop their own IPC work on abort.
      () => loadConversations(),
      (signal) => loadModels(signal),
      (signal) => loadSettings(signal)
    ]))
  }, [loadConversations, loadModels, loadSettings])

  useEffect(() => {
    void startBootstrap()
  }, [startBootstrap])

  // Provider discovery enriches model selection, but it is not required to mount
  // the local shell. A slow or failed keychain read must never strand boot.
  useEffect(() => {
    if (!window.api) return
    let alive = true
    void window.api.settings.listProviderKeys().then((providerList) => {
      if (!alive || !providerList.success) return
      useProvidersStore.getState().setProviders(providerList.data as ProviderEntry[])
    }).catch(() => { /* optional discovery; Settings can retry it */ })
    return () => { alive = false }
  }, [])

  if (bootstrap.status === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg-primary)]">
        <div className="font-mono text-[16px] text-[var(--text-muted)]">{t('Loading...')}</div>
      </div>
    )
  }

  return (
    // `key` on the language: t() reads a module-level dictionary, which React has no way
    // to observe — without this, switching to 中文 changes the setting, re-renders
    // nothing, and looks like the picker is still broken. Keying the tree remounts it so
    // every t() re-evaluates. Language changes are rare and deliberate, so a remount is
    // the right cost; a context provider threaded through 169 components is not.
    <div
      key={uiLang ?? 'auto'}
      className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--text-primary)]"
    >
      {showOnboarding && <OnboardingFlow onClose={() => setShowOnboarding(false)} />}

      {settingsOpen && <SettingsDialog onClose={closeSettings} />}

      {customizeOpen && <CustomizeView />}

      {projectViewId && <ProjectHome projectId={projectViewId} onClose={closeProjectView} />}

      <MemoryModal />

      {approvalRequest && (
        <ToolApprovalModal
          request={approvalRequest}
          onResolved={() => setApprovalRequest(null)}
          onAllowed={(req) => {
            approvedSeenRef.current.add(approvalKey(req.serverId, req.name))
          }}
        />
      )}

      <Titlebar onSettingsClick={openSettings} />

      {bootstrap.status === 'degraded' && (
        <div role="alert" className="flex items-center gap-2 border-b border-[var(--warning)]/35 bg-[var(--warning)]/10 px-3 py-2 text-[12px] text-[var(--text-secondary)]">
          <span className="min-w-0 flex-1">{bootstrap.message} You can continue with what is available.</span>
          <button className="shrink-0 font-medium text-[var(--accent)] hover:underline" onClick={() => void startBootstrap()}>{t('Retry')}</button>
          <button className="shrink-0 font-medium text-[var(--accent)] hover:underline" onClick={() => openSettings()}>{t('Open settings')}</button>
          <button className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]" onClick={() => setBootstrap({ status: 'ready' })}>{t('Continue locally')}</button>
        </div>
      )}

      {/* All three columns (Sidebar | Chat | RightPanel) sit flush below
          Row 1 of the Titlebar, forming one clean horizontal divider.
          SecondaryToolbar now lives at the top of the right panel only
          (suppressed when the right panel is collapsed or showing a
          transient ArtifactPanel). */}
      <div className="flex flex-1 gap-[var(--panel-gap)] overflow-hidden p-[var(--panel-gap)]">
        <Sidebar />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* "Skip for now" must not be a dead end: while no brain folder is set, the way back
              into first-run setup sits with the other banners. */}
          <NoBrainFolderBanner hidden={showOnboarding} onSetUp={() => setShowOnboarding(true)} />
          <IntegrityBanner />
          <ReasoningOffBanner />
          <SecurityBanner />
          <UpdateBanner />
          {/* The p-2 inset frames the brain graph. An expanded chat covers the graph
              entirely, so the inset is pure wasted gutter there — dropping it lets the
              expanded panel stretch out to the substrate gap the other panels sit on. */}
          <div
            className={`flex min-w-0 flex-1 overflow-hidden bg-transparent transition-[padding] duration-200 ${chatExpanded ? 'p-0' : 'p-2'}`}
          >
            <ChatView rightInset={0} />
          </div>
        </div>

        {/* On desktop the right panel is part of the flex row (rail when
            collapsed, full panel when expanded). On narrow viewports it's
            lifted out into a fixed slide-over drawer (see block below). */}
        {!isNarrow && rightPanelCollapsed && (
          <div className="panel-shadow flex h-full w-8 flex-col items-center rounded-[var(--panel-radius)] bg-[var(--panel-bg)] py-2">
            <IconButton
              onClick={() => setRightPanelCollapsed(false)}
              title={t('Expand side panel')}
              aria-label={t('Expand side panel')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </IconButton>
          </div>
        )}
        {/* Precedence in the single right-panel slot: artifact > tool > home.
            The artifact MUST outrank the tool. The Artifacts surface is itself a
            tool (`activeTool === 'artifacts'`), so gating the artifact branch on
            `!activeTool` meant clicking an item there set `artifactOpen` but
            mounted nothing — the HTML only appeared once the tool was dismissed
            with ✕, which is exactly the "it's behind the panel" report. Closing
            the artifact (✕) falls back to whatever tool is still active, so the
            Artifacts list comes right back. */}
        {!isNarrow && !rightPanelCollapsed && activeTool && !artifactOpen && (
          <div
            className="right-panel-surface panel-shadow relative flex flex-col overflow-hidden rounded-[var(--panel-radius)] bg-[var(--panel-bg)]"
            style={{ width: 'var(--right-panel-width, 420px)', minWidth: 'var(--right-panel-width, 420px)' }}
          >
            <div
              onPointerDown={handleRightResizeStart}
              onDoubleClick={() => setRightPanelWidth(RIGHT_PANEL_BOUNDS.default)}
              title={t('Drag to resize · double-click to reset')}
              role="separator"
              aria-orientation="vertical"
              className="resize-handle-v resize-handle-v-left"
            />
            <SecondaryToolbar onSettingsClick={openSettings} />
            {/* U4: per-branch boundary. A throw inside a tool panel used to unmount
                the WHOLE tree to a blank window; now it costs this column only. */}
            <ErrorBoundary label="this tool panel">
              <ToolsPanel />
            </ErrorBoundary>
          </div>
        )}
        {!isNarrow && !rightPanelCollapsed && artifactOpen && (
          <div
            className="right-panel-surface panel-shadow relative flex flex-col overflow-hidden rounded-[var(--panel-radius)] bg-[var(--panel-bg)]"
            style={{ width: 'var(--right-panel-width, 420px)', minWidth: 'var(--right-panel-width, 420px)' }}
          >
            <div
              onPointerDown={handleRightResizeStart}
              onDoubleClick={() => setRightPanelWidth(RIGHT_PANEL_BOUNDS.default)}
              title={t('Drag to resize · double-click to reset')}
              role="separator"
              aria-orientation="vertical"
              className="resize-handle-v resize-handle-v-left"
            />
            {/* The artifact state draws the same SecondaryToolbar as the tool
                and home states. Without it this branch was 48px of chrome
                against their 84px, so the grey bar visibly jumped every time
                an artifact opened — the same mismatch RightPanelHeader fixed
                between the other two. It also means the collapse chevron and
                All Surfaces are reachable while an artifact is open. */}
            <SecondaryToolbar onSettingsClick={openSettings} />
            <ErrorBoundary label="the artifact panel">
              <ArtifactPanel
                artifactType={artifactType}
                artifactSource={artifactSource}
                onClose={() => setArtifactOpen(false)}
              />
            </ErrorBoundary>
          </div>
        )}
        {!isNarrow && !rightPanelCollapsed && !activeTool && !artifactOpen && (
          <div
            className="right-panel-surface panel-shadow relative flex flex-col overflow-hidden rounded-[var(--panel-radius)] bg-[var(--panel-bg)]"
            style={{ width: 'var(--right-panel-width, 420px)', minWidth: 'var(--right-panel-width, 420px)' }}
          >
            <div
              onPointerDown={handleRightResizeStart}
              onDoubleClick={() => setRightPanelWidth(RIGHT_PANEL_BOUNDS.default)}
              title={t('Drag to resize · double-click to reset')}
              role="separator"
              aria-orientation="vertical"
              className="resize-handle-v resize-handle-v-left"
            />
            <SecondaryToolbar onSettingsClick={openSettings} />
            <ErrorBoundary label="the workspace panel">
              <RightPanelHome />
            </ErrorBoundary>
          </div>
        )}
      </div>

      {/* Narrow-viewport drawer. Slides in from the right with a backdrop
          when the right panel is "open" on narrow viewports. Doesn't render
          when collapsed (the chat takes full width); the user re-opens via
          the right-panel toggle in Titlebar row 1. */}
      {isNarrow && !rightPanelCollapsed && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px]"
            onClick={() => setRightPanelCollapsed(true)}
            aria-hidden
          />
          <aside
            role="dialog"
            aria-label={t('Workspace panel')}
            className="right-panel-surface fixed bottom-0 right-0 top-0 z-50 flex flex-col overflow-hidden rounded-l-[var(--panel-radius)] bg-[var(--panel-bg)] shadow-2xl"
            style={{
              width: 'min(var(--right-panel-width, 420px), calc(100vw - 24px))',
              transition: 'transform 200ms ease-out',
              transform: 'translateX(0)'
            }}
          >
            <SecondaryToolbar onSettingsClick={openSettings} />
            {/* Same artifact > tool > home precedence as the desktop column. */}
            <ErrorBoundary label="the workspace panel">
            {artifactOpen ? (
              <ArtifactPanel
                artifactType={artifactType}
                artifactSource={artifactSource}
                onClose={() => setArtifactOpen(false)}
              />
            ) : activeTool ? (
              <ToolsPanel />
            ) : (
              <RightPanelHome />
            )}
            </ErrorBoundary>
          </aside>
        </>
      )}

      <StatusLine />

      <QuickOpenPalette />
      <WorkflowPalette />
      <GlobalSearchPalette />
      <WorktreeManagerModal />
      <AsyncEventToast />
      <AskUserModal />

      <ToastContainer />
    </div>
  )
}

export default App
