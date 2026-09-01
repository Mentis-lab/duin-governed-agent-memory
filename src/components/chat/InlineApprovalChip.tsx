import { t } from '@/lib/i18n'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/Button'
import type {
  ApprovalDecision,
  ApprovalScope,
  ToolApprovalRequest,
  ToolRisk
} from '@/lib/types'

// Fluidity J5: lightweight in-transcript approval row. App.tsx routes
// non-destructive, previously-approved (server, tool) pairs here instead
// of opening the modal. Keyboard:
//   1 → Approve (scope: once)
//   2 → Deny (scope: once)
//   3 → Always allow this tool (scope: workspace)
//   Esc → Deny (same as 2)
// The first chip in the list auto-focuses on mount so the keystrokes
// land without a click.

interface InlineApprovalChipProps {
  request: ToolApprovalRequest
  autoFocus: boolean
  onResolved: () => void
}

const RISK_COLOR: Record<ToolRisk, string> = {
  read: 'text-[var(--text-muted)] border-[var(--panel-border)]',
  write: 'text-amber-300 border-amber-500/30',
  network: 'text-sky-300 border-sky-500/30',
  destructive: 'text-red-300 border-red-500/40',
  secret: 'text-fuchsia-300 border-fuchsia-500/40',
  sandboxBypass: 'text-red-200 border-red-400/60'
}

function shortArgPreview(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length === 0) return ''
  const first = keys[0]
  const value = args[first]
  const valStr =
    typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value)
  const compact = `${first}=${valStr}`
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact
}

export function InlineApprovalChip({
  request,
  autoFocus,
  onResolved
}: InlineApprovalChipProps) {
  const rootRef = useRef<HTMLDivElement>(null)

  const respond = (decision: ApprovalDecision, scope: ApprovalScope) => {
    window.api?.tools.respondToApproval({
      callId: request.callId,
      decision,
      scope
    })
    onResolved()
  }

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!autoFocus) return
    const handler = (e: KeyboardEvent) => {
      // Don't steal keystrokes from inputs the user is typing into.
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
          // Allow when the focused element is *us* — chip root has tabIndex.
          if (target !== rootRef.current) return
        }
      }
      if (e.key === '1') {
        e.preventDefault()
        respond('allow', 'once')
      } else if (e.key === '2' || e.key === 'Escape') {
        e.preventDefault()
        respond('deny', 'once')
      } else if (e.key === '3') {
        e.preventDefault()
        respond('allow', 'workspace')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [autoFocus, request.callId])

  const providerLabel =
    request.providerKind === 'mcp'
      ? request.serverId.charAt(0).toUpperCase() + request.serverId.slice(1)
      : request.providerKind === 'plugin'
      ? `Plugin: ${request.serverId}`
      : 'DUIN'

  const displayName = request.name.includes('__')
    ? request.name.split('__').slice(1).join('__')
    : request.name

  const argPreview = shortArgPreview(request.args)

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-inline-approval={request.callId}
      className="mb-3 flex flex-col gap-2 rounded-lg border border-[var(--accent)] bg-[var(--accent-dim)] px-3 py-2 outline-none transition-colors focus:ring-1 focus:ring-[var(--accent)]"
    >
      <div className="flex items-baseline gap-2 text-[12px]">
        <span className="font-medium text-[var(--text-primary)]">
          {providerLabel}
        </span>
        <span className="text-[var(--text-muted)]">/</span>
        <span className="font-mono text-[var(--text-secondary)]">{displayName}</span>
        {request.risks.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {request.risks.map((risk) => (
              <span
                key={risk}
                className={`rounded-full border px-1.5 py-0 text-[11px] font-medium uppercase tracking-wide ${RISK_COLOR[risk]}`}
              >
                {risk}
              </span>
            ))}
          </div>
        )}
      </div>
      {argPreview && (
        <code className="block truncate font-mono text-[11px] text-[var(--text-muted)]">
          {argPreview}
        </code>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary"
          onClick={() => respond('allow', 'once')}
        >
          <span className="font-mono">1</span> {t('Approve')}
        </Button>
        <Button variant="secondary"
          onClick={() => respond('deny', 'once')}
        >
          <span className="font-mono">2</span> {t('Deny')}
        </Button>
        <Button variant="secondary"
          onClick={() => respond('allow', 'workspace')}
          title={t('Always allow this tool in this workspace')}
        >
          <span className="font-mono">3</span> {t('Always')}
        </Button>
        <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Inline approval')}
        </span>
      </div>
    </div>
  )
}
