---
name: revise
description: When a fact the brain holds has changed, update the node in place and mark the prior version superseded — keeping the brain current without losing the history of what changed. Use for "X is now Y not Z", "this is outdated", "update the note on X". Not for filing a brand-new thought (use distill) or merging two nodes that are the same (use dedup).
autoInvoke: true
allowedTools:
  - Read
  - Write
  - shell_command
---

# revise

Knowledge goes stale. A second brain that only ever *adds* drifts out of sync with reality — old
"facts" keep surfacing and quietly mislead. This skill keeps a node current: it updates the record in
place and preserves a trail of what it used to say, so the brain reflects now without amnesia about
then.

## When this skill activates

A held fact has changed: "X is now Y, not Z", "this note is outdated", "update what you have on X",
"they moved / renamed / decided differently".

## How it works (wired)

1. **Find the node** — locate the existing note/node the change applies to
   (`GET http://127.0.0.1:8799/state/resolve`, `/state/graph`). If it doesn't exist yet, this is a new
   thought → hand to **distill**, don't force a revision.
2. **Update in place** — write the corrected content via `POST /state/doc/save`, preserving the node's
   identity and inbound edges (so everything pointing at it still resolves).
3. **Record the supersession** — mark the prior version superseded: keep a short "was: … / now: … /
   changed on …" trail and add a `supersedes` relation (via **relate**) from the new state to the old.
   Route the fully-obsolete old content to **archive** rather than deleting it.
4. **Check for knock-on contradictions** — if the change now conflicts with another node, surface it
   (a `contradicts` edge) instead of leaving two live facts fighting.

## Hard rules
- Never silently overwrite — always leave the supersession trail (what changed, when). The history is
  part of the operator's judgment record.
- Preserve node identity and edges; a revision updates a node, it doesn't replace it with an orphan.
- A revision that contradicts other held facts must surface the conflict, not smooth it over.

## Hand-offs
- The content is genuinely new, not a change to an existing fact → **distill**.
- Recording the supersedes/contradicts edge → **relate**.
- Retiring the obsolete prior version → **archive**.
