// vision-image-path.test.ts — coverage for the image attachment path, which had NONE.
//
// Images crossed IPC, were validated, were folded into a multimodal content array and forwarded to
// the provider — and not one line of that was tested. The gap mattered: the field rode the wire
// undeclared for weeks (see chat-send-contract.ts ChatSendRequest.images), and the renderer sent the
// same image twice to vision models because an OCR filter forgot to check the capability flag.
//
// These tests pin the three properties that make the path safe:
//   1. absent images  ⇒ byte-for-byte the pre-vision body (no silent shape change for text turns)
//   2. present images ⇒ exactly one text part + one image_url part per image, on the LAST user turn
//   3. a text-only engine ⇒ image parts are stripped, never handed to the provider

import { describe, it, expect } from 'vitest'
import { buildAguiBody } from '../services/duin-bridge'
import { validateChatSendRequest } from '../ipc/chat-validation'
import { hasImagePart, stripImageParts, type AguiMessage } from '../services/local-brain/server'
import { buildBrainHistory, capImages } from '../services/brain-history'
import { buildApiMessagesFromStoredMessages } from '../services/chat-history'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
const wire = { threadId: 't-1', runId: 'r-1', prompt: 'what is this' }

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
const messagesOf = (body: Record<string, unknown>) =>
  body.messages as { role: string; content: string | Part[] }[]

