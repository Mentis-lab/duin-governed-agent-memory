# Pre-registration — post-fix LongMemEval_S re-run (W4)

Written BEFORE any post-fix run. The 2026-08-17 result (76.0 vs 85.0, RESULTS-2026-08-17.md)
was measured against pre-fix trunk `5c0d708`; adaptive whole-note grounding (`5e8741a`) deployed
hours later and has never been benchmarked. This file fixes the protocol and the decision rules
so the re-run cannot be graded on vibes after the fact.

## Config under test
- Deployed app (asar lineage `bfa3f32`+, carries `decideBreadth`), isolated bench instance.
- Env (launch-parity, now set by bench_instance.ps1 itself): `DUIN_WHOLENOTE_GROUND=1`,
  `DUIN_WHOLENOTE_ALLOW_CLOUD=1`, adaptive defaults (`SPREAD_MIN=3`, `WINDOW=8`).
- Both arms gpt-5.5 via the OneAI gateway; judge `oneai` (same as 08-17 — comparability beats
  judge purity here); dataset `longmemeval_s_cleaned`, `--stratify` (27/26/16/14/11/6 mix), n=100.
- Invocation: `python lme_harness.py iso --variant s --n 100 --stratify` (guaranteed operator
  restore; supervisor + feishu-bridge schtasks disabled for the window and restored after).

## Protocol
- **2 runs minimum.** A 3rd run only if runs 1-2 DISAGREE IN SIGN on the primary endpoint.
- Identical stratified question set across runs and arms (same offset/stratify → same selection).
- Per-question paired comparison against the naive arm on the same questions; the July/Aug
  "deltas <10 = noise" claim was a misapplication of cross-harness spread and is retired —
  the paired subscore deltas are the signal, the overall number is context.
- Grading dies on a gateway 502 → re-run `grade` alone on the surviving hypotheses (hypotheses
  persist; never re-generate to fix a grading fault).
- Traps checklist (all fixed in the current harness, verify anyway): ONEAI base inherited or
  set (empty-answer trap), keys.json present in DUIN-bench userData, `--stratify` passed
  (sampling trap).

## Pre-registered decision rules
- **Primary endpoint: multi-session subscore, DUIN − naive, mean of runs.**
  - **T1 FIRES** if DUIN still loses multi-session by MORE than 5 points → architecture review
    of the distillation premise itself (raw-session store + governed overlay), not another
    retrieval patch. The consolidation-writer question (D2) resolves to NO.
  - **T1 CLEAR** if the multi-session gap is ≤5 points or reversed → the premise stands;
    adaptive breadth did its job; D2 (consolidation writer, governed lane) opens for design.
- Secondary: temporal-reasoning + knowledge-update deltas (the two abilities bitemporal
  supersession exists for) — reported, directional, not decisive alone.
- **Regression guard:** single-session categories (the 08-17 wins: 14/14, 11/11) dropping >5
  points vs 08-17 means the adaptive threshold over-widens → tune `DUIN_WHOLENOTE_SPREAD_MIN`,
  do NOT read it as the premise failing.
- No post-hoc endpoint additions. Anything else interesting goes in a "hypothesis-generating"
  section of the results, explicitly labeled.

## What this decides
T1 is the field-evaluation tripwire (2026-08-21 strategy review): it separates "the governed
distillation premise holds once retrieval breadth adapts" from "storing raw sessions with a
governed overlay is the honest architecture". Either answer is a win over not knowing.
