# Skills

A **skill** is a markdown file whose body is injected into DUIN's system prompt when the operator
switches it on in **Customize → Skills**. It stays on for every message until it is switched off.

Skills are hot-reloaded: drop a `.md` into the skills directory and it appears within ~150 ms.

> **Scope.** A skill teaches the model *how to approach* something. It is not a tool (tools are
> registered in `electron/services/*-tool-pack.ts`), not a subagent, and not a method. A **method**
> (`type: method` note in the vault) composes skills into a sequence — see `resources/skills/method-creator`.

---

## File format

```markdown
---
name: Ground Answers
description: Answer from the operator's own notes before answering from general knowledge. Use for any question about their work, their history, or what they decided.
---
Search before asserting. Classify the question first — decision, status, person,
factual, temporal, exploratory — because each takes a different retrieval move.
```

| Field | Required | What it does |
|---|---|---|
| `name` | yes | Rendered as the `<skill name="…">` attribute and shown in the Customize list. |
| `description` | yes | Rendered as the `description` attribute and used as the list subtitle. Write it in the third person, and say both *what it does* and *when to use it*. |
| body | yes | Everything after the frontmatter, injected verbatim. |
| `allowedTools` | no | **Advisory only.** Rendered as `suggested-tools=`, deliberately *not* `allowed-tools=` — no gate reads it. See `electron/shared/skill-contract.ts`. |
| `model` | no | Parsed and surfaced, **wired to nothing**. With several skills enabled there is no defined precedence, so honouring it would be a guess. |
| `autoInvoke` | no | Parsed (three spellings), **wired to nothing**. Every skill applies only when the operator enables it; auto-applying one is a governance decision, not a wiring detail. |

`SKILL_FIELD_DISPOSITION` in `electron/shared/skill-contract.ts` is the authority on which fields do
anything. Adding a field to the schema without recording its disposition is a compile error — that is
the point of the file.

**Flat vs directory.** `direct-voice.md` → id `direct-voice`. `plan/SKILL.md` → id `plan`. The id comes
from the **filename or directory name**, not from `name:`. Directory skills may carry sibling files;
those are discovered as `supportingFiles` and **not** inlined into the prompt, so put long reference
material there and let the model read it on demand.

---

## Where skills live

| Mode | Directory |
|---|---|
| Dev (`npm run dev`) | `<repo>/resources/skills/` — the shipped set itself |
| Production | `<userData>/skills/`, seeded from `<install>/resources/skills/` |

`userData` is `%APPDATA%\DUIN` on Windows, `~/Library/Application Support/DUIN` on macOS,
`~/.config/DUIN` on Linux.

Dev reads the shipped set **directly**. Until 2026-08-17 it read a separate top-level `skills/`
directory, and the two drifted — dev-only skills that never shipped, shipped skills a developer never
saw. One tree now, so a change to a default is reviewed by whoever runs the app.

### How seeding behaves

`ensureSkillsDir` records what it seeded, and the bytes, in `<skillsDir>/.bundled-skills.json`. That
manifest is what lets the three states be told apart:

| State | Behaviour |
|---|---|
| Absent, and previously seeded | The operator deleted it. **It stays deleted.** |
| Present and unchanged since seeding | A newer bundled version **replaces it** — shipped fixes reach existing installs. |
| Present and edited | The operator's bytes **always win**, and the divergence is remembered. |

Deleting the manifest re-seeds everything, which is the escape hatch if a bundled skill needs to come
back. Pinned by `electron/services/skill-loader-seed.test.ts`.

---

## How a skill reaches the model

There are **two render paths**, and they have different budgets. Know which one you are authoring for.

**Brain / chat path** — `local-brain/active-skills.ts`, the default. Renders the **full body, always**;
there is no stub mode here. Injected at *floor* tier, so it is never evicted by context pressure —
which is why it is capped instead:

