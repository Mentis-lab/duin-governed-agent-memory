import { describe, it, expect } from 'vitest'
import { cjkTokens, hasCjk, CJK_CLASS, CJK_RANGES } from './cjk-tokens'

// Realistic strings from the operator's 39%-CJK vault (北澜 = the game, 云帆泰克 = the semiconductor
// line, 风暴模拟器 = an emulator partner) rather than toy input — the failure this fixes only shows
// up on real multi-character terms.
describe('cjkTokens — CJK runs become overlapping bigrams', () => {
  it('emits overlapping bigrams for a Chinese run', () => {
    expect(cjkTokens('北澜渠道')).toEqual(['北澜', '澜渠', '渠道'])
    expect(cjkTokens('风暴模拟器')).toEqual(['风暴', '暴模', '模拟', '拟器'])
  })

  it('never emits single characters for a multi-character run (the defect)', () => {
    const toks = cjkTokens('风暴模拟器的合作现在是什么状态')
    expect(toks.every((t) => t.length === 2)).toBe(true)
    expect(toks).not.toContain('的') // a single char is a near-stopword: df ≈ N, IDF ≈ 0
    expect(toks).toContain('风暴')
  })

  it('a Chinese query and a Chinese document share tokens (the whole point)', () => {
    const q = new Set(cjkTokens('云帆泰克的董事长是谁'))
    const doc = new Set(cjkTokens('云帆泰克董事长赵慕青，负责封测业务'))
    const shared = [...q].filter((t) => doc.has(t))
    expect(shared).toEqual(expect.arrayContaining(['云帆', '帆泰', '泰克', '董事', '事长']))
  })

  it('a lone CJK character (a one-char run) stands alone — there is no pair to form', () => {
    expect(cjkTokens('钱')).toEqual(['钱'])
    expect(cjkTokens('花 钱 了')).toEqual(['花', '钱', '了'])
  })
})

describe('cjkTokens — run boundaries', () => {
  it('does NOT let a bigram span punctuation or a sentence boundary', () => {
    expect(cjkTokens('北澜。渠道')).toEqual(['北澜', '渠道']) // never 月渠
    expect(cjkTokens('北澜、渠道')).toEqual(['北澜', '渠道'])
    expect(cjkTokens('北澜，渠道；进展')).toEqual(['北澜', '渠道', '进展'])
    expect(cjkTokens('《北澜》渠道')).toEqual(['北澜', '渠道'])
  })

  it('splits CJK from Latin/numeric rather than swallowing it into one run', () => {
    expect(cjkTokens('北澜 TapTap 渠道')).toEqual(['北澜', 'taptap', '渠道'])
    expect(cjkTokens('云帆泰克/YUNFAN 深圳')).toEqual(['云帆', '帆泰', '泰克', 'yunfan', '深圳'])
    // A bare "4" is a 1-char Latin/numeric run ⇒ dropped by the default minLatin: 2 (unchanged from
    // the tokenizer this replaces). A CJK run of the same length is NOT dropped — 号馆 survives.
    expect(cjkTokens('BilibiliWorld 北澜4号馆')).toEqual(['bilibiliworld', '北澜', '号馆'])
    expect(cjkTokens('BilibiliWorld 北澜4号馆', { minLatin: 1 })).toEqual(['bilibiliworld', '北澜', '4', '号馆'])
    expect(cjkTokens('厦门 4399 好游快爆')).toEqual(['厦门', '4399', '好游', '游快', '快爆'])
  })

  it('treats the katakana middle dot as a separator but keeps the long-vowel mark', () => {
    expect(cjkTokens('ソーシング・プラットフォーム')).toEqual([
      'ソー', 'ーシ', 'シン', 'ング', 'プラ', 'ラッ', 'ット', 'トフ', 'フォ', 'ォー', 'ーム'
    ])
  })

  it('bigrams Japanese kanji the same way (佐藤千夏 / 取締役)', () => {
    expect(cjkTokens('佐藤千夏 取締役')).toEqual(['佐藤', '藤千', '千夏', '取締', '締役'])
  })
})

