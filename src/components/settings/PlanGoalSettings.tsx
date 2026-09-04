import { t, tc, tf } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PanelState } from '@/components/ui/PanelState'
import { SettingsLoadError, SettingsLoading, SettingsPage, SettingsRow } from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import { useChatStore } from '@/stores/chat-store'
import type { ConversationPlanGoalState, Goal, GoalStatus, PlanStep, PlanStepStatus } from '@/lib/types'

// Inspect / clear the persisted plan + goal state the `update_plan` and
// create_goal / update_goal tools write per conversation (see
// plan-goal-persistence.ts). This is the cleanup side of that store: the model
// fills it during normal use; here the user can see what's stored and wipe it
// per conversation or all at once. Clearing emits `plan:updated` so an open
// checklist refreshes to empty.

const GLOBAL_KEY = '__global__'

function stepStatusLabel(status: PlanStepStatus): string {
  switch (status) {
    case 'pending':
      return t('Pending')
    case 'in_progress':
      return t('In progress')
    case 'done':
      return t('Done')
    default:
      return status
  }
}

function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case 'open':
      // "Open" the state, not the verb the rest of the app translates.
      return tc('goal status', 'Open')
    case 'in_progress':
      return t('In progress')
    case 'done':
      return t('Done')
    case 'abandoned':
      return t('Abandoned')
    default:
      return status
  }
}

const STEP_DOT: Record<PlanStepStatus, string> = {
  pending: 'text-[var(--text-muted)]',
  in_progress: 'text-[var(--warning)]',
  done: 'text-[var(--success)]'
}

function PlanStepRow({ step, index }: { step: PlanStep; index: number }): React.ReactElement {
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <span aria-hidden className={`pt-0.5 font-mono ${STEP_DOT[step.status]}`}>
        {step.status === 'done' ? '●' : '○'}
      </span>
      <span className="text-[var(--text-muted)]">{index}.</span>
      <span className="min-w-0 flex-1 break-words text-[var(--text-secondary)]">
        {step.text || <em className="text-[var(--text-muted)]">{t('(empty)')}</em>}
      </span>
      <span className="shrink-0 font-mono text-[11px] uppercase text-[var(--text-muted)]">
        {stepStatusLabel(step.status)}
      </span>
    </li>
  )
}

function GoalRow({ goal }: { goal: Goal }): React.ReactElement {
  return (
    <li className="flex items-start justify-between gap-2 text-[12px]">
      <span className="min-w-0 flex-1 break-words text-[var(--text-secondary)]">
        {goal.title}
        {goal.dueDate && (
          <span className="ml-1 text-[11px] text-[var(--text-muted)]">
            · {tf('due {date}', { date: goal.dueDate })}
          </span>
        )}
      </span>
      <span className="shrink-0 font-mono text-[11px] uppercase text-[var(--text-muted)]">
        {goalStatusLabel(goal.status)}
      </span>
    </li>
  )
}

