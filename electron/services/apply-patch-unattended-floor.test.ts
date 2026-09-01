import { describe, it, expect, vi } from 'vitest'

// WHY THIS FILE EXISTS
//
// The unattended CAP floor (governance/action-class.ts `capFloorForDescriptor`)
// is the gate every headless run passes through — loop-agent → headless-agent →
// tool-exec step 1b, and chat.ts's loop path. Its comments name `apply_patch` as
// THE example of a reversible write it allows "so the loop can still do work",
// and loop-agent.ts offers apply_patch as a brain loop's ONLY write tool.
//
// It did not. The REAL descriptor (apply-patch-tool-pack.ts) declares
// `risks: ['write', 'destructive']` + `requiresApproval: true` — because ONE
// envelope can Add, Update or Delete — so the floor refused it twice over on
// every unattended call, including an `*** Add File:` that cannot destroy
// anything. Every brain loop was silently read-only: the model's write was
// denied, the model stopped, and runHeadlessAgent still returned 'ok', so the
// Activity timeline and autonomous-log recorded a completed run that wrote
// nothing, every day, forever.
//
// The drift was invisible because the floor's own tests (loop-action-floor.test.ts)
// hand-wrote apply_patch as `risks: ['write'], requiresApproval: false` — the
// descriptor it SHOULD have had for a pure editor — so the suite proved an allow
// production never took. These tests therefore drive the REGISTERED descriptor
// pulled out of the real registry: if the pack's risk declaration and the floor
// ever disagree again, this fails.

// tool-registry pulls electron transitively in the node test env.
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-apply-patch-floor', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))

// Importing the pack registers apply_patch as a side effect.
import './apply-patch-tool-pack'
import { toolRegistry } from './tool-registry'
import { capFloorForDescriptor } from './governance/action-class'

const applyPatch = (): { name: string; risks: readonly string[]; requiresApproval?: boolean; mutates?: boolean } => {
  const d = toolRegistry.getById('apply_patch')
  if (!d) throw new Error('apply_patch is not registered — the loop has no write tool at all')
  return d
}

const envelope = (...lines: string[]): string =>
  ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')

// The exact shape loop-agent.ts's daily-digest prompt asks the model to emit.
const DAILY_DIGEST_PATCH = envelope(
  '*** Add File: DUIN/Planning/daily notes/2026-08-09.md',
  '+# 2026-08-09 — Daily digest',
  '+',
  '+## Done today',
  '+## Open / tomorrow',
  '+## Notes'
)

describe('unattended floor vs the REAL apply_patch descriptor', () => {
  it('the registered descriptor still declares destructive + requiresApproval (the attended gate is untouched)', () => {
    // Pins that this defect was NOT fixed by loosening the descriptor: chat.ts's
    // attended gate is `descriptorNeedsApproval` = requiresApproval || a gating
    // risk, and permission-policies-store's "deny destructive globally" matches
    // on the risk. Dropping either would silently un-gate every interactive
    // apply_patch call — a much larger hole than the one being closed.
    const d = applyPatch()
    expect(d.risks).toContain('destructive')
    expect(d.requiresApproval).toBe(true)
  })

  it('ALLOWS the add-only patch a brain loop writes its artifact with', () => {
    // Before the fix this returned {classId:'risk:destructive'} and the daily
    // notes folder stayed empty every day while the loop reported success.
    expect(capFloorForDescriptor(applyPatch(), { patch: DAILY_DIGEST_PATCH })).toBeNull()
  })

  it('ALLOWS an update-only patch (edits are reversible: the vault snapshots into .trash)', () => {
    const patch = envelope(
      '*** Update File: DUIN/Planning/daily notes/2026-08-09.md',
      '@@ ## Notes',
      '+Shipped the loop runner.'
    )
    expect(capFloorForDescriptor(applyPatch(), { patch })).toBeNull()
  })

  it('STILL FLOORS a patch that deletes a file — the branch the descriptor is declared for', () => {
    const patch = envelope('*** Delete File: DUIN/Planning/daily notes/2026-08-08.md')
    expect(capFloorForDescriptor(applyPatch(), { patch })).not.toBeNull()
  })

  it('STILL FLOORS a delete hidden after an innocent add in the same envelope', () => {
    const patch = envelope(
      '*** Add File: DUIN/Planning/daily notes/2026-08-09.md',
      '+# digest',
      '*** Delete File: DUIN/Planning/daily notes/2026-08-08.md'
    )
    expect(capFloorForDescriptor(applyPatch(), { patch })).not.toBeNull()
  })

  it('STILL FLOORS an edit to a foundational file — 1b defers to the classifier, it does not bypass it', () => {
    const patch = envelope(
      '*** Update File: .duin/config/settings.json',
      '@@',
      '+  "backgroundAutonomy": true'
    )
    expect(capFloorForDescriptor(applyPatch(), { patch })).not.toBeNull()
  })

  it('FAILS SAFE on a missing / non-string / empty patch arg', () => {
    expect(capFloorForDescriptor(applyPatch(), {})).not.toBeNull()
    expect(capFloorForDescriptor(applyPatch(), { patch: 42 })).not.toBeNull()
    expect(capFloorForDescriptor(applyPatch(), { patch: '   ' })).not.toBeNull()
  })

  it('does not leak the exemption to other destructive tools', () => {
    // The carve-out is keyed on the tool, not on "args look harmless": a
    // shell_command or a delete_file with an equally benign-looking arg is
    // refused exactly as before.
    const shell = { name: 'shell_command', risks: ['write', 'network'], mutates: true, requiresApproval: true }
    const del = { name: 'delete_file', risks: ['destructive', 'write'], mutates: true, requiresApproval: true }
    expect(capFloorForDescriptor(shell, { patch: DAILY_DIGEST_PATCH })).not.toBeNull()
    expect(capFloorForDescriptor(del, { patch: DAILY_DIGEST_PATCH })).not.toBeNull()
  })
})
