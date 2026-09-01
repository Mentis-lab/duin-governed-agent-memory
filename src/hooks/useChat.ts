import { useEffect } from 'react'
import { useChatStore } from '@/stores/chat-store'
import { useProposedEditsStore } from '@/stores/proposed-edits-store'
import { usePlanStore } from '@/stores/plan-store'
import type { AgentRunPhase, PlanSnapshot } from '@/lib/types'
import { toast } from '@/stores/toast-store'
import { useInlineNoticesStore } from '@/stores/inline-notices-store'

export function useChat(): void {
  useEffect(() => {
    if (!window.api) return

    // ── Per-conversation RAF coalescing ──────────────────────────────────
    // Chunks can arrive faster than React can render. Coalesce all chunks
    // that land within a single animation frame into one store update per
    // conversation so we re-render at most ~60×/sec per active stream.
    // Keyed by conversationId so concurrent streams don't mix buffers.
    const pendingChunks: Record<string, string> = {}
    const pendingReasoning: Record<string, string> = {}
    const rafHandles: Record<string, number> = {}

    const flushPending = (cid: string) => {
      rafHandles[cid] = null as any
      delete rafHandles[cid]
      const chunk = pendingChunks[cid]
      if (chunk) {
        delete pendingChunks[cid]
        useChatStore.getState().appendStreamChunk(chunk, cid)
      }
      const reasoning = pendingReasoning[cid]
      if (reasoning) {
        delete pendingReasoning[cid]
        useChatStore.getState().appendReasoningChunk(reasoning, cid)
      }
    }

    const scheduleFlush = (cid: string) => {
      if (!(cid in rafHandles) || rafHandles[cid] === null || rafHandles[cid] === undefined) {
        rafHandles[cid] = requestAnimationFrame(() => flushPending(cid))
      }
    }

    const flushNow = (cid: string) => {
      if (rafHandles[cid] !== null && rafHandles[cid] !== undefined) {
        cancelAnimationFrame(rafHandles[cid])
        delete rafHandles[cid]
      }
      const chunk = pendingChunks[cid]
      if (chunk) {
        delete pendingChunks[cid]
        useChatStore.getState().appendStreamChunk(chunk, cid)
      }
      const reasoning = pendingReasoning[cid]
      if (reasoning) {
        delete pendingReasoning[cid]
        useChatStore.getState().appendReasoningChunk(reasoning, cid)
      }
    }

    const queueChunk = (content: string, cid: string) => {
      pendingChunks[cid] = (pendingChunks[cid] || '') + content
      scheduleFlush(cid)
    }

    const queueReasoning = (content: string, cid: string) => {
      pendingReasoning[cid] = (pendingReasoning[cid] || '') + content
      scheduleFlush(cid)
    }

    // Drive the run-phase pill from the brain's ACTUAL stream events. The brain
    // path never calls emitPhase, so without this the pill freezes on the
    // initial 'understanding' for the whole turn even while it reasons and uses
    // tools. Only advances when the phase actually changes (avoids churn).
    const advancePhase = (to: AgentRunPhase, cid: string) => {
      const st = useChatStore.getState()
      const stream = st.streams[cid]
      if (stream?.runPhase && stream.runPhase !== 'done' && stream.runPhase !== 'error' && stream.runPhase !== to) {
        st.setRunPhase(to, cid)
      }
    }

    // ── Event handlers — process ALL conversations, not just the active one ──

    window.api.chat.onChunk((e) => {
      const cid = e.conversationId
      if (!cid) return
      advancePhase('summarizing', cid)
      queueChunk(e.content, cid)
    })

    window.api.chat.onReasoning((e) => {
      const cid = e.conversationId
      if (!cid) return
      // Only the FIRST thinking phase; don't yank it back to "planning" if the
      // model reasons again after already answering/acting.
      const stream = useChatStore.getState().streams[cid]
      if (stream?.runPhase === 'understanding') advancePhase('planning', cid)
      queueReasoning(e.content, cid)
    })

    window.api.chat.onDone((e) => {
      const cid = (e as { conversationId?: string })?.conversationId
      if (!cid) return
      flushNow(cid)
      // finishStream handles both active and non-active conversations:
      // - active: appends message to visible list, clears flat streaming fields
      // - non-active: just removes the stream slot (message was saved by backend)
      useChatStore.getState().finishStream(e.message as any, cid)
    })

    window.api.chat.onError((e) => {
      const cid = e?.conversationId
      if (!cid) {
        // No conversation context — surface the error globally
        flushNow(useChatStore.getState().activeConversationId || '')
        useChatStore.getState().streamError(e.error)
        const msg = (e.error || 'The brain hit an error on that turn.').toString().trim()
        toast.error(msg.length > 160 ? msg.slice(0, 157) + '...' : msg)
        return
      }
      flushNow(cid)
      useChatStore.getState().streamError(e.error, cid)
      // The failure must outlive the 4-second toast. streamError wipes the streaming
      // UI (by design — the lock must release), so without a durable row a 30s
      // "thinking…" simply VANISHED with no explanation and no way to retry (QA
      // 2026-08-24, F2). Park a TranscriptNotice in the conversation: it stays until
      // the next send supersedes it, and clicking it re-issues the failed turn.
      const noticeMsg = (e.error || 'The brain hit an error on that turn.').toString().trim()
      useInlineNoticesStore.getState().push({
        id: `turn-error-${cid}`,
        conversationId: cid,
        title: 'This turn failed',
        message: `${noticeMsg} — click to retry.`,
        ts: Date.now(),
        onActivate: () => useChatStore.getState().retryLastSend(cid)
      })
      // Only toast for the active conversation to avoid noise from background streams
      if (cid === useChatStore.getState().activeConversationId) {
        const msg = (e.error || 'The brain hit an error on that turn.').toString().trim()
        toast.error(msg.length > 160 ? msg.slice(0, 157) + '...' : msg)
      }
    })

    window.api.chat.onReset((e) => {
      const cid = e.conversationId
      if (!cid) return
      // The brain discarded its streamed preamble and is about to re-stream clean
      // prose. Drop any chunk buffered-but-not-yet-flushed this frame, then clear
      // the visible body.
      if (rafHandles[cid] !== null && rafHandles[cid] !== undefined) {
        cancelAnimationFrame(rafHandles[cid])
        delete rafHandles[cid]
      }
      delete pendingChunks[cid]
      useChatStore.getState().resetStreamBuffer(cid)
    })

    window.api.chat.onToolCall((e) => {
      const cid = (e as { conversationId?: string })?.conversationId
      if (!cid) return
      advancePhase('acting', cid)
      // Route by the event's conversation. Gating on activeConversationId
      // dropped every tool call a background turn made, so switching back to it
      // showed a turn with no work in it — and any card that started BEFORE the
      // switch stayed 'running' forever because its result was dropped too.
      useChatStore.getState().addToolCall(e as any, cid)
    })

    window.api.chat.onToolCallResult((e) => {
      const cid = (e as { conversationId?: string })?.conversationId
      if (!cid) return
      useChatStore.getState().updateToolCall(e as any, cid)
    })

    // Brain rendered + validated an artifact
    const onArtifact = (window.api.chat as {
      onArtifact?: (
        cb: (e: { conversationId: string; artifactType: string; source: string; title?: string }) => void
      ) => void
    }).onArtifact
    if (onArtifact) {
      onArtifact((e) => {
        if (!e?.conversationId) return
        if (e.conversationId !== useChatStore.getState().activeConversationId) return
        const opener = (window as unknown as { __openArtifact?: (type: string, source: string) => void })
          .__openArtifact
        if (opener && e?.source) opener(e.artifactType || 'html', e.source)
      })
    }

    const onDocCreated = (window.api.chat as {
      onDocumentCreated?: (
        cb: (e: { conversationId: string; document: any }) => void
      ) => () => void
    }).onDocumentCreated
    const docUnsub = onDocCreated
      ? onDocCreated((e) => {
          if (!e?.conversationId) return
          useChatStore.getState().appendStreamingDocument(e.document, e.conversationId)
        })
      : undefined

    // Reviewable / reversible proposed-edit CARD events — new card + every
    // status change (accept / reject / edit). Upsert into the store, which
    // MessageList's ProposedEditQueue renders.
    const onEditProposed = (window.api.chat as {
      onEditProposed?: (
        cb: (e: { conversationId: string; proposal: any }) => void
      ) => () => void
    }).onEditProposed
    const editProposedUnsub = onEditProposed
      ? onEditProposed((e) => {
          if (!e?.conversationId || !e?.proposal) return
          useProposedEditsStore.getState().applyProposed({
            conversationId: e.conversationId,
            proposal: e.proposal
          })
        })
      : undefined

    const onPhase = (window.api.chat as { onPhase?: (cb: (e: { conversationId: string; phase: string }) => void) => void }).onPhase
    if (onPhase) {
      onPhase((e) => {
        const cid = e.conversationId
        if (!cid) return
        const phase = e.phase as AgentRunPhase
        if (phase === 'done' || phase === 'error') {
          useChatStore.getState().setRunPhase(null, cid)
        } else {
          useChatStore.getState().setRunPhase(phase, cid)
        }
      })
    }

    // T4 — streaming-vitals heartbeat.
    const onVitals = (window.api.chat as {
      onStreamingVitals?: (
        cb: (e: {
          conversationId: string
          lastChunkAt: number
          msSinceLastChunk: number
          chunkCount: number
          tokenEstimate: number
          attemptElapsedMs: number
        }) => void
      ) => () => void
    }).onStreamingVitals
    const vitalsUnsub = onVitals
      ? onVitals((e) => {
          if (!e?.conversationId) return
          useChatStore.getState().setStreamingVitals({
            lastChunkAt: e.lastChunkAt,
            msSinceLastChunk: e.msSinceLastChunk,
            chunkCount: e.chunkCount,
            tokenEstimate: e.tokenEstimate,
            attemptElapsedMs: e.attemptElapsedMs
          }, e.conversationId)
        })
      : undefined

    // Plan checklist live updates.
    const planNs = (window.api as { plan?: { onUpdated?: (cb: (e: { conversationId: string; snapshot: unknown }) => void) => () => void } }).plan
    const planUnsub = planNs?.onUpdated
      ? planNs.onUpdated((e) => {
          if (!e?.conversationId) return
          if (e.conversationId !== useChatStore.getState().activeConversationId) return
          usePlanStore.getState().applyUpdate(e.snapshot as PlanSnapshot)
        })
      : undefined

    // ── RESILIENCE — watchdog for stuck streams (per-conversation) ────────
    // A hung turn would leave isStreaming=true and lock the composer forever.
    // This watchdog checks each active stream slot for staleness. We only
    // cancel the ACTIVE conversation's stuck stream (the one the user can see).
    const STUCK_TIMEOUT_MS = 200_000
    const stuckWatchdog = setInterval(() => {
      const st = useChatStore.getState()
      const cid = st.activeConversationId
      if (!cid) return
      const stream = st.streams[cid]
      if (!stream?.isStreaming) return
      const last = Math.max(
        stream.streamStartedAt ?? 0,
        stream.lastActivityAt ?? 0,
        stream.streamingVitals?.lastChunkAt ?? 0
      )
      if (last && Date.now() - last > STUCK_TIMEOUT_MS) {
        st.cancelStream(cid)
        toast.error('That response stalled — you can chat again. Try a faster model if it recurs.')
      }
    }, 5_000)

    return () => {
      // Cancel all pending RAFs
      for (const cid of Object.keys(rafHandles)) {
        if (rafHandles[cid] !== null && rafHandles[cid] !== undefined) {
          cancelAnimationFrame(rafHandles[cid])
        }
      }
      clearInterval(stuckWatchdog)
      window.api?.chat.offAll()
      planUnsub?.()
      docUnsub?.()
      editProposedUnsub?.()
      vitalsUnsub?.()
    }
  }, [])
}
