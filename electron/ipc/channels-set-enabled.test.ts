// CALL-SITE coverage for `channels:setEnabled` (electron/ipc/settings.ts).
//
// THE GAP these tests close: channels-store.setChannelEnabled and
// gateway.restartChannel were both fully written and had ZERO callers anywhere —
// the channels IPC surface was list/pair/approve/revoke only. There was no way to
// turn a channel on except hand-editing userData/channels.json, and the live
// measurement (PLANNING/DUIN_LIVE_MEASUREMENTS_2026-08-03.md) records that the
// file DOES NOT EXIST on the install, i.e. even that workaround had never been
// exercised. So the enable path was not "rarely used", it was unreachable.
//
// These drive the REAL registered ipcMain handler: electron is mocked only for
// ipcMain (to capture handlers) and app.getPath; the channels.json the store
// writes is a REAL file in a REAL temp userData dir. The registry is faked so the
// test does not depend on whichever concrete adapters CHANNELS currently holds.
//
// POWER CONTROL: deleting the `channels:setEnabled` handler from settings.ts
// fails every test below (the handler is simply not registered). Registering it
// WITHOUT the restartChannel call fails 'restarts the adapter' — which is the
// half that makes the toggle take effect on a running app rather than only at the
// next launch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
    on: () => {}
  },
  app: { getPath: () => userDataDir, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' }
}))

// Fake registry — two channels, one configured and one not. Keeps the assertions
// about the ENABLE PATH rather than about whether a Telegram token happens to be
// on this machine.
vi.mock('../services/channels/index', () => {
  const mk = (id: string, label: string, configured: boolean) => ({
    id,
    label,
    isConfigured: () => configured,
    start: async () => {},
    stop: async () => {},
    send: async () => {},
    authorizeUser: async () => 'pending' as const
  })
  const list = [mk('telegram', 'Telegram', true), mk('discord', 'Discord', false)]
  return {
    listChannels: () => list,
    getChannel: (id: string) => list.find((c) => c.id === id)
  }
})

// Spy on the gateway rather than start real adapters: the handler's contract is
// "persist the flag AND ask the gateway to re-apply it", and starting a real
// long-lived socket in a unit test is neither possible nor the point.
const restartSpy = vi.fn(async (_id: string) => {})
vi.mock('../services/channels/gateway', () => ({
  restartChannel: (id: string) => restartSpy(id),
  startGateway: async () => {},
  stopGateway: async () => {}
}))

import { registerSettingsHandlers } from './settings'
import { setChannelsPath, isChannelEnabled } from '../services/channels/channels-store'

function channelsJson(): string {
  return join(userDataDir, 'channels.json')
}

beforeEach(() => {
  handlers.clear()
  restartSpy.mockClear()
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-chan-ud-'))
  writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({}), 'utf8')
  // Same call main.ts makes at boot — points the store at the temp userData dir.
  setChannelsPath(userDataDir)
  registerSettingsHandlers()
})

afterEach(() => {
  if (userDataDir && existsSync(userDataDir)) rmSync(userDataDir, { recursive: true, force: true })
})

describe('channels:setEnabled IPC handler (real call site)', () => {
  it('is registered — the operator has a way in that is not a text editor', () => {
    expect(handlers.has('channels:setEnabled')).toBe(true)
  })

  it('flips `enabled` in userData/channels.json', async () => {
    // The install's starting condition: no channels.json at all.
    expect(existsSync(channelsJson())).toBe(false)

    const res = await handlers.get('channels:setEnabled')!({}, 'telegram', true)
    expect(res.success).toBe(true)

    expect(existsSync(channelsJson())).toBe(true)
    const persisted = JSON.parse(readFileSync(channelsJson(), 'utf8'))
    expect(persisted.state.telegram.enabled).toBe(true)
    // …and the in-process predicate the gateway + external-action gate read.
    expect(isChannelEnabled('telegram')).toBe(true)
  })

  it('restarts that adapter so the toggle takes effect without a relaunch', async () => {
    await handlers.get('channels:setEnabled')!({}, 'telegram', true)
    expect(restartSpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).toHaveBeenCalledWith('telegram')
  })

  it('turns a channel back off, and restarts it so the live adapter stops', async () => {
    await handlers.get('channels:setEnabled')!({}, 'telegram', true)
    restartSpy.mockClear()

    const res = await handlers.get('channels:setEnabled')!({}, 'telegram', false)
    expect(res.success).toBe(true)
    expect(JSON.parse(readFileSync(channelsJson(), 'utf8')).state.telegram.enabled).toBe(false)
    expect(isChannelEnabled('telegram')).toBe(false)
    expect(restartSpy).toHaveBeenCalledWith('telegram')
  })

  // An unknown id must not silently write a phantom entry that the gateway will
  // never look at — setChannelEnabled already returns false for it; the handler
  // must surface that instead of reporting success.
  it('refuses an unknown channel id and does not restart anything', async () => {
    const res = await handlers.get('channels:setEnabled')!({}, 'nope', true)
    expect(res.success).toBe(false)
    expect(restartSpy).not.toHaveBeenCalled()
  })

  // Enabling an UNCONFIGURED channel is allowed (the operator may enable before
  // pasting a token) — the gateway is what refuses to start it. The toggle must
  // not pretend the channel is live.
  it('persists the enable for an unconfigured channel without claiming it started', async () => {
    const res = await handlers.get('channels:setEnabled')!({}, 'discord', true)
    expect(res.success).toBe(true)
    expect(JSON.parse(readFileSync(channelsJson(), 'utf8')).state.discord.enabled).toBe(true)
    // startedAt stays null — nothing started; restartChannel is still asked, and
    // it is the gateway's isConfigured() check that declines.
    expect(JSON.parse(readFileSync(channelsJson(), 'utf8')).state.discord.startedAt).toBe(null)
  })
})

describe('channels:list — the pane reads the same summaries the store already built', () => {
  it('reports enabled state per channel after a toggle', async () => {
    await handlers.get('channels:setEnabled')!({}, 'telegram', true)
    const res = await handlers.get('channels:list')!({})
    expect(res.success).toBe(true)
    const telegram = (res.data as { id: string; enabled: boolean; configured: boolean }[]).find(
      (c) => c.id === 'telegram'
    )
    expect(telegram).toBeTruthy()
    expect(telegram!.enabled).toBe(true)
    expect(telegram!.configured).toBe(true)
  })
})
