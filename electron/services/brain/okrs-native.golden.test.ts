// GOLDEN parity lock for the list_okrs port (okrs-native.ts).
//
// list_okrs feeds nodes DIRECTLY into build_brain_graph, so any drift in the
// parsed fields, the id-slug, the emoji→state map, or the goal-then-KRs ordering
// silently corrupts the brain graph. This file pins the EXACT node array for a
// synthetic OKR-tracker vault (values hand-derived from the Python source, not
// from the code under test), covering: frontmatter project, objective + KR heads,
// KR table-cell extraction, the ✅/🟡/🟢 → state map, and the CJK-project _slug
// edge (北澜 → "output", because _slug strips every non-[a-zA-Z0-9] char).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listOkrs } from './okrs-native'

describe('okrs-native — golden (exact list_okrs parity)', () => {
  let dir: string
  const write = (rel: string, text: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text, 'utf-8')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-okrgold-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('parses a 03 Projects tracker: goal-then-KRs order, cells, state map', () => {
    write(
      '03 Projects/DUIN/DUIN Q2 OKR Tracker.md',
      [
        '---',
        'project: DUIN',
        '---',
        '# DUIN Q2 OKR Tracker',
        '',
        '## O1 建立发行中台能力',
        '',
        '**Objective：** 在 Q2 内跑通从立项到上线的中台流程',
        '',
        '### KR1 —【中台准入 SOP v1】上线',
        '',
        '| **状态** | 🟢 进行中 |',
        '| **进度** | 60% |',
        '| **Owner** | 沈一舟 |',
        '| **截止** | 2026-05-12 |',
        '',
        '### KR2 —【渠道对接】完成 3 家',
        '',
        '| **状态** | 🟡 有风险 |',
        '| **进度** | 30% |',
        '| **Owner** | 方晋楠 |',
        '| **截止** | 2026-06-30 |',
        '',
        '## O2 数据看板',
        '',
        '**Objective：** 建立发行数据看板',
        ''
      ].join('\n')
    )

    expect(listOkrs(dir)).toEqual([
      {
        kind: 'goal',
        id: 'okr:duin-o1',
        title: 'O1 建立发行中台能力',
        project: 'DUIN',
        parent: '',
        desc: '在 Q2 内跑通从立项到上线的中台流程'
      },
      {
        kind: 'kr',
        id: 'okr:duin-o1-kr1',
        title: 'KR1 中台准入 SOP v1 上线',
        project: 'DUIN',
        parent: 'okr:duin-o1',
        status: '🟢 进行中',
        state: 'on',
        progress: '60%',
        owner: '沈一舟',
        due: '2026-05-12'
      },
      {
        kind: 'kr',
        id: 'okr:duin-o1-kr2',
        title: 'KR2 渠道对接 完成 3 家',
        project: 'DUIN',
        parent: 'okr:duin-o1',
        status: '🟡 有风险',
        state: 'risk',
        progress: '30%',
        owner: '方晋楠',
        due: '2026-06-30'
      },
      {
        kind: 'goal',
        id: 'okr:duin-o2',
        title: 'O2 数据看板',
        project: 'DUIN',
        parent: '',
        desc: '建立发行数据看板'
      }
    ])
  })

  it('discovers arena-folder trackers and slugs a CJK project to "output" (✅→done)', () => {
    write(
      '北澜/北澜 OKR Tracker.md',
      [
        '---',
        'project: 北澜',
        '---',
        '## O1 目标一',
        '',
        '**Objective：** 描述文本',
        '',
        '### KR1 —【关键结果】',
        '',
        '| **状态** | ✅ 完成 |',
        '| **进度** | 100% |',
        ''
      ].join('\n')
    )

    expect(listOkrs(dir)).toEqual([
      {
        kind: 'goal',
        id: 'okr:output-o1',
        title: 'O1 目标一',
        project: '北澜',
        parent: '',
        desc: '描述文本'
      },
      {
        kind: 'kr',
        id: 'okr:output-o1-kr1',
        title: 'KR1 关键结果',
        project: '北澜',
        parent: 'okr:output-o1',
        status: '✅ 完成',
        state: 'done',
        progress: '100%',
        owner: '',
        due: ''
      }
    ])
  })

  it('returns [] for a vault with no trackers', () => {
    write('03 Projects/DUIN/README.md', '# nothing here')
    expect(listOkrs(dir)).toEqual([])
  })
})
