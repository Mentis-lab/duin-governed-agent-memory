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
> The Brainframe-era entries below and the private tester builds (`v0.8.0-tester.N`) predate the
> public line and are not listed separately. `v0.1.0` is the first public release; public history and tags start
> there.

## [Unreleased]

### Added
- **Every derived entity has a card.** Open a person, project, topic or any other extracted node
  in the Explorer and see what the brain knows about it, joined from what it already held: the
  facts lifted from your notes (current first, superseded ones marked), the notes it appears in
  with the sentence that names it, its typed connections, the other names it goes by, first and
  last seen, and any node that looks like the same thing, with a one-click merge.
- **A written description for each entity, from the free local model by default.** The card asks
  a model for one or two sentences and a few attributes, grounded in the card's own material and
  nothing else; names and attributes the model invents are dropped. The description is kept in
  `.brain/state/entity-enrichment.json`, rewritten only when the material changes, and carried on
  the graph node as `desc`. A detected Ollama model is used first (`DUIN_ENRICH_PREFER_LOCAL=0`
  to follow the provider policy instead); `DUIN_DISABLE_ENRICH=1` turns the pass off.
- **Organize the vault from the Explorer.** Every note row and folder row has a quiet menu (and a
  right-click): rename a note, move it to a folder (typed, created if missing), rename a folder,
  start a new note in a folder. A rename rewrites the `[[links]]` that pointed at the old name
  across your notes (basename, path and markdown forms), a move and a folder rename rewrite the
  path forms, and every note rewritten is preserved to `.trash` first. Nothing clobbers, nothing
  reaches `.brain`, `.duin` or `.trash`, and every act is journalled to
  `.duin/_state/organize-journal.jsonl`. The graph, the index and the map follow at once.
- **Name a derived entity.** Rename on an entity the extractor produced sets your name for it,
  kept in `.duin/_state/node-labels.jsonl` and applied to the served graph after the build, so a
  rebuild cannot overwrite it; leave it empty to return to the extracted name.
- **Home: one surface for what needs you, what is alive, what changed.** One item leads (a
  decision waiting on you, else a machine problem with its fix, else news, else what the brain
  noticed, else calm), then Needs you, then the machine as one line each with the reason (engine
  and the model answering, brain notes and nodes, loops, what is running, the harness with its
  main-thread stalls, backups and spend, sources), then what moved since your last session
  (notes read, nodes added, beliefs learned, runs, forecasts resolved, the last conversation's
  errors). Live: every event the folded surfaces listen to re-composes it, plus a quiet poll.
- **DUIN on GitHub** (Settings → GitHub): the release you are on beside the latest published
  one with a "Check now", a "Report a bug" that opens the repository's issue form with your
  version and platform filled in, and a Star for a connected account. The tab is about DUIN's
  own repository first; your account follows.
- **Settings export, import and reset.** Settings → Persistence → Settings backup exports your
  settings, channels, pairings and connected agents as one file, imports them on another
  computer, or resets every setting to its default while keeping the brain folder and the consent
  you gave. API keys never travel: their encryption is bound to the OS user, so they are re-entered.
- **A notice when the settings file cannot be read.** A torn settings.json used to boot DUIN on
  defaults without a word, which looks exactly like a fresh install; it now lands in Needs you with
  the path of the preserved copy.
- **Two notifications that worked but had no switch:** "A forecast is overdue for review" and
  "A confident prediction was wrong" (Settings → Notifications).
- **Approvals from a channel** (Settings → Channels): who may approve an action while you are away,
  and how long DUIN waits before declining. Both were honoured before; neither could be set.
- **Tool surface** (Settings → Engine): list every tool to the model on each turn, or load MCP
  tools on demand.
- **A Governance tab in the Automations hub** holds the capability breaker and the governor's record
  (adjudicated rules, reversible actions, proposed improvements), which are monitoring, not settings.
- **A settings kit** (`src/components/ui/settings`): the page frame, section, card row, toggle row,
  number field, draft textarea, load-error block, tab link, secret field and provider key card every
  Settings page is now built from, with the conventions written down in its index.
- **A way back into first-run setup.** While no brain folder is set, a banner above the chat
  offers "Set up my brain" and re-opens the welcome flow — "Skip for now" is no longer a dead
  end whose only exit was Settings → Brain.
