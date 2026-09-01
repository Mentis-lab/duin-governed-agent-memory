// Fluidity J5: pure routing decision for tool-approval requests.
//
// The chip vs modal split:
//   - `destructive` risk → modal, always (the safety floor)
//   - sandbox-bypass escalation (`sandboxBypass` risk or `dangerous: true`)
//     → modal, always (the second safety floor — see below)
//   - first-time-this-session for the (server, tool) pair → modal (so the
//     user reads the full descriptor + args once before opting into the
//     lightweight chip)
//   - otherwise → chip
//
// `approvedSeen` is a renderer-session-level set of `${serverId}::${toolName}`
// keys mutated by App.tsx whenever a chip OR modal resolves with allow=true.
// Keeping it per-(server, tool) rather than per-server is conservative: a
// brand-new write-tier tool from a previously-approved server still gets
// the heavyweight confirmation the first time.

import type { ToolRisk } from './types'

export type ApprovalSurface = 'modal' | 'chip'

// The main process's risk vocabulary is a SUPERSET of the renderer's
// `ToolRisk`: electron/services/tool-registry.ts adds 'sandboxBypass', and
// electron/ipc/chat.ts appends it per-call for `shell_command` +
// `dangerously_disable_sandbox: true`. The renderer union never gained the
// member — which is precisely why this floor was missing for so long. Against
// a plain `ToolRisk[]`, writing `risks.includes('sandboxBypass')` is a *type
// error*, so the escalation tag was effectively invisible to every renderer
// path downstream of the IPC boundary even though it arrives on the wire.
export type ApprovalRisk = ToolRisk | 'sandboxBypass'

export interface ApprovalRoutingInput {
  serverId: string
  name: string
  risks: readonly ApprovalRisk[]
  /** Main-process escalation flag (permissions-store `requestApprovalDetailed`
   *  sets it for sandbox bypasses and fallback-provenance mutating calls). It
   *  means "every persisted 'always allow' was deliberately refused and the
   *  user is being re-asked" — so it must never resolve on a one-keystroke
   *  chip, which is exactly the consent the main process just declined to
   *  assume. Carried alongside the risk tag because the two triggers are
   *  equivalent at the permission gate but not always both present. */
  dangerous?: boolean
}

export interface ApprovalRoutingContext {
  approvedSeen: ReadonlySet<string>
}

export function approvalKey(serverId: string, name: string): string {
  return `${serverId}::${name}`
}

export function routeApproval(
  req: ApprovalRoutingInput,
  ctx: ApprovalRoutingContext
): ApprovalSurface {
  if (req.risks.includes('destructive')) return 'modal'
  // Sandbox-bypass floor. `approvedSeen` records that the user allowed the
  // SANDBOXED tool once; it says nothing about running the same tool outside
  // the sandbox. Without this line a prior `shell_command` approval demoted
  // the forced bypass re-prompt to the chip, where `1` allows and `3`
  // persists a workspace-scope grant for the whole tool id.
  if (req.dangerous === true || req.risks.includes('sandboxBypass')) return 'modal'
  if (!ctx.approvedSeen.has(approvalKey(req.serverId, req.name))) return 'modal'
  return 'chip'
}
