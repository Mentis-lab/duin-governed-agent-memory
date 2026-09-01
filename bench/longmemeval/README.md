# LongMemEval harness for DUIN

Measures **DUIN's memory moat vs. baseline models on the same base model** — isolating the *lift
from DUIN's bitemporal-graph memory + hybrid retrieval*, which is the number worth reporting
("DUIN vs baseline Opus" on the axis DUIN is actually built for).

Why LongMemEval (not UniClawBench): it scores long-term memory abilities — **knowledge-updates** and
**temporal reasoning** — that map directly onto DUIN's supersession / valid-invalid intervals / as-of
queries. It's a QA interface DUIN serves through `/agui` with no computer-use / Docker build. (See the
handoff doc for the full UniClawBench-vs-LongMemEval rationale.)

## Conditions (one grader)
| Condition | How | Tests |
|---|---|---|
| `duin` | ingest a question's session haystack into a DUIN vault → ask via `/agui` | DUIN's full memory pipeline (retrieval + claim-metabolism) |
| `baseline` (fullctx) | whole haystack in the prompt → base model directly | ceiling; overflows on `_m` |
| naiverag *(TODO)* | embed sessions, top-k → base model | the fair RAG comparison |

**Headline number:** `acc(duin) − acc(naiverag)` on the **same base model** = DUIN's memory contribution.

## Dataset (HF `xiaowu0162/longmemeval-cleaned`, MIT)
500 questions × 6 `question_type`s + a 30-item `_abs` abstention subset. Report **LongMemEval_S**
(`longmemeval_s_cleaned.json`, ~115k tok/Q); `oracle` is the retrieval-trivial sanity ceiling (already
downloaded). Grab the others:
```
curl -sL -o data/longmemeval_s_cleaned.json https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

## Model access
- **`duin` needs NO key** — DUIN self-auths via its OS keychain and answers through `/agui`.
- **`baseline` + `grade` need a key** in the environment: `ANTHROPIC_API_KEY` (Claude) or `OPENAI_API_KEY`
  (gpt-4o — the LongMemEval **standard grader**; use it for reportable numbers). The grader is LLM-as-judge
  with the official per-`question_type` prompts (temp 0, yes/no), reproduced verbatim in `lme_harness.py`.

## Commands
```
python lme_harness.py selfcheck                                   # offline: converter + judge prompts + metrics
python lme_harness.py convert  --variant oracle --qid <id>        # preview the DUIN notes for one instance
python lme_harness.py duin     --variant oracle --n 5 --out runs/duin.jsonl --restore-dir "<operator vault>"
python lme_harness.py baseline --variant oracle --n 5 --out runs/fullctx.jsonl --model claude-opus-4-8
python lme_harness.py grade    --hyp runs/duin.jsonl --variant oracle --judge gpt-4o     # -> *.graded + metrics
python lme_harness.py metrics  --graded runs/duin.jsonl.graded
```
Metrics reported: **Overall**, **Task-averaged** (macro over the 6 types), **Abstention**, and per-type.

## Validated so far (PoC)
- ✅ Dataset pulled (oracle, 500, exact type distribution).
- ✅ Converter: instance → one timestamped `.md` note per session (what DUIN ingests).
- ✅ `/agui` adapter: round-trips + SSE-parses an answer (`PONG` in 10.2s), operator vault untouched.
- ✅ Judge-prompt routing (per type incl. temporal/knowledge-update/preference/abstention) + metrics aggregation.
- ⏳ Not yet run at scale: the full `duin` ingest→ask loop and the graded DUIN-vs-baseline numbers (need the items below).

## Isolated benchmark instance (READY — use this, never your live brain)
Isolation is via Electron's `--user-data-dir` (separate settings / search index / claim ledger /
model cache / vault pointer), running **exclusively** on `:8799`. Your real brain data (default
userData) is untouched; your DUIN is stopped for the run and relaunched by `-Action stop`.
```
powershell -File bench_instance.ps1 -Action start     # stop operator DUIN, boot isolated instance on :8799
python lme_harness.py duin --variant oracle --n 20 --out runs/duin.jsonl   # DUIN_BRAIN_URL defaults to :8799
python lme_harness.py baseline --variant oracle --n 20 --model claude-opus-4-8   # needs an API key
python lme_harness.py grade --hyp runs/duin.jsonl --variant oracle --judge gpt-4o
powershell -File bench_instance.ps1 -Action stop      # stop bench instance, relaunch operator DUIN
```
Verified 2026-07-12: the bench instance boots healthy on `:8799` with an EMPTY vault (`/state/config`
`dir=''`) — fully separate from the operator vault. First boot downloads e5-small into its own model
cache (one-time). `LOCAL_BRAIN_PORT` is also env-overridable (`DUIN_BRAIN_PORT`) for a future
*concurrent* instance, but a few internal self-calls still hardcode `:8799`, so prefer the exclusive
`--user-data-dir` path above until those are parameterized.

## Remaining before the full 500-Q run
1. **Index-ready poll.** The `duin` loop currently `sleep(settle)` after repoint. Replace with a poll on
   an index-size/ready signal so it never asks before the reindex lands (correctness + speed). ~1h.
2. **API key** for `baseline` + `grade` (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`; `duin` needs none). For
   apples-to-apples "DUIN vs Opus": baseline `--model claude-opus-4-8`, DUIN's answer model = Opus, grade
   with gpt-4o.
3. **naiverag baseline** (the fair RAG comparison the headline delta needs) — still a TODO.
4. **Scale.** 500 Q × (ingest+reindex+ask) is an overnight batch — validate `oracle --n 20` first
   (retrieval trivial → isolates reader+grader), then run `s`.

## What "good" looks like (from the paper)
Long-context LLMs drop 30–60% on `_S` vs oracle; strong systems land ~30–70% by ability (temporal-reasoning
+ knowledge-update hardest). Memory-system design typically buys ~4–11% over naive full-context/RAG — that
band is roughly the DUIN lift we're trying to demonstrate (and beat).
