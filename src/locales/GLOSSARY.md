# DUIN localization glossary — 中文 / 日本語

The terms that must be translated **the same way every time**. A UI can survive an awkward
sentence; it cannot survive `Brain` being 大脑 on one screen and 头脑 on the next, because
the user stops believing the two screens are the same feature.

Settle this file first. Everything in `zh.json` / `ja.json` is downstream of it.

## How these were chosen

Three rules, applied in order:

1. **Keep the English where the English IS the name.** Product and protocol names (MCP,
   RAG, GitHub, API) are not translated in Chinese or Japanese software either. Translating
   them makes a product look amateur and makes its docs unsearchable.
2. **Translate the concept, not the word.** `Brain` is not 大脑 (the organ). It is the
   thing that remembers and reasons over your notes, so zh label 知识大脑; ja label ブレイン
   (ナレッジブレイン survives only as the first-run gloss — locale-native lengths differ).
3. **Japanese: katakana for imported concepts, kanji for actions.** This is the convention
   users expect. ワークスペース, not 作業空間. But 削除 for delete, not デリート.

## Core product nouns

| English | 中文 | 日本語 | Note |
|---|---|---|---|
| DUIN | DUIN | DUIN | Never translated. Product name. |
| Brain | 知识大脑 | ブレイン | Not 大脑/頭脳 — those are the organ. ja nav uses short ブレイン; ナレッジブレイン only as first-run gloss. Possessive prose: 你的大脑 / あなたのブレイン. |
| Vault | 笔记库 | 保管庫 | The notes folder. Changed 2026-08-23: 知识库/ナレッジベース is what this audience's other AI products call the ingested-doc RAG store (= DUIN's Library) — keeping it inverted expectations. 笔记库 says what it is; 保管庫 is Obsidian-JP's own word. |
| Workspace | 工作区 | ワークスペース | The directory the agent acts in. Distinct from Vault — keep them visibly different. |
| Chat | 对话 | チャット | |
| Session | 会话 | セッション | |
| Project | 项目 | プロジェクト | |
| Library | 资料库 | ライブラリ | Ingested documents. Not 图书馆. |
| Memory | 记忆 | メモリ | |
| Skill | 技能 | スキル | |
| Method | 方法 | メソッド | A saved procedure. |
| Workflow | 工作流 | ワークフロー | |
| Automation | 自动化 | 自動化 | |
| Connector | 连接器 | コネクタ | An MCP server. |
| Channel | 通道 | チャネル | Discord/Feishu etc. NOT 频道 — that reads as a TV channel. |
| Agent | 智能体 | エージェント | An external agent driving DUIN. |
| Plugin | 插件 | プラグイン | |
| Hook | 钩子 | フック | |
| Snip | 剪藏 | スニップ | Web clipping. 剪藏 is the established CN term. |
| Artifact | 制品 | アーティファクト | |
| Canvas | 画布 | キャンバス | |
| Note | 笔记 | ノート | |
| Graph | 图谱 | グラフ | Knowledge graph = 知识图谱 / ナレッジグラフ. |
| Entity | 实体 | エンティティ | |

## Not translated

`MCP` · `RAG` · `API` · `GitHub` · `OAuth` · `token` (as API token: トークン / 令牌 only in prose) ·
`Markdown` · `JSON` · `URL` · `PDF` · `OCR` · model names (`DeepSeek`, `Claude`, `GPT`)

Rationale: these are how users search for help. A Chinese developer looking for MCP setup
searches "MCP", not "模型上下文协议".

## Actions

