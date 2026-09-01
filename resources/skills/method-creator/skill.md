---
name: method-creator
description: Build a new method — a reusable way of working that composes existing skills toward a named deliverable. Use when the user says they want to create, author, build, or design a method, wants to turn a repeated piece of work into something reusable, or asks how to make DUIN do a multi-step job the same way every time.
triggers:
  - make a method
  - create a method
  - author a method
  - build a method
  - turn this into a method
---

A method is a note in the user's vault that says three things: what it produces, which skills it composes, and the steps. Running one activates those skills and hands the model the steps as a soft dependency shape. Your job is to get those three things right and write the note.

## What makes a method worth having

A method earns its place when the user does a job repeatedly, the job takes several moves, and the quality depends on doing those moves in a particular way. If the job is one skill invoked once, say so — they want a skill, not a method, and a method wrapping a single skill just adds a layer.

Skills are capabilities. Methods are the user's judgment about how to sequence them. The value is in the sequencing, so do not accept a vague answer about what the method produces.

## Interview

Ask about these, one or two at a time — not as a form. Stop as soon as you can write a good note; do not extract all of it if the user has already told you.

- **The deliverable.** What exists at the end that did not exist before? Push for something concrete: "a debrief that preserves what the client actually said, verbatim" beats "meeting notes". This becomes `deliverable:` and it is what the run prompt asks for.
- **The trigger.** When does the user reach for this? Goes in `description:`.
- **The moves.** What actually happens, in order? Where does it usually go wrong? A step that exists to prevent a known failure is the most valuable thing in the note — write down the failure too.
- **What varies.** Which steps are fixed and which depend on the situation? The steps are read as a soft DAG, so say which ordering is real and which is incidental.

## Wire real skills

Before proposing any `calls-skills` entry, look at what is actually installed — read the user's skills directory or ask. A name that does not match an installed skill renders as "not installed" and silently contributes nothing at run time.

If the method needs a capability the user does not have, say so plainly and offer to build that skill first. Do not paper over it by naming a skill you hope exists.

## Write the note

Write to `Methods/m-<slug>.md` in the user's vault with `write_file`. The path matters — both readers walk the vault, so a method saved anywhere else is invisible. Never put "template" in the filename or path; the method walk skips those.

```markdown
---
type: method
name: Deal debrief
description: Turn a client call into an internal debrief that keeps their judgment intact.
deliverable: an internal debrief preserving insider judgment verbatim
calls-skills: [meeting-note, preserve, to-internal-briefing]
---

## Method

When to reach for this, and what it protects against.

## Steps

1. Capture the call with meeting-note, keeping quotes verbatim.
2. Mark the judgment calls the client made — those are the payload.
3. Rewrite for an internal reader without flattening their reasoning.
```

`type: method` is the gate — without it the note is invisible as a method. The `## Steps` heading is lifted verbatim into the run prompt, so it must be spelled exactly that way or running the method loses its steps.

## Close

Show the user the note you wrote and where it went. Tell them it is now in Customize → Methods, and that running it activates the wired skills for that turn. If any wire was not installed, say which and what to do about it.
