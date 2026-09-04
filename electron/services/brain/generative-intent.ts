// generative-intent — detects a "compose a document as the answer" request: the class the
// tool-biased chat loop mishandles. Asked to "write a complete structured document", the
// write_file-biased model (its tool description commands "ACTUALLY save… never merely
// describe") treats it as a file-authoring task, churns through search-tool rounds emitting
// only a narration preamble, and never composes the document (recorded in the
// operator's own card store, not cited here). Such a request wants PROSE in the
// chat, not a saved file — so the server routes round 0 tools-off (prose-first). The retrieval
// step runs BEFORE the tool loop and injects vault context, so the model composes from
// grounding in one pass instead of churning.
//
// The detector is deliberately conservative: it requires a compose verb AND a document-shaped
// object, and it SUPPRESSES when the phrasing signals a real file/persistence operation (the
// user genuinely wants an artifact written to disk — keep the tools). PURE.

// Compose verbs — English word-boundaried; CJK matched directly (no word boundaries in Chinese or
// Japanese). JP adds 作成 (create) / 書く・書いて (write) / まとめ (compile); 生成 and 整理 are shared
// with Chinese and already covered.
const GEN_VERB =
  /\b(write|draft|compose|generate|produce|create|put together|prepare|author)\b|撰写|编写|起草|草拟|拟定|拟写|生成|写一?[一份个篇章]|做一?[一份个]|整理(?:成|一?份)|作成|書[いく]|まとめ/i
// The CJK half must carry the operator's OWN recurring artifact names, not just the
// dictionary nouns. `报告` does not match 双周报 / 周报 / 月报 — those end in a bare 报 —
// so the highest-stakes recurring artifact in the vault (双周报, with its own output
// convention note) fell through to the tool loop while the English "biweekly report"
// routed prose-first. Measured live 2026-08-02 against the deployed build, same request
// in both languages: EN → 1 tool call, prose, clean terminal at 51s; ZH → 20 tool calls,
// 31.7k reasoning chars, no terminal frame at 240s, and the document written silently to
// a vault file instead of streamed. The period prefixes are enumerated rather than a bare
// `报` so 情报 / 报名 / 汇报对象 do not become document objects.
const GEN_OBJECT =
  /\b(document|report|doc|essay|plan|spec(?:ification)?|proposal|memo|summary|brief|outline|analysis|write[-\s]?up|article|letter|overview|breakdown|guide|walkthrough|whitepaper|narrative|section|chapter|draft)\b|文档|文稿|草稿|报告|(?:双周|周|月|日|季|年|半年)报|汇报|简报|汇总|文章|方案|计划书?|规划|规格|提案|备忘录?|总结|摘要|概要|大纲|纲要|分析|说明书?|指南|概述|综述|纪要|白皮书|清单|レポート|資料|企画書?|提案書|報告書|議事録|仕様書|ドキュメント|文書/i

// File / persistence signals — the user wants an artifact SAVED or an existing file edited, so
// the tool loop (write_file/edit_file/render_artifact) is genuinely wanted. These suppress
// prose-first so we never regress a real file-authoring request into a chat-only answer.
// NARROWED 2026-08-03. Two alternatives were over-broad and suppressed prose-first on requests
// that only MENTIONED a file rather than asking for one:
//   - a bare `\.(md|txt|…)` matched any filename anywhere, so citing a spec ("参考 _双周报输出约定.md")
//     routed the highest-stakes recurring artifact in the vault back into the tool loop. It now
//     requires a persistence verb AND a DESTINATION preposition before the path. Proximity alone
//     was not enough: "write a summary of what CLAUDE.md says" has the verb 25 chars from the
//     extension and is still a mention. What separates the two is "to/into/as/at" — a destination
//     is what makes it persistence, so "write the analysis to notes/analysis.md" stays suppressed.
//   - a bare `\bfile\b` matched "the spec file", "which file has the numbers". It now requires a
//     determiner immediately before it, which still catches "create a file …".
// Everything below is an explicit persistence phrase and is left exactly as it was.
const FILE_SIGNAL =
  /\b(save|to disk|onto disk|write to|save (?:it|this|that|the\b)|into the vault|create a file|save as|new file|append to|edit (?:the|my|this)|update the|render)\b|\b(?:a|the|this|new|to a|into a)\s+file\b|\b(?:write|save|export|put|dump|output|append)\b[^\n]{0,30}?\b(?:to|into|as|at)\s+\S{0,60}?\.(?:md|txt|html?|csv|json|ya?ml)\b|文件|保存|存到|写入|存为|另存|存盘|ファイル|書き込[みむ]|ディスク/i

/** True when the query reads as "compose a document as the answer" and NOT a file operation.
 *  Language-agnostic: fires on English or CJK compose-a-document phrasing. */
export function looksLikeGenerativeWrite(query: string): boolean {
  if (!query || query.trim().length < 4) return false // CJK requests ("生成方案") are short but dense
  if (FILE_SIGNAL.test(query)) return false
  return GEN_VERB.test(query) && GEN_OBJECT.test(query)
}

/** Prose-first routing is on by default (it's the fix); disable with DUIN_GENERATIVE_PROSE_FIRST=0. */
export function generativeProseFirstEnabled(): boolean {
  const v = (process.env.DUIN_GENERATIVE_PROSE_FIRST ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}