export function PlanGoalSettings(): React.ReactElement {
  const [state, setState] = useState<PanelStatus<ConversationPlanGoalState[]>>(panelLoading())
  const [busy, setBusy] = useState<string | null>(null)
  // The cards used to be titled by a truncated conversation id. The titles are already in
  // the chat store; fall back to the id only for a conversation it no longer lists.
  const conversations = useChatStore((s) => s.conversations)
  const titles = useMemo(() => new Map(conversations.map((c) => [c.id, c.title])), [conversations])

  const conversationLabel = useCallback(
    (id: string): string => {
      if (id === GLOBAL_KEY) return t('Global (no conversation)')
      const title = titles.get(id)?.trim()
      return title || tf('Conversation {id}', { id: `${id.slice(0, 8)}…` })
    },
    [titles]
  )

  // A thrown listAllState used to leave the page on "Loading…" for good; query() turns a
  // throw, a missing handler and success:false into one error with a Retry.
  const refresh = useCallback(async (): Promise<void> => {
    setState(panelFromResult(await query<ConversationPlanGoalState[]>('plans and goals', window.api?.plan?.listAllState)))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const states = state.phase === 'ready' ? state.data : []

  // Conversations with the most steps + goals first; stable by id otherwise.
  const sorted = useMemo(
    () =>
      [...states].sort((a, b) => {
        const sizeA = a.planSteps.length + a.goals.length
        const sizeB = b.planSteps.length + b.goals.length
        return sizeB - sizeA || a.conversationId.localeCompare(b.conversationId)
      }),
    [states]
  )

  const totalSteps = useMemo(() => states.reduce((n, s) => n + s.planSteps.length, 0), [states])
  const totalGoals = useMemo(() => states.reduce((n, s) => n + s.goals.length, 0), [states])

  const handleClearConversation = async (conversationId: string): Promise<void> => {
    if (
      !window.confirm(
        tf('Clear the plan and goals for "{name}"? This cannot be undone.', {
          name: conversationLabel(conversationId)
        })
      )
    ) {
      return
    }
    setBusy(conversationId)
    try {
      await invoke('clear plan and goals', () => window.api.plan.clearConversationState(conversationId))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not clear that conversation')))
    } finally {
      setBusy(null)
    }
  }

  const handleClearAll = async (): Promise<void> => {
    if (states.length === 0) return
    if (
      !window.confirm(
        tf('Clear the plans and goals of all {n} conversations? This cannot be undone.', { n: states.length })
      )
    ) {
      return
    }
    setBusy('all')
    try {
      await invoke('clear all plans and goals', () => window.api.plan.clearAllState())
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not clear the plans and goals')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage
      purpose={t('Plans and goals the model keeps per conversation. They clear when you delete the conversation; clear them here by hand.')}
      actions={
        <Button
          variant="danger"
          size="sm"
          disabled={states.length === 0 || busy === 'all'}
          onClick={() => void handleClearAll()}
        >
          {busy === 'all' ? t('Clearing…') : t('Clear all')}
        </Button>
      }
    >
      <PanelState
        state={state}
        loading={<SettingsLoading what={t('plans and goals')} />}
        error={(message, retry) => (
          <SettingsLoadError what={t('plans and goals')} message={message} onRetry={retry} />
        )}
        empty={
          <div className="rounded-lg border border-dashed border-[var(--panel-border)] px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {t('No stored plans or goals yet.')}
          </div>
        }
        onRetry={() => void refresh()}
      >
        {() => (
          <div className="space-y-3">
            <p className="text-[11px] text-[var(--text-muted)]">
              {tf('{conversations} conversations · {steps} plan steps · {goals} goals', {
                conversations: states.length,
                steps: totalSteps,
                goals: totalGoals
              })}
            </p>

            {sorted.map((entry) => {
              const clearing = busy === entry.conversationId
              return (
                <SettingsRow
                  key={entry.conversationId}
                  label={<span className="block truncate">{conversationLabel(entry.conversationId)}</span>}
                  hint={tf('{steps} steps · {goals} goals', {
                    steps: entry.planSteps.length,
                    goals: entry.goals.length
                  })}
                  control={
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void handleClearConversation(entry.conversationId)}
                    >
                      {clearing ? t('Clearing…') : t('Clear')}
                    </Button>
                  }
                >
                  {entry.planSteps.length > 0 && (
                    <div className="mb-2">
                      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                        {t('Plan')}
                      </div>
                      <ul className="space-y-1">
                        {entry.planSteps.map((step, i) => (
                          <PlanStepRow key={step.id} step={step} index={i + 1} />
                        ))}
                      </ul>
                    </div>
                  )}

                  {entry.goals.length > 0 && (
                    <div>
                      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                        {t('Goals')}
                      </div>
                      <ul className="space-y-1">
                        {entry.goals.map((goal) => (
                          <GoalRow key={goal.id} goal={goal} />
                        ))}
                      </ul>
                    </div>
                  )}
                </SettingsRow>
              )
            })}
          </div>
        )}
      </PanelState>
    </SettingsPage>
  )
}
