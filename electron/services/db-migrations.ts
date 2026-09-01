import type { Database } from 'better-sqlite3'
import { applyChangeContractSchema } from './change-contract-schema'
import { applyProofReceiptSchema } from './proof-receipt-schema'
import { applyFailureLedgerSchema } from './failure-ledger-schema'
import { LOOP_SCHEMA_SQL } from './loop-schema'
import { BRAIN_SCHEMA_SQL, ENTITY_GRAPH_SCHEMA_SQL } from './brain/brain-schema'
import {
  PROPOSED_EDIT_SCHEMA_SQL,
  addProposedEditWorkspaceRootColumn
} from './proposed-edit-schema'
import { sweepOrphanedConversationChildren } from './orphan-sweep'
import { messageOf } from './guarded'
import { applyOperationalGoalSchema } from './goal-lifecycle-schema'
import { AUTOMATION_RUN_SCHEMA_SQL } from './automation-run-schema'
import { applyAutomationTriggerSchema } from './automation-trigger-schema'
import {
  applyAutomationGoalBindingSchema,
  applyGoalLoopBridgeSchema
} from './goal-automation-bridge-schema'

// Persistence Phase / PS1 — migration ledger gated by PRAGMA user_version.
//
// Rationale: until v0.9.0 the schema evolved via `safeAddColumn` alone — a
// regex-guarded ALTER TABLE that swallows "duplicate column name" and lets
// every other failure bubble. That worked while every change was idempotent
// (column adds with NULL-friendly defaults). The moment we need a non-
// idempotent step — data backfill, FTS rebuild, vec0 dimension swap — we
// have no way to know whether a previous launch ran it. A partial migration
// on a crashed startup is invisible.
//
// `PRAGMA user_version` is SQLite's built-in single-integer ledger. It is
// atomic in WAL mode and costs nothing to read. We use it as the marker;
// the typed `MIGRATIONS` array below is the source of truth for what each
// version means.
//
// Discipline (per the phase plan §0.6):
//   - `safeAddColumn` stays for idempotent column adds INSIDE a migration's
//     `up(db)`.
//   - Non-idempotent steps (backfills, rebuilds, drops) MUST go through a
//     migration. They run exactly once per DB and gate on `user_version`.
//   - Each migration's `up(db)` runs INSIDE a single transaction wrapping
//     the user_version bump. A throw rolls back both the DDL/DML and the
//     version stamp — the next launch retries from the same version.
//   - Migrations are append-only and ordered by `version`. Renumbering is
//     forbidden; a typo is a new migration with a fix-forward `up`.
//
// Baseline: v0.8.x DBs come in stamped at user_version = 0 (SQLite default).
// Migration v1 is the "stamp existing schema" no-op — it just asserts the
// baseline tables exist and bumps the version. Future PS prompts (PS6, PS7,
// PS9, PS11) append entries with version 2, 3, … each guarded by the same
// transaction discipline.

export interface Migration {
  /** Monotonic version this migration upgrades the DB TO. */
  version: number
  /** One-line description, surfaced in logs + the Persistence Settings panel. */
  description: string
  /**
   * Apply the migration. Runs inside a transaction with the user_version
   * bump. Throw to abort the whole migration; the rollback restores both
   * the schema and the version stamp atomically.
   */
  up(db: Database): void
}

/**
 * Every `version` that a RELEASED DUIN build has ever registered — i.e. every
 * number that some user's `PRAGMA user_version` may already have been stamped
 * past. Frozen: this list only ever grows by appending, and only when a build
 * actually ships.
 *
 * This exists because `runMigrations` gates on `version <= user_version`. A
 * number BELOW the highest released version can never execute again on an
 * existing install — the stamp has already passed it. Reserving such a number
 * "for a concurrent workstream" therefore reserves a permanent silent no-op:
 * the migration runs on the developer's fresh DB (which starts at 0) and does
 * nothing on every real vault, so the bug is invisible to whoever wrote it.
 * `assertMigrationRegistryValid` turns that into a hard startup failure.
 *
 * The gaps below (3-10, 29-31, 37-42) are DEAD NUMBERS, not a reservation
 * pool. Never assign one.
 */
const RELEASED_VERSIONS: readonly number[] = [
  1, 2, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 32, 33, 34, 35,
  36, 43
]

/** Highest version any released build has stamped. A new migration MUST be > this. */
const RELEASED_FLOOR: number = RELEASED_VERSIONS.reduce((a, v) => (v > a ? v : a), 0)

