# DUIN

### Your notes, answering back.

<p align="center">
Ask a folder of Markdown notes a question and get the answer with the note it came from. Connect a model and DUIN maps the people, projects and decisions inside your notes, keeps track of what is still open, and puts an agent to work on your files that asks before it acts. Local, MIT, no account.
</p>

<p align="center">
  <a href="https://github.com/Mentis-lab/DUIN/releases/latest"><b>Download</b></a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/faq.md">FAQ</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="https://github.com/Mentis-lab/DUIN/discussions">Discussions</a> ·
  <a href="https://github.com/Mentis-lab/DUIN/issues/new/choose">Report a bug</a> ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/Mentis-lab/DUIN/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Mentis-lab/DUIN/ci.yml?branch=main" /></a>
  <a href="https://github.com/Mentis-lab/DUIN/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/Mentis-lab/DUIN" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/Mentis-lab/DUIN" /></a>
</p>

<p align="center">
  <img src="docs/assets/hero.gif" alt="Asking DUIN what its own evidence gate is: the answer arrives with the notes it came from, then the chat closes to show the map of the vault behind it" width="100%" />
</p>
<p align="center"><sub>The author's own vault, about 1,200 notes: ask, read the answer with the notes it cites, close the chat, see the map.</sub></p>

**0.1, first public release.** The rough edges, and what is planned for each: [#10](https://github.com/Mentis-lab/DUIN/issues/10).

---

## Download

<p align="center">
  <a href="https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-x64.exe"><img alt="Download for Windows (x64)" src="https://img.shields.io/badge/Windows-x64%20installer%2C%20~650%20MB-0078D4" /></a>
  <a href="https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-arm64.dmg"><img alt="Download for macOS (Apple Silicon)" src="https://img.shields.io/badge/macOS-Apple%20Silicon%2C%20~710%20MB-111111" /></a>
  <a href="https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-x86_64.AppImage"><img alt="Download for Linux (AppImage)" src="https://img.shields.io/badge/Linux-AppImage%2C%20~950%20MB-777777" /></a>
</p>

Also [`DUIN-amd64.deb`](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-amd64.deb)
and [`DUIN-arm64.zip`](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-arm64.zip).
Installers are large because the on-device search models ship inside them, so search works
offline from the first launch. Nothing is sent anywhere until you connect a model.

<details>
<summary>Unsigned builds, and how to verify a download</summary>

Windows shows a SmartScreen warning: choose **More info → Run anyway**. macOS: right-click the
app and choose **Open** the first time. Linux builds come from CI and have not yet been run by
the maintainers. Each release attaches `latest.yml`, `latest-mac.yml` and `latest-linux.yml`
with the SHA-512 of every file; the commands to check them, and how updates work, are in
[docs/getting-started.md](docs/getting-started.md#9-verify-a-download).
</details>

## First run

1. Install DUIN and launch it. When the welcome screen asks for a folder, choose the folder
   that holds your Markdown notes; an Obsidian vault works as-is, and so does an empty folder.
2. Ask a question. With nothing configured you get an answer drawn from your notes, with the
   notes it came from.
3. Connect a model (Settings → API Keys, or a running Ollama) for conversational answers, and
   open **Brain** to watch the people, projects and decisions in your notes become a map.

What lands on disk, step by step: [docs/getting-started.md](docs/getting-started.md).

## What you get

<table>
<tr><td><b>Answers you can check</b></td><td>Ask in plain language. Grounded answers cite the notes they stood on, and when your notes hold too little evidence DUIN says so rather than filling the gap. Search and reranking run on your machine with bundled encoders.</td></tr>
<tr><td><b>A map of what you are working on</b></td><td>People, projects, decisions and open threads, extracted from your notes into a graph you can explore in 2D and 3D. Click a node to chat about it. Open loops and converging threads are tracked over time. Needs a connected model.</td></tr>
<tr><td><b>An agent with hands, on a leash</b></td><td>It edits files, runs commands, and uses MCP servers, skills, hooks and subagents. Shell commands, deletes, moves and anything outside your notes ask first. Background loops ship off; you switch each one on.</td></tr>
<tr><td><b>Memory you can read</b></td><td>What DUIN learns about you is kept as Markdown you can open, diff and overrule. Each fact is labelled as something you said or something DUIN inferred, and a fact you stated is never aged out by a model on its own. How it works: <a href="docs/architecture.md#memory-provenance-and-supersession">architecture</a>.</td></tr>
<tr><td><b>No key required</b></td><td>Search and grounded answers work with nothing configured. For conversation and the graph, connect OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot, Zhipu, DashScope (Qwen), xAI, Mistral, Groq, DeepInfra, GitHub Models or OpenRouter, or a local model through Ollama.</td></tr>
<tr><td><b>Your files stay yours</b></td><td>Plain Markdown in a folder you own; an Obsidian vault works as-is. DUIN never edits your existing notes. It adds four Markdown files to the root and keeps its own state in <code>.brain/</code>, <code>.duin/</code>, <code>.trash/</code> and <code>_agui_outputs/</code>, all text you can ignore in sync or git. Interface in English, Chinese and Japanese.</td></tr>
</table>

<p align="center">
  <img src="docs/assets/screenshot-app.png" alt="DUIN on a real vault of roughly 1,200 notes: the Brain view, the chat composer and the Explorer surfaces" width="100%" />
</p>
<p align="center"><sub>DUIN on the author's own vault, roughly 1,200 notes.</sub></p>

## How it compares

- **Editor plugins** (Copilot for Obsidian, Smart Connections) give you chat and related notes inside the editor, on mobile too. DUIN is a separate app for asking the whole vault and seeing what is in it; it adds the graph, memory you can read, and an agent with approvals.
- **Local RAG apps** (AnythingLLM, Khoj) ingest documents into workspaces or a server. DUIN reads your folder in place, needs no server, and answers with no key.
- **Coding agents on a notes folder** (Claude Code, Codex) are stronger general agents. They keep no graph or memory between sessions and cost tokens on every question. DUIN keeps both, and exposes its brain to other agents over MCP.
- **Agent memory systems** (OpenClaw, mem0, Letta) keep memory as capped files or a vector store written by the model. DUIN's memory is grounded in your notes, cited, labelled by provenance, and yours to overrule.

## What DUIN is, and is not

- It reads a folder of Markdown you already have. Keep editing it with any editor.
- It is a second brain with an agent attached, not a coding agent with notes attached.
- It is local-first, not offline-only. Search and the note map work with no key. Entity
  extraction and conversational answers need a model: a cloud key or a local Ollama.
- It is single-user. No sync, no team space, no server mode. Nothing listens beyond `127.0.0.1`.

## Known limitations in 0.1

- Installers are unsigned; updates are notify-only until signing lands.
- Linux builds come from CI and have not been run by the maintainers.
- With a key connected, one turn is several model calls, and the first graph build reads the
  whole vault. Start with a small model or a free tier.
- Slow local models can trip the 90 s idle budget (`DUIN_TURN_STALL_MS` raises it).
- Ollama is fixed to `127.0.0.1:11434`; there is no custom endpoint yet.
- The conversation database is not encrypted. Use disk encryption.

The full list, with what is planned for each: [#10](https://github.com/Mentis-lab/DUIN/issues/10).

## Privacy and cloud usage

- Your notes stay where they are. DUIN keeps its index, conversations and settings in the app's
  user-data directory, and its own state in your vault under `.brain/` and `.duin/`.
- Embedding and reranking run on your machine. No telemetry. Crash reports are not uploaded.
- Without a key, the only network traffic is the update check against GitHub Releases
  (Settings → General to disable) and, if your build lacks the bundled encoders, a one-time
  model download.
- With a key, your question plus the relevant note excerpts go to that provider on every turn,
  and building the graph sends your notes to it in batches. DUIN asks before the first
  vault-wide extraction; recurring loops stay off until you enable them.
- The agent asks before it acts. Full computer access (Settings → General, off by default)
  removes those prompts for local operations. The threat model: [SECURITY.md](SECURITY.md).

## Use it with your own notes

Choose any folder of Markdown, including an empty one. DUIN writes four foundation files
(`ME.md`, `BRAIN.md`, `SOUL.md`, `GOALS.md`) and its state folders into it, all plain text you
can read and edit. Connect a model in Settings → API Keys, or run Ollama; keys are stored
encrypted with the OS credential store. The step-by-step walkthrough, including what lands on
disk: [docs/getting-started.md](docs/getting-started.md).

## Build from source

Node.js 22.12 or newer and git. On Windows, clone into a short path or enable long paths.

```bash
git clone https://github.com/Mentis-lab/DUIN
cd DUIN
npm run setup        # npm ci --ignore-scripts + the Electron binary; no Python or C++ needed
npm run dev          # launch the app in development
npm run typecheck && npm run lint && npm test
npm run build:win    # or build:mac / build:linux → ./dist (fetches ~412 MB of encoders once)
```

Contributor setup, running a second DUIN beside an installed one, and the checks CI runs:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation and community

- [Getting started](docs/getting-started.md) · [Architecture](docs/architecture.md) (the three
  processes, the brain on `127.0.0.1:8799`, storage, memory, and the AG-UI contract for
  connecting an external brain: default endpoint `http://127.0.0.1:8799/agui`, `DUIN_BRAIN_URL`
  points DUIN at another AG-UI server) · [Skills](docs/skills.md) · [FAQ](docs/faq.md) · [What DUIN is](docs/constitution.md) ·
  [Glossary](docs/glossary.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md) ·
  [Releasing](docs/RELEASING.md).
- Questions: [Discussions → Q&A](https://github.com/Mentis-lab/DUIN/discussions/categories/q-a).
  Ideas: [Discussions → Ideas](https://github.com/Mentis-lab/DUIN/discussions/categories/ideas).
  Bugs: [Issues](https://github.com/Mentis-lab/DUIN/issues/new/choose). Security:
  [private report](https://github.com/Mentis-lab/DUIN/security/advisories/new).
- There is no Discord yet: one maintainer, and Discussions stay searchable. If DUIN is useful to
  you, a star helps others find it.

## Contributing

Bug reports, fixes and documentation improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md)
has the setup, the checks every PR must pass, and the PR size guidance.

## Attribution

DUIN started from [lamprey-harness](https://github.com/USS-Parks/Lamprey-Harness) by Basho
Parks (MIT). The agent shell, chat UI, skills and MCP plumbing, and the Electron build pipeline
began there. DUIN adds the in-process brain, the knowledge graph and its console, grounding,
memory, foresight and governance. Some on-disk and environment identifiers still carry the
`lamprey` name; they are listed in [docs/legacy-names.md](docs/legacy-names.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party notices for bundled models and
libraries ship with the installers.
