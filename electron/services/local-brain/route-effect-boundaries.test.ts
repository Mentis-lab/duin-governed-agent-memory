import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import type { IncomingMessage, ServerResponse } from 'http'

const generateForecasts = vi.hoisted(() => vi.fn(() => [{ id: 'forecast-1' }]))
const logForecastsToLedger = vi.hoisted(() => vi.fn())
const runCalibration = vi.hoisted(() => vi.fn())
const inferDrivers = vi.hoisted(() => vi.fn(async () => ({ drivers: [] })))
const runLearningShadow = vi.hoisted(() => vi.fn(() => ({ staleCandidates: [] })))
const runLearningDeep = vi.hoisted(() => vi.fn(async () => ({ staleCandidates: [] })))
const listFutures = vi.hoisted(() => vi.fn(() => ({ tracks: [] })))

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

vi.mock('../brain/forecast-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/forecast-generator')>()),
  generateForecasts
}))
vi.mock('../brain/forecast-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/forecast-ledger')>()),
  logForecastsToLedger
}))
vi.mock('../brain/calibration-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/calibration-store')>()),
  runCalibration
}))
vi.mock('../brain/misc-routes-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/misc-routes-native')>()),
  inferDrivers
}))
vi.mock('../brain/learning-metabolism', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/learning-metabolism')>()),
  runLearningShadow,
  runLearningDeep
}))
vi.mock('../brain/futures-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../brain/futures-native')>()),
  listFutures
}))

import { setLocalBrainSettingsReader } from './server'
import { handleRequestNativeImpl } from './brain-native-routes'
import { handleRequestNativeImpl2 } from './brain-native-routes-2'

interface Reply {
  status: number
  body: unknown
}

function request(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string
): Promise<Reply> {
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
        const text = String(chunk ?? '')
        resolve({ status, body: text ? JSON.parse(text) : null })
        return res
      },
      setHeader: () => res,
      write: () => true
    } as unknown as ServerResponse
    handler(req, res)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setLocalBrainSettingsReader(() => ({ localBrainNotesDir: 'D:\\test-vault' }))
})

describe('local brain route effect boundaries', () => {
  it('keeps forecast GET pure and performs ledger/calibration effects only on POST refresh', async () => {
    await request(handleRequestNativeImpl2, 'GET', '/state/forecasts')
    expect(generateForecasts).toHaveBeenCalledTimes(1)
    expect(logForecastsToLedger).not.toHaveBeenCalled()
    expect(runCalibration).not.toHaveBeenCalled()

    await request(handleRequestNativeImpl2, 'POST', '/state/forecasts/refresh')
    expect(logForecastsToLedger).toHaveBeenCalledTimes(1)
    expect(runCalibration).toHaveBeenCalledTimes(1)
  })

  it('uses cache-only driver mode on GET and force mode only on POST refresh', async () => {
    await request(handleRequestNativeImpl, 'GET', '/state/drivers?force=1')
    expect(inferDrivers).toHaveBeenLastCalledWith(
      'D:\\test-vault',
      false,
      expect.objectContaining({ generate: expect.any(Function) })
    )

    await request(handleRequestNativeImpl, 'POST', '/state/drivers/refresh')
    expect(inferDrivers).toHaveBeenLastCalledWith(
      'D:\\test-vault',
      true,
      expect.objectContaining({ generate: expect.any(Function) })
    )
  })

  it('ignores deep query flags on GET and reserves model evaluation for POST', async () => {
    await request(handleRequestNativeImpl2, 'GET', '/state/learning-metabolism?deep=1')
    expect(runLearningShadow).toHaveBeenCalledTimes(1)
    expect(runLearningDeep).not.toHaveBeenCalled()

    await request(handleRequestNativeImpl2, 'POST', '/state/learning-metabolism/deep')
    expect(runLearningDeep).toHaveBeenCalledTimes(1)
  })

  it('returns a structured 500 when futures computation fails before headers are sent', async () => {
    listFutures.mockImplementationOnce(() => {
      throw new Error('futures unavailable')
    })

    await expect(request(handleRequestNativeImpl, 'GET', '/state/futures')).resolves.toEqual({
      status: 500,
      body: { error: 'futures unavailable' }
    })
  })
})
