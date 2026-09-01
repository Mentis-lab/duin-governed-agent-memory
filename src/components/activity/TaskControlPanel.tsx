import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useChatStore } from '@/stores/chat-store'
import { toast } from '@/stores/toast-store'
import {
  buildConversationTaskRows,
  type TaskGraphNodeView
} from '@/lib/task-control-presentation'

// DUIN task-graph control panel. Additive sub-component rendered inside the
// Activity dashboard. Reads the canonical conversation + agent-run graph and
// exposes recoverable lifecycle (pin / archive / close / restore / rename),
// bounded wait, and a two-step permanent delete.
//
// DUIN adaptation of the upstream lamprey TaskControlPanel: no turn-control, so
// the steer / interrupt affordances are dropped. Everything speaks
// window.api.taskGraph.* (task-graph:* IPC).

interface TaskGraphView {
  nodes: TaskGraphNodeView[]
  total: number
}

interface DeletePreview {
  previewToken: string
  conversationIds: string[]
  agentRunIds: string[]
  identityIds: string[]
  turnIds: string[]
  activeNodeIds: string[]
}

function resultData<T>(result: { success: boolean; data?: T; error?: string }): T {
  if (!result.success || result.data === undefined)
    throw new Error(result.error || 'Task action failed')
  return result.data
}

export function TaskControlPanel(): ReactElement | null {
  const [graph, setGraph] = useState<TaskGraphView>({ nodes: [], total: 0 })
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null)
  const selectConversation = useChatStore((state) => state.selectConversation)

  const refresh = useCallback(async () => {
    if (!window.api?.taskGraph?.graph) return
    try {
      const data = resultData<TaskGraphView>(await window.api.taskGraph.graph({ limit: 200 }))
      setGraph(data)
      setSelectedId((current) =>
        current && data.nodes.some((node) => node.id === current)
          ? current
          : (data.nodes.find((node) => node.kind === 'conversation')?.id ?? null)
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load task graph')
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (!window.api?.taskGraph?.onNotify) return
    return window.api.taskGraph.onNotify(() => void refresh())
  }, [refresh])

  const rows = useMemo(() => buildConversationTaskRows(graph.nodes), [graph.nodes])
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null
  const conversationId = selected ? String(selected.metadata.entityId) : null
  const pinned = selected?.metadata.pinned === true
  const unread = Number(selected?.metadata.unreadCount ?? 0)

  useEffect(() => {
    setTitle(selected?.title ?? '')
    setDeletePreview(null)
  }, [selected?.id, selected?.title])

  const perform = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await work()
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Task action failed')
    } finally {
      setBusy(false)
    }
  }

  const updateMetadata = (
    action: 'rename' | 'pin' | 'unpin' | 'archive' | 'restore' | 'close',
    value?: string
  ) =>
    perform(async () => {
      if (!selectedId) return
      resultData(await window.api.taskGraph.updateMetadata(selectedId, action, value))
      toast.success(`Task ${action} complete`)
    })

  const wait = () =>
    perform(async () => {
      if (!selectedId) return
      const data = resultData<{ reason: string }>(
        await window.api.taskGraph.waitGraph([{ taskId: selectedId }], 30_000)
      )
      toast.info(data.reason === 'changed' ? 'Task changed' : 'Task wait timed out')
    })

  if (rows.length === 0) return null

  return (
    <section
      className="mt-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2"
      data-testid="task-control-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('Task graph')}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-[10px] text-[var(--accent)]"
        >
          {t('Refresh')}
        </button>
      </div>
      <div className="mt-1 max-h-36 overflow-y-auto">
        {rows.map(({ node, depth }) => {
          const nodeUnread = Number(node.metadata.unreadCount ?? 0)
          return (
            <button
              type="button"
              key={node.id}
              onClick={() => setSelectedId(node.id)}
              className={`flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] ${selectedId === node.id ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              <span aria-hidden>{depth ? '↳' : '•'}</span>
              <span className="min-w-0 flex-1 truncate">{node.title || 'Untitled task'}</span>
              {nodeUnread > 0 && (
                <span
                  className="rounded-full bg-[var(--accent)] px-1 text-[9px] text-white"
                  title={t('Unread task events')}
                >
                  {nodeUnread}
                </span>
              )}
              <span className="font-mono text-[9px] uppercase text-[var(--text-muted)]">
                {node.status}
              </span>
            </button>
          )
        })}
      </div>

      {selected && conversationId && (
        <div className="mt-2 space-y-2 border-t border-[var(--panel-border)] pt-2">
          <div className="flex flex-wrap gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => void selectConversation(conversationId)}
              className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
            >
              {t('Open')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={wait}
              className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
            >
              {t('Wait 30s')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => updateMetadata(pinned ? 'unpin' : 'pin')}
              className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
            {selected.status === 'archived' || selected.status === 'closed' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => updateMetadata('restore')}
                className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
              >
                {t('Restore')}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => updateMetadata('archive')}
                  className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
                >
                  {t('Archive')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => updateMetadata('close')}
                  className="rounded bg-[var(--bg-tertiary)] px-2 py-1"
                >
                  {t('Close')}
                </button>
              </>
            )}
          </div>

          <div className="flex gap-1">
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label={t('Task title')}
              className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px]"
            />
            <button
              type="button"
              disabled={busy || !title.trim()}
              onClick={() => updateMetadata('rename', title)}
              className="rounded bg-[var(--bg-tertiary)] px-2 text-[10px]"
            >
              {t('Rename')}
            </button>
          </div>

          {deletePreview ? (
            <div className="rounded border border-red-500/30 bg-red-500/5 p-1.5 text-[10px] text-red-700 dark:text-red-300">
              <p>
                {deletePreview.conversationIds.length} conversation(s),{' '}
                {deletePreview.agentRunIds.length} run(s).{' '}
                {deletePreview.activeNodeIds.length
                  ? 'Active descendants block deletion.'
                  : 'This cannot be undone.'}
              </p>
              <button
                type="button"
                disabled={busy || deletePreview.activeNodeIds.length > 0}
                onClick={() =>
                  perform(async () => {
                    resultData(
                      await window.api.taskGraph.deleteGraphTask(
                        selectedId!,
                        deletePreview.previewToken
                      )
                    )
                    setDeletePreview(null)
                    toast.success('Task tree permanently deleted')
                  })
                }
                className="mt-1 rounded bg-red-600 px-2 py-1 text-white"
              >
                {t('Delete permanently')}
              </button>
              <button
                type="button"
                onClick={() => setDeletePreview(null)}
                className="ml-1 px-2 py-1"
              >
                {t('Cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                perform(async () =>
                  setDeletePreview(
                    resultData<DeletePreview>(await window.api.taskGraph.previewDelete(selected.id))
                  )
                )
              }
              className="text-[10px] text-red-600"
            >
              {t('Preview permanent deletion')}
            </button>
          )}
          {unread > 0 && (
            <p className="text-[10px] text-[var(--text-muted)]">
              {unread} unread task event{unread === 1 ? '' : 's'} will be delivered on the task's
              next turn.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