| English | 中文 | 日本語 |
|---|---|---|
| New chat | 新建对话 | 新規チャット |
| Send | 发送 | 送信 |
| Stop | 停止 | 停止 |
| Retry | 重试 | 再試行 |
| Save | 保存 | 保存 |
| Cancel | 取消 | キャンセル |
| Delete | 删除 | 削除 |
| Remove | 移除 | 除外 | ja changed 2026-08-23: Delete/Remove both 削除 hid a destructiveness difference (destroy vs detach). |
| Edit | 编辑 | 編集 |
| Add | 添加 | 追加 |
| Close | 关闭 | 閉じる |
| Dismiss | 忽略 · 不采纳 · 暂缓 | 消去 · 不採用 · 保留 | Three mechanics — see Governance & decision verbs. ja 閉じる retired (implied no state change). |
| Open | 打开 | 開く |
| Search | 搜索 | 検索 |
| Copy | 复制 | コピー |
| Replace | 替换 | 置換 | ja: 検索と置換 pair; 置き換え only in file-conflict prose. |
| Import | 导入 | インポート |
| Export | 导出 | エクスポート |
| Install | 安装 | インストール |
| Enable / Disable | 启用 / 停用 | 有効 / 無効 | ja action BUTTONS take 〜化 (有効化/無効化); 有効/無効 stay the state words. |
| Approve / Deny | 批准 / 拒绝 | 許可 / 拒否 | ja changed 2026-08-23: 許可 is the OS-permission idiom; 承認 is reserved for Ratify (see Governance). |
| Confirm (dialog button) | 确认 | OK | ja 確認 means "review it", not "do it" (destructive commits: 実行). 確認/確認済み reserved for the govern loop's automatic verification. |
| Connect / Disconnect | 连接 / 断开 | 接続 / 切断 |

## Governance & decision verbs (added 2026-08-22 · 日本語 + language-pass fixes 2026-08-23)

Four mechanics that English smears across near-synonyms. They must stay four words in each
locale, or the product's core distinction — "the system verified it" vs "you sanctioned it" —
collapses. The ja scheme deliberately moves the generic Approve to 許可 (the OS-permission
idiom) so 承認 (the sign-off of prepared work) is free for Ratify.

| English | 中文 | 日本語 | Mechanic / where |
|---|---|---|---|
| Ratify | 核准 | 承認 | A human lands a STAGED system change (loop iteration, RSI self-tune, keyless belief) |
| Approve / Deny | 批准 / 拒绝 | 許可 / 拒否 | A human OKs a proposal BEFORE it runs (tool call, plan, cascade, pairing) |
| Confirm (mechanic) | 确认 | 確認 | The govern loop's AUTOMATIC verification — never a human act. Display of the resulting fact status diverges by locale: zh 已转正 (because zh keeps 确认 as the human dialog button), ja 確認済み (safe because ja's dialog button is OK) |
| Promote (button) | 采纳 | 採用 | Endorse a candidate INTO probation (candidate → provisional) — not graduation |
| Dismiss | 忽略 · 不采纳 · 暂缓 | 消去 · 不採用 · 保留 | THREE mechanics: generic notice dismiss; RSI dismiss (terminal, never re-asked); loop-ratify defer |
| Revert / rolled-back / Undo | 回退 / 已回滚 / 撤销 | 差し戻し / ロールバック済み / 元に戻す | Govern demotion / RSI automatic rollback / operator undo — keep distinct |
| Veto(ed) | 否决 / 已否决 | 却下 / 却下済み | Operator strikes a fact down (rendered status; the quiet UI link "remove" = 移除 / 除外) |
| Staged (governor) | 待核准 | 承認待ち | Ran-but-held for ratification. NEVER 暂存 / ステージ — those are git's words |
| Staged (git) | 已暂存 | ステージ済み | Git index staging, industry-locked |
| Hold / Held (jury-held output) | 暂扣 / 已暂扣 | 差し止め / 差し止め中 | Output withheld pending decision ("Held by the jury" = 由评审团暂扣 / 審査員により差し止め中). ONE word — the earlier 已搁置 variant is retired |
| Breaker rung "Held — will not act" | 已冻结 | 凍結中 | Capability freeze inside the 熔断/ブレーカー metaphor — deliberately NOT the jury word |
| — your call | ——你来定 | — 決めるのはあなた | Card-title suffix. "Make the call" = 拍板 / あなたが決める; "the call is yours" = 决定权在你 / 決定権はあなたにあります |
| Needs you | 需要你 | あなたの出番 | Family: "Waiting on you" = 等你定夺 / あなたの判断待ち; "A loop needs attention" = 一个循环需要你 / ループがあなたを待っています. Never 需要关注/请注意 / 要確認 |

