# Changelog

All notable changes to **DUIN** are documented here. The project follows
[Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/) format.

> **Naming.** The app shipped its first two internal releases as **Brainframe** (`0.1.0`,
> `0.2.0`) and was renamed to **DUIN** on 2026-07-02. Historical entries keep the name they
> shipped under. Both are built on the MIT-licensed
> [lamprey-harness](https://github.com/USS-Parks/Lamprey-Harness) by Basho Parks. See
> [docs/branding.md](docs/branding.md).
>
> Versions between `0.2.0` and `0.9.0` were private tester builds (`v0.8.0-tester.N`) and are
> not listed separately. `v0.9.0` is the first public release; public history and tags start
> there.

## [Unreleased]

## [0.9.0] - 2026-09-04

The first public release. Since the last Brainframe entry the product was renamed, the brain
moved in-process, and the agent, graph, memory and governance layers were built out.

### Added

- **In-process TypeScript brain** on `127.0.0.1:8799`: indexing (SQLite + `sqlite-vec` + local
  embeddings), grounded answers, the knowledge graph and the foresight engines are all native.
  With no model connected, DUIN still answers from your notes with an extractive answer.
- **Knowledge graph**: an entity graph of people, projects, organizations, decisions and topics
  extracted from notes, with provenance per plane, a delete path that survives rebuilds, and
  duplicate folding. Explorer with Memory and Concepts tiers; the 2D map on `cosmos.gl` (GPU
  points and links); level-of-detail in the 3D view; a Relations panel with an ego graph.
- **Grounding**: retrieval with a cross-encoder reranker, an evidence gate that refuses thin
  evidence, adaptive whole-note breadth, period-scoped retrieval, and `runCode` so retrieval can
  compute rather than only rank.
- **Memory and learning**: provenance on every memory (`user-explicit`, `session`, `inferred`,
  `reflection`, `imported`, `unknown`); the `SOUL.md` foundation file; a topic-track layer; OKF
  concept materialization under `<vault>/.brain/memory/`; the Learn loop captures corrections at
  the turn boundary (English and Chinese); causal survival credit as the promotion bar.
- **Governance**: a rule-of-two session floor, a fail-closed per-action reviewer for unattended
  surfaces with injection fencing, per-turn cost metering with an operator ceiling, wall-clock
  bounds on every tool, a turn that stops after repeated identical failing calls, and a durable
  record of every turn including aborted ones.
- **Agent reach**: file tools in operator-approved folders outside the vault; a Windows
  restricted-token sandbox backend; capability `requires` declarations checked before spawning;
  a permissions view showing what each standing grant has done.
- **External executor**: `delegate_task` runs the DeepSeek Harness (`dsh`) as a governed child
  process in an isolated git worktree, with a cost ceiling, earned autonomy, a keep/discard
  review, and a Settings → Executors card.
- **Channels**: a capability model and transport seam with Telegram, Discord, Slack, Feishu
  (bot and app), WeCom, DingTalk and Email definitions. All dormant until configured.
- **DUIN Brain for other agents**: an in-process MCP mount at `/exec/mcp` with principal
  pairing, plus an installable MCP plugin (`plugins/duin-brain`).
- **Models**: the catalog redone across provider families with a grouped picker; Anthropic
  through its OpenAI-compatible layer; the Gemini line; Moonshot, Zhipu `glm-5.3-flash`, Qwen
  3.8 Flash; a Background model setting for extraction and titles; failover that reports which
  model failed and why.
- **Image generation** providers: Seedream (Volcengine Ark), `gpt-image-2`, MiniMax.
- **Chat**: native multimodal images and Office attachments; JSON Canvas blueprints with an
  in-app editor; wikilinks in the read view; detached surface windows; continuation instead of
  an output cap; a retryable notice on failed turns.
- **Automations and notices**: schedules described in words; a "Needs you" tab and status pill;
  forecasts asked about in conversation instead of pushed.
- **Customize**: skills browse and packaging, authorable methods, bundled skills seeded by
  manifest so shipped fixes reach existing installs without overwriting edits.
- **Plugins** installable from a git URL as a reviewed two-step.
- **Deep links** (`duin://tool/…`, `duin://settings/<tab>`, `duin://conversation/<id>`) from
  notices into the app.
- **Localization**: English, Chinese and Japanese across the renderer and main-process strings,
  OS-language auto-detect, per-language CJK fonts.
- **macOS**: adapted interface, Full Disk Access grantable, ad-hoc signed builds.
- **Diagnostics**: a doctor check that reads brain health, stalls, backend health, capability
  gaps, provider keys and build provenance together and answers pass/warn/fail.
- **Repository**: public home at `Mentis-lab/DUIN`; downloads and auto-update from GitHub
  Releases; CI on Ubuntu and Windows; CODE_OF_CONDUCT, issue and PR templates, Dependabot,
  `.editorconfig`; `docs/` rewritten (getting started, architecture, FAQ, releasing, skills,
  legacy names).

### Changed

- Renamed the product from **Brainframe** to **DUIN**; the name is hard-set in
  `electron/brand.ts`, `src/lib/brand.ts`, `package.json` and `electron-builder.yml`.
- **Electron 43** and `better-sqlite3` 13 (N-API prebuilds). `npm ci` no longer forces a
  from-source rebuild, so no Python or C++ toolchain is needed for an ordinary install.
- Git hooks are opt-in (`npm run hooks:install`). `npm run build` no longer rewrites tracked
  files.
- **Public defaults**: full computer access off; the Node REPL and Chrome (Playwright) MCP seeds
  present but disabled; unattended model work (vault-wide extraction, recurring checks) gated
  behind Background autonomy or explicit consent; hooks on with a Settings toggle; auto-update
  notify-only until builds are signed.
- The demo brain is gone: first run indexes a folder you choose, and an empty folder is a
  valid start.
- Retired surfaces: the people, browser and environment panels; Meetings, Outputs and Mental
  Models; the `project` entity kind; the standalone 2D/3D control in favor of the map.
- Graph construction: a topic earns a node by carrying structure (floor of three relations);
  duplicates fold before the floor; the brain graph is served stale and tagged, then refreshed.
- Boot: the integrity scan and heavy monitors moved off the pre-window path and are idle-gated.
- Background model work runs only while the app is in use and knowledge moved.
- Onboarding: identity lands first, a failed setup cannot consume onboarding, and a key
  connected during onboarding routes the first chat.
- Routing uses whichever configured account is available, not only the priority one.
- Licensing and attribution: `LICENSE` carries DUIN's line together with the upstream notice,
  `NOTICE` lists every bundled component, and generated third-party notices ship in the
  installers. Attribution names lamprey-harness by Basho Parks.

### Fixed

- MCP: retries reused one transport and failed instantly; a non-array `mcp-servers.json` crashed
  initialization; removing a server left OAuth tokens replayable; `connectors.json` was parsed
  against a narrower shape and dropped HTTP, OAuth, headers and scope; the Node REPL could not
  import its SDK in a packaged install; disabling a stdio server respawned it; token-authed SSE
  handshakes sent no headers; concurrent OAuth flows clobbered each other's consent.
- Updater: the periodic check ran once at launch and never again; the Restart button reported
  success for a refused install; a foreign artifact on the feed is refused by name.
- Providers: Kimi and OpenAI token parameters; a status-less stream death now surfaces as the
  real HTTP status (a `402` is a `402`); a rejected key no longer ends the failover chain; the
  catalog verifier no longer marks a good key dead.
- Brain: the govern loop resurrected rules the operator had corrected away; a soft-retired rule
  still shipped as confirmed; vault adoption is transactional; the first vault pick overwrote the
  vault's real ledger; a locked history file turned the next panel open into a wipe; retired
  rules re-entered grounding; deletions and graph provenance survive rebuilds; FTS5 syntax in a
  query returned nothing; folders with a dot in the name were skipped; consolidation deleted the
  entry it had just merged; index rows for files deleted between sessions were never swept.
- Chat and approvals: the composer keeps focus across the first send; a cancelled turn left its
  approval modal on screen; approval-gated network tools fanned out onto the single approval
  slot; "ask before destructive actions" could never match an MCP tool; a late approval executed
  on a turn already cut; truncated answers reach channels with their "(interrupted)" marker.
- Loops and automations: the "Enable loops" switch governs every engine; the every-minute
  runaway's side door is closed; a wake-up turn had no deadline; double dispatch and an
  unreachable cost ceiling; the runaway alarm reported a dead incident and hid three live ones.
- Startup and reliability: renderer and child-process death is observed and recovered; no
  permanent spinners or false-empty panels; startup and onboarding are recoverable; benign
  `ResizeObserver` noise no longer toasts at launch.
- Windows sandbox: ACLs were re-propagated on every command (13.5 s → 0.4 s), plus an operator
  kill switch (`DUIN_SANDBOX=0`).
- Skills: importing a skill could overwrite a hand-authored one; the wizard sold an advisory tool
  hint as a hard restriction; method wires resolve against the app's skills.
- Localization: 63 untranslated channel strings shipped past a scan that reported zero; 11
  entries were translated English rather than product copy; Japanese rendered in a Chinese face.
- Tools: `weather_lookup` reaches its geocoder; dead tools say so in Settings; four channels
  advertised uploads none implemented.
- Tests and CI: the win32 sandbox test depended on the host; macOS builds died with `EMFILE`
  during ad-hoc signing; release installers are no longer uploaded as run artifacts.

### Security

- A real control-plane guard on the brain server: loopback `Host` on every verb, per-launch
  tokens on every mutating verb and the effectful GETs, and cross-origin writes refused.
- Renderer-supplied paths are confined (backup restore, file processing, one-shot file drops);
  `will-navigate` is pinned to the packaged renderer; writes outside the vault require an
  operator-granted folder.
- Plaintext keychain fallback consent is scoped per provider and per session, and an
  unresolvable autonomy rung is never armed.
- `create_skill`, `spawn_agent` and `delegate_task` take the deny-first execution-token path;
  code-executing MCP servers fail closed (Node REPL JavaScript had been classified as a network
  read); an inbound channel turn cannot carry execution authority.
- A fail-closed per-action reviewer and a rule-of-two floor on unattended surfaces; `web_find`
  fetches go through the egress gates; the confidential-egress denylist cache is invalidated on
  a vault switch.
- The brain bridge no longer ships the execution token off-machine and no longer reports
  refusals as success.
- A plugin install can no longer spawn an MCP stdio connector without the approval dialog, and
  an extra slash cannot walk a spawn past the install gate.

## 0.2.0 - 2026-06-20 (Brainframe, not published)

The built-in local brain: Brainframe became useful with no external server.

### Added

- **In-process local brain** (`electron/services/local-brain/`): an AG-UI server on
  `127.0.0.1:8799` that indexes a notes folder (`sqlite-vec` + local embeddings), answers chat
  grounded in the notes through the user's chosen provider, and serves a notes-derived graph.
- **Notes → Brain graph**: a node per note, edges from `[[wikilinks]]` and Markdown links,
  lanes from top-level folders, instead of demo data once a folder is set.
- **Retrieval tool cards**: notes retrieval surfaces as a `search_notes` tool call in chat.
- **Settings → Brain → notes folder**: native folder picker, reindex, "N notes indexed" status.

### Fixed

- The brain graph loads over a main-process IPC instead of a renderer fetch that the CSP had
  silently blocked.
- Welcome and onboarding rebranded and made skippable; the brain became the default model and
  the first workspace tool; 3D graph framing and node visibility.

## 0.1.0 - 2026-06-20 (Brainframe, not published)

First standalone build of **Brainframe**: a desktop agent shell with an animated 2D/3D
brain-graph console and a pluggable brain connector, built on lamprey-harness and rebranded as
a standalone product.

### Added

- **Pluggable brain connector** (`electron/services/duin-bridge.ts`): drives the chat UI from an
  external AG-UI brain (HTTP `POST {threadId, messages}` → SSE
  `RUN_STARTED → TEXT_MESSAGE_CONTENT → RUN_FINISHED`).
- **Configurable brain endpoint** through the `DUIN_BRAIN_URL` environment variable.
- **Demo mode** when no brain is reachable, so first run was never broken.
- **2D + 3D brain-graph console** with bundled demo data, and **node-launch** to open a chat
  scoped to a graph node.
- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, this changelog, and a `NOTICE` crediting the
  upstream harness.

### Changed

- Rebranded from "Lamprey" to **Brainframe**, with the product name centralized in
  `electron/brand.ts` and `src/lib/brand.ts`.

[Unreleased]: https://github.com/Mentis-lab/DUIN/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Mentis-lab/DUIN/releases/tag/v0.9.0