describe('buildAguiBody — image folding', () => {
  it('without images the last user message stays a PLAIN STRING', () => {
    const msgs = messagesOf(buildAguiBody({}, wire))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({ role: 'user', content: 'what is this' })
  })

  it('an empty images array is treated as absent (no shape change)', () => {
    const withEmpty = messagesOf(buildAguiBody({ images: [] }, wire))
    const without = messagesOf(buildAguiBody({}, wire))
    expect(withEmpty).toEqual(without)
  })

  it('with images the last user message becomes [text, ...image_url]', () => {
    const msgs = messagesOf(
      buildAguiBody({ images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )
    expect(msgs[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: PNG } }
    ])
  })

  it('every image gets its own part, in order, after a single text part', () => {
    const content = messagesOf(
      buildAguiBody(
        {
          images: [
            { mimeType: 'image/png', dataUrl: PNG },
            { mimeType: 'image/jpeg', dataUrl: JPG }
          ]
        },
        wire
      )
    )[0].content as Part[]
    expect(content.filter((p) => p.type === 'text')).toHaveLength(1)
    expect(content.filter((p) => p.type === 'image_url').map((p) => (p as { image_url: { url: string } }).image_url.url))
      .toEqual([PNG, JPG])
  })

  it('images attach to the LAST user turn, never to history or an assistant turn', () => {
    const history = [
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'what is this' }
    ]
    const msgs = messagesOf(
      buildAguiBody({ history, images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )
    expect(msgs[0].content).toBe('earlier question')
    expect(msgs[1].content).toBe('earlier answer')
    expect(Array.isArray(msgs[2].content)).toBe(true)
  })
})

describe('validateChatSendRequest — image hygiene', () => {
  const base = { conversationId: 'c', model: 'm', content: 'hi', activeSkillIds: [] }
  const valueOf = (raw: unknown) => {
    const v = validateChatSendRequest(raw)
    if (!v.ok) throw new Error('expected a valid request')
    return v.value as { images?: { mimeType: string; dataUrl: string }[] }
  }

  it('accepts a well-formed image', () => {
    expect(valueOf({ ...base, images: [{ mimeType: 'image/png', dataUrl: PNG }] }).images).toEqual([
      { mimeType: 'image/png', dataUrl: PNG }
    ])
  })

  it('drops entries whose dataUrl is not a data: URL — no remote fetch is ever induced', () => {
    // A https:// url here would make the PROVIDER fetch an attacker-chosen host.
    expect(
      valueOf({ ...base, images: [{ mimeType: 'image/png', dataUrl: 'https://evil.test/x.png' }] })
        .images
    ).toBeUndefined()
  })

  it('drops malformed entries rather than half-forwarding them', () => {
    const v = valueOf({
      ...base,
      images: [
        { mimeType: 'image/png' },
        { dataUrl: PNG },
        { mimeType: '', dataUrl: PNG },
        null,
        'nope',
        { mimeType: 'image/png', dataUrl: PNG }
      ]
    })
    expect(v.images).toEqual([{ mimeType: 'image/png', dataUrl: PNG }])
  })

  it('omits the field entirely when nothing survives, so the body keeps its old shape', () => {
    expect(valueOf({ ...base, images: [] }).images).toBeUndefined()
    expect(valueOf({ ...base, images: 'not-an-array' }).images).toBeUndefined()
  })
})

describe('replay of persisted images', () => {
  const part = (url: string) => ({ type: 'image_url' as const, image_url: { url } })

  it('a history turn carries its own images — an earlier image survives later turns', () => {
    const history = [
      { role: 'user', content: 'look at this', parts: [part(PNG)] },
      { role: 'assistant', content: 'I see a chart' },
      { role: 'user', content: 'what colour was it' }
    ]
    const msgs = messagesOf(buildAguiBody({ history }, wire))
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'look at this' }, part(PNG)])
    expect(msgs[1].content).toBe('I see a chart')
    expect(msgs[2].content).toBe('what colour was it')
  })

  it('does NOT double-attach when history already supplied this turn images', () => {
    // ipc/chat.ts persists the user row (with parts) BEFORE building history, so the live
    // `images` option describes the SAME attachment the history turn already carries.
    const history = [{ role: 'user', content: 'what is this', parts: [part(PNG)] }]
    const content = messagesOf(
      buildAguiBody({ history, images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )[0].content as Part[]
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(1)
  })

  it('still honours live images when history carries none (unpersisted callers)', () => {
    const history = [{ role: 'user', content: 'what is this' }]
    const content = messagesOf(
      buildAguiBody({ history, images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )[0].content as Part[]
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(1)
  })
})

describe('buildBrainHistory — image budgeting', () => {
  const part = (url: string) => ({ type: 'image_url' as const, image_url: { url } })
  const imgMsg = (n: number) => ({ role: 'user', content: `turn ${n}`, parts: [part(`data:image/png;base64,${n}`)] })

  it('keeps only the most recent N image-bearing turns, but keeps ALL the text', () => {
    const msgs = [imgMsg(1), imgMsg(2), imgMsg(3), imgMsg(4)]
    const out = capImages(msgs, 2)
    expect(out.map((m) => m.content)).toEqual(['turn 1', 'turn 2', 'turn 3', 'turn 4'])
    expect(out.filter((m) => m.parts?.length).map((m) => m.content)).toEqual(['turn 3', 'turn 4'])
  })

  it('returns the input untouched when under the cap (no allocation, no shape change)', () => {
    const msgs = [imgMsg(1)]
    expect(capImages(msgs, 2)).toBe(msgs)
  })

  it('a huge data URL does not blow the CHAR budget and evict the conversation', () => {
    // The budget bounds TEXT. Measuring a base64 image against it would drop every prior turn the
    // moment anyone attached a screenshot — the regression this separation exists to prevent.
    const huge = 'data:image/png;base64,' + 'A'.repeat(60_000)
    const out = buildBrainHistory([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third', parts: [part(huge)] }
    ])
    expect(out.map((m) => m.content)).toEqual(['first', 'second', 'third'])
    expect(out[2].parts).toHaveLength(1)
  })

  it('text-only history is unchanged and carries no parts key', () => {
    const out = buildBrainHistory([{ role: 'user', content: 'hi' }])
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('raw: provider path rebuilds images from storage', () => {
  const part = { type: 'image_url' as const, image_url: { url: PNG } }

  it('a stored user turn with parts becomes multimodal content on a vision model', () => {
    const msgs = buildApiMessagesFromStoredMessages(
      'sys',
      [{ role: 'user', content: 'what is this', contentParts: [part] }],
      'gpt-4o'
    )
    // [0] is the system prompt.
    expect(msgs[1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'what is this' }, part]
    })
  })

  it('withholds images when NO model id is given — capability is unverifiable', () => {
    // Fail safe: omitting an image loses content, but sending an unsupported
    // content block fails the entire request. Prefer the recoverable loss.
    const msgs = buildApiMessagesFromStoredMessages('sys', [
      { role: 'user', content: 'what is this', contentParts: [part] }
    ])
    expect(msgs[1]).toEqual({ role: 'user', content: 'what is this' })
  })

  it('a stored turn WITHOUT parts stays a plain string (byte-for-byte the old path)', () => {
    const msgs = buildApiMessagesFromStoredMessages('sys', [{ role: 'user', content: 'hello' }])
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' })
  })

  it('an empty parts array is treated as absent', () => {
    const msgs = buildApiMessagesFromStoredMessages('sys', [
      { role: 'user', content: 'hello', contentParts: [] }
    ])
    expect(msgs[1]).toEqual({ role: 'user', content: 'hello' })
  })
})

describe('brain-side vision safety net', () => {
  const textMsg: AguiMessage = { role: 'user', content: 'plain' }
  const imgMsg: AguiMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'what is this' },
      { type: 'image_url', image_url: { url: PNG } }
    ]
  }

  it('detects image parts only when present', () => {
    expect(hasImagePart(textMsg)).toBe(false)
    expect(hasImagePart(imgMsg)).toBe(true)
    expect(hasImagePart({ role: 'user', content: [{ type: 'text', text: 'a' }] })).toBe(false)
  })

  it('strips images back to the text projection', () => {
    expect(stripImageParts(imgMsg)).toEqual({ role: 'user', content: 'what is this' })
  })

  it('leaves a plain string message untouched (identity)', () => {
    expect(stripImageParts(textMsg)).toBe(textMsg)
  })

  it('joins multiple text parts and never leaks a data URL into the text', () => {
    const stripped = stripImageParts({
      role: 'user',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image_url', image_url: { url: PNG } },
        { type: 'text', text: 'line two' }
      ]
    })
    expect(stripped.content).toBe('line one\nline two')
    expect(String(stripped.content)).not.toContain('base64')
  })
})