The 暂-family, documented so nobody adds a seventh: 待核准 (staged) · 暂缓 (defer) · 暂扣
(jury hold) · 已暂存 (git) · 已暂停 (paused) · 已冻结 (breaker rung). Each is one mechanic.

## Domain vocabulary (added 2026-08-22 · 日本語 2026-08-23)

| English | 中文 | 日本語 | Note |
|---|---|---|---|
| second brain | 第二大脑 | セカンドブレイン | The concept, set in onboarding. Label noun: zh 知识大脑, ja ブレイン (locale-native; ナレッジブレイン only as first-run gloss). Possessive prose "your brain" = 你的大脑 / あなたのブレイン, never 脑/脳 alone |
| belief / fact / claim | 信念 / 事实 / 断言 | 信念 / 事実 / 主張 | Three different objects. Never collapse; ja never クレーム |
| taste | 品味 | 好み | "Compiled from your verdicts" = 由你的裁定汇编 / あなたの裁定から学習 |
| judgment | 判断力 | 判断力 | Never 判决 / 判決 |
| grounding / grounded | 溯源 / 基于（你的）笔记 | 出典 / あなたのノートに基づく | |
| foresight / forecast | 前瞻 / 预测 | 先読み / 予測 | 前瞻/先読み = the faculty; one item = 预测/予測 |
| calibration | 校准 | キャリブレーション | |
| verdict verbs | 判定（预测）/ 裁定（品味·回合） | 判定 / 裁定 | One EN word "verdict", two mechanics: forecasts get 判定, taste/turn verdicts get 裁定. Never swap |
| earned autonomy | 实绩自主（权） | 実績による自律 | Prose 自主权需靠实绩赢得 / 自律は実績で勝ち取る; "trust not yet earned" = 信任尚未赢得 |
| self-tune | 自我调优 | 自己チューニング | Card: DUIN 提议一次自我调优——你来定 / DUIN が自己チューニングを提案 — 決めるのはあなた |
| jury | 评审团 | 審査員 | Not 陪审团 / 陪審 (courtroom) |
| survival / survived N sessions | 存活 / 已历经 N 次会话 | 存続 / {n}セッション存続 | Bar prose: 已达存活门槛 |
| provisional / candidate | 试用中 / 候选 | 試用中 / 候補 | Header "Recently learned — proving out" = 新学到 · 考察中 / 新しく学んだこと — 見極め中 |
| digest / morning brief / EOD reconciliation | 摘要（每日摘要）/ 晨报 / 日终盘点 | デイリーダイジェスト / 朝のブリーフィング / 一日の棚卸し | ja: never bare ブリーフ (underwear). zh: no fourth word — "your brief" refers to the artifact by name (你的晨报) |
| capability breaker / re-arm | 能力熔断 / 重新启用 | 機能ブレーカー / 再投入 | 再投入 = the electrician's word; never 重新武装 / 再武装 |
| principal / plane | 主体 / 权限面 | プリンシパル / 権限プレーン | Keep with gloss on first use |
| cascade | 连锁项 / 连锁影响 | 波及 / 波及効果 | |
| fleet (shared goal plane) | 编队 | フリート | Goal actions render mapped: complete = 完成 / 完了, abort = 中止 / 中止 — never the raw enum |
| Fork / Lineage | 分叉 / 来源链 | フォーク / 系譜 | Not GitHub 复刻; ja not 来歴 (one char from 履歴) |
| Reasoning / Thinking | 推理 / 思考中 | 推論 / 思考中 | ja NEVER 推理 (detective fiction). zh 推理 = the trace/effort noun only |
| moat | —（不出现） | —（記憶バックアップ） | UI renders 记忆备份 / "Restore…" = 从备份恢复记忆 / バックアップから記憶を復元 |
| Tags / Labels (graph captions) | 标签 / 标注 | タグ / ラベル | zh needs the split; ja gets it free |
| link (graph edge / [[wikilink]] / hyperlink) | 连接 / 链接 / 链接 | つながり / リンク / リンク | |
| forecast verdicts | 命中 / 落空 / 作废；已成真 / 已避免 / 已证伪 / 未命中 / 未观测 | 的中 / 外れ / 対象外；現実化 / 回避済み / 反証済み / 不的中 / 未観測 | "materialized" count chips use 成真 {n} — never a second word (应验 retired) |
| decision self-verdict | 对 / 错 / 部分对 | 正解 / 不正解 / 一部正解 | right/wrong/partial |
| ingest | 收录（内容进大脑）/ 入库（Library·RAG 流水线）| 取り込み / インジェスト | zh "indexed/indexing" status labels stay 已索引/索引中. Never 摄取/摄入/采集 / 摂取 |
| Explorer (tool) | 探索 | — | Never 浏览器; ja pending native pass |
| Review (code tool) / review (GitHub PR) | 审查 / 评审 | レビュー | zh splits the two objects; ja uses one word safely |
| Auto Review (permission mode) | 自动审批 | 自動レビュー | Settles tool calls automatically (approve-or-deny); zh 自动审查 retired — collided with the Review tool |
| pin | 置顶（列表）/ 固定（记忆）/ 钉为章节 | ピン留め / 固定 / チャプターに固定 | Three surfaces, deliberate |
| embedder / embedding / chunk / rerank | 嵌入模型 / 向量化 / 分块 / 重排序 | — | RAG vocabulary; ja pending native pass |
| steer (a running turn) | 插话 | — | ja pending native pass |
| after action | 复盘 | 振り返り | The panel + report |
| event spine | 事件主线 | — | Audit timeline; ja pending |
| attended / unattended | 有人值守 / 无人值守 | — | Autonomy prose; ja pending |
| Library (Workflows tab, capabilities) | 能力库 | スキルライブラリ | DISTINCT from the documents Library = 资料库 / ライブラリ. Long-term: rename the EN key so one string stops meaning two things |
| Brain status (hub tab) | 大脑状态 | — | Documented exception to the 知识大脑 label rule — in-brain context tab, width-bound |

