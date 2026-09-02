# DUIN

### Agents that earn your trust.

**Every agent you run writes its own memory, grades its own judgment and asks for its own permissions. DUIN is a harness that makes it earn all three, in files you own.**

DUIN is an open harness for personal agents: long-term memory, a working model of your world, and the rules for what an agent may do, kept as Markdown in a folder you own and governed at every step. Memory is earned: every fact is labelled as something you said or something a model inferred, proven over sessions before it becomes a rule, superseded with its history kept, and never revised by a model once you stated it. Autonomy is earned too: the agent asks before it acts outside your notes, background loops stay off until you turn them on, and any other agent, Claude Code included, mounts the same memory over MCP with exactly the grants you approve. Local, MIT, no account.

[Download](https://github.com/Mentis-lab/DUIN/releases/latest) · [The harness](#the-harness) · [With Claude Code](#with-the-agents-you-already-run) · [Getting started](docs/getting-started.md) · [Architecture](docs/architecture.md) · [FAQ](docs/faq.md) · [Discussions](https://github.com/Mentis-lab/DUIN/discussions) · [Security](SECURITY.md)

[![CI](https://github.com/Mentis-lab/DUIN/actions/workflows/ci.yml/badge.svg)](https://github.com/Mentis-lab/DUIN/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Mentis-lab/DUIN)](https://github.com/Mentis-lab/DUIN/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/hero.gif" alt="Open a note from the Explorer, ask in its context, and read the answer with the note it cites" width="100%" />
</p>
<p align="center"><sub>The author's own vault, about 1,200 notes: open a note from the Explorer, ask in its context, read the answer with the note it cites. Answered by DeepSeek V4 Flash; the citation comes from local search.</sub></p>

**0.1, first public release.** The rough edges and the plan for each: [#10](https://github.com/Mentis-lab/DUIN/issues/10). Next: signed installers with automatic updates, a custom Ollama endpoint, a per-turn spend ceiling.

---

## The harness

Three things an agent normally does on its own authority. In DUIN each one is governed, visible, and kept in files you own.

### Memory: facts are earned, not appended

A harness appends what it decides to a memory file and re-reads it. DUIN puts each fact through a process, visible in the Learning panel and in your vault:

- **Labelled at capture.** "Remember that I prefer replies that lead with the conclusion" is recorded as something you said; a model's inference from your turns is recorded as inferred. The label is stamped when the fact is created and never back-filled.
- **On probation.** A new fact grounds softly while it proves out over several sessions and an independent check: a jury of a different model when one is connected, your ratification when not. A fact that fails is reverted.
- **A rule, as a file.** A confirmed fact becomes a concept file under `.brain/memory/` with its status, source, dates and lineage. Rewrite its claim line and DUIN records your version as a statement superseding the old one; delete the file and the fact is retracted.
- **Superseded, never overwritten.** A contradicted fact is retired with the pointer to what replaced it, its file moves to `.brain/_retired/`, and you can reinstate it.
- **Your word is final.** A fact you stated is never retired, pruned or relabelled by a model on its own.

What one of those files looks like:

```yaml
---
id: concept-of_12_k9a
name: Prefers replies that lead with the conclusion
description: "Prefers replies that lead with the conclusion, then the evidence."
type: learned
metadata:
  kind: preference
  factId: of_12_k9a
  status: promoted          # candidate → provisional → promoted
  source: operator          # you said it; a model can never revise this fact
  adjudicatedBy: human      # you ratified it
  capturedAt: 1787115440387
  promotedAt: 2026-08-19
  supersedes: [of_7_c2q]    # the fact this one replaced; its file is in .brain/_retired/
tags: [preference, promoted, learned]
---
```

### Judgment: a model of your world, not a blob in the prompt

- From your notes and what it learns, DUIN extracts the people, projects, decisions and open threads in your work into a graph you can explore, and keeps it current as you write. Open loops and converging threads are tracked over time.
- Extracted claims carry a valid-from and valid-to, a verdict and the reason. A model-proposed retirement is applied only above a confidence guard, is shown to you as applied or blocked, and your ruling on it is a pin that survives every later pass. The brain can answer what was believed as of a date.
- Decisions carry review dates and your own verdicts on them, so the record says what turned out right.
- Answers cite the notes they stood on, and when the notes hold too little evidence DUIN says so rather than filling the gap. Search and reranking run on your machine; no key is needed for any of this except the extraction that builds the graph.

### Autonomy: earned by rung, granted by you

- The agent edits files, runs commands, and uses MCP servers, skills, hooks and subagents. Shell commands, deletes, moves and anything outside your notes ask first.
- Recurring automations and background loops ship off; you switch each one on. Once you do, changes the harness proposes to its own settings are staged until you ratify them, and a run that misbehaves trips a breaker only you can re-arm.
- Inbound messages from channels never carry the execution token, and a fact taught from outside is quarantined until you promote it.
- Other agents mount DUIN over MCP. What each may read or write is a grant you approve in the app, plane by plane, and it can be narrower than what was asked.
- The boundary is the approval prompt and the operating system's own dialog, not a sandbox. What that does and does not protect against is in [SECURITY.md](SECURITY.md).

Details, from the code: [architecture](docs/architecture.md).

## Download

| Windows | macOS | Linux |
|---|---|---|
| [DUIN-x64.exe](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-x64.exe) | [DUIN-arm64.dmg](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-arm64.dmg) | [DUIN-x86_64.AppImage](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-x86_64.AppImage) |

Also [DUIN-amd64.deb](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-amd64.deb) and [DUIN-arm64.zip](https://github.com/Mentis-lab/DUIN/releases/latest/download/DUIN-arm64.zip).

Installers are large because the two on-device encoders (search and reranking, about 412 MB) ship inside them; the rest is Electron and the app. Search and grounded answers work offline from the first launch. Nothing is sent anywhere until you connect a model. No GPU is needed.

<details><summary>Unsigned builds, and how to verify a download</summary>

Windows shows a SmartScreen warning: choose **More info → Run anyway**. macOS: right-click the app and choose **Open** the first time. Linux builds come from CI and have not yet been run by the maintainers. Each release attaches `latest.yml`, `latest-mac.yml` and `latest-linux.yml` with the SHA-512 of every file; the commands to check them, and how updates work, are in [docs/getting-started.md](docs/getting-started.md#9-verify-a-download).

</details>

## First run

1. Install DUIN and launch it. When the welcome screen asks for a folder, choose the one that holds your Markdown notes. An Obsidian vault works as-is; so does an empty folder. Your notes are the memory it starts from.
2. Tell it something: "Remember that I prefer replies that lead with the conclusion." Open **Learning**. The fact is there, labelled as something you said.
3. Ask about something you know you wrote down. With nothing configured, the answer comes from your notes with the notes it stood on, or DUIN says the notes hold too little.
4. Connect a model (Settings → API Keys, or a running Ollama). Facts now go through the jury instead of waiting for you, and **Brain** shows the people, projects and decisions in your notes as a map.
5. Optional: mount it into Claude Code (below) so the agent you already use remembers you the same way.

What lands on disk at each step: [docs/getting-started.md](docs/getting-started.md).

## What you get

- **Memory that earns its place.** Every fact labelled, proven over sessions, superseded with history, and yours to ratify, veto, un-veto or reinstate from the Learning panel or by editing the files in your vault. A fact you stated is never overruled by a model.
- **A map of what you are working on.** People, projects, decisions and open threads, extracted into a graph you can explore in 2D and 3D, with open loops tracked over time. Needs a connected model.
- **Answers you can check.** Grounded answers cite the notes they stood on and refuse when the evidence is thin. On-device search and reranking, no key.
- **An agent with hands, on a leash.** Files, commands, MCP servers, skills, hooks and subagents, with approvals for anything outside your notes and loops off by default.
- **One memory, every agent.** Claude Code or any MCP client mounts the same memory and map with the grants you approve.
- **No key required.** Search, grounded answers and the memory itself work with nothing configured. For conversation, the jury and the graph, connect OpenAI, Anthropic, Google Gemini, DeepSeek, Moonshot, Zhipu, DashScope (Qwen), xAI, Mistral, Groq, DeepInfra, GitHub Models or OpenRouter, or a local model through Ollama.
- **Your files stay yours.** Plain Markdown in a folder you own; an Obsidian vault works as-is. DUIN never edits your existing notes. It adds four Markdown files to the root and keeps its own state in `.brain/`, `.duin/`, `.trash/` and `_agui_outputs/`, all text you can ignore in sync or git. Interface in English, Chinese and Japanese.

<p align="center">
  <img src="docs/assets/screenshot-app.png" alt="DUIN on a real vault of roughly 1,200 notes: the Brain view, the chat composer and the Explorer surfaces" width="100%" />
</p>
<p align="center"><sub>DUIN on the author's own vault, roughly 1,200 notes.</sub></p>

## With the agents you already run

Claude Code and Codex are stronger agents, and each keeps a memory file of its own. DUIN is the memory they can share, and the one that is governed.

- **Claude Code.** Run `/plugin marketplace add https://github.com/Mentis-lab/DUIN` and then `/plugin install duin-brain@duin`. With DUIN running, the session can read your context and beliefs (`duin_brief`, `duin_retrieve`, `duin_beliefs`, `duin_context`) and, only if you grant it in Settings → Agents, teach corrections or write memory. Every grant is approved by you in the app. The pairing flow, planes and tools: [plugins/duin-brain/README.md](plugins/duin-brain/README.md). Install verified from this repository on 2026-09-02 with a clean Claude Code configuration.
- **Any other MCP client** that speaks HTTP with a bearer header, Codex included where its client allows it, mounts the same endpoint: `http://127.0.0.1:8799/exec/mcp`. Until an agent is paired, the endpoint offers only the two pairing tools.
- **The other direction.** DUIN's own chat can be driven by an external brain over AG-UI (`DUIN_BRAIN_URL`), and the agent can hand a task to another harness as a governed child (`delegate_task`), with DUIN deciding every tool call.

## How it compares

- **A harness's own memory** (Claude Code's memory files, `AGENTS.md`, `CLAUDE.md`): rules you write by hand, and memory the model appends and rewrites, with no record of who said what and no history. DUIN labels, proves, supersedes and keeps history, and refuses a model the right to revise what you said.
- **Agent memory systems** (OpenClaw, mem0, Letta): SDKs and always-on runtimes; memory written by the model, last write wins, no source labels. DUIN is an app plus files, not an API; its memory is grounded in your notes, cited, labelled by provenance, proven over sessions, and yours to rule on.
- **Editor plugins** (Copilot for Obsidian, Smart Connections): chat and related notes inside the editor, on mobile too, and lighter: Smart Connections runs local embeddings in a few megabytes where DUIN ships 412 MB of encoders. They keep no governed memory of you.
- **Local RAG apps** (AnythingLLM, Khoj): documents into workspaces or a server, with web and mobile clients. DUIN reads your folder in place, needs no server, and answers with no key.
- **Reor**: a notes app with AI search built in. DUIN is not an editor; it reads the notes you keep elsewhere.

## What DUIN is, and is not

- It is a harness that governs an agent's memory, judgment and autonomy, not a coding agent with a memory file. The agent shell is deliberately the thinner part; the governance is the product.
- It reads a folder of Markdown you already have. Keep editing it with any editor; DUIN never edits your existing notes.
- It is local-first, not offline-only. Search, grounded answers and the memory work with no key. Extraction, conversation and the jury need a model: a cloud key or a local Ollama.
- It is single-user. No sync, no team space, no server mode, no SDK. Nothing listens beyond `127.0.0.1`.

## Known limitations in 0.1

- A fact takes time to be trusted. Probation is the point, but it means a preference you state today grounds softly until it is ratified or has proven out; ratify it yourself if you want it now.
- Recall is on par with plain retrieval, not better: on LongMemEval, two pre-registered runs, DUIN scored 1.0 below a naive-RAG baseline overall and 7.7 above it on temporal questions. The harness and results are in `bench/longmemeval/`.
- Installers are unsigned; updates are notify-only until signing lands.
- Linux builds come from CI and have not been run by the maintainers.
- With a key connected, one turn is several model calls, and the first graph build reads the whole vault. Start with a small model or a free tier.
- Slow local models can trip the 90 s idle budget (`DUIN_TURN_STALL_MS` raises it).
- Ollama is fixed to `127.0.0.1:11434`; there is no custom endpoint yet.
- The conversation database is not encrypted. Use disk encryption.

The full list, with what is planned for each: [#10](https://github.com/Mentis-lab/DUIN/issues/10).

## Runs on

Windows x64, macOS on Apple silicon, and Linux x64 (AppImage or deb). No GPU is needed; the encoders run on the CPU. Installed size and memory figures will be published once measured on a reference machine.

## Privacy and cloud usage

- Your notes stay where they are. DUIN keeps its index, conversations and settings in the app's user-data directory, and its own state in your vault under `.brain/` and `.duin/`.
- Embedding and reranking run on your machine. No telemetry. Crash reports are not uploaded.
- Without a key, the only network traffic is the update check against GitHub Releases (Settings → General to disable) and, if your build lacks the bundled encoders, a one-time model download.
- With a key, your question plus the relevant note excerpts go to that provider on every turn, and building the graph sends your notes to it in batches. DUIN asks before the first vault-wide extraction; recurring automations stay off until you enable them. Memory upkeep (the jury that verifies facts, and the pass that retires stale ones) sends short prompts to the same provider on its own.
- Keys are stored with the operating system's credential store through Electron `safeStorage` (Keychain on macOS, DPAPI on Windows).
- The agent asks before it acts. Full computer access (Settings → General, off by default) removes those prompts for local operations. The threat model: [SECURITY.md](SECURITY.md).

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

Contributor setup, running a second DUIN beside an installed one, and the checks CI runs: [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation and community

- [Architecture](docs/architecture.md): the memory model first, then the three processes, the brain on `127.0.0.1:8799`, storage, and the AG-UI contract for connecting an external brain (default endpoint `http://127.0.0.1:8799/agui`, `DUIN_BRAIN_URL` points DUIN at another AG-UI server) · [Getting started](docs/getting-started.md) · [Skills](docs/skills.md) · [FAQ](docs/faq.md) · [What DUIN is](docs/constitution.md) · [Glossary](docs/glossary.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md) · [Releasing](docs/RELEASING.md).
- Questions: [Discussions → Q&A](https://github.com/Mentis-lab/DUIN/discussions/categories/q-a). Ideas: [Discussions → Ideas](https://github.com/Mentis-lab/DUIN/discussions/categories/ideas). Bugs: [Issues](https://github.com/Mentis-lab/DUIN/issues/new/choose). Security: [private report](https://github.com/Mentis-lab/DUIN/security/advisories/new).
- There is no Discord yet: one maintainer, and Discussions stay searchable. If DUIN is useful to you, a star helps others find it.

## Contributing

Bug reports, fixes and documentation improvements are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the checks every PR must pass, and the PR size guidance.

How the code is written: DUIN is developed with AI coding agents under one human maintainer. Every change passes the type checker, the linter, the test suite (about 10,600 tests, in the tree) and a proof gate before it lands. The tests are the specification for the harness behaviour described above.

## Attribution

DUIN started from [lamprey-harness](https://github.com/USS-Parks/Lamprey-Harness) by Basho Parks (MIT). The agent shell, chat UI, skills and MCP plumbing, and the Electron build pipeline began there. DUIN adds the in-process brain, the knowledge graph and its console, grounding, memory, foresight and governance. Some on-disk and environment identifiers still carry the `lamprey` name; they are listed in [docs/legacy-names.md](docs/legacy-names.md).

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Third-party notices for bundled models and libraries ship with the installers.