/**
 * Registry integrity gate, evaluated once at module load over the real registry.
 *
 * Enforces the only two rules that keep a migration from becoming a silent no-op:
 *   1. versions are unique and strictly increasing in array order (append-only), and
 *   2. any version at or below `RELEASED_FLOOR` must be one that a released build
 *      already carried — a NEW migration must claim a number above the floor.
 *
 * Rule 2 is the one that was missing. `duin/localization-phase0` numbers its deferred
 * FTS5 bigram rebuild v28/v29 against a shipped floor of 43; without this gate that
 * merge is accepted, boots cleanly, and never rebuilds the index on any existing vault.
 * With it, the app refuses to start and names the next legal number.
 *
 * Exported (and pure) so it can be exercised directly rather than only via import
 * side-effect.
 */
export function assertMigrationRegistryValid(migrations: readonly Migration[]): void {
  const released = new Set(RELEASED_VERSIONS)
  let previous = 0
  for (const migration of migrations) {
    const v = migration.version
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`db-migrations: migration version ${v} is not a positive integer.`)
    }
    if (v <= previous) {
      throw new Error(
        `db-migrations: migration v${v} ("${migration.description}") is not strictly ` +
          `greater than the preceding v${previous}. The registry is append-only and ` +
          `ordered; renumbering or inserting is forbidden.`
      )
    }
    if (v <= RELEASED_FLOOR && !released.has(v)) {
      throw new Error(
        `db-migrations: migration v${v} ("${migration.description}") claims a version ` +
          `at or below the released floor v${RELEASED_FLOOR} that no shipped build ` +
          `carried. runMigrations skips every version <= user_version, and every ` +
          `existing install is already stamped v${RELEASED_FLOOR}, so this migration ` +
          `would NEVER run on a real vault while appearing to work on a fresh DB. ` +
          `Renumber it to v${RELEASED_FLOOR + 1} or higher.`
      )
    }
    previous = v
  }
}