## Enum values that reach the UI (2026-08-22 · ja + fixes 2026-08-23)

These render RAW today. The columns below are the display maps an engineering pass must add —
never translate the stored values. Render-site punch list: `PLANNING/DUIN_LOCALIZATION_SURFACE_MAP.md`.

| Enum | Values → 中文 → 日本語 |
|---|---|
| Fact status | candidate 候选 候補 · provisional 试用中 試用中 · promoted 已转正 確認済み (locale-divergent — see Confirm row) · vetoed 已否决 却下済み · reverted 已回退 差し戻し済み |
| Loop status | running 运行中 実行中 · paused 已暂停 一時停止中 · stopped 已停止 停止済み · done 已完成 完了 · error 出错 エラー |
| Loop mode | interval 定时 定期 · self_paced 自定节奏 自己ペース (the loop sets its own pace) · autonomous 自主 自律 |
| Backlog status | pending 待处理 未処理 · in_progress 进行中 処理中 · done 已完成 完了 · skipped 已跳过 スキップ済み · error 出错 エラー · awaiting-ratification 待核准 承認待ち |
| RSI change status | proposed 已提议 提案済み · applied 已应用 適用済み · kept 已保留 定着 · rolled-back 已回滚 ロールバック済み · dismissed 不采纳 不採用 |
| Forecast kinds | driver 驱动因素 駆動要因 · convergence 汇聚 合流 · cascade 连锁影响 波及 · decision-window 决策窗口 決断ウィンドウ · anchor-risk 锚点风险 アンカーリスク · forecast 预测 予測 · deadline-collision 截止日冲突 締め切り衝突 · chain-slippage 链式延误 連鎖遅延 |
| Notice severity | info 提示 情報 · warning 值得留意 注意 (2026-08-23: was 值得一看 — keeps the warmth, adds the direction) · error 失败 失敗 (the display word is "Failed") |
| Provenance | declared 已声明 明示 · inferred 推断 推定 · ambiguous 存疑 曖昧 |
| MCP status | disconnected 未连接 未接続 · connecting 连接中 接続中 · connected 已连接 接続済み · error 出错 エラー |
| Principal status | active 已启用 有効 · paused 已暂停 一時停止中 · revoked 已吊销 失効済み |
| Loop stop reasons (chips) | max-iterations 达迭代上限 · max-wallclock 达时长上限 · token-budget 预算用尽 · model-stop 模型停止 · backlog-empty 队列已空 · disk-low 磁盘不足 · awaiting-ratification 待核准 · autonomy-not-earned 自主权尚未赢得 · reconcile-divergence 记录与实际不一致 · no-approval-channel 无审批通道 (tail accepts free text — untranslatable) |
| Escalation reasons | stalled 停滞 停滞 · repeated-failure 反复失败 失敗の繰り返し · budget-breach 超预算 予算超過 · resource-exhaustion 资源告急 リソース保護 · approval-timeout 审批超时 承認タイムアウト · permanent-error 永久错误 回復不能なエラー · turn-incomplete 单轮未完 ターン未完 · verify-failed 校验未过 検証失敗 |
| Fleet goal actions | complete 完成 完了 · abort 中止 中止 |

