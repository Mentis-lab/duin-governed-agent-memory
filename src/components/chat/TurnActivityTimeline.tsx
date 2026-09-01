import { useEffect, useRef, useState } from 'react'
import type { ToolCallState } from '@/stores/chat-store'
import type { AgentRunPhase } from '@/lib/types'
import { groupConsecutiveToolCalls, groupTotalDurationMs } from '@/lib/tool-call-grouping'
import { formatElapsed } from '@/lib/tool-card-helpers'
import { ReasoningBlock } from './ReasoningBlock'
import { ToolUseGroup } from './ToolUseGroup'
import { ToolUseCard } from './ToolUseCard'

// Per-turn Activity Timeline. One in-transcript surface per assistant turn that
// unifies what used to be three disconnected things — the run-phase pill
// (AgentRunBanner), the reasoning card (ReasoningBlock), and the conversation-
// level tool chip (ToolActivityChip). Generalizes the AgentRunInlineGroup (J7)
// "transcript is the single source of truth" pattern to every turn.
//
//   Streaming  → expanded, live: phase label + current tool step + elapsed
//                heartbeat. This is also what fills a HIDDEN-reasoning model's
//                silent gap (gpt-5.5-oneai streams no CoT) so a turn never
//                looks dead while the model thinks privately.
//   Done       → collapses to a persistent "Worked Xs · N steps ▸" header that
//                expands to the full ordered trace (reasoning + each tool call).
//                Nothing disappears; the trace stays inspectable, bound to the
//                turn (not the conversation).

const PHASE_LABEL: Record<AgentRunPhase, string> = {
  understanding: 'Reading your message',
  gathering_context: 'Reading project',
  planning: 'Thinking',
  acting: 'Working',
  verifying: 'Checking result',
  summarizing: 'Responding',
  done: 'Done',
  error: 'Stopped'
}

export interface TurnActivityTimelineProps {
  /** Tool calls belonging to THIS turn (live for the streaming turn, persisted
   *  for a historical one). Selected per-message by the caller. */
  toolCalls: ToolCallState[]
  /** Streamed chain-of-thought, when the provider exposes a reasoning channel. */
  reasoning?: string | null
  /** Live run phase off the chat:phase stream; null when no run is active. */
  runPhase?: AgentRunPhase | null
  /** True while this turn is the one currently streaming. */
  isStreaming?: boolean
  /** OpenAI-lineage reasoners (incl. via the OneAI gateway) never emit a
   *  reasoning stream — their CoT is hidden. When true and no reasoning
   *  arrived, the timeline says "thinking privately" rather than implying a
   *  broken stream. */
  hiddenReasoning?: boolean
}

/** Ticking elapsed since `since`, paused (frozen) when `running` is false. */
function useLiveElapsed(since: number | undefined, running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  if (since == null) return 0
  return Math.max(0, now - since)
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span className="flex-none text-[12px] text-[var(--text-muted)]" aria-hidden>
      {open ? '▾' : '▸'}
    </span>
  )
}

export function TurnActivityTimeline({
  toolCalls,
  reasoning,
  runPhase,
  isStreaming,
  hiddenReasoning
}: TurnActivityTimelineProps) {
  const hasReasoning = !!(reasoning && reasoning.trim())
  const hasTools = toolCalls.length > 0
  const active = !!isStreaming && runPhase != null && runPhase !== 'done' && runPhase !== 'error'

  // Auto-expanded while the turn runs; auto-collapses once when it finishes.
  // A manual toggle after completion wins (we only force-collapse on the
  // active→idle transition, tracked by wasActive).
  const [open, setOpen] = useState<boolean>(active)
  const wasActive = useRef<boolean>(active)
  useEffect(() => {
    if (wasActive.current && !active) setOpen(false)
    if (!wasActive.current && active) setOpen(true)
      wasActive.current = active
  }, [active])

  const runningTool = toolCalls.find((t) => t.status === 'running' || t.status === 'pending')
  const stepCount = toolCalls.length
  const totalMs = groupTotalDurationMs(toolCalls)
  // Hook must run every render (before any early return) — Rules of Hooks.
  const liveMs = useLiveElapsed(runningTool?.startedAt ?? toolCalls[0]?.startedAt, active)

  // Nothing to show: no reasoning, no tools, not currently running.
  if (!hasReasoning && !hasTools && !active) return null

  // ── Header ────────────────────────────────────────────────────────────
  const header = active ? (
    <span className="inline-flex items-center gap-2">
      <span className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-[var(--accent)]" aria-hidden />
      <span className="text-[var(--text-secondary)]">
        {runningTool?.title || runningTool?.toolName || (runPhase ? PHASE_LABEL[runPhase] : 'Working')}
      </span>
      {liveMs > 0 && <span className="font-mono tabular-nums text-[var(--text-muted)]">{formatElapsed(liveMs)}</span>}
    </span>
  ) : (
    <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
      <span className="inline-block h-2 w-2 flex-none rounded-full bg-[var(--success)]" aria-hidden />
      <span>
        {stepCount > 0
          ? `Worked${totalMs > 0 ? ` ${formatElapsed(totalMs)}` : ''} · ${stepCount} step${stepCount === 1 ? '' : 's'}`
          : 'Reasoning'}
      </span>
    </span>
  )

  const items = groupConsecutiveToolCalls(toolCalls)

  return (
    <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]"
        aria-expanded={open}
      >
        <Chevron open={open} />
        {header}
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-3 pb-2">
          {hasReasoning ? (
            <ReasoningBlock content={reasoning as string} isThinking={active} />
          ) : (
            active &&
            hiddenReasoning && (
              <div className="px-1 text-[12px] italic text-[var(--text-muted)]">
                Thinking privately — this model doesn&rsquo;t stream its reasoning.
              </div>
            )
          )}
          {items.map((item, i) =>
            item.kind === 'group' ? (
              <ToolUseGroup key={`g${i}`} group={item} />
            ) : (
              <ToolUseCard key={item.toolCall.callId} toolCall={item.toolCall} />
            )
          )}
        </div>
      )}
    </div>
  )
}
