import { ipcMain } from 'electron'
import {
  acceptProposedEdit,
  editProposedEdit,
  ProposedEditConflictError,
  rejectProposedEdit
} from '../services/proposed-edit-flow'
import { getProposedEdit, listProposedEdits } from '../services/proposed-edit-store'
import { getActiveWorkspace } from '../services/workspace-state'
import { readSettings } from '../services/settings-helper'
import { emitChatEvent } from '../services/chat-events'
import { friendly } from '../services/guarded'

// Proposed-edit CARD IPC. The card's actions are DIRECT IPC (not a chat
// re-prompt): window.api.proposedEdit.accept / reject / edit / list. Every
// mutating handler re-emits `chat:edit-proposed` with the updated row so the
// card in any open chat view reflects the new status immediately, and the
// persisted row keeps the change durable across reload.
//
// Accept is the load-bearing one: it applies the proposal ATOMICALLY through
// the workspace patch authority, bypassing the tool-approval gate — the
// human's Apply-click IS the approval (they consented in-transcript). Drift
// between propose and accept fails closed as `conflict` with nothing written.

function vaultDir(): string | undefined {
  try {
    const d = readSettings().localBrainNotesDir
    return typeof d === 'string' && d.trim() !== '' ? d : undefined
  } catch {
    return undefined
  }
}

export function registerProposedEditHandlers(): void {
  ipcMain.handle('proposedEdit:list', async (_e, conversationId: string) => {
    try {
      if (!conversationId) return { success: false, error: 'conversationId required' }
      return { success: true, data: listProposedEdits(conversationId) }
    } catch (err) {
      return { success: false, error: friendly(err, 'proposedEdit:list failed') }
    }
  })

  ipcMain.handle('proposedEdit:get', async (_e, id: string) => {
    try {
      if (!id) return { success: false, error: 'id required' }
      return { success: true, data: getProposedEdit(id) }
    } catch (err) {
      return { success: false, error: friendly(err, 'proposedEdit:get failed') }
    }
  })

  ipcMain.handle('proposedEdit:accept', async (_e, id: string) => {
    try {
      if (!id) return { success: false, error: 'id required' }
      const workspaceRoot = getActiveWorkspace()
      const { proposal, applied } = await acceptProposedEdit({
        proposalId: id,
        workspaceRoot,
        vaultDir: vaultDir()
      })
      emitChatEvent('chat:edit-proposed', {
        conversationId: proposal.conversationId,
        proposal
      })
      return { success: true, data: { proposal, applied } }
    } catch (err) {
      // A conflict (or any accept failure) already persisted a terminal
      // status inside the flow; re-emit the fresh row so the card shows the
      // conflict/error state, then report the reason to the renderer.
      const latest = getProposedEdit(id)
      if (latest) {
        emitChatEvent('chat:edit-proposed', {
          conversationId: latest.conversationId,
          proposal: latest
        })
      }
      const conflict = err instanceof ProposedEditConflictError
      return {
        success: false,
        error: friendly(err, 'proposedEdit:accept failed'),
        conflict
      }
    }
  })

  ipcMain.handle('proposedEdit:reject', async (_e, id: string) => {
    try {
      if (!id) return { success: false, error: 'id required' }
      const proposal = rejectProposedEdit(id)
      emitChatEvent('chat:edit-proposed', {
        conversationId: proposal.conversationId,
        proposal
      })
      return { success: true, data: proposal }
    } catch (err) {
      return { success: false, error: friendly(err, 'proposedEdit:reject failed') }
    }
  })

  ipcMain.handle(
    'proposedEdit:edit',
    async (
      _e,
      payload: { id: string; patch: string; title?: string | null; rationale?: string | null }
    ) => {
      try {
        if (!payload?.id) return { success: false, error: 'id required' }
        if (!payload.patch || typeof payload.patch !== 'string') {
          return { success: false, error: 'patch required' }
        }
        const workspaceRoot = getActiveWorkspace()
        const proposal = editProposedEdit({
          proposalId: payload.id,
          patch: payload.patch,
          title: payload.title ?? null,
          rationale: payload.rationale ?? null,
          workspaceRoot
        })
        emitChatEvent('chat:edit-proposed', {
          conversationId: proposal.conversationId,
          proposal
        })
        return { success: true, data: proposal }
      } catch (err) {
        return { success: false, error: friendly(err, 'proposedEdit:edit failed') }
      }
    }
  )
}