describe('cjkTokens — Latin/numeric behaviour', () => {
  it('keeps whole lowercased words of length ≥ minLatin (default 2)', () => {
    expect(cjkTokens('a hi the')).toEqual(['hi', 'the'])
    expect(cjkTokens('a hi the', { minLatin: 1 })).toEqual(['a', 'hi', 'the'])
    expect(cjkTokens('The GR-90 Trail', { minLatin: 1 })).toEqual(['the', 'gr', '90', 'trail'])
  })

  it('drops stopwords when a stop set is supplied, and only then', () => {
    const stop = new Set(['the', 'of'])
    expect(cjkTokens('the cost of 北澜', { stop })).toEqual(['cost', '北澜'])
    expect(cjkTokens('the cost of 北澜')).toEqual(['the', 'cost', 'of', '北澜'])
  })

  it('a stop set never removes a CJK bigram (a bigram is not an English word)', () => {
    expect(cjkTokens('北澜的合作', { stop: new Set(['the', '北澜']) })).toEqual(['北澜', '澜的', '的合', '合作'])
  })

  it('keeps duplicates and order — BM25 needs term frequencies', () => {
    expect(cjkTokens('北澜 北澜')).toEqual(['北澜', '北澜'])
  })

  it('handles empty / nullish input', () => {
    expect(cjkTokens('')).toEqual([])
    expect(cjkTokens(undefined as unknown as string)).toEqual([])
    expect(cjkTokens('、。 —— !!')).toEqual([])
  })
})

describe('hasCjk', () => {
  it('detects un-delimited script, ignores Latin and CJK punctuation', () => {
    expect(hasCjk('北澜')).toBe(true)
    expect(hasCjk('mixed 云帆泰克 text')).toBe(true)
    expect(hasCjk('ソーシング')).toBe(true)
    expect(hasCjk('plain ascii 123')).toBe(false)
    expect(hasCjk('')).toBe(false)
  })
})

// Halfwidth katakana (U+FF66–FF9F) is the ONE range the localization branch's rival character class
// had that this tokenizer lacked. It is legacy-but-real Japanese (CSV exports, older business
// systems), and without it a halfwidth-kana run tokenizes to nothing at all.
describe('cjkTokens — halfwidth katakana', () => {
  it('bigrams a halfwidth-katakana run instead of dropping it', () => {
    expect(cjkTokens('ｶﾀｶﾅ')).toEqual(['ｶﾀ', 'ﾀｶ', 'ｶﾅ'])
    expect(hasCjk('ｿｰｼﾝｸﾞ')).toBe(true)
  })

  it('keeps the halfwidth voiced mark inside the syllable, not as a separator', () => {
    // ﾞ (U+FF9E) is part of ｸﾞ (gu); excluding it would split the run and lose the pairing.
    expect(cjkTokens('ｶﾞｲﾄﾞ')).toEqual(['ｶﾞ', 'ﾞｲ', 'ｲﾄ', 'ﾄﾞ'])
  })

  it('treats halfwidth CJK punctuation (U+FF61–FF65) as a separator', () => {
    // ｡ and ･ are punctuation, not letters — a bigram must never span them.
    expect(cjkTokens('ｶﾅ･ｶﾅ')).toEqual(['ｶﾅ', 'ｶﾅ'])
    expect(cjkTokens('ｶﾅ｡ｶﾅ')).toEqual(['ｶﾅ', 'ｶﾅ'])
  })
})

// CJK_CLASS is open-coded twice (a regex class body for the ~15 slug/split sites, explicit numeric
// comparisons in the hot-path `isCjkCode`). This proves the two can never drift.
describe('CJK_CLASS ≡ the tokenizer’s notion of a CJK letter', () => {
  const classRe = new RegExp(`^[${CJK_CLASS}]$`)

  it('agrees with hasCjk on every code point in the BMP', () => {
    const disagreements: string[] = []
    for (let c = 0; c <= 0xffff; c++) {
      // Lone surrogates are not characters; skip them rather than compare garbage.
      if (c >= 0xd800 && c <= 0xdfff) continue
      const ch = String.fromCharCode(c)
      if (classRe.test(ch) !== hasCjk(ch)) disagreements.push(c.toString(16))
    }
    expect(disagreements).toEqual([])
  })

  it('contains no regex metacharacter that would corrupt a spliced class', () => {
    expect(CJK_CLASS).not.toMatch(/[\\\]^]/)
    // Every range renders as `lo-hi`, so the body is exactly 3 chars per range.
    expect(CJK_CLASS.length).toBe(CJK_RANGES.length * 3)
  })

  it('is usable as a negated slug class that preserves CN and JP alike', () => {
    const strip = new RegExp(`[^a-z0-9${CJK_CLASS}]+`, 'g')
    const slug = (s: string) => s.toLowerCase().replace(strip, '-').replace(/^-+|-+$/g, '')
    expect(slug('北澜发行')).toBe('北澜发行') // CN never regressed
    expect(slug('レポートを作成する')).toBe('レポートを作成する') // kana: the fix
    expect(slug('まとめ')).not.toBe('') // used to collapse to the shared fallback id
    expect(slug('Hello 世界 / test')).toBe('hello-世界-test')
    // The middle dot is a separator here too, so it splits rather than joining.
    expect(slug('SEGA向け・星辰発行')).toBe('sega向け-星辰発行')
  })
})
