import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import {
  executeApplyPatch,
  parsePatch,
  resolvePathWithinWorkspace
} from './apply-patch-tool'
import {
  createProposedEdit,
  getProposedEdit,
  setProposedEditStatus,
  updateProposedEdit,
  type ProposedEditAnchor,
  type ProposedEditProposal
} from './proposed-edit-store'

// Proposed-edit CARD flow — propose / edit / accept / reject over the
// workspace patch authority. Adapted from lamprey's pr-patch-flow with the
// GitHub/PR/SHA machinery replaced by a DISK CONTENT-HASH freshness anchor.
//
// The design invariant carried over from upstream: a proposal NEVER touches
// disk until it is explicitly accepted, and acceptance re-checks freshness so
// a stale card (the file moved on under it while the human was AFK) fails
// closed with `status = 'conflict'` and writes nothing.

/** Raised when the affected files drifted between propose and accept. Carries
 *  the human-readable drift summary so the IPC layer can surface it on the
 *  card without re-deriving it. */
export class ProposedEditConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProposedEditConflictError'
  }
}

/**
 * Parse the patch and confine every target path to the workspace root. Throws
 * on a malformed envelope (via parsePatch) or a path that escapes / resolves
 * outside the root (via resolvePathWithinWorkspace). Returns the parsed
 * per-file targets so the caller can anchor them.
 */
export function validateProposedEditPaths(
  patch: string,
  workspaceRoot: string
): Array<{ path: string; abs: string }> {
  const ops = parsePatch(patch)
  return ops.map((op) => {
    const abs = resolvePathWithinWorkspace(workspaceRoot, op.path)
    if (abs === null) {
      throw new Error(`patch path escapes the workspace root or is invalid: ${op.path}`)
    }
    return { path: op.path, abs }
  })
}

