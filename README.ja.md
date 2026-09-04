# DUIN

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語**

### あなたの信頼を勝ち取るエージェント。

**あなたが動かすエージェントは、自分でメモリを書き、自分の判断力を自分で採点し、自分で権限を要求します。DUIN は、その三つすべてを実績で勝ち取らせるエージェントハーネス（harness）です。しかもすべては、あなた自身のファイルの中に残ります。**

DUIN は個人用エージェントのためのオープンなハーネスです。長期メモリ、あなたの世界の動くモデル、そしてエージェントが何をしてよいかのルール。そのすべてを、あなた自身のフォルダに Markdown として置き、一歩ごとに統治します。メモリも自律性も、どちらも勝ち取るものです。事実は記録される時点で「あなたが言ったこと」か「モデルが推測したこと」としてラベル付けされ、複数のセッションを経て検証されてからルールになります。エージェントは、ノートの外側に手を伸ばす前に必ずあなたに尋ねます。ローカルで動作し、MIT ライセンス、アカウント不要。

[ダウンロード](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest) · [ハーネス](#ハーネス) · [Claude Code と](#すでに使っているエージェントと) · [はじめかた](docs/getting-started.md) · [アーキテクチャ](docs/architecture.md) · [FAQ](docs/faq.md) · [Discussions](https://github.com/Mentis-lab/duin-governed-agent-memory/discussions) · [セキュリティ](SECURITY.md)

[![CI](https://github.com/Mentis-lab/duin-governed-agent-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Mentis-lab/duin-governed-agent-memory/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Mentis-lab/duin-governed-agent-memory)](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/hero.gif" alt="ブレインマップを拡大・縮小し、エクスプローラーで DUIN のノートを選び、その文脈のまま尋ねる" width="100%" />
</p>
<p align="center"><sub>作者自身の保管庫、約 1,200 件のノートの実録です。ブレインマップを拡大して戻し、エクスプローラーを DUIN のノートに絞って開き、その文脈のまま尋ねます——入力欄に<em>文脈を保ったまま質問</em>と出、答えはそのノートに接地します。回答は DeepSeek V4 Flash。この録画ではマップのラベルをオフにしています。</sub></p>

**0.1、最初の公開リリース。** 粗い部分と、それぞれの計画：[#10](https://github.com/Mentis-lab/duin-governed-agent-memory/issues/10)。次は、自動更新付きの署名済みインストーラー、Ollama のカスタムエンドポイント、1 ターンあたりの上限額。

---

## できること

| できること | 内容 | 必要なもの |
|---|---|---|
| **場所を勝ち取るメモリ** | すべての事実が「あなたが言ったこと」か「モデルが推測したこと」としてラベル付けされ、複数のセッションで検証され、置き換えられても履歴が残ります。承認も却下も復帰もあなたの手にあり、あなたが述べた事実をモデルが覚すことはありません。 | 不要 |
| **確かめられる回答** | 根拠付きの回答は依拠したノートを引用し、証拠が薄ければ答えを拒みます。 | 不要 |
| **ファイルはあなたのもののまま** | あなたのフォルダにあるプレーンな Markdown。Obsidian のボールトはそのまま使えます。DUIN が既存のノートを書き換えることはありません。 | 不要 |
| **今取り組んでいることの地図** | 人物、プロジェクト、決定、未決のスレッドを探索できるグラフに取り出し、開いたままのループを追跡します。 | モデルの接続 |
| **手を持ち、綼をつけたエージェント** | ファイル、コマンド、MCP サーバー、スキル、フック、サブエージェント。ノートの外側はすべて事前に尋ね、バックグラウンドのループは初期状態でオフです。 | モデルの接続 |
| **ひとつのメモリを、すべてのエージェントで** | Claude Code でも他の MCP クライアントでも、マウントするのは同じメモリと地図です。 | あなたの許可 |

**検索はすべてあなたのマシン上で：** CJK を扱えるトークナイザ上の BM25、multilingual-e5-small で埋め込んだベクトルを sqlite-vec に置き、両者を重み付きの Reciprocal Rank Fusion で融合し、最後に bge-reranker-base のクロスエンコーダをかけます。キーもサーバーも GPU も不要です。

**不要**とは、キーもアカウントもいらないということです。検索、根拠付きの回答、そしてメモリ自体は初回起動から動きます。**モデルの接続**とは、OpenAI、Anthropic、Google Gemini、DeepSeek、Moonshot、Zhipu、DashScope（Qwen）、xAI、Mistral、Groq、DeepInfra、GitHub Models、OpenRouter のいずれか、または Ollama 経由のローカルモデルです。何も接続していないときは、陪審団の代わりにあなた自身の承認が入ります。DUIN はフォルダ直下に Markdown ファイルを 4 つ追加し、自分の状態を `.brain/`、`.duin/`、`.trash/`、`_agui_outputs/` に保存します。すべてテキストなので、同期や git で無視できます。インターフェースは英語、中国語、日本語に対応。

<p align="center">
  <img src="docs/assets/screenshot-app.png" alt="約 1,200 件のノートを持つ実際の保管庫で動く DUIN。ブレインマップ、チャットの入力欄、そしてホーム" width="100%" />
</p>
<p align="center"><sub>作者自身の保管庫、約 1,200 件のノートで動く DUIN。右のパネルは<strong>ホーム</strong>、起動時に開くサーフェースです。</sub></p>

## DUIN であるもの、ないもの

- エージェントのメモリ、判断力、自律を統治するハーネスであって、メモリファイル付きのコーディングエージェントではありません。エージェントのシェルは意図的に薄い側です。統治のほうが製品です。
- すでにあなたが持っている Markdown のフォルダを読みます。好きなエディタで編集し続けてください。DUIN が既存のノートを編集することはありません。
- ローカルファーストであって、オフライン専用ではありません。検索、出典付きの回答、メモリはキーなしで動きます。抽出、会話、審査員にはモデルが要ります。クラウドのキーか、ローカルの Ollama です。
- シングルユーザーです。同期も、チームスペースも、サーバーモードも、SDK もありません。`127.0.0.1` の外で待ち受けるものは何もありません。

## ハーネス

エージェントが普段は自分の裁量でやってしまう三つのこと。DUIN ではそのどれもが統治され、目に見え、あなた自身のファイルに残ります。

### メモリ：事実は追記ではなく、勝ち取るもの

普通のハーネスは、自分で決めたことをメモリファイルに追記し、それを読み直します。DUIN は事実を一つずつプロセスに通します。そのプロセスは「学習」パネルでも、あなたの保管庫でも見えます。

- **記録した時点で明示。**「結論から始める返信が好きだと覚えておいて」はあなたが言ったこととして記録され、あなたのやり取りからモデルが導いたものは推定として記録されます。このラベルは事実が作られた瞬間に押され、後から埋め直されることはありません。
- **まず試用期間。** 新しい事実はゆるく効きながら、複数のセッションと独立した検証を通して実証されます。モデルが接続されていれば別のモデルによる審査員が、なければあなたの承認が、その検証です。通らなかった事実は差し戻されます。
- **ルールは 1 個のファイル。** 確認された事実は `.brain/memory/` の下の概念ファイルになり、状態、出所、日付、系譜を持ちます。その主張行を書き換えれば、DUIN はあなたの版を旧版を置き換える陳述として記録します。ファイルを削除すれば、その事実は撤回されます。
- **置き換えるだけで、上書きはしない。** 覆された事実は、何に置き換わったかのポインタとともに退役し、ファイルは `.brain/_retired/` へ移り、いつでも復帰させられます。
- **あなたの言葉が最終。** あなたが述べた事実を、モデルが独断で退役させたり、間引いたり、ラベルを付け替えたりすることはありません。

そのファイルの一例です。

```yaml
---
id: concept-of_12_k9a
name: 結論から始める返信を好む
description: "結論を先に、根拠を後に置いた返信を好む。"
type: learned
metadata:
  kind: preference
  factId: of_12_k9a
  status: promoted          # candidate 候補 → provisional 試用中 → promoted 確認済み
  source: operator          # あなたが言ったこと。モデルがこの事実を書き換えることはできない
  adjudicatedBy: human      # あなたが承認した
  capturedAt: 1787115440387
  promotedAt: 2026-08-19
  supersedes: [of_7_c2q]    # これが置き換えた事実。そのファイルは .brain/_retired/ にある
tags: [preference, promoted, learned]
---
```

### 判断力：プロンプトに詰め込む塊ではなく、あなたの世界のモデル

- DUIN はあなたのノートと学んだことから、仕事の中の人物、プロジェクト、決定、未決のスレッドを、探索できるグラフとして取り出し、あなたが書くたびに最新に保ちます。開いたままのループと、収束しつつあるスレッドは時系列で追跡されます。
- 取り出された主張は、有効期間の開始と終了、判定、そしてその理由を持ちます。モデルが提案した退役は信頼度の基準を超えたときだけ適用され、適用されたのか阻止されたのかがあなたに示されます。それに対するあなたの裁定はピンとして残り、以後のどのパスでも覆りません。ブレインは「ある日付の時点で何を信じていたか」に答えられます。
- 決定は振り返りの日付と、それに対するあなた自身の判定を持ちます。だから記録は、結果的に何が正しかったのかを語ります。
- 回答は根拠にしたノートを引用し、ノートの中の証拠が足りないときは、DUIN は穴を埋めずにそう言います。検索とリランキングはあなたのマシンで動きます。グラフを組み立てる抽出を除けば、ここまでのすべてにキーは要りません。

### 自律：段階ごとに勝ち取り、授けるのはあなた

- エージェントはファイルを編集し、コマンドを実行し、MCP サーバー、スキル、フック、サブエージェントを使います。シェルコマンド、削除、移動、そしてノートの外にあるものはすべて、先に尋ねます。
- 定期的な自動化とバックグラウンドのループは無効の状態で出荷され、あなたが一つずつ有効化します。有効にしたあとも、ハーネスが自分の設定に提案する変更はあなたの承認待ちで保留され、暴走した実行はブレーカーを落とします。再投入できるのはあなただけです。
- チャネルから届くメッセージが実行トークンを持つことは決してなく、外から教えられた事実は、あなたが採用するまで隔離されます。
- 他のエージェントは MCP 越しに DUIN をマウントします。それぞれが何を読めて何を書けるかは、アプリの中で権限プレーンごとにあなたが許可した範囲であり、要求されたものより狭くできます。
- 境界は承認プロンプトと OS 自身のダイアログであって、サンドボックスではありません。それが何を守り、何を守らないかは [SECURITY.md](SECURITY.md) にあります。

コードから起こした詳細：[アーキテクチャ](docs/architecture.md)。

## ダウンロード

| Windows | macOS | Linux |
|---|---|---|
| [DUIN-x64.exe](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest/download/DUIN-x64.exe) | [DUIN-arm64.dmg](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest/download/DUIN-arm64.dmg) | [DUIN-x86_64.AppImage](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest/download/DUIN-x86_64.AppImage) |

[DUIN-amd64.deb](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest/download/DUIN-amd64.deb) と [DUIN-arm64.zip](https://github.com/Mentis-lab/duin-governed-agent-memory/releases/latest/download/DUIN-arm64.zip) もあります。

インストーラーが大きいのは、2 つのオンデバイス・エンコーダー（検索とリランキング、約 412 MB）が同梱されているからです。残りは Electron とアプリ本体です。検索と出典付きの回答は、初回起動からオフラインで動きます。モデルを接続するまで、どこにも何も送信されません。GPU は不要です。

<details><summary>未署名ビルドと、ダウンロードの検証方法</summary>

Windows では SmartScreen の警告が出ます。**詳細情報 → 実行** を選んでください。macOS では初回のみ、アプリを右クリックして **開く** を選びます。Linux ビルドは CI から出ており、メンテナーがまだ実際に動かしていません。各リリースには全ファイルの SHA-512 を含む `latest.yml`、`latest-mac.yml`、`latest-linux.yml` が添付されます。検証コマンドと更新の仕組みは [docs/getting-started.md](docs/getting-started.md#9-verify-a-download) にあります。

</details>

## 初回起動

1. DUIN をインストールして起動します。ようこそ画面でフォルダを聞かれたら、Markdown のノートが入っているフォルダを選びます。Obsidian の保管庫はそのまま使えますし、空のフォルダでも構いません。あなたのノートが、出発点となるメモリです。
2. 何か伝えてみます。「結論から始める返信が好きだと覚えておいて。」起動直後に開いているのがホームパネル（画面上の表記は Home）で、その下部の **詳細 → 学習** から学習パネルが開きます。その事実が、あなたが言ったこととして記録されています。
3. 自分で書いたと分かっていることを尋ねます。何も設定していない状態でも、根拠にしたノート付きで答えが返るか、ノートの中の証拠が足りないと DUIN が言います。
4. モデルを接続します（設定 → API キー、または起動中の Ollama）。ここから事実はあなたを待たずに審査員を通るようになり、**ブレイン** があなたのノートの中の人物、プロジェクト、決定を地図として見せます。
5. 任意：Claude Code にマウントします（下記）。すでに使っているエージェントが、同じやり方であなたを覚えるようになります。

各ステップでディスクに何が置かれるか：[docs/getting-started.md](docs/getting-started.md)。

## すでに使っているエージェントと

Claude Code と Codex はより強いエージェントで、それぞれが自前のメモリファイルを持っています。DUIN は、その二つが共有できるメモリであり、統治されている側のメモリです。

- **Claude Code。** `/plugin marketplace add https://github.com/Mentis-lab/duin-governed-agent-memory` を実行し、続いて `/plugin install duin-brain@duin` を実行します。DUIN が起動していれば、セッションはあなたの文脈と信念を読めます（`duin_brief`、`duin_retrieve`、`duin_beliefs`、`duin_context`）。設定 → エージェント で許可した場合にのみ、訂正を教えたりメモリを書いたりできます。どの許可も、アプリの中であなたが承認します。ペアリングの流れ、権限プレーン、ツール：[plugins/duin-brain/README.md](plugins/duin-brain/README.md)。2026-09-02 に、まっさらな Claude Code 設定で、このリポジトリからのインストールを検証済みです。
- **bearer ヘッダー付きの HTTP を話す他の MCP クライアント**（クライアントが許す範囲で Codex を含む）は、同じエンドポイントをマウントします：`http://127.0.0.1:8799/exec/mcp`。エージェントがペアリングを終えるまで、このエンドポイントはペアリング用の 2 つのツールしか出しません。
- **逆方向も。** DUIN 自身のチャットを外部のブレインから AG-UI 越しに動かすこともできますし（`DUIN_BRAIN_URL`）、エージェントが別のハーネスに統治された子としてタスクを渡すこともできます（`delegate_task`）。そのときもツール呼び出しを一つずつ決めるのは DUIN です。

## 他との違い

- **ハーネス自身のメモリ**（Claude Code のメモリファイル、`AGENTS.md`、`CLAUDE.md`）：ルールは手書き、メモリはモデルが追記して書き換え、誰が言ったかの記録も履歴もありません。DUIN は明示し、実証し、置き換え、履歴を残し、あなたが言ったことをモデルが書き換える権利を認めません。
- **エージェントメモリ基盤**（OpenClaw、mem0、Letta）：SDK と常駐ランタイムで、メモリはモデルが書き、後勝ちで、出所のラベルはありません。DUIN は API ではなくアプリとファイルです。そのメモリはあなたのノートに根ざし、引用され、出所で明示され、複数のセッションで実証され、最後に裁定するのはあなたです。
- **エディタのプラグイン**（Copilot for Obsidian、Smart Connections）：エディタの中でのチャットと関連ノートで、モバイルでも動き、より軽量です。Smart Connections は数メガでローカルの埋め込みを動かしますが、DUIN は 412 MB のエンコーダーを積みます。ただし、あなたについての統治されたメモリは持ちません。
- **ローカル RAG アプリ**（AnythingLLM、Khoj）：文書をワークスペースやサーバーに取り込み、Web とモバイルのクライアントを持ちます。DUIN はあなたのフォルダをその場で読み、サーバーを必要とせず、キーなしで答えます。
- **Reor**：AI 検索を内蔵したノートアプリ。DUIN はエディタではありません。あなたが別の場所で書いているノートを読みます。

## 0.1 の既知の制約

- 事実が信頼されるまでには時間がかかります。試用期間はまさにその狙いですが、今日あなたが述べた好みは、承認されるか実証されるまでゆるくしか効かないということでもあります。すぐ効かせたいなら、自分で承認してください。
- 想起は素の検索と同等で、それ以上ではありません。LongMemEval で、事前登録した 2 回の実行のうち、DUIN は総合で素朴な RAG ベースラインを 1.0 下回り、時間に関する設問では 7.7 上回りました。実験環境と結果は `bench/longmemeval/` にあります。
- インストーラーは未署名です。署名が入るまで、更新は通知のみです。
- Linux ビルドは CI 産で、メンテナーが動かしていません。
- キーを接続すると 1 ターンが複数回のモデル呼び出しになり、最初のグラフ構築は保管庫全体を読みます。小さいモデルか無料枠から始めてください。
- 遅いローカルモデルは 90 秒のアイドル予算に引っかかることがあります（`DUIN_TURN_STALL_MS` で引き上げられます）。
- Ollama は `127.0.0.1:11434` に固定で、カスタムエンドポイントはまだありません。
- 会話データベースは暗号化されていません。ディスク暗号化を使ってください。

全リストと、それぞれの計画：[#10](https://github.com/Mentis-lab/duin-governed-agent-memory/issues/10)。

## 動作環境

Windows x64、Apple シリコンの macOS、Linux x64（AppImage または deb）。GPU は不要で、エンコーダーは CPU で動きます。インストールサイズとメモリ使用量は、リファレンス機で実測してから公開します。

## プライバシーとクラウド利用

- あなたのノートは元の場所のままです。DUIN はインデックス、会話、設定をアプリのユーザーデータディレクトリに置き、自身の状態は保管庫の `.brain/` と `.duin/` の下に置きます。
- 埋め込みとリランキングはあなたのマシンで動きます。テレメトリはありません。クラッシュレポートは送信されません。
- キーがない場合、通信は GitHub Releases への更新チェックだけです（設定 → 一般 で無効化できます）。ビルドにエンコーダーが同梱されていない場合は、1 回だけモデルのダウンロードが走ります。
- キーがある場合、毎ターンあなたの質問と関連するノートの抜粋がそのプロバイダーに送られ、グラフの構築時にはノートがバッチで送られます。保管庫全体の抽出を初めて行う前に DUIN は確認します。定期的な自動化は、あなたが有効にするまで止まったままです。メモリの手入れ（事実を検証する審査員と、古い事実を退役させるパス）も、同じプロバイダーへ短いプロンプトを自動で送ります。
- キーは Electron の `safeStorage` を通じて OS 自身の資格情報ストアに保存されます（macOS は Keychain、Windows は DPAPI）。
- エージェントは動く前に尋ねます。フルコンピューターアクセス（設定 → 一般、既定は無効）は、ローカル操作についてそのプロンプトを外します。脅威モデルは [SECURITY.md](SECURITY.md) にあります。

## ソースからビルド

Node.js 22.12 以上と git。Windows では短いパスにクローンするか、長いパスを有効にしてください。

```bash
git clone https://github.com/Mentis-lab/duin-governed-agent-memory
cd duin-governed-agent-memory
npm run setup        # npm ci --ignore-scripts と Electron バイナリ。Python も C++ も不要
npm run dev          # 開発モードでアプリを起動
npm run typecheck && npm run lint && npm test
npm run build:win    # または build:mac / build:linux → ./dist（約 412 MB のエンコーダーを一度だけ取得）
```

コントリビューター向けのセットアップ、インストール済みの DUIN の隣でもう一つ動かす方法、CI が回すチェック：[CONTRIBUTING.md](CONTRIBUTING.md)。

## ドキュメントとコミュニティ

- [アーキテクチャ](docs/architecture.md)：まずメモリモデル、次に三つのプロセス、`127.0.0.1:8799` で動くブレイン、ストレージ、そして外部ブレインを接続するための AG-UI の取り決め（既定のエンドポイントは `http://127.0.0.1:8799/agui`、`DUIN_BRAIN_URL` で DUIN を別の AG-UI サーバーに向けられます） · [はじめかた](docs/getting-started.md) · [スキル](docs/skills.md) · [FAQ](docs/faq.md) · [DUIN とは](docs/constitution.md) · [用語集](docs/glossary.md) · [セキュリティポリシー](SECURITY.md) · [変更履歴](CHANGELOG.md) · [リリース手順](docs/RELEASING.md)。
- 質問：[Discussions → Q&A](https://github.com/Mentis-lab/duin-governed-agent-memory/discussions/categories/q-a)。アイデア：[Discussions → Ideas](https://github.com/Mentis-lab/duin-governed-agent-memory/discussions/categories/ideas)。不具合：[Issues](https://github.com/Mentis-lab/duin-governed-agent-memory/issues/new/choose)。セキュリティ：[非公開の報告](https://github.com/Mentis-lab/duin-governed-agent-memory/security/advisories/new)。
- Discord はまだありません。メンテナーが一人であること、そして Discussions は検索に残ることが理由です。DUIN が役に立ったなら、star が他の人の助けになります。

## コントリビュート

不具合の報告、修正、ドキュメントの改善を歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) に、セットアップ、すべての PR が通すべきチェック、PR の大きさの目安があります。

コードの書かれ方：DUIN は一人の人間のメンテナーのもとで、AI コーディングエージェントとともに開発されています。すべての変更は、型チェック、リンター、テストスイート（約 10,600 件、リポジトリ内にあります）、そして証明ゲートを通ってから入ります。このテスト群が、上に書いたハーネスの振る舞いの仕様です。

## 由来

DUIN は Basho Parks による [lamprey-harness](https://github.com/USS-Parks/Lamprey-Harness)（MIT）から始まりました。エージェントのシェル、チャット UI、スキルと MCP まわりの配線、そして Electron のビルドパイプラインは、そこから来ています。DUIN はそこに、プロセス内のブレイン、ナレッジグラフとそのコンソール、出典、メモリ、先読み、統治を加えました。ディスク上や環境変数の識別子には今も `lamprey` の名前が残っているものがあり、[docs/legacy-names.md](docs/legacy-names.md) に一覧があります。

## ライセンス

MIT。[LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。同梱するモデルとライブラリのサードパーティ通知は、インストーラーに同梱されます。
