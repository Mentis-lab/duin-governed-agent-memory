# Embedder A/B eval (Spec §C)

The gate that decides whether a multilingual embedder earns the default. The metric core and the
decision rule are pure and unit-tested (`scoring.ts`, `scoring.test.ts`); the live run is
operator-triggered against a vault you point it at, never CI.

## Why a runner, not a vitest test
Scoring a real embedder means reindexing a vault under each candidate model (downloading bge-m3
~600 MB / e5 ~118 MB) and running `index-store.search` — that needs the Electron runtime + native
`better-sqlite3` + sqlite-vec, which do not load under vitest. So the run is a one-off operator step.

## What ships here, and what does not
| file | shipped | role |
|---|---|---|
| `scoring.ts` | yes | `rankOf`, `scoreByBucket`, `multilingualWins` — the metric + decision rule |
| `scoring.test.ts` | yes | pins the metric on tiny hand-made rankings |
| `cn-en-queries.jsonl` | **no** | the labeled query set — you build it (format below) |

The labeled set that accompanied this runner during development was written against one operator's
real vault and named real decisions, so it is not published. A query set only scores the vault it was
labeled on; build yours against yours.

## Building a synthetic labeled set
`cn-en-queries.jsonl` is one JSON object per line:

```json
{"query": "为什么终止了和渠道商的合作", "expectNote": "05 Decisions/2026-05-14-channel-partner-ended.md", "bucket": "cn-paraphrase"}
{"query": "渠道商合作终止", "expectNote": "05 Decisions/2026-05-14-channel-partner-ended.md", "bucket": "cn-exact"}
{"query": "why did we end the channel partnership", "expectNote": "05 Decisions/2026-05-14-channel-partner-ended.md", "bucket": "en"}
```

- `expectNote` is the vault-relative path of the ONE note that answers the query. It must exist in
  the vault you index, or the query scores as a miss under every candidate.
- `bucket` is one of `cn-exact` (the query reuses the note's own wording), `cn-paraphrase` (same
  meaning, different words — the bucket a multilingual model is supposed to win), `en` (an English
  query against a Chinese note, or vice versa — the bucket it must not lose).
- Cover all three buckets with at least ~10 queries each. Fewer than that and the decision rule's
  thresholds (0.05 / 0.02) sit inside the noise.
- A synthetic vault works: write ~30 fictional-name notes (decisions, meeting notes, a project folder
  per counterparty), then write three queries per note — one per bucket — from the note's content.

## Run (when evaluating a candidate)
1. Point DUIN at the vault (Settings → Brain) and let the index finish.
2. For each candidate in `[bge-small-en-v1.5, multilingual-e5-small, bge-m3]`:
   `probeModel` → on success, set it active → `reindex` (the dim-flexible vec table migrates) → for
   each labeled query, `search(query, 5)` → collect the ranked note-ids.
3. `scoreByBucket(labels, retrievedByQuery)` per candidate; print a per-bucket recall@5 / MRR table.

## Decision rule (`multilingualWins`)
Flip `DEFAULT_EMBEDDER_ID` to a multilingual model ONLY if it lifts **cn-paraphrase recall@5** by
> 0.05 **without** regressing **en** recall@5 by more than 0.02. An earlier e5 attempt failed exactly
this (no measured CN win), which is why the default only moves when a candidate clears the bar on a
labeled set.
