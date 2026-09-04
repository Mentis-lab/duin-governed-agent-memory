import { tf, t } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'

/**
 * The inline body for a read that FAILED. Pair it with <PanelState>'s required `error`
 * prop. It names the failure and offers a retry; it never looks like an empty list.
 */
export function SettingsLoadError({
  what,
  message,
  onRetry
}: {
  /** What was being read, lower case: "your API keys", "automations". */
  what: string
  message: string
  onRetry?: () => void
}): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-lg border border-[var(--warning)]/60 bg-[var(--bg-primary)] p-3"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{tf("Couldn't load {what}", { what })}</div>
        <p className="mt-1 break-words text-[12px] text-[var(--text-muted)]">{message}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t('Retry')}
        </Button>
      )}
    </div>
  )
}

/** The matching in-flight line. */
export function SettingsLoading({ what }: { what: string }): React.ReactElement {
  return <p className="text-[12px] text-[var(--text-muted)]">{tf('Loading {what}…', { what })}</p>
}
