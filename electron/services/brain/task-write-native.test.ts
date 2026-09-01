import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { taskAction, moveTask, locateTask, setInlineField, rewriteTaskStatus, taskTitleOf } from './task-write-native'

describe('task-write-native', () => {
  let vault: string
  let tasksMd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-tw-'))
    mkdirSync(join(vault, '06 Tasks'), { recursive: true })
    tasksMd = join(vault, '06 Tasks', 'Inbox.md')
    writeFileSync(
      tasksMd,
      [
        '# Tasks',
        '- [ ] first task {{duinTaskId:: t1}} {{status:: Project.Inbox}}',
        '- [ ] second with priority {{duinTaskId:: t2}} {{priority:: P2}}',
        '- [x] already done {{duinTaskId:: t3}} {{status:: Project.Done}} ✅ 2026-06-01'
      ].join('\n') + '\n'
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  const read = (): string => readFileSync(tasksMd, 'utf-8')

  describe('pure helpers', () => {
    it('setInlineField replaces, adds, and removes', () => {
      expect(setInlineField('- [ ] x {{priority:: P2}}', 'priority', 'P1')).toContain('{{priority:: P1}}')
      expect(setInlineField('- [ ] x', 'status', 'Project.Done')).toBe('- [ ] x {{status:: Project.Done}}')
      expect(setInlineField('- [ ] x {{due:: 2026-01-01}}', 'due', '')).toBe('- [ ] x')
    })
    it('rewriteTaskStatus flips checkbox + status together', () => {
      expect(rewriteTaskStatus('- [ ] x {{status:: Project.Inbox}}', 'Done')).toBe('- [x] x {{status:: Project.Done}}')
      expect(rewriteTaskStatus('- [x] x {{status:: Project.Done}}', 'Inbox')).toBe('- [ ] x {{status:: Project.Inbox}}')
    })
    it('locateTask finds by duinTaskId and by relpath#line', () => {
      expect(locateTask(vault, 't2')!.idx).toBe(2)
      expect(locateTask(vault, 'nope')).toBeNull()
      const byLine = locateTask(vault, '06 Tasks/Inbox.md#1')
      expect(byLine!.idx).toBe(1)
    })
  })

  describe('taskAction', () => {
    it('complete flips checkbox, stamps ✅ date, sets status Done', () => {
      const r = taskAction(vault, 't1', 'complete', '', new Date('2026-07-02T00:00:00Z'))
      expect(r.ok).toBe(true)
      const line = read().split('\n')[1]
      expect(line).toContain('- [x]')
      expect(line).toContain('✅ 2026-07-02')
      expect(line).toContain('{{status:: Project.Done}}')
    })
    it('reopen un-checks + strips ✅ + sets Inbox', () => {
      taskAction(vault, 't1', 'complete', '', new Date('2026-07-02T00:00:00Z'))
      const r = taskAction(vault, 't1', 'reopen')
      expect(r.ok).toBe(true)
      const line = read().split('\n')[1]
      expect(line).toContain('- [ ]')
      expect(line).not.toContain('✅')
      expect(line).toContain('{{status:: Project.Inbox}}')
    })
    it('priority sets the inline field; delete removes the line', () => {
      expect(taskAction(vault, 't1', 'priority', 'P1').ok).toBe(true)
      expect(read().split('\n')[1]).toContain('{{priority:: P1}}')
      expect(taskAction(vault, 't2', 'delete').ok).toBe(true)
      expect(read()).not.toContain('duinTaskId:: t2')
    })
    it('unknown action / missing task → ok:false, no write', () => {
      expect(taskAction(vault, 't1', 'frobnicate').ok).toBe(false)
      expect(taskAction(vault, 'ghost', 'complete').ok).toBe(false)
    })
  })

  describe('moveTask', () => {
    it('moves by duinTaskId, sanitizes status, flips checkbox for Done', () => {
      expect(moveTask(vault, 't1', 'Doing')).toBe(true)
      expect(read().split('\n')[1]).toContain('{{status:: Project.Doing}}')
      expect(moveTask(vault, 't1', 'Done!!')).toBe(true) // non-alpha stripped → Done
      expect(read().split('\n')[1]).toContain('- [x]')
      expect(read().split('\n')[1]).toContain('{{status:: Project.Done}}')
    })
    it('returns false for empty id / missing task', () => {
      expect(moveTask(vault, '', 'Done')).toBe(false)
      expect(moveTask(vault, 'ghost', 'Done')).toBe(false)
    })
  })
})

describe('taskTitleOf — emoji-safe stamp stripping', () => {
  // Regression: the stamp class must keep its `u` flag. Without it the class is 5 UTF-16 code
  // units rather than 4 emoji (🔺 and 🔴 both begin \uD83D), so the bare high surrogate matches
  // alone and — the date tail being fully optional — decapitates any other \uD83D-family emoji
  // in a title, leaving an orphan low surrogate in the notice text.
  const hasLoneSurrogate = (s: string): boolean =>
    [...s].some((ch) => {
      const n = ch.codePointAt(0) ?? 0
      return n >= 0xd800 && n <= 0xdfff
    })

  it('strips the stamps it is meant to strip, with or without a date tail', () => {
    expect(taskTitleOf('- [x] 交付渠道包 ✅ 2026-07-25')).toBe('交付渠道包')
    expect(taskTitleOf('- [ ] 处理合规问题 ⏫')).toBe('处理合规问题')
    expect(taskTitleOf('- [ ] 风险项 🔺 2026-07')).toBe('风险项')
    expect(taskTitleOf('- [ ] 阻塞项 🔴')).toBe('阻塞项')
  })

  it('leaves unrelated emoji intact and never emits a lone surrogate', () => {
    for (const [line, keep] of [
      ['- [ ] 修复构建 🔥 紧急', '🔥'],
      ['- [ ] 部署上线 🚀', '🚀'],
      ['- [ ] 记录想法 💡', '💡'],
      ['- [ ] 北澜渠道 🎮 对接', '🎮'],
    ] as const) {
      const out = taskTitleOf(line)
      expect(out).toContain(keep)
      expect(hasLoneSurrogate(out)).toBe(false)
    }
  })

  it('still strips inline fields', () => {
    expect(taskTitleOf('- [ ] 双周报 {{due:: 2026-07-30}} ⏫')).toBe('双周报')
  })
})
