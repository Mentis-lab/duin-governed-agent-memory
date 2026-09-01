# What DUIN is

> **The one page.** This file decides what the system is *for* and what shape it must keep.
> When a design disagrees with this file, the design changes.
>
> Every property below is paired with the observation that would prove it false.
> A principle you cannot fail is decoration.
>
> [glossary.md](glossary.md) decides what things are *called*; [architecture.md](architecture.md)
> describes what the code does. If you read only one file about DUIN, read this one. It should
> take five minutes.

---

## What it is for

DUIN is a **compounding personal-judgment system**. The agentic harness is the engagement
engine; the brain (grounding, foresight, calibration, taste) is the asset being compounded.

The point is not defensibility. It is **understanding one operator well enough that a model
reasoning with that understanding fits them better than the same model reasoning cold**. That
is also the only success test that matters:

> Does the accumulated operator state measurably improve fit-to-operator versus the same model
> with none of it?

Everything else (connectors, the coding shell, the graph) is either in service of that question
or it is overhead. Connection is a feature; **comprehension is the moat wearing a channel as an
intake.**

## The shape

**Three planes.** *Vault* is Markdown the operator wrote. *Memory* is durable facts DUIN keeps,
one per file. *Brain* is everything derived from the other two. Terms and storage in
[glossary.md](glossary.md).

**Four loops.** *Ground* (what bears on this?) and *Remember* (what is worth keeping?) are the
fast loops; they make DUIN useful. *Learn* (what was I wrong about?) and *Govern* (what may I
change about myself?) are the slow loops; they make DUIN **yours**. A DUIN with only the fast
loops is a search box with good manners.

---

## The eight properties

### 1. One concept, one owner

Every load-bearing noun (foundation file, provenance, memory, promotion) has exactly one module
that defines it. Everything else imports. The agreement is held by a **test**, not by review.

This is the discipline the codebase most needs, because its failures are invisible locally:
three separate lists once encoded "this is not a user note," each site individually correct and
well-commented, and nothing owned the concept. Incoherence enters at the seams between
locally-correct components.

> **False when:** a second definition of an existing concept exists anywhere, or a shared
> definition has no test that fails when a consumer drifts from it.

### 2. What is earned is never derived away, and lives where the operator can see it

The Brain is derived and may be rebuilt at any time. The Vault and Memory may not. Any feature
that puts unrecoverable operator content in the Brain is a bug, whatever else it does.

The second half is equally binding: **earned state belongs in a plane the operator can read,
edit, export and diff.** Local-first is not only about where bytes sit; it is about whether the
person the system is modelling can inspect the model. Durable state that exists only in an
opaque blob is not an asset they own.

> **False when:** durable facts accumulate somewhere the operator cannot read without a
> debugger.

### 3. Provenance is recorded, never inferred

Where a fact came from is stamped at the moment it is created, or it is `unknown` forever.
Back-guessing provenance from timestamps or adjacency manufactures exactly the confidence the
field exists to make honest.

`unknown` is a first-class value, not a hole to be filled in later.

Corollary: a fact DUIN inferred may never be relabelled as something the operator stated. That
single distinction is what lets a high-stakes answer be grounded on "what you actually told
me," and it is the easiest one to destroy in a well-intentioned refactor.

> **False when:** any migration or default assigns a source it did not observe.

### 4. Memory is historical context, not current fact

Stored knowledge says what was true when it was written. Mutable things (paths, task states,
permissions, plans, who owns what) must be re-checked before use, and marked as possibly stale
if they cannot be.

> **False when:** an answer asserts a stored mutable value as current without verifying it.

### 5. Every mechanism publishes its limits

A mechanism's documentation states what it does **not** do, in the same place it states what it
does. Retrieval returns a bounded snippet of one chunk per file against a small slot budget;
that is not a footnote, it is the fact that decides whether retrieval can substitute for
always-on context.

Stated limits are the cheapest defect prevention available, because they kill bad plans at the
design stage instead of the review stage.

This property has no lint, on purpose: a check can verify that a doc block *contains* a limits
paragraph, not that the limits are true or complete, and completeness is the whole property. It
is upheld by practice. `electron/shared/skill-contract.ts` classifies skill fields as advisory
or unwired and names what does *not* enforce them; the reachability lint explains why its
allowlist exists; the sandbox documents its own degradation.

> **False when:** a plan is written that assumes a capability the mechanism never had, and
> nothing in the mechanism's own documentation contradicted it.

### 6. Claims about ourselves are computed, not typed

Any assertion about DUIN's own wiring (is this live, is it called, is it covered) must be
derived from the code, not written by hand. A hand-typed status is a claim that rots, and it
rots in the most damaging direction: a map that says LIVE hides the gap from the very check
built to surface it.

> **False when:** a status field in any self-description disagrees with what a grep would
> return.

*Enforced, partially:* `coherence-map-claims.test.ts` decides the coherence map's `LIVE` and
`DEAD` claims against the same reference counter the dead-export detector uses, and fails on
disagreement. The reachability, preload-surface and unsupplied-input lints compute whether code
is reachable, whether a bridge binding has a caller, and whether an optional input is ever
supplied. Statuses that assert runtime behavior or deliberate stance remain hand-typed.

### 7. Complexity is earned by motion

A crude mechanism that runs beats a sophisticated one that has stalled. Not because simplicity
is virtuous, but because **a mechanism small enough to hold in one head is one you can notice
has stopped.** Elaborate machinery removes your ability to tell whether it is working, and it
fails silently by design.

Before adding a state to a lifecycle, a gate to a pipeline, or a score to a ledger: show that
the existing states transition, the existing gates fire, and the existing ledger has non-null
rows.

> **False when:** instrumentation sophistication exceeds the signal passing through it: states
> with no transitions, ledgers with no scored rows.

### 8. One representation, one meaning

A value must be able to express every state its producer can be in. When two genuinely
different situations produce an identical result, the caller cannot tell them apart, and
neither can you, six weeks later, holding a bug report.

This is the class that costs the most, because every instance is locally correct. The site
reads fine, the comment is accurate, the tests pass. It only surfaces when something downstream
behaves oddly, and by then the diagnosis is archaeology.

The remedy is never cleverness. It is one more value: a `'kept-cache'` status, an `'unknown'`
rung, a `source` column, an `envNum` that distinguishes unset from zero.

Two corollaries, both violated by code that looked careful:

- **A "safe default" is not safe in general.** It is safe relative to a caller's polarity. If
  two callers read the same value with opposite fail direction (one requires `'run'`, one blocks
  only `'hold'`) then the default is safe for one and open for the other. Return what you know.
- **Clamping is a collapse.** Silently correcting an out-of-range input hides "you asked for
  nonsense" behind "you asked for the boundary".

> **False when:** two different situations produce identical output, and any caller branches on
> it. The mechanical half (env reads that cannot express zero) is enforced by
> `npm run lint:signal`; it also reports advisory counts for the two shapes a grep cannot settle
> (duplicate return literals, and `vi.mock` edges, since mutual mocking hides a seam the same
> way).

---

## Using this file

- **Designing anything:** name which property it serves. A change that serves none is overhead;
  a change that violates one needs an argument written down, in the same PR.
- **Reviewing:** check the seams, not the files. Ask who owns the concept. The answer "three
  places" or "nobody" is the finding.
- **When this file goes stale:** that is itself a property-6 violation. Fix the file in the PR
  that made it wrong.
