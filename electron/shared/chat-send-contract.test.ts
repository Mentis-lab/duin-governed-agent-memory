// chat-send-contract.test.ts — the tripwire for the transport cliff.
//
// The 2026-07-20 UI/engine coherence audit found three controls whose values crossed IPC and were
// then silently dropped before reaching the brain (skills, plan mode, deep research). Nothing
// caught them because the request shape, the transport options and the POST body were three
// unrelated declarations. These tests assert the relationship the types cannot fully express:
// that a field the contract calls 'forwarded' REALLY lands on the /agui body.

import { describe, it, expect } from 'vitest'
import {
  CHAT_SEND_DISPOSITION,
  FORWARDED_KEYS,
  NOT_FORWARDED_KEYS,
  OPEN_TRANSPORT_DEFECTS,
  type ChatSendKey,
  type ChatSendRequest
} from './chat-send-contract'
import { buildAguiBody } from '../services/duin-bridge'

/** A fully-populated request — every optional field set, so nothing is skipped by absence. */
const FULL_REQUEST: Required<ChatSendRequest> = {
  conversationId: 'conv-1',
  model: 'test-model',
  content: 'hello',
  activeSkillIds: ['skill-a'],
  context: { id: 'node-1', label: 'A note', kind: 'note' },
  reasoningEffort: 'high',
  permissionsMode: 'default',
  language: 'ja',
  images: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]
}

// `images` is omitted unless a case asks for it: it is the one field whose presence RESHAPES
// `messages` (string → multimodal array), so leaving it on by default would mean every assertion
// about the text-turn body shape silently tested the vision path instead. Folding is asserted
// explicitly below, and exhaustively in vision-image-path.test.ts.
const bodyFor = (over: Partial<ChatSendRequest> = {}) => {
  const r = { ...FULL_REQUEST, images: undefined, ...over }
  return buildAguiBody(
    {
      model: r.model,
      context: r.context,
      reasoningEffort: r.reasoningEffort,
      permissionsMode: r.permissionsMode,
      language: r.language,
      images: r.images
    },
    { threadId: r.conversationId, runId: 'run-1', prompt: r.content }
  )
}

describe('chat:send transport contract', () => {
  it('classifies EVERY request field — no field is unaccounted for', () => {
    // The Record<ChatSendKey, Disposition> type already makes an omission a compile error; this
    // asserts the runtime table matches a real request object, catching a key added to the type
    // and the table but never actually sent.
    const requestKeys = Object.keys(FULL_REQUEST).sort()
    const classifiedKeys = Object.keys(CHAT_SEND_DISPOSITION).sort()
    expect(classifiedKeys).toEqual(requestKeys)
  })

  it('every FORWARDED field actually lands on the /agui body', () => {
    const body = bodyFor()
    for (const key of FORWARDED_KEYS) {
      const d = CHAT_SEND_DISPOSITION[key]
      if (d.kind !== 'forwarded') continue
      expect(
        body,
        `contract says '${key}' is forwarded as '${d.bodyField}', but it is absent from the /agui body — ` +
          `this is the transport-cliff defect: the value crosses IPC and evaporates`
      ).toHaveProperty(d.bodyField)
    }
  })

  it('a forwarded field carries its VALUE, not just its key', () => {
    const body = bodyFor()
    expect(body.model).toBe('test-model')
    expect(body.reasoningEffort).toBe('high')
    expect(body.context).toEqual({ id: 'node-1', label: 'A note', kind: 'note' })
    expect(body.permissionsMode).toBe('default')
  })

  it('omitting an optional forwarded field omits it from the body (byte-identical old shape)', () => {
    const body = bodyFor({ model: undefined, context: undefined, reasoningEffort: undefined, permissionsMode: undefined })
    expect(body).not.toHaveProperty('model')
    expect(body).not.toHaveProperty('context')
    expect(body).not.toHaveProperty('reasoningEffort')
    expect(body).not.toHaveProperty('permissionsMode')
    // The transformed fields survive regardless.
    expect(body.threadId).toBe('conv-1')
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('TRANSFORMED fields reach the brain under their renamed body field', () => {
    const body = bodyFor()
    expect(body.threadId).toBe(FULL_REQUEST.conversationId)
    expect(body.messages).toEqual([{ role: 'user', content: FULL_REQUEST.content }])
  })

  it('images are TRANSFORMED into the messages array, not sent as a sibling field', () => {
    // The disposition claims bodyField 'messages'. Assert both halves of that claim: the images
    // land inside `messages`, and no stray top-level `images` key rides along.
    const body = bodyFor({ images: FULL_REQUEST.images })
    expect(body).not.toHaveProperty('images')
    const content = (body.messages as { content: unknown }[])[0].content as { type: string }[]
    expect(Array.isArray(content)).toBe(true)
    expect(content.map((p) => p.type)).toEqual(['text', 'image_url'])
  })

  it('every NOT-FORWARDED field states a reason', () => {
    for (const key of NOT_FORWARDED_KEYS) {
      const d = CHAT_SEND_DISPOSITION[key]
      if (d.kind !== 'not-forwarded') continue
      expect(d.reason.length, `'${key}' is dropped with no recorded reason`).toBeGreaterThan(20)
    }
  })

  it('a NOT-FORWARDED field is genuinely absent from the body (the claim is honest both ways)', () => {
    const body = bodyFor()
    for (const key of NOT_FORWARDED_KEYS) {
      expect(body, `'${key}' is marked not-forwarded but appears on the body`).not.toHaveProperty(key)
    }
  })

  it('there are NO open transport defects — every field reaches the brain', () => {
    // activeSkillIds was the last one; it is now transformed -> `skills`. If this fails, a field
    // is being silently dropped again and the audit's core defect has reappeared.
    expect(OPEN_TRANSPORT_DEFECTS).toEqual([])
  })

  it('activeSkillIds is carried as resolved `skills` (the 2026-07-20 fix)', () => {
    const d = CHAT_SEND_DISPOSITION.activeSkillIds
    expect(d.kind).toBe('transformed')
    if (d.kind === 'transformed') expect(d.bodyField).toBe('skills')
    const body = buildAguiBody(
      { skills: [{ name: 'Debugging', content: 'Reproduce before fixing.' }] },
      { threadId: 't', runId: 'r', prompt: 'p' }
    )
    expect(body.skills).toEqual([{ name: 'Debugging', content: 'Reproduce before fixing.' }])
  })

  it('no enabled skills -> the field is omitted (old body shape preserved)', () => {
    expect(buildAguiBody({ skills: [] }, { threadId: 't', runId: 'r', prompt: 'p' })).not.toHaveProperty('skills')
    expect(buildAguiBody({}, { threadId: 't', runId: 'r', prompt: 'p' })).not.toHaveProperty('skills')
  })
})
