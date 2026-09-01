// Brain persistence schema (applied by db-migrations v18). Durable home for the
// decision-loop's "made" side and the calibration ledger (logged predictions +
// their verdicts). Seed brains stay renderer-side (localStorage) — these tables
// are the state that was previously in-memory-only and lost on restart.
//
// DDL lives here (mirrors loop-schema.ts) so a focused integration test can run
// the exact same statements.

export const BRAIN_SCHEMA_SQL = `
-- The decisions the user has made (decision-loop "made" side). One row per
-- node; a re-decide replaces it (UPSERT on node_id).
CREATE TABLE IF NOT EXISTS brain_decisions (
  node_id    TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  -- Valid set (cleared/blocked/done/dismissed/cancelled) is enforced by the
  -- DecisionOutcome TS type, not a SQL CHECK (migration v19 dropped the 2-value
  -- CHECK so the table can widen without an ALTER).
  choice     TEXT NOT NULL,
  note       TEXT,
  decided_at TEXT NOT NULL
);

-- Logged predictions (the calibration ledger input). Append-once per id; the
-- first sighting's created_at is preserved so we can resolve it after its due.
CREATE TABLE IF NOT EXISTS brain_predictions (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  due        TEXT,
  confidence REAL,
  track      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_predictions_kind ON brain_predictions(kind);

-- Verdicts on predictions (the calibration feedback). One row per prediction.
--   happened    — the foreseen risk occurred (prediction was right)
--   averted     — flagged, you acted, prevented it (a useful catch)
--   false_alarm — never a real risk (prediction was wrong)
--   unobserved  — not yet resolved (the default before a verdict)
CREATE TABLE IF NOT EXISTS brain_verdicts (
  prediction_id TEXT PRIMARY KEY,
  outcome       TEXT NOT NULL CHECK(outcome IN ('happened','averted','false_alarm','unobserved')),
  note          TEXT,
  recorded_at   TEXT NOT NULL
);

-- Verdicts on cross-cutting insights (useful/dismissed/acted/inaccurate). This is
-- the Home Digest's AFFINITY signal — the moat term that leans the digest toward
-- the KIND of insight the operator keeps finding useful. One row per insight id
-- (a re-verdict replaces it). \`feature\` is the insight's rule family (the id
-- prefix before \`::\`, e.g. conv / riskconc / orphan) so the useful-rate accrues
-- per kind of insight, not per one-off id. No SQL CHECK — the verdict set is
-- enforced by the TS type (mirrors the brain_decisions decision here).
CREATE TABLE IF NOT EXISTS brain_insight_verdicts (
  insight_id  TEXT PRIMARY KEY,
  feature     TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_insight_verdicts_feature ON brain_insight_verdicts(feature);

-- Home Digest SALIENCE attention-state (second-brain modulators on the ranking).
-- NOT durable/moat-projected: unlike verdicts (real user judgments) these are derived
-- attention state — losing them on reinstall just resets novelty/anti-nag to neutral,
-- which is the cold-start behavior anyway. One row per insight id.
--   first_seen: when the brain first NOTICED this insight → Novelty (newly-derived
--     knowledge is more salient; the boost decays with age).
CREATE TABLE IF NOT EXISTS brain_insight_first_seen (
  insight_id    TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);
--   impressions: how many distinct DAYS this insight has been SHOWN in the digest →
--     Decay (habituation / anti-nag: fade an insight the operator keeps seeing but not
--     acting on). Per-DAY, not per-render, so polling can't inflate it.
CREATE TABLE IF NOT EXISTS brain_insight_impressions (
  insight_id   TEXT PRIMARY KEY,
  shown_days   INTEGER NOT NULL,
  last_shown_on TEXT NOT NULL
);
`

// Foundation 3 — the persistent ENTITY GRAPH substrate (entity-graph-store.ts). DUIN's other
// durable stores are FLAT (operator-facts) or WHOLE-FILE/full-rebuild BATCH (claim-ledger,
// construction JSON); none is a node/edge graph with SINGLE-NODE incremental writes. These two
// tables are that store: `entity_nodes` is the node table (retire-not-delete via `valid_to`,
// mirroring the claim ledger's reversible retirement), and `entity_edges` is the edge table with
// a src+dst neighbour index so a write-time relink can read one node's neighbourhood in O(deg)
// instead of scanning. The store adds PERSISTENCE + neighbour-evolution + retirement; it is NOT a
// new merge gate — entity-resolver's ENTITY_ALIAS whitelist + disjoint-subgraph tripwire stay the
// SOLE merge authority. Added by db-migrations v27 (mirrors the v26 salience precedent). Empty
// tables are inert/harmless — the WRITES (write-time relink) and the retirement CASCADE are gated
// behind DUIN_ENTITY_GRAPH, which is `!== '0'` — i.e. DEFAULT **ON**, opt-OUT (see
// entity-graph-relink.ts:52). This comment said "default OFF" until 2026-07-28 and was wrong:
// persistent entity-graph writes ARE happening on every install that has not explicitly set
// DUIN_ENTITY_GRAPH=0. `coherence-map.ts` carries the same stale claim and scores the subsystem as
// a deliberate cold gate on the strength of it. Corrected here rather than changing the flag,
// because the flag's own docblock ("staging flag, =0 to opt out") shows ON is the intent.
export const ENTITY_GRAPH_SCHEMA_SQL = `
-- Persistent entity nodes. One row per canonical entity id. RETIRE-NOT-DELETE: a merge/removal sets
-- \`valid_to\` (reversible), never deletes the row — mirrors the claim ledger's validTo retirement.
CREATE TABLE IF NOT EXISTS entity_nodes (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  -- when this node was folded into another identity (rekeyNode); NULL for a first-class live node.
  canonical_id TEXT,
  -- retirement stamp (ISO). NULL = live/active; set = retired (merged-away / removed / orphaned).
  valid_to     TEXT,
  -- WHICH PLANE minted this node. 'construction' = the typed LLM extraction layer (carries a real
  -- kind); 'claim' = the claim/relink path, which knows a label but genuinely has NO kind, so its
  -- rows carry kind='entity' honestly rather than defectively; 'operator' = a direct human action.
  -- Without this the two populations were indistinguishable and the coherence axis conflated them
  -- (see migration v46). NEVER back-inferred — 'unknown' is first-class, per constitution property 3.
  source       TEXT NOT NULL DEFAULT 'unknown'
               CHECK(source IN ('construction','claim','operator','unknown')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Persistent directed edges (src --type--> dst). One row per (src,dst,type) — a re-observation is an
-- idempotent UPSERT (bumps updated_at). RETIRE-NOT-DELETE via \`valid_to\`.
CREATE TABLE IF NOT EXISTS entity_edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  type       TEXT NOT NULL,
  valid_to   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (src, dst, type)
);
-- The NEIGHBOUR INDEX — the whole point of the store: an O(deg) single-node neighbour read in BOTH
-- directions (neighborsOf) instead of a table scan, so write-time relink stays incremental.
CREATE INDEX IF NOT EXISTS idx_entity_edges_src ON entity_edges(src);
CREATE INDEX IF NOT EXISTS idx_entity_edges_dst ON entity_edges(dst);
`