- `ACTIVE_SKILLS_TOTAL_CHAR_BUDGET = 12_000` across **all enabled skills**
- `ACTIVE_SKILLS_PER_SKILL_CHAR_BUDGET = 6_000` for any one skill

Over-budget skills are truncated or omitted, and an omitted skill is **named in the block** so the
model can say it did not fit. Silent dropping is the failure mode that rule exists to prevent.

**Agentic / coding path** — `system-prompt-builder.ts`. Supports stub mode: when `lazySkillBodies` is
on (it follows `toolSurface`, which defaults to `'full'`, so it is normally **off**), a skill renders
as name + description only and the model calls `skill_open("<name>")` to load the body.

Assembly order is fixed: base persona → memory → retrieved context → chapters → active skills. The
persona (`system-prompt-builder.ts`) describes a second-brain agent for a knowledge worker; skills
sharpen that, they do not replace it.

---

## Authoring guidance

- **Assume the model is already capable.** Only add what it would not do unprompted. A skill that
  restates default competence is not free — under a shared 12k budget it evicts one that isn't.
- **Imperative voice.** "Search before asserting", not "this skill helps with searching."
- **Explain the reasoning instead of shouting.** If you are writing ALWAYS or NEVER in caps, reframe.
- **Name tools in backticks, and only real ones.** `electron/services/bundled-skill-tool-parity.test.ts`
  fails the build if a bundled skill names a tool the registry does not have.
- **Know what a cold-start user actually has.** Vault read/write, `search_notes`, `walk_links`,
  `graph_report`, `memory_add`, planning and goal tools, `generate_docx/xlsx/pptx/pdf`,
  `export_artifact` and `propose_edit` are ungated, keyless and offline. Web search needs a provider
  configured; shell, browser actions and `apply_patch` prompt for approval; email, calendar and the
  other effectors need accounts; loops need three switches armed. A default that opens by requiring
  any of those is dead on the install that most needs it.
- **End with a stopping condition.** Every directory skill here closes with a `Stop when…` line. Keep
  the convention — it is the most useful sentence in most of these files.
- **Keep descriptions orthogonal.** If two skills could plausibly match the same request, the operator
  cannot choose between them and neither can a future ranker.
- **Test it against itself.** Run the task with the skill off, then on. If you cannot tell the
  difference, the skill is not earning its slot.

---

## The bundled set

Shipped from `resources/skills/`. All ship **disabled**; the operator turns on what they want.

| Skill | Form | What it does |
|---|---|---|
| `context` | dir | Orient in a workspace before acting: `workspace_context`, then the instruction files it names. |
| `plan` | dir | Plan before editing. Builds an `update_plan` checklist, one step in progress at a time. |
| `debug` | dir | Reproduce, isolate, fix narrowly, verify the original failure path. |
| `review` | dir | Review for risk. Findings by severity with evidence, and a `SHIP` / `CHANGES` verdict. |
| `verify` | dir | `verify_workspace`, then name what ran **and what did not**. |
| `frontend-qa` | dir | Exercise a URL in the in-app browser. `PASS` / `FAIL` / `NEEDS-REVIEW`. |
| `fan-out` | dir | `multi_agent_run` for independent reasoning passes, synthesized by the caller. |
| `method-creator` | dir | Interview the operator and author a method that composes skills toward a deliverable. |
| `example-directory-skill` | dir | Format demo: `skill.md` plus a sibling reference file. |
| `code-review.md` | flat | Four-bucket code review with a ship verdict. |
| `git-commit.md` | flat | Conventional commit messages from a diff. |
| `direct-voice.md` | flat | Declarative, concise register. No hedging or preamble. |
| `ingest.md` | flat | How material gets into the brain: files, web pages, connections, notes. |

`plan`, `context` and `verify` are also auto-activated by **agentic coding mode**
(`electron/services/agentic-coding-config.ts`) — renaming or removing one breaks that contract, so
change it there in the same edit.
