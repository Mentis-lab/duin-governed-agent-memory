import { ipcMain } from 'electron'
import {
  closeChangeContract,
  createChangeContract,
  getActiveChangeContract,
  getChangeContract,
  listChangeContracts,
  updateChangeContract,
  waiveChangeContract,
  type ListChangeContractsFilter
} from '../services/change-contract-store'
import { friendly, messageOf } from '../services/guarded'

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function asString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
}

function asPositiveInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : undefined
}

function coerceListFilter(raw: unknown): ListChangeContractsFilter {
  const r = asObject(raw)
  const filter: ListChangeContractsFilter = {}
  const conversationId = asString(r.conversationId)
  if (conversationId) filter.conversationId = conversationId
  const correlationId = asString(r.correlationId)
  if (correlationId) filter.correlationId = correlationId
  if (r.status === 'active' || r.status === 'closed' || r.status === 'waived') {
    filter.status = r.status
  } else if (Array.isArray(r.status)) {
    const statuses = r.status.filter(
      (status): status is 'active' | 'closed' | 'waived' =>
        status === 'active' || status === 'closed' || status === 'waived'
    )
    if (statuses.length > 0) filter.status = statuses
  }
  const limit = asPositiveInt(r.limit)
  if (limit !== undefined) filter.limit = limit
  return filter
}

export function registerContractHandlers(): void {
  ipcMain.handle('contracts:create', async (_event, input: unknown) => {
    try {
      return { success: true, data: createChangeContract(asObject(input) as any) }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:create failed') }
    }
  })

  ipcMain.handle('contracts:update', async (_event, id: unknown, input: unknown) => {
    try {
      const contractId = asString(id)
      if (!contractId) return { success: false, error: 'id is required' }
      return { success: true, data: updateChangeContract(contractId, asObject(input) as any) }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:update failed') }
    }
  })

  ipcMain.handle('contracts:close', async (_event, id: unknown) => {
    try {
      const contractId = asString(id)
      if (!contractId) return { success: false, error: 'id is required' }
      return { success: true, data: closeChangeContract(contractId) }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:close failed') }
    }
  })

  ipcMain.handle('contracts:waive', async (_event, input: unknown) => {
    try {
      const r = asObject(input)
      const id = asString(r.id)
      if (!id) return { success: false, error: 'id is required' }
      return {
        success: true,
        data: waiveChangeContract({
          id,
          reason: String(r.reason ?? ''),
          waivedBy: String(r.waivedBy ?? '')
        })
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:waive failed') }
    }
  })

  ipcMain.handle('contracts:get', async (_event, id: unknown) => {
    try {
      const contractId = asString(id)
      if (!contractId) return { success: false, error: 'id is required' }
      const contract = getChangeContract(contractId)
      if (!contract) return { success: false, error: 'not found' }
      return { success: true, data: contract }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:get failed') }
    }
  })

  ipcMain.handle('contracts:list', async (_event, filter: unknown) => {
    try {
      return { success: true, data: listChangeContracts(coerceListFilter(filter)) }
    } catch (err) {
      return { success: false, error: friendly(err, 'contracts:list failed') }
    }
  })

  ipcMain.handle(
    'contracts:active',
    async (_event, conversationId: unknown, correlationId?: unknown) => {
      try {
        const conv = asString(conversationId)
        if (!conv) return { success: false, error: 'conversationId is required' }
        return {
          success: true,
          data: getActiveChangeContract(conv, asString(correlationId))
        }
      } catch (err) {
        return { success: false, error: friendly(err, 'contracts:active failed') }
      }
    }
  )

  // UB-4 (Unburdening Phase, 2026-06-10) — the WC-5 `messages:setProofStatus`
  // channel died with the proof-gate banner. The contract-store CRUD above
  // stays (K2: store layers + historical rows survive).
}
