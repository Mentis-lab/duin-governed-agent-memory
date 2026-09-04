// THE ENTITY KEY: what makes two extracted nodes the same real thing. One rule, in a leaf module,
// so the construction store's convergence, the cross-batch merge and the map's duplicate fold all
// agree. Until 2026-09-03 they did not: convergence and the batch merge keyed on trim+lowercase,
// only the map stripped glosses and folded traditional→simplified, and the map ran last, so every
// variant the model produced on a re-run ("张三 (小张)", "20-80"/"2080", "示例项目 - 游戏设计与卖点") was a
// new entity kept forever. Measured on the live store: 1,479 duplicate groups, 1,740 surplus nodes.
//
// Four mechanical rules, no inference: strip an echoed id prefix, strip a parenthetical gloss, fold
// traditional→simplified for the characters this vault collides on, then keep letters and digits
// only (NFKC first, so full-width forms match their ASCII twins). This is a KEY, not a rename: the
// surviving node keeps its own display label.

/** An id-shaped string the extractor echoed back as a NAME (`'project:duin'`, `'person:theo-quill'`).
 *  It is never a real name. */
export const ID_SHAPED = /^(?:person|org|topic|project|event|decision|entity|concept|place|product):/i
/** A trailing gloss: `Acme (ACM)`, `张三 (Zhang San)` — a rendering of the SAME name, not a qualifier. */
const APPOSITIVE = /\s*[（(][^)）]*[)）]\s*$/

/** Traditional→simplified for the characters this vault actually collides on. NOT a full OpenCC
 *  table and not meant to be — a starter set, extended when a real collision shows up. */
const TRAD_SIMP: Record<string, string> = {
  慶: '庆', 國: '国', 華: '华', 東: '东', 傳: '传', 語: '语', 會: '会', 學: '学', 實: '实',
  點: '点', 開: '开', 關: '关', 專: '专', 業: '业', 產: '产', 動: '动', 發: '发', 遊: '游',
  戲: '戏', 網: '网', 電: '电', 際: '际', 龍: '龙', 鳳: '凤', 陳: '陈', 張: '张'
}

export function mergeKey(label: string): string {
  let s = String(label ?? '').normalize('NFKC').trim()
  s = s.replace(ID_SHAPED, '')
  s = s.replace(APPOSITIVE, '')
  s = s.replace(/[一-鿿]/g, (ch) => TRAD_SIMP[ch] ?? ch)
  // Letters and digits only. Measured on the live map (2026-09-03): a whitespace-only collapse
  // left 76 duplicate groups standing on nothing but punctuation and width: "Bilibili World 2026"
  // vs "BilibiliWorld 2026", "上海差旅 2026-05-18" vs "上海差旅2026-05-18", "（MES 2.0）" vs "(MES 2.0)",
  // "方案一：…" vs "方案一·…".
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** The convergence / merge key for an extracted entity: kind + the label's mergeKey. Kind stays in
 *  the key so a genuine org-vs-person collision on one surface form is left to the alias whitelist. */
export function entityKey(kind: string, label: string): string {
  return String(kind) + '\0' + mergeKey(label)
}

/**
 * Which indexed files the CONSTRUCTION pass may read. The retrieval index deliberately holds
 * DUIN's own memory projections (`.brain/memory/*`), machine state, archives and code so search can
 * reach them; entity extraction must not: it turned the brain's own memory files back into
 * "knowledge" (35 nodes on the live map extracted from `.brain/memory`, e.g. "Promoted operator
 * fact"), and code files into topics (393 store entities from `src/`, `.ts`, `.json`). Documents
 * only, and only where a person wrote them.
 */
const CODE_OR_ASSET = /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|lock|css|scss|html?|py|rb|go|rs|java|kt|swift|sh|ps1|cmd|bat|sql|csv|tsv|xml|svg|png|jpe?g|gif|webp|pdf|zip|exe|dll|node)$/i
export function isConstructionCorpusPath(p: string): boolean {
  const s = String(p ?? '').replace(/\\/g, '/')
  if (!s) return false
  if (/(^|\/)\.(brain|duin)(\/|$)/.test(s)) return false // machine state and memory projections
  if (/(^|\/)[._][^/]*\//.test(s)) return false // hidden or archive folders: `.claude/`, `_retired-from-rg/`
  if (/(^|\/)\.[^/]+$/.test(s)) return false // dotfiles
  if (CODE_OR_ASSET.test(s)) return false
  return true
}

/** A note that asks not to be read by the extractor: `duin-extract: false` in its head. */
export function noteOptsOutOfExtraction(text: string): boolean {
  return /(^|\n)\s*duin-extract\s*:\s*false\b/i.test(String(text ?? '').slice(0, 800))
}

/**
 * Per-vault fence: folders (vault-relative prefixes, `/`-separated) the extractor must not read.
 * Read from `<brain root>/.brain/state/construction-exclude.json` as `{ "folders": [...] }`.
 * The case it exists for: DUIN's own harness folders mirrored into the operator's vault
 * (dev handoffs, rules, meta, instincts, identity, templates). Measured on the live map
 * (2026-09-03): 2,968 of 4,354 extracted nodes were anchored only under `DUIN/*`, and every
 * rule file had become a "decision" node. Retrieval still indexes those notes; only entity
 * extraction stops reading them.
 */
export function pathUnderFence(p: string, folders: readonly string[]): boolean {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  for (const f of folders) {
    const g = String(f ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!g) continue
    if (s === g || s.startsWith(g + '/')) return true
  }
  return false
}
