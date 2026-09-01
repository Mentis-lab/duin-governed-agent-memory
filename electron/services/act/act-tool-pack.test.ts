import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// act-tool-pack → registerExternalAction → tool-registry pulls electron transitively.
// Mock electron (node test env) so the registration side effects don't touch a real app.
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-act-tool-pack', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
// The connector resolves a live bearer token through the shared Google freshness gate;
// stub it so the end-to-end handler test needs no keychain and no network.
vi.mock('../google-auth', () => ({ ensureFreshGoogleToken: async () => 'TEST_TOKEN' }))

// Importing the pack registers every ACT external action as a side effect.
import './act-tool-pack'
import { externalActionTier } from './action-tier'
import { decideAguiGate } from '../local-brain/agui-approval'
import { toolRegistry } from '../tool-registry'
import { setActExecContext, clearActExecContext } from './external-action'
import { validateToolArguments } from '../tool-schema-validator'

describe('act-tool-pack — consequence-tier assignment per action', () => {
  it('classifies calendar create/update as write-reversible and delete as irreversible', () => {
    expect(externalActionTier('calendar_create_event')).toBe('write-reversible')
    expect(externalActionTier('calendar_update_event')).toBe('write-reversible')
    expect(externalActionTier('calendar_delete_event')).toBe('irreversible')
  })
  it('classifies drive upload + feishu writes as write-reversible', () => {
    expect(externalActionTier('drive_upload_file')).toBe('write-reversible')
    expect(externalActionTier('feishu_create_doc')).toBe('write-reversible')
    expect(externalActionTier('feishu_base_add_record')).toBe('write-reversible')
  })
})

// The SECURITY crux: a de-privileged inbound turn (execOk:false) must be DENIED any of
// these external writes at the dispatch gate, BEFORE the handler is reached. The gate
// recognizes a registered external action via its tier registry (aguiTier →
// externalActionTier), so these are gated tools even though they aren't in the fixed
// AGUI_GATED_TOOLS set.

function gateInput(toolName: string, execOk: boolean) {
  return {
    toolName,
    execOk,
    screen: null,
    posture: 'trusted-afk' as const,
    policy: null,
    hasWindow: false
  }
}

describe('act-tool-pack — de-privileged turn is denied every external write', () => {
  for (const tool of [
    'calendar_create_event',
    'calendar_update_event',
    'calendar_delete_event',
    'drive_upload_file',
    'feishu_create_doc',
    'feishu_base_add_record'
  ]) {
    it(`DENIES ${tool} on a de-privileged (execToken:null) turn at the exec-token rule`, () => {
      const v = decideAguiGate(gateInput(tool, false))
      expect(v.kind).toBe('deny')
      expect(v.kind === 'deny' && v.source).toBe('exec-token')
    })
  }

  it('a privileged turn is allowed a write-reversible action (soft gate) but the irreversible delete still gates through approval', () => {
    // Write-reversible on a privileged trusted-afk turn → allowed.
    expect(decideAguiGate(gateInput('calendar_create_event', true)).kind).toBe('allow')
    // The irreversible delete is a gated tool; on a privileged turn it is still not a
    // free pass — its descriptor requiresApproval:true routes it through the approval
    // service, and runExternalAction demands an explicit operator approve before the
    // handler fires (covered exhaustively in external-action.test.ts).
    const del = decideAguiGate(gateInput('calendar_delete_event', true))
    expect(del.tier).toBe('external-irreversible')
  })
})

// ──────────────────── REGRESSION: null must not erase user content ────────────────────
// The defect: `{eventId, start, description: null}` — a very common LLM spelling of
// "leave the description unchanged" — was accepted by the shared validator (null ==
// missing, tool-schema-validator.ts:210) but the handler's `args.description !== undefined`
// was TRUE and `str(null)` returned '', so the outbound PATCH carried `"description":""`
// and Google overwrote the user's hand-written agenda. The connector reported plain
// success ("Updated calendar event <id>") and nothing snapshotted the prior value.
//
// These drive the REAL registered handler through the REAL registry + gate wrapper,
// capturing the outbound HTTP body. Only electron / google-auth / fetch are stubbed.

const CTX = { conversationId: 'test-conv' } as never

function stubFetch(getBody: Record<string, unknown> = { id: 'evt1', description: 'AGENDA' }) {
  const calls: { url: string; method: string; body?: string }[] = []
  const fn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body })
    const data = method === 'GET' ? getBody : { id: 'evt1', htmlLink: 'https://cal/evt1' }
    return { ok: true, status: 200, text: async () => JSON.stringify(data), json: async () => data }
  })
  ;(globalThis as { fetch: unknown }).fetch = fn
  return calls
}

describe('calendar_update_event handler — a null field means UNCHANGED, not erase', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => setActExecContext(true)) // privileged turn: write-reversible is allowed
  afterEach(() => {
    clearActExecContext()
    ;(globalThis as { fetch: unknown }).fetch = realFetch
    vi.restoreAllMocks()
  })

  // Guard the premise: the validator really does bless a null and really does keep it.
  it('the shared validator passes {description:null} through with the null intact', () => {
    const schema = toolRegistry.getDescriptors().find((d) => d.name === 'calendar_update_event')!.inputSchema
    const v = validateToolArguments('calendar_update_event', { eventId: 'evt1', description: null }, schema)
    expect(v.valid).toBe(true)
    expect(v.valid && v.parsed.description).toBeNull()
  })

  it('does NOT send a description key when the model passes description:null on a reschedule', async () => {
    const calls = stubFetch()
    const r = (await toolRegistry.executeNative(
      'calendar_update_event',
      { eventId: 'evt1', start: '2026-07-21T16:00:00+08:00', description: null },
      CTX
    )) as { result: string; status: string }
    expect(r.status).toBe('done')
    const patch = calls.find((c) => c.method === 'PATCH')!
    const body = JSON.parse(patch.body!)
    expect('description' in body).toBe(false)
    expect(body).toEqual({ start: { dateTime: '2026-07-21T16:00:00+08:00' } })
    // A null field is "unchanged", so nothing is read either — no clear to snapshot.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })

  it.each(['summary', 'location'] as const)(
    'does NOT send a %s key when that field is null (blanking the title / de-inviting is unrecoverable)',
    async (field) => {
      const calls = stubFetch()
      await toolRegistry.executeNative(
        'calendar_update_event',
        { eventId: 'evt1', start: '2026-07-21T16:00:00+08:00', [field]: null },
        CTX
      )
      const body = JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!)
      expect(field in body).toBe(false)
    }
  )

  // The contrast case: an EXPLICIT empty string is still honoured as a deliberate clear
  // (the calendar may legitimately be edited) — but it is snapshotted first and the
  // result stops claiming a bare success.
  it('still honours an explicit "" clear, but reads the prior text first and reports it', async () => {
    const calls = stubFetch({ id: 'evt1', description: 'Q3 agenda: 1) budget 2) hiring' })
    const r = (await toolRegistry.executeNative(
      'calendar_update_event',
      { eventId: 'evt1', description: '' },
      CTX
    )) as { result: string; status: string }
    expect(r.status).toBe('done')
    expect(calls[0].method).toBe('GET') // snapshot BEFORE the destructive write
    expect(JSON.parse(calls[1].body!)).toEqual({ description: '' })
    expect(r.result).toContain('Q3 agenda') // what changed + where the old text went
    expect(r.result).toContain('CLEARED')
  })
})