## Formats & counts (2026-08-22 · ja + rules 2026-08-23)

**中文**
- Relative time templates: 刚刚 · {n} 分钟前 · {n} 小时前 · {n} 天前 · {n} 分钟后 · 已到期 ·
  从未. Future marker is a suffix — template, not word substitution. Seven duplicate `ago()`
  implementations exist; localize once, share.
- Plurals: delete `s`-ternaries; measure words per noun: {n} 项等你定夺 · {n} 条信念/规则 ·
  {n} 篇笔记 · {n} 个实体/智能体 · {n} 次（工具调用、{n}×）· 第 {n} 轮.
- Quotes: 「」 for every quoted UI label, note title, or search term in zh prose; ASCII
  straight quotes only inside untranslated code/paths. Single … always (never ……). No trailing
  。 on labels; fullwidth ，；：（）？ in prose — halfwidth only inside untranslatable tokens
  (`n={N}`, `{a}/{b}`, paths, cron, YES/NO).
- Toast register rule: read-path errors = 无法加载/读取{对象}; mutation errors = {动作}{对象}失败{：原因};
  missing capability = {组件}不可用/缺失.
- Digits, %, fractions, confidence 0.85: keep halfwidth as-is.

**日本語**
- Relative time: たった今 · {n}分前 · {n}時間前 · {n}日前 · {n}分後 · {n}時間後 · 期限切れ ·
  未実行 (for last-run "Never"; frequency pickers keep なし). No space between digit and counter.
- Counters: {n}件 (notices, facts, rules, notes) · {n}回 (runs, tool calls) · {n}個 (entities) ·
  {n}人 (people) · {n}周目 (loop rounds). "N waiting on you" = 判断待ち {n}件.
- Punctuation: 。 on full sentences (including inside 「…。」 when quoting a full sentence);
  none on labels/fragments; quoted UI terms take none (「保存」をクリック). Avoid ！ (brand
  voice). Buttons are bare nouns; action buttons may take 〜化 (有効化/無効化) while 有効/無効
  stay the state words.
- Register: です/ます in sentences; direct, no politeness inflation.

