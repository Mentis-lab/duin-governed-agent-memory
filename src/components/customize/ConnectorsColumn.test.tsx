import { describe, it, expect, vi } from 'vitest'

// The pane pulls in ipc-client (reads `window.api` at module scope) and this env is
// node-only. Only the pure status helpers are under test; the probe itself is covered
// by electron/services/capability-requires.test.ts on the other side of the wire.
vi.mock('@/lib/ipc-client', () => ({ query: vi.fn() }))

import { statusBadge, describeMissingRequirements } from './ConnectorsColumn'
import type { McpServerConfig, RequirementResult } from '@/lib/types'

// UNAVAILABLE IS NOT AN ERROR, and that distinction is the point of this file.
//
// Before requirements existed, a connector on a machine without Node failed the same
// way as one whose remote had gone down: three retry attempts, backoff, then a
// generic transport error carrying whatever the child wrote to stderr. Those want
// opposite responses from the operator — install something, versus try again — so
// they must not render the same.

type ServerOver = Partial<McpServerConfig> & { error?: string }

const server = (over: ServerOver = {}): McpServerConfig & { error?: string } => ({
  id: 'github',
  name: 'GitHub',
  transport: 'stdio',
  auth: 'none',
  enabled: true,
  status: 'disconnected',
  ...over
})

const missing = (label: string, detail?: string): RequirementResult => ({
  requirement: { kind: 'binary', name: label },
  satisfied: false,
  label,
  detail
})

describe('statusBadge', () => {
  it('shows connected and connecting unchanged', () => {
    expect(statusBadge(server({ status: 'connected' })).label).toBe('Connected')
    expect(statusBadge(server({ status: 'connecting' })).label).toBe('Connecting')
  })

  it('an error still reads as an error, carrying what the child said', () => {
    const badge = statusBadge(server({ status: 'error', error: 'Connection closed' }))
    expect(badge.label).toBe('Error')
    expect(badge.sub).toBe('Connection closed')
    expect(badge.dotClass).toContain('--error')
  })

  it('unavailable is NOT painted as an error — different problem, different action', () => {
    const badge = statusBadge(
      server({
        status: 'unavailable',
        missing: [missing('npx', 'Install Node.js (nodejs.org) — npx ships with it.')]
      })
    )
    expect(badge.label).toBe('Unavailable')
    expect(badge.dotClass).not.toContain('--error')
  })

  it('the unavailable sub-line carries the HINT, which is the only how-to-fix', () => {
    const badge = statusBadge(
      server({ status: 'unavailable', missing: [missing('npx', 'Install Node.js.')] })
    )
    expect(badge.sub).toContain('npx')
    expect(badge.sub).toContain('Install Node.js.')
  })

  // Without this, the operator enables a connector, waits out the retry ladder, and
  // is then told what could have been said before they clicked.
  it('a DISCONNECTED row with unmet requirements says "Needs setup" up front', () => {
    const badge = statusBadge(
      server({ status: 'disconnected', missing: [missing('GITHUB_TOKEN', 'Create a token.')] })
    )
    expect(badge.label).toBe('Needs setup')
    expect(badge.sub).toContain('GITHUB_TOKEN')
  })

  it('a plain disconnected row is untouched — no warning where nothing is wrong', () => {
    const badge = statusBadge(server({ status: 'disconnected' }))
    expect(badge.label).toBe('Disconnected')
    expect(badge.sub).toBeUndefined()
  })

  it('an empty missing array is the same as none — not a warning', () => {
    expect(statusBadge(server({ status: 'disconnected', missing: [] })).label).toBe('Disconnected')
  })

  it('falls back to the error text when unavailable arrives with no probe detail', () => {
    const badge = statusBadge(server({ status: 'unavailable', error: 'lark-cli not found' }))
    expect(badge.sub).toBe('lark-cli not found')
  })
})

describe('describeMissingRequirements', () => {
  it('joins every missing requirement, not just the first', () => {
    const line = describeMissingRequirements(
      server({ missing: [missing('npx', 'Install Node.'), missing('GITHUB_TOKEN', 'Make a token.')] })
    )
    expect(line).toContain('npx')
    expect(line).toContain('GITHUB_TOKEN')
  })

  it('is undefined when nothing is missing, so callers can skip the row', () => {
    expect(describeMissingRequirements(server())).toBeUndefined()
    expect(describeMissingRequirements(server({ missing: [] }))).toBeUndefined()
  })

  it('degrades to the bare label when an author gave no hint', () => {
    expect(describeMissingRequirements(server({ missing: [missing('git')] }))).toBe('git')
  })
})
