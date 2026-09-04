import { contextBridge, ipcRenderer, webUtils, webFrame } from 'electron'
// The chat:send request shape is declared ONCE, in the shared contract, alongside the table that
// says where each field goes on the wire. Re-declaring it here is what let activeSkillIds be sent
// and silently dropped. See electron/shared/chat-send-contract.ts.
import type { ChatSendRequest, ChatSteerRequest } from './shared/chat-send-contract'
import { buildInfo, formatBuildStamp } from './build-info'

const api = {
  // Per-launch /agui execution token (deny-first gate). The renderer attaches it to its agentic
  // chat POSTs so host-exec / destructive tools are authorized; unauthenticated callers can't.
  execToken: (): Promise<string | null> => ipcRenderer.invoke('brain:exec-token'),
  controlToken: (): Promise<string | null> => ipcRenderer.invoke('brain:control-token'),
  // Whole-UI font scaling (the Appearance "Font size" toggle). Native page zoom
  // scales chrome + panels + content uniformly and rescales the viewport with it,
  // so the fixed-px / h-screen layout never clips (the failure mode of CSS zoom).
  setUiZoom: (factor: number): void => webFrame.setZoomFactor(factor),
  chat: {
    send: (request: ChatSendRequest) => ipcRenderer.invoke('chat:send', request),
    cancel: (conversationId: string) => ipcRenderer.invoke('chat:cancel', conversationId),
    // Composer STEERING — inject text into the FOREGROUND running turn instead of queuing a new
    // turn. Resolves to { accepted } from the brain; accepted:false means no live run caught it
    // (the caller then enqueues it as a durable new turn).
    steer: (request: ChatSteerRequest) => ipcRenderer.invoke('chat:steer', request),
    generateTitle: (content: string, model?: string) =>
      ipcRenderer.invoke('chat:generateTitle', content, model),
    onChunk: (cb: (e: { conversationId: string; content: string }) => void) =>
      ipcRenderer.on('chat:chunk', (_, e) => cb(e)),
    onReasoning: (cb: (e: { conversationId: string; content: string }) => void) =>
      ipcRenderer.on('chat:reasoning', (_, e) => cb(e)),
    onDone: (cb: (e: { conversationId: string; message: unknown }) => void) =>
      ipcRenderer.on('chat:done', (_, e) => cb(e)),
    /** Reasoning Audit Phase R4 — Planner row persisted during a
     *  multi-agent pipeline turn. Renderer treats it as audit-only:
     *  the row is appended to the conversation message list but R7's
     *  MessageList attaches it to the next downstream Coder/Composer
     *  bubble behind a "Show pipeline trace" toggle instead of
     *  rendering it as its own visible message bubble. */
    onPlannerMessage: (
      cb: (e: { conversationId: string; message: unknown }) => void
    ) => ipcRenderer.on('chat:planner-message', (_, e) => cb(e)),
    onError: (cb: (e: { conversationId: string; error: string }) => void) =>
      ipcRenderer.on('chat:error', (_, e) => cb(e)),
    /** The brain discarded its streamed answer body (tool-call preamble) and is
     *  about to re-stream clean prose — the renderer clears its streaming buffer
     *  so the retry prose replaces the preamble instead of appending to it. */
    onReset: (cb: (e: { conversationId: string }) => void) =>
      ipcRenderer.on('chat:reset', (_, e) => cb(e)),
    onToolCall: (cb: (e: unknown) => void) => ipcRenderer.on('chat:tool-call', (_, e) => cb(e)),
    onToolCallResult: (cb: (e: unknown) => void) =>
      ipcRenderer.on('chat:tool-call-result', (_, e) => cb(e)),
    onArtifact: (
      cb: (e: { conversationId: string; artifactType: string; source: string; title?: string }) => void
    ) => ipcRenderer.on('chat:artifact', (_, e) => cb(e)),
    onPhase: (cb: (e: { conversationId: string; phase: string }) => void) =>
      ipcRenderer.on('chat:phase', (_, e) => cb(e)),
    onStreamingVitals: (
      cb: (e: {
        conversationId: string
        lastChunkAt: number
        msSinceLastChunk: number
        chunkCount: number
        tokenEstimate: number
        attemptElapsedMs: number
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: any): void => cb(e)
      ipcRenderer.on('chat:streaming-vitals', handler)
      return () => ipcRenderer.removeListener('chat:streaming-vitals', handler)
    },
    onDocumentCreated: (
      cb: (e: {
        conversationId: string
        document: {
          id: string
          name: string
          mimeType: string
          content: string
          sizeBytes: number
          createdAt: number
        }
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: any): void => cb(e)
      ipcRenderer.on('chat:document-created', handler)
      return () => ipcRenderer.removeListener('chat:document-created', handler)
    },
    onAsyncEvent: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('async-event:received', handler)
      return () => ipcRenderer.removeListener('async-event:received', handler)
    },
    /** Reviewable / reversible proposed-edit CARD event. Fires on a new
     *  `propose_edit` card AND on every status change (accept / reject /
     *  edit) so the renderer store can upsert the row by id. Returns an
     *  unsubscribe. */
    onEditProposed: (
      cb: (e: { conversationId: string; proposal: unknown }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: any): void => cb(e)
      ipcRenderer.on('chat:edit-proposed', handler)
      return () => ipcRenderer.removeListener('chat:edit-proposed', handler)
    },
    offAll: () => {
      ;[
        'chat:chunk',
        'chat:reasoning',
        'chat:done',
        'chat:error',
        'chat:reset',
        'chat:tool-call',
        'chat:tool-call-result',
        'chat:phase',
        'chat:streaming-vitals',
        'chat:document-created',
        'chat:edit-proposed'
      ].forEach((ch) => ipcRenderer.removeAllListeners(ch))
    },
    // Per-conversation subscription that returns an unsubscribe function.
    // Use for side-chat panels so they don't fight the global useChat listener.
    subscribe: (
      conversationId: string,
      cbs: {
        onChunk?: (e: { conversationId: string; content: string }) => void
        onReasoning?: (e: { conversationId: string; content: string }) => void
        onDone?: (e: { conversationId: string; message: unknown }) => void
        onError?: (e: { conversationId: string; error: string }) => void
        onReset?: (e: { conversationId: string }) => void
      }
    ) => {
      const handlers: Array<[string, (...args: any[]) => void]> = []
      const wire = (channel: string, fn?: (e: any) => void) => {
        if (!fn) return
        const h = (_: any, e: any) => {
          if (e?.conversationId === conversationId) fn(e)
        }
        ipcRenderer.on(channel, h)
        handlers.push([channel, h])
      }
      wire('chat:chunk', cbs.onChunk)
      wire('chat:reasoning', cbs.onReasoning)
      wire('chat:done', cbs.onDone)
      wire('chat:error', cbs.onError)
      wire('chat:reset', cbs.onReset)
      return () => {
        for (const [ch, h] of handlers) ipcRenderer.removeListener(ch, h)
      }
    }
  },

  // E3 — cross-session search + archive surface. Separate namespace so
  // the legacy `conversation.*` calls stay untouched.
  sessions: {
    list: (opts?: {
      tab?: 'recent' | 'pinned' | 'archived'
      query?: string
      limit?: number
      offset?: number
    }) => ipcRenderer.invoke('sessions:list', opts),
    archive: (id: string, archived: boolean) =>
      ipcRenderer.invoke('sessions:archive', id, archived),
    setPinned: (id: string, pinned: boolean) =>
      ipcRenderer.invoke('sessions:setPinned', id, pinned),
    search: (query: string, limit?: number) => ipcRenderer.invoke('sessions:search', query, limit),
    listActive: (limit?: number) => ipcRenderer.invoke('sessions:list-active', limit)
  },

  conversation: {
    list: () => ipcRenderer.invoke('conversation:list'),
    get: (id: string) => ipcRenderer.invoke('conversation:get', id),
    create: (
      model: string,
      opts?: {
        kind?: 'local' | 'cloud' | 'worktree'
        worktreePath?: string | null
        projectId?: string | null
      }
    ) => ipcRenderer.invoke('conversation:create', model, opts),
    delete: (id: string) => ipcRenderer.invoke('conversation:delete', id),
    updateTitle: (id: string, title: string) =>
      ipcRenderer.invoke('conversation:updateTitle', id, title),
    getMessages: (id: string) => ipcRenderer.invoke('conversation:getMessages', id),
    appendSystem: (id: string, content: string) =>
      ipcRenderer.invoke('conversation:appendSystem', id, content),
    setModel: (id: string, model: string) => ipcRenderer.invoke('conversation:setModel', id, model),
    fork: (input: unknown) => ipcRenderer.invoke('conversation:fork', input),
    lineage: (conversationId: string) => ipcRenderer.invoke('conversation:lineage', conversationId),
    compact: (id: string) => ipcRenderer.invoke('conversation:compact', id)
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (
      partial: Record<string, unknown>,
      options?: { ensureBrainReady?: boolean }
    ) => ipcRenderer.invoke('settings:set', partial, options ?? {}),

    listProviderKeys: () => ipcRenderer.invoke('settings:listProviderKeys'),
    saveProviderKey: (provider: string, key: string) =>
      ipcRenderer.invoke('settings:saveProviderKey', provider, key),
    hasProviderKey: (provider: string) => ipcRenderer.invoke('settings:hasProviderKey', provider),
    testProviderKey: (provider: string) => ipcRenderer.invoke('settings:testProviderKey', provider),
    deleteProviderKey: (provider: string) =>
      ipcRenderer.invoke('settings:deleteProviderKey', provider),

    saveApiKey: (key: string) => ipcRenderer.invoke('settings:saveApiKey', key),
    hasApiKey: () => ipcRenderer.invoke('settings:hasApiKey'),
    testApiKey: () => ipcRenderer.invoke('settings:testApiKey'),
    saveGoogleCredentials: (clientId: string, clientSecret: string) =>
      ipcRenderer.invoke('settings:saveGoogleCredentials', clientId, clientSecret),
    deleteApiKey: () => ipcRenderer.invoke('settings:deleteApiKey'),
    isEncryptionAvailable: () => ipcRenderer.invoke('settings:isEncryptionAvailable'),
    // macOS Full Disk Access: report the state, and open the pane. Requesting it is not
    // possible — Apple exposes no API, so the user must flip the switch themselves.
    fullDiskAccessStatus: () =>
      ipcRenderer.invoke('system:fullDiskAccess:status') as Promise<{
        success: boolean
        data?: 'granted' | 'denied' | 'not-applicable'
        error?: string
      }>,
    openFullDiskAccessSettings: () =>
      ipcRenderer.invoke('system:fullDiskAccess:openSettings') as Promise<{
        success: boolean
        data?: boolean
        error?: string
      }>,
    grantPlaintextConsent: () => ipcRenderer.invoke('settings:grantPlaintextConsent'),
    hasPlaintextConsent: () => ipcRenderer.invoke('settings:hasPlaintextConsent'),

    // R4 — search-provider key namespace. Separate from AI providers so the
    // type-narrowed handler can refuse cross-namespace writes.
    listSearchProviderKeys: () => ipcRenderer.invoke('settings:listSearchProviderKeys'),
    saveSearchProviderKey: (provider: string, key: string) =>
      ipcRenderer.invoke('settings:saveSearchProviderKey', provider, key),
    deleteSearchProviderKey: (provider: string) =>
      ipcRenderer.invoke('settings:deleteSearchProviderKey', provider),

    // Fires whenever ANY key is saved or deleted, in EITHER namespace, from
    // ANY surface (Settings, the in-chat unlock prompt, onboarding). Emitted
    // by the keychain's own write path, so a surface that subscribes here can
    // never miss a key added somewhere else. Payload is the provider id only.
    onKeychainChanged: (cb: (provider: string) => void) => {
      const listener = (_: unknown, provider: string): void => cb(provider)
      ipcRenderer.on('keychain:changed', listener)
      return () => {
        ipcRenderer.removeListener('keychain:changed', listener)
      }
    },
    fileState: () => ipcRenderer.invoke('settings:fileState'),
    exportBundle: () => ipcRenderer.invoke('settings:exportBundle'),
    importBundle: () => ipcRenderer.invoke('settings:importBundle'),
    resetToDefaults: () => ipcRenderer.invoke('settings:resetToDefaults'),
  },

  model: {
    list: () => ipcRenderer.invoke('model:list'),
    listProviders: () => ipcRenderer.invoke('model:listProviders'),
    // DEPRECATED (P0 model plane, one phase): getActive = what the chat ROLE resolves to now
    // (or 'duin-brain' for "auto"); setActive(id) = move id's provider to the front of the
    // policy order. New callers use policyGet/policySet/resolve below.
    getActive: () => ipcRenderer.invoke('model:getActive'),
    setActive: (id: string) => ipcRenderer.invoke('model:setActive', id),
    // ── P0 model plane (electron/services/providers/roles.ts MODEL_IPC) ──
    // Operator-ordered provider preference (+ per-role overrides, local-only switch).
    policyGet: () => ipcRenderer.invoke('model:policy:get'),
    policySet: (patch: {
      order?: string[]
      roles?: Record<string, string[]>
      localOnlyBackground?: boolean
      /** chat/agentic tier preference: 'fast' (flash first, the default) | 'balanced' | 'strong'. */
      speed?: 'fast' | 'balanced' | 'strong'
    }) => ipcRenderer.invoke('model:policy:set', patch),
    // Provider health = a real 1-token completion, not a key check. healthList is the cached
    // view (≤10 min stale); healthProbe(provider | 'all') forces a fresh completion.
    healthList: () => ipcRenderer.invoke('model:health:list'),
    healthProbe: (target: string) => ipcRenderer.invoke('model:health:probe', target),
    // What a ROLE ('chat' | 'agentic' | 'extraction' | 'reviewer' | 'jury' | 'title' | 'embed')
    // resolves to right now: { modelId, provider, chain, source } or null. `pin` = a
    // per-conversation model id; 'duin-brain' means "no pin".
    resolve: (task: string, pin?: string) => ipcRenderer.invoke('model:resolve', task, pin),
    // Push: fires with the full ProviderHealth[] whenever any provider's health or cooldown
    // changes (probe, key save, classified failure, served request). keychain:changed pattern.
    onHealthChanged: (cb: (list: unknown[]) => void) => {
      const listener = (_: unknown, list: unknown[]): void => cb(list)
      ipcRenderer.on('model:health-changed', listener)
      return () => {
        ipcRenderer.removeListener('model:health-changed', listener)
      }
    },
    // Settings → Models → Background model: what DUIN's own structured work resolves to
    // right now, and why (setting / env pin / auto / nothing routable).
    describeBackground: () => ipcRenderer.invoke('model:describeBackground'),
    addCustom: (model: {
      id: string
      name: string
      provider?: string
      contextWindow: number
      supportsTools: boolean
      supportsVision: boolean
    }) => ipcRenderer.invoke('model:addCustom', model),
    removeCustom: (id: string) => ipcRenderer.invoke('model:removeCustom', id),
    verifyCatalog: () => ipcRenderer.invoke('model:verifyCatalog'),
    openRouterCatalog: () => ipcRenderer.invoke('model:openRouterCatalog'),
    // UA provider-expansion: pull a provider's live catalog, then import a chosen
    // id set as collision-safe custom models.
    listLive: (provider: string) => ipcRenderer.invoke('model:listLive', provider),
    importLive: (provider: string, ids: string[]) =>
      ipcRenderer.invoke('model:importLive', { provider, ids })
  },

  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    create: (skill: { name: string; description: string; content: string }) =>
      ipcRenderer.invoke('skills:create', skill),
    update: (id: string, skill: { name: string; description: string; content: string }) =>
      ipcRenderer.invoke('skills:update', id, skill),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    // Import skills from a user-chosen folder (any agent's skill collection).
    pickAndImport: () => ipcRenderer.invoke('skills:pickAndImport'),
    importFromDir: (dir: string) => ipcRenderer.invoke('skills:importFromDir', dir),
    // Asset browsing — the whole skill directory, so `scripts/`, `references/` and
    // `assets/` are visible rather than just the shallow siblings.
    listFiles: (id: string) => ipcRenderer.invoke('skills:listFiles', id),
    readFile: (id: string, relPath: string) => ipcRenderer.invoke('skills:readFile', id, relPath),
    // Packaging — a .zip whose root is the skill directory, the shape the Skills API
    // and claude.ai both accept.
    exportPackage: (id: string) => ipcRenderer.invoke('skills:export', id),
    importPackage: () => ipcRenderer.invoke('skills:importPackage'),
    onChanged: (cb: (skills: unknown[]) => void) => {
      const listener = (_: unknown, skills: unknown[]): void => cb(skills)
      ipcRenderer.on('skills:changed', listener)
      return () => {
        ipcRenderer.removeListener('skills:changed', listener)
      }
    }
  },

  // Methods — `type: method` vault notes that compose skills. Mirrors the skills
  // family so the Customize column can offer the same create/edit/import flow.
  methods: {
    list: () => ipcRenderer.invoke('methods:list'),
    create: (input: unknown) => ipcRenderer.invoke('methods:create', input),
    update: (path: string, input: unknown) => ipcRenderer.invoke('methods:update', path, input),
    delete: (path: string) => ipcRenderer.invoke('methods:delete', path),
    read: (path: string) => ipcRenderer.invoke('methods:read', path),
    pickAndImport: () => ipcRenderer.invoke('methods:pickAndImport'),
    onChanged: (cb: () => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('methods:changed', listener)
      return () => {
        ipcRenderer.removeListener('methods:changed', listener)
      }
    }
  },

  memory: {
    // `filter` is optional; pass `{ type?: MemoryType, projectSlug?: string }`
    // to scope the result to a typed file-backed view. The no-arg form
    // returns the legacy shape (numeric ids) so the pre-D3 MemoryPanel
    // keeps rendering during the transition.
    list: (filter?: { type?: string; projectSlug?: string }) =>
      ipcRenderer.invoke('memory:list', filter),
    add: (content: string) => ipcRenderer.invoke('memory:add', content),
    update: (id: number, content: string) => ipcRenderer.invoke('memory:update', id, content),
    delete: (idOrName: number | string) => ipcRenderer.invoke('memory:delete', idOrName),
    clear: () => ipcRenderer.invoke('memory:clear'),
    export: () => ipcRenderer.invoke('memory:export'),
    import: (entries: unknown[]) => ipcRenderer.invoke('memory:import', entries),
    // Typed file-backed surface (D1).
    write: (payload: {
      name: string
      type: 'user' | 'feedback' | 'project' | 'reference'
      body: string
      description?: string
      /** Where this memory came from. Omitted → 'unknown'; the operator-facing
       *  editor passes 'user-explicit', conversation capture passes 'session'. */
      source?:
        | 'user-explicit'
        | 'session'
        | 'inferred'
        | 'reflection'
        | 'imported'
        | 'unknown'
      projectSlug?: string
      sourceConversationId?: string
      /** 'create' disambiguates the slug instead of replacing a colliding entry. */
      mode?: 'create' | 'overwrite'
    }) => ipcRenderer.invoke('memory:write', payload),
    read: (name: string) => ipcRenderer.invoke('memory:read', name),
    search: (query: string, limit?: number) => ipcRenderer.invoke('memory:search', query, limit),
    // D2: read the on-disk MEMORY.md for a project, plus the broken-link
    // list so D3's sidebar pip can surface "to-write" suggestions.
    readIndex: (projectSlug?: string) => ipcRenderer.invoke('memory:readIndex', projectSlug),
    listBrokenLinks: (projectSlug?: string) =>
      ipcRenderer.invoke('memory:listBrokenLinks', projectSlug),
    onAdded: (cb: (entry: unknown) => void) =>
      ipcRenderer.on('memory:added', (_, entry) => cb(entry)),
    onChanged: (cb: (entries: unknown[]) => void): (() => void) => {
      const handler = (_: unknown, entries: unknown[]) => cb(entries)
      ipcRenderer.on('memory:changed', handler)
      return () => ipcRenderer.removeListener('memory:changed', handler)
    }
  },

  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    get: (id: string) => ipcRenderer.invoke('plugins:get', id),
    enable: (id: string) => ipcRenderer.invoke('plugins:enable', id),
    disable: (id: string) => ipcRenderer.invoke('plugins:disable', id),
    remove: (id: string) => ipcRenderer.invoke('plugins:remove', id),
    installFromDirectory: (srcPath: string) =>
      ipcRenderer.invoke('plugins:installFromDirectory', srcPath),
    installFromManifest: (manifest: unknown, files?: Record<string, string>) =>
      ipcRenderer.invoke('plugins:installFromManifest', manifest, files),
    installFromUrl: (url: string) => ipcRenderer.invoke('plugins:installFromUrl', url),
    // Two-step URL install: stage (clone to scratch, install nothing) → the
    // operator reads what it would run → commit (native approval per stdio
    // connector, then install disabled). See ipc/plugins.ts.
    stageFromUrl: (url: string) => ipcRenderer.invoke('plugins:stageFromUrl', url),
    commitStaged: (stageId: string) => ipcRenderer.invoke('plugins:commitStaged', stageId),
    discardStaged: (stageId: string) => ipcRenderer.invoke('plugins:discardStaged', stageId),
    listBundledAvailable: () => ipcRenderer.invoke('plugins:listBundledAvailable'),
    installBundled: (id: string) => ipcRenderer.invoke('plugins:installBundled', id),
    pickDirectory: () => ipcRenderer.invoke('plugins:pickDirectory'),
    onChanged: (cb: (entries: unknown[]) => void) => {
      const handler = (_: unknown, entries: unknown[]) => cb(entries)
      ipcRenderer.on('plugins:changed', handler)
      return () => ipcRenderer.removeListener('plugins:changed', handler)
    }
  },

  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    getStatus: (id: string) => ipcRenderer.invoke('mcp:getStatus', id),
    reconnect: (id: string) => ipcRenderer.invoke('mcp:reconnect', id),
    addServer: (config: unknown) => ipcRenderer.invoke('mcp:addServer', config),
    // Post-add controls. Without these an added connector is permanent, a disabled
    // one can never be turned on, and a server needing a secret can only be fixed by
    // hand-editing mcp-servers.json.
    removeServer: (id: string) => ipcRenderer.invoke('mcp:removeServer', id),
    updateServer: (id: string, patch: unknown) => ipcRenderer.invoke('mcp:updateServer', id, patch),
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('mcp:setEnabled', id, enabled),
    openConfigFolder: () => ipcRenderer.invoke('mcp:openConfigFolder'),
    setupGoogleOAuth: () => ipcRenderer.invoke('mcp:setupGoogleOAuth'),
    // Part B — read-only Google connect state (token presence + expiry).
    googleAuthStatus: () => ipcRenderer.invoke('mcp:googleAuthStatus'),
    // MR — MCP Resources surface.
    listResources: (id: string, cursor?: string) =>
      ipcRenderer.invoke('mcp:listResources', id, cursor),
    listResourceTemplates: (id: string, cursor?: string) =>
      ipcRenderer.invoke('mcp:listResourceTemplates', id, cursor),
    readResource: (id: string, uri: string) => ipcRenderer.invoke('mcp:readResource', id, uri),
    openResource: (id: string, uri: string) => ipcRenderer.invoke('mcp:openResource', id, uri),
    approveToolCall: (callId: string, approved: boolean) =>
      ipcRenderer.invoke('mcp:approveToolCall', callId, approved),
    onStatusChanged: (cb: (e: unknown) => void) =>
      ipcRenderer.on('mcp:statusChanged', (_, e) => cb(e)),
    onConfirmationRequired: (cb: (e: unknown) => void) =>
      ipcRenderer.on('mcp:confirmationRequired', (_, e) => cb(e))
  },

  tools: {
    // Track 2 / C1: `tools:list` returns lightweight stubs (no inputSchema).
    // Renderer uses `resolve` / `search` to pull full descriptors on demand.
    list: () => ipcRenderer.invoke('tools:list'),
    get: (id: string) => ipcRenderer.invoke('tools:get', id),
    resolve: (names: string[]) => ipcRenderer.invoke('tools:resolve', names),
    search: (payload: { query: string; maxResults?: number }) =>
      ipcRenderer.invoke('tools:search', payload),
    getRecentCalls: (limit?: number) => ipcRenderer.invoke('tools:getRecentCalls', limit),
    getCallsForConversation: (conversationId: string, limit?: number) =>
      ipcRenderer.invoke('tools:getCallsForConversation', conversationId, limit),
    /**
     * Subscribe to approval requests. Returns an unsubscribe function so
     * effect cleanup (hot reload, dialog remount) can detach the listener
     * and avoid duplicate modal handling.
     */
    onApprovalRequired: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('tools:approvalRequired', handler)
      return () => ipcRenderer.removeListener('tools:approvalRequired', handler)
    },
    /**
     * Subscribe to approval CANCELLATIONS — the other half of the conversation.
     * cancelPending resolves the request in main when a chat round is aborted, but
     * nothing told the window, so the full-screen modal stayed up over a turn that had
     * already been cancelled and answering it did nothing.
     */
    onApprovalCancelled: (cb: (e: { callId: string }) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e as { callId: string })
      ipcRenderer.on('tools:approvalCancelled', handler)
      return () => ipcRenderer.removeListener('tools:approvalCancelled', handler)
    },
    respondToApproval: (response: {
      callId: string
      decision: 'allow' | 'deny'
      scope: 'once' | 'conversation' | 'workspace' | 'always'
    }) => ipcRenderer.invoke('tools:respondToApproval', response)
  },

  persistence: {
    // PS4–PS10 — read-write surface for the persistence floor.
    getStatus: () => ipcRenderer.invoke('persistence:getStatus'),
    runIntegrityCheck: () => ipcRenderer.invoke('persistence:runIntegrityCheck'),
    forceCheckpoint: () => ipcRenderer.invoke('persistence:forceCheckpoint'),
    createBackup: () => ipcRenderer.invoke('persistence:createBackup'),
    listBackups: () => ipcRenderer.invoke('persistence:listBackups'),
    restoreFromBackup: (backupPath: string) =>
      ipcRenderer.invoke('persistence:restoreFromBackup', backupPath),
    // PS9 encryption opt-in.
    getEncryptionStatus: () => ipcRenderer.invoke('persistence:getEncryptionStatus'),
    enableEncryption: (passphrase: string) =>
      ipcRenderer.invoke('persistence:enableEncryption', passphrase),
    disableEncryption: (passphrase: string) =>
      ipcRenderer.invoke('persistence:disableEncryption', passphrase),
    changePassphrase: (oldPassphrase: string, newPassphrase: string) =>
      ipcRenderer.invoke('persistence:changePassphrase', oldPassphrase, newPassphrase),
    setReadOnlyMode: (enabled: boolean) =>
      ipcRenderer.invoke('persistence:setReadOnlyMode', enabled)
  },

  permissions: {
    listGlobalPolicies: () => ipcRenderer.invoke('permissions:listGlobalPolicies'),
    setGlobalPolicy: (toolId: string, decision: 'allow' | 'deny' | null) =>
      ipcRenderer.invoke('permissions:setGlobalPolicy', toolId, decision),
    clearConversationPolicies: (conversationId: string) =>
      ipcRenderer.invoke('permissions:clearConversationPolicies', conversationId),
    // Wider policy CRUD — Settings UI uses these to inspect/edit any scope.
    listPolicies: () => ipcRenderer.invoke('permissions:listPolicies'),
    addPolicy: (input: {
      scope: 'conversation' | 'workspace' | 'global'
      subjectKind: 'tool' | 'risk'
      subject: string
      decision: 'allow' | 'deny'
      conversationId?: string
      workspacePath?: string
    }) => ipcRenderer.invoke('permissions:addPolicy', input),
    deletePolicy: (id: string) => ipcRenderer.invoke('permissions:deletePolicy', id),
    clearScope: (scope: 'conversation' | 'workspace' | 'global') =>
      ipcRenderer.invoke('permissions:clearScope', scope),
    clearConversation: (conversationId: string) =>
      ipcRenderer.invoke('permissions:clearConversation', conversationId)
  },

  contracts: {
    create: (input: unknown) => ipcRenderer.invoke('contracts:create', input),
    update: (id: string, input: unknown) => ipcRenderer.invoke('contracts:update', id, input),
    close: (id: string) => ipcRenderer.invoke('contracts:close', id),
    waive: (input: { id: string; reason: string; waivedBy: string }) =>
      ipcRenderer.invoke('contracts:waive', input),
    get: (id: string) => ipcRenderer.invoke('contracts:get', id),
    list: (filter?: unknown) => ipcRenderer.invoke('contracts:list', filter ?? {}),
    active: (conversationId: string, correlationId?: string) =>
      ipcRenderer.invoke('contracts:active', conversationId, correlationId)
  },

  plan: {
    get: (conversationId: string) => ipcRenderer.invoke('plan:get', conversationId),
    update: (
      conversationId: string,
      input: {
        replace?: boolean
        steps?: Array<{ id?: string; text?: string; status?: 'pending' | 'in_progress' | 'done' }>
      }
    ) => ipcRenderer.invoke('plan:update', conversationId, input),
    listAllState: () => ipcRenderer.invoke('plan:listAllState'),
    clearConversationState: (conversationId: string) =>
      ipcRenderer.invoke('plan:clearConversationState', conversationId),
    clearAllState: () => ipcRenderer.invoke('plan:clearAllState'),
    onUpdated: (cb: (e: { conversationId: string; snapshot: unknown }) => void): (() => void) => {
      const handler = (_: unknown, e: { conversationId: string; snapshot: unknown }) => cb(e)
      ipcRenderer.on('plan:updated', handler)
      return () => ipcRenderer.removeListener('plan:updated', handler)
    },
    // Track 2 / C3 — plan-mode gate. Banner hydrates via `isModeActive` on
    // conversation switch; the Exit button calls `exitMode`. Live updates
    // arrive via `onModeChanged` (the model toggles via the
    // enter_plan_mode / exit_plan_mode tools mid-turn).
    isModeActive: (conversationId: string) =>
      ipcRenderer.invoke('plan:isModeActive', conversationId),
    enterMode: (conversationId: string) => ipcRenderer.invoke('plan:enterMode', conversationId),
    exitMode: (conversationId: string) => ipcRenderer.invoke('plan:exitMode', conversationId),
    onModeChanged: (cb: (e: { conversationId: string; active: boolean }) => void): (() => void) => {
      const handler = (_: unknown, e: { conversationId: string; active: boolean }) => cb(e)
      ipcRenderer.on('plan:mode-changed', handler)
      return () => ipcRenderer.removeListener('plan:mode-changed', handler)
    }
  },

  files: {
    process: (paths: string[]) => ipcRenderer.invoke('files:process', paths),
    processDropped: (files: File[]) => {
      const paths = files.map((file) => {
        try {
          return webUtils.getPathForFile(file)
        } catch {
          return ''
        }
      })
      return ipcRenderer.invoke('files:processDropped', paths)
    },
    /** Clipboard images have no path, so they take this route to get the same
     *  type-check + OCR an on-disk image gets. */
    processPastedImage: (input: { dataUrl: string; name: string; mimeType: string }) =>
      ipcRenderer.invoke('files:processPastedImage', input),
    openPicker: () => ipcRenderer.invoke('files:openPicker'),
    getWorkdir: () => ipcRenderer.invoke('files:getWorkdir'),
    pickWorkdir: () => ipcRenderer.invoke('files:pickWorkdir'),
    setWorkdir: (path: string) => ipcRenderer.invoke('files:setWorkdir', path),
    clearWorkdir: () => ipcRenderer.invoke('files:clearWorkdir'),
    openInVSCode: (args?: { targetPath?: string }) =>
      ipcRenderer.invoke('files:openInVSCode', args),
    openInExplorer: (args?: { targetPath?: string }) =>
      ipcRenderer.invoke('files:openInExplorer', args),
    listDir: (dirPath: string) => ipcRenderer.invoke('files:listDir', dirPath),
    readText: (filePath: string) => ipcRenderer.invoke('files:readText', filePath),
    walkProject: (rootPath: string) => ipcRenderer.invoke('files:walkProject', rootPath),
    getPathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },

  // Track 2 / E1 — session chapters. `markChapter` anchors a chapter to
  // a message; `list` hydrates the renderer's TOC; `chaptersForAnchor`
  // returns rows pinned to a specific message id; `delete` removes one.
  // `onMarked` is the live subscription to `chat:chapter-marked` so any
  // open chapter sidebar updates without polling.
  session: {
    markChapter: (payload: {
      conversationId: string
      title: string
      summary?: string | null
      anchorMessageId: string
    }) => ipcRenderer.invoke('session:markChapter', payload),
    listChapters: (conversationId: string) =>
      ipcRenderer.invoke('session:listChapters', conversationId),
    chaptersForAnchor: (anchorMessageId: string) =>
      ipcRenderer.invoke('session:chaptersForAnchor', anchorMessageId),
    deleteChapter: (id: string) => ipcRenderer.invoke('session:deleteChapter', id),
    onChapterMarked: (
      cb: (e: { conversationId: string; chapter: unknown }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: { conversationId: string; chapter: unknown }) => cb(e)
      ipcRenderer.on('chat:chapter-marked', handler)
      return () => ipcRenderer.removeListener('chat:chapter-marked', handler)
    }
  },

  // Track 2 / C4 — slash commands. `list` returns user-visible commands
  // only (`hidden: true` entries stay out of the palette but `resolve`
  // still resolves them by name); `listAll` is for diagnostics; `resolve`
  // returns the interpolated prompt body. `onChanged` fires whenever
  // chokidar picks up a file mutation in userData/slash-commands.
  slash: {
    list: () => ipcRenderer.invoke('slash:list'),
    listAll: () => ipcRenderer.invoke('slash:listAll'),
    resolve: (payload: { name: string; rest?: string }) =>
      ipcRenderer.invoke('slash:resolve', payload),
    onChanged: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown) => cb(e)
      ipcRenderer.on('slash:changed', handler)
      return () => ipcRenderer.removeListener('slash:changed', handler)
    }
  },

  // Track 1 / B1+B3 — workflow runner control. `runInline` accepts a
  // raw script body; `run` fires a named workflow from disk. Progress
  // events arrive over `workflow:progress`.
  workflows: {
    list: () => ipcRenderer.invoke('workflows:list'),
    validate: (input: { script: string }) => ipcRenderer.invoke('workflows:validate', input),
    // `overwrite` reaches the handler now. workflows:save has always accepted it, and
    // without it a re-save of the same workflow name is refused — so a user-authored
    // workflow could be created once and never edited through the UI again.
    save: (input: { script: string; overwrite?: boolean }) =>
      ipcRenderer.invoke('workflows:save', input),
    // ...and workflows:delete existed in main with no binding at all, so there was no
    // way to remove one either.
    delete: (input: { name: string }) => ipcRenderer.invoke('workflows:delete', input),
    runInline: (input: {
      script: string
      args?: unknown
      budgetTotal?: number | null
      concurrencyCap?: number
      timeoutMs?: number
      // Journals now write on every run (electron/ipc/workflows.ts); passing
      // the prior run's id here replays its cached agent() results.
      resumeFromRunId?: string
    }) => ipcRenderer.invoke('workflows:runInline', input),
    run: (input: { name: string; args?: unknown; resumeFromRunId?: string }) =>
      ipcRenderer.invoke('workflows:run', input),
    stop: (runId: string) => ipcRenderer.invoke('workflows:stop', runId),
    onProgress: (listener: (event: unknown) => void): (() => void) => {
      const wrapped = (_e: unknown, event: unknown): void => listener(event)
      ipcRenderer.on('workflow:progress', wrapped)
      return () => ipcRenderer.removeListener('workflow:progress', wrapped)
    }
  },

  // Track 1 / A2 — background subagent task tracking. `onNotify` fires
  // when a background fork completes; E6 (this branch) layers the
  // async-event-bridge on top so the next user turn sees a synthetic
  // <task-notifications> block.
  tasks: {
    spawn: (payload: {
      sourceConversationId: string
      title: string
      prompt: string
      tldr?: string | null
      cwd?: string | null
      model?: string | null
    }) => ipcRenderer.invoke('tasks:spawn', payload),
    list: (filter?: {
      status?:
        | 'running'
        | 'done'
        | 'error'
        | 'aborted'
        | Array<'running' | 'done' | 'error' | 'aborted'>
      parentConvId?: string | null
      parentRunId?: string | null
      background?: boolean
      limit?: number
    }) => ipcRenderer.invoke('tasks:list', filter),
    get: (id: string) => ipcRenderer.invoke('tasks:get', id),
    output: (id: string) => ipcRenderer.invoke('tasks:output', id),
    stop: (id: string) => ipcRenderer.invoke('tasks:stop', id),
    update: (id: string, patch: { label?: string }) =>
      ipcRenderer.invoke('tasks:update', id, patch),
    onNotify: (listener: (event: unknown) => void): (() => void) => {
      const wrapped = (_e: unknown, event: unknown): void => listener(event)
      ipcRenderer.on('agent:run:notify', wrapped)
      return () => ipcRenderer.removeListener('agent:run:notify', wrapped)
    },
    onSpawned: (listener: (event: unknown) => void): (() => void) => {
      const wrapped = (_e: unknown, event: unknown): void => listener(event)
      ipcRenderer.on('tasks:spawned', wrapped)
      return () => ipcRenderer.removeListener('tasks:spawned', wrapped)
    }
  },

  // External executor (delegate_task → dsh). Status for the Settings card, and the
  // keep/discard review of what a delegated run produced. The renderer reads and decides;
  // it cannot START a run (that is the gated delegate_task tool).
  executor: {
    status: () => ipcRenderer.invoke('executor:status'),
    reviews: () => ipcRenderer.invoke('executor:reviews'),
    reviewDiff: (runId: string) => ipcRenderer.invoke('executor:reviewDiff', runId),
    keep: (runId: string) => ipcRenderer.invoke('executor:keep', runId),
    discard: (runId: string) => ipcRenderer.invoke('executor:discard', runId)
  },

  // Canonical task graph (conversation + agent-run nodes) + read/wait +
  // recoverable/destructive lifecycle. Distinct from `tasks.*` (agent_runs
  // table). Channels are task-graph:*. `onNotify` reuses the agent:run:notify
  // broadcast — the same signal that wakes wait_tasks — so the panel refreshes
  // whenever a background fork changes state.
  taskGraph: {
    graph: (query?: {
      cursor?: string | null
      limit?: number
      rootConversationId?: string | null
    }) => ipcRenderer.invoke('task-graph:graph', query),
    readGraphTask: (taskId: string) => ipcRenderer.invoke('task-graph:readGraphTask', taskId),
    waitGraph: (
      targets: Array<{ taskId: string; afterCursor?: string | null }>,
      timeoutMs?: number
    ) => ipcRenderer.invoke('task-graph:waitGraph', targets, timeoutMs),
    updateMetadata: (
      taskId: string,
      action: 'rename' | 'pin' | 'unpin' | 'archive' | 'restore' | 'close',
      value?: string | null
    ) => ipcRenderer.invoke('task-graph:updateMetadata', taskId, action, value),
    previewDelete: (taskId: string) => ipcRenderer.invoke('task-graph:previewDelete', taskId),
    deleteGraphTask: (taskId: string, previewToken: string) =>
      ipcRenderer.invoke('task-graph:deleteGraphTask', taskId, previewToken),
    onNotify: (listener: (event: unknown) => void): (() => void) => {
      const wrapped = (_e: unknown, event: unknown): void => listener(event)
      ipcRenderer.on('agent:run:notify', wrapped)
      return () => ipcRenderer.removeListener('agent:run:notify', wrapped)
    }
  },

  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
    create: (input: {
      event: string
      label: string
      command: string
      language?: 'js' | 'shell'
      timeoutMs?: number
    }) => ipcRenderer.invoke('hooks:create', input),
    update: (
      id: string,
      patch: Partial<{
        event: string
        label: string
        command: string
        enabled: boolean
        language: 'js' | 'shell'
        timeoutMs: number
      }>
    ) => ipcRenderer.invoke('hooks:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('hooks:delete', id),
    // Track 2 / C2 — test-run an unsaved hook body against a sample context.
    test: (payload: {
      code: string
      event: string
      context?: {
        conversationId?: string
        toolName?: string
        args?: Record<string, unknown>
        result?: string
        promptBody?: string
        cwd?: string
      }
      timeoutMs?: number
    }) => ipcRenderer.invoke('hooks:test', payload)
  },

  automations: {
    list: () => ipcRenderer.invoke('automations:list'),
    create: (input: { label: string; cron: string; prompt: string; model?: string }) =>
      ipcRenderer.invoke('automations:create', input),
    update: (
      id: string,
      patch: Partial<{
        label: string
        cron: string
        prompt: string
        model: string
        enabled: boolean
      }>
    ) => ipcRenderer.invoke('automations:update', id, patch),
    delete: (id: string) => ipcRenderer.invoke('automations:delete', id),
    runNow: (id: string) => ipcRenderer.invoke('automations:runNow', id),
    validateCron: (expr: string) => ipcRenderer.invoke('automations:validateCron', expr),
    // UA-AUTO: durable run-history ledger (automation_runs) for the RunHistoryViewer.
    runs: (id: string, limit?: number) => ipcRenderer.invoke('automations:runs', id, limit)
  },

  loops: {
    schedule: (input: {
      conversationId: string
      delaySeconds: number
      prompt: string
      reason?: string | null
    }) => ipcRenderer.invoke('loops:schedule', input),
    cancel: (id: string) => ipcRenderer.invoke('loops:cancel', id),
    runAgentic: (name: string) => ipcRenderer.invoke('loops:runAgentic', name),
    list: (filter?: {
      conversationId?: string
      status?:
        | 'pending'
        | 'fired'
        | 'cancelled'
        | 'error'
        | Array<'pending' | 'fired' | 'cancelled' | 'error'>
      limit?: number
    }) => ipcRenderer.invoke('loops:list', filter),
    onFired: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_: unknown, event: unknown): void => cb(event)
      ipcRenderer.on('loop:wakeup:fired', handler)
      return () => ipcRenderer.removeListener('loop:wakeup:fired', handler)
    },
    // LP-7 — loop entities (recurring loops, distinct from one-shot wake-ups).
    create: (input: {
      mode: 'interval' | 'self_paced' | 'autonomous'
      conversationId?: string
      instruction?: string
      model?: string
      intervalSeconds?: number
      tasks?: string[]
    }) => ipcRenderer.invoke('loops:create', input),
    listLoops: (filter?: { conversationId?: string; status?: string | string[]; limit?: number }) =>
      ipcRenderer.invoke('loops:listLoops', filter),
    getLoop: (id: string) => ipcRenderer.invoke('loops:getLoop', id),
    pause: (id: string) => ipcRenderer.invoke('loops:pause', id),
    resume: (id: string) => ipcRenderer.invoke('loops:resume', id),
    stop: (id: string, reason?: string) => ipcRenderer.invoke('loops:stop', id, reason),
    // Governor 4a — decide a HELD (staged) iteration: 'ratify' (land) | 'revert' (discard) | 'dismiss' (defer).
    ratify: (backlogId: string, verb: 'ratify' | 'revert' | 'dismiss') =>
      ipcRenderer.invoke('loops:ratify', backlogId, verb),
    deleteLoop: (id: string) => ipcRenderer.invoke('loops:deleteLoop', id),
    listBacklog: (loopId: string) => ipcRenderer.invoke('loops:listBacklog', loopId),
    enqueue: (loopId: string, tasks: string[]) => ipcRenderer.invoke('loops:enqueue', loopId, tasks),
    reorderBacklog: (loopId: string, orderedIds: string[]) =>
      ipcRenderer.invoke('loops:reorderBacklog', loopId, orderedIds),
    removeBacklog: (id: string) => ipcRenderer.invoke('loops:removeBacklog', id),
    listRuns: (loopId: string, limit?: number) => ipcRenderer.invoke('loops:listRuns', loopId, limit),
    onLoopEvent: (cb: (event: { channel: string; payload: unknown }) => void): (() => void) => {
      const channels = [
        'loop:iteration:start',
        'loop:iteration:done',
        'loop:iteration:error',
        'loop:stopped',
        // Governor 4a — an iteration's output was HELD; the UI surfaces a ratify/revert control.
        'loop:staged'
      ]
      const handlers = channels.map((channel) => {
        const handler = (_: unknown, payload: unknown): void => cb({ channel, payload })
        ipcRenderer.on(channel, handler)
        return { channel, handler }
      })
      return () => handlers.forEach(({ channel, handler }) => ipcRenderer.removeListener(channel, handler))
    }
  },
  // W2 considerate-RSI — staged self-tune proposals awaiting the operator's decision.
  // 'ratify' applies (byte-reversible, judged by the held-out A/B); 'dismiss' parks that
  // value for good (never re-asked). The Needs-you panel is the renderer caller.
  rsi: {
    pending: () => ipcRenderer.invoke('rsi:pending'),
    resolve: (id: string, verb: 'ratify' | 'dismiss') => ipcRenderer.invoke('rsi:resolve', id, verb)
  },

  // The inbox record: what happened while you weren't looking, and what still wants a
  // decision. Read/ack only — producers are main-process services.
  notices: {
    list: (opts?: { limit?: number; includeRead?: boolean }) =>
      ipcRenderer.invoke('notices:list', opts ?? {}),
    counts: () => ipcRenderer.invoke('notices:counts'),
    markRead: (ids: string[]) => ipcRenderer.invoke('notices:markRead', ids),
    resolve: (ids: string[]) => ipcRenderer.invoke('notices:resolve', ids),
    markAllRead: () => ipcRenderer.invoke('notices:markAllRead'),
    onChanged: (cb: (counts: { unread: number; needsDecision: number }) => void): (() => void) => {
      const handler = (_: unknown, counts: { unread: number; needsDecision: number }): void =>
        cb(counts)
      ipcRenderer.on('notices:changed', handler)
      return () => ipcRenderer.removeListener('notices:changed', handler)
    }
  },
  // Executive API membrane — the operator's side of agent pairing (the agent's
  // side lives on /exec/mcp). Approval is renderer-IPC only, by design.
  executive: {
    pairings: {
      list: () => ipcRenderer.invoke('executive:pairings:list'),
      approve: (pairingId: string, grantPlanes?: string[]) =>
        ipcRenderer.invoke('executive:pairings:approve', pairingId, grantPlanes),
      deny: (pairingId: string) => ipcRenderer.invoke('executive:pairings:deny', pairingId)
    },
    principals: {
      list: () => ipcRenderer.invoke('executive:principals:list'),
      // Returns the plaintext token ONCE. It is never stored and no other call can return it.
      create: (input: { name: string; kind?: string; planes?: string[] }) =>
        ipcRenderer.invoke('executive:principals:create', input),
      setStatus: (principalId: string, status: 'active' | 'paused' | 'revoked') =>
        ipcRenderer.invoke('executive:principals:setStatus', principalId, status),
      reissue: (principalId: string) =>
        ipcRenderer.invoke('executive:principals:reissue', principalId),
      // `null` on a field resets it to the default; omitting the field leaves it alone.
      updateGrant: (
        principalId: string,
        patch: {
          scope?: string[] | null
          writeScope?: string | null
          quota?: { callsPerHour: number; charsPerHour: number } | null
        }
      ) => ipcRenderer.invoke('executive:principals:updateGrant', principalId, patch)
    },
    goals: {
      decide: (actionId: string, approve: boolean, completion?: string) =>
        ipcRenderer.invoke('executive:goals:decide', actionId, approve, completion)
    }
  },

  notifications: {
    push: (input: { title: string; body: string; deepLink?: string | null }) =>
      ipcRenderer.invoke('notifications:push', input),
    onClicked: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_: unknown, event: unknown): void => cb(event)
      ipcRenderer.on('notifications:clicked', handler)
      return () => ipcRenderer.removeListener('notifications:clicked', handler)
    },
    // Retention (Dim 8): jargon-free "send me a daily brain digest" opt-in. The
    // schedule persists to userData and re-arms across restarts (main-side).
    getDigestSchedule: () =>
      ipcRenderer.invoke('notifications:getDigestSchedule') as Promise<{
        success: boolean
        data?: { enabled: boolean; hour: number; minute: number }
        error?: string
      }>,
    setDigestSchedule: (input: { enabled?: boolean; hour?: number; minute?: number }) =>
      ipcRenderer.invoke('notifications:setDigestSchedule', input) as Promise<{
        success: boolean
        data?: { enabled: boolean; hour: number; minute: number }
        error?: string
      }>
  },

  // Feedback channel (DUIN nervous system, organ #1). record() persists the
  // user's verdict on a proactive surface as a typed seed; engagement() reads
  // the per-detectorClass tally that gates loudness / earned autonomy.
  feedback: {
    record: (input: {
      sourceCardId: string
      sourceKind: 'notice' | 'notification' | 'activity-card'
      action: 'act' | 'snooze' | 'dismiss' | 'not-relevant'
      detectorClass?: string | null
      conversationId?: string | null
      title?: string | null
      engineRef?: {
        kind: 'forecast' | 'prediction' | 'insight' | 'cascade'
        id: string
        domain?: string | null
      } | null
    }) => ipcRenderer.invoke('feedback:record', input),
    engagement: (opts?: { sinceMs?: number; limit?: number }) =>
      ipcRenderer.invoke('feedback:engagement', opts)
  },

  // Consumption bridge (DUIN nervous system, organ #2). drain() pumps recorded
  // feedback seeds into the engine (forwarding the mappable ones over HTTP,
  // staging the rest locally); status() reads the delivery ledger summary.
  feedbackBridge: {
    drain: () => ipcRenderer.invoke('feedback-bridge:drain'),
    status: () => ipcRenderer.invoke('feedback-bridge:status')
  },

  sessionsMessaging: {
    sendMessage: (input: {
      targetSessionId: string
      body: string
      fromSessionId?: string | null
    }) => ipcRenderer.invoke('sessions-messaging:sendMessage', input),
    onIncoming: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_: unknown, event: unknown): void => cb(event)
      ipcRenderer.on('sessions:incoming-message', handler)
      return () => ipcRenderer.removeListener('sessions:incoming-message', handler)
    }
  },

  askUser: {
    respond: (payload: { requestId: string; answer: unknown }) =>
      ipcRenderer.invoke('ask-user:respond', payload),
    list: () => ipcRenderer.invoke('ask-user:list'),
    cancelAll: () => ipcRenderer.invoke('ask-user:cancelAll'),
    onAwaiting: (cb: (event: unknown) => void): (() => void) => {
      const handler = (_: unknown, event: unknown): void => cb(event)
      ipcRenderer.on('ask-user:awaiting', handler)
      return () => ipcRenderer.removeListener('ask-user:awaiting', handler)
    }
  },

  statusline: {
    get: () => ipcRenderer.invoke('statusline:get'),
    set: (input: { slots?: string[]; formats?: Record<string, string> }) =>
      ipcRenderer.invoke('statusline:set', input),
    availableSlots: () => ipcRenderer.invoke('statusline:availableSlots')
  },

  snip: {
    stats: () => ipcRenderer.invoke('snip:stats'),
    recent: (payload?: { limit?: number }) => ipcRenderer.invoke('snip:recent', payload),
    listFilters: () => ipcRenderer.invoke('snip:listFilters'),
    reloadFilters: () => ipcRenderer.invoke('snip:reloadFilters'),
    discover: (payload?: { sinceDays?: number; limit?: number }) =>
      ipcRenderer.invoke('snip:discover', payload),
    clearHistory: () => ipcRenderer.invoke('snip:clearHistory'),
    openFilterDir: () => ipcRenderer.invoke('snip:openFilterDir'),
    onFiltersChanged: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('snip:filters-changed', handler)
      return () => ipcRenderer.removeListener('snip:filters-changed', handler)
    }
  },

  worktree: {
    list: (args: { cwd?: string }) => ipcRenderer.invoke('worktree:list', args),
    create: (args: { cwd?: string; path: string; branch: string; baseRef?: string }) =>
      ipcRenderer.invoke('worktree:create', args),
    remove: (args: { cwd?: string; path: string; force?: boolean }) =>
      ipcRenderer.invoke('worktree:remove', args)
  },

  projects: {
    list: (args?: { includeArchived?: boolean }) => ipcRenderer.invoke('projects:list', args),
    get: (id: string) => ipcRenderer.invoke('projects:get', id),
    create: (input: { name: string; path?: string | null; description?: string | null }) =>
      ipcRenderer.invoke('projects:create', input),
    rename: (id: string, name: string) => ipcRenderer.invoke('projects:rename', id, name),
    setPinned: (id: string, pinned: boolean) =>
      ipcRenderer.invoke('projects:setPinned', id, pinned),
    setArchived: (id: string, archived: boolean) =>
      ipcRenderer.invoke('projects:setArchived', id, archived),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    openFolder: (id: string) => ipcRenderer.invoke('projects:openFolder', id),
    copyPath: (id: string) => ipcRenderer.invoke('projects:copyPath', id),
    assignConversation: (conversationId: string, projectId: string | null) =>
      ipcRenderer.invoke('projects:assignConversation', conversationId, projectId),
    ensureForPath: (path: string, fallbackName?: string) =>
      ipcRenderer.invoke('projects:ensureForPath', path, fallbackName),
    select: (id: string) => ipcRenderer.invoke('projects:select', id),
    update: (id: string, patch: { name?: string | null; description?: string | null; path?: string | null }) =>
      ipcRenderer.invoke('projects:update', id, patch)
  },

  review: {
    status: (args: { cwd?: string }) => ipcRenderer.invoke('review:status', args),
    diff: (args: { cwd?: string; path?: string; staged?: boolean }) =>
      ipcRenderer.invoke('review:diff', args),
    stage: (args: { cwd?: string; path: string }) => ipcRenderer.invoke('review:stage', args),
    unstage: (args: { cwd?: string; path: string }) => ipcRenderer.invoke('review:unstage', args),
    discard: (args: { cwd?: string; path: string }) => ipcRenderer.invoke('review:discard', args),
    branches: (args?: { cwd?: string }) => ipcRenderer.invoke('review:branches', args),
    checkout: (args: { cwd?: string; name: string }) => ipcRenderer.invoke('review:checkout', args),
    createBranch: (args: { cwd?: string; name: string }) =>
      ipcRenderer.invoke('review:createBranch', args),
    summary: (args?: { cwd?: string }) => ipcRenderer.invoke('review:summary', args),
    commit: (args: { cwd?: string; message: string; stageAll?: boolean }) =>
      ipcRenderer.invoke('review:commit', args),
    push: (args?: { cwd?: string }) => ipcRenderer.invoke('review:push', args),
    onChanged: (cb: (e: { cwd: string }) => void) => {
      const handler = (_: unknown, e: { cwd: string }) => cb(e)
      ipcRenderer.on('review:changed', handler)
      return () => ipcRenderer.removeListener('review:changed', handler)
    }
  },

  browser: {
    newTab: (args: { url?: string }) => ipcRenderer.invoke('browser:newTab', args),
    closeTab: (args: { id: string }) => ipcRenderer.invoke('browser:closeTab', args),
    setActiveTab: (args: { id: string }) => ipcRenderer.invoke('browser:setActiveTab', args),
    navigate: (args: { id: string; url: string }) => ipcRenderer.invoke('browser:navigate', args),
    back: (args: { id: string }) => ipcRenderer.invoke('browser:back', args),
    forward: (args: { id: string }) => ipcRenderer.invoke('browser:forward', args),
    reload: (args: { id: string }) => ipcRenderer.invoke('browser:reload', args),
    setBounds: (args: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('browser:setBounds', args),
    setVisible: (args: { visible: boolean }) => ipcRenderer.invoke('browser:setVisible', args),
    listTabs: () => ipcRenderer.invoke('browser:listTabs'),
    onTabUpdated: (
      cb: (e: {
        id: string
        title: string
        url: string
        loading: boolean
        canGoBack: boolean
        canGoForward: boolean
      }) => void
    ) => ipcRenderer.on('browser:tabUpdated', (_, e) => cb(e)),
    onTabClosed: (cb: (e: { id: string; activeTabId: string | null }) => void) =>
      ipcRenderer.on('browser:tabClosed', (_, e) => cb(e)),
    onActiveTab: (cb: (e: { id: string }) => void) =>
      ipcRenderer.on('browser:activeTab', (_, e) => cb(e)),
    offAll: () => {
      ;['browser:tabUpdated', 'browser:tabClosed', 'browser:activeTab'].forEach((ch) =>
        ipcRenderer.removeAllListeners(ch)
      )
    }
  },

  // F4 — Background shell + monitor primitive.
  shellBg: {
    spawn: (args: {
      command: string
      cwd?: string
      env?: Record<string, string>
      emitLines?: boolean
    }) => ipcRenderer.invoke('shell:bg:spawn', args),
    list: () => ipcRenderer.invoke('shell:bg:list'),
    get: (processId: string) => ipcRenderer.invoke('shell:bg:get', processId),
    kill: (processId: string) => ipcRenderer.invoke('shell:bg:kill', processId),
    destroy: (processId: string) => ipcRenderer.invoke('shell:bg:destroy', processId),
    onLine: (
      cb: (evt: {
        processId: string
        stream: 'stdout' | 'stderr'
        line: string
        at: number
      }) => void
    ) => {
      const h = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('shell:bg:line', h)
      return () => ipcRenderer.removeListener('shell:bg:line', h)
    },
    onExit: (
      cb: (evt: {
        processId: string
        exitCode: number | null
        signal: string | null
        durationMs: number
      }) => void
    ) => {
      const h = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('shell:bg:exit', h)
      return () => ipcRenderer.removeListener('shell:bg:exit', h)
    }
  },

  monitor: {
    start: (opts: { processId: string; untilPattern?: string }) =>
      ipcRenderer.invoke('monitor:start', opts),
    read: (streamId: string, since?: number) => ipcRenderer.invoke('monitor:read', streamId, since),
    stop: (streamId: string) => ipcRenderer.invoke('monitor:stop', streamId),
    destroy: (streamId: string) => ipcRenderer.invoke('monitor:destroy', streamId),
    list: () => ipcRenderer.invoke('monitor:list'),
    onLine: (cb: (evt: { streamId: string; processId: string; entry: unknown }) => void) => {
      const h = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('monitor:line', h)
      return () => ipcRenderer.removeListener('monitor:line', h)
    },
    onMatched: (
      cb: (evt: {
        streamId: string
        processId: string
        matchedLine: string
        entry: unknown
      }) => void
    ) => {
      const h = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('monitor:matched', h)
      return () => ipcRenderer.removeListener('monitor:matched', h)
    },
    onExit: (
      cb: (evt: { streamId: string; processId: string; exitCode: number | null }) => void
    ) => {
      const h = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('monitor:exit', h)
      return () => ipcRenderer.removeListener('monitor:exit', h)
    }
  },

  terminal: {
    spawn: (args: {
      id: string
      cwd?: string
      shellKind?: 'powershell' | 'cmd' | 'git-bash' | 'wsl'
    }) => ipcRenderer.invoke('terminal:spawn', args),
    write: (args: { id: string; data: string }) => ipcRenderer.invoke('terminal:write', args),
    resize: (args: { id: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('terminal:resize', args),
    kill: (args: { id: string }) => ipcRenderer.invoke('terminal:kill', args),
    onData: (cb: (e: { id: string; chunk: string }) => void) => {
      const handler = (_: unknown, e: { id: string; chunk: string }) => cb(e)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onExit: (cb: (e: { id: string; code: number | null; signal: string | null }) => void) => {
      const handler = (_: unknown, e: { id: string; code: number | null; signal: string | null }) =>
        cb(e)
      ipcRenderer.on('terminal:exit', handler)
      return () => ipcRenderer.removeListener('terminal:exit', handler)
    },
    offAll: () => {
      ;['terminal:data', 'terminal:exit'].forEach((ch) => ipcRenderer.removeAllListeners(ch))
    }
  },

  artifact: {
    render: (type: string, content: string) => ipcRenderer.invoke('artifact:render', type, content),
    hide: () => ipcRenderer.invoke('artifact:hide'),
    show: () => ipcRenderer.invoke('artifact:show'),
    saveToLibrary: (name: string, html: string) => ipcRenderer.invoke('artifact:saveToLibrary', name, html),
    // Canvas blueprints. Separate from saveToLibrary because a canvas is a
    // first-class vault file (editable, indexed, JSON Canvas), not an artifact
    // snapshot under userData.
    saveCanvas: (name: string, json: string) => ipcRenderer.invoke('canvas:save', name, json),
    listCanvases: () => ipcRenderer.invoke('canvas:list'),
    readCanvas: (rel: string) => ipcRenderer.invoke('canvas:read', rel),
    openCanvasWindow: (rel: string) => ipcRenderer.invoke('canvas:openWindow', rel),
    saveCanvasAt: (rel: string, json: string) => ipcRenderer.invoke('canvas:saveAt', rel, json),
    /** Open a surface in its own window: 'canvas' (vault path) or 'node' (node id). */
    openDetached: (view: 'canvas' | 'node', key: string) =>
      ipcRenderer.invoke('window:openDetached', view, key),
    readVaultFile: (relpath: string) => ipcRenderer.invoke('artifact:readVaultFile', relpath),
    resize: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke('artifact:resize', bounds),
    openInWindow: (type: string, content: string) =>
      ipcRenderer.invoke('artifact:openInWindow', type, content),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    getSource: () => ipcRenderer.invoke('artifact:getSource'),
    getType: () => ipcRenderer.invoke('artifact:getType')
  },

  // AI-created HTML/MD files on disk (userData/artifacts/**) — the Artifacts surface.
  artifacts: {
    listFiles: () => ipcRenderer.invoke('artifacts:listFiles'),
    readFile: (path: string) => ipcRenderer.invoke('artifacts:readFile', path),
    persist: (type: string, content: string) =>
      ipcRenderer.invoke('artifacts:persist', type, content)
  },

  update: {
    onAvailable: (cb: (info: { version: string | null; releaseNotes: string | null }) => void) =>
      ipcRenderer.on('update:available', (_, info) => cb(info)),
    onDownloaded: (cb: (info: { version: string | null }) => void) =>
      ipcRenderer.on('update:downloaded', (_, info) => cb(info)),
    onError: (cb: (e: { message: string }) => void) =>
      ipcRenderer.on('update:error', (_, e) => cb(e)),
    restart: () => ipcRenderer.invoke('update:restart'),
    check: () => ipcRenderer.invoke('update:check'),
    // Notify-only updater (release M11): the operator starts the download from the banner.
    download: () => ipcRenderer.invoke('update:download')
  },

  shortcuts: {
    onCopyLastAssistant: (cb: () => void) =>
      ipcRenderer.on('shortcut:copyLastAssistant', () => cb())
  },

  tray: {
    onNewConversation: (cb: () => void) => ipcRenderer.on('tray:newConversation', () => cb())
  },

  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text)
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: () => ipcRenderer.invoke('window:maximizeToggle'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    reload: () => ipcRenderer.invoke('window:reload'),
    toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools'),
    onMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_: unknown, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximizedChanged', handler)
      return () => {
        ipcRenderer.removeListener('window:maximizedChanged', handler)
      }
    }
  },

  webTools: {
    setProvider: (provider: string, opts: { apiKey?: string; endpoint?: string }) =>
      ipcRenderer.invoke('webTools:setProvider', provider, opts),
    getProvider: () => ipcRenderer.invoke('webTools:getProvider'),
    testAdapter: () => ipcRenderer.invoke('webTools:testAdapter'),
    deleteKey: (provider: string) => ipcRenderer.invoke('webTools:deleteKey', provider)
  },

  research: {
    start: (request: { question: string; depth?: 'quick' | 'standard' | 'exhaustive'; conversationId: string }) =>
      ipcRenderer.invoke('research:start', request),
    cancel: (runId: string) => ipcRenderer.invoke('research:cancel', runId),
    status: (runId: string) => ipcRenderer.invoke('research:status', runId),
    list: () => ipcRenderer.invoke('research:list'),
    read: (filename: string) => ipcRenderer.invoke('research:read', filename),
    download: (filename: string) => ipcRenderer.invoke('research:download', filename),
    onProgress: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('research:progress', handler)
      return () => ipcRenderer.removeListener('research:progress', handler)
    },
    onCompleted: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('research:completed', handler)
      return () => ipcRenderer.removeListener('research:completed', handler)
    },
    onFailed: (cb: (e: unknown) => void): (() => void) => {
      const handler = (_: unknown, e: unknown): void => cb(e)
      ipcRenderer.on('research:failed', handler)
      return () => ipcRenderer.removeListener('research:failed', handler)
    }
  },

  currentInfo: {
    setProvider: (kind: string, provider: string, opts: { apiKey?: string | null }) =>
      ipcRenderer.invoke('currentInfo:setProvider', kind, provider, opts),
    getProvider: (kind?: string) => ipcRenderer.invoke('currentInfo:getProvider', kind),
    test: (kind: string) => ipcRenderer.invoke('currentInfo:test', kind)
  },

  imageGen: {
    setProvider: (provider: string, opts: { apiKey?: string; model?: string }) =>
      ipcRenderer.invoke('imageGen:setProvider', provider, opts),
    getProvider: () => ipcRenderer.invoke('imageGen:getProvider'),
    test: () => ipcRenderer.invoke('imageGen:test')
  },

  github: {
    status: () => ipcRenderer.invoke('github:status'),
    saveOAuthClient: (args: { clientId: string; clientSecret: string }) =>
      ipcRenderer.invoke('github:saveOAuthClient', args),
    hasOAuthClient: () => ipcRenderer.invoke('github:hasOAuthClient'),
    hasBundledClient: () => ipcRenderer.invoke('github:hasBundledClient'),
    setMode: (mode: 'oauth' | 'github_app' | 'gh-cli' | 'none') =>
      ipcRenderer.invoke('github:setMode', mode),
    connect: () => ipcRenderer.invoke('github:connect'),
    disconnect: () => ipcRenderer.invoke('github:disconnect'),
    viewer: () => ipcRenderer.invoke('github:viewer'),
    repositories: (args?: { page?: number; perPage?: number }) =>
      ipcRenderer.invoke('github:repositories', args),
    getRepository: (args: { owner: string; repo: string }) =>
      ipcRenderer.invoke('github:getRepository', args),
    pickCloneDir: () => ipcRenderer.invoke('github:pickCloneDir'),
    clone: (args: { owner: string; repo: string; targetDir: string }) =>
      ipcRenderer.invoke('github:clone', args),
    resolveCloneTarget: (args: { baseDir: string; repoName: string }) =>
      ipcRenderer.invoke('github:resolveCloneTarget', args),
    getProjectRepo: (args: { projectId: string }) =>
      ipcRenderer.invoke('github:getProjectRepo', args),
    assignRepoToProject: (args: {
      projectId: string
      owner: string
      repo: string
      localPath?: string | null
    }) => ipcRenderer.invoke('github:assignRepoToProject', args),
    unlinkRepo: (args: { projectId: string }) => ipcRenderer.invoke('github:unlinkRepo', args),
    compare: (args: { owner: string; repo: string; base: string; head: string }) =>
      ipcRenderer.invoke('github:compare', args),
    createPullRequest: (args: {
      owner: string
      repo: string
      title: string
      body?: string
      head: string
      base: string
      draft?: boolean
      headLabel?: string
      conversationId?: string
    }) => ipcRenderer.invoke('github:createPullRequest', args),
    pullRequests: (args: {
      owner: string
      repo: string
      state?: 'open' | 'closed' | 'all'
      per_page?: number
    }) => ipcRenderer.invoke('github:pullRequests', args),
    getPullRequest: (args: { owner: string; repo: string; number: number }) =>
      ipcRenderer.invoke('github:getPullRequest', args),
    listConversationPullRequests: (args: { conversationId: string }) =>
      ipcRenderer.invoke('github:listConversationPullRequests', args),

    // F2 — PR review threading + inline review post.
    listPullRequestReviewComments: (args: { owner: string; repo: string; number: number }) =>
      ipcRenderer.invoke('github:listPullRequestReviewComments', args),
    listPullRequestReviewThreads: (args: { owner: string; repo: string; number: number }) =>
      ipcRenderer.invoke('github:listPullRequestReviewThreads', args),
    createPullRequestReview: (args: {
      owner: string
      repo: string
      number: number
      body?: string
      event?: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
      commitId?: string
      comments?: Array<{
        path: string
        body: string
        position?: number
        line?: number
        start_line?: number
        side?: 'LEFT' | 'RIGHT'
        start_side?: 'LEFT' | 'RIGHT'
      }>
    }) => ipcRenderer.invoke('github:createPullRequestReview', args),
    replyToReviewComment: (args: {
      owner: string
      repo: string
      number: number
      commentId: number
      body: string
    }) => ipcRenderer.invoke('github:replyToReviewComment', args),
    resolveReviewThread: (args: { threadId: string }) =>
      ipcRenderer.invoke('github:resolveReviewThread', args),
    unresolveReviewThread: (args: { threadId: string }) =>
      ipcRenderer.invoke('github:unresolveReviewThread', args),

    // F3 — issues + status checks.
    listIssues: (args: {
      owner: string
      repo: string
      state?: 'open' | 'closed' | 'all'
      per_page?: number
      labels?: string
    }) => ipcRenderer.invoke('github:listIssues', args),
    getPullRequestStatus: (args: { owner: string; repo: string; number: number }) =>
      ipcRenderer.invoke('github:getPullRequestStatus', args),
    pushBranch: (args: {
      cwd: string
      branch: string
      owner: string
      repo: string
      setUpstream?: boolean
    }) => ipcRenderer.invoke('github:pushBranch', args),
    openInBrowser: (url: string) => ipcRenderer.invoke('github:openInBrowser', url),
    // DUIN's own repository (Settings → GitHub).
    projectRelease: (args?: { force?: boolean }) => ipcRenderer.invoke('github:projectRelease', args),
    projectStarred: () => ipcRenderer.invoke('github:projectStarred'),
    starProject: (args: { starred: boolean }) => ipcRenderer.invoke('github:starProject', args),
    onTokenRejected: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on('github:tokenRejected', handler)
      return () => ipcRenderer.removeListener('github:tokenRejected', handler)
    }
  },

  // Read-only access to the event spine. There is no `record` here — the
  // renderer must NOT be able to write into the audit log; producers live in
  // main-process services so the spine reflects what the harness actually did,
  // not what an arbitrary renderer claims it did.
  events: {
    list: (filter?: unknown) => ipcRenderer.invoke('events:list', filter ?? {}),
    get: (id: string) => ipcRenderer.invoke('events:get', id),
    timeline: (filter: unknown) => ipcRenderer.invoke('events:timeline', filter)
  },

  afterAction: {
    get: (conversationId: string) => ipcRenderer.invoke('after-action:get', conversationId)
  },

  harnessRecs: {
    list: (conversationId?: string) => ipcRenderer.invoke('harness:recommendations', conversationId)
  },

  // Local RAG (Lamprey RAG Plan, R1+). R1 ships collection CRUD; R2 adds the
  // embedder catalogue + active-id surface. Document / query / attachment
  // namespaces arrive in R5-R12. `embed()` is intentionally NOT exposed —
  // raw embedding access would let a renderer DoS the worker.
  rag: {
    status: () => ipcRenderer.invoke('rag:status'),
    // Live index-progress fan-out (index-store.ts broadcasts per-tick). Lets the
    // onboarding indexing UI show a real N/M bar instead of a silent wait.
    // Returns an unsubscribe fn for effect cleanup.
    onIndexProgress: (
      cb: (e: {
        phase: 'scanning' | 'chunking' | 'embedding' | 'ready'
        done: number
        total: number
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: any): void => cb(e)
      ipcRenderer.on('rag:index:progress', handler)
      return () => ipcRenderer.removeListener('rag:index:progress', handler)
    },
    // Local search-model download lifecycle (embeddings/service.ts broadcasts
    // rag.model.download.* — notably `.failed` with a TYPED, already-friendly
    // reason for offline). Lets onboarding show the friendly message instead of
    // a stall. Returns an unsubscribe fn.
    onModelDownload: (
      cb: (e: {
        type: string
        kind?: 'offline' | 'timeout' | 'unknown'
        offline?: boolean
        reason?: string
      }) => void
    ): (() => void) => {
      const handler = (_: unknown, e: any): void => cb(e)
      ipcRenderer.on('rag:model:download', handler)
      return () => ipcRenderer.removeListener('rag:model:download', handler)
    },
    collection: {
      list: () => ipcRenderer.invoke('rag:collection:list'),
      create: (input: {
        name: string
        description?: string
        embedderId: string
        chunkSize?: number
        chunkOverlap?: number
        workspacePath?: string
        projectId?: string
      }) => ipcRenderer.invoke('rag:collection:create', input),
      update: (
        id: string,
        patch: {
          name?: string
          description?: string
          embedderId?: string
          chunkSize?: number
          chunkOverlap?: number
          workspacePath?: string
          projectId?: string
        }
      ) => ipcRenderer.invoke('rag:collection:update', id, patch),
      delete: (id: string) => ipcRenderer.invoke('rag:collection:delete', id)
    },
    embedder: {
      catalog: () => ipcRenderer.invoke('rag:embedder:catalog'),
      active: () => ipcRenderer.invoke('rag:embedder:active'),
      setActive: (id: string) => ipcRenderer.invoke('rag:embedder:setActive', id)
    },
    // R5 document + ingest surface. `onProgress` returns an unsubscribe
    // function so effect cleanup (hot reload, tab switch) detaches the
    // listener without duplicating progress event handling.
    document: {
      list: (collectionId: string) => ipcRenderer.invoke('rag:document:list', collectionId),
      text: (documentId: string) => ipcRenderer.invoke('rag:document:text', documentId),
      file: (documentId: string) => ipcRenderer.invoke('rag:document:file', documentId),
      preview: (documentId: string) => ipcRenderer.invoke('rag:document:preview', documentId),
      ingest: (
        collectionId: string,
        files: Array<{
          path?: string
          text?: string
          name: string
          sourceKind?: string
        }>
      ) => ipcRenderer.invoke('rag:document:ingest', collectionId, files),
      reingest: (documentId: string) => ipcRenderer.invoke('rag:document:reingest', documentId),
      delete: (documentId: string) => ipcRenderer.invoke('rag:document:delete', documentId),
      cancel: (jobId: string) => ipcRenderer.invoke('rag:document:cancel', jobId),
      onProgress: (cb: (e: unknown) => void): (() => void) => {
        const handler = (_: unknown, e: unknown): void => cb(e)
        ipcRenderer.on('rag:document:progress', handler)
        return () => ipcRenderer.removeListener('rag:document:progress', handler)
      }
    },
    query: {
      run: (input: { query: string; collectionIds: string[]; topN?: number }) =>
        ipcRenderer.invoke('rag:query:run', input)
    },
    attachments: {
      list: (conversationId: string) => ipcRenderer.invoke('rag:attachments:list', conversationId),
      add: (input: { conversationId: string; collectionId?: string; documentId?: string }) =>
        ipcRenderer.invoke('rag:attachments:add', input),
      remove: (input: { conversationId: string; collectionId?: string; documentId?: string }) =>
        ipcRenderer.invoke('rag:attachments:remove', input)
    },
    // Auto-route a large file through the RAG ingest pipeline into a
    // per-conversation auto-collection. The renderer calls this when a
    // ProcessedFile arrives with kind: 'rag-pending'. Progress updates flow
    // over the existing rag.document.onProgress subscription — match the
    // returned jobId to the IngestProgressEvent.jobId.
    autoAttach: (input: { conversationId: string; filePath: string; displayName?: string }) =>
      ipcRenderer.invoke('rag:auto-attach', input),
    chunk: {
      get: (chunkId: string) => ipcRenderer.invoke('rag:chunk:get', chunkId)
    }
  },

  // DUIN — agent/DUIN brain connectivity. testConnection runs in the
  // main process (no renderer CORS) and is non-blocking from the UI's POV.
  brain: {
    testConnection: (endpoint: string) =>
      ipcRenderer.invoke('brain:testConnection', endpoint) as Promise<{
        success: boolean
        data?: { ok: boolean; detail: string }
        error?: string
      }>,
    // Native single-folder picker for the local brain's notes directory.
    // Returns the chosen path, or null on cancel.
    pickFolder: () =>
      ipcRenderer.invoke('dialog:pickFolder') as Promise<{
        success: boolean
        data?: string | null
        error?: string
      }>,
    // Scaffold an OKF harness from a folder of raw notes — auto-files every note
    // by kind, runs (key-gated) LLM passes for tracks/bio + entity extraction,
    // and writes the foundation files (BRAIN.md / me / GOALS / …) + starter Rules
    // + DIAGNOSIS.md. IN-PLACE by default: omit outDir (or pass === srcDir) to
    // scaffold the brain folder in place (notes MOVED into pillar folders, never
    // losing a file); a separate outDir keeps the legacy copy-out. Returns the
    // counts/tracks and the diagnosis path. Defensive: ok:false + error on any
    // failure; degrades to heuristics with no model.
    scaffoldHarness: (args: { srcDir: string; outDir?: string }) =>
      ipcRenderer.invoke('brain:scaffold-harness', args) as Promise<{
        success: boolean
        data?: {
          ok: boolean
          counts: Record<string, number>
          tracks: string[]
          diagnosisPath: string
          error?: string
        }
        error?: string
      }>,
    // (Re)index the persisted notes folder into the in-process local brain.
    reindex: () =>
      ipcRenderer.invoke('localBrain:reindex') as Promise<{
        success: boolean
        data?: { ok: boolean; count: number }
        error?: string
      }>,
    // "Build my brain" — run ONE LLM pass over the raw indexed notes to infer
    // entities, typed relationships, and note classifications, then cache them
    // so the graph + panels show a connected field. Key-gated: status
    // 'no-model' means no AI model is configured (prompt the user to connect).
    build: () =>
      ipcRenderer.invoke('brain:build') as Promise<{
        success: boolean
        data?: {
        entities: number
        edges: number
        // 'kept-cache' = a clobber guard declined to persist; the previous graph still stands.
        status: 'built' | 'kept-cache' | 'no-model' | 'model-error'
      }
        error?: string
      }>,
    // The autonomy BREAKER. `state` is read-only; `rearm` is the operator's only way to move a
    // capability back toward autonomy — the governor trips capabilities automatically and never
    // restores one. Before this existed the restore path was reachable by curl alone.
    autonomy: {
      state: () =>
        ipcRenderer.invoke('autonomy:state') as Promise<{
          success: boolean
          data?: {
            capabilities: {
              id: string
              title: string
              rung: string
              floorRung: string
              trust: number
              coldStart: boolean
              reverts: number
              willTrip: boolean
              tripsTo: string | null
              canRearm: boolean
            }[]
          }
          error?: string
        }>,
      rearm: (id: string) =>
        ipcRenderer.invoke('autonomy:rearm', id) as Promise<{
          success: boolean
          data?: { ok: boolean; change?: { id: string; from: string; to: string }; reason?: string }
          error?: string
        }>
    },
    // The governor's own RECORD. Same three surfaces the brain exposes at
    // /state/govern-audit, /state/improvements and /state/undo — which had real
    // content and zero renderer callers, so only an agent could read what the
    // governor had done. `undo` is the one write and fires a capability demote,
    // so its caller confirms first.
    govern: {
      audit: () =>
        ipcRenderer.invoke('govern:audit') as Promise<{
          success: boolean
          data?: {
            generatedAt: number
            facts: {
              id: string
              fact: string
              status: string
              govern?: { verdict: string; juryProvider: string | null; crossModel: boolean; ts: number }
              reliability?: number
            }[]
            actions: { id: string; ts: number; actionKind: string; capabilityId: string; status: string }[]
            undoTarget: string | null
          }
          error?: string
        }>,
      improvements: () =>
        ipcRenderer.invoke('govern:improvements') as Promise<{
          success: boolean
          data?: {
            shadow: boolean
            proposals: { type: string; targetId: string; target: string; rationale: string; reversible: boolean }[]
          }
          error?: string
        }>,
      undo: (actionId?: string) =>
        ipcRenderer.invoke('govern:undo', actionId) as Promise<{
          success: boolean
          data?: { actionId: string }
          error?: string
        }>
    },
    // Moat recovery — automatic ledger/construction backups taken before each
    // destructive reindex, and a one-click restore of the newest good state.
    moatBackups: () =>
      ipcRenderer.invoke('brain:moatBackups') as Promise<{
        success: boolean
        data?: Array<{ label: string; name: string; path: string; size: number; mtimeMs: number }>
        error?: string
      }>,
    restoreMoat: (label?: string) =>
      ipcRenderer.invoke('brain:restoreMoat', label) as Promise<{
        success: boolean
        // `skipped` = labels that HAVE a backup on disk but were not written back.
        // Surfaced so a partial restore is never reported as a complete one.
        data?: { restored: string[]; skipped?: Array<{ label: string; reason: string }> }
        error?: string
      }>,
    // `.brain/` harness root — detect existing agent systems (Codex, …) on disk
    // + in the vault, so the user can import their identity + memory + skills
    // with one click.
    detectImports: () =>
      ipcRenderer.invoke('brain:detectImports') as Promise<{
        success: boolean
        data?: Array<{
          adapter: string
          label: string
          dir: string
          contains: {
            identity: boolean
            memory: number
            skills: number
            agents: number
            hooks: number
          }
        }>
        error?: string
      }>,
    // Import a detected system into `.brain/` (link = live pointer, copy =
    // snapshot). Broadcasts brain:updated so live views re-read the grounding.
    import: (payload: { adapterId: string; sourceDir: string; mode: 'link' | 'copy' }) =>
      ipcRenderer.invoke('brain:import', payload) as Promise<{
        success: boolean
        data?: {
          ok: boolean
          adapter: string
          mode: 'link' | 'copy'
          brainRoot: string
          summary: {
            identity: boolean
            memory: number
            skills: number
            agents: number
            hooks: number
            linked: boolean
          }
          /** Trash-relative path where a pre-existing `.brain/identity.md` was preserved
           *  before this import overwrote it. Absent when nothing was replaced. */
          replaced?: string
          error?: string
        }
        error?: string
      }>,
    // Read the `.brain/` identity + memory summary for display.
    loadIdentity: () =>
      ipcRenderer.invoke('brain:loadIdentity') as Promise<{
        success: boolean
        data?: {
          root: string
          hasIdentity: boolean
          identityChars: number
          memoryCount: number
          memoryChars: number
        } | null
        error?: string
      }>,
    // Distinct note files currently indexed by the local brain.
    localStatus: () =>
      ipcRenderer.invoke('localBrain:status') as Promise<{
        success: boolean
        data?: { indexed: number }
        error?: string
      }>,
    // Rich brain status for the Brain settings panel: notes indexed, current
    // graph node/edge counts (structural + any cached construction), and whether
    // a callable AI model is available to build the brain from raw prose.
    status: () =>
      ipcRenderer.invoke('brain:status') as Promise<{
        success: boolean
        data?: { notesIndexed: number; graphNodes: number; graphEdges: number; hasModel: boolean }
        error?: string
      }>,
    // Detect a locally-running Ollama (keyless local models) for guided setup.
    detectOllama: () =>
      ipcRenderer.invoke('localBrain:detectOllama') as Promise<{
        success: boolean
        data?: { available: boolean; models: string[] }
        error?: string
      }>,
    // Fetch the brain graph (CausalGraph JSON) via MAIN — the renderer's CSP is
    // connect-src 'none', so it cannot fetch the local brain at :8799 directly.
    getGraph: (url: string) =>
      ipcRenderer.invoke('brain:graph', url) as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // In-process causal engine (Phase A). The notes-derived demo graph runs the
    // same shape; these add the lag-aware what-if propagation on top.
    causalGraph: (anchor?: string) =>
      ipcRenderer.invoke('brain:causalGraph', anchor ?? '') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    propagate: (nodeId: string, shiftDays: number, decision?: 'cleared' | 'blocked') =>
      ipcRenderer.invoke('brain:propagate', nodeId, shiftDays, decision ?? '') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Leading-indicator risks the engine derives from the causal field.
    predictedRisks: () =>
      ipcRenderer.invoke('brain:predictedRisks') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Per-track (lane) situation rolled up from the causal field + risks.
    worldState: () =>
      ipcRenderer.invoke('brain:worldState') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Cross-cutting analytical insights the brain notices across the field.
    insights: () =>
      ipcRenderer.invoke('brain:insights') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Analytical + GENERATIVE insights (the LLM half). Async/key-gated: returns
    // the analytical set enriched with higher-level LLM insights when a model is
    // configured, else the analytical set unchanged.
    insightsGenerative: () =>
      ipcRenderer.invoke('brain:insights-generative') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Right-panel "Today" home — one triaged digest (focal + brain-noticed +
    // needs-you + since-you-were-away). Ranked in-process by the home-digest scorer.
    homeDigest: () =>
      ipcRenderer.invoke('brain:homeDigest') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Structural graph report (community detection + hubs + cross-cluster
    // bridges + edge provenance). Keyless + cold-data-safe.
    graphReport: () =>
      ipcRenderer.invoke('brain:graphReport') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Global search (Cmd/Ctrl+K palette) — grouped note/doc + graph-node hits
    // from the existing hybrid retriever. Read-only.
    search: (query: string) =>
      ipcRenderer.invoke('brain:search', query) as Promise<{
        success: boolean
        data?: {
          query: string
          notes: { file: string; title: string; breadcrumb: string; snippet: string; score: number }[]
          nodes: { id: string; label: string; kind: string; layer?: string; degree: number }[]
        }
        error?: string
      }>,
    // Decision simulation — grounded rollout of each option + consistency gate.
    simulateDecision: (req: unknown) =>
      ipcRenderer.invoke('brain:simulateDecision', req) as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Commit the pre-act forecast for the chosen option (idempotent ledger write).
    commitDecisionForecast: (input: unknown) =>
      ipcRenderer.invoke('brain:commitDecisionForecast', input) as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Per-node community assignment (id → cluster + color) for coloring the graph.
    graphCommunities: () =>
      ipcRenderer.invoke('brain:graphCommunities') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Graph growth history (one snapshot/day) for the sparkline.
    graphHistory: () =>
      ipcRenderer.invoke('brain:graphHistory') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Relations surface — hydrated capped ego graph around an entity (id or label) + the
    // anchor's LIVE governable beliefs (candidate | provisional | promoted — the drawer is the
    // human gate, so the pending statuses must arrive). See electron/services/brain/entity-ego.ts.
    entityGraph: (anchor: string, depth?: number) =>
      ipcRenderer.invoke('brain:entityGraph', anchor, depth) as Promise<{
        success: boolean
        data?: {
          anchor: string
          nodes: Array<{ id: string; label: string; kind: string; source: string; beliefCount?: number }>
          edges: Array<{ src: string; dst: string; type: string; dir: 'in' | 'out' }>
          stats: { nodes: number; edges: number; truncated: boolean }
          beliefs: Array<{ factId: string; text: string; kind: string; status: string }>
        }
        error?: string
      }>,
    // RETIRED 2026-08-04: `meetings` / `outputs` / `mentalModels`. They projected notes into
    // three buckets via derive-knowledge's isMeeting / isOutput / isMentalModel — four-way
    // disjunctions over a frontmatter type, a tag, a folder name and an LLM classification, with
    // no precedence between them and no exclusion of person notes. On a vault not organised by
    // those folder names the first three never fire, so the bucket was the model's guess. The
    // Explorer offers operator-authored tags instead. `people` below is NOT retired: it is
    // graph-backed (constructed `person:*` nodes), not classifier-backed.
    //
    // Person entities derived from the graph/notes (constructed `person:*` nodes
    // + person-notes). The People panel merges these with manual entries.
    people: () =>
      ipcRenderer.invoke('brain:people') as Promise<{
        success: boolean
        data?: { people?: { id: string; name: string; note?: string; mentions?: number }[] }
        error?: string
      }>,
    // Fires when the brain's index changes (e.g. after a reindex) so live Brain
    // views can refetch — the graph endpoint URL is static. Returns unsubscribe.
    onUpdated: (cb: (e: { count: number }) => void): (() => void) => {
      const handler = (_: unknown, e: { count: number }): void => cb(e)
      ipcRenderer.on('brain:updated', handler)
      return () => ipcRenderer.removeListener('brain:updated', handler)
    },
    // Fires when the brain tried to build its entity graph but no callable extraction
    // model is configured (cold-start: no API key). The renderer surfaces a toast/banner
    // prompting the user to add a key. Returns unsubscribe.
    onNeedsKey: (cb: (e: { message: string }) => void): (() => void) => {
      const handler = (_: unknown, e: { message: string }): void => cb(e)
      ipcRenderer.on('brain:needs-key', handler)
      return () => ipcRenderer.removeListener('brain:needs-key', handler)
    },
    // Fires when the entity-graph build STARTS and COMPLETES. The multi-minute LLM construction runs
    // AFTER indexing (and after onboarding shows "ready"), so a subscriber can surface a live
    // "building… / graph ready · N entities" indicator instead of the build being invisible. On a
    // keyless cold start the 'done' event carries status:'no-model' so the UI can prompt for a model.
    // Returns unsubscribe.
    onBuild: (
      cb: (e: { phase: 'started' | 'done'; status?: string; entities?: number; edges?: number }) => void
    ): (() => void) => {
      const handler = (
        _: unknown,
        e: { phase: 'started' | 'done'; status?: string; entities?: number; edges?: number }
      ): void => cb(e)
      ipcRenderer.on('brain:build', handler)
      return () => ipcRenderer.removeListener('brain:build', handler)
    },
    // Push the onboarding-interview seed brain (or clear with []). The renderer
    // builds the nodes/edges; main holds them for the session.
    setSeed: (nodes: unknown[], edges: unknown[]) =>
      ipcRenderer.invoke('brain:setSeed', nodes, edges) as Promise<{
        success: boolean
        data?: { ok: boolean; nodes: number }
        error?: string
      }>,
    // Record a verdict on a cross-cutting insight (useful/dismissed/acted/
    // inaccurate). Reads+writes the same in-process brain insights() reads, so
    // the id matches the shown insight (dismissed/inaccurate drop it on refetch).
    insightVerdict: (
      id: string,
      verdict: 'useful' | 'dismissed' | 'acted' | 'inaccurate'
    ) =>
      ipcRenderer.invoke('brain:insightVerdict', id, verdict) as Promise<{
        success: boolean
        data?: { success: boolean }
        error?: string
      }>,
    // Record a verdict on a logged prediction (happened/averted/false_alarm).
    recordVerdict: (
      predictionId: string,
      outcome: 'happened' | 'averted' | 'false_alarm' | 'unobserved',
      note?: string
    ) =>
      ipcRenderer.invoke('brain:recordVerdict', predictionId, outcome, note ?? '') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Adaptive decision loop — open loops (owed/risk/problem) ↔ made decisions.
    decisionLoop: () =>
      ipcRenderer.invoke('brain:decisionLoop') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // Record a call on an owed decision; moves it from open → made.
    recordDecision: (
      nodeId: string,
      choice: 'cleared' | 'blocked' | 'done' | 'dismissed' | 'cancelled',
      note?: string
    ) =>
      ipcRenderer.invoke('brain:recordDecision', nodeId, choice, note ?? '') as Promise<{
        success: boolean
        data?: unknown
        error?: string
      }>,
    // A1 cold-start: persist the interview-generated ME.md + BRAIN.md to the vault root
    // so the grounding loader reads them into every turn. No-clobber unless overwrite.
    writeIdentity: (notesDir: string, meMd: string, brainMd: string, overwrite?: boolean) =>
      ipcRenderer.invoke('brain:writeIdentity', notesDir, meMd, brainMd, overwrite === true) as Promise<{
        success: boolean
        data?: { wrote: string[]; skipped: string[] }
        error?: string
      }>,
    // Foundations pane: edit a vault-root foundation file (ME.md / BRAIN.md / GOALS.md).
    // Path-scoped to a fixed whitelist of basenames; the vault root is resolved main-side
    // (never passed from here), and prior bytes are snapshotted to .trash before overwrite.
    writeFoundationFile: (name: string, body: string) =>
      ipcRenderer.invoke('brain:writeFoundationFile', name, body) as Promise<{
        success: boolean
        data?: { name: string; wrote: boolean; replacedTrashRel?: string }
        error?: string
      }>,
    // #4a — one orchestrated PER-VAULT first-run flow for a NEW operator: stand up a
    // clean, isolated, seedable brain. Idempotent + no-clobber (a set-up vault = no-op).
    scaffoldNewOperator: (
      vaultDir: string,
      opts?: {
        rawSrcDir?: string
        identity?: { meMd: string; brainMd: string; overwrite?: boolean }
        force?: boolean
      }
    ) =>
      ipcRenderer.invoke('brain:scaffoldNewOperator', vaultDir, opts ?? {}) as Promise<{
        success: boolean
        data?: {
          ok: boolean
          foundationWritten: string[]
          pillarsWritten: boolean
          seededFacts: number
          marker: boolean
          alreadySetUp?: boolean
          error?: string
        }
        error?: string
      }>,
    // Cold-start (Dim 6): materialize a typed OKF concept skeleton (+ the
    // first-run interview answers as typed project/decision/risk concepts) into
    // `<vaultDir>/.brain/memory/` so a fresh/empty vault renders a real seed
    // graph, not a blank canvas. Idempotent + no-clobber on the main side.
    scaffoldOkf: (
      vaultDir: string,
      answers?: { working?: string; deciding?: string; worried?: string },
      overwrite?: boolean,
      reindexAfter?: boolean
    ) =>
      ipcRenderer.invoke(
        'brain:scaffoldOkf',
        vaultDir,
        answers,
        overwrite === true,
        reindexAfter !== false
      ) as Promise<{
        success: boolean
        data?: {
          conceptsWritten?: number
          conceptsIndexed?: number
          indexPath?: string | null
          wrote?: string[]
          skipped?: string[]
          // For each file whose prior content was REPLACED, where that prior content
          // was preserved (a `.trash` path relative to the vault). The handler has
          // always returned this; the type omitted it, so the recovery path was
          // invisible to every renderer typechecker. Only non-empty when a caller
          // passes `overwrite: true` — no renderer does yet, so the recovery path is
          // wired but not surfaced. See okf-scaffold-ipc.test.ts.
          replaced?: Record<string, string>
        }
        error?: string
      }>
  },

  // F1 — operator-learning promotion governance: review what DUIN learned about
  // you, promote a candidate to a governing rule, or veto it.
  operator: {
    list: () =>
      ipcRenderer.invoke('operator:list') as Promise<{
        success: boolean
        data?: {
          id: string
          fact: string
          kind: string
          status: string
          ts: number
          source?: string
          adjudicatedBy?: string
          capturedAt?: number
          provisionalAt?: number
          promotedAt?: number
          invalidatedAt?: number
          invalidatedBy?: string
          supersededBy?: string
          observedSessions?: string[]
          reverts?: number
          govern?: { verdict: string; crossModel?: boolean; juryProvider?: string | null; ts?: number }
        }[]
        error?: string
      }>,
    // W5: every row including superseded ones (the "Superseded" list), and the keyless facts
    // parked at ratify (the "Awaiting your ratification" section and the Needs-you card).
    listAll: () =>
      ipcRenderer.invoke('operator:listAll') as Promise<{
        success: boolean
        data?: {
          id: string
          fact: string
          kind: string
          status: string
          ts: number
          source?: string
          adjudicatedBy?: string
          capturedAt?: number
          provisionalAt?: number
          promotedAt?: number
          invalidatedAt?: number
          invalidatedBy?: string
          supersededBy?: string
          observedSessions?: string[]
          reverts?: number
          govern?: { verdict: string; crossModel?: boolean; juryProvider?: string | null; ts?: number }
        }[]
        error?: string
      }>,
    awaitingRatify: () =>
      ipcRenderer.invoke('operator:awaitingRatify') as Promise<{
        success: boolean
        data?: {
          id: string
          fact: string
          kind: string
          status: string
          ts: number
          source?: string
          adjudicatedBy?: string
          capturedAt?: number
          provisionalAt?: number
          promotedAt?: number
          invalidatedAt?: number
          invalidatedBy?: string
          supersededBy?: string
          observedSessions?: string[]
          reverts?: number
          govern?: { verdict: string; crossModel?: boolean; juryProvider?: string | null; ts?: number }
        }[]
        error?: string
      }>,
    // Read-only review queue: candidate facts awaiting your promote/veto verdict.
    // Powers the daily Home-digest "N facts waiting for your review" nudge.
    pendingReview: () =>
      ipcRenderer.invoke('operator:pendingReview') as Promise<{
        success: boolean
        data?: { count: number; items: { id: string; text: string; capturedAt: number }[] }
        error?: string
      }>,
    promote: (id: string, reason?: string) =>
      ipcRenderer.invoke('operator:promote', id, reason) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    veto: (id: string, reason?: string) =>
      ipcRenderer.invoke('operator:veto', id, reason) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    // W5 human verbs — ratify (provisional → rule, the person's word), un-veto, revert a supersession.
    ratify: (id: string, reason?: string) =>
      ipcRenderer.invoke('operator:ratify', id, reason) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    unveto: (id: string, reason?: string) =>
      ipcRenderer.invoke('operator:unveto', id, reason) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    revertSupersession: (id: string, reason?: string) =>
      ipcRenderer.invoke('operator:revertSupersession', id, reason) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    // Live refresh: fires after any fact mutation (human veto AND the automatic
    // capture/govern loop). Returns an unsubscribe. Mirrors memory.onChanged.
    onChanged: (cb: (facts: unknown[]) => void): (() => void) => {
      const handler = (_: unknown, facts: unknown[]) => cb(facts)
      ipcRenderer.on('operator:changed', handler)
      return () => ipcRenderer.removeListener('operator:changed', handler)
    }
  },

  // Integrations (ingest) — connector sources feeding the brain.
  connections: {
    list: () =>
      ipcRenderer.invoke('connections:list') as Promise<{
        success: boolean
        data?: { id: string; label: string; configured: boolean; enabled: boolean; lastSyncMs: number | null; lastCount: number | null; lastError: string | null }[]
        error?: string
      }>,
    sync: (id: string) =>
      ipcRenderer.invoke('connections:sync', id) as Promise<{ success: boolean; data?: { ok: boolean; count: number; error?: string }; error?: string }>,
    backfill: (id: string, days: number) =>
      ipcRenderer.invoke('connections:backfill', id, days) as Promise<{ success: boolean; data?: { ok: boolean; count: number; error?: string }; error?: string }>,
    setEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke('connections:setEnabled', id, enabled) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    setSlackToken: (token: string) =>
      ipcRenderer.invoke('connections:setSlackToken', token) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    setNotionToken: (token: string) =>
      ipcRenderer.invoke('connections:setNotionToken', token) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    getRssFeeds: () =>
      ipcRenderer.invoke('connections:getRssFeeds') as Promise<{ success: boolean; data?: string[]; error?: string }>,
    setRssFeeds: (feeds: string[]) =>
      ipcRenderer.invoke('connections:setRssFeeds', feeds) as Promise<{ success: boolean; data?: number; error?: string }>,
    // Google (Gmail + Calendar) ingest reuses the OAuth flow that also backs the
    // Google MCP connectors: save the OAuth-app client creds, then run the browser
    // consent flow. Both live outside the connections namespace already; these are
    // thin passthroughs so the Connections panel can drive the whole flow in-place.
    saveGoogleCreds: (clientId: string, clientSecret: string) =>
      ipcRenderer.invoke('settings:saveGoogleCredentials', clientId, clientSecret) as Promise<{ success: boolean; error?: string }>,
    connectGoogle: () =>
      ipcRenderer.invoke('mcp:setupGoogleOAuth') as Promise<{ success: boolean; error?: string }>,
    ingest: (source: string, docs: unknown[]) =>
      ipcRenderer.invoke('connections:ingest', source, docs) as Promise<{ success: boolean; data?: { count: number }; error?: string }>,
    onUpdated: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('connections:updated', handler)
      return () => ipcRenderer.removeListener('connections:updated', handler)
    }
  },

  // Channels (conversational connectivity) — two-way surfaces + per-user pairing.
  channels: {
    list: () =>
      ipcRenderer.invoke('channels:list') as Promise<{
        success: boolean
        data?: { id: string; label: string; configured: boolean; enabled: boolean; lastError: string | null; startedAt: number | null }[]
        error?: string
      }>,
    // What each channel IS — readable before it is configured or started, which is
    // when the operator needs it. Drives the generated setup UI: steps, docs link,
    // capabilities, and whether it needs a public HTTPS endpoint.
    listDefinitions: () =>
      ipcRenderer.invoke('channels:listDefinitions') as Promise<{
        success: boolean
        data?: {
          id: string
          label: string
          description: string
          region: 'global' | 'cn' | 'jp' | 'any'
          authMode: 'credentials' | 'oauth' | 'device-link' | 'external'
          ingress: 'websocket' | 'poll' | 'webhook' | 'local'
          needsPublicUrl: boolean
          capabilities: string[]
          credentials: {
            keychainKey: string
            label: string
            kind: 'secret' | 'text'
            placeholder?: string
            help?: string
          }[]
          setupSteps: string[]
          docsUrl?: string
          status: 'available' | 'planned'
          installed: boolean
        }[]
        error?: string
      }>,
    // The operator's enable path. Persists the flag AND restarts that adapter, so
    // the toggle takes effect on the running app rather than at the next launch.
    setEnabled: (channelId: string, enabled: boolean) =>
      ipcRenderer.invoke('channels:setEnabled', channelId, enabled) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    // The values a channel needs before it can connect. A secret reports only whether one
    // is stored (`hasValue`); non-secret configuration also carries its `value` so it is
    // editable rather than write-only.
    listCredentials: (channelId: string) =>
      ipcRenderer.invoke('channels:listCredentials', channelId) as Promise<{
        success: boolean
        data?: {
          keychainKey: string
          label: string
          kind: 'secret' | 'text'
          placeholder?: string
          help?: string
          hasValue: boolean
          value?: string
        }[]
        error?: string
      }>,
    setCredential: (channelId: string, keychainKey: string, value: string) =>
      ipcRenderer.invoke('channels:setCredential', channelId, keychainKey, value) as Promise<{
        success: boolean
        data?: { configured: boolean }
        error?: string
      }>,
    pair: (channelId: string, externalUserId: string) =>
      ipcRenderer.invoke('channels:pair', channelId, externalUserId) as Promise<{ success: boolean; data?: { status: string; code: string | null }; error?: string }>,
    approve: (channelId: string, opts: { userId?: string; code?: string }) =>
      ipcRenderer.invoke('channels:approve', channelId, opts) as Promise<{ success: boolean; data?: { userId: string }; error?: string }>,
    revoke: (channelId: string, externalUserId: string) =>
      ipcRenderer.invoke('channels:revoke', channelId, externalUserId) as Promise<{ success: boolean; data?: boolean; error?: string }>,
    onUpdated: (cb: () => void): (() => void) => {
      const handler = (): void => cb()
      ipcRenderer.on('channels:updated', handler)
      return () => ipcRenderer.removeListener('channels:updated', handler)
    }
  },

  // Reviewable / reversible proposed-edit CARD actions. Direct IPC — the
  // card's Apply / Discard / Edit buttons call these, NOT a chat re-prompt.
  // Accept applies the patch atomically through the workspace patch authority
  // (the Apply-click is the approval). `list` hydrates cards on reload.
  proposedEdit: {
    list: (conversationId: string) =>
      ipcRenderer.invoke('proposedEdit:list', conversationId),
    get: (id: string) => ipcRenderer.invoke('proposedEdit:get', id),
    accept: (id: string) => ipcRenderer.invoke('proposedEdit:accept', id),
    reject: (id: string) => ipcRenderer.invoke('proposedEdit:reject', id),
    edit: (payload: {
      id: string
      patch: string
      title?: string | null
      rationale?: string | null
    }) => ipcRenderer.invoke('proposedEdit:edit', payload)
  },

  app: {
    onError: (cb: (e: { message: string }) => void): (() => void) => {
      const handler = (_: unknown, e: { message: string }): void => cb(e)
      ipcRenderer.on('app:error', handler)
      return () => ipcRenderer.removeListener('app:error', handler)
    },
    onWarning: (cb: (e: { message: string }) => void): (() => void) => {
      const handler = (_: unknown, e: { message: string }): void => cb(e)
      ipcRenderer.on('app:warning', handler)
      return () => ipcRenderer.removeListener('app:warning', handler)
    },
    getWorkingFolder: () => ipcRenderer.invoke('app:getWorkingFolder'),
    getDataDir: () => ipcRenderer.invoke('app:getDataDir'),
    openPath: (p: string) => ipcRenderer.invoke('app:openPath', p),
    // Synchronous from preload — process.platform is available in the
    // sandbox. Renderer reads it once via window.api.app.platform.
    platform: process.platform as NodeJS.Platform,
    // Build provenance, also synchronous: the values are `define`d string
    // literals baked in at build time (see electron.vite.config.ts), so this
    // needs no IPC round-trip and still answers when the main process is busy
    // or the brain is down. Same data as GET /state/build.
    build: buildInfo(),
    buildStamp: formatBuildStamp()
  }
}

contextBridge.exposeInMainWorld('api', api)

// Debug-only flag: true when the app was launched with BF_DEBUG_PORT (the same
// switch that opens the CDP port for in-app QA). The renderer uses it to expose
// its stores on window so automated QA can drive UI state deterministically.
// Absent/false in normal user runs — nothing internal is leaked.
contextBridge.exposeInMainWorld('__duinDebug', { on: !!process.env.BF_DEBUG_PORT })

export type LampreyAPI = typeof api
