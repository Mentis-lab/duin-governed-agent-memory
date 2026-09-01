# Operator Brain — evergreen second-brain skill pack

These skills are part of **one system**, not a separate bundle. The coding-shell skills
(`context`, `debug`, `plan`, `review`, `verify`, …) and these knowledge-work skills load into a single
set the model draws on — no split, no "developer pack" to swap in. What this set adds is the product
thesis the coding skills don't touch: **accumulate a per-operator understanding and use it to make
outputs fit that specific user better than a cold model would.**

It is designed to get real signal flowing through DUIN's learning loop — which, per the product
strategy's 2026-07-02 ground-truth audit, is currently empty (zero scored forecasts; corrections
captured with the `why` field blank).

## The skills (one word each), in six clusters

**Judgment** — the loop that models the operator:
1. **capture** — record the user's correction/endorsement *with its `why`*; precision-gated against
   machine-injected turns.
2. **frame** — frame make-or-break outputs through the accumulated taste.
3. **audit** — the flip test: keep judgment that beats the cold model, prune what it now supplies free.

**Learning** — turn signal into behavior, and keep it honest:
4. **reflect** — consolidate recurring corrections into propose-only binding-rule candidates (human gate).
5. **resolve** — close past forecasts with real outcomes so the calibration ledger can learn.

**Foresight** — the convergence engine:
6. **forecast** — surface how threads converge toward milestones and what present move that implies.
7. **decide** — pressure-test a specific decision against predicted risk + world-state, consistency-gated.

**Comprehension** — intake and grounded recall:
8. **distill** — reconcile a new thought against the brain before creating; no orphans.
9. **comprehend** — turn channel items into structured world-state; carries the cold-start on-ramp.
10. **recall** — answer strictly from the brain, with citations; honest about gaps.

**Graph** — keep the knowledge connected and clean:
11. **surface** — proactive cross-domain links + salience ranking of what to look at now.
12. **relate** — map typed, provenance-tagged relations between existing nodes.
13. **dedup** — find and merge nodes that are really the same thing, preserving every link.
14. **lint** — read-only hygiene pass: orphans, broken references, stale nodes, unmarked contradictions.

