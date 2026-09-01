import { toolRegistry } from './tool-registry'
import { proposeEdit } from './proposed-edit-flow'
import { getActiveWorkspace } from './workspace-state'
import { emitChatEvent } from './chat-events'

// propose_edit — the reviewable / reversible proposed-edit CARD tool.
//
// This is the NON-CODER edit surface. Where `apply_patch` writes to the
// workspace immediately (behind the approval gate), `propose_edit` writes
// NOTHING: it parses + path-validates the patch, snapshots a disk
// content-hash freshness anchor, and persists a pending card. The human
// then clicks Apply / Discard / Edit on the card (direct IPC), and only an
// explicit Apply-click runs the patch — atomically — through the workspace
// patch authority. The Apply-click IS the approval.
//
// Descriptor flags mirror create_document's UX-shim shape:
//   transcriptHidden: true   — the card IS the visible surface; a tool-call
//                              row would double-render.
//   mutates: false           — proposing touches no workspace state, so the
//                              plan-mode gate never blocks a proposal.
//   requiresApproval: false  — nothing is applied here; approval happens at
//                              the card's Apply-click, not at propose time.
//   risks: []                — a proposal is inert until accepted.
//
// Boundary vs create_document: create_document emits a NEW standalone
// deliverable the user keeps; propose_edit proposes an EDIT to an existing
// workspace file. See the descriptions of both tools.

toolRegistry.registerNative(
  {
    id: 'propose_edit',
    name: 'propose_edit',
    title: 'Propose edit',
    description:
      'Propose a reviewable, reversible EDIT to one or more EXISTING workspace files, WITHOUT applying it. Use this instead of apply_patch when the user should see and approve the change first — the default for non-coders. The patch is parsed and path-checked now, then shown to the user as a card with Apply / Discard / Edit buttons; nothing is written until the user clicks Apply, which applies the whole patch atomically (all-or-nothing). Boundary: use create_document to hand the user a NEW standalone deliverable (a fresh file they keep); use propose_edit to change files that already exist in the workspace. The `patch` uses the same envelope as apply_patch ("*** Begin Patch" … "*** End Patch" with Add/Update/Delete File blocks). Optionally set a short `title` and `rationale` so the card explains the change in plain language.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description:
            'The full patch envelope including "*** Begin Patch" header and "*** End Patch" footer. Each file block is "*** Add File: <path>" (body lines start with "+"), "*** Update File: <path>" (optional "@@ <context>", then "+"/"-"/" " body lines per hunk), or "*** Delete File: <path>" (no body). All paths must resolve inside the workspace root.'
        },
        title: {
          type: 'string',
          description:
            'Optional short, plain-language label for the card (e.g. "Fix the typo in the kickoff notes"). Defaults to the affected filename when omitted.'
        },
        rationale: {
          type: 'string',
          description:
            'Optional one-or-two-sentence explanation, in plain language, of what the edit does and why — shown on the card so the user can decide without reading the diff.'
        }
      },
      required: ['patch'],
      additionalProperties: false
    },
    risks: [],
    requiresApproval: false,
    enabled: true,
    mutates: false,
    transcriptHidden: true
  },
  async (args, ctx) => {
    if (!ctx.conversationId) {
      throw new Error('propose_edit requires an active conversation')
    }
    const patch = typeof args.patch === 'string' ? args.patch : ''
    if (!patch.trim()) {
      throw new Error('propose_edit requires a non-empty `patch`')
    }
    const workspaceRoot = ctx.workspacePath ?? getActiveWorkspace()
    // proposeEdit parses + path-validates + anchors; a malformed or escaping
    // patch throws here and never becomes a card.
    const proposal = proposeEdit({
      conversationId: ctx.conversationId,
      patch,
      title: typeof args.title === 'string' ? args.title : null,
      rationale: typeof args.rationale === 'string' ? args.rationale : null,
      workspaceRoot
    })
    emitChatEvent('chat:edit-proposed', {
      conversationId: ctx.conversationId,
      proposal
    })
    const fileCount = proposal.anchors.length
    return `Proposed edit "${proposal.title}" (${fileCount} file${fileCount === 1 ? '' : 's'}) is waiting for the user on a card with Apply / Discard / Edit. Nothing has been written yet. Do NOT paste the diff into your visible reply — the user already sees the card. Do not call apply_patch for the same change.`
  }
)
