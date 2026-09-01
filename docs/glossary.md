# DUIN glossary

> **Hand-maintained.** This file decides *what things are called*. [constitution.md](constitution.md)
> sits above it: it decides what the system is *for* and what shape it must keep. Read that
> first; this file gives you the vocabulary, that one gives you the reason any of it is shaped
> the way it is.

DUIN accumulated its vocabulary one construction phase at a time, so the same idea picked up
several names and some names picked up several ideas. That is not a cosmetic problem: at one
point the Explorer mis-filed most of the graph because `entity` and `topic` belonged to no
category; nobody had decided what they *were*. Naming the two tiers fixed the categorisation
in one pass.

**One concept, one name. If you need a new name, retire the old one in the same PR.**

---

## The shape of the system

Three planes and four loops. Everything below is one of those, or it is plumbing.

### The three planes

| Plane | What it is | Who owns it | Rebuildable? |
| --- | --- | --- | --- |
| **Vault** | Markdown the operator wrote | The operator | **No**: it is the source |
| **Memory** | Durable facts DUIN keeps, one per file | DUIN, operator-editable | **No**: earned over time |
| **Brain** | Concepts, nodes, edges, claims derived from the other two | DUIN | **Yes**, always |

The invariant: **the Brain is derived and may be rebuilt at any time; the Vault and Memory may
not.** Any feature that puts unrecoverable operator content in the Brain is a bug, whatever
else it does.

### The four loops

| Loop | Question it answers | Speed |
| --- | --- | --- |
| **Ground** | What do I know that bears on this? | per turn |
| **Remember** | What from this is worth keeping? | per session |
| **Learn** | What was I wrong about, and what do I now believe? | per week |
| **Govern** | What am I allowed to change about myself? | per change |

Ground and Remember are the fast loops; they make DUIN useful. Learn and Govern are the slow
loops; they make DUIN *yours*. A DUIN with only the fast loops is a search box with good manners.

---

## Canonical terms

### Plane: Vault

| Term | Means | Lives in |
| --- | --- | --- |
| **Vault** | The operator's Markdown directory. The only content DUIN never authored. | operator's filesystem |
| **Note** | One Markdown file in the Vault. | `notes_files` |
| **Chunk** | A slice of a Note, the unit of retrieval. | `notes_chunks`, `notes_vec` |
| **Foundation file** | The four Vault-root files defining the operator and the agent. | `FOUNDATION_BASENAMES` |

The four, in the order they are read into context:

| File | Answers | Register |
| --- | --- | --- |
| **SOUL.md** | Who DUIN is: character, voice, what it won't do | declarative |
| **BRAIN.md** | How DUIN must operate: the contract | imperative |
| **ME.md** | Who the operator is | declarative |
| **GOALS.md** | What the operator is trying to do (graph only, not per turn) | declarative |

SOUL and BRAIN are not synonyms and the split matters: an imperative rule is followed literally
and therefore only covers situations someone anticipated, while character generalizes to the
ones nobody did. Character is read first so the rules land on someone. Hard constraints go in
BRAIN.md; who is applying them goes in SOUL.md.

**Adding a foundation file touches seven sites.** Miss one and the failure is silent, not loud:

1. `FOUNDATION_BASENAMES` (write-identity), else the Settings pane cannot save it
2. `loadBrain` (brain-root), else it is written but never read
3. `isRootFoundation` (`brain/foundation-files`, consumed by `build-graph-native` and
   `graph-derive`), else a fresh vault counts it as a real note and loses its whole cold-start
   graph
4. the foundation-hub list in those same two builders, else it is not a graph node
5. `FOUNDATION_FILES` (`brain/foundation-files`) guarding `scaffold-harness`'s in-place mover,
   else a scaffold run files it into a pillar folder and `loadBrain`, which reads the root only,
   silently stops loading it
6. `scaffoldOkf`, else new vaults never get it
7. a boot backfill, else *existing* vaults never get it, and it ships to new users only

Sites 3 and 5 used to be three separate sets that all meant "this is not a user note", with
nothing keeping them in agreement. They now share one list in `brain/foundation-files.ts`, and
`foundation-files.test.ts` fails if the ordered identity subset drifts out of it. Sites 1, 2, 4,
6 and 7 are still independent: this made the checklist shorter, not unnecessary.

A Note is a *file*. Say "note" only about Vault Markdown, never about a memory, a concept, or a
graph node, all of which have their own names below.

### Plane: Memory

| Term | Means | Lives in |
| --- | --- | --- |
| **Memory** | One durable fact DUIN keeps, one per file, with a type and a provenance. | `memory_index`, `<userData>/lamprey-memory/` |
| **Memory type** | *What kind of fact*: `user`, `feedback`, `project`, `reference`. | `memory_index.type` |
| **Memory source** | *Where the fact came from*: `user-explicit`, `session`, `inferred`, `reflection`, `imported`, `unknown`. | `memory_index.source` |

Type and source are orthogonal and both are needed. Type answers "is this about the operator or
about the work"; source answers "did they tell me this, or did I infer it?" Only source can
distinguish a fact the operator stated from one DUIN guessed, which is exactly the distinction
that matters when grounding a high-stakes answer.