/**
 * Migration registry. Ordered by `version`. Append-only.
 *
 * IMPORTANT: never renumber. Never delete. If a migration was wrong, add a
 * fix-forward migration with the next version number — which must be strictly
 * greater than every version in `RELEASED_VERSIONS`. There are no reserved
 * numbers; the gaps are dead. `assertMigrationRegistryValid` enforces this at
 * module load.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'PS1 baseline: stamp the v0.8.x schema as version 1',
    up(db) {
      // No DDL. The baseline tables are produced by `initSchema` (which runs
      // before us on every startup) + the historical `safeAddColumn` calls.
      // This migration's only job is to bump user_version from 0 to 1 so
      // subsequent versioned migrations have a known floor to gate against.
      //
      // We still sanity-check that the canonical baseline tables exist —
      // a DB that's been corrupted to the point of missing them is a
      // recovery case, not a migration case, and we want to fail loudly
      // rather than mark it migrated.
      const required = ['conversations', 'messages', 'events']
      const stmt = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      for (const name of required) {
        const row = stmt.get(name)
        if (!row) {
          throw new Error(
            `db-migrations v1: baseline table ${JSON.stringify(name)} is missing — ` +
              `cannot stamp user_version. Run initSchema first.`
          )
        }
      }
    }
  },
  {
    version: 2,
    description:
      'PS7 embedder meta — record active embedder + dimensions for vec0 dim-guard',
    up(db) {
      // Singleton table. The PRIMARY KEY constraint on `id` + the
      // hard-coded 'singleton' value means there is at most one row,
      // ever. stamp/read helpers in rag/embedder-meta.ts enforce that.
      //
      // No backfill: a DB that already has rag_chunk_vec rows but no
      // meta row is treated as "unknown embedder, assume default";
      // assertEmbedderDimensionMatch stamps the first row on first
      // post-PS7 ingest. That's safe because the only dims-in-use up
      // to this point are 384 (both catalogue entries).
      db.exec(`
        CREATE TABLE IF NOT EXISTS rag_embedder_meta (
          id          TEXT PRIMARY KEY CHECK(id = 'singleton'),
          embedder_id TEXT NOT NULL,
          dimensions  INTEGER NOT NULL,
          stamped_at  INTEGER NOT NULL
        );
      `)
    }
  },
  {
    version: 11,
    description: 'PS11 fork lineage and seed metadata columns',
    up(db) {
      // Idempotent column adds via local safeAddColumn helper —
      // db-migrations.ts owns its own safeAddColumn since schema-init.ts
      // (PS6's owner) is the legacy bootstrap and migrations are the
      // canonical path for new columns going forward.
      const safeAddColumn = (table: string, ddl: string): void => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
        } catch (err) {
          const msg = String(messageOf(err) ?? err)
          if (!/duplicate column name/i.test(msg)) throw err
        }
      }
      safeAddColumn('conversations', 'forked_from_id TEXT')
      safeAddColumn('conversations', 'forked_from_message_id TEXT')
      safeAddColumn('conversations', 'seed_blob TEXT')
      safeAddColumn(
        'conversations',
        "seed_source_kind TEXT NOT NULL DEFAULT 'none' CHECK(seed_source_kind IN ('none','message','block','transcript-range','custom'))"
      )
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_forked_from
          ON conversations(forked_from_id, created_at DESC);
      `)
    }
  },
  {
    version: 12,
    description: 'Mechanical proof M1 receipt and artifact tables',
    up(db) {
      applyProofReceiptSchema(db)
    }
  },
  {
    version: 13,
    description: 'Mechanical proof M2 scoped change contracts',
    up(db) {
      applyChangeContractSchema(db)
    }
  },
  {
    version: 14,
    description: 'Mechanical proof M11 failure ledger and replay seeds',
    up(db) {
      applyFailureLedgerSchema(db)
    }
  },
  {
    version: 15,
    description: 'PRJ-2 project model extension — slug, description, updated_at, last_opened_at',
    up(db) {
      const safeAdd = (table: string, ddl: string): void => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
        } catch (err) {
          if (!/duplicate column name/i.test(String(messageOf(err) ?? err))) throw err
        }
      }
      safeAdd('projects', "slug TEXT NOT NULL DEFAULT ''")
      safeAdd('projects', 'description TEXT')
      safeAdd('projects', 'updated_at INTEGER NOT NULL DEFAULT 0')
      safeAdd('projects', 'last_opened_at INTEGER')
    }
  },
  {
    version: 16,
    description:
      'WC-4 messages.proof_status — persisted proof gate trust state ' +
      "(NULL = not-applicable | 'trusted' | 'untrusted' | 'blocked' | 'waived')",
    up(db) {
      const safeAdd = (table: string, ddl: string): void => {
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
        } catch (err) {
          if (!/duplicate column name/i.test(String(messageOf(err) ?? err))) throw err
        }
      }
      safeAdd('messages', 'proof_status TEXT')
    }
  },
  {
    version: 17,
    description:
      'Loop Phase LP-2 — loops entity, loop_backlog queue, loop_runs audit ' +
      '(recurring autonomous loops; off by default via loopsEnabled)',
    up(db) {
      // DDL lives in loop-schema.ts so the node:sqlite integration test runs
      // the EXACT same statements (loop-db-integration.test.ts).
      db.exec(LOOP_SCHEMA_SQL)
    }
  },
  {
    version: 18,
    description:
      'Brain persistence — decisions (decision-loop "made" side) + calibration ' +
      'ledger (logged predictions + verdicts)',
    up(db) {
      // DDL in brain/brain-schema.ts (mirrors the loop-schema pattern).
      db.exec(BRAIN_SCHEMA_SQL)
    }
  },
  {
    version: 19,
    description:
      'Brain decisions — widen choice to the outcome taxonomy ' +
      '(cleared/blocked/done/dismissed/cancelled); drop the 2-value CHECK',
    up(db) {
      // SQLite can't ALTER a CHECK constraint, so rebuild the table preserving
      // every existing row. The valid set is now enforced by the DecisionOutcome
      // TS type rather than a SQL CHECK.
      db.exec(`
        CREATE TABLE brain_decisions_new (
          node_id    TEXT PRIMARY KEY,
          title      TEXT NOT NULL,
          choice     TEXT NOT NULL,
          note       TEXT,
          decided_at TEXT NOT NULL
        );
        INSERT INTO brain_decisions_new (node_id, title, choice, note, decided_at)
          SELECT node_id, title, choice, note, decided_at FROM brain_decisions;
        DROP TABLE brain_decisions;
        ALTER TABLE brain_decisions_new RENAME TO brain_decisions;
      `)
    }
  },
  {
    version: 20,
    description:
      'Failure ledger — drop the brittle kind CHECK so new kinds (runtime_failed, ' +
      'bridged from the event log) are accepted; enforce the set via the TS type',
    up(db) {
      // Only rebuild if the table exists with the old CHECK. SQLite can't ALTER
      // a CHECK, so recreate preserving every row + index. New installs already
      // get the CHECK-free schema (failure-ledger-schema.ts).
      const exists = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='failure_ledger'")
        .get() as { sql: string } | undefined
      if (!exists || !/CHECK\s*\(\s*kind/i.test(exists.sql)) return
      db.exec(`
        CREATE TABLE failure_ledger_new (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL,
          kind TEXT NOT NULL,
          receipt_id TEXT,
          contract_id TEXT,
          event_id TEXT,
          conversation_id TEXT,
          correlation_id TEXT,
          command TEXT,
          diff_hash TEXT,
          message TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          replay_seed_json TEXT NOT NULL DEFAULT '{}',
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO failure_ledger_new SELECT * FROM failure_ledger;
        DROP TABLE failure_ledger;
        ALTER TABLE failure_ledger_new RENAME TO failure_ledger;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_failure_ledger_fingerprint
          ON failure_ledger(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_failure_ledger_kind
          ON failure_ledger(kind, last_seen_at DESC);
        CREATE INDEX IF NOT EXISTS idx_failure_ledger_receipt
          ON failure_ledger(receipt_id);
        CREATE INDEX IF NOT EXISTS idx_failure_ledger_contract
          ON failure_ledger(contract_id, last_seen_at DESC);
      `)
    }
  },
  {
    version: 21,
    description:
      'Brain insight verdicts — persist useful/dismissed on cross-cutting insights ' +
      '(the Home Digest Affinity signal). Idempotent CREATE; new installs also get ' +
      'it via BRAIN_SCHEMA_SQL.',
    up(db) {
      // The same DDL that brain-schema.ts now carries (kept in lockstep). IF NOT
      // EXISTS so a fresh install already at v18+ is a no-op here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS brain_insight_verdicts (
          insight_id  TEXT PRIMARY KEY,
          feature     TEXT NOT NULL,
          verdict     TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_brain_insight_verdicts_feature
          ON brain_insight_verdicts(feature);
      `)
    }
  },
  {
    version: 22,
    description:
      'Proactive — automations.deliver_to: JSON {kind,target} ChannelRef for ' +
      'cron→channel delivery (NULL = no outbound, text-only run)',
    up(db) {
      // Idempotent column add. Fresh installs already get it from initSchema's
      // CREATE TABLE; this migration covers pre-existing automations tables.
      safeAddColumn(db, 'automations', 'deliver_to TEXT')
    }
  },
  {
    version: 23,
    description:
      'Long-run L1-L8 — add durability/budget/context/provider columns to loops ' +
      '(cost_spent, cost_budget_usd, stall_count, last_state_hash, rolling_summary, ' +
      'artifact_dir, last_git_sha, provider_chain, current_provider, last_digest_at)',
    up(db) {
      // Idempotent column adds. Fresh installs already carry these from
      // LOOP_SCHEMA_SQL (CREATE TABLE loops); this migration covers pre-existing
      // loops tables created before v23.
      safeAddColumn(db, 'loops', 'cost_spent REAL NOT NULL DEFAULT 0')
      safeAddColumn(db, 'loops', 'cost_budget_usd REAL')
      safeAddColumn(db, 'loops', 'stall_count INTEGER NOT NULL DEFAULT 0')
      safeAddColumn(db, 'loops', 'last_state_hash TEXT')
      safeAddColumn(db, 'loops', 'rolling_summary TEXT')
      safeAddColumn(db, 'loops', 'artifact_dir TEXT')
      safeAddColumn(db, 'loops', 'last_git_sha TEXT')
      safeAddColumn(db, 'loops', 'provider_chain TEXT')
      safeAddColumn(db, 'loops', 'current_provider TEXT')
      safeAddColumn(db, 'loops', 'last_digest_at INTEGER')
    }
  },
  {
    version: 24,
    description:
      'Phase B3 — one-time sweep of orphaned per-conversation children ' +
      '(tool_calls, snip_command_log, snip_events, conversation_rag_attachments) ' +
      'left behind by conversation deletes before the deleteConversation cascade fix',
    up(db) {
      // Runs inside the migration transaction. The sweep only deletes rows whose
      // conversation_id is non-NULL and absent from `conversations` — NULL-parent
      // rows (ephemeral tool calls, global snip entries) are preserved. Going
      // forward, deleteConversation cleans these tables so no new orphans form.
      const swept = sweepOrphanedConversationChildren(db)
      if (swept.length > 0) {
        console.info('[db-migrations v24] swept orphaned conversation children:', swept)
      }
    }
  },
  {
    version: 25,
    description:
      'Loop backlog — drop the status CHECK so the governor 4a held-output state ' +
      "('awaiting-ratification') is accepted; enforce the set via the BacklogStatus TS union",
    up(db) {
      // SQLite can't ALTER a CHECK, so rebuild loop_backlog preserving every row +
      // its next-item index. Idempotent: only rebuild if the old CHECK is present
      // (a fresh install already gets the CHECK-free loop-schema.ts). Mirrors the
      // v19/v20 "drop the brittle CHECK" precedent.
      const exists = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='loop_backlog'")
        .get() as { sql: string } | undefined
      if (!exists || !/CHECK\s*\(\s*status/i.test(exists.sql)) return
      db.exec(LOOP_BACKLOG_REBUILD_V25)
    }
  },
  {
    version: 26,
    description:
      'Home Digest salience attention-state — first-seen (Novelty) + impressions (Decay) ' +
      'ledgers. Idempotent CREATE; new installs also get it via BRAIN_SCHEMA_SQL.',
    up(db) {
      // Same DDL brain-schema.ts now carries (kept in lockstep, mirrors the v21 verdicts
      // precedent). IF NOT EXISTS so a fresh install already at v18+ is a no-op here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS brain_insight_first_seen (
          insight_id    TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS brain_insight_impressions (
          insight_id   TEXT PRIMARY KEY,
          shown_days   INTEGER NOT NULL,
          last_shown_on TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 27,
    description:
      'Foundation 3 — persistent entity graph (entity_nodes + entity_edges with a src/dst ' +
      'neighbour index). The node/edge substrate for write-time relink + retirement cascade; ' +
      'empty tables are inert (WRITES gated by DUIN_ENTITY_GRAPH, which is `!== \'0\'` — default ON, ' +
      'opt-out; see entity-graph-relink.ts:entityGraphEnabled).',
    up(db) {
      // DDL in brain/brain-schema.ts (ENTITY_GRAPH_SCHEMA_SQL) so a node:sqlite integration test can
      // run the exact production statements. IF NOT EXISTS throughout, so a re-run is a no-op — mirrors
      // the v26 salience precedent. Fresh installs also get it here (they run every migration up to
      // LATEST); the tables carry no data, so their existence alone changes nothing at runtime.
      db.exec(ENTITY_GRAPH_SCHEMA_SQL)
    }
  },
  {
    version: 28,
    description:
      'Task & thread control — conversations.closed_at (task `close`/`restore` lifecycle) ' +
      '+ idx_conversations_closed. Idempotent: fresh installs also add the column via ' +
      'schema-init, so this uses a duplicate-column-swallowing add + CREATE INDEX IF NOT EXISTS.',
    up(db) {
      // ALTER TABLE ADD COLUMN is NOT idempotent in SQLite; the fresh-install path
      // (schema-init) already adds closed_at before migrations run, so swallow the
      // duplicate rather than exec the raw TASK_LIFECYCLE_SCHEMA_SQL constant.
      // Mirrors the v11 fork-lineage precedent.
      safeAddColumn(db, 'conversations', 'closed_at INTEGER')
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_closed
          ON conversations(closed_at);
      `)
    }
  },
  // ── Automations + Operational Goals control plane (UA-AUTO, v32-v36) ──────────
  // Ports upstream Lamprey's automations/goals feature ADAPTED under DUIN's governor.
  // Every step is idempotent (safeAddColumn swallows duplicate-column, indexes are
  // IF NOT EXISTS, backfills are guarded).
  //
  // NOTE: this block once claimed 28-31 and 37-42 were "reserved for concurrent
  // workstreams". That reservation was void the moment v43 shipped in the same build
  // (see RELEASED_VERSIONS below) and has been withdrawn.
  {
    version: 32,
    description:
      'UA-AUTO goals lifecycle — operational-goal state machine columns (+13) + ' +
      'legacy-status backfill + lifecycle index',
    up(db) {
      applyOperationalGoalSchema(db)
    }
  },
  {
    version: 33,
    description:
      'UA-AUTO automation_runs — durable idempotency ledger ' +
      'UNIQUE(automation_id,trigger_key,attempt), replacing in-memory lastFiredMinute',
    up(db) {
      db.exec(AUTOMATION_RUN_SCHEMA_SQL)
    }
  },
  {
    version: 34,
    description:
      'UA-AUTO automations trigger taxonomy — trigger_kind/config/next_run/retry ' +
      'columns + wrap-legacy-cron backfill',
    up(db) {
      applyAutomationTriggerSchema(db)
    }
  },
  {
    version: 35,
    description:
      'UA-AUTO automations goal-binding + loop-ceiling columns (goal_id, ' +
      'goal_conversation_id, loop_max_*, loop_token_budget) + goal index',
    up(db) {
      applyAutomationGoalBindingSchema(db)
    }
  },
  {
    version: 36,
    description:
      'UA-AUTO goal-owned loop bridge — goals loop-ownership columns + unique ' +
      'loop-owner index; loops goal back-reference columns + index',
    up(db) {
      applyGoalLoopBridgeSchema(db)
    }
  },
  {
    version: 43,
    description:
      'Proposed-edit CARDs — reviewable/reversible proposed-edit proposals over the workspace ' +
      'patch authority (proposed_edit_proposals + conversation index). DDL in ' +
      'proposed-edit-schema.ts so a node:sqlite test runs the exact production statements; ' +
      'IF NOT EXISTS throughout, so a fresh install (which runs every migration up to LATEST) ' +
      'is a no-op. Empty table is inert until the propose_edit tool writes a card.',
    up(db) {
      db.exec(PROPOSED_EDIT_SCHEMA_SQL)
    }
  },
  {
    version: 44,
    description:
      'Proposed-edit CARDs — bind each proposal to the workspace root it was reviewed ' +
      'against (proposed_edit_proposals.workspace_root). Without it accept re-resolves ' +
      'the relative anchors against the accept-time active workspace and the content-hash ' +
      'drift check cannot tell two roots apart.',
    up(db) {
      // v43 created the table without the column; the fresh-install path now gets it
      // from PROPOSED_EDIT_SCHEMA_SQL, so the ALTER swallows duplicate-column.
      // Existing rows keep NULL and are refused at accept (see proposed-edit-flow).
      addProposedEditWorkspaceRootColumn(db)
    }
  },
  {
    version: 45,
    description:
      'Memory provenance — memory_index.source records where a memory CAME FROM ' +
      '(user-explicit / session / inferred / reflection / imported / unknown), orthogonal to ' +
      '`type`, which records what it is ABOUT. Enables grounding on only what the ' +
      'operator actually stated. Existing rows default to `unknown` and are NEVER ' +
      'back-inferred: guessing provenance from timestamps would manufacture exactly ' +
      'the confidence the column exists to make honest. DDL matches schema-init.ts ' +
      'verbatim (CHECK included) so fresh and migrated DBs cannot drift.',
    up(db) {
      // memory_index is owned by schema-init, not by this registry. In production
      // initLegacySchema runs first, so the table is always present here and the
      // ALTER simply hits duplicate-column (swallowed). But the registry is also
      // run against BARE databases — the migration tests and the gap-repair path —
      // where the table does not exist, and safeAddColumn only tolerates duplicate
      // COLUMN, not missing TABLE. Without this guard the whole chain throws there.
      // Skipping is the correct no-op either way: a DB with no memory_index gets
      // the column from schema-init's CREATE TABLE the moment it makes one.
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_index'")
        .get()
      if (!exists) return
      safeAddColumn(
        db,
        'memory_index',
        "source TEXT NOT NULL DEFAULT 'unknown' " +
          "CHECK(source IN ('user-explicit','session','inferred','reflection','imported','unknown'))"
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_index_source ON memory_index(source, updated_at DESC);'
      )
    }
  },
  {
    version: 46,
    description:
      'Graph-node provenance — entity_nodes.source records WHICH PLANE minted a node ' +
      '(construction / claim / operator / unknown). Property 3 had only ever been applied to ' +
      'FACTS; the graph carried no provenance at all, so its health could not be read. Measured ' +
      '2026-07-31: 3,630 of 5,776 nodes carried kind=entity and the standing reading was "63% ' +
      'carry a defect marker" — but ZERO of those labels also had a properly-kinded node, so they ' +
      'are not duplicates. They are CLAIM-plane nodes for concepts construction never extracted, ' +
      'where there is genuinely no kind to assign. One table, two populations, no way to tell them ' +
      'apart, and a coherence metric that conflated them. Existing rows default to `unknown` and ' +
      'are NEVER back-inferred: guessing a plane from an id prefix would manufacture exactly the ' +
      'confidence this column exists to make honest.',
    up(db) {
      // entity_nodes is owned by brain-schema (v27), not by this registry, and the registry also
      // runs against BARE databases (migration tests, gap-repair) where the table does not exist.
      // safeAddColumn tolerates a duplicate COLUMN but not a missing TABLE, so guard exactly as
      // v45 does. Skipping is the correct no-op: a DB with no entity_nodes gets the column from
      // ENTITY_GRAPH_SCHEMA_SQL the moment it creates one.
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entity_nodes'")
        .get()
      if (!exists) return
      safeAddColumn(
        db,
        'entity_nodes',
        "source TEXT NOT NULL DEFAULT 'unknown' " +
          "CHECK(source IN ('construction','claim','operator','unknown'))"
      )
      db.exec('CREATE INDEX IF NOT EXISTS idx_entity_nodes_source ON entity_nodes(source, kind);')
    }
  }
]

/** The v25 loop_backlog rebuild (CHECK-drop) as a standalone constant so a
 *  node:sqlite test can validate the exact production SQL without the Electron
 *  better-sqlite3 ABI. Preserves every row + the next-item index. */
