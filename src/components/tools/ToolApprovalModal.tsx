import { t } from '@/lib/i18n'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import type {
  ApprovalDecision,
  ApprovalScope,
  ToolApprovalRequest,
  ToolRisk
} from '@/lib/types'

interface ToolApprovalModalProps {
  request: ToolApprovalRequest
  onResolved: () => void
  /** Fluidity J5: fired only on allow so App.tsx can mark the (server, tool)
   *  pair as approved-once → subsequent requests route to the inline chip. */
  onAllowed?: (request: ToolApprovalRequest) => void
}

const RISK_LABEL: Record<ToolRisk, string> = {
  read: 'Read',
  write: 'Write',
  network: 'Network',
  destructive: 'Destructive',
  secret: 'Secret access',
  // The main process's highest-severity class (action-class CAP_RISKS).
  sandboxBypass: 'Escapes the sandbox'
}

const RISK_COLOR: Record<ToolRisk, string> = {
  read: 'text-[var(--text-muted)] border-[var(--panel-border)]',
  write: 'text-amber-300 border-amber-500/30',
  network: 'text-sky-300 border-sky-500/30',
  destructive: 'text-red-300 border-red-500/40',
  secret: 'text-fuchsia-300 border-fuchsia-500/40',
  // Rendered at the destructive tone or hotter — it outranks it.
  sandboxBypass: 'text-red-200 border-red-400/60'
}

export function ToolApprovalModal({ request, onResolved, onAllowed }: ToolApprovalModalProps) {
  const [scope, setScope] = useState<ApprovalScope>('once')

  // No auto-deny timer. The main process's askUser (permissions-store.ts)
  // deliberately has NO timeout — a pending approval stays pending until the
  // user answers or cancelPending/abort resolves it. A renderer-side 30s
  // auto-deny (removed here) silently refused tool calls the moment the user
  // stepped away and mis-attributed a machine timeout to a human in the audit
  // log (source:'modal', actorKind:'user'). The old comment claimed the main
  // process "also has a 30s deny timeout" — it does not; that made the defect
  // read as intentional parity when it was the opposite.

  const respond = (decision: ApprovalDecision, chosenScope: ApprovalScope) => {
    window.api?.tools.respondToApproval({
      callId: request.callId,
      decision,
      scope: chosenScope
    })
    if (decision === 'allow') onAllowed?.(request)
    onResolved()
  }

  const providerLabel =
    request.providerKind === 'mcp'
      ? request.serverId.charAt(0).toUpperCase() + request.serverId.slice(1)
      : request.providerKind === 'plugin'
      ? `Plugin: ${request.serverId}`
      : 'DUIN'

  const displayName = request.name.includes('__')
    ? request.name.split('__').slice(1).join('__')
    : request.name

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-6 shadow-2xl">
        <h2 className="mb-4 text-[20px] font-semibold text-[var(--text-primary)]">
          {t('Allow this action?')}
        </h2>

        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-[var(--accent-dim)] text-[12px] font-bold text-[var(--accent)]">
            {providerLabel.charAt(0)}
          </span>
          <span className="text-[16px] font-medium text-[var(--text-primary)]">{providerLabel}</span>
          <span className="text-[16px] text-[var(--text-muted)]">/</span>
          <span className="font-mono text-[16px] text-[var(--text-secondary)]">{displayName}</span>
        </div>

        {request.risks.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {request.risks.map((risk) => (
              <span
                key={risk}
                className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${RISK_COLOR[risk]}`}
              >
                {RISK_LABEL[risk]}
              </span>
            ))}
          </div>
        )}

        <div className="mb-4 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <pre className="max-h-48 overflow-auto text-[12px] font-mono text-[var(--text-secondary)]">
            {JSON.stringify(request.args, null, 2)}
          </pre>
        </div>

        <div className="mb-4 flex items-center gap-2 text-[12px]">
          <label className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <span>{t('Decision scope:')}</span>
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as ApprovalScope)}
              disabled={!request.conversationId && scope === 'conversation'}
            >
              <option value="once">{t('Just this once')}</option>
              <option value="conversation" disabled={!request.conversationId}>
                {t('This conversation')}
              </option>
              <option value="workspace">{t('This workspace')}</option>
              <option value="always">{t('Always (every workspace)')}</option>
            </Select>
          </label>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => respond('deny', scope)}
            className="flex-1 rounded-lg border border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-4 py-2 text-[16px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)]"
          >
            {t('Deny')}
          </button>
          <Button
            onClick={() => respond('allow', scope)}
            variant="primary"
            size="lg"
            className="flex-1"
          >
            {t('Allow')}
          </Button>
        </div>
      </div>
    </div>
  )
}
