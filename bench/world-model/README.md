# DUIN World-Model Benchmark Loop — Stage 0

The yardstick from `DUIN-WORLD-MODEL-BUILD-SPEC-2026-07-25.md`. Stage 0 gates every later stage:
*you cannot claim a conversion without the number.*

Everything here is **offline, read-only, zero app imports, zero enactment**. It reads vault ledgers
and markdown and does pure math. Safe to run against a live instance; it cannot change product
behavior.

```bash
node run-bench.mjs                                    # full baseline, default vault
node run-bench.mjs --vault <dir> --out baseline.json  # pin the vault, persist the baseline
node score-trend.mjs     <ledger.jsonl> [--period week|month]
node score-foresight.mjs <ledger.jsonl> <decisionsDir>
node score-calibration.mjs <ledger.jsonl>             # permissive variant, see note below
```

## App-parity (why these numbers are trustworthy)

`run-bench.mjs` independently reproduces the running app's own figures from the raw ledger:

| Quantity | Harness | Live app | Source |
|---|---|---|---|
| Brier | 0.1819 | 0.1819 | `GET /state/calibration-score` |
| base-rate Brier | 0.1094 | 0.1094 | same |
| ECE | 0.25 | 0.25 | same |
| n | 8 | 8 | same |
| signal-mode useful rate | 0.8515 | 0.851 | `GET /state/calibration` |

Same inputs, same answers, no shared code. That parity is the harness's correctness proof.

## The two populations — never mix them

This is the reconciliation the first scorer left as a TODO, resolved in `lib/ledger.mjs` against the
app's own authority (`electron/services/brain/calibration-scoring.ts`):

- **proper** — real probabilistic forecasts. Scored with Brier / Murphy skill / ECE. **n = 8.**
- **signal** — `decision-window` rows, which the code itself calls *"a deadline reminder, not a
  forecast"*. Scored as efficacy (on-time vs slipped). **n = 202.**

Outcome mapping mirrors the app exactly: `materialized|hit → 1`; `averted → 1` only for the
structural kinds (`driver`, `convergence`) where averted means the structure *held*, else `0`;
`refuted|miss → 0`; `unobserved|moot|open` excluded.

**Why it matters:** the widely-quoted 0.851 comes from the 202-row signal population. The Brier
comes from the 8-row proper population. Reporting one with the other's sample size is the single
easiest way to overstate this axis. The harness prints them in separate blocks for that reason.

> `score-calibration.mjs` (committed earlier) is the **permissive** variant: it scores *all* rows in
> one pool, including signal-mode. That is why it reports Brier ≈ 0.165 over a much larger n. It is
> kept as-is; prefer `run-bench.mjs` for the app-parity split.

## Stage 0 baseline (2026-07-25, live vault)

| Axis | Metric | Baseline | Status |
|---|---|---|---|
| 1 · State | LoCoMo-J-vault | — | **not measurable offline** (Stage 1 shipped the traversal it needs: `/state/kg-query`) |
| 2A · Transition (outcome) | Brier / skill / ECE | **Brier 0.182** vs base-rate 0.109; ECE 0.25; skill **gated** (n=8 < 20) | measured |
| 2B · Transition (delta) | state-delta F1 | — | **built in Stage 2** — read via `/state/transition-score` |
| 3 · Foresight | M1 / M2 / M3 | M1 / M2 **awaiting data** (rankOptions shipped in Stage 3), M3 **0.18** (one-way: **0**, n=1) | partial |
| 4A · Self-correction (calibration) | ECE, honest-null | ECE 0.25; honest-null **PASS**; 5 distinct confidence levels | measured |
| 4B · Self-correction (slope) | error trend | proper **gated** (n=8); signal **+0.043** weighted, improving | partial |

### Findings this baseline surfaces

1. **Rate-calibrated, not probability-calibrated.** Brier 0.182 is *worse* than the 0.109 base-rate
   baseline (ungated skill −0.66) while the efficacy rate is a healthy 0.851. The system is good at
   being right and bad at saying how sure it is.
2. **`slope: 0` in `self-improve-bench` is a structural artifact for the proper population**, not a
   measured flat trend — n=8 cannot support a slope, and the harness gates it rather than printing 0.
3. **The signal population IS trending up** (+0.043/week weighted, +0.021 unweighted — same sign, so
   not an artifact of thin periods). This is the first measured evidence of positive compounding.
4. **Foresight now ranks, but nothing has been logged yet.** Stage 3 shipped `rankOptions`, so M1/M2
   moved from `unmeasurable` to `awaiting-data` — still null, never 0, because a 0 would imply we
   ranked and scored badly.
5. **Pre-commit catch-rate is low and worst where it matters**: 0.18 overall, **0 of 1** on the
   one-way (irreversible) decision in the window.

## Coverage discipline (no silent gaps)

Two axes are **not** baselined here, and are reported as `not-measurable-offline` with the reason:

- **Axis 1 (State)** needs a gold Q/A set built from the vault edit timeline plus an LLM judge.
  Neither is pure replay. The spec's "macro-J ≈38–42" is an *estimate*, not a measurement — do not
  quote it as one.
- **Axis 2B (state-delta)** is BUILT (Stage 2 `predictDelta`) but stays out of this harness: it
  replays `runVerdicts`, which is TypeScript, and this `.mjs` imports nothing from the app by
  design. Read it at `GET /state/transition-score`.

## Caveats worth carrying

- **M3 is workstream-level coverage, not semantic recall.** The join is `prediction.track ==
  decision tag AND created < decision date`. It shows a forward signal was active in the same
  workstream before the commit — not that it named that decision.
- **The decision corpus predates the ledger.** 12 of 23 dated decisions fall before the ledger's
  first entry (2026-06-09) and could never have been caught; they are excluded, not scored as
  misses. 26 files scanned, 3 dropped for no parseable date.
- **Slopes are sample-weighted.** Periods range from n=3 to n=90; an unweighted fit lets a
  near-empty week swing the trend. Both fits are reported, and a sign disagreement between them is
  flagged as unreliable.
- **n=8 is the binding constraint on this whole axis.** Most "gated" results resolve themselves by
  accumulating resolved probabilistic forecasts, not by changing code.
