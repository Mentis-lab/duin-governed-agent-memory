import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// /debug/log-tail and /debug/cost (cohesion P0, lane C): token-gated by the shared
// control-plane policy, shaped for the Status panel, limits published on every reply.

const readRecentTurns = vi.hoisted(() =>
  vi.fn(async () => [
    {
      runId: 'r1',
      at: Date.now() - 60_000,
      model: 'deepseek-v4-flash',
      end: { type: 'TURN_END', costUsd: 0.25, meteredCalls: 2 },
      frames: 3,
      incomplete: false
    }
  ])
)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => '0.0.0-test'
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: async () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./agui-journal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agui-journal')>()),
  readRecentTurns
}))

import { setLocalBrainSettingsReader } from './server'
import { handleRequestNativeImpl2 } from './brain-native-routes-2'
import { admitControlPlaneRequest } from './control-plane-guard'
import { isControlledGetPath } from '../../shared/control-plane-policy'
import { __resetMainLogForTest, setMainLogDir, log } from '../main-log'
import { __forceMemoryFallback, __resetEventLog, recordEvent } from '../event-log'

interface Reply {
  status: number
  body: Record<string, unknown>
}

function request(method: string, url: string): Promise<Reply> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage
    req.method = method
    req.url = url
    req.headers = {}
    let status = 0
    const res = {
      writeHead: (code: number) => {
        status = code
        return res
      },
      end: (chunk?: string) => {
        resolve({ status, body: JSON.parse(String(chunk ?? '{}')) as Record<string, unknown> })
        return res
      },
      setHeader: () => res,
      write: () => true
    } as unknown as ServerResponse
    handleRequestNativeImpl2(req, res)
  })
}

let dir: string

beforeEach(() => {
  vi.clearAllMocks()
  setLocalBrainSettingsReader(() => ({ localBrainNotesDir: 'D:\\test-vault' }))
  __resetMainLogForTest()
  dir = mkdtempSync(join(tmpdir(), 'duin-observe-routes-'))
  setMainLogDir(dir)
  __resetEventLog()
  __forceMemoryFallback()
})

afterEach(() => {
  __resetMainLogForTest()
  rmSync(dir, { recursive: true, force: true })
})

describe('admission — both reads require the control (or exec) token, like the bench route', () => {
  it('lists both paths in the shared controlled-GET policy', () => {
    expect(isControlledGetPath('/debug/log-tail')).toBe(true)
    expect(isControlledGetPath('/debug/cost')).toBe(true)
    expect(isControlledGetPath('/debug/stalls')).toBe(false)
  })

  it('refuses a tokenless GET and admits one carrying x-duin-control', () => {
    const tokens = { control: 'ctl-token', exec: null }
    const bare = admitControlPlaneRequest(
      { method: 'GET', url: '/debug/cost?window=24h', headers: { host: '127.0.0.1:8799' } },
      tokens
    )
    expect(bare).toEqual({ ok: false, reason: 'control-token-required' })
    const withToken = admitControlPlaneRequest(
      { method: 'GET', url: '/debug/log-tail?n=50', headers: { host: '127.0.0.1:8799', 'x-duin-control': 'ctl-token' } },
      tokens
    )
    expect(withToken.ok).toBe(true)
    // A plain diagnostic read stays tokenless.
    expect(admitControlPlaneRequest({ method: 'GET', url: '/debug/stalls', headers: {} }, tokens).ok).toBe(true)
  })
})

describe('GET /debug/log-tail', () => {
  it('returns the last n lines with the sink limits', async () => {
    log.warn('first')
    log.error('second')
    const r = await request('GET', '/debug/log-tail?n=1')
    expect(r.status).toBe(200)
    const lines = r.body.lines as string[]
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ERROR second')
    expect(r.body.n).toBe(1)
    expect(r.body.limits).toMatchObject({ maxLines: 2000, path: join(dir, 'main.log'), written: 2, dropped: 0 })
  })

  it('defaults to 200 lines and caps a huge n', async () => {
    const d = await request('GET', '/debug/log-tail')
    expect(d.body.n).toBe(200)
    const big = await request('GET', '/debug/log-tail?n=999999')
    expect(big.body.n).toBe(2000)
  })
})

describe('GET /debug/cost', () => {
  it('rolls spine events and journal turns into one ledger with its limits published', async () => {
    recordEvent({
      type: 'model.request.completed',
      actorKind: 'model',
      payload: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        role: 'operator-learning',
        purpose: 'other',
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 1000 }
      }
    })
    const r = await request('GET', '/debug/cost?window=7d')
    expect(r.status).toBe(200)
    expect(readRecentTurns).toHaveBeenCalledWith(500)
    expect(r.body.window).toBe('7d')
    expect((r.body.sources as { name: string }[]).map((s) => s.name)).toEqual(['events', 'journal'])
    const byRole = r.body.byRole as Record<string, { calls: number; costUsd: number }>
    expect(byRole.extraction.calls).toBe(1)
    expect(byRole.chat.costUsd).toBeCloseTo(0.25, 6)
    const byProvider = r.body.byProvider as Record<string, { calls: number }>
    expect(byProvider.deepseek.calls).toBe(3)
    expect(typeof r.body.estimated).toBe('boolean')
    expect((r.body.since as number) < (r.body.until as number)).toBe(true)
    expect(r.body.limits).toMatchObject({ truncated: false, journalTurns: 1, journalTurnsInWindow: 1 })
    expect(typeof (r.body.limits as { pricing: string }).pricing).toBe('string')
  })

  it('defaults an unknown window to 24h', async () => {
    const r = await request('GET', '/debug/cost?window=1y')
    expect(r.body.window).toBe('24h')
  })
})
