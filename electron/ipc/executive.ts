import { ipcMain } from 'electron'
import {
  approvePairing,
  createPrincipal,
  denyPairing,
  listPendingPairings,
  listPrincipals,
  reissueToken,
  setPrincipalStatus,
  updatePrincipalGrant,
  type ExecutivePlane,
  type GrantPatch,
  type PrincipalKind,
  type PrincipalStatus
} from '../services/executive-api/principal-store'
import { FLEET_SCOPE, parseGoalHoldActionId } from '../services/executive-api/exec-endpoint'
import { transitionGoal } from '../services/plan-goal-store'
import { resolveByActionId } from '../services/proactive/notices-store'
import { broadcastNoticesChanged } from './notices'
import { messageOf } from '../services/guarded'

// Operator surface for the Executive API membrane. Pairing APPROVAL is an
// operator-authority act, so it lives on the renderer IPC (the operator's own
// window), never on any HTTP route — an unauthenticated loopback route that
// approves principals would let any local process self-approve and the
// membrane would be theater. The foreign agent's side of the flow (request +
// one-time claim) lives on /exec/mcp; this file is the human's side.

const VALID_STATUS: readonly PrincipalStatus[] = ['active', 'paused', 'revoked']

export function registerExecutiveHandlers(): void {
  ipcMain.handle('executive:pairings:list', async () => {
    try {
      // Codes/tokens never ride: pending pairings hold no token yet, and the
      // store scrubs one-time tokens on claim; this is display data.
      return { success: true, data: { pairings: listPendingPairings() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(
    'executive:pairings:approve',
    async (_event, pairingId: unknown, grantPlanes: unknown) => {
      try {
        if (typeof pairingId !== 'string' || !pairingId) {
          return { success: false, error: 'pairingId required' }
        }
        const planes = Array.isArray(grantPlanes)
          ? (grantPlanes.filter((p): p is ExecutivePlane => typeof p === 'string') as ExecutivePlane[])
          : undefined
        const result = approvePairing(pairingId, planes ? { grantPlanes: planes } : undefined)
        if (!result.ok) {
          // The decision is moot (expired/denied/claimed meanwhile) — but the
          // operator DECIDED, so the owed notice must clear regardless or it
          // sits in "Needs you" forever (the agent just re-pairs).
          if (resolveByActionId(pairingId) > 0) broadcastNoticesChanged()
          return { success: false, error: result.reason }
        }
        if (resolveByActionId(pairingId) > 0) broadcastNoticesChanged()
        // The principal row is safe to return (hash only). The TOKEN is not
        // here — the agent claims it one-time over the mount.
        return { success: true, data: { principal: result.principal } }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle('executive:pairings:deny', async (_event, pairingId: unknown) => {
    try {
      if (typeof pairingId !== 'string' || !pairingId) {
        return { success: false, error: 'pairingId required' }
      }
      const ok = denyPairing(pairingId)
      // Resolve the owed notice either way: a deny on an already-expired
      // pairing is still the operator's answer to that request.
      if (resolveByActionId(pairingId) > 0) broadcastNoticesChanged()
      return ok ? { success: true, data: { denied: true } } : { success: false, error: 'not pending' }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('executive:principals:list', async () => {
    try {
      return { success: true, data: { principals: listPrincipals() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle(
    'executive:principals:setStatus',
    async (_event, principalId: unknown, status: unknown) => {
      try {
        if (typeof principalId !== 'string' || !principalId) {
          return { success: false, error: 'principalId required' }
        }
        if (!VALID_STATUS.includes(status as PrincipalStatus)) {
          return { success: false, error: 'status must be active | paused | revoked' }
        }
        const ok = setPrincipalStatus(principalId, status as PrincipalStatus)
        return ok ? { success: true, data: { status } } : { success: false, error: 'not found' }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  // Operator-initiated admission. The pairing flow waits for an agent to ask, which leaves the
  // Agents pane with no action on it when nothing is asking — the state an operator is in when
  // they have just decided to connect something.
  ipcMain.handle(
    'executive:principals:create',
    async (_event, input: unknown) => {
      try {
        if (typeof input !== 'object' || input === null) {
          return { success: false, error: 'name required' }
        }
        const i = input as Record<string, unknown>
        if (typeof i.name !== 'string' || !i.name.trim()) {
          return { success: false, error: 'name required' }
        }
        const planes = Array.isArray(i.planes)
          ? (i.planes.filter((p): p is ExecutivePlane => typeof p === 'string') as ExecutivePlane[])
          : undefined
        const result = createPrincipal({
          name: i.name,
          kind: typeof i.kind === 'string' ? (i.kind as PrincipalKind) : undefined,
          planes
        })
        if (!result.ok) return { success: false, error: result.reason }
        // The token rides back exactly once. Nothing persists it in plaintext, and no other
        // read surface can return it, so a caller that loses this response cannot recover the
        // credential — only reissue a new one.
        return { success: true, data: { principal: result.principal, token: result.token } }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  // The bounds a grant carries — read scope, write scope, hourly quota — had no operator
  // surface at all until now: they existed on the principal and were enforced on every call,
  // but the only way to SET one was to hand-edit executive-principals.json. A bound nobody
  // can reach is a bound nobody uses.
  ipcMain.handle(
    'executive:principals:updateGrant',
    async (_event, principalId: unknown, patch: unknown) => {
      try {
        if (typeof principalId !== 'string' || !principalId) {
          return { success: false, error: 'principalId required' }
        }
        if (typeof patch !== 'object' || patch === null) {
          return { success: false, error: 'patch required' }
        }
        const p = patch as Record<string, unknown>
        const clean: GrantPatch = {}
        // `undefined` = leave alone, `null` = reset to default. Both must survive the IPC
        // boundary distinctly, so each field is only copied when the caller actually sent it.
        if ('scope' in p) {
          if (p.scope !== null && !Array.isArray(p.scope)) {
            return { success: false, error: 'scope must be an array of paths, or null to clear' }
          }
          clean.scope = p.scope === null ? null : (p.scope as unknown[]).map((s) => String(s))
        }
        if ('writeScope' in p) {
          if (p.writeScope !== null && typeof p.writeScope !== 'string') {
            return { success: false, error: 'writeScope must be a string, or null to clear' }
          }
          clean.writeScope = p.writeScope as string | null
        }
        if ('quota' in p) {
          if (p.quota === null) {
            clean.quota = null
          } else {
            const q = p.quota as Record<string, unknown>
            if (typeof q?.callsPerHour !== 'number' || typeof q?.charsPerHour !== 'number') {
              return { success: false, error: 'quota needs numeric callsPerHour and charsPerHour, or null to clear' }
            }
            clean.quota = { callsPerHour: q.callsPerHour, charsPerHour: q.charsPerHour }
          }
        }
        const ok = updatePrincipalGrant(principalId, clean)
        return ok
          ? { success: true, data: { updated: true } }
          : { success: false, error: 'not found, revoked, or the quota was out of range' }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle(
    'executive:goals:decide',
    async (_event, actionId: unknown, approve: unknown, completion: unknown) => {
      try {
        if (typeof actionId !== 'string' || !actionId) {
          return { success: false, error: 'actionId required' }
        }
        const parsed = parseGoalHoldActionId(actionId)
        if (!parsed) return { success: false, error: 'not a fleet-goal hold actionId' }
        if (approve === true) {
          // The operator applies the parked terminal transition as the USER
          // actor — the authority the ANS gate always honors. Completing
          // requires text; default to an attributed operator approval.
          try {
            const goal = transitionGoal(FLEET_SCOPE, {
              goalId: parsed.goalId,
              action: parsed.action,
              actor: 'user',
              completion:
                parsed.action === 'complete'
                  ? (typeof completion === 'string' && completion.trim()) ||
                    'approved by operator (fleet proposal)'
                  : undefined,
              reason: 'operator decision on executive hold'
            })
            if (resolveByActionId(actionId) > 0) broadcastNoticesChanged()
            return {
              success: true,
              data: { applied: true, lifecycleStatus: goal?.lifecycleStatus ?? null }
            }
          } catch (err) {
            // The hold is moot (goal already terminal via the ordinary
            // surface). The operator still answered — resolve the owed row
            // instead of stranding it behind the error.
            if (resolveByActionId(actionId) > 0) broadcastNoticesChanged()
            return { success: false, error: messageOf(err) }
          }
        }
        // Decline: the goal stays as it is; the hold is resolved so the inbox
        // stops owing a decision. The agent observes via duin_goals.
        if (resolveByActionId(actionId) > 0) broadcastNoticesChanged()
        return { success: true, data: { applied: false } }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    }
  )

  ipcMain.handle('executive:principals:reissue', async (_event, principalId: unknown) => {
    try {
      if (typeof principalId !== 'string' || !principalId) {
        return { success: false, error: 'principalId required' }
      }
      const result = reissueToken(principalId)
      if (!result.ok) return { success: false, error: 'not found or revoked' }
      // Reissue is the ONE place a plaintext token crosses to the renderer:
      // the operator asked for it, on the operator's own window, to paste into
      // an agent's config. It is shown once and stored nowhere.
      return { success: true, data: { token: result.token } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}
