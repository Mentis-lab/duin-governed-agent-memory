import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { useToolsStore } from '@/stores/tools-store'
import { useWorkflowsStore } from '@/stores/workflows-store'
import { DryRunPanel, dryRunWorkflowSource, type DryRunResult } from './DryRunPanel'
import { MetaScaffolder, workflowScaffold } from './MetaScaffolder'

interface WorkflowEditorProps {
  onSaved: () => void
}

export function WorkflowEditor({ onSaved }: WorkflowEditorProps): ReactElement {
  const [script, setScript] = useState(() => workflowScaffold())
  const [validation, setValidation] = useState<{ ok: true; label: string } | { ok: false; error: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null)
  // A 'conflict' refusal is the ONLY one the user can resolve in place, so it gets a
  // banner with the overwrite action rather than a toast that disappears.
  const [conflict, setConflict] = useState<{ name: string; message: string } | null>(null)
  const validateWorkflow = useWorkflowsStore((s) => s.validateWorkflow)
  const saveWorkflow = useWorkflowsStore((s) => s.saveWorkflow)
  const stubs = useToolsStore((s) => s.stubs)
  const loadStubs = useToolsStore((s) => s.loadStubs)

  useEffect(() => {
    void loadStubs()
  }, [loadStubs])

  useEffect(() => {
    const id = window.setTimeout(() => {
      void validateWorkflow(script).then((result) => {
        if (result.ok) {
          const meta = result.meta as { name?: string }
          setValidation({ ok: true, label: meta.name ?? 'valid' })
        } else {
          setValidation({ ok: false, error: result.error })
        }
      })
    }, 300)
    return () => window.clearTimeout(id)
  }, [script, validateWorkflow])

  const suggestions = useMemo(
    () => stubs.filter((stub) => /agent|task|workflow|preview|monitor/i.test(`${stub.name} ${stub.description}`)).slice(0, 6),
    [stubs]
  )

  const save = async (overwrite = false) => {
    setSaving(true)
    const outcome = await saveWorkflow(script, overwrite)
    setSaving(false)
    if (outcome.ok) {
      setConflict(null)
      toast.success(`Saved ${outcome.entry.name}`)
      onSaved()
      return
    }
    // Route by WHICH refusal. workflow-library distinguishes these deliberately:
    // a name collision is fixable right here (replace it), a scaffold placeholder
    // name is not (the user has to name the workflow first). Collapsing both into
    // one "save failed" toast is what left overwrite unreachable from the UI.
    if (outcome.code === 'conflict') {
      setConflict({ name: outcome.name ?? 'this workflow', message: outcome.error })
      return
    }
    // Belt and braces with the onChange reset: if an overwrite ever comes back naming a
    // DIFFERENT workflow than the one confirmed, re-prompt rather than honour it.
    setConflict(null)
    toast.error(outcome.error)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-[var(--panel-border)] bg-[var(--bg-primary)]" data-testid="workflow-editor">
      <div className="flex items-center justify-between border-b border-[var(--panel-border)] px-3 py-2">
        <div>
          <div className="text-[12px] font-medium text-[var(--text-primary)]">{t('New workflow')}</div>
          {validation && (
            <div className={`font-mono text-[11px] ${validation.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
              {validation.ok ? `meta: ${validation.label}` : validation.error}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <MetaScaffolder onInsert={setScript} />
          <Button variant="secondary" className="font-mono"
            onClick={() => setDryRun(dryRunWorkflowSource(script))}
          >
            {t('Dry run')}
          </Button>
          <Button variant="primary" className="font-mono"
            onClick={() => void save()}
            disabled={saving || validation?.ok === false}
          >
            {saving ? 'Saving' : 'Save'}
          </Button>
        </div>
      </div>
      {conflict && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-2">
          <span className="text-[12px] text-[var(--text-secondary)]">{conflict.message}</span>
          <span className="flex shrink-0 items-center gap-1">
            <Button variant="secondary" className="font-mono" onClick={() => setConflict(null)}>
              {t('Cancel')}
            </Button>
            <Button variant="primary" className="font-mono" disabled={saving} onClick={() => void save(true)}>
              {saving ? 'Replacing' : 'Replace'}
            </Button>
          </span>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_220px]">
        <textarea
          value={script}
          // Editing invalidates the confirmation. `conflict` names the workflow the user
          // agreed to replace, but save(true) re-reads the CURRENT script and derives the
          // target file from ITS meta.name — so a banner left standing across an edit
          // could authorize overwriting a different workflow than the one it warned about.
          onChange={(e) => {
            setConflict(null)
            setScript(e.target.value)
          }}
          spellCheck={false}
          className="min-h-0 resize-none border-0 bg-[var(--bg-primary)] p-3 font-mono text-[12px] leading-5 text-[var(--text-primary)] outline-none"
        />
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto border-l border-[var(--panel-border)] p-2">
          <div className="rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2">
            <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
              {t('Registry')}
            </div>
            <button
              type="button"
              onClick={() => setScript((current) => `${current}\nconst reply = await agent('Prompt', { label: 'agent-1', agentType: 'general', model: 'cheap' })\n`)}
              className="mb-1 w-full rounded bg-[var(--bg-primary)] px-2 py-1 text-left font-mono text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              agent(...)
            </button>
            {suggestions.map((stub) => (
              <div key={stub.name} className="truncate font-mono text-[11px] text-[var(--text-muted)]" title={stub.description}>
                {stub.name}
              </div>
            ))}
          </div>
          <DryRunPanel result={dryRun} />
        </div>
      </div>
    </div>
  )
}
