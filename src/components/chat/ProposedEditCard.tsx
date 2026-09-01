import { t } from '@/lib/i18n'
import { useMemo, useState } from 'react'
import type { ProposedEditProposal, ProposedEditStatus } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'

// Reviewable / reversible proposed-edit CARD. Reuses InlineApprovalChip's
// visual language (accent border + accent-dim fill for the actionable state)
// because a pending card IS an approval surface: the Apply-click is the
// approval, applied atomically through the workspace patch authority.
//
// The card is fed entirely by the persisted store (proposed-edits-store),
// so it survives reload / AFK. Actions are direct IPC — no chat re-prompt.
//
// A Delete-directive patch gets a one-tap confirm before Apply: a
// non-coder should not remove a file on a single mis-click.

interface ProposedEditCardProps {
  proposal: ProposedEditProposal
}

const STATUS_PILL: Record<ProposedEditStatus, { label: string; cls: string }> = {
  pending: {
    label: 'Awaiting your review',
    cls: 'text-[var(--accent)] border-[var(--accent)]/40'
  },
  accepted: {
    label: 'Applied',
    cls: 'text-[var(--success)] border-[var(--success)]/40'
  },
  rejected: {
    label: 'Discarded',
    cls: 'text-[var(--text-muted)] border-[var(--panel-border)]'
  },
  conflict: {
    label: 'Conflict — file changed',
    cls: 'text-amber-300 border-amber-500/40'
  },
  error: {
    label: 'Failed to apply',
    cls: 'text-[var(--error)] border-[var(--error)]/40'
  }
}

export function ProposedEditCard({ proposal }: ProposedEditCardProps) {
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftPatch, setDraftPatch] = useState(proposal.patch)

  const pending = proposal.status === 'pending'
  const pill = STATUS_PILL[proposal.status]
  const hasDelete = useMemo(
    () => /^\*\*\* Delete File: /m.test(proposal.patch),
    [proposal.patch]
  )

  const accept = async () => {
    if (hasDelete && !confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setConfirmingDelete(false)
    setBusy(true)
    try {
      const r = await window.api.proposedEdit.accept(proposal.id)
      if (!r.success) {
        toast.error(r.error || 'Could not apply the edit')
      } else {
        toast.success('Edit applied')
      }
    } catch {
      toast.error('Could not apply the edit')
    } finally {
      setBusy(false)
    }
  }

  const reject = async () => {
    setBusy(true)
    try {
      const r = await window.api.proposedEdit.reject(proposal.id)
      if (!r.success) toast.error(r.error || 'Could not discard the edit')
    } catch {
      toast.error('Could not discard the edit')
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    setBusy(true)
    try {
      const r = await window.api.proposedEdit.edit({
        id: proposal.id,
        patch: draftPatch,
        title: proposal.title,
        rationale: proposal.rationale
      })
      if (!r.success) {
        toast.error(r.error || 'Could not update the edit')
      } else {
        setEditing(false)
      }
    } catch {
      toast.error('Could not update the edit')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-proposed-edit={proposal.id}
      className={`mb-3 flex flex-col gap-2 rounded-lg border px-3 py-2.5 ${
        pending
          ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
          : 'border-[var(--panel-border)] bg-[var(--bg-secondary)]'
      }`}
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--text-primary)]">
          {proposal.title}
        </span>
        <span
          className={`flex-none rounded-full border px-1.5 py-0 text-[11px] font-medium uppercase tracking-wide ${pill.cls}`}
        >
          {pill.label}
        </span>
      </div>

      {proposal.rationale && (
        <p className="text-[12px] text-[var(--text-secondary)]">{proposal.rationale}</p>
      )}

      <div className="text-[11px] text-[var(--text-muted)]">
        {proposal.anchors.length} file{proposal.anchors.length === 1 ? '' : 's'}:{' '}
        <span className="font-mono">
          {proposal.anchors.map((a) => a.path).join(', ')}
        </span>
      </div>

      {/* The paths above are workspace-RELATIVE. Showing only them let a reviewer
          approve a patch bound to a workspace they had since switched away from,
          with nothing on the card to notice. Name the bound root. */}
      <div className="truncate text-[11px] text-[var(--text-muted)]" title={proposal.workspaceRoot ?? undefined}>
        in workspace{' '}
        <span className="font-mono">
          {proposal.workspaceRoot ?? 'unknown — re-propose to apply'}
        </span>
      </div>

      {editing ? (
        <textarea
          value={draftPatch}
          onChange={(e) => setDraftPatch(e.target.value)}
          spellCheck={false}
          className="max-h-[40vh] min-h-[8rem] w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      ) : (
        <DiffView patch={proposal.patch} />
      )}

      {(proposal.status === 'conflict' || proposal.status === 'error') && proposal.result && (
        <p className="text-[11px] text-[var(--text-muted)]">{proposal.result}</p>
      )}

      {pending && (
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button variant="primary" disabled={busy} onClick={saveEdit}>
                {t('Save changes')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setDraftPatch(proposal.patch)
                  setEditing(false)
                }}
              >
                {t('Cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" disabled={busy} onClick={accept}>
                {confirmingDelete ? 'Confirm — this deletes a file' : 'Apply'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={reject}>
                {t('Discard')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmingDelete(false)
                  setEditing(true)
                }}
              >
                {t('Edit')}
              </Button>
              <span className="ml-auto font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                {t('Proposed edit')}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Lightweight colorized render of a Codex-style patch envelope. Kept
 *  self-contained (no dependency on the main-process parser). */
function DiffView({ patch }: { patch: string }) {
  const lines = patch.replace(/\r\n/g, '\n').split('\n')
  return (
    <pre className="max-h-[45vh] overflow-auto rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 text-[11px] leading-relaxed">
      <code className="font-mono">
        {lines.map((line, i) => {
          const cls = lineClass(line)
          return (
            <div key={i} className={cls}>
              {line === '' ? ' ' : line}
            </div>
          )
        })}
      </code>
    </pre>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('*** ') || line.startsWith('@@')) {
    return 'text-[var(--text-muted)]'
  }
  if (line.startsWith('+')) return 'text-[var(--success)]'
  if (line.startsWith('-')) return 'text-[var(--error)]'
  return 'text-[var(--text-secondary)]'
}