**Lifecycle** — keep knowledge current as it ages (a note's life over time):
15. **revise** — update a node in place when a fact changes; mark the prior version superseded (no amnesia).
16. **consolidate** — collapse a sprawling cluster into one canonical synthesis node, linked to its sources.
17. **archive** — soft-retire stale/dead/superseded notes to a reversible tier; hard-delete only true junk, gated.

## Wiring (to DUIN's real brain, port 8799)

These skills feed the app's existing brain, not a parallel store:
- **capture** → `POST /learn/correction` — the same native capture arrow the app uses (writes
  `.duin/_state/corrections.jsonl`, feeds `reflect()` + taste). Payload is the `Correction` shape
  (`ts, session, skill, artifact, ai_output, correction, why, candidate_rule, polarity`); **never send
  a `source` field** (the route 400s on machine rows). Promotion to a binding rule stays human-gated
  downstream via `reflect()` (≥3 cluster, propose-only) + the Learning panel.
- **frame** → `GET /learn/taste` — the computed taste block.
- **audit** → reads `.duin/_state/corrections.jsonl` + `GET /learn/taste`; complements the brain's
  `reflect()` with the flip test.
- **comprehend** → `POST /state/world-update`.
- **distill** → `GET /state/graph` / `/state/resolve` to reconcile; `POST /state/doc/save` to persist.
- **surface** → read-only `GET /state/graph`, `/state/decision-connections`, `/state/outputs`.
- **reflect** → `POST /learn/reflect`. **resolve** → `POST /state/forecast-verdict` / `/state/insight-verdict`.
- **forecast** → `POST /state/forecast`. **decide** → `POST /state/decision` (+ `GET /state/decision-connections`).
- **relate** / **dedup** → `GET /state/graph` → `POST /state/resolve-node`. **lint** → read-only `GET /state/graph`,
  `/state/graph-diff`. **recall** → brain retrieval / context-compiler (`GET /state/resolve`, `/state/doc`).
- **revise** → `GET /state/doc` → `POST /state/doc/save` (update in place) + `relate` for the supersedes edge.
  **consolidate** → `GET /state/graph` → `POST /state/doc/save` (synthesis) + `relate` to link sources.
  **archive** → marks `archived` frontmatter via `POST /state/doc/save` (route-verified 2026-07-03). **Known gap:**
  the brain has **no archive/delete/status route** — the mark is reversible and forward-compatible but is **not
  yet honored** (archived notes still appear in retrieval/graph). Full soft-archive needs a small brain capability;
  `archive` never hard-deletes (no delete route exists, by design).

Skills reach the brain over HTTP via the granted `shell_command` tool (`curl` to `127.0.0.1:8799`). Where a
POST payload shape isn't documented above, the skill inspects a prior payload / read route before writing
rather than guessing a schema.

**Honest overlap:** DUIN *already* auto-captures human promote/veto verdicts into `/learn/correction`
— but that path deliberately leaves `why` **empty** (a fixed phrase would cause false clustering in
`reflect()`). `capture` is additive precisely there: it records the correction *in-conversation with a
real, varied `why`*, which is the signal the 2026-07-02 audit found missing. It does not replace the
verdict hook; it fills the field the hook can't.

## Known limitation — auto-trigger is model-driven (verified 2026-07-03)

Live test on the running app (GLM 5.2): the pack loads and is enabled (14 skills recognized), but
`capture` did **not** fire across two real correction turns. DUIN surfaces skills as stubs behind a
`skill_open` progressive-disclosure tool, so firing an `autoInvoke` skill requires the model to
proactively `skill_open` → read → act. GLM 5.2 instead answered conversationally — and in one case
replied *"Persisted. Standing rule: …"* while making **no** tool call at all (narrated a write it
never performed). The correction ledger stayed at 9 rows, 0 with a `why`.

**Implication:** the always-on learning-capture step must NOT depend on model self-invocation — it's
unreliable and can be hallucinated. `capture` specifically should be wired as a **deterministic
post-turn hook** (detect correction-shaped user turns in-process and run the write, or extend DUIN's
existing native verdict hook to also extract the `why`), mirroring why DUIN already ships a
deterministic learn-bridge rather than trusting the model. The user-*requested* skills (frame, audit,
forecast, decide, recall, relate, dedup, lint) are fine as model-invoked; the ambient ones
(capture, and arguably comprehend) need the deterministic path to actually fill the loop.

## Design provenance
- **capture / frame / audit** port the loop shape of the operator's harness judgment subsystem (capture → draft →
  distill → measure), generalized: the operator-specific node vocabulary, vault paths, and produce-prompt are
  externalized as config; the capture→apply→flip-metric spine is kept intact. `capture`'s precision gate
  reflects the 2026-06-22 injected-prompt-gate fix (don't mistake the app's own plumbing for the user's
  judgment).
- **distill** ports the operator's reconcile-before-create distillation — a gap the default skill sets of
  the mainstream coding shells do not cover.
- **comprehend** operationalizes the strategy's "comprehension is the moat wearing a channel as intake"
  and the first-run/cold-start litmus.
- **surface** combines cross-domain bridge discovery with the home-digest salience spec.

## Rollout — one system
These skills load **alongside** the existing coding-shell skills as a single set the model draws on per
turn; there is no demotion and no separate pack. If activating incrementally, the judgment trio first
(**capture · frame · audit**) is the highest-leverage start — that's the empty-loop priority.

## Portability config (for real deployment)
Each judgment skill assumes a small amount of per-deployment config, currently implicit:
- store root (`userData/judgment/…`),
- the judgment-note vocabulary (kept generic here; a power user can seed their own values/frameworks),
- the "produce-prompt" persona used inside `audit`'s arms.
These are the only operator-specific pieces from the source subsystem; everything else is user-agnostic.