- **The brain map comes back where it was.** Node positions are remembered per vault across
  launches, and a launch re-heats the map you know gently instead of scattering it from a
  spiral and settling into a different picture.
- **Community names on the map.** With Clusters on, the largest communities are named at their
  centre of mass at overview and the names follow the map while it settles; zoomed in, node
  labels take over. Labels are placed against a viewport budget with overlap culling, so they no
  longer pile onto the centre of a small window.
- **Shift + drag on the brain map selects a region.** The selection lights like a focus, and a
  chip offers "Ask about these" (the names go into the chat box, ready to edit) and Clear. The
  project logos are now drawn by the GPU as part of the map (the core mark stays a DOM sprite
  so it keeps a legible size at overview).
- **The brain map's physics runs on the GPU.** cosmos.gl's own simulation is now the engine:
  drag a node and its neighbours give way, the core stays pinned, the map settles in seconds, and
  with Clusters on the detected communities gather on the map instead of only sharing a colour.
  The four Layout sliders drive the same forces (50 = the shipped look). `localStorage.brainLayout=
  worker` restores the previous off-thread d3 layout. Above 2,500 nodes the map now shows the
  skeleton plus the most salient notes (connectedness tempered by recency) rather than a fixed
  fraction; "Show all nodes" still overrules. With a node locked, ← → step through its
  connections. Cluster detection runs on the map you look at, with a link you typed weighing more
  than one the brain inferred, so folder hubs and roadmap nodes can carry a cluster colour too.
- **The brain map's visual grammar.** Node shape now says what a thing is (star: the core;
  hexagon: folder; pentagon: project, track, strategy, move; triangle: goal, KR; diamond: event,
  milestone, release; square: organisation; cross: risk, issue, owed decision; circle: everything
  else). Inside a lit neighbourhood a connection you typed draws solid and one the brain inferred
  draws dotted, directed relations carry an arrowhead, hovering a connection names both ends and
  its provenance, and clicking it walks the lock to the far node. Right-click a node for Open,
  Ask about this, Lock/Unlock neighborhood, Isolate its cluster, Copy path. Escape clears a lock.
  Isolating a cluster frames it. `localStorage.brainFps=1` shows the renderer's frame monitor.
  The systematic evaluation of every cosmos.gl option against DUIN's data model, with what was
  adopted, deferred and rejected and why: `PLANNING/DUIN_BRAIN_GRAPH_VISUAL_GRAMMAR.md`.
- **Learned facts live in your vault by default.** Every fact DUIN learns about you — on
  probation or confirmed — materializes as `.brain/memory/concept-<id>.md` with its status,
  source, dates and supersession lineage; retired facts move to `.brain/_retired/`. Re-projection
  writes nothing when the bytes would not change. `DUIN_SEAM_MATERIALIZE=0` turns it off.
- **Edit or delete a concept file and DUIN follows.** Rewriting the claim line records your
  version as a statement superseding the old fact (a confirmed rule stays confirmed); deleting
  the file vetoes the fact; annotations are preserved until the fact changes; removing the
  machine marker releases the file to you. A seam ledger in `.duin/_state/` tells your edits from
  DUIN's own writes.
- **Human verbs in the Learning panel:** provenance on every row (declared / inferred / from a
  channel, and whether you ruled), Ratify for facts on probation (the keyless card in Needs-you
  carries Ratify / Veto too), Un-veto, Revert on a superseded fact, and Keep retired / Revert on
  the claims a model retired from your notes, which now show whether the retirement stood or
  was blocked and why.

### Fixed
- **A card that could not be cleared no longer leads Home.** After a restart, the card that
  says a candidate belief awaits your review stayed waiting forever, even once the belief had
  been ratified: the code that clears it compared the queue against a count that starts at zero
  on every launch, and so skipped the clear. Home then led with something waiting whose panel
  had nothing in it. The clear now runs whenever the queue is empty.
- **Anything waiting on you can now be closed by hand.** A row that carries no decision of its
  own offers Dismiss, which clears it from Needs you and says plainly that it does not answer
  the request behind it. Nothing could be dismissed before, so one stuck row was permanent.
- **Models → Add model always routed to DeepSeek.** The form sent no provider and main stamped one;
  a Groq or Mistral id was silently sent to DeepSeek. The form asks for the provider and main
  refuses an add without one.
