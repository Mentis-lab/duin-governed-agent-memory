import { describe, it, expect } from 'vitest'
import { checkLabel, recoverMojibake, hasLostBytes } from './label-sanity'

// The three labels below are the ACTUAL corrupted rows found in the live vault on 2026-08-03.
describe('recoverMojibake — the corruption observed in production', () => {
  // Two recover exactly. The third is mojibake AND cut mid-character (its byte stream ends on a
  // lone `e8` — the start of a `论` that never arrived), so it is DETECTED but only partly
  // recoverable. Detection is what the guard acts on; recovery is a diagnostic nicety.
  const CLEAN: Array<[string, string]> = [
    ['3DM骞冲彴', '3DM平台'],
    ['骞垮窞鍔ㄦ极娓告垙鐩涘吀', '广州动漫游戏盛典']
  ]
  for (const [bad, good] of CLEAN) {
    it(`recovers ${bad.slice(0, 12)} -> ${good}`, () => expect(recoverMojibake(bad)).toBe(good))
    it(`refuses to mint ${good}`, () => {
      const v = checkLabel(bad)
      expect(v.ok).toBe(false)
      expect(v.reason).toBe('mojibake')
      expect(v.recovered).toBe(good)
    })
  }
  // This one lost bytes in more than one place, and `増` is a Japanese kanji whose GB18030 form is
  // 4 bytes — outside the 2-byte table. So recovery is PARTIAL by construction. The guard only
  // needs detection; recovery is a diagnostic. Asserting the weaker true thing rather than the
  // stronger convenient one.
  it('detects the doubly-damaged one even though it cannot be fully recovered', () => {
    const rec = recoverMojibake('IP鍑虹増鍚堜綔鏂规璁ㄨ')
    expect(rec).not.toBeNull()
    expect(rec).toContain('出版合作方') // the run that survived
    expect(checkLabel('IP鍑虹増鍚堜綔鏂规璁ㄨ')).toMatchObject({ ok: false, reason: 'mojibake' })
  })
})

// The precision half. A guard that drops real labels is worse than the bug it prevents.
describe('recoverMojibake — does NOT fire on legitimate text', () => {
  for (const good of [
    '北澜',
    '林书远',
    '广州动漫游戏盛典',
    '3DM平台',
    'IP出版合作方案讨论',
    '商务双周报',
    '端午美林试玩会',
    '趣方块《白银之城》',
    'BilibiliWorld',
    'DUIN CORE',
    'Orbis Inc',
    '半导体-云帆泰克',
    'レポートを作成',
    '한국어 라벨',
    'Café Zürich',
    '',
    'plain ascii label'
  ]) {
    it(`keeps ${JSON.stringify(good.slice(0, 18))}`, () => {
      expect(recoverMojibake(good)).toBeNull()
      expect(checkLabel(good).ok).toBe(true)
    })
  }
})

describe('hasLostBytes — text that was cut mid-character', () => {
  it('flags the Unicode replacement char', () => {
    expect(hasLostBytes('高培�')).toBe(true)
    expect(checkLabel('高培�')).toMatchObject({ ok: false, reason: 'lost-bytes' })
  })
  it('flags a lone high surrogate', () => expect(hasLostBytes('abc\ud83d')).toBe(true))
  it('flags a lone low surrogate', () => expect(hasLostBytes('\udc00abc')).toBe(true))
  it('keeps a correctly paired astral char', () => {
    expect(hasLostBytes('emoji 🚀 ok')).toBe(false)
    expect(checkLabel('emoji 🚀 ok').ok).toBe(true)
  })
  it('keeps ordinary Chinese', () => expect(hasLostBytes('广州动漫游戏盛典')).toBe(false))
})

// Every string below was pulled from the live graph on 2026-08-03. The junk cases are why
// the operator noticed "so many more notes than there were previously"; the keep cases are
// what a careless filter would have deleted along with them.
describe('checkLabel — a name, or prose about a name', () => {
  it('refuses sentence fragments the extractor minted as nodes', () => {
    for (const junk of [
      'a memory upgrade for DUIN',
      'a FRESH Claude session that did NOT build DUIN',
      'many organizations including playstation, xbox, bilibili',
      'TapTap, B站, 4399, 好游快爆',
      'C:\\Users\\theo\\AppData\\Local\\Programs\\DUIN',
      'arena-first organization with cross-cutting material in DUIN/'
    ]) {
      const v = checkLabel(junk)
      expect(v.ok, `should have refused: ${junk}`).toBe(false)
      expect(v.reason).toBe('not-a-name')
    }
  })

  // The bar that matters. A guard that eats real entities is worse than the junk it removes,
  // because a missing node is invisible while a junk node is merely noisy.
  it('keeps real entities, including the awkward ones', () => {
    for (const real of [
      'DUIN',
      'B站',
      '哔哩哔哩',
      'Bilibili (B站)',
      '广州星海网络科技有限公司',
      'Bilibili Game Cooperation Dept',
      'B站「次元炼金术·跨次元营销沙龙」',
      '林书远（Theo）',
      'BilibiliWorld (BW)',
      'B站长期分成 5:5→7:3',
      // Contains "and" and "of" — both legitimate inside a proper noun, so neither is a signal.
      'Marks and Spencer',
      'Bank of China',
      // Both found as FALSE POSITIVES by running the guard over the live graph, and both are
      // real nodes. The embassy is six words with two joiners — caught by the prose rule until
      // Title Case was made to survive it. The amount's commas are thousands separators.
      'Embassy of P.R. China in Japan',
      'USD 50,000,000'
    ]) {
      expect(checkLabel(real).ok, `should have kept: ${real}`).toBe(true)
    }
  })

  it('states its own limit: CJK clauses pass, because regex cannot segment them', () => {
    // Documented in label-sanity.ts rather than pretended away. This test PINS the limit so
    // that closing it later is a visible change rather than a silent one.
    expect(checkLabel('与B站联合承办美林试玩会').ok).toBe(true)
  })
})

describe('checkLabel — contract', () => {
  it('is total: null/undefined are not a crash', () => {
    expect(checkLabel(null).ok).toBe(true)
    expect(checkLabel(undefined).ok).toBe(true)
  })
  it('is idempotent on a recovered label — the fix does not re-trip the guard', () => {
    const rec = recoverMojibake('骞垮窞鍔ㄦ极娓告垙鐩涘吀')!
    expect(checkLabel(rec).ok).toBe(true)
  })
})