// ── Regressions found by adversarial review, 2026-07-29 ───────────────────────
describe('raw path: capability + volume guards on replayed images', () => {
  const part = { type: 'image_url' as const, image_url: { url: PNG } }
  const turn = (n: number) => ({ role: 'user' as const, content: `t${n}`, contentParts: [part] })

  it('does NOT replay images to a text-only model — an image_url block would FAIL the turn', () => {
    // deepseek-v4-pro is supportsVision:false in the catalog. Before this guard,
    // switching the picker to a text-only model after any image had been attached
    // rebuilt the old turn with an image part and the provider rejected the request.
    const msgs = buildApiMessagesFromStoredMessages('sys', [turn(1)], 'deepseek-v4-pro')
    expect(msgs[1]).toEqual({ role: 'user', content: 't1' })
  })

  it('replays images to a vision model', () => {
    const msgs = buildApiMessagesFromStoredMessages('sys', [turn(1)], 'gpt-4o')
    expect(Array.isArray((msgs[1] as { content: unknown }).content)).toBe(true)
  })

  it('caps replay to the most recent image turns instead of re-uploading the whole thread', () => {
    const msgs = buildApiMessagesFromStoredMessages(
      'sys',
      [turn(1), turn(2), turn(3), turn(4)],
      'gpt-4o'
    )
    const withImages = msgs
      .slice(1)
      .filter((m) => Array.isArray((m as { content: unknown }).content))
    expect(withImages).toHaveLength(2)
    // …and it keeps the NEWEST, not the oldest.
    const texts = withImages.map(
      (m) => ((m as { content: { type: string; text?: string }[] }).content[0].text)
    )
    expect(texts).toEqual(['t3', 't4'])
  })

  it('an unknown model id is treated as unable to see (conservative)', () => {
    const msgs = buildApiMessagesFromStoredMessages('sys', [turn(1)], 'no-such-model-xyz')
    expect(msgs[1]).toEqual({ role: 'user', content: 't1' })
  })
})

describe('bridge: live image is not suppressed by an OLDER turn carrying one', () => {
  const part = (u: string) => ({ type: 'image_url' as const, image_url: { url: u } })
  const OTHER = 'data:image/png;base64,OLDOLDOLD='

  it('attaches the NEW image when only a previous turn had parts', () => {
    // The regression: a global "history carried images" flag suppressed the live
    // image because turn 1 had one, so the model saw the STALE picture instead.
    const history = [
      { role: 'user', content: 'first', parts: [part(OTHER)] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now look at this' } // parts dropped / not persisted
    ]
    const msgs = messagesOf(
      buildAguiBody({ history, images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )
    const last = msgs[2].content as Part[]
    expect(last.filter((p) => p.type === 'image_url').map((p) => (p as { image_url: { url: string } }).image_url.url))
      .toEqual([PNG])
    // The older turn keeps its own image — it is not moved or duplicated.
    expect((msgs[0].content as Part[]).filter((p) => p.type === 'image_url')).toHaveLength(1)
  })

  it('still suppresses the double-attach when the LAST user turn already carries it', () => {
    const history = [{ role: 'user', content: 'what is this', parts: [part(PNG)] }]
    const content = messagesOf(
      buildAguiBody({ history, images: [{ mimeType: 'image/png', dataUrl: PNG }] }, wire)
    )[0].content as Part[]
    expect(content.filter((p) => p.type === 'image_url')).toHaveLength(1)
  })
})
