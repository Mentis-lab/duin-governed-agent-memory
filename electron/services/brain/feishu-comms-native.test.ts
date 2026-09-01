import { describe, it, expect } from 'vitest'
import { feishuText, pickChat, pullFeishuMessages, sendFeishuMessage, type Exec } from './feishu-comms-native'

describe('feishu-comms — feishuText (PURE)', () => {
  it('labels empty/media, unwraps JSON text + rich posts, truncates plain', () => {
    expect(feishuText('', 'image')).toBe('[image]')
    expect(feishuText('<folder name="SOW.pdf"/>', 'file')).toBe('[file: SOW.pdf]')
    expect(feishuText('{"text":"hello"}', 'text')).toBe('hello')
    expect(feishuText('{"title":"T","content":[[{"text":"a"},{"text":"b"}]]}', 'post')).toBe('T a b')
    expect(feishuText('plain text', 'text')).toBe('plain text')
  })
})

describe('feishu-comms — pickChat (PURE)', () => {
  const chats = [{ chat_id: 'c1', name: '张三（北澜）', p2p_target_id: 'u1' }, { chat_id: 'c2', name: '李四' }]
  it('matches the core name before an org suffix', () => {
    expect(pickChat(chats, '张三 - 北澜项目')?.chat_id).toBe('c1')
  })
  it('returns null on no match / too-short query', () => {
    expect(pickChat(chats, '王五')).toBeNull()
    expect(pickChat(chats, 'x')).toBeNull()
  })
})

describe('feishu-comms — pullFeishuMessages', () => {
  const chatList = JSON.stringify({ data: { items: [{ chat_id: 'c1', name: '张三', p2p_target_id: 'u1' }] } })
  const msgList = JSON.stringify({
    data: {
      items: [
        { sender: { id: 'me' }, content: '{"text":"我周五给你"}', msg_type: 'text', create_time: '200' },
        { sender: { id: 'u1' }, content: '{"text":"好的谢谢"}', msg_type: 'text', create_time: '100' }
      ]
    }
  })
  const exec: Exec = async (args) => ({
    stdout: args.includes('+chat-list') ? chatList : msgList,
    stderr: '',
    code: 0
  })

  it('resolves the chat, marks mine vs theirs, chronological + awaiting flag', async () => {
    const r = await pullFeishuMessages('张三', { exec })
    expect(r.ok).toBe(true)
    expect(r.chat).toBe('张三')
    // desc from API → reversed to chronological: theirs(100) then mine(200)
    expect(r.messages.map((m) => [m.mine, m.text])).toEqual([[false, '好的谢谢'], [true, '我周五给你']])
    expect(r.awaiting).toBe(false) // last message is mine
  })

  it('errors when no chat matches', async () => {
    const r = await pullFeishuMessages('王五', { exec })
    expect(r).toMatchObject({ ok: false, error: "no Feishu chat matched '王五'", messages: [] })
  })
})

describe('feishu-comms — sendFeishuMessage', () => {
  const chatList = JSON.stringify({ data: { items: [{ chat_id: 'c1', name: '张三', p2p_target_id: 'u1' }] } })

  it('rejects an empty message (no exec)', async () => {
    let called = false
    const r = await sendFeishuMessage('张三', '  ', false, { exec: async () => { called = true; return { stdout: '', stderr: '', code: 0 } } })
    expect(r).toEqual({ ok: false, error: 'empty message' })
    expect(called).toBe(false)
  })

  it('dry-run reports clean exit + preview without parsing an envelope', async () => {
    const exec: Exec = async (args) => (args.includes('+chat-list')
      ? { stdout: chatList, stderr: '', code: 0 }
      : { stdout: 'would send: hi', stderr: '', code: 0 })
    const r = await sendFeishuMessage('张三', 'hi', true, { exec })
    expect(r).toEqual({ ok: true, to: '张三', preview: 'would send: hi' })
  })

  it('real send parses the {ok} envelope + targets the p2p user', async () => {
    let sendArgs: string[] = []
    const exec: Exec = async (args) => {
      if (args.includes('+chat-list')) return { stdout: chatList, stderr: '', code: 0 }
      sendArgs = args
      return { stdout: JSON.stringify({ ok: true }), stderr: '', code: 0 }
    }
    const r = await sendFeishuMessage('张三', 'hello', false, { exec })
    expect(r).toEqual({ ok: true, to: '张三', error: '' })
    expect(sendArgs).toContain('--user-id')
    expect(sendArgs).toContain('u1')
    expect(sendArgs).not.toContain('--dry-run')
  })

  it('surfaces a send error envelope', async () => {
    const exec: Exec = async (args) => (args.includes('+chat-list')
      ? { stdout: chatList, stderr: '', code: 0 }
      : { stdout: JSON.stringify({ ok: false, error: { message: 'rate limited' } }), stderr: '', code: 0 })
    const r = await sendFeishuMessage('张三', 'hello', false, { exec })
    expect(r).toEqual({ ok: false, to: '张三', error: 'rate limited' })
  })

  it('errors when no chat resolves', async () => {
    const exec: Exec = async () => ({ stdout: JSON.stringify({ data: { items: [] } }), stderr: '', code: 0 })
    expect(await sendFeishuMessage('张三', 'hi', false, { exec })).toEqual({ ok: false, error: "no Feishu chat for '张三'" })
  })
})

// ── backlog finding 9, the send-path half ───────────────────────────────────

describe('feishu-comms — the dry-run flag cannot be displaced by the payload', () => {
  const chatList = JSON.stringify({ data: { items: [{ chat_id: 'c1', name: '张三', p2p_target_id: 'u1' }] } })

  const capture = (): { seen: string[][]; exec: Exec } => {
    const seen: string[][] = []
    const exec: Exec = async (args) => {
      seen.push(args)
      return args.includes('+chat-list')
        ? { stdout: chatList, stderr: '', code: 0 }
        : { stdout: 'would send', stderr: '', code: 0 }
    }
    return { seen, exec }
  }

  it('places --dry-run BEFORE --text, never after it', async () => {
    // On win32 these args are joined into a cmd.exe command line. A newline in the
    // message terminates that line, so a `--dry-run` sitting after `--text <msg>`
    // silently fell off and the preview sent for real. Ordering it ahead of the
    // caller-controlled payload means no payload quirk can cost us the flag.
    const { seen, exec } = capture()
    await sendFeishuMessage('张三', 'hi', true, { exec })
    const send = seen.find((a) => a.includes('+messages-send'))!
    expect(send).toContain('--dry-run')
    expect(send.indexOf('--dry-run')).toBeLessThan(send.indexOf('--text'))
  })

  it('a real send carries no --dry-run at all', async () => {
    const { seen, exec } = capture()
    await sendFeishuMessage('张三', 'hi', false, { exec })
    const send = seen.find((a) => a.includes('+messages-send'))!
    expect(send).not.toContain('--dry-run')
    expect(send[send.indexOf('--text') + 1]).toBe('hi')
  })
})