export const LOOP_BACKLOG_REBUILD_V25 = `
  CREATE TABLE loop_backlog_new (
    id TEXT PRIMARY KEY,
    loop_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  INSERT INTO loop_backlog_new (id, loop_id, position, task, status, result, created_at, started_at, finished_at)
    SELECT id, loop_id, position, task, status, result, created_at, started_at, finished_at FROM loop_backlog;
  DROP TABLE loop_backlog;
  ALTER TABLE loop_backlog_new RENAME TO loop_backlog;
  CREATE INDEX IF NOT EXISTS idx_loop_backlog_next
    ON loop_backlog(loop_id, status, position ASC);
`

/**
 * Most recent migration version. Computed from the registry so it stays in
 * sync with appends.
 */
export const LATEST_VERSION: number = MIGRATIONS.reduce(
  (acc, m) => (m.version > acc ? m.version : acc),
  0
)

// ── The applied-migration ledger (gate finding F3) ───────────────────────────
//
// `PRAGMA user_version` is a single high-water integer, so "has migration N
// run?" was answered as `N <= user_version`. That is only sound while the
// registry is CONTIGUOUS. It is not: `MIGRATIONS` has numbering gaps, and a gap
// exists precisely because a concurrent workstream reserved the block — which
// means a real build could ship the versions ABOVE the gap without the one
// below it. Commit 49ee04eb did exactly that: it shipped v32-v36 without v28.
// A DB migrated by that build stamps 36; the merged build then sees
// `28 <= 36` and skips v28 forever, stranding `conversations.closed_at`
// silently, with no error and no way for the user to notice.
//
// The fix is to stop inferring membership from an ordering test. `user_version`
// stays (it is the crash-safe stamp, and the downgrade guard reads it), but a
// durable per-version ledger now records what ACTUALLY ran. The ledger can only
// ADD work, never remove it: a migration still runs when `version > stamp`
// regardless of the ledger, so hand-lowering `user_version` behaves exactly as
// it always did.
export const MIGRATION_LEDGER_TABLE = 'schema_migrations'