Memory files are **canonical**; the SQL table is a **mirror** rebuilt by the watcher. A
migration that touches only SQL reverts on the next sync.

### Plane: Brain

| Term | Means | Lives in |
| --- | --- | --- |
| **Concept** | A typed Markdown file in the OKF substrate: the portable, human-readable brain. | `.brain/memory/*.md` |
| **Node** | One entity in the graph: a person, project, org, decision, topic… | `entity_nodes` |
| **Node kind** | The node's type: `person`, `org`, `decision`, `goal`, `topic`, `risk`, `stream`, `driver`, `context`, `deadline`, `cascade`, `entity`. | `entity_nodes.kind` |
| **Edge** | A typed, directed relation between two Nodes. | `entity_edges` |
| **Construction** | The extraction pass that reads Notes and produces Nodes and Edges. | `build-graph-native.ts` |
| **Claim** | A proposition the brain holds, with evidence and a confidence state. | claim ledger |
| **Promotion** | A Claim's lifecycle: `candidate` → `provisional` → `promoted`, or `vetoed`. | promotion engine |
| **Correction** | An operator statement that something DUIN believed was wrong. Feeds Learn. | corrections ledger |
| **Prediction / Verdict** | What DUIN expected, and what actually happened. The scoring substrate for Learn. | `brain_predictions`, `brain_verdicts` |

`entity` is a node kind meaning **"typed extraction failed"**: an unclassified node, not a
category. It is a defect marker. A healthy graph trends toward zero of them.

### Cross-cutting

| Term | Means |
| --- | --- |
| **Grounding** | Assembling the evidence a turn is answered from. Not "search", not "RAG", not "recall". |
| **Evidence gate** | The check that refuses to answer from thin evidence rather than guessing confidently. |
| **Loop** | A scheduled recurring job (`loops.yaml`). Not to be confused with the four conceptual loops above; those are *named* loops, these are *scheduled* ones. |
| **Autonomy rung** | How much a change may do unattended: propose → stage → apply. |

---

## Known forks (not yet resolved)

Places where two names for one idea still coexist. Listed so they are visible debt rather than
a surprise; each needs a decision, not a rename in passing.

**Two provenance vocabularies.** `MemorySource` (`user-explicit` / `session` / `inferred` /
`reflection` / `imported` / `unknown`) labels a **Memory**. `FactSource` (`operator` /
`machine` / `external`) labels an **operator-model fact**. They answer the same question, where
did this come from, for two different stores.

The target mapping is `operator` → `user-explicit`, `machine` → **`inferred`**, `external` →
`imported`, absent → `unknown`, with reflection-pass output setting `reflection` as its
*source* instead of encoding it in `kind`.

An earlier version of this entry said `machine ≈ session + reflection`. **That was wrong and
the error is worth keeping visible**, because it is the natural mistake: `session` is not "arose
during a conversation", it is *the operator stated this, in a conversation*: same authority as
`user-explicit`, different channel. `machine` is a model inference that must earn its way to
`promoted` and may never masquerade as something the operator asserted. Mapping `machine` to
`session` would relabel the majority of a store's machine-inferred facts as operator statements
and destroy the one distinction the field exists for. `inferred` was added to `MemorySource` to
give them somewhere honest to land.

**Two durable-fact stores.** `memory_index` plus the memory files (the Memory plane) and the
`operator-model` store (facts with their own candidate→promoted lifecycle, `dependsOn` edges
and eviction cap). Reflections currently land only in the second, which is why
`MemorySource='reflection'` has no emitter: the vocabulary slot is real, the pipeline writes
somewhere else.

Resolving this is a store decision, not a naming one. Mirroring reflections into Memory would
make the label true at the cost of duplicating durable state across two stores, which is the
disease this file exists to treat, not the cure. Closing the first fork does not close this one.

## Names to stop using

Construction milestones that leaked into production code decode to nothing for anyone who was
not present when they were built. **Retire on touch**: when you edit a file containing one,
rename it; do not schedule a sweep.

| Retired | Say instead |
| --- | --- |
| Phase 3b · P4++ · Wave-3 · R4 · item-16 · graft ② | the behavior's actual name |
| COLD-START A1 | first-run scaffold |
| Fluidity J11 / J2 | the affected surface |
| F2 (bounded-context) | context bounding |
| "the OKF substrate" (unqualified) | Concepts |
| "operator facts" / "promoted facts" / "cards" | Memory, or Claim: pick the one you mean |

The last row is the expensive one. Before this file, memory-adjacent things went by ten names:
`MEMORY.md`, `memory_entries`, `memory_index`, entity graph, claim ledger, corrections,
operator facts, promoted facts, cards, concepts. Three of those are genuinely different things
(Memory, Concept, Claim). The rest were synonyms nobody had adjudicated.

---

## Using this file

- **Naming something new:** check here first. If the concept exists, use its name. If it does
  not, add a row *in the same PR that introduces it*.
- **Reviewing:** a new name for an existing concept is a change request, not a nit.
- **Writing docs or UI copy:** these are the words. The Explorer says "Memory" and "Concepts"
  because that is what this file calls them.
