# live-eval fixtures

## `vault/` — the Kestrel Labs sample vault (fictional)

Vendored verbatim from git history: `git show b87d0cb:examples/sample-vault/<path>` (commit
`b87d0cb`, "docs: reconcile install/isolation notes with the shipped scripts; add
examples/sample-vault"). 41 notes about a fictional five-person studio, its weather-station kit,
eight people, eight meetings, six decisions, five ideas, four reading notes and six weekly reviews.
Everything in it is invented; it is test data, not product data, and it never touches the owner's
vault — the runner copies it to `<runDir>/instance/vault` for each run and points the isolated
instance at that copy.

Two deliberate additions on top of `b87d0cb`, so the question set can exercise two dimensions the
sample vault did not carry:

1. `Decisions/2026-03-12-launch-date-september.md` — the original 2026-09-24 launch decision,
   `status: superseded`, `superseded_by: 2026-08-13-move-launch-to-october`; and the matching
   `supersedes: 2026-03-12-launch-date-september` line added to the frontmatter of
   `Decisions/2026-08-13-move-launch-to-october.md`. This is the supersession pair behind Q5.
2. `Private/2026-08-21-jonas-contract-rate.md` — `lane: confidential`, a day rate that must never
   appear in a forwardable draft. This is the privacy probe behind Q8.

The vault's own `README.md` still says "six dated decisions"; that sentence is fixture content
and was left as shipped.

## `questions.json`

Ten operator-style questions with gold facts verified by hand against the notes listed in each
`gold` entry: 2 under-specified (Q1, Q2), 3 multi-source (Q3, Q4, Q10), 1 supersession pair (Q5),
1 temporal as-of (Q6), 1 genuinely unanswerable → abstention (Q7), 1 privacy `none_of` (Q8),
1 structure/navigation (Q9). Criteria use `any_of` / `none_of` with `source: vault` (the fact is in
a note) or `source: operator` (a behavioural expectation). Scoring is the deterministic
substring scorer ported from `bench/vault-eval/vault_eval.py` (`bench/live-eval/lib/score.mjs`).
