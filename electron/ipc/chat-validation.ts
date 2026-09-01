// Pure validation for the `chat:send` IPC payload. Lives in its own file
// (rather than alongside the handler in chat.ts) so the test layer can
// exercise it without pulling chat.ts's full module graph — chat.ts
// transitively imports skill-loader / electron-toolkit / providers, none
// of which initialize cleanly under headless vitest.

// UB-7 (Unburdening Phase, 2026-06-10) — the `agentMode` request field died
// with the pipeline; unknown fields (including stale agentMode from old
// callers) are simply ignored.
export type ChatSendValidation =
  | {
      ok: true
      value: {
        content: string
        model: string
        conversationId: string
        activeSkillIds: string[]
        /** Node the chat is scoped to (pinned per conversation). Optional —
         *  absent for unscoped chats. Only well-formed refs survive validation. */
        context?: { id: string; label: string; kind: string }
        /** Per-conversation reasoning-effort override for this turn. Absent when
         *  the composer didn't set one (the global default then applies). */
        reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
        /** Vision image data URLs forwarded to a vision-capable brain/model.
         *  Absent on every non-image / non-vision turn → byte-for-byte the old
         *  request shape. Each entry is a validated {mimeType, dataUrl} pair. */
        images?: { mimeType: string; dataUrl: string }[]
        /** Composer permissions pill for this turn. Only the three known values
         *  survive; anything else is dropped so a stale/garbage value falls back
         *  to the env posture at the gate (env-floor invariant, §4.4). */
        permissionsMode?: 'default' | 'auto-review' | 'full'
        /** Response language for this turn. Only the three explicit choices survive;
         *  anything else (including the settings-level 'auto') is dropped so no
         *  language is forwarded and the brain emits no directive — byte-for-byte
         *  the old body. */
        language?: 'en' | 'zh' | 'ja'
      }
    }
  | { ok: false; error: string }

export function validateChatSendRequest(raw: unknown): ChatSendValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'chat:send: request object is required' }
  }
  const req = raw as Record<string, unknown>
  if (typeof req.content !== 'string' || req.content.trim() === '') {
    return {
      ok: false,
      error: 'chat:send: content (non-empty string) is required'
    }
  }
  if (typeof req.model !== 'string' || !req.model) {
    return { ok: false, error: 'chat:send: model id is required' }
  }
  if (req.conversationId !== undefined && typeof req.conversationId !== 'string') {
    return {
      ok: false,
      error: 'chat:send: conversationId must be a string'
    }
  }
  // Filter to strings so a mixed-type array doesn't reach the skill loader
  // as a "skill not found" later.
  const activeSkillIds: string[] = Array.isArray(req.activeSkillIds)
    ? req.activeSkillIds.filter(
        (s): s is string => typeof s === 'string' && s.length > 0
      )
    : []
  // Accept a context ref only when all three string fields are present — a
  // partial/malformed object is dropped rather than half-forwarded to the brain.
  let context: { id: string; label: string; kind: string } | undefined
  const c = req.context
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const cc = c as Record<string, unknown>
    if (
      typeof cc.id === 'string' &&
      typeof cc.label === 'string' &&
      typeof cc.kind === 'string' &&
      cc.id.length > 0
    ) {
      context = { id: cc.id, label: cc.label, kind: cc.kind }
    }
  }
  // Only accept the known effort levels; anything else is dropped so a stale or
  // malformed value can't reach the provider as a bad reasoning_effort.
  const re = req.reasoningEffort
  const reasoningEffort =
    re === 'low' || re === 'medium' || re === 'high' || re === 'max'
      ? (re as 'low' | 'medium' | 'high' | 'max')
      : undefined
  // Vision images: accept only a well-formed array of {mimeType, dataUrl}
  // objects (both non-empty strings, dataUrl must be a data: URL). A partial
  // or malformed entry is dropped rather than half-forwarded to the brain.
  let images: { mimeType: string; dataUrl: string }[] | undefined
  if (Array.isArray(req.images)) {
    const cleaned = req.images
      .filter(
        (i): i is { mimeType: string; dataUrl: string } =>
          !!i && typeof i === 'object' && !Array.isArray(i) &&
          typeof (i as { mimeType?: unknown }).mimeType === 'string' &&
          typeof (i as { dataUrl?: unknown }).dataUrl === 'string' &&
          !!(i as { mimeType: string }).mimeType &&
          (i as { dataUrl: string }).dataUrl.startsWith('data:')
      )
      .map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl }))
    if (cleaned.length) images = cleaned
  }
  // Composer permissions pill: whitelist only the three known modes; a stale or
  // garbage value is dropped so the gate falls back to the env posture (never
  // loosens — env-floor invariant).
  const pm = req.permissionsMode
  const permissionsMode =
    pm === 'default' || pm === 'auto-review' || pm === 'full'
      ? (pm as 'default' | 'auto-review' | 'full')
      : undefined
  // Response language: whitelist only the three explicit choices. A stale/garbage value — or the
  // settings-level 'auto' — is dropped, so nothing is forwarded and the brain emits no directive.
  const lg = req.language
  const language = lg === 'en' || lg === 'zh' || lg === 'ja' ? (lg as 'en' | 'zh' | 'ja') : undefined
  return {
    ok: true,
    value: {
      content: req.content,
      model: req.model,
      conversationId:
        typeof req.conversationId === 'string' ? req.conversationId : 'new',
      activeSkillIds,
      ...(context ? { context } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(images ? { images } : {}),
      ...(permissionsMode ? { permissionsMode } : {}),
      ...(language ? { language } : {})
    }
  }
}