- **Automations without a pinned model silently pinned deepseek-v4-flash** and failed for anyone
  without a DeepSeek key. They follow the provider order like a chat turn; when nothing routes,
  the run says which setting to fix.
- **Two controls that did nothing:** RAG "Auto-RAG in conversations" and Snip "Verbose mode" wrote
  keys nothing read. Removed, with four more unread RAG keys.
- **Foundations → Reveal in files never worked** (the file-explorer handler refused files) and
  reported nothing. It reveals the file and reports failures.
- **Escape inside the Add-key dialog closed the whole Settings view** underneath it.
- **Number fields that could not be typed into** (RAG top-K, Models context window, Seed budget,
  Loop ceilings) clamped on every keystroke; the Personality custom-voice box dropped characters
  and broke Chinese and Japanese input. All of them are drafts now and commit when you leave them.
- **Eight pages whose title did not match their tab**, and Persistence which had none. The dialog
  draws the tab label as the title.
- **"Use external brain" pre-filled the local brain's own address** and flipped the page into
  external mode while nothing had changed.
- **Channels rendered every help line twice**, hid the credential fields entirely when the read
  failed, and always showed the deprecated lark-cli row first.
- **Ten pages painted a failed read as an empty state** ("No key", "No automations yet", "Runtime
  not installed", "Loading…" forever). They show the failure and a Retry.
- **Models:** the health line counted providers without a key as unhealthy and showed "0s ago" on
  them; "Test model" leaked a conversation on failure; "Move up" had no way back.
- **Shortcuts:** Ctrl+K was labelled a command palette (it is search); Ctrl+Shift+K was missing.
- **Web Tools:** "Use this provider" could switch to a provider with no key and silently kill web
  search; Wikipedia was rejected by the provider check; activating SearXNG wiped its saved address.
- **Current Info** Save could switch to a keyless provider and break the tool; **Image Gen** offered
  the unfinished Stability provider.
- **Hooks:** editor edits were lost on a tab switch, the page did not say the master switch on
  General was off, and cancelling the approval dialog toasted errors. Two events nothing fired
  (loopStarted, loopIterationDone) are no longer offered.
- **Notifications:** a quiet-hours start equal to the end switched quiet hours off mid-edit; a
  failed digest read showed "off".
- **The renderer default for the job-failure notification disagreed with main** (false vs true);
  the defaults parity test now checks nested blocks.
- **Home and system folders were listed as sandbox write roots and silently ignored.** They are
  refused when added, with the reason.
- **The brain map's Layout sliders are continuous and the settle is smooth.** Link force used to
  switch from d3's adaptive strength (only at exactly 50) to a constant one step away, a 10x jolt
  on every hub link; the centre force was a whole-map translation fighting the pinned core. Each
  slider is now one geometric ramp with 50 unchanged, the centre force is a real per-node pull,
  nodes no longer overlap (collision on each node's drawn radius), a nudge re-heats the map gently
  and a sweep fully, and positions stream at 60 ms instead of 120 ms.
- **First run on Windows: "Couldn't set up that folder — Vault durability moat failed: vault
  switch cleanup failed: lamprey-memory: ENOTEMPTY".** Every fresh install failed at its very
  first folder pick. The memory store's file watcher held `lamprey-memory` open while the vault
  switch removed it, and a directory with an open handle cannot be removed on Windows. The
  watcher is released for the switch (its rollback included) and re-armed after.
- **Brain nodes keep their identity across rebuilds.** A re-extracted entity keeps the id it was
  first known by, so its place on the map, its lock and its cluster survive a rebuild (15% of nodes
  used to get a new id per run). A per-vault fence (`.brain/state/construction-exclude.json`) and a
  per-note `duin-extract: false` keep chosen folders out of entity extraction while retrieval still
  indexes them; the construction store is parsed once per change instead of three times per check.
- **The brain stops accumulating nodes.** Re-reading a note now replaces what it yielded instead of
  keeping every variant every model ever produced (one miss tolerated, the second retires the
  entity or triple); the store, the batch merge and the map use one entity key; entity extraction
  reads documents only (never `.brain/` memory files, machine state, hidden or archive folders, or
  code). On the map a document absorbs an extracted entity of the same name, one event under several
  names becomes one node when the dates agree, and an entity whose note is not on the map is not
  drawn. Live map: 6,320 → 5,608 nodes before the store itself converges.
- **Brain map: lighter on laptops.** The withdrawn 3D renderer's three.js no longer loads at
  startup (renderer bundle 8.9 MB → 7.7 MB); a settle on a slow GPU stops after 15 s and keeps the
  layout as it stands; hovering with nothing lit no longer re-uploads the link buffers; the
  simulation is drawn only while it runs.
- **Brain map: hovering or locking a node now lights its connections.** The GPU renderer greys
  links only through its own link-highlight list, which the adapter never set, so a focused
  neighbourhood dimmed its points while ten thousand full-colour links kept drawing over them and
  nothing visibly changed. Lit links now take the accent (the anchor's own brighter), everything
  else recedes to the legacy painter's accepted levels, and the neighbourhood's members get labels.
- **Brain map: the core and the folder hubs are back.** The graph builder's duplicate fold judged
  by label with no exemption for the map's skeleton, so the core had folded onto an extracted
  topic of the same name and 8 of 11 folder hubs onto same-label entities: no centre, no core
  mark, a two-folder legend. Structural nodes never enter a fold; a product-store node wins its
  fold over any extracted mention of it.
- **Clusters: stable colours, a legend without duplicates, and a fresh assignment after a
  reindex.** Cluster colour is seeded by the cluster's top hub instead of its size rank (two
  clusters swapped colours whenever an edit reordered them; clusters 17..30 shared colours with
  1..14 in the same legend); only the sixteen largest are coloured. The per-node cluster map is
  refetched whenever the graph changes instead of once per session.
- **Brain map: a hover no longer re-walks every node to choose labels** (the pass the renderer had
  already measured at a 50 ms p90 and banned mid-zoom ran on each hover enter and leave).
- **Memory: a fact you stated is never retired, pruned, evicted or relabelled by a model on its
  own.** The auto-supersession judge now offers model-extracted triggers only model-inferred facts,
  and the replacements it mints are tagged `machine` instead of inheriting the retired fact's
  `operator` label; the verification pass never prunes an operator-stated candidate; cap eviction
  drops model churn first; consolidation no longer absorbs an operator statement into a model
  superset (`isOperatorStated`, `electron/services/brain/operator-model.ts`).
- **Memory files deleted outside the app stay deleted.** The watcher journals an external deletion,
  so the boot rehydrate no longer restores it from the vault mirror.

### Changed
- **The README leads with what you get and names the retrieval stack.** The capability list and
  the is/is-not section move above the harness walkthrough, each capability says what it needs
  (nothing / a model / your grant), and the substrate is stated instead of implied: BM25 over a
  CJK-aware tokenizer, vectors in sqlite-vec with a multilingual-e5-small embedder, fused by
  weighted reciprocal-rank fusion, then a bge-reranker-base cross-encoder. Two claims that had
  gone stale are corrected in all three languages: the 3D map was removed from the product, and
  Learning is now reached through Home rather than its own launcher.
- **Home says "1 thing needs you" rather than "1 decision is waiting on you."** It is the Needs
  you tab's own language. Decisions is the record of calls you made and the place you score
  them, so the old wording sent you to a page that could never hold the thing waiting.
- **Learning and Decisions read as one product.** Both surfaces now share one grammar: a
  summary line instead of a paragraph, small-caps section labels, hairline rows instead of card
  walls, verbs as text with the primary one in the accent, history folded until asked for.
  Learning leads with what awaits your ratification, then what is proving out, then the rules
  in force; vetoed, superseded, retired claims and taste start folded. Decisions leads with
  what waits on you (a call to score, a cascade to approve), then the record; "Record a
  decision" opens inline instead of sitting as a permanent form above everything.
- **Status, Learning, Automations, Background tasks and After action fold into Home.** They
  keep their panels and open from Home's lines and its Details row (and from deep links), but
  no longer sit in the launcher as five equal doors to one question. Home is the default
  right-panel surface; the Explorer is one tap away.
- **Every Settings page is built from the settings kit.** Section labels, card rows with the
  control on the right, a Saved mark when an auto-applied write is confirmed, one Save per form with
  a confirm before leaving the tab, an accessible name on every control, and the same storage
  sentence for secrets everywhere. Roughly a thousand Settings strings are now localized (zh-CN, ja).
- **One home for keys.** Model-provider keys come first on API Keys and the search keys second;
  Web Tools links there instead of hosting its own inputs; finance, weather and image keys stay with
  their tool in one key card; Ollama no longer asks for a key.
- **The Workflows tab is now Automations** and holds only settings: schedules and loops, with the
  Background-autonomy dependency stated next to the schedule switch.
- **Copy pass across Settings:** the demo graph, the multi-agent pipeline, "Opus 4.5 era", phase
  codes, lamprey, the GitHub promises that had no surface, and "GPT-4-ish" are gone; the "Caveman"
  tone is "Terse"; developer hints no longer surface as user copy.
- **settings:set checks the file's shape.** A key DUIN does not know, or a known key with a value
  of the wrong kind, is refused by name instead of persisted. Every read of settings.json runs the
  provider-policy migration.
- **The brain map reads notes first.** Extracted entities draw smaller and fainter than the
  vault's own notes; link ink adapts to how many links are drawn (the whisper alpha was tuned for
  a 16k-link map); the core mark is small, the largest hubs are capped; a whole-map frame fits
  the body of the map (2..98% of nodes) with more padding and re-frames after a rebuild that
  changed the map's shape; click-to-focus zooms to 3x instead of 6x. With Clusters on, nodes lean
  toward their community's colour instead of being recoloured outright.
- **The brain map's physics is the d3 worker again by default.** cosmos.gl's GPU simulation
  (cluster pull, gravity) is opt-in via `localStorage.brainLayout=gpu`; the map keeps the spread
  the worker gives it and the sliders drive the worker's forces.
- **A hovered or locked neighbourhood's links are solid gradients**, running from the node's
  colour into each neighbour's, instead of a dotted accent stroke. Whether a relation was typed
  in a note or inferred by the brain is still in the link tooltip.
- **The first-run ready step leads with the model.** Connecting a model — a local Ollama, or a
  service key — is the one choice that decides whether the brain grows, so it is now the first
  block on "Your brain is ready", with the service cards inline (one tap opens the key form); an
  already-connected model reads as one line. The folder, the daily digest and computer access
  each take one line; the "how DUIN answers" explainer and the generic come-back nudge are gone
  from the step, and a concrete come-back reason is now localized. The welcome copy is shorter.
  The composer's folder chip follows the brain folder chosen in first-run setup.
- Concept files under `.brain/memory/` now say how to use them ("rewrite the claim line to restate this fact; delete the file to retract it") instead of "do not hand-edit"; files written with the old marker are still recognised and regenerated once.
- The page leads with the harness: memory, judgment and autonomy, each earned and governed; tagline "Agents that earn your trust."
- README and docs describe memory as it ships: memory files (Markdown, user data, mirrored into
  `.brain/`), the learned-fact ledger (JSON), and claims; concept materialization documented as
  opt-in (`DUIN_SEAM_MATERIALIZE=1`); the human verbs named per panel; memory upkeep named as
  running by default. The keyless "candidate awaits your review" card now opens the Relations
  panel, where promote and veto live.

### Removed
- Three settings keys nothing read: `theme`, `sidebarCollapsed`, `artifactPanelWidth`.
- The `snip:setEnabled` / `snip:setVerbose` IPC channels (the master switch is an ordinary setting).
- **The 3D brain map and its three.js dependencies.** The control was withdrawn on 2026-08-26
  for lag; the code path (`brain-graph-3d.tsx`), `react-force-graph-3d`, `three` and
  `three-spritetext` are gone from the tree and the install. The 2D canvas fallback for machines
  without WebGL2 stays.

## [0.1.0] - 2026-09-01

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
- **Repository**: public home at `Mentis-lab/duin-governed-agent-memory`; downloads and auto-update from GitHub
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

## Brainframe 0.2.0 - 2026-06-20 (predecessor, not published)

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

## Brainframe 0.1.0 - 2026-06-20 (predecessor, not published)

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

[Unreleased]: https://github.com/Mentis-lab/duin-governed-agent-memory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Mentis-lab/duin-governed-agent-memory/releases/tag/v0.1.0
