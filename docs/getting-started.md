# Getting started

The first run, step by step, on a fresh install. It says what DUIN writes and where, so
nothing that lands on disk is a surprise.

## 1. Install

- **Windows:** run `DUIN-x64.exe`. It is a per-user installer and needs no admin rights. The
  build is unsigned, so SmartScreen warns on first run: choose **More info → Run anyway**.
- **macOS (Apple Silicon):** open `DUIN-arm64.dmg` and drag DUIN to Applications. The build is
  ad-hoc signed and not notarized, so the first time, right-click the app and choose **Open**.
- **Linux:** an AppImage (`chmod +x` then run it) and a `.deb` are produced by CI but have not
  been tested by the maintainers yet. Storing keys needs a Secret Service (GNOME Keyring or
  KWallet); without one DUIN asks before storing a key in plaintext.

Downloads and checksums: [README → Download](../README.md#download).

## 2. First launch

- The interface follows your OS language (Chinese and Japanese are shipped; anything else falls
  back to English). You can pin a language in Settings.
- The brain server starts on `127.0.0.1:8799`. Nothing listens on the network.
- If your build lacks the bundled encoder models, DUIN downloads them from Hugging Face now
  (about 135 MB for the embedder and 280 MB for the reranker). Installers from GitHub Releases
  include them, so this step is normally silent.
- DUIN checks GitHub Releases for a newer version (Settings → General to turn that off) and
  checks whether a local Ollama is running.
- Three default hooks are seeded: a session-start log line, a guard that blocks unmistakably
  destructive shell commands, and a tool audit line. They run in a sandbox with no file or
  network access; you can edit or delete them in Settings → Hooks.

## 3. Choose a folder

The welcome screen asks for a folder. Click **Choose a folder** and pick any folder of Markdown
notes, or an empty folder: DUIN starts your brain there as plain files you own.

You can answer three optional questions first (what you are working on, a decision you are
weighing, anything that might slip). DUIN saves the answers as notes in your brain. **Skip for
now** marks onboarding complete with no folder; you can pick one later in Settings → Brain (that
path indexes the folder but does not write the foundation files below).

When you pick a folder, DUIN:

1. Records it as your vault and indexes every Markdown file (full-text and vector index).
2. Writes four **foundation files** in the folder root: `ME.md` (who you are), `BRAIN.md` (how
   DUIN must operate), `SOUL.md` (DUIN's character) and `GOALS.md`. They are ordinary Markdown;
   edit them.
3. Creates `.brain/` with `memory/` (typed concept files such as `_about-<pillar>.md` and a
   `_concept-index.md`) and, over time, `_moat/` (operator model, success traces and
   capability tables), `_backups/` and `_exports/`.
4. Creates `.duin/` with `_state/` (the brain's ledgers), `_backups/` (daily snapshots) and
   `_agui_entities.json`.
5. Later, as you use it: `.trash/` (anything the agent deletes goes here first) and
   `_agui_outputs/` (documents the agent produces).

Everything DUIN keeps about you is in those folders as text you can read, edit, diff and
delete. Add `.brain/`, `.duin/`, `.trash/` and `_agui_outputs/` to your sync or git ignore
rules if you do not want them replicated.

## 4. The ready screen

Once indexing finishes you see **Your brain is ready** with the note count. Two things are
optional here:

- **Connect a model.** Pick a provider card and paste a key ("Get a key" opens the provider's
  page; most have a free tier). The key goes into the OS keychain. As soon as a key is saved,
  DUIN starts building the entity graph (people, projects, decisions and how they connect) from
  your notes. That runs in the background and takes minutes on a large vault. If the provider
  rejects the request (no balance, no quota), the ready screen says so and DUIN retries as
  notes change.
- **A daily digest.** A once-a-day summary of what changed, delivered as an OS notification.
  It stays on the device.

Without a key you can still search and ask questions. The ready screen says **Connect an AI
model to build your knowledge graph** because the entity graph needs a model; the note graph
(notes and their links) draws without one.

## 5. Your first question

Type a question in the chat.

- **Without a key:** DUIN answers from the notes it found, deterministically (retrieved passages
  plus its own insights, risks and open loops), and ends with a hint to connect a model.
- **With a key:** DUIN retrieves, reranks and answers through your provider, citing the notes
  it used. A turn is several model calls (the answer, a retrieval agent, and extraction of
  what is worth remembering), so a metered account sees real usage.

Retrieval appears as a `search_notes` call above the answer, so you can see which notes it
stood on. If the notes do not cover the question, DUIN says so instead of guessing.

## 6. Finding your way around

- **Chat** is the home surface. The model picker offers **DUIN brain** (grounded in your notes)
  and any provider models you connected.
- **Brain** shows the graph: a 2D map and an orbitable 3D field. Click a node to see its
  relations and launch a chat scoped to it. The **Explorer** lists what the brain holds, tiered
  into Memory and Concepts.
- **Customize** holds skills, methods, connectors (MCP servers) and plugins. Bundled skills
  ship disabled; switch on what you want. See [skills.md](skills.md).
- **Settings** holds API keys, models, general options (computer access, updates), hooks,
  loops, automations, executors, permissions, notifications and GitHub.

## 7. Where things live

The user-data directory is `%APPDATA%\DUIN` on Windows, `~/Library/Application Support/DUIN` on
macOS and `~/.config/DUIN` on Linux.

| Path | What it holds |
| --- | --- |
| `<userData>/settings.json` | Settings (mode `0600`). |
| `<userData>/keys.json` | API keys and tokens, encrypted with the OS keychain. |
| `<userData>/lamprey.db` | Conversations, the memory index, ledgers (SQLite). |
| `<userData>/local-brain.db` | The notes index (vectors and full text). Rebuildable from your notes. |
| `<userData>/lamprey-memory/` | "Remember this" memory files, one per fact. Canonical; the database mirrors them. |
| `<userData>/models/transformers/` | Downloaded encoder models. |
| `<userData>/skills/`, `plugins/`, `mcp-servers.json` | Your skills, plugins and MCP server configs, seeded from the bundled set. |
| `<userData>/backups/` | Daily snapshots of the databases. |
| `<vault>/ME.md`, `BRAIN.md`, `SOUL.md`, `GOALS.md` | Foundation files. |
| `<vault>/.brain/` | Memory concepts, the operator model, exports, backups. |
| `<vault>/.duin/` | Brain state ledgers and snapshots. |
| `<vault>/.trash/`, `<vault>/_agui_outputs/` | Deleted files; agent deliverables. |

The `lamprey` names are inherited from the upstream harness; see
[legacy-names.md](legacy-names.md).

## 8. Changing your mind

- **Switch folders** in Settings → Brain. The new folder is indexed; foundation
  files are written only by onboarding.
- **Turn things off:** the update check (Settings → General), hooks (Settings → Hooks),
  background loops and autonomy (Settings → Loops), automations (Settings → Automations).
- **Full computer access** (Settings → General) lets the agent read, write, move and delete
  anywhere and run shell commands without prompts. It is off by default; read
  [SECURITY.md](../SECURITY.md) before turning it on.
- **Remove DUIN:** uninstall the app and delete the user-data directory. Your vault keeps the
  foundation files and the `.brain/`, `.duin/`, `.trash/` and `_agui_outputs/` folders; delete
  them if you want the folder back exactly as it was.
