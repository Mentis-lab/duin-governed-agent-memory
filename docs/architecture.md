# Architecture

DUIN is an Electron application: a main process that owns the brain, the agent and all
privileged operations; a sandboxed React renderer; and one preload bridge between them. This
page is the map. The reasons the system has this shape are in [constitution.md](constitution.md),
and the vocabulary is in [glossary.md](glossary.md).

## Processes

| Process | Code | Role |
| --- | --- | --- |
| **Main** | `electron/main.ts` → `electron/ipc/*` → `electron/services/*` | Window lifecycle, IPC handlers, the brain server, providers, tools, MCP, hooks, storage, updater, tray. |
| **Preload** | `electron/preload.ts` | The `window.api` contextBridge. The only way the renderer reaches the main process. |
| **Renderer** | `src/` | React 19, Zustand stores under `src/stores/`, IPC-bound hooks under `src/hooks/`, components by domain (`src/components/chat/`, `brain/`, `settings/`, …). |
| **Utility processes** | `electron/services/rag/embeddings/worker.ts` | The embedding and reranking encoders run in a separate process. |

The renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`.
Renderer code never calls `ipcRenderer.invoke`; it calls a typed binding on `window.api`, and
every IPC handler returns `{ success: true, data }` or `{ success: false, error }`. Contracts
that both sides import live in `electron/shared/`.

## The brain server

The brain is in-process, in `electron/services/local-brain/` (server, gate, retrieval,
grounding) and `electron/services/brain/` (graph construction, memory, foresight,
calibration, governance). It listens on `127.0.0.1:8799` (`DUIN_BRAIN_PORT` overrides) and
speaks HTTP + SSE:

- `POST /agui`: a chat turn (the AG-UI contract below). The renderer talks to it through the
  bridge in `electron/services/duin-bridge.ts`.
- `GET /state/*`, `GET /graph`, `GET /debug/*`: state reads.
- `POST /debug/*`: effectful diagnostics.
- `/exec/*`: the surface for other agents. `/exec/mcp` mounts the brain as an MCP server;
  callers hold bearer principals that are paired through an approval in the app.

Every request passes `electron/services/local-brain/control-plane-guard.ts`: a present,
non-loopback `Host` is refused on every verb; mutating verbs and the effectful GETs listed in
`electron/shared/control-plane-policy.ts` need a per-launch token (`x-duin-control`, held by the
renderer, or `x-duin-exec`); a mutating request with a remote `Origin` is refused. Tokens are
minted when the server starts and reach the renderer over IPC, never over the wire.

Inside a turn, side-effecting tools pass a second gate (`agui-guard.ts`, `agui-gate.ts`,
`agui-approval.ts`): host shell, deletes, moves, out-of-vault writes, mail, spawning and
`create_skill` need the execution token and then an approval decision that depends on the
posture (interactive, review, unattended), persisted policies, the catastrophic-command screen
(`command-screen.ts`), the sandbox state and the autonomy rung.

## Storage

Two places, deliberately. The user-data directory is the app's own; the vault is yours.

**User data** (`%APPDATA%\DUIN`, `~/Library/Application Support/DUIN`, `~/.config/DUIN`):

| File | Owner | Purpose |
| --- | --- | --- |
| `settings.json` | `electron/services/settings-helper.ts` | Settings, written atomically with mode `0600`. Defaults in `default-app-settings.ts`, byte-locked to the renderer's copy in `src/stores/settings-store.ts`. |
| `keys.json` | `keychain.ts` | Secrets, encrypted with Electron `safeStorage`; plaintext only with consent. |
| `lamprey.db` | `database.ts` | Conversations, memory index, ledgers, hooks, sessions (SQLite, WAL). |
| `local-brain.db` | `local-brain/index-store.ts` | The notes index: chunks, FTS5, `sqlite-vec` vectors. Rebuildable. |
| `lamprey-memory/` | `memory-store.ts` | Memory files, one per fact. The files are canonical; SQLite mirrors them. |
| `models/transformers/` | `rag/embeddings/worker.ts` | Encoder cache; bundled copies under `resources/models/` take precedence. |
| `skills/`, `plugins/`, `mcp-servers.json` | `skill-loader`, `plugins`, `mcp-manager.ts` | Seeded from `resources/` on first run, by manifest, so shipped fixes reach existing installs without overwriting edits. |
| `backups/`, `executor-worktrees/` | `backup-runner.ts`, `executor/` | Snapshots; git worktrees for delegated runs. |

**Vault** (the folder you chose):

| Path | Purpose |
| --- | --- |
| `ME.md`, `BRAIN.md`, `SOUL.md`, `GOALS.md` | Foundation files, read into context in that order (`electron/services/brain/foundation-files.ts`). |
| `.brain/memory/` | Concepts: typed Markdown files that make the brain portable and readable. |
| `.brain/_moat/` | The operator model, success traces and capability tables, mirrored from user data every five minutes and restored on boot. |
| `.brain/_backups/`, `.brain/_exports/` | Graph snapshots and exports. |
| `.duin/_state/` | Ledgers: predictions, verdicts, calibration, corrections, health histories. `electron/services/brain/brain-state-dir.ts` is the one resolver for this path. |
| `.duin/_backups/` | Daily moat snapshots. |
| `.trash/`, `_agui_outputs/` | Reversible deletes; agent deliverables. |

The invariant: the **Vault** and **Memory** planes are never derived away; the **Brain** plane
(graph, claims, indexes) is derived and may be rebuilt at any time.

## Memory: provenance and supersession

What DUIN learns is kept as text you can read, and it is never allowed to forget who said what.

- **Three stores.** Your *memory files* (the `#` shortcut, the Memory panel, or a provider model's
  `memory_add`) are Markdown in the user-data `lamprey-memory/` directory; they are the canonical
  copy and SQLite mirrors them (`electron/services/memory-store.ts`). What DUIN *learns about you*
  from your turns is the operator model, a JSON ledger in user data
  (`electron/services/brain/operator-model.ts`), projected into your vault as one concept file
  per fact under `.brain/memory/`. *Claims* extracted from your notes live in
  `.duin/_state/claim-ledger.jsonl` (`electron/services/brain/claim-metabolism.ts`). The first two
  are mirrored into `.brain/` every few minutes; the mirrors are backups, not the place to edit.
- **Provenance.** Every memory file carries a source label: `user-explicit` (you typed it), `session`
  (a model saved it from a conversation), `imported` or `unknown` (`electron/shared/memory-source.ts`).
  Every learned fact carries `operator` (you stated it in chat), `machine` (a model inferred it) or
  `external` (an inbound channel message, quarantined until you promote it). A fact a model inferred
  is never relabelled as something you stated: a model-authored replacement keeps the `machine`
  label ([constitution](constitution.md)).
- **A fact you stated is never aged out by a model on its own.** A model-extracted fact can supersede
  only model-inferred facts; only your own later statement supersedes a fact you stated. The model's
  verification pass never prunes it, the cap evicts model noise before it, and consolidation never
  absorbs it into a model summary (`isOperatorStated` in `electron/services/brain/operator-model.ts`).
- **Claims have a lifetime.** Extracted claims record `validFrom`, `validTo`, `observedAt` and
  `supersededBy`, and each one holds a verdict: `current`, `stale`, `contradicted` or `orphaned`,
  with the reason (`temporal`, `supersession`, `jtms` or `model`). You can ask the brain what was
  believed as of any date on the local API (`GET /state/claim-metabolism?asOf=`).
- **Model supersessions are recorded; human rulings are pinned.** A model-proposed supersession of a
  claim is applied only above a confidence guard and is stamped `verdictBy`; below the guard nothing
  changes. A human confirm or revert (`POST /state/claim-metabolism/resolve`) is a pin that survives
  every later tick, available on the local API and from the Learning panel's "Claims the model
  retired" section, which also shows whether each retirement stood or was blocked and why.
- **Retire, never delete.** Entities and claims are retired by setting `valid_to`, so the graph keeps
  its history (`electron/services/brain/brain-schema.ts`). A superseded learned fact keeps its row
  with `invalidatedAt` and `supersededBy`; a pruned or cap-evicted model candidate is tombstoned in
  the eviction log.
- **Files you can diff and overrule.** Memory files and the `.brain/` mirrors are plain text
  under your own version control. Learned facts — promoted and provisional — materialize as typed
  Markdown under `.brain/memory/` (`concept-<id>.md` with `status:`, `source:`, `capturedAt`,
  `promotedAt` or `provisionalAt`, and `supersedes:` / `supersededBy:`), retired ones moving to
  `.brain/_retired/` (`electron/services/brain/concept-materialize.ts`). This is on by default;
  `DUIN_SEAM_MATERIALIZE=0` turns it off. The files are yours to change: rewrite the claim line
  and DUIN records it as your statement superseding the old fact (a confirmed rule stays
  confirmed); delete a file and the fact is vetoed; anything else you add to a file is left alone
  until the fact itself changes; remove the machine marker and the file is yours for good. A
  seam ledger in `.duin/_state/seam-ledger.json` tells your edits from DUIN's own writes, and
  re-projection never rewrites a file whose bytes would not change.
- **Corrections are input, and the verbs are yours.** The Learn loop captures a correction at the
  turn boundary and feeds it into the promotion lifecycle (`candidate → provisional → promoted |
  vetoed`). From the Learning panel you can ratify a fact on probation (a keyless install parks
  facts there until you do), veto it, take a veto back, or reinstate a fact a newer statement
  replaced; the Needs-you card for parked facts carries Ratify and Veto too. "Confirm" stays the
  govern loop's automatic word; "ratify" is yours. Every row shows its provenance and whether you
  already ruled on it.

## Providers

`electron/services/providers/registry.ts` is the source of truth: the `ProviderId` union, the
`PROVIDERS` table (endpoints, key names, catalogs, extraction defaults) and the client factory.
A parity test asserts the union and the table are member-identical. Chat, extraction, titles
and the background model all resolve through it; the Background model setting (`''` = auto)
picks a per-provider extraction default for whatever key is present. Ollama is a provider like
the others, with a local endpoint.

## Skills, methods, hooks

- **Skills** are Markdown files injected into the system prompt when enabled. Bundled ones live
  in `resources/skills/`; the render paths, budgets and file format are in [skills.md](skills.md).
- **Methods** are vault notes (`type: method`) that compose skills into a sequence, authored in
  Customize or in chat.
- **Hooks** (`electron/services/hooks-runner.ts`) fire on `sessionStart`, `preToolUse`,
  `postToolUse`, `promptSubmit` and `agentStop`. JavaScript hooks run in a frozen `vm` with
  only logging, `Date`/`JSON`/`Math` and read-only event bindings; a `preToolUse` hook that
  throws blocks the call. Three are seeded on first run.

## MCP, plugins, channels, executor

- **MCP** (`electron/services/mcp-manager.ts`): stdio, SSE and HTTP transports, OAuth for
  remote servers, child environments allowlisted. Two seeds ship disabled (a Node REPL and
  Chrome through Playwright). Every mounted tool is offered to the model each turn.
- **Plugins** bundle skills, connectors and commands; installable from a git URL as a reviewed
  two-step (`plugin-install-remote.ts`). `plugins/duin-brain` is DUIN itself as an MCP plugin
  for other agents.
- **Channels** (`electron/services/channels/`): a capability model over transports (Telegram,
  Discord, Slack, Feishu, WeCom, DingTalk, Email). Pairing is deny-first, and an inbound turn
  never carries the execution token.
- **Executor** (`electron/services/executor/`): `delegate_task` runs the DeepSeek Harness as a
  child process in a git worktree, with DUIN deciding every tool call through the gate.

## The AG-UI contract

DUIN's chat UI is driven by a brain over a small streaming HTTP contract called **AG-UI**. The
in-process brain implements it; so can yours.

### Endpoint resolution

The brain URL resolves in this order:

1. An explicit `brainUrl` (Settings, or the option in code).
2. The `DUIN_BRAIN_URL` environment variable.
3. The default, `http://127.0.0.1:8799/agui`.

`:8765` cannot be selected. It was the port of a retired external engine, and any target
resolving there is coerced back to `:8799` by `resolveBrainUrl()` in
`electron/services/duin-bridge.ts`. Point an external brain at any other port.

```bash
# macOS / Linux
DUIN_BRAIN_URL="http://127.0.0.1:9000/agui" npm run dev

# Windows (PowerShell)
$env:DUIN_BRAIN_URL = "http://127.0.0.1:9000/agui"; npm run dev
```

Then pick the **DUIN brain** model in the picker. If nothing is listening, the chat stays
usable and says so.

### Request

`POST` with a JSON body:

```json
{
  "threadId": "conversation-or-thread-id",
  "messages": [{ "role": "user", "content": "the user's prompt" }]
}
```

When the turn carries images, the last user message's `content` becomes an array of text and
`image_url` parts; otherwise it is a plain string.

### Response

An SSE stream (`text/event-stream`) of `data:`-prefixed JSON frames:

| Event | Meaning |
| --- | --- |
| `RUN_STARTED` | Lifecycle start; no chat output. |
| `TEXT_MESSAGE_CONTENT` | A text delta (`delta` field), streamed to the UI. |
| `THINKING`, `REASONING`, `TEXT_MESSAGE_THINKING` | A reasoning delta, shown in the reasoning block and replayed into the next turn's context. |
| `STEP` | An operator-facing status line (the long-turn heartbeat). Shown, not stored as reasoning. |
| `TEXT_MESSAGE_START`, `TEXT_MESSAGE_END` | Lifecycle; no chat peer. |
| `RUN_FINISHED` | Turn complete; the assistant bubble is finalized. |
| `RUN_ERROR`, `ERROR` | Terminated turn (`message` or `error` field), surfaced to the user. |

```
data: {"type":"RUN_STARTED"}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}
data: {"type":"TEXT_MESSAGE_CONTENT","delta":", world."}
data: {"type":"RUN_FINISHED"}
```

A brain that never emits `RUN_FINISHED` is cut off by a deadline and the turn ends as
`RUN_ERROR`. The adapter is `electron/services/duin-bridge.ts`, unit-tested in
`duin-bridge.test.ts`.

**A remote brain is a trust boundary.** If you point `DUIN_BRAIN_URL` at a non-loopback host,
that server receives your prompts and returns content rendered in the UI. Only point it at a
brain you control, over HTTPS.

## The shape in one paragraph

Three planes: the **Vault** (Markdown you wrote), **Memory** (durable facts DUIN keeps, one
per file) and the **Brain** (everything derived from the other two). Four loops: **Ground**
(what bears on this turn), **Remember** (what is worth keeping), **Learn** (what was I wrong
about) and **Govern** (what may I change about myself). The fast loops make DUIN useful; the
slow loops make it yours. [constitution.md](constitution.md) states the properties this shape
must keep and what would prove each one false.