**Both locales**
- Reply tokens are ENGLISH-LOCKED: channel approvals parse yes/no only — copy must keep
  回复 YES / NO（大写原文） · YES / NO（半角大文字）で返信してください until the parser
  accepts 同意/拒绝 · はい/いいえ (code change).
- Never translate: `duin://` deep links, API routes in copy (`POST /state/forecast-verdict`),
  env vars (`DUIN_ACTION_REVIEWER=0`), RSI diff keys/values (`namedSkillTopK: 3 → 1`),
  plane names (`goals.write`), cron expressions, keyboard keys, file/dir names (`.duin/`,
  `SOUL.md`, `lamprey.db.pre-restore-<timestamp>`), badge chips (RAG/PDF/FILE/MEM/MCP),
  git status letters U/M/A/D/R.

## Settings sections

| English | 中文 | 日本語 |
|---|---|---|
| Settings | 设置 | 設定 |
| Essentials | 基础 | 基本 |
| General | 通用 | 一般 |
| Personality | 个性 | パーソナリティ |
| Foundations | 基石 | 基盤 | Changed 2026-08-23: 基础设定 was indistinguishable from Essentials 基础 in the same sidebar; ファウンデーション read as makeup. |
| Brain (settings tab / nav paths) | 知识大脑 | ブレイン | Paths render 设置 → 知识大脑. |
| Customize | 自定义 | カスタマイズ | Paths render 「自定义 → 技能」. |
| Activity (Automations hub tab) | 运行记录 | 実行履歴 | Changed 2026-08-23: the tab is a run log; 活动/アクティビティ read as events. |
| Connections | 连接 | 接続 |
| Notifications | 通知 | 通知 |
| Models | 模型 | モデル |
| API Keys | API 密钥 | API キー |
| Appearance | 外观 | 外観 |
| Shortcuts | 快捷键 | ショートカット |
| Permissions | 权限 | 権限 |
| Advanced | 高级 | 詳細設定 |
| Coding Mode | 编程模式 | コーディングモード |
| Web Tools | 网页工具 | Web ツール |
| Image Gen | 图像生成 | 画像生成 |
| Plans & Goals | 计划与目标 | プランと目標 |
| Engine | 引擎 | エンジン |
| Persistence | 持久化 | 永続化 |
| Full Disk Access | 完全磁盘访问权限 | フルディスクアクセス | macOS's own term — must match Apple's wording exactly or users cannot find the pane. |

## Status words

| English | 中文 | 日本語 |
|---|---|---|
| Loading… | 加载中… | 読み込み中… |
| Saving | 保存中 | 保存中 |
| Connected | 已连接 | 接続済み |
| Disconnected | 未连接 | 未接続 |
| Enabled / Disabled | 已启用 / 已停用 | 有効 / 無効 |
| Granted / Not granted | 已授权 / 未授权 | 許可済み / 未許可 |
| Failed | 失败 | 失敗 |
| Error | 错误 | エラー |
| Warning | 警告 | 警告 |
| Unknown | 未知 | 不明 |
| Never | 从未 | なし / 未実行 | ja: 未実行 for last-run fields (なし loses the temporal sense); なし only in frequency pickers. |
| Today / Yesterday | 今天 / 昨天 | 今日 / 昨日 |

## Tone

**中文** — 简体. Address the user as 你, not 您: DUIN is a personal tool, and 您 makes it
read like enterprise software. No trailing 。 on button labels or short UI fragments.

**日本語** — です/ます throughout. Buttons and labels are bare nouns (保存, 削除), never
imperative verb forms (保存しろ). No 。 on labels; keep it on full sentences in help text.

**Both** — DUIN is direct and unfussy in English. Do not add politeness the original does
not have; a hedged Japanese translation of a blunt English sentence changes the product's
character.

## Layout risk

CJK text is typically **60–70% the width** of its English source, but a few terms invert
that: `Full Disk Access` → `完全磁盘访问权限` is longer. The places to check after
translating are the settings sidebar (fixed width), button rows that already sit tight,
and the composer's model/effort chips.
