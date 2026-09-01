import { t } from '@/lib/i18n'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { useUiStore } from '@/stores/ui-store'
import { useWorkflowsStore, type WorkflowLibraryEntry } from '@/stores/workflows-store'
import { WorkflowEditor } from './WorkflowEditor'

function score(query: string, entry: WorkflowLibraryEntry): boolean {
  if (!query.trim()) return true
  const q = query.toLowerCase()
  return `${entry.name} ${entry.description} ${entry.origin}`.toLowerCase().includes(q)
}

export function WorkflowPalette(): ReactElement | null {
  const visible = useUiStore((s) => s.workflowPaletteVisible)
  const close = useUiStore((s) => s.closeWorkflowPalette)
  const library = useWorkflowsStore((s) => s.library)
  const loading = useWorkflowsStore((s) => s.libraryLoading)
  const error = useWorkflowsStore((s) => s.libraryError)
  const refreshLibrary = useWorkflowsStore((s) => s.refreshLibrary)
  const runWorkflow = useWorkflowsStore((s) => s.runWorkflow)
  const deleteWorkflow = useWorkflowsStore((s) => s.deleteWorkflow)
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  // Two-step delete: the first click arms, the second removes. Deleting a workflow
  // unlinks a file, so it should not be one stray click away from a run.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!visible) return
    setQuery('')
    setActiveIdx(0)
    setEditorOpen(false)
    setArmedDelete(null)
    requestAnimationFrame(() => inputRef.current?.focus())
    void refreshLibrary()
  }, [refreshLibrary, visible])

  const matches = useMemo(() => library.filter((entry) => score(query, entry)).slice(0, 30), [library, query])

  useEffect(() => {
    setActiveIdx(0)
    // A confirmation armed against one row must not still be armed after the list
    // changes underneath it — otherwise a later single click deletes a file the user
    // never armed.
    setArmedDelete(null)
  }, [query])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (!editorOpen && e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((idx) => Math.min(matches.length - 1, idx + 1))
      } else if (!editorOpen && e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((idx) => Math.max(0, idx - 1))
      } else if (!editorOpen && e.key === 'Enter') {
        // Let a focused control have its own Enter. This is a WINDOW listener that
        // preventDefault()s, so it used to swallow the Delete/Confirm button's native
        // activation: pressing Enter to confirm a delete instead STARTED an unrelated
        // workflow (activeIdx tracks the mouse, never focus) and closed the palette.
        if (document.activeElement instanceof HTMLButtonElement) return
        const entry = matches[activeIdx]
        if (!entry) return
        e.preventDefault()
        void run(entry)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeIdx, close, editorOpen, matches, visible])

  const run = async (entry: WorkflowLibraryEntry) => {
    const runId = await runWorkflow(entry.name)
    if (!runId) {
      toast.error('Workflow did not start')
      return
    }
    toast.success(`Started ${entry.name}`)
    close()
  }

  const remove = async (name: string) => {
    if (armedDelete !== name) {
      setArmedDelete(name)
      return
    }
    setArmedDelete(null)
    if (await deleteWorkflow(name)) {
      // refreshLibrary just shrank the list; keep the cursor inside it.
      setActiveIdx(0)
      toast.success(`Deleted ${name}`)
    } else {
      toast.error(`Could not delete ${name}`)
    }
  }

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-black/35 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
      data-testid="workflow-palette"
    >
      <div className="flex h-[72vh] w-[min(980px,calc(100vw-32px))] overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] shadow-2xl">
        <div className="flex w-[360px] shrink-0 flex-col border-r border-[var(--panel-border)]">
          <div className="border-b border-[var(--panel-border)] p-3">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={loading ? 'Loading workflows...' : 'Run workflow...'}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-2 text-[14px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
            />
            <Button variant="secondary" className="mt-2 w-full text-left"
              onClick={() => setEditorOpen(true)}
            >
              {t('New workflow')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {error && <div className="px-3 py-2 text-[12px] text-[var(--error)]">{error}</div>}
            {!error && !loading && matches.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t('No workflows found.')}</div>
            )}
            {matches.map((entry, idx) => (
              <div
                key={`${entry.origin}:${entry.name}`}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`flex w-full items-center gap-2 pr-2 transition-colors ${
                  idx === activeIdx
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => void run(entry)}
                  className="flex min-w-0 flex-1 flex-col px-3 py-2 text-left"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium">{entry.name}</span>
                    <span className="rounded bg-[var(--bg-primary)] px-1 py-0.5 font-mono text-[11px] uppercase text-[var(--text-muted)]">
                      {entry.origin}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[11px] text-[var(--text-muted)]">
                    {entry.description}
                  </span>
                </button>
                {/* Built-ins ship with the app and deleteUserWorkflow refuses them
                    anyway, so only user scripts get the control at all. */}
                {entry.origin === 'user' && (
                  <button
                    type="button"
                    title={`Delete ${entry.name}`}
                    onClick={() => void remove(entry.name)}
                    className={`shrink-0 rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                      armedDelete === entry.name
                        ? 'bg-[var(--error)] text-white'
                        : 'text-[var(--text-muted)] hover:bg-[var(--bg-primary)] hover:text-[var(--error)]'
                    }`}
                  >
                    {armedDelete === entry.name ? 'Confirm' : 'Delete'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        {editorOpen ? (
          <WorkflowEditor
            onSaved={() => {
              setEditorOpen(false)
              void refreshLibrary()
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
            {matches[activeIdx]?.description ?? 'Select a workflow'}
          </div>
        )}
      </div>
    </div>
  )
}
