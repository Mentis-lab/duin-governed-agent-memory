import { ipcMain } from 'electron'
import {
  permissionsService,
  type ToolApprovalResponse
} from '../services/permissions-store'
import {
  clearPoliciesForConversation,
  clearPoliciesForScope,
  canonicalWorkspacePath,
  deletePolicy,
  isUsingMemoryFallback,
  listPolicies,
  upsertPolicy,
  type PolicyDecision,
  type PolicyScope,
  type PolicySubjectKind
} from '../services/permission-policies-store'
import { listPolicyUsage, type PolicyUsage } from '../services/event-log'
import { friendly, messageOf } from '../services/guarded'

const VALID_DECISIONS = new Set(['allow', 'deny'])
const VALID_SCOPES = new Set(['once', 'conversation', 'workspace', 'always'])
const VALID_POLICY_SCOPES = new Set<PolicyScope>(['conversation', 'workspace', 'global'])
const VALID_POLICY_SUBJECT_KINDS = new Set<PolicySubjectKind>(['tool', 'risk'])
const VALID_POLICY_DECISIONS = new Set<PolicyDecision>(['allow', 'deny'])

export function registerPermissionsHandlers(): void {
  ipcMain.handle('tools:respondToApproval', async (_event, response: ToolApprovalResponse) => {
    try {
      if (!response || typeof response.callId !== 'string') {
        return { success: false, error: 'callId is required' }
      }
      if (!VALID_DECISIONS.has(response.decision)) {
        return { success: false, error: `Invalid decision: ${response.decision}` }
      }
      if (!VALID_SCOPES.has(response.scope)) {
        return { success: false, error: `Invalid scope: ${response.scope}` }
      }
      permissionsService.respond(response)
      return { success: true, data: null }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'tools:respondToApproval failed')
      }
    }
  })

  // Backwards-compat — the previous renderer called window.api.mcp.approveToolCall
  // (boolean approved). Route it through the permissions service with scope=once.
  // This handler used to live in chat.ts; CLAUDE.md note about that is now stale.
  ipcMain.handle('mcp:approveToolCall', async (_event, callId: string, approved: boolean) => {
    try {
      if (typeof callId !== 'string') {
        return { success: false, error: 'callId is required' }
      }
      permissionsService.respondLegacy(callId, !!approved)
      return { success: true, data: null }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'mcp:approveToolCall failed')
      }
    }
  })

  ipcMain.handle('permissions:listGlobalPolicies', async () => {
    try {
      return { success: true, data: permissionsService.listGlobalPolicies() }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'permissions:listGlobalPolicies failed')
      }
    }
  })

  ipcMain.handle(
    'permissions:setGlobalPolicy',
    async (_event, toolId: string, decision: 'allow' | 'deny' | null) => {
      try {
        if (typeof toolId !== 'string' || !toolId) {
          return { success: false, error: 'toolId is required' }
        }
        if (decision !== null && !VALID_DECISIONS.has(decision)) {
          return { success: false, error: `Invalid decision: ${decision}` }
        }
        permissionsService.setGlobalPolicy(toolId, decision)
        return { success: true, data: null }
      } catch (err) {
        return {
          success: false,
          error: friendly(err, 'permissions:setGlobalPolicy failed')
        }
      }
    }
  )

  ipcMain.handle(
    'permissions:clearConversationPolicies',
    async (_event, conversationId: string) => {
      try {
        if (typeof conversationId !== 'string' || !conversationId) {
          return { success: false, error: 'conversationId is required' }
        }
        permissionsService.clearConversationPolicies(conversationId)
        return { success: true, data: null }
      } catch (err) {
        return {
          success: false,
          error: friendly(err, 'permissions:clearConversationPolicies failed')
        }
      }
    }
  )

  // Wider policy CRUD — used by PermissionsSettings to list, add, and clear
  // policies at any scope. The legacy global-only handlers above remain so
  // older renderer code keeps working.

  ipcMain.handle('permissions:listPolicies', async () => {
    try {
      // Usage travels WITH the policies, in one round trip, because the two are
      // read together or not at all — a grant list without "what has this done"
      // is the surface we already had.
      //
      // A usage read that throws must NOT take the policy list down with it: the
      // list is the safety-relevant half (it is what you revoke from), usage is
      // context. Degrading to "no usage shown" beats an error state that hides
      // every standing grant you have.
      let usage: PolicyUsage[] = []
      let usageError: string | null = null
      try {
        usage = listPolicyUsage()
      } catch (err) {
        usageError = friendly(err, 'usage unavailable')
        console.error('[permissions] policy usage read failed:', usageError)
      }
      return {
        success: true,
        data: {
          policies: listPolicies(),
          memoryFallback: isUsingMemoryFallback(),
          usage,
          usageError
        }
      }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'permissions:listPolicies failed')
      }
    }
  })

  ipcMain.handle(
    'permissions:addPolicy',
    async (
      _event,
      input: {
        scope: PolicyScope
        subjectKind: PolicySubjectKind
        subject: string
        decision: PolicyDecision
        conversationId?: string
        workspacePath?: string
      }
    ) => {
      try {
        if (!input || typeof input !== 'object') {
          return { success: false, error: 'input is required' }
        }
        if (!VALID_POLICY_SCOPES.has(input.scope)) {
          return { success: false, error: `Invalid scope: ${input.scope}` }
        }
        if (!VALID_POLICY_SUBJECT_KINDS.has(input.subjectKind)) {
          return { success: false, error: `Invalid subjectKind: ${input.subjectKind}` }
        }
        if (typeof input.subject !== 'string' || input.subject.trim() === '') {
          return { success: false, error: 'subject is required' }
        }
        if (!VALID_POLICY_DECISIONS.has(input.decision)) {
          return { success: false, error: `Invalid decision: ${input.decision}` }
        }
        if (input.scope === 'conversation' && !input.conversationId) {
          return {
            success: false,
            error: 'conversationId is required for conversation-scoped policies'
          }
        }
        if (input.scope === 'workspace') {
          const canon = canonicalWorkspacePath(input.workspacePath)
          if (!canon) {
            return {
              success: false,
              error: 'workspacePath is required for workspace-scoped policies'
            }
          }
        }
        const policy = upsertPolicy({
          scope: input.scope,
          subjectKind: input.subjectKind,
          subject: input.subject.trim(),
          decision: input.decision,
          conversationId: input.conversationId,
          workspacePath: input.workspacePath
        })
        return { success: true, data: policy }
      } catch (err) {
        return {
          success: false,
          error: friendly(err, 'permissions:addPolicy failed')
        }
      }
    }
  )

  ipcMain.handle('permissions:deletePolicy', async (_event, id: string) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'id is required' }
      }
      const removed = deletePolicy(id)
      return { success: true, data: { removed } }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'permissions:deletePolicy failed')
      }
    }
  })

  ipcMain.handle('permissions:clearScope', async (_event, scope: PolicyScope) => {
    try {
      if (!VALID_POLICY_SCOPES.has(scope)) {
        return { success: false, error: `Invalid scope: ${scope}` }
      }
      const removed = clearPoliciesForScope(scope)
      return { success: true, data: { removed } }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'permissions:clearScope failed')
      }
    }
  })

  ipcMain.handle(
    'permissions:clearConversation',
    async (_event, conversationId: string) => {
      try {
        if (typeof conversationId !== 'string' || !conversationId) {
          return { success: false, error: 'conversationId is required' }
        }
        const removed = clearPoliciesForConversation(conversationId)
        return { success: true, data: { removed } }
      } catch (err) {
        return {
          success: false,
          error: friendly(err, 'permissions:clearConversation failed')
        }
      }
    }
  )
}