function hashBytes(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

/**
 * Snapshot the freshness anchor for every file the patch touches: existence
 * + content hash at this instant. The relative `path` is stored verbatim so
 * accept can re-resolve against the accept-time workspace root.
 */
export function computeAnchors(
  patch: string,
  workspaceRoot: string
): ProposedEditAnchor[] {
  const targets = validateProposedEditPaths(patch, workspaceRoot)
  return targets.map(({ path, abs }) => {
    const existed = existsSync(abs)
    return { path, existed, sha256: existed ? hashBytes(abs) : null }
  })
}

/**
 * Normalise a workspace root for identity comparison. Absolute + separator-
 * normalised, trailing separator stripped, and case-folded on Windows/macOS
 * where the filesystem is case-insensitive — so `C:\Work` and `c:\work\` are
 * the same root, while `C:\Work` and `C:\Work2` are not.
 */
function normalizeRoot(root: string): string {
  const abs = resolve(root).replace(/[\\/]+$/, '')
  return process.platform === 'linux' ? abs : abs.toLowerCase()
}

/**
 * The proposal↔workspace binding check. Returns a human-readable reason when
 * the proposal may NOT be applied against `workspaceRoot`, or null when the
 * root is the one the human reviewed.
 *
 * WHY this cannot be left to the freshness anchors: the anchors hold
 * workspace-RELATIVE paths plus a content hash, which says nothing about which
 * root the path was hashed under. An Add-File anchor is { existed:false,
 * sha256:null } and therefore matches in ANY root where the path is absent; an
 * Update anchor matches in any root whose file happens to hold identical bytes
 * (shared boilerplate, a template, an empty file, .gitignore). In both cases
 * `detectDrift` reports "no drift" and the patch lands in a root the human
 * never reviewed. The active workspace can move under a pending card with no
 * user error at all — workspace-state.ts silently falls back to the vault the
 * moment the persisted folder stops passing `isDirectorySafe`, and the card is
 * explicitly designed to survive reload / AFK.
 *
 * CONSERVATIVE by choice: a proposal with NO recorded root (written by the v43
 * build, before the column existed) is REFUSED rather than assumed to belong to
 * whatever root is active now. An un-appliable card that says why is strictly
 * better than a patch written into the wrong tree; the human re-proposes.
 */
function detectWorkspaceMismatch(
  proposal: ProposedEditProposal,
  workspaceRoot: string
): string | null {
  if (!proposal.workspaceRoot) {
    return (
      'This edit was proposed before DUIN recorded which workspace a card belongs to, ' +
      'so it cannot be verified against the current workspace. Ask for the edit again ' +
      'to get a fresh card.'
    )
  }
  if (normalizeRoot(proposal.workspaceRoot) === normalizeRoot(workspaceRoot)) return null
  return (
    `This edit was reviewed against the workspace "${proposal.workspaceRoot}", but the ` +
    `active workspace is now "${resolve(workspaceRoot)}". The file paths on the card are ` +
    `relative, so applying it here would change different files than the ones you ` +
    `reviewed. Switch back to the original workspace, or ask for the edit again.`
  )
}

/**
 * Re-hash every anchor against current disk and return a drift summary, or
 * null when everything still matches. A file that appeared, disappeared, or
 * changed bytes since propose counts as drift.
 */
function detectDrift(
  anchors: ProposedEditAnchor[],
  workspaceRoot: string
): string | null {
  const drifted: string[] = []
  for (const anchor of anchors) {
    const abs = resolvePathWithinWorkspace(workspaceRoot, anchor.path)
    if (abs === null) {
      drifted.push(`${anchor.path} (no longer resolvable in the workspace)`)
      continue
    }
    const existsNow = existsSync(abs)
    if (existsNow !== anchor.existed) {
      drifted.push(
        existsNow
          ? `${anchor.path} (created since the edit was proposed)`
          : `${anchor.path} (deleted since the edit was proposed)`
      )
      continue
    }
    if (existsNow) {
      const now = hashBytes(abs)
      if (now !== anchor.sha256) {
        drifted.push(`${anchor.path} (changed on disk since the edit was proposed)`)
      }
    }
  }
  return drifted.length > 0
    ? `The workspace changed under this edit: ${drifted.join('; ')}. Re-review before applying.`
    : null
}

export function proposeEdit(input: {
  conversationId: string
  patch: string
  title?: string | null
  rationale?: string | null
  workspaceRoot: string
}): ProposedEditProposal {
  // parse + path-validate + anchor at PROPOSE time — a malformed or escaping
  // patch never becomes a card.
  const anchors = computeAnchors(input.patch, input.workspaceRoot)
  const title =
    typeof input.title === 'string' && input.title.trim() !== ''
      ? input.title.trim().slice(0, 200)
      : defaultTitle(anchors)
  return createProposedEdit({
    conversationId: input.conversationId,
    title,
    patch: input.patch,
    rationale: input.rationale ?? null,
    anchors,
    // BIND the card to the root the anchors were captured against. Accept
    // compares against this, not against whatever is active at accept time.
    workspaceRoot: resolve(input.workspaceRoot)
  })
}

export function editProposedEdit(input: {
  proposalId: string
  patch: string
  title?: string | null
  rationale?: string | null
  workspaceRoot: string
}): ProposedEditProposal {
  const proposal = getProposedEdit(input.proposalId)
  if (!proposal || proposal.status !== 'pending') {
    throw new Error('proposed edit is missing or no longer pending')
  }
  // Re-anchoring against a DIFFERENT root would silently re-home the card and
  // hand accept a matching binding — a trivial bypass of the check below. Refuse
  // instead; the card stays pending against its original root.
  const mismatch = detectWorkspaceMismatch(proposal, input.workspaceRoot)
  if (mismatch) throw new ProposedEditConflictError(mismatch)
  const anchors = computeAnchors(input.patch, input.workspaceRoot)
  return updateProposedEdit(input.proposalId, {
    patch: input.patch,
    title:
      typeof input.title === 'string' && input.title.trim() !== ''
        ? input.title.trim().slice(0, 200)
        : proposal.title,
    rationale: input.rationale ?? null,
    anchors
  })
}

export async function acceptProposedEdit(input: {
  proposalId: string
  workspaceRoot: string
  vaultDir?: string
}): Promise<{ proposal: ProposedEditProposal; applied: string }> {
  const proposal = getProposedEdit(input.proposalId)
  if (!proposal || proposal.status !== 'pending') {
    throw new Error('proposed edit is missing or no longer pending')
  }

  // WORKSPACE BINDING re-check, BEFORE the freshness anchors — the anchors are
  // relative and cannot distinguish roots, so this has to run first. Mismatch →
  // conflict, and NOTHING is written in either root.
  const mismatch = detectWorkspaceMismatch(proposal, input.workspaceRoot)
  if (mismatch) {
    setProposedEditStatus(proposal.id, 'conflict', mismatch)
    throw new ProposedEditConflictError(mismatch)
  }

  // Freshness re-check: drift → conflict, and NOTHING is written.
  const drift = detectDrift(proposal.anchors, input.workspaceRoot)
  if (drift) {
    setProposedEditStatus(proposal.id, 'conflict', drift)
    throw new ProposedEditConflictError(drift)
  }

  // Accept-click IS the approval (the human consented in-transcript), so this
  // calls executeApplyPatch directly — bypassing the tool-approval gate. The
  // accept path uses atomic: true so a mid-patch hunk failure rolls the whole
  // thing back and leaves the workspace exactly as it was.
  const applied = await executeApplyPatch({ patch: proposal.patch }, input.workspaceRoot, {
    vaultDir: input.vaultDir,
    atomic: true
  })
  if (applied.result.startsWith('Error:')) {
    setProposedEditStatus(proposal.id, 'error', applied.result)
    throw new Error(applied.result)
  }
  return {
    proposal: setProposedEditStatus(proposal.id, 'accepted', applied.result),
    applied: applied.result
  }
}

export function rejectProposedEdit(proposalId: string): ProposedEditProposal {
  return setProposedEditStatus(
    proposalId,
    'rejected',
    'Discarded without workspace changes'
  )
}

/** Fallback card title derived from the affected files when the model didn't
 *  supply one. Non-coders see "Edit kickoff-notes.md" rather than a UUID. */
function defaultTitle(anchors: ProposedEditAnchor[]): string {
  if (anchors.length === 0) return 'Proposed edit'
  const first = anchors[0].path.split(/[\\/]/).pop() || anchors[0].path
  return anchors.length === 1
    ? `Edit ${first}`
    : `Edit ${first} +${anchors.length - 1} more`
}
