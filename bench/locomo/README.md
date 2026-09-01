# LoCoMo — DUIN's first external benchmark run

`DUIN LoCoMo J = 73.5%` (147/200), 95% CI [67.4, 79.6] · run 2026-07-25 · 21.9 min, 0 errors.

Peer-reviewed anchors: Zep ~75.1 · Mem0-graph 68.4 · full-context upper bound ~72.9.

| Category | J | n |
|---|---|---|
| cat1 multi-hop | 45.9% | 17/37 |
| cat2 temporal | 69.0% | 29/42 |
| cat3 open-domain | 58.3% | 7/12 |
| cat4 single-hop | 86.2% | 94/109 |
| **Overall J** | **73.5%** | **147/200** |

## Reproducing

```
python locomo_harness.py run --n 200 --seed 0
```

Needs the LoCoMo dataset (`locomo10.json` from `snap-research/locomo`, ~2.8 MB — not vendored here)
and a running DUIN brain on `:8799`. Run it against a **bench instance** with its own
`--user-data-dir`, never the operator's brain: the harness repoints the indexed directory via
`POST /state/config`.

Path through the product, so this measures DUIN and not a mock: one dated `.md` per conversation
session → `POST /state/config` → poll `GET /state/index-status` → `POST /agui` per question, reading
`TEXT_MESSAGE_CONTENT` deltas. Live retrieval + claim-metabolism.

`duin_locomo-2026-07-25.jsonl` holds the per-item record for the run above — DUIN's answer (`hyp`),
the judge's verdict (`correct`, `judge_raw`), latency and retrieval count, keyed by `sample_id` +
`qi`. Keep it: it is what makes the headline number auditable rather than a claim. The LoCoMo
question, gold answer and evidence spans are NOT in the file (see the attribution below); join on
`sample_id` + `qi` against your own copy of `locomo10.json` to see them side by side.

## Dataset attribution

LoCoMo (Long-term Conversational Memory) is by Snap Research — Maharana et al., "Evaluating Very
Long-Term Conversational Memory of LLM Agents", 2024 — <https://github.com/snap-research/locomo>,
released under **CC BY-NC 4.0**. The dataset is not vendored here: neither `locomo10.json` nor its
questions, gold answers or evidence spans are in this repository. `duin_locomo-2026-07-25.jsonl`
contains only DUIN's own outputs and the judge's verdicts; obtain LoCoMo from its authors under
its own terms to reproduce or audit the run.

## Reading the number honestly

- **Sample** is 200 of 1,540, proportional-stratified by category, `seed=0`, fixed **before** any
  result was seen, spanning all 10 conversations. Category 5 (adversarial, no gold answer) is
  excluded per the Mem0/LoCoMo-memory convention.
- **Answer and judge shared a base model** (`gpt-5.5` via OneAI — the only keyed provider on the
  bench instance). Self-family judging plausibly inflates J by a few points. A cross-family judge is
  the cheapest hardening and should land before this number is quoted externally.
- **There is no baseline arm.** This is DUIN's absolute J, not a lift over naive RAG, so it does not
  yet answer "does the accumulated brain beat plain retrieval". That arm is still a TODO in
  `bench/longmemeval/README.md`.
- **The judge differs from the published work** (papers typically use gpt-4o / gpt-4o-mini), so
  cross-paper comparison is indicative, not exact.
- **cat3 (n=12) is noise.** The overall, cat4 and cat2 figures carry the weight. **cat1 multi-hop at
  45.9% is the real finding** — it is the weakest category by a wide margin and the most actionable
  thing the run surfaced.