/** Ledger DDL as a constant so a node:sqlite test can run the exact statement. */
export const MIGRATION_LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_LEDGER_TABLE} (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`

/**
 * Registry versions at-or-below `startVersion` that a stamp of `startVersion`
 * does NOT prove ran: the entry immediately below each numbering gap the stamp
 * crosses.
 *
 * A gap in the registry marks concurrent authoring — the block was reserved by
 * another workstream — so the entry just under it is exactly the one a branch
 * build could have shipped past. Entries inside a contiguous run are still
 * proven by the stamp (a build carrying N carries N-1, which was authored
 * before it), so they are NOT re-run: this stays a surgical repair, not a
 * blanket replay of the whole registry.
 */
export function gapStraddledVersions(
  registry: readonly { version: number }[],
  startVersion: number
): number[] {
  const versions = registry.map((m) => m.version).sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; i < versions.length - 1; i++) {
    const here = versions[i]
    const next = versions[i + 1]
    if (here > startVersion || next > startVersion) continue
    if (next !== here + 1) out.push(here)
  }
  return out
}

/**
 * Versions to seed into a freshly-created ledger on a DB that predates it.
 * Everything the stamp proves ran — i.e. everything at-or-below the stamp
 * EXCEPT the gap-straddled entries, which get re-applied once so a
 * skipped-by-gap migration is repaired rather than lost.
 */
export function seedLedgerVersions(
  registry: readonly { version: number }[],
  startVersion: number
): number[] {
  const untrusted = new Set(gapStraddledVersions(registry, startVersion))
  return registry
    .map((m) => m.version)
    .filter((v) => v <= startVersion && !untrusted.has(v))
    .sort((a, b) => a - b)
}

/**
 * The migrations `runMigrations` should execute, in registry order.
 *
 * Run when the version is above the stamp (the original rule, unchanged) OR
 * when the ledger has no record of it. The second clause is what makes a
 * skipped-by-gap migration recoverable.
 */
export function pendingMigrationVersions(
  registry: readonly { version: number }[],
  startVersion: number,
  ledger: ReadonlySet<number>
): number[] {
  return registry
    .filter((m) => m.version > startVersion || !ledger.has(m.version))
    .map((m) => m.version)
}
// Fail at IMPORT, not at some later launch: a registry that can silently no-op is a
// defect in the build, not in the user's data. Deliberately NOT called from
// runMigrations — that would reject a legitimately-swapped registry in a test and,
// more importantly, this is an invariant of the SOURCE, not of any particular DB.
assertMigrationRegistryValid(MIGRATIONS)

/** Result reported by `runMigrations` — for tests + the Persistence panel. */
export interface MigrationResult {
  /** user_version before the call. */
  startVersion: number
  /** user_version after the call. Equals `startVersion` when nothing ran. */
  endVersion: number
  /** Versions that actually executed in this call. */
  applied: number[]
  /**
   * Versions that executed even though they sit at-or-below `startVersion` —
   * migrations a numbering gap had silently stranded (F3). Empty on a healthy
   * DB. Surfaced (and warned about) rather than repaired in silence.
   */
  repaired: number[]
}

/**
 * Read `user_version`, run every migration the ledger has no record of (and
 * every migration above the stamp), in ascending order, each inside its own
 * transaction that also records the version. Returns a structured report.
 *
 * Idempotent: calling twice in a row makes the second call a no-op.
 *
 * Crash-safe: a throw inside any `up(db)` rolls back that migration's
 * transaction (DDL + version stamp + ledger row together). The next launch
 * retries from the same version.
 *
 * Gap-safe (F3): a migration below the stamp that the ledger cannot account
 * for is re-applied and reported in `repaired`, instead of being skipped into
 * oblivion by the old `version <= start` ordering test.
 */
export function runMigrations(db: Database): MigrationResult {
  // `PRAGMA user_version` returns a number in better-sqlite3.
  const start = readUserVersion(db)
  const applied: number[] = []
  const repaired: number[] = []

  // Defensive: a DB carrying a version higher than the code knows about
  // means the user downgraded the app. We refuse rather than risk running
  // older migrations against a newer schema. Checked BEFORE the ledger is
  // touched so a refused run leaves no trace at all.
  if (start > LATEST_VERSION) {
    throw new Error(
      `db-migrations: DB user_version is ${start} but this build only knows ` +
        `migrations up to v${LATEST_VERSION}. Did you downgrade DUIN? ` +
        `Refusing to run — please launch the newer version or restore a backup.`
    )
  }

  const ledger = openLedger(db, start)
  const pending = new Set(pendingMigrationVersions(MIGRATIONS, start, ledger))
  let stamp = start

  for (const migration of MIGRATIONS) {
    if (!pending.has(migration.version)) continue
    const isRepair = migration.version <= start
    if (isRepair) {
      console.warn(
        `[db-migrations] v${migration.version} (${migration.description}) sits at or below ` +
          `user_version ${start}, but a numbering gap in the registry means the stamp cannot ` +
          `prove it ran. Re-applying (idempotent by registry discipline) so a gap-skipped ` +
          `migration is repaired rather than silently lost.`
      )
    }

    // Each migration runs in its own transaction so a partial registry
    // application is still durable: if v3 throws, v2's changes stay.
    const nextStamp = Math.max(stamp, migration.version)
    const tx = db.transaction(() => {
      migration.up(db)
      // Bump the version inside the same transaction. A throw above this
      // line rolls back the DDL; a throw here is theoretically impossible
      // (PRAGMA writes don't fail in practice) but the transaction still
      // covers it. `Math.max` so repairing a below-stamp migration never
      // REWINDS user_version (which would re-run everything above it).
      writeUserVersion(db, nextStamp)
      recordLedgerVersion(db, migration.version)
    })

    try {
      tx()
      stamp = nextStamp
      applied.push(migration.version)
      if (isRepair) repaired.push(migration.version)
    } catch (err) {
      const msg = messageOf(err) ?? String(err)
      throw new Error(
        `db-migrations v${migration.version} (${migration.description}) failed: ${msg}`,
        { cause: err }
      )
    }
  }

  return { startVersion: start, endVersion: readUserVersion(db), applied, repaired }
}

/**
 * Create the ledger if absent and return the set of versions already recorded.
 *
 * On a DB that predates the ledger the table is created and seeded with
 * everything the stamp PROVES ran ({@link seedLedgerVersions}) — the
 * gap-straddled entries are deliberately left out so this call re-applies
 * them once and the strand is repaired.
 */
function openLedger(db: Database, start: number): Set<number> {
  const existed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MIGRATION_LEDGER_TABLE)
  db.exec(MIGRATION_LEDGER_DDL)

  if (!existed && start > 0) {
    const seed = seedLedgerVersions(MIGRATIONS, start)
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ${MIGRATION_LEDGER_TABLE} (version, applied_at) VALUES (?, ?)`
    )
    const now = Date.now()
    const tx = db.transaction(() => {
      for (const v of seed) insert.run(v, now)
    })
    tx()
  }

  const rows = db
    .prepare(`SELECT version FROM ${MIGRATION_LEDGER_TABLE}`)
    .all() as Array<{ version: number }>
  return new Set(rows.map((r) => r.version))
}

function recordLedgerVersion(db: Database, version: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO ${MIGRATION_LEDGER_TABLE} (version, applied_at) VALUES (?, ?)`
  ).run(version, Date.now())
}

function readUserVersion(db: Database): number {
  // better-sqlite3's `pragma` returns either a primitive (when `simple: true`)
  // or an array of rows. We use `simple: true` to get the integer directly.
  const v = db.pragma('user_version', { simple: true })
  if (typeof v !== 'number') {
    throw new Error(
      `db-migrations: PRAGMA user_version returned a non-number: ${JSON.stringify(v)}`
    )
  }
  return v
}

function writeUserVersion(db: Database, value: number): void {
  // PRAGMA writes don't support parameter binding; we inline the integer
  // after asserting it's a safe value.
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`db-migrations: refusing to write invalid user_version ${value}`)
  }
  db.pragma(`user_version = ${value}`)
}

function safeAddColumn(db: Database, table: string, ddl: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`)
  } catch (err) {
    const msg = String(messageOf(err) ?? err)
    if (!/duplicate column name/i.test(msg)) throw err
  }
}
