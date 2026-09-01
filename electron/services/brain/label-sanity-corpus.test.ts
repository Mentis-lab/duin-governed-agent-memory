import { describe, it, expect } from 'vitest'
import { checkLabel } from './label-sanity'

// THE test that matters. A one-way version of this detector flagged 96 of 8,582 live labels —
// including 武汉大学 and 原神 6.8 版本 — and would have deleted them. So the guard is pinned against
// a corpus of REAL labels sampled from the live graph, not against hand-picked examples that
// happen to pass. Any future loosening that re-breaks precision fails here.
const REAL_LABELS = [
  '美林版本', '跨部门优先级对齐', '渠道商务时间倒推', 'ATE 自动测试设备', '云帆回购重组方案',
  '角色印象共识 / 文案设定', '珠海长隆', '星海网络《北澜》', '测试设备预测性维护', '回购重组方案',
  '神貌之树逆卡巴拉', '原神 6.8 版本', '趣方块常态化情报互通', '武汉大学', '美林外墙彩绘报批',
  '北澜', '商务双周报', '端午美林试玩会', '广州动漫游戏盛典', '3DM平台', 'IP出版合作方案讨论',
  'BilibiliWorld', 'TapTap', '半导体-云帆泰克', 'Orbis Inc', 'DUIN CORE', '二测', '国际发行',
  '极驰汽车 - JICHI', '蜜雪冰城', '瑞声科技', '发行支撑组', '晨曦发行', 'Q2 OKR Tracker',
  'レポートを作成', '한국어 라벨', 'Café Zürich', 'plain ascii'
]

describe('label guard — precision against real vault labels', () => {
  for (const label of REAL_LABELS) {
    it(`keeps ${JSON.stringify(label)}`, () => {
      expect(checkLabel(label).ok).toBe(true)
    })
  }
  it('flags ZERO of the real corpus', () => {
    const flagged = REAL_LABELS.filter((l) => !checkLabel(l).ok)
    expect(flagged).toEqual([])
  })
})

describe('label guard — still catches the real corruption', () => {
  // The two cleanly-reversible ones observed in production.
  for (const bad of ['3DM骞冲彴', '骞垮窞鍔ㄦ极娓告垙鐩涘吀']) {
    it(`refuses ${JSON.stringify(bad.slice(0, 10))}`, () => {
      expect(checkLabel(bad)).toMatchObject({ ok: false, reason: 'mojibake' })
    })
  }
})
