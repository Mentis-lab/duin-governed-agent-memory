import { t, tf } from '@/lib/i18n'
import { useId, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import type {
  HookEvent,
  HookLanguage,
  HookSampleContext,
  HookTestResult
} from '@/stores/hooks-store'

interface SamplePayload {
  id: string
  /** English; rendered through sampleLabel(). */
  label: string
  context: HookSampleContext
}

const SAMPLE_PAYLOADS: Record<HookEvent, SamplePayload[]> = {
  sessionStart: [
    { id: 'workspace', label: 'Workspace launch', context: { cwd: 'C:\\workspace' } },
    { id: 'project', label: 'Project launch', context: { cwd: 'C:\\workspace\\production-app' } }
  ],
  promptSubmit: [
    {
      id: 'refactor',
      label: 'Refactor prompt',
      context: {
        conversationId: 'sample-conv',
        promptBody: 'Refactor the auth module.',
        cwd: 'C:\\workspace'
      }
    },
    {
      id: 'prod',
      label: 'Production request',
      context: {
        conversationId: 'sample-conv',
        promptBody: 'Deploy the production hotfix.',
        cwd: 'C:\\workspace\\production-app'
      }
    }
  ],
  preToolUse: [
    {
      id: 'risky-shell',
      label: 'Risky shell',
      context: {
        conversationId: 'sample-conv',
        toolName: 'shell_command',
        args: { command: 'rm -rf node_modules' },
        cwd: 'C:\\workspace\\production-app'
      }
    },
    {
      id: 'read-file',
      label: 'Read file',
      context: {
        conversationId: 'sample-conv',
        toolName: 'read_file',
        args: { path: 'src/App.tsx' },
        cwd: 'C:\\workspace'
      }
    }
  ],
  postToolUse: [
    {
      id: 'shell-result',
      label: 'Shell result',
      context: {
        conversationId: 'sample-conv',
        toolName: 'shell_command',
        args: { command: 'npm test' },
        result: '1152 tests passed',
        cwd: 'C:\\workspace'
      }
    },
    {
      id: 'write-result',
      label: 'File write',
      context: {
        conversationId: 'sample-conv',
        toolName: 'apply_patch',
        args: { path: 'src/App.tsx' },
        result: 'updated 1 file',
        cwd: 'C:\\workspace'
      }
    }
  ],
  agentStop: [
    { id: 'complete', label: 'Completed run', context: { conversationId: 'sample-conv' } },
    { id: 'review', label: 'Review run', context: { conversationId: 'review-conv' } }
  ],
  automationStarted: [
    {
      id: 'automationstarted',
      label: 'Automation start',
      context: { sourceId: 'auto-1', label: 'Morning brief', promptBody: 'Summarise overnight.' }
    }
  ],
  automationDone: [
    {
      id: 'automationdone',
      label: 'Automation end',
      context: { sourceId: 'auto-1', label: 'Morning brief' }
    }
  ],
  workflowStarted: [
    {
      id: 'workflowstarted',
      label: 'Workflow start',
      context: { sourceId: 'run-1', label: 'review-changes' }
    }
  ],
  workflowFinished: [
    {
      id: 'workflowfinished',
      label: 'Workflow end',
      context: { sourceId: 'run-1', label: 'review-changes' }
    }
  ]
}

// Sample names as literal t() calls so the coverage test sees every key.
function sampleLabel(sample: SamplePayload): string {
  switch (sample.id) {
    case 'workspace':
      return t('Workspace launch')
    case 'project':
      return t('Project launch')
    case 'refactor':
      return t('Refactor prompt')
    case 'prod':
      return t('Production request')
    case 'risky-shell':
      return t('Risky shell')
    case 'read-file':
      return t('Read file')
    case 'shell-result':
      return t('Shell result')
    case 'write-result':
      return t('File write')
    case 'complete':
      return t('Completed run')
    case 'review':
      return t('Review run')
    case 'automationstarted':
      return t('Automation start')
    case 'automationdone':
      return t('Automation end')
    case 'workflowstarted':
      return t('Workflow start')
    case 'workflowfinished':
      return t('Workflow end')
    default:
      return t(sample.label)
  }
}

interface HookTestRunnerProps {
  event: HookEvent
  language: HookLanguage
  code: string
  timeoutMs: number
  testing: boolean
  lastTest: { code: string; event: HookEvent; result: HookTestResult } | null
  onRun: (context: HookSampleContext) => void
  onClear: () => void
  /** Hooks are switched off under General: a run would only report "disabled". */
  disabled?: boolean
}

export function HookTestRunner({
  event,
  language,
  code,
  timeoutMs,
  testing,
  lastTest,
  onRun,
  onClear,
  disabled
}: HookTestRunnerProps): React.ReactElement {
  // A hook stored against an event this build no longer offers has no samples.
  const samples = SAMPLE_PAYLOADS[event] ?? []
  const [sampleId, setSampleId] = useState(samples[0]?.id ?? '')
  const selectId = useId()

  const sample = useMemo(
    () => samples.find((item) => item.id === sampleId) ?? samples[0],
    [sampleId, samples]
  )

  const payloadText = useMemo(() => JSON.stringify(sample?.context ?? {}, null, 2), [sample])

  const blocked = Boolean(lastTest?.result.thrown)
  const hasLogs = Boolean(lastTest?.result.logs.length)

  const runTitle = disabled
    ? t('Hooks are switched off under General.')
    : language !== 'js'
      ? t('Only JavaScript hooks can be test-run.')
      : undefined

  return (
    <div className="mt-3 rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {t('Test runner')}
        </span>
        <label htmlFor={selectId} className="text-[11px] text-[var(--text-muted)]">
          {t('Sample')}
        </label>
        <Select
          id={selectId}
          value={sample?.id ?? ''}
          onChange={(e) => setSampleId(e.target.value)}
          className="py-1 text-[11px]"
        >
          {samples.map((item) => (
            <option key={item.id} value={item.id}>
              {sampleLabel(item)}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          onClick={() => sample && onRun(sample.context)}
          disabled={disabled || testing || language !== 'js' || !code.trim() || !sample}
          title={runTitle}
        >
          {testing ? t('Running…') : t('Run sample')}
        </Button>
        <span className="text-[11px] text-[var(--text-muted)]">
          {tf('{ms} ms timeout', { ms: timeoutMs })}
        </span>
      </div>

      <pre className="max-h-28 overflow-auto rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] leading-relaxed text-[var(--text-muted)]">
        {payloadText}
      </pre>

      {lastTest && (
        <div
          role="status"
          className="mt-2 rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 text-[11px]"
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
              {t('Result')} · {lastTest.event}
            </span>
            {blocked ? (
              <span className="rounded bg-[var(--error)] px-1.5 py-0.5 text-[11px] text-[var(--on-accent)]">
                {t('Blocked')}
              </span>
            ) : (
              <span className="rounded bg-[var(--success)] px-1.5 py-0.5 text-[11px] text-[var(--on-accent)]">
                {t('OK')}
              </span>
            )}
            <Button variant="ghost" size="sm" onClick={onClear} className="ml-auto">
              {t('Clear')}
            </Button>
          </div>
          {lastTest.result.thrown && (
            <pre className="m-0 mb-1 whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--error)]">
              {t('Sandbox error')}: {lastTest.result.thrown}
            </pre>
          )}
          {!hasLogs && !blocked && <p className="m-0 text-[var(--text-muted)]">{t('No log output.')}</p>}
          {lastTest.result.logs.map((line, index) => (
            <pre
              key={index}
              className={
                'm-0 whitespace-pre-wrap break-all font-mono text-[11px] ' +
                (line.kind === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-muted)]')
              }
            >
              {line.kind === 'error' ? '! ' : '> '}
              {line.message}
            </pre>
          ))}
        </div>
      )}
    </div>
  )
}
