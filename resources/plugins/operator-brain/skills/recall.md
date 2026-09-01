---
name: recall
description: Answer a question strictly from what the brain holds — retrieve the relevant notes/nodes and respond with citations, refusing to fill gaps from general knowledge. Use when the user asks "what do I know about X", "what did I decide on Y", "find where I wrote about Z". Not for open web/general questions, and not for filing a new thought (use distill).
autoInvoke: false
allowedTools:
  - Read
  - shell_command
---

# recall

Grounded recall is the difference between a second brain and a chatbot: an answer built only from *the
user's own* knowledge, with sources, and honest about what isn't there. This is the retrieval any
second-brain user needs most — "surface what I already know about this."

## When this skill activates

The user asks something answerable from their own brain: "what do I know about X", "what did I decide on
Y", "where did I write about Z", "pull everything on <project/person>".

## How it works (wired)

1. **Retrieve** the relevant nodes/notes from the brain (the app's retrieval / context-compiler — hybrid
   lexical + vector over the vault; read the resolved context, e.g. `GET /state/resolve`, `/state/doc`).
2. **Answer only from retrieved context.** Synthesize across the pulled sources; do not add facts the
   retrieval didn't surface.
3. **Cite** — attach the source node/note for each claim so the user can trace and trust it.
4. **Be honest about gaps** — if the brain holds little or nothing on the topic, say so plainly and offer
   to capture it (**distill**) rather than answering from general knowledge.

## Hard rules
- Grounded only. If it's not in the retrieved context, it doesn't go in the answer.
- One claim, one citation — an uncited claim reads as a hallucination in a second-brain.
- "I don't have much on this" is a valid, valuable answer — never paper over an empty brain.

## Hand-offs
- The topic isn't in the brain yet → **distill** (file it) or **comprehend** (from a channel).
- Surfacing what the user *didn't* ask for but should see → **surface**.
