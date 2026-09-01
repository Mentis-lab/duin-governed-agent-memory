// Backlog finding 18. CRON_ALLOWED_TOOLS is the capability allow-list handed to every
// scheduled automation. It listed `send_message`, which could never once run: the tool
// carries the `network` risk, `network` is in action-class.ts's CAP_RISKS, and tool-exec
// step 1b's unattended CAP floor sits BELOW the capability layer and overrides it. So the
// most natural automation anyone would author — "check X, message me if Y" — called
// send_message on every attempt, was refused every time, and `automation.completed` still
// fired, so nothing surfaced the failure anywhere.
//
// Same shape as apply-patch-unattended-floor.test.ts: drive the REGISTERED descriptors
// against the REAL floor, so an allow-list that drifts out of agreement with the layer
// beneath it fails here instead of silently at 3am.

import { describe, it, expect, vi } from 'vitest'

// tool-registry pulls electron transitively in the node test env.
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-cron-allowlist-floor', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./settings-helper', () => ({ readSettings: () => ({}) }))

// Importing the packs registers their tools as a side effect.
import './vault-read-tool-pack'
import './comms-tool-pack'
import { toolRegistry } from './tool-registry'
import { capFloorForDescriptor } from './governance/action-class'
import { CRON_ALLOWED_TOOLS } from './automations-runner'

type Desc = { name: string; risks?: readonly string[]; requiresApproval?: boolean; mutates?: boolean }

const descriptorFor = (name: string): Desc | undefined =>
  toolRegistry.getById(name) as Desc | undefined

describe('cron allow-list vs the unattended CAP floor', () => {
  it('offers the model nothing the floor beneath it will refuse', () => {
    const offered = CRON_ALLOWED_TOOLS.map((n) => ({ name: n, d: descriptorFor(n) }))
    // If a tool is not registered the allow-list is stale in a different way; say which.
    const missing = offered.filter((o) => !o.d).map((o) => o.name)
    expect(missing, `allow-listed but not registered: ${missing.join(', ')}`).toEqual([])

    const floored = offered
      .filter((o) => o.d && capFloorForDescriptor(o.d as never, {}) !== null)
      .map((o) => o.name)
    expect(
      floored,
      `allow-listed but CAP-floored on every unattended run: ${floored.join(', ')}`
    ).toEqual([])
  })

  it('still refuses send_message unattended — the reason it left the list', () => {
    // Not asserting the list lacks it (that would be a tautology). Asserting the FLOOR
    // is why: if this ever stops being floored, re-adding it becomes a real option.
    const d = descriptorFor('send_message')
    expect(d, 'send_message should be a registered tool').toBeDefined()
    expect(capFloorForDescriptor(d as never, {})).not.toBeNull()
  })
})
