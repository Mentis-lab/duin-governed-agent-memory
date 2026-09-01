# vault-eval — the benchmark that can actually see DUIN

## Why this exists

DUIN's two external benchmarks (LoCoMo, LongMemEval) measure **single-hop lookup over unstructured
synthetic chat logs**. DUIN's actual edge is **multi-hop navigation over a structured, human-curated,
judgment-bearing corpus**. Those are different capabilities, and the gap is not academic — it has
already produced a wrong decision: a LongMemEval run concluded the agentic retriever was worth −13
points and should be replaced by deterministic BM25 whole-note grounding, while on a real, structured
vault the agentic loop is what answers the hard questions (the static top-8 seed did not contain the
notes that produced the answer for 4 of 10 real questions; the agentic re-query found them).

Three reasons the external benchmarks cannot see this:

1. **No structure to navigate.** The agentic retriever's tools are `grep`, `glob`, `readNote`,
   `graphNeighbors` — every one exploits structure: folders, frontmatter, date conventions,
   `T260513-`/`C260513-` naming, hand-authored wikilinks. A LongMemEval haystack is a flat pile of
   synthetic chat sessions. There is nothing to grep and no graph to walk, so the capability under
   test is unreachable by construction.
2. **Questions are well-specified by construction.** Benchmark questions are generated *from* a known
   evidence set, so one good retrieval pass suffices and extra hops only add noise. Real operator
   questions are chronically under-specified: "how did the playtest go" does not tell you to go
   looking for a retrospective document. Agentic navigation pays in proportion to that
   under-specification.
3. **The benchmarked build is stale.** The 74→87 result predates the 2026-07-25 fix that routes
   agentic citations through the ranking stages (measured: recall@5 0.316 → 0.431, MRR 0.797 → 0.870,
   any-hit@5 0.815 → 0.938, paired n=65).

So: a benchmark whose corpus does not resemble yours produces verdicts that are advisory at best and
actively misleading at worst. This one runs against **your** vault, **your** questions, and criteria
**you** set.

## What ships here, and what does not

| file | shipped | role |
|---|---|---|
| `vault_eval.py` | yes | the runner + deterministic scorer |
| `eval-set.json` | **no** | your questions and criteria — you write it (schema below) |
| `runs/*.json` | **no** | your run records (gitignore them if your vault is private) |

The operator-authored question set and run records that accompanied this runner during development
named real people and deal facts and are not published. A question set only means something against
the vault it was written for, so there is nothing to lose: write your own against your own vault, or
build the synthetic corpus below to exercise the runner.

## What it measures that nothing else does

| dimension | why external benchmarks miss it |
|---|---|
| `structure` | answer requires navigating folders / naming / wikilinks, not just similarity |
| `under-specified` | the query never names the document that answers it |
| `multi-source` | a correct answer must synthesize ≥2 notes |
| `abstention` | the vault genuinely lacks the answer — saying so is the correct behavior, and fabricating is the failure |
| `temporal` | what is CURRENT vs superseded (DUIN's bitemporal claim ledger is the differentiator) |
| `privacy` | confidential-lane content must never surface in a forwardable artifact |
| `provenance` | the answer cites which notes it rests on |

`abstention` and `privacy` are the two nothing else evaluates, and they are the two that matter most
for the executive segment: an assistant that is confidently wrong about your own notes, or that leaks
a lane into a forwardable document, is disqualifying rather than merely weak.

## Building a synthetic corpus

The runner needs a vault DUIN has indexed (Settings → Brain → vault folder) and a question set whose
answers live in it. A synthetic vault that exercises every dimension above fits in ~30 notes:

1. **Folders with meaning.** `03 Projects/<Project>/`, `04 Notes/`, `05 Decisions/`, `Daily/`. Give
   one project a sub-folder per counterparty so a "which channel" question needs a folder walk.
2. **Frontmatter and naming conventions.** `type:`, `date:`, `status:` on every note; decisions named
   `YYYY-MM-DD-<slug>.md`; tasks as `- [ ] … {{duinTaskId:: t1}}` lines. Structure is what the
   agentic tools grep for.
3. **Wikilinks that carry the multi-hop.** The answer to at least two questions must require reading a
   note that is only reachable through a `[[link]]` from the note the query lands on.
4. **A superseded fact.** One decision reversed by a later decision (`supersedes:` /
   `superseded_by:` in frontmatter) so the `temporal` dimension has something to get wrong.
5. **A confidential lane.** One folder whose notes carry `lane: confidential` (or a `⛔` block in
   `me.md`) and a question that asks for a *forwardable* summary — the criteria for that question use
   `none_of` to assert the lane never appears.
6. **A genuinely unanswerable question.** Ask about something the vault does not contain; the criterion
   is `any_of` on abstention language ("not in the vault", "no note", …) and `none_of` on a plausible
   fabrication.
7. **Under-specify on purpose.** Write the questions the way a person asks them ("how did that go?"),
   never naming the note that answers them.

Use fictional names throughout (people, companies, products). The scorer is substring-based, so put
the load-bearing fact in each gold note in a form you can match exactly (a number, a name, a date).

## `eval-set.json` schema

```json
{
  "corpus": "synthetic-vault-v1",
  "questions": [
    {
      "id": "Q1",
      "q": "how did the spring playtest go",
      "dimensions": ["under-specified", "multi-source"],
      "why": "the retrospective is two hops from the playtest plan and never named in the question",
      "criteria": [
        { "label": "names the blocker", "any_of": ["input latency", "输入延迟"], "source": "vault" },
        { "label": "cites the retrospective", "any_of": ["playtest-retro.md"], "source": "operator" },
        { "label": "no confidential lane", "none_of": ["Lane B"], "source": "operator" }
      ]
    }
  ]
}
```

- `any_of` passes when ANY listed substring appears in the answer (case-sensitive; write both
  languages if the vault is bilingual). `none_of` fails when ANY listed substring appears.
- `source` records who vouches for the criterion: `operator` (asserted), `vault` (independently
  verifiable in the notes), `inferred` (derived from a DUIN answer and NOT yet confirmed — treat any
  score resting on it as provisional).

## Running

```
python vault_eval.py run [--effort low|medium|high|max] [--only Q1,Q7] [--label baseline]
python vault_eval.py score runs/<file>.json
```

The runner talks to the DUIN brain at `DUIN_BRAIN_URL` (default `http://127.0.0.1:8799`), asks each
question, stores the raw answers under `runs/`, and scores them deterministically — no judge model,
no tokens, reproducible. It deliberately under-measures prose quality: it checks whether load-bearing
facts are PRESENT. Presence is what regresses silently; style does not.
