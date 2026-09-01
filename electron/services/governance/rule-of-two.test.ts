import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  ruleOfTwoCheck,
  noteExecutedTool,
  legsOf,
  clearRuleOfTwoProfile,
  ruleOfTwoProfile,
  __testing
} from './rule-of-two'

const CID = 'conv-rot-test'
const mcpRead = { name: 'feishu__list_messages', providerKind: 'mcp' as const, risks: ['read'] }
const webOpen = { name: 'web_open', providerKind: 'native' as const, risks: ['network'] }
const secretRead = { name: 'credential_get', providerKind: 'native' as const, risks: ['read', 'secret'] }
const sendMsg = { name: 'send_message', providerKind: 'native' as const, risks: ['write', 'network'] }
const secretSend = { name: 'credential_export', providerKind: 'native' as const, risks: ['secret', 'network'] }
const localWrite = { name: 'apply_patch', providerKind: 'native' as const, risks: ['write'] }
const plainRead = { name: 'read_file', providerKind: 'native' as const, risks: ['read'] }

beforeEach(() => {
  __testing.profiles.clear()
  delete process.env.DUIN_RULE_OF_TWO
})
afterEach(() => {
  delete process.env.DUIN_RULE_OF_TWO
})

describe('legsOf', () => {
  it('derives legs from the owning vocabularies', () => {
    expect(legsOf(mcpRead)).toEqual({ untrusted: true, secret: false, stateChange: false })
    expect(legsOf(webOpen)).toEqual({ untrusted: true, secret: false, stateChange: true })
    expect(legsOf(secretRead)).toEqual({ untrusted: false, secret: true, stateChange: false })
    expect(legsOf(localWrite)).toEqual({ untrusted: false, secret: false, stateChange: false })
  })
})

describe('ruleOfTwoCheck', () => {
  it('allows a state-change action in a clean session (no untrusted history)', () => {
    expect(ruleOfTwoCheck(CID, sendMsg)).toBeNull()
  })

  it('blocks the triple: untrusted history + secret history + incoming state-change', () => {
    noteExecutedTool(CID, mcpRead) // [A]
    noteExecutedTool(CID, secretRead) // [B]
    const rot = ruleOfTwoCheck(CID, sendMsg) // [C]
    expect(rot).not.toBeNull()
    expect(rot!.legs.fromHistory).toContain('untrusted-input')
    expect(rot!.legs.fromHistory).toContain('secret-access')
    expect(rot!.legs.fromThisAction).toEqual(['state-change'])
  })

  it('two legs alone never block', () => {
    noteExecutedTool(CID, mcpRead) // [A] only
    expect(ruleOfTwoCheck(CID, sendMsg)).toBeNull() // A + C, no B
    clearRuleOfTwoProfile(CID)
    noteExecutedTool(CID, secretRead) // [B] only
    expect(ruleOfTwoCheck(CID, sendMsg)).toBeNull() // B + C, no A
  })

  it('counts secret from the INCOMING action (B+C in one call completes the triple)', () => {
    noteExecutedTool(CID, mcpRead) // [A]
    const rot = ruleOfTwoCheck(CID, secretSend) // [B]+[C] together
    expect(rot).not.toBeNull()
    expect(rot!.legs.fromThisAction).toEqual(expect.arrayContaining(['state-change', 'secret-access']))
  })

  it('never counts untrusted from the incoming action (A is history-only)', () => {
    noteExecutedTool(CID, secretRead) // [B]
    // webOpen is itself an untrusted SOURCE and a network action — but its result is not
    // yet ingested, and a clean-history session has no injected instruction to contain.
    expect(ruleOfTwoCheck(CID, webOpen)).toBeNull()
  })

  it('never gates reads or reversible local writes, even in a tripled session', () => {
    noteExecutedTool(CID, mcpRead)
    noteExecutedTool(CID, secretRead)
    expect(ruleOfTwoCheck(CID, plainRead)).toBeNull()
    expect(ruleOfTwoCheck(CID, localWrite)).toBeNull()
  })

  it('is scoped per conversation', () => {
    noteExecutedTool(CID, mcpRead)
    noteExecutedTool(CID, secretRead)
    expect(ruleOfTwoCheck('other-conv', sendMsg)).toBeNull()
    expect(ruleOfTwoCheck(CID, sendMsg)).not.toBeNull()
  })

  it('DUIN_RULE_OF_TWO=0 disables both accrual and the floor', () => {
    process.env.DUIN_RULE_OF_TWO = '0'
    noteExecutedTool(CID, mcpRead)
    noteExecutedTool(CID, secretRead)
    expect(__testing.profiles.size).toBe(0)
    expect(ruleOfTwoCheck(CID, sendMsg)).toBeNull()
  })

  it('missing conversationId is a no-op (never throws, never blocks)', () => {
    expect(() => noteExecutedTool(undefined, mcpRead)).not.toThrow()
    expect(ruleOfTwoCheck(undefined, sendMsg)).toBeNull()
  })
})

describe('profile bookkeeping', () => {
  it('accrues legs monotonically and exposes a read-only view', () => {
    noteExecutedTool(CID, mcpRead)
    noteExecutedTool(CID, sendMsg)
    expect(ruleOfTwoProfile(CID)).toEqual({ untrustedIngested: true, secretTouched: false, stateChanged: true })
    const view = ruleOfTwoProfile(CID)!
    view.secretTouched = true // mutating the view must not touch the store
    expect(ruleOfTwoProfile(CID)!.secretTouched).toBe(false)
  })

  it('ignores tools contributing no legs (no profile churn)', () => {
    noteExecutedTool(CID, plainRead)
    noteExecutedTool(CID, localWrite)
    expect(__testing.profiles.size).toBe(0)
  })

  it('bounds live profiles (LRU)', () => {
    for (let i = 0; i < __testing.MAX_PROFILES + 10; i++) {
      noteExecutedTool(`conv-${i}`, mcpRead)
    }
    expect(__testing.profiles.size).toBeLessThanOrEqual(__testing.MAX_PROFILES)
  })

  it('clearRuleOfTwoProfile drops the session', () => {
    noteExecutedTool(CID, mcpRead)
    clearRuleOfTwoProfile(CID)
    expect(ruleOfTwoProfile(CID)).toBeNull()
  })
})
