---
name: comprehend
description: Turn an item from a connected channel (email, chat message, calendar event, doc) into structured world-state — owed decisions, deadlines, commitments, and what it binds to — rather than just storing or summarizing the text. Use when a channel item arrives or the user asks "what does this mean for me". Not for freeform personal notes (use distill).
autoInvoke: true
allowedTools:
  - Read
  - shell_command
---

# comprehend

Connection (fetching a message) is commodity; **comprehension** — turning that message into a structured
piece of the user's world-model — is the real value. This skill is also the cold-start answer: a
brand-new user with zero notes but one connected channel gets a genuinely useful read in their *first*
session, because their channels are already full of their real life.

## When this skill activates

A channel item arrives or is referenced: an email, a chat/DM, a calendar event, a shared doc. Or the user
asks what a channel item means for them.

## How it works — comprehend, don't just store

Extract structured events, not prose. For each item, identify whichever of these apply:
- **Owed decision** — something now waiting on the user to decide or respond to.
- **Deadline / time-binding** — an explicit or implied "by when", tied to a real date.
- **Commitment** — a promise the user made or received.
- **Binding** — what this connects to: a project, a person, an existing thread, an upcoming milestone.
- **State change** — a fact that updates the world-model ("venue is now unconfirmed" changes an event's
  risk).

## Write it into the world-model (wired to DUIN's brain)

Feed the extracted events to the native world-update writer so foresight, reminders, and the digest can
reason over them — the *same* comprehension the brain runs on notes, just fed from a channel:

```
shell_command: curl -s -X POST http://127.0.0.1:8799/state/world-update \
  -H 'content-type: application/json' -d '<structured events JSON>'
```

Bind every extracted event to at least one entity (person, project, or thread) and preserve the source
link + timestamp. If unsure of the exact field shape the deployment expects, inspect a prior
`/state/world-update` payload or the world-state read routes first, rather than guessing a schema.

## Hard rules
- Produce structured events, not a summary. "Store the email" is the anti-goal.
- An unbound event can't inform foresight — always attach it to an entity.
- Don't act on the channel (reply, accept, decline) — comprehend and surface; the user decides.

## First-run note
When the brain is otherwise empty, this skill carries the on-ramp: a useful world-state + owed-decisions
read from channel data alone earns the right to start accumulating.

## Hand-offs
- A channel item that's really the user's own thought to file → **distill**.
- Ranking which comprehended items deserve attention now → **surface**.
