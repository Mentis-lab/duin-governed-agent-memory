import { describe, expect, it } from 'vitest'
import { approvalKey, routeApproval } from './approval-routing'
import type { ApprovalRisk } from './approval-routing'

function req(serverId: string, name: string, risks: ApprovalRisk[] = ['read']) {
  return { serverId, name, risks }
}

describe('routeApproval', () => {
  it('returns "modal" when any risk is destructive', () => {
    const seen = new Set<string>([approvalKey('lamprey', 'shell_command')])
    expect(routeApproval(req('lamprey', 'shell_command', ['destructive']), { approvedSeen: seen }))
      .toBe('modal')
  })

  it('returns "modal" when the (server, tool) pair has never been approved this session', () => {
    expect(routeApproval(req('lamprey', 'read_file'), { approvedSeen: new Set() }))
      .toBe('modal')
  })

  it('returns "chip" for previously-approved non-destructive tools', () => {
    const seen = new Set<string>([approvalKey('lamprey', 'read_file')])
    expect(routeApproval(req('lamprey', 'read_file', ['read']), { approvedSeen: seen }))
      .toBe('chip')
  })

  it('chip routing is per-(server, tool), not per-server', () => {
    // Server has had one tool approved — a brand new tool from the same
    // server still goes to the modal so its descriptor is read once.
    const seen = new Set<string>([approvalKey('lamprey', 'read_file')])
    expect(routeApproval(req('lamprey', 'apply_patch', ['write']), { approvedSeen: seen }))
      .toBe('modal')
  })

  it('a write-risk previously-approved tool still gets a chip the second time', () => {
    const seen = new Set<string>([approvalKey('lamprey', 'apply_patch')])
    expect(routeApproval(req('lamprey', 'apply_patch', ['write']), { approvedSeen: seen }))
      .toBe('chip')
  })

  // S12 regression guard. shell_command's descriptor risks are
  // ['write','network'] — no 'destructive' — so the destructive floor never
  // covered a sandbox bypass. Once the user has approved a normal
  // shell_command this session, `approvedSeen` holds the key and the forced
  // bypass re-prompt used to land on the one-keystroke chip.
  it('returns "modal" for a sandboxBypass risk even when the tool was already approved', () => {
    const seen = new Set<string>([approvalKey('internal', 'shell_command')])
    expect(
      routeApproval(req('internal', 'shell_command', ['write', 'network', 'sandboxBypass']), {
        approvedSeen: seen
      })
    ).toBe('modal')
  })

  it('returns "modal" when the main process flags the request dangerous', () => {
    // The `dangerous: true` escalation arrives without a risk-tag change for
    // fallback-provenance mutating calls, so it has to floor on its own.
    const seen = new Set<string>([approvalKey('internal', 'shell_command')])
    expect(
      routeApproval(
        { ...req('internal', 'shell_command', ['write', 'network']), dangerous: true },
        { approvedSeen: seen }
      )
    ).toBe('modal')
  })

  it('a plain shell_command approval still chips on the second sandboxed call', () => {
    // Guard against over-flooring: the bypass floor must key off the
    // escalation signals, not off shell_command's ordinary risk set.
    const seen = new Set<string>([approvalKey('internal', 'shell_command')])
    expect(
      routeApproval(req('internal', 'shell_command', ['write', 'network']), { approvedSeen: seen })
    ).toBe('chip')
  })

  it('approvalKey is namespaced so two servers cannot collide', () => {
    expect(approvalKey('a', 'tool')).not.toBe(approvalKey('b', 'tool'))
  })
})
