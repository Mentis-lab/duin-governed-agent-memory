import { t } from '@/lib/i18n'
import type { ReactElement } from 'react'
import { Button } from '@/components/ui/Button'
import type { SessionEntry } from '@/stores/sessions-store'

interface SessionDetailPaneProps {
  session: SessionEntry | null
  unreadCount: number
  onResume: (id: string) => void
  onDuplicate: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
}

function fullWhen(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function SessionDetailPane({
  session,
  unreadCount,
  onResume,
  onDuplicate,
  onArchive
}: SessionDetailPaneProps): ReactElement {
  if (!session) {
    return (
      <div className="border-t border-[var(--panel-border)] px-3 py-2 text-[11px] text-[var(--text-muted)]">
        {t('No session selected.')}
      </div>
    )
  }

  return (
    <div className="border-t border-[var(--panel-border)] bg-[var(--bg-primary)]/50 px-3 py-2" data-testid="session-detail-pane">
      <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">{session.title}</div>
      <div className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
        {session.messageCount} messages · last active {fullWhen(session.updatedAt)}
      </div>
      {unreadCount > 0 && (
        <div className="mt-1 rounded bg-[var(--accent-dim)] px-2 py-1 font-mono text-[11px] text-[var(--accent)]">
          {unreadCount} unread agent result{unreadCount === 1 ? '' : 's'}
        </div>
      )}
      <div className="mt-2 grid grid-cols-3 gap-1">
        <Button
          onClick={() => onResume(session.id)}
          variant="primary"
          size="sm"
        >
          {t('Resume')}
        </Button>
        <Button variant="secondary"
          onClick={() => onDuplicate(session.id)}
        >
          {t('Duplicate')}
        </Button>
        <Button variant="secondary"
          onClick={() => onArchive(session.id, !session.archived)}
        >
          {session.archived ? 'Restore' : 'Archive'}
        </Button>
      </div>
      {session.title.toLowerCase().includes('workflow') && (
        <Button variant="secondary" className="mt-1 w-full"
          onClick={() => onResume(session.id)}
        >
          {t('Resume workflow')}
        </Button>
      )}
    </div>
  )
}
