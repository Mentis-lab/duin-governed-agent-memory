// The COHERENCE MAP — the checked-in, typed seed for the Coherence Health meta-benchmark
// (coherence-health.ts). One row per DUIN loop/subsystem, tracing design-intent → code → runtime.
//
// This is the KEYSTONE STATE the coherence loop reads and rewrites (DUIN_COHERENCE_HEALTH.md §2).
// Unlike the three subsystem benchmarks (Brain / Backend / Compounding Health), which each score ONE
// subsystem's live numbers, this map is the SYSTEM-WIDE wiring ledger: every entry names a subsystem,
// its intended behavior, whether that behavior is actually wired end-to-end at runtime, a concrete
// evidence anchor, the deterministic detector(s) that guard it, and — load-bearing — whether a
// cold/absent state is BY DESIGN (the operator's deliberate gates) or a real defect.
//
// SEED PROVENANCE (this v1 map): extracted from THIS session's three read-only audits —
//   - identity-spine deploy      (memory: duin-identity-spine-deploy.md)
//   - backend hardening          (memory: duin-backend-hardening.md + DUIN_BACKEND_HARDENING_HANDOFF.md)
//   - value-core cold-map        (memory: duin-value-core-coldmap.md + DUIN_VALUE_CORE_HANDOFF.md)
// plus direct code verification in this worktree (branch duin/coherence-health @ 53cead1). Every entry
// traces to a real anchor (a file:symbol and/or a named audit finding). ACCURACY > COMPLETENESS: a
// missing subsystem is fine; a wrongly-stated one poisons the benchmark.
//
// by_design is the honesty pivot (DUIN_COHERENCE_HEALTH.md §2): a COLD_BY_DESIGN subsystem (RSI
// enact gate, whole-note privacy, proof-receipts cold-by-use) is NOT a defect and must NEVER tank an
// axis — the scorer treats byDesign entries as healthy. Only a NON-byDesign cold/dead/gap state is a
// defect. Getting these flags right is the whole point of separating "chosen stance" from "silent rot".

// ──────────────────── the wiring-state vocabulary ────────────────────

/**
 * The runtime wiring state of a subsystem, design→code→runtime:
 * - LIVE               producer→consumer→behavior all connected and turning.
 * - COLD               wired but not turning / not producing (a real, fixable gap — data or a flip away).
 * - WRITTEN_NEVER_READ a store/ledger is written but has no production reader (dead data sink).
 * - SHADOW             computed but never surfaced/consumed (e.g. a UI card that never mounts).
 * - COLD_BY_DESIGN     deliberately not turning — the operator's chosen gate (accept-starvation, privacy). NOT a defect.
 * - GAP                a design edge with no code path yet (a missing loop).
 * - DEAD               an exported symbol / path with no non-test caller (dead code).
 */
export type WiringState =
  | 'LIVE'
  | 'COLD'
  | 'WRITTEN_NEVER_READ'
  | 'SHADOW'
  | 'COLD_BY_DESIGN'
  | 'GAP'
  | 'DEAD'

/** Which of the 4 Coherence Health axes this subsystem PRIMARILY scores into.
 *  (GUARDEDNESS's detector/monitor coverage is measured across the WHOLE map; the guarded-axis
 *  tag marks the subsystems that ARE the guardedness infrastructure.) */
export type CoherenceAxis = 'wiring' | 'intent' | 'guarded' | 'liveness'

// ──────────────────── the map entry ────────────────────

export interface CoherenceEntry {
  /** Stable subsystem name (the key). */
  subsystem: string
  /** What it SHOULD do (the design intent / anchor). */
  designIntent: string
  /** Runtime wiring state (see WiringState). */
  wiringState: WiringState
  /** Concrete evidence: a file:symbol and/or a named audit finding + a live datum. Never empty. */
  evidence: string
  /** The deterministic check(s) guarding this loop — detector or *-monitor names. Empty ⇒ unguarded. */
  detectors: string[]
  /** Which axis this subsystem scores into. */
  axis: CoherenceAxis
  /** TRUE ⇒ a cold/absent state is a DELIBERATE stance (never counts as a defect). */
  byDesign: boolean
  /** Why it is by-design (required-in-spirit whenever byDesign is true). */
  byDesignWhy?: string
  /** The open gap (if any), or a "resolved: …" note for a closed one. */
  gap?: string
  /** Rough leverage rank of closing the gap: 'high' | 'med' | 'low'. */
  leverage?: 'high' | 'med' | 'low'
}

// ──────────────────── the seed (v1) ────────────────────

/**
 * The map's own counts are ASSERTED IN `coherence-health.test.ts`, not written here.
 *
 * This docblock used to carry them by hand ("~27 subsystems … wiring 10, intent 5, guarded 5,
 * liveness 7 … byDesign=true: 3 … states span LIVE / COLD / WRITTEN_NEVER_READ / SHADOW /
 * COLD_BY_DESIGN / GAP"). By 2026-08-03 every one of those numbers was wrong — the map had grown to
 * 42 entries — and three of the six states it named were used by zero entries. Property 6 says
 * claims about ourselves are computed, not typed, and a self-description that miscounts ITSELF is
 * the least defensible place to violate it: the file exists to catch exactly this drift elsewhere.
 *
 * Adding an entry now fails a test until you acknowledge the new total, which is the conscious act
 * the hand-typed summary was reaching for and never got.
 */
export const COHERENCE_MAP: CoherenceEntry[] = [
  // ─────────── WIRING (producer→consumer→behavior connected end-to-end?) ───────────
  {
    subsystem: 'Rule-of-Two session floor (W1)',
    designIntent:
      'A session that has processed untrusted input AND touched secret-class material must not take a state-changing/external action without a human — Meta’s Agents Rule of Two as a tighten-only structural floor across all three gate faces (chat IPC, tool-exec headless core, /agui gate), closing the trusted-afk blanket-allow door for tripled sessions.',
    wiringState: 'LIVE',
    evidence:
      'governance/rule-of-two.ts (legs derive from taint-guard isUntrustedSource + the descriptor risks vocabulary — no new lists). Accrual: tool-exec.ts noteExecutedTool beside markUntrustedResult; ipc/chat.ts post-execution beside the taint mark; agui-dispatch.ts post-allow (main + subagent funnel). Enforcement: tool-exec.ts step 1d (deny), chat.ts rotEscalation → `dangerous` forced re-ask + unattended hard floor, agui-gate.ts third tighten-only composer after the ANS meet (allow→prompt; AFK prompt fail-closes). Flag DUIN_RULE_OF_TWO default ON.',
    detectors: ['rule-of-two.test'],
    axis: 'guarded',
    byDesign: false,
    gap: 'v1 gates only C-contributing actions (reads never blocked, CAP-consistent); A-leg is history-only by design. Adaptive adversarial evaluation of the floor (attacker-moves-second style) is W-future work — the floor forces the human gate, it does not claim detection.'
  },
  {
    subsystem: 'Causal survival credit (W2, earned-in-use promotion bar)',
    designIntent:
      'A survival tick is tenure, not evidence — promotion on the keyed govern path additionally requires sessions where the fact was RETRIEVED into grounding and the graded turn ENDORSED (earned ⊆ observed), killing the co-retrieval credit-theft class (RoMeRL memory-reward trap).',
    wiringState: 'LIVE',
    evidence:
      'personalization-recall.ts RecallCandidate.factId → agui-grounding.ts stages ids with kinds (stageRecalledKinds 4th arg) → recall-efficacy.ts positive grade on a TRUSTED turn → operator-model.ts noteFactEndorsed → converted to earnedSessions[] at the noteSession boundary (same clock as tenure). operator-govern.ts governDecision earnedOk on the juryPass===true branch only (keyless keeps raw survival); epoch-gated (causalCreditEpochMs — legacy probations keep the old rule); govern provenance rows carry earned/observed counts. Flag DUIN_CAUSAL_CREDIT default ON.',
    detectors: ['causal-credit.test'],
    axis: 'wiring',
    byDesign: false,
    gap: 'endorsement staging is in-memory (a restart delays at most one session’s earning — safe direction). Counterfactual ablation replay (retrieve-without-it probe) deliberately deferred to W5 utilization probes, where the probe machinery makes it real instead of half-built here; the decision-time audit row (earned vs observed) ships now.'
  },
  {
    subsystem: 'Per-action reviewer lane (W3, fail-closed)',
    designIntent:
      'A SEPARATE cheap model reviews each action an unattended surface would run — the trusted-afk blanket allow on /agui, and mutating calls on the capability/headless core — catching single anomalous in-distribution actions the rung ladder (standing trust) and the deterministic floors (CAP/taint/Rule-of-Two) structurally cannot see. Tighten-only: critical denies, high prompts (fail-closes AFK), medium/low stand.',
    wiringState: 'LIVE',
    evidence:
      'governance/action-reviewer.ts (reviewAction; injectable llm seam like the govern jury). Wired on THREE unattended faces: agui-gate.ts (verdict.source===posture:trusted-afk allows, with Rule-of-Two profile context), tool-exec.ts step 1e (mutating capability-mode calls), and chat.ts chat-unattended (the L6 provider-failover landing path — loop-controller.ts:808 can switch a loop off duin-brain, so without this hook failover silently exited reviewer coverage). Reads never cost a model call. Polarity split (property 8): keyless/no-model → SKIPPED verdict-stands; staffed-but-failed (error/timeout/parse-miss) → CRITICAL fail-closed. W3.1 hardening: args enter the prompt only inside UNTRUSTED-DATA fences with a persuasion-raises-tier rule (collision-guarded); distinct-family preference via routeDistinctModels(avoid actor provider) on faces that thread actorModel (chat-unattended, headless); keyed verdict cache (TTL DUIN_ACTION_REVIEWER_CACHE_TTL_MS 600s, model-verdicts only, LRU 256); reviewerTelemetry() counters + recent ring; fail-closed deny-storm → recordNotice(watch, dedupKey action-reviewer-storm) at DUIN_ACTION_REVIEWER_STORM_N (5)/rolling hour. tool-exec gained auditDenied(): ALL floor denials on the headless face (capability-miss/CAP/taint/RoT/reviewer) now land on the event spine — they were previously invisible outside the returned string. Flags DUIN_ACTION_REVIEWER default ON, DUIN_ACTION_REVIEWER_CHAT reserved OFF, timeout 5000ms.',
    detectors: ['action-reviewer.test'],
    axis: 'guarded',
    byDesign: false,
    gap: 'Interactive chat face reserved behind DUIN_ACTION_REVIEWER_CHAT; single reviewer, no panel; agui face does not thread actorModel yet (falls back to the extraction route — see agui-gate.ts KNOWN LIMIT note); telemetry is in-process only (no /debug route yet); red-team fixture set vs the live posture rides the eval-profile campaign with the W1 fixture.'
  },
  {
    subsystem: 'Brain API native memory (foreign-agent read/write)',
    designIntent:
      'A foreign agent (Claude Code, Codex, a bridge) reads and writes the operator’s memory as natively as a DUIN chat turn does — one call for everything a turn grounds on, a way to teach a durable claim, and a bounded way to leave a note — while every one of those powers stays inside a grant the operator approved: a read scope, a write scope, an hourly budget, and an audit row per call.',
    wiringState: 'COLD',
    evidence:
      'executive-api/exec-endpoint.ts — duin_context (identity + memoryIndex + ranked beliefs + scoped retrieval in one call, degrading with an explicit beliefsNote rather than an empty list when beliefs.read is absent), duin_teach (om.recordFacts with source FORCED to \'external\' server-side, so isQuarantinedExternal holds it out of every grounding site until a human promotes it — the agent may teach, not self-certify), duin_memory_write (three independent refusals: resolved-path containment, FOUNDATION_FILES basename refusal reusing brain/foundation-files.ts, and a principal provenance stamp; never overwrites without mode:\'append\'). Bounds live on the GRANT, not the call: principal-store.ts scope/writeScope/quota/usage + pathInScope + chargeCall/chargeChars, funnelled through the single guard() wrapper that charges, runs, charges size, and audits (surface \'brain-api\'; query and result SIZE logged, never bodies). COLD, not LIVE: the live registry holds 2 principals (claude-fable-afk, claude-fable-afk-writer, 1 call each) and NEITHER holds memory.write or learning.submit, neither carries a scope or a quota override, and the build carrying these tools is un-deployed as of 2026-08-17.',
    detectors: ['exec-endpoint.test', 'principal-store.test', 'brain-api-native.test'],
    axis: 'guarded',
    byDesign: false,
    gap: 'Turns LIVE on a deploy plus a re-pairing that actually requests the new planes — the two existing principals predate them, so today the write half has no holder. Also open: quota is per-principal only (no estate-wide ceiling), and a very narrow read scope can still return fewer than k hits without saying that the over-fetch cap (k*5, max 100) is what truncated it.',
    leverage: 'med'
  },
  {
    subsystem: 'Brain API operator surface (Connected Agents)',
    designIntent:
      'The human half of the membrane: see which agents are mounted, approve or deny a pairing with the requested planes visible and trimmable, revoke or pause a principal, and edit the scope/quota a grant carries. Every bound the Brain API enforces is chosen HERE, so without this surface the operator holds the authority in name only.',
    wiringState: 'LIVE',
    evidence:
      'src/components/settings/AgentsSettings.tsx, mounted at Settings > Essentials > Agents (SettingsDialog GROUPS, next to Connections/Channels — the third direction of connectivity: something else DRIVING DUIN). Closes a SHADOW found on 2026-08-17: main (ipc/executive.ts, registered at ipc/index.ts:103) and preload (preload.ts:826-842) were both fully wired with ZERO renderer callers, so the pairing notice pointed at a "Connected Agents" screen that had never been built and approval meant calling approvePairing() by hand — which is how both live principals were admitted. The pane does three separable jobs: ADMISSION (approve/deny with per-plane trim-only checkboxes, each plane described in operator language rather than as a vocabulary string), STANDING (pause/resume, permanent revoke behind a confirm, reissue showing the one-time token once), and BOUNDS (read scope, write scope, hourly quota). Bounds needed a new setter — principal-store.updatePrincipalGrant + executive:principals:updateGrant — because those fields were enforced on every call from the day they shipped and had no editor at all.',
    detectors: ['AgentsSettings.test', 'principal-store.test', 'preload-surface-lint'],
    axis: 'wiring',
    byDesign: false,
    gap: 'Approval lives only here, so a pending request is seen in "Needs you" and acted on in Settings. Judged the right split rather than an omission: a security grant should be approved on a surface that shows what is being granted and lets it be trimmed, not behind a one-click button in a notice list — and the 15-minute expiry is harmless because re-requesting is free, which the notice now says. Planes deliberately have no post-approval editor (widening later would grant authority the agent never requested); narrowing is pause/revoke. Still open: no deep link from the notice into the pane, which needs a `settings` kind in the shared duin:// parser.',
    leverage: 'med'
  },
  {
    subsystem: 'Legacy exec-token file (the Brain API bypass)',
    designIntent:
      'Retire the single all-powerful userData/exec-token file in favour of identified principals with plane grants — the estate map’s privilege inversion. While the file exists, whoever can read it holds UNSCOPED exec, which makes the entire principal / plane / scope / quota / audit apparatus advisory rather than binding.',
    wiringState: 'LIVE',
    evidence:
      'IN CODE (D1, 2026-08-17): local-brain/server.ts writes the file ONLY under DUIN_EXEC_TOKEN_FILE=1 and unlinks a stale one when the flag is off, so turning it off actually revokes instead of leaving a readable credential behind; the flag is SET in both launch-env definitions (deploy.cmd + ~/.duin/duin-launch.bat) for one consumer, the out-of-repo Feishu agent-bridge. IN THE RUNNING APP: not yet — the deployed bundle (asar bfa3f32, 16:39) contains ZERO occurrences of DUIN_EXEC_TOKEN_FILE, so the live DUIN still writes the file UNCONDITIONALLY, exactly as it did before the gate was written. Verified by extracting out/main/index.js from the shipped asar and by observing the file itself on disk (73 bytes, 2026-08-17 16:45). The same extraction shows duin_context absent, and the live mount\'s duin_pair enum offers learning.submit with no tool behind it — the grant-without-capability bug the A1 work fixes. A fresh install never sets the flag, so a new downloader gets the principal path only. NOT ANCHORABLE by coherence-map-claims: the producer is in-repo but the CONSUMER is the out-of-repo bridge, so no in-repo reference count can adjudicate this LIVE claim.',
    detectors: ['brain-api-native.test'],
    axis: 'guarded',
    byDesign: false,
    gap: 'The bypass is accepted, not resolved: on THIS machine the scoping work above can be walked around by anything that can read one file. Retiring it = migrating the Feishu bridge to a bridge-kind principal with explicit planes (PLANNING/DUIN_BRAIN_API_NATIVE_MEMORY_SPEC.md, D1), after which the flag comes out of both launchers and the file stops being written anywhere.',
    leverage: 'high'
  },
  {
    subsystem: 'proposeAliasGroups (duplicate-entity surfacer)',
    designIntent:
      'Cluster raw-construction entity labels + PROPOSE near-duplicate groups for human review, AND auto-merge the conservative containment-spine subset unattended (entity-automerge-tick.ts)',
    wiringState: 'LIVE',
    evidence:
      'entity-resolver.ts:267 proposeAliasGroups ← computeAliasCandidatesReport:360 ← GET /debug/alias-candidates (brain-native-routes-2.ts:1158). Was the canonical DEAD export; wired as surfacer in identity-spine P7a (memory duin-identity-spine-deploy).',
    detectors: ['dead-export', 'alias-candidates-route'],
    axis: 'wiring',
    byDesign: false,
    gap: 'resolved (P7a): dead export → live surfacer. Surfaces for review; ALSO auto-merges the subset clearing cosine>=0.9 / <=3 members / lexical containment spine (entity-automerge.ts), writing entity-aliases.json unattended via runEntityAutoMergeTick'
  },
  {
    subsystem: 'seam (promotion → OKF concept materialization)',
    designIntent:
      'On promote, materialize a portable OKF concept .md into <vault>/.brain/memory/; retire it out of the lane on revert/veto/supersede — so learned memory becomes portable, exportable, and retrievable',
    wiringState: 'COLD_BY_DESIGN',
    evidence:
      'concept-materialize.ts (materializeConcept/retireConcept/reconcileConcepts) ← operator-model.ts fireMaterialize in confirmFact(promote) + revertFact/vetoFact/supersedeFact/revertByBindingId(retire) ← main.ts setMaterializeHook(makeMaterializeHook). Routes: POST /debug/materialize-backfill (reconcile) + /debug/export-brain-bundle. Concepts ground via the retrieval carve-out (index-store.ts collectBrainMemoryFiles), excluded from the always-on body-dump (brain-root.ts type:learned skip). Flag DUIN_SEAM_MATERIALIZE is set ON by deploy.cmd (PLANNING/DUIN_SEAM_BUILD_SPEC.md).',
    detectors: ['concept-materialize.test'],
    axis: 'wiring',
    byDesign: true,
    byDesignWhy:
      'Ships ON: deploy.cmd sets DUIN_SEAM_MATERIALIZE=1, and it is also set as a user-scope env var on the operator machine (measured 2026-08-03). The code default remains off — byte-identical when unset — but no shipped install runs with it unset, so describing it as default-OFF understated what is live.',
    gap: 'built 2026-07-24; retire moved OUTSIDE memory/ → .brain/_retired (was leaking back into grounding+retrieval); reconcile sweep repairs any missed-retire drift. Remaining: flip the flag + backfill the ~49 promoted facts, then UI/CLI export packaging.',
    leverage: 'high'
  },
  {
    subsystem: 'feedback-bridge',
    designIntent: 'Route UI feedback into the learning loop as durable signal',
    wiringState: 'LIVE',
    evidence:
      'The drain IS started unconditionally at boot: startFeedbackBridge() (main.ts:1004, stop at 1125) → a periodic best-effort drain (feedback-bridge.ts:458 startFeedbackBridge/drainFeedbackBridge) that reads feedback seeds from the events table and forwards them to the engine /state/* endpoints (single-writer, through the engine lock), staging keyless in userData/feedback-bridge/consumed-seeds.jsonl. Feedback reaches a live consumer (the engine). Map seeded pre-wiring at value-core@53cead1.',
    detectors: ['write-no-read'],
    axis: 'wiring',
    byDesign: false,
    gap: 'resolved: startFeedbackBridge periodic drain wired at boot → feedback forwarded to the engine'
  },
  {
    subsystem: 'RSI proposer/enactor (applyChange seam, ENACT_ENABLED)',
    designIntent: 'Self-improve loop proposes → enacts vetted changes (gate/rollback/ratchet)',
    wiringState: 'LIVE',
    evidence:
      "W2 considerate-RSI (2026-08-21, posture directive): the human-ratify seam is BUILT — below the earned tier the proposer only STAGES (status 'proposed', file untouched, Needs-you card via notices-store; ratifyProposed/dismissProposed in self-improve-loop.ts + rsi:pending/rsi:resolve IPC + NeedsYouPanel buttons are the human limb; the apply write-sink re-checks isConfinedToDuin, R1 2026-08-22); at earned 'auto' (GRADUATE_N ratchet) it applies and leaves an FYI. LIMIT (corrected 2026-08-22): selfImproveEngageTick is wired ONLY into server.ts's KEYLESS turn-end branch (server.ts:1430), not the model-connected twin (the governTick/consolidationTick block ~server.ts:2489). So on any install with a model configured — the live app — the engage tick does NOT fire from a normal chat turn, and RSI staging is dormant there under the default posture (DUIN_RSI_TICK_MS=0, backgroundAutonomy=false). Wiring the model-branch twin is deliberately deferred: that gap is what keeps the tier-'auto' auto-apply path dormant on the live app, and closing it is coupled to the unresolved backgroundAutonomy-bypass posture decision (R3). The old background tick (autonomy+DUIN_RSI_TICK_MS-gated) remains as the opt-in unattended path. rsi-staging.test.ts pins the staging + confinement mechanics.",
    detectors: ['dead-export', 'self-improve-loop.test', 'rsi-staging.test'],
    axis: 'wiring',
    byDesign: false,
    gap: "resolved (W2): the human-ratify seam the operator's [[decision 2026-06-10-accept-starvation]] asked for is now the BUILT shape — staging + ratify UI — rather than an unqualified cold-hold; self-application still requires EARNED tier, and the ratchet accrues verdicts through the ratify path."
  },
  {
    subsystem: 'mergedGraph resolver routing',
    designIntent: 'ALL graph-assembly consumers pass through ONE entity-resolver call (uniform spine)',
    wiringState: 'LIVE',
    evidence:
      'construct.ts getResolvedConstruction() memoized on construction identity; identity-spine P6 (memory duin-identity-spine-deploy) — /graph, color lens, graph-report, snapshot now render RESOLVED ids.',
    detectors: ['identity-spine-parity.test'],
    axis: 'wiring',
    byDesign: false,
    gap: 'resolved (P6): mergedGraph bypass closed'
  },
  {
    subsystem: 'entity→note connectivity edge',
    designIntent: 'Entities carry a "mentions" edge back to their source notes (no orphan islands)',
    wiringState: 'LIVE',
    evidence:
      'build-duin-graph.ts entity→note "mentions" edge (default-on, additive); identity-spine P1 → entityNoteConnectivity 0→1.0 live (memory duin-identity-spine-deploy).',
    detectors: ['brain-health-monitor', 'identity-spine-parity.test'],
    axis: 'wiring',
    byDesign: false
  },
  {
    subsystem: 'entity resolution (annotateEntityKeys / clusterAliases)',
    designIntent: 'Assign stable entityKeys + cluster aliases so ProjectA ≡ 《ProjectA》 across rebuilds',
    wiringState: 'LIVE',
    evidence:
      'value-core P7 incremental blocking entityKey resolution (bounded Σb², local embedder), DUIN_CLAIM_SUPERSESSION default-ON. Was COLD (0 entityKeys in 4821 rows; annotateEntityKeys bailed at MAX_RESOLVE_SUBJECTS=400 — memory duin-value-core-coldmap).',
    detectors: ['claim-supersession-flag', 'threshold-inversion'],
    axis: 'wiring',
    byDesign: false,
    gap: 'entityKey backfill needs a full reindex to populate legacy rows',
    leverage: 'med'
  },
  {
    subsystem: 'corrections → binding-rule drain',
    designIntent: 'Confirmed corrections promote into durable binding rules — on HUMAN confirm',
    wiringState: 'COLD_BY_DESIGN',
    evidence:
      'The loop is WIRED end-to-end + human-gated: learn-native.reflect() clusters corrections (≥MIN_BIND=3) into binding_candidates, invoked in production via scheduleReflect (learn-bridge on feedback delivery), consolidation-trigger, and GET /state/reflect; the human-confirm bind route is live (POST /state/bind-candidate, brain-native-routes-2.ts:687 → bindCandidate → appendBinding → falsifiable checkRecurrence). Corrections sitting at status:new were long read as COLD-START here. That was WRONG, and measured wrong on 2026-07-30: at the old BIND_OVERLAP_MIN=3, 36 of 12,090 comparable pairs passed the pair test but NO cluster ever reached MIN_BIND — 0 binding candidates in 166 corrections, i.e. the gate could not fire at all. Against a median correction of 4 tokens a 3-token intersection demands near-duplicates. Relaxed to 2 (10aa89b): the same stream now yields 4 binding candidates, verified against the live file 2026-07-31. Note also that DUIN never WRITES the status field on a correction: learn-store owns corrections.jsonl as append-only capture, so status transitions were never a signal this loop could produce. Binding candidates are.',
    detectors: ['compounding-health:bindingDrain', 'compounding-health-monitor'],
    axis: 'wiring',
    byDesign: true,
    byDesignWhy:
      "Binding is HUMAN-CONFIRM-gated by design (binding-ledger.ts:4 'nothing auto-binds') — the same propose→human-confirm moat as fact promotion + the RSI enact seam. Auto-draining corrections→bindings would violate it; the surfacer + bind route are wired, it awaits a recurring theme + a human confirm.",
    gap: 'awaits a recurring theme (≥3×) + a human confirm — surfacer + bind route both wired (not a missing wire)',
    leverage: 'med'
  },
  {
    subsystem: 'proof_receipts',
    designIntent: 'Emit verifiable proof-of-work receipts for autonomous actions',
    wiringState: 'COLD_BY_DESIGN',
    evidence:
      'proof_receipts table = 0 rows, never fired; the only writer is the verify_workspace tool, unexercised in personal use (memory duin-value-core-coldmap verification pass).',
    detectors: [],
    axis: 'wiring',
    byDesign: true,
    byDesignWhy: 'Cold-by-USE, not a defect — the sole writer (verify_workspace) is simply not exercised in solo operator use.',
    gap: 'unexercised writer',
    leverage: 'low'
  },
  {
    subsystem: 'operator-fingerprint',
    designIntent: 'Compute an operator taste/style fingerprint and surface it to a consumer',
    wiringState: 'LIVE',
    evidence:
      'FingerprintAxis IS consumed in production: decision-axes.ts ("the single behavior read"), divergence-nudge.ts, operator-divergence.ts, and transfer-ab.ts:169 (blind A/B grader); buildStyleFingerprint served at /state/style-fingerprint (brain-native-routes-2.ts:88). Not shadow — the fingerprint feeds divergence + the A/B grader (map seeded pre-merge from the UI-card-only view).',
    detectors: ['style-fingerprint-route'],
    axis: 'wiring',
    byDesign: false,
    gap: 'resolved: fingerprint consumed by divergence/decision-axes/transfer-ab (a dedicated UI card is a separate, optional surface)'
  },
  {
    subsystem: 'moat-health surface',
    designIntent: 'Surface cold|warming|compounding moat status so coldness is visible + actionable',
    wiringState: 'LIVE',
    evidence:
      'getMoatHealth() now has production readers: self-improve-bench.ts:232 folds moat status into its Compounding axis (surfaced at GET /debug/self-improve-bench), plus GET /state/moat-health (brain-native-routes-2.ts:809). No longer written-never-read (map seeded pre self-improve-bridge merge).',
    detectors: ['moat-health-governed-only', 'self-improve-bench'],
    axis: 'wiring',
    byDesign: false,
    gap: 'resolved (self-improve bridge): moat status consumed by the self-improve benchmark + served on /state/moat-health'
  },

  // ─────────── INTENT-FIDELITY (does code match design intent — no silent drift?) ───────────
  {
    // Added 2026-08-02. An audit found the map had no entry for the agentic retriever AT ALL —
    // not for retrieve-agent, the four ranking stages, HyDE, or the code tool — i.e. the one
    // subsystem that produces every grounded answer was unmapped. Absence is a coverage gap rather
    // than a property-6 violation under this file's own ACCURACY > COMPLETENESS rule, but it is
    // the worst place to have one.
    subsystem: 'agentic retriever (retrieve-agent → four ranking stages)',
    designIntent:
      'Drive a cheap model through read-only tools (grep/glob/readNote/semanticSearch/graphNeighbors/graphExpand) to gather citations, then route them through the four ranking stages rather than bypassing them',
    wiringState: 'LIVE',
    evidence:
      'retrieve-agent.ts:retrieveContext is called from server.ts on every grounded turn when agenticRetrieverEnabled(); measured recall@5 0.316 → 0.431 (+11.6pp), MRR 0.797 → 0.870, any-hit@5 0.815 → 0.938 over 25 probes × 6 replicates (server.ts:~481; measured by the agentic-bypass eval, a private harness that is not shipped in the public tree). The contextOverride bypass of the four stages is gated by DUIN_AGENTIC_RANK_STAGES (default ON).',
    detectors: ['agentic-rank-stages', 'agentic-bypass-eval'],
    axis: 'intent',
    byDesign: false,
    gap: 'The 1-hop neighbour-merge cap was a hardcoded 8 against a pool sized by searchK, so the stage silently no-opped for every searchK >= 8 — two-thirds of the tunable\'s own [3,30] range, while retrieval-tunables.ts urges raising it to 20-30. FIXED 2026-08-02 (server.ts: hits.length + NEIGHBOUR_SLOTS, byte-identical at the searchK=6 default), pinned by neighbour-merge-cap.test.ts. Remaining: searchK itself has never been swept for lookup recall — the sweep optimiser exists and has still never written a config.',
    leverage: 'high'
  },
  {
    subsystem: 'runCode retrieval tool (DUIN_RETRIEVER_CODE)',
    designIntent:
      'Let retrieval COMPUTE over the corpus, not only rank it — counts, modes and argmaxes whose answer exists in no single note — as an ADDITIVE tool, never a replacement for ranked retrieval',
    wiringState: 'COLD_BY_DESIGN',
    evidence:
      'Shipped 2026-08-02 (9bf3521) default ON; reversed to default OFF the same day (8459022) after adversarial review. codeEvalEnabled() === \'1\'. The capability gap is real and structural — the aggregation-arms eval (private harness; its findings are summarised at the top of code-sandbox.ts): stock retrieval 0/18 on counting probes, the same retrieval at searchK=30 with the merge cap fixed ALSO 0/18, a grep+code agent 18/18 — but that 18/18 came from a bespoke eval arm with the state ledgers in scope and 8 turns/30 tool calls, against the shipped notes-only scope at 4/16.',
    detectors: ['code-sandbox-escape-tests', 'retrieve-agent-code'],
    axis: 'intent',
    byDesign: true,
    byDesignWhy:
      'Default-OFF is the honest stance, not drift: the SHIPPED configuration has never been measured (the 18/18 is a more capable proxy at double the budget), the "code hurts lookup" premise was wrong (arm P, same agent minus code, scored 2/6 vs P+ 1/6 — a one-trial delta), the regression check was a null experiment (runCode invoked 0/25), and the cheaper mechanism — giving grep a count mode, since it truncates at 60 matches with no total — was never tried. Property 7 says try that first.',
    gap: 'Earning the default back = measuring retrieveContext ITSELF on aggregation probes, after trying grep-with-a-count. Also open: node:vm bounds CPU but not MEMORY — a verified allocation loop aborts the Electron main process at ~3.4s before the timeout fires, which is the strongest argument for moving execution into a worker or a real isolate.',
    leverage: 'med'
  },
  {
    subsystem: 'graph-expand grounding (DUIN_GRAPH_EXPAND_GROUND)',
    designIntent: 'Offer multi-hop graph-expand grounding as an opt-in path (local, no egress) — NOT the default',
    wiringState: 'COLD_BY_DESIGN',
    evidence:
      'value-core P1 flipped it default-ON on a "+8pp recall@gold" TUNE-corpus claim; that claim did NOT reproduce on the real vault (25 probes / 12,793 chunks / exact KNN): recall@5 0.318 vs RRF-fusion 0.408 (−9.0pp), MRR 0.533 vs 0.636 (−10.3pp), and multi-hop is an exact tie at k=5 / −28.4pp at the production TOPK=12. Reverted to opt-in 2026-07-25 (graph-expand-adapt.ts: DUIN_GRAPH_EXPAND_GROUND === \'1\').',
    detectors: ['default-off-better', 'compounding-health:grounding', 'compounding-health-monitor'],
    axis: 'intent',
    byDesign: true,
    byDesignWhy:
      'Default-OFF is the MEASURED stance, not drift: on a real-sized corpus this path loses to the RRF 2:1 fusion it replaces AND suppresses four downstream ranking stages (graph-neighbour merge, cross-encoder rerank, taste-rerank, claim-freshness) by setting contextOverride. Opt-in via =1.',
    gap: 'root causes known but UNFIXED (out of scope, no measured better values): beta=1.2 > alpha=1.0 promotes weakly-activated reached notes over real BM25 hits, and hubDfCap = max(4, ⌊N·0.4⌋) = 452 at vault scale so the hub brake prunes nothing. Both tuned on 10–20-note corpora. A size-independent hub cap + beta < alpha at scale are the candidates — needs a fresh evaluation before re-enabling.'
  },
  {
    subsystem: 'whole-note grounding, adaptive breadth (DUIN_WHOLENOTE_GROUND)',
    designIntent:
      'Ground on whole notes ONLY when this turn\'s evidence is spread across sources; keep snippets for narrow turns. Per-turn, model-free breadth choice, still behind the P8 egress gate.',
    wiringState: 'LIVE',
    evidence:
      'RUNNING as of 2026-08-17: BOTH launch-env definitions (deploy.cmd + ~/.duin/duin-launch.bat) now set DUIN_WHOLENOTE_GROUND=1 AND DUIN_WHOLENOTE_ALLOW_CLOUD=1, so wholeNoteEgressAllowed returns true for this operator\'s cloud models and the branch at local-brain/server.ts:1547 actually executes. Breadth decision: local-brain/grounding-breadth.ts decideBreadth counts DISTINCT source files among the top hits (window 8, widen at >= 3) and server.ts folds it into `wholeNoteWanted`, so only scattered-evidence turns widen — narrow turns keep snippets. DUIN_WHOLENOTE_ALWAYS=1 restores the unconditional path July\'s +14pp A/B measured. Rationale is measured: bench/longmemeval/RESULTS-2026-08-17.md — DUIN wins BOTH single-session categories (100% vs 90.9%/92.9%) and loses multi-session by 25.9pp, so always-on would trade wins for losses. DEPLOY CONFIRMED 2026-08-17 16:39 (asar bfa3f32, shipped by the skill-shelf lane): the deployed out/main/index.js contains decideBreadth and both breadth env reads, so this is running in the live app rather than waiting on a build. The earlier "takes effect only on a future deploy" caveat is retired — verified by extracting the shipped bundle, not by reading the lane table.',
    detectors: ['P8-wholeNoteEgressAllowed', 'private-grounding-fail-closed', 'grounding-breadth.test'],
    axis: 'intent',
    byDesign: false,
    gap: 'TWO live gaps. (1) UNMEASURED as adaptive: the +14pp figure was measured always-on, and the 3-distinct-source threshold is reasoned from the multi-session deficit, not tuned — re-run the LongMemEval iso harness to test it. (2) PRIVACY POSTURE CHANGED: full note bodies from a vault holding business and personnel material may now egress to cloud providers on spread turns. The operator accepted this explicitly on 2026-08-17 after being shown the semantics; it is bounded by adaptive breadth (only matched notes, only scattered turns) and the 20k per-note cap, and reverts by deleting one line from each launcher.'
  },
  {
    subsystem: 'supersession confidence bar (P7 guard)',
    designIntent: 'Supersession retire-gate confidence bar must sit ABOVE the entity-cluster threshold',
    wiringState: 'LIVE',
    evidence:
      'value-core P7 derived the bar as ENTITY_CLUSTER_THRESHOLD(0.86)+0.06=0.92 with a module-load invariant. Was mis-tuned 0.85 < 0.86 → gate never fired (threshold-inversion; memory duin-value-core-coldmap P7).',
    detectors: ['threshold-inversion', 'module-load-invariant-assert'],
    axis: 'intent',
    byDesign: false,
    gap: 'resolved (P7): bar derived + asserted at module load'
  },
  {
    subsystem: 'decision-window calibration consumption',
    designIntent: 'Route the honest decision-window efficacy rate into a real rerank (not advisory-only)',
    wiringState: 'LIVE',
    evidence:
      'compounding-health-live.ts:137-150 DECISION_WINDOW_CONSUMED=true → calibrationConsumeMode() honest baseline "rerank" (value-core P4). Was the wasted-signal drift: 194 obs read only as an advisory sentence (memory duin-value-core-coldmap defect #3).',
    detectors: ['compounding-health:calibrationMode', 'compounding-health-monitor'],
    axis: 'intent',
    byDesign: false,
    gap: 'clock-self-grading honesty (P4a) still worth a full audit',
    leverage: 'low'
  },
  {
    subsystem: 'metabolism shrink-floor guard',
    designIntent: 'Refuse to persist the claim-ledger only on ABSOLUTE degeneracy, never on a ratio drop',
    wiringState: 'LIVE',
    evidence:
      'value-core P2 reworked the guard to refuse only 0 / ≤2-of-≥20. Was the mis-tuned guard that write-locked the ledger for 2 days (ratio floor 2410 vs real extraction 263 → reconcileLedgerForPersist returned null every tick; memory duin-value-core-coldmap defect #2).',
    detectors: ['frozen-ledger', 'WRITE_SKIP_TAG-alert'],
    axis: 'intent',
    byDesign: false,
    gap: 'resolved (P2): guard now degeneracy-only; frozen ledger persists next tick'
  },

  // ─────────── GUARDEDNESS (each loop protected by a detector + a scheduled monitor?) ───────────
  {
    subsystem: 'Brain Health benchmark + monitor',
    designIntent: 'Score the brain GRAPH (coherence/grounding/freshness/purity) + self-police each rebuild',
    wiringState: 'LIVE',
    evidence:
      'brain-health.ts computeBrainHealth + brain-health-monitor.ts (identity-spine P7b, fires post-persistConstruction, WARNs on regression). GET /debug/brain-health. Live overall ~92 (memory duin-identity-spine-deploy).',
    detectors: ['brain-health-monitor', 'identity-spine-parity.test'],
    axis: 'guarded',
    byDesign: false
  },
  {
    subsystem: 'Backend Health monitor',
    designIntent: 'Operational analog: DB integrity / backup freshness / failure spike / stuck runs, on a clock',
    wiringState: 'LIVE',
    evidence:
      'backend-health-monitor.ts (backend-hardening B2, hourly, failure-isolated). GET /debug/backend-health; ledger backend-health-history.jsonl. Would have caught the 1,539-failure QA runaway (memory duin-backend-hardening).',
    detectors: ['backend-health-monitor'],
    axis: 'guarded',
    byDesign: false
  },
  {
    subsystem: 'Compounding Health benchmark',
    designIntent: 'Score the LEARNING loop (stability/metabolism/compounding/grounding) — the learning-liveness instrument',
    wiringState: 'LIVE',
    evidence:
      'compounding-health.ts computeCompoundingHealth + GET /debug/compounding-health (value-core P0). Baseline overall 20.9 (memory duin-value-core-coldmap). NOW has a DEDICATED scheduled writer: compounding-health-monitor.ts recomputes the benchmark, WARNs on overall/axis regression + a rising unmeasuredCount (an axis going dark), and appends compounding-health-history.jsonl. Wired at the coherence daily tick (main.ts) — refreshed BEFORE coherence rolls it up, so the compounding LIVENESS rollup is now a LIVE number instead of null. Failure-isolated, flag DUIN_COMPOUNDING_HEALTH_MONITOR.',
    detectors: ['compounding-health.test', 'compounding-health-monitor', 'coherence-health-monitor'],
    axis: 'guarded',
    byDesign: false,
    gap: 'resolved: dedicated scheduled compounding-health monitor now writes the history ledger + feeds the rollup (was the map\'s standing gap). Follow-on: also event-trigger it on consolidation completion for sub-daily responsiveness.',
    leverage: 'med'
  },
  {
    subsystem: 'backup coverage (moat JSONs + local-brain.db)',
    designIntent: 'The product MOAT stores are backed up daily from the authoritative copy, atomically',
    wiringState: 'LIVE',
    evidence:
      'backup-runner.ts + moat-backup.ts (backend-hardening B1, DUIN_LOCAL_BRAIN_BACKUP). Was 1-of-~14 stores on a real schedule pre-fix (memory duin-backend-hardening).',
    detectors: ['backend-health-monitor:backup-freshness'],
    axis: 'guarded',
    byDesign: false
  },
  {
    subsystem: 'learning-liveness monitor',
    designIntent: 'A meta-monitor that notices when the compounding/learning loops stop turning',
    wiringState: 'LIVE',
    evidence:
      'coherence-health-monitor.ts — scheduled DAILY (main.ts, first tick +90s then 24h, .unref, stopped in will-quit + headless finally), writes coherence-health-history.jsonl, WARNs via detectCoherenceRegression on any overall/axis drop or a rising deadWiring/driftFlags/frozenCount. IS the learning-liveness monitor: its LIVENESS axis rolls up the compounding benchmark, so a stalled learning loop trips a regression. Closed the GAP that let the 2-day claim freeze go unnoticed (memory duin-value-core-coldmap).',
    detectors: ['coherence-health-monitor'],
    axis: 'guarded',
    byDesign: false,
    gap: 'resolved: Coherence Health monitor is the learning-liveness monitor (scheduled, ledgered, self-policing)',
    leverage: 'high'
  },
  {
    subsystem: 'notes-accumulation liveness monitor',
    designIntent:
      'EVENT-triggered (not clock) watchdog: every N ingested notes, assert the construction/metabolism loops actually advanced on the fresh input',
    wiringState: 'LIVE',
    evidence:
      'notes-liveness-monitor.ts — hooked into notes-watcher.scheduleReindex (fires on ingest, the one signal that keeps ticking while a downstream loop is frozen). Accumulates ingested notes; at threshold (DUIN_NOTES_LIVENESS_THRESHOLD, default 10) reads the construction + coherence/compounding/self-improve heartbeat ledgers, WARNs any stale past its window, and appends notes-liveness-history.jsonl. Complements the DAILY coherence-health-monitor: catches a construction stall THE MOMENT notes pile up on a dead loop, not a day later — the class of freeze (2-day construction stall) the rebuild-completion monitor is structurally blind to (no rebuild ⇒ no event). Pure-fs, flag-gated (DUIN_NOTES_LIVENESS_MONITOR), failure-isolated. 25 unit tests.',
    detectors: ['notes-liveness-monitor'],
    axis: 'guarded',
    byDesign: false,
    gap: 'resolved: event-triggered liveness watchdog closes the frozen-loop-produces-no-event blind spot',
    leverage: 'high'
  },

  // ─────────── LIVENESS (are the loops actually turning — fresh, not frozen/stuck?) ───────────
  {
    subsystem: 'claim-ledger metabolism',
    designIntent: 'The claim/verdict engine advances (fresh ledger, resolving claims), not frozen',
    wiringState: 'LIVE',
    evidence:
      'value-core P2 unfroze it (guard reworked → live 263-from-4821 persists next tick). Was FROZEN since 07-14 10:50 for ~2 days (4821 rows, shrink-floor deadlock; memory duin-value-core-coldmap CRITICAL breakage).',
    detectors: ['frozen-ledger', 'compounding-health:ledgerFreshnessHours', 'compounding-health-monitor'],
    axis: 'liveness',
    byDesign: false,
    gap: 'verdict diversity still low until supersession/JTMS verdicts apply (P7)',
    leverage: 'med'
  },
  {
    subsystem: 'construction rebuild loop',
    designIntent: 'Rebuild converges — does not churn/clobber the entity graph (a 44-entity run must not replace a 260-entity one)',
    wiringState: 'LIVE',
    evidence:
      'value-core P3 batch-failure-gated clobber guard + per-batch retry + failure_ledger + >30% totalEntities-drop monitor. Churns on flaky extraction (deepseek-v4-flash, 1539 failures; memory duin-value-core-coldmap root-cause cluster 1).',
    detectors: ['brain-health-monitor:totalEntities-drop', 'compounding-health:clobberEvents', 'notes-liveness-monitor'],
    axis: 'liveness',
    byDesign: false,
    gap: 'flaky extraction model drives construction churn',
    leverage: 'high'
  },
  {
    subsystem: 'behavioral-efficacy measure pass',
    designIntent: 'Periodically measure each fact\'s behavioral efficacy → feed demotion + govern grant',
    wiringState: 'LIVE',
    evidence:
      'measure-tick.ts scheduled 6h cadence, model-agnostic local-first (value-core P6, flag DUIN_MEASURE_TICK). efficacyCoverage still 0/46 — cold-START, data-limited, not a code gap (memory duin-value-core-coldmap).',
    detectors: ['compounding-health:efficacyCoverage', 'compounding-health-monitor'],
    axis: 'liveness',
    byDesign: false,
    gap: 'efficacy needs n≥20/kind of observations — cold-start (data/time), not a flip',
    leverage: 'med'
  },
  {
    subsystem: 'forecast/calibration Loop A',
    designIntent: 'Forecasts resolve against outcomes and the calibration track record stays fresh',
    wiringState: 'LIVE',
    evidence:
      'The one genuinely compounding measured loop — 204/294 resolved, forecast-track-record.json fresh today (memory duin-value-core-coldmap fast-loop).',
    detectors: ['forecast-resolution'],
    axis: 'liveness',
    byDesign: false
  },
  {
    subsystem: 'promotion funnel (earn/promote)',
    designIntent: 'Provisional facts accrue session-survival → graduate to promoted (honestly earned)',
    wiringState: 'COLD',
    evidence:
      '45/46 facts observedSessions=0; only 1 earned; survivalReady=0 — moat currency accrues on legacy, not the earned-autonomy machinery (memory duin-value-core-coldmap). P5 fixed per-run-nonce topic ids so survival can accrue across restarts.',
    detectors: ['compounding-health:survivalProgress', 'compounding-health:promotionThroughput', 'compounding-health-monitor'],
    axis: 'liveness',
    byDesign: false,
    gap: 'survival needs real sessions (cold-start) + the topicId-collision fix to take effect',
    leverage: 'med'
  },
  {
    subsystem: 'events retention',
    designIntent: 'The events table is pruned on a schedule (bounded growth), ref-preserving',
    wiringState: 'LIVE',
    evidence:
      'value-core P5 events retention (30d/100k, daily tick, ref-preserving). Was UNBOUNDED (~570/day, the store 108k spam rows were pruned from would regrow; memory duin-value-core-coldmap residual).',
    detectors: ['backend-health-monitor:events-anomaly'],
    axis: 'liveness',
    byDesign: false,
    gap: 'resolved (P5): retention tick bounds growth'
  },
  {
    subsystem: 'RAG document ingest',
    designIntent: 'Ingest PDFs/docs into the RAG chunk/vec store for retrieval',
    wiringState: 'LIVE',
    evidence:
      'pdf-parse v1→v2 break FIXED in both loaders (loaders/pdf.ts + loaders/iwork.ts): the module is a `PDFParse` CLASS now, not a callable — the old `require("pdf-parse")(buf)` threw "pdfParse is not a function" (known bug duin-pdf-embed-worker-esm). Verified live: `new PDFParse({data}).getText()` extracts real text from a 34-page vault PDF (8436 chars). RESIDUAL (separate, non-blocking): the bge-small embedder model download fails offline (rag.model.download.failed) so retrieval degrades semantic→lexical — text ingest + lexical search still work; only the vector leg is cold.',
    detectors: [],
    axis: 'liveness',
    byDesign: false,
    gap: 'text ingest resolved (pdf-parse v2); UNGUARDED — no dedicated ingest-liveness monitor yet, and the vector leg awaits an embedder-download path (offline model)',
    leverage: 'low'
  },

  // ─────────── GRADUATED FROM HANDBOOK CATALOG (scouted + adversarially-verified 2026-07-23) ───────────
  // 11 subsystems discovered by the 18-scout mapping pass, confirmed by adversarial refutation
  // (duin-gap-verify: 11 confirmed / 2 partial / 4 refuted). 2 fixed same day (Channel→Foresight,
  // brain-client resolve) enter LIVE; the other 9 are open verified gaps. See handbook-catalog.json.
  {
    subsystem: "Persistent entity-graph substrate (Foundation 3 store)",
    designIntent: "A better-sqlite3 node/edge store (entity_nodes/entity_edges) giving single-node incremental UPSERTs, an O(deg) neighbour index, and reversible retire-not-delete — the substrate an incremental relink and retirement cascade both need.",
    wiringState: "COLD",
    evidence: "Writer and readers share ONE gate: DUIN_ENTITY_GRAPH, which entity-graph-relink.ts:entityGraphEnabled reads as `!== '0'` — DEFAULT ON, opt-out. So writes are LIVE on every install that has not explicitly set =0, and the store fills by default. Anchors: entity-graph-store.ts:upsertNode; entity-graph-store.ts:neighborsOf; reveal-persist.ts:autoRevealPersist (refuses unless entityGraphEnabled()). Consumers are the write-time relink + retirement cascade reading their own writes, plus kg-query.ts behind GET /state/kg-query — which no renderer calls.",
    detectors: ["reveal-persist.test.ts", "entity-graph-relink.test.ts"],
    axis: "wiring",
    byDesign: false,
    gap: "RE-SCORED 2026-08-03: was COLD_BY_DESIGN + byDesign:true on the claim that 'DUIN_ENTITY_GRAPH defaults OFF'. That claim was INVERTED — the flag is `!== '0'`, default ON (brain-schema.ts:91-98 caught this on 2026-07-28 and named this entry as the surviving wrong site; it was never corrected). The byDesign exemption therefore rested on a false premise and was laundering a real gap out of the score twice over: byDesign zeroes an entry out of the defect count (coherence-health.ts:138-139) AND exempts it from coherence-map-claims.test.ts, which declines to adjudicate COLD_BY_DESIGN. The WRITE-GATING branch is genuinely done — autoRevealPersist refuses before revealForSource when the flag is off — but on a default install the flag is ON, so the store fills. STILL OPEN: the only consumers are the relink and retirement cascades reading their own writes, plus kg-query.ts behind a route with no renderer caller; no grounding or UI surface reads the persisted graph back. That branch is a retrieval/UI quality change and this repo's convention is that such a path ships flag-gated until measured better (cf. graph-expand grounding, which was defaulted ON on an unreproduced +8pp bench and reverted to opt-in on 2026-07-25 after measuring −9.0pp recall@5 on the real vault — the cautionary case, not the precedent) — so it is NOT bundled into a wiring fix. Next step if taken: union the persisted graph into mergedGraph() behind the same flag and measure.",
    leverage: "med",
  },
  {
    subsystem: "Grounding staleness fusion + precision eval",
    designIntent: "Down-weight operator facts the learning-metabolism flags as currency-stale in the LIVE grounding block, but ONLY once the staleness signal's measured precision (Wilson-lo over materialized-vs-refuted judge labels) clears a floor — so a valid preference is never buried on weak evidence.",
    wiringState: "COLD",
    evidence: "Down-weight operator facts the learning-metabolism flags as currency-stale in the LIVE grounding block, but ONLY once the staleness signal's measured precision (Wilson-lo over materialized-vs-refuted judge labels) clears a floor — so a valid preference is never buried on weak evidence. Anchors: agui-grounding.ts@313; grounding-eval-live.ts:shouldFuseStaleness@412; grounding-eval-live.ts:scoreStalenessJudged@124; grounding-eval.ts:scoreStaleness@51. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["grounding-eval-live.test.ts","erosion-governs-grounding.test.ts"],
    axis: "liveness",
    byDesign: false,
    gap: "No background tick accrues judged grounding-staleness outcomes, so stalenessTrust is perpetually null on real vaults and the fail-safe gate always chooses full-block (no fusion) — the measured-precision gate is dead weight until an accrual tick exists. — FIX: Add a background accrual tick (e.g. in measure-tick.ts) that periodically runs recordGroundingStalenessOutcomes(vault, outcomesFromScore(await scoreStalenessJudged(activeFacts, (t)=>matchStale(t,topics), createJudgeDeps(selectMeasureModelLocalFirst), now), loadAdjudicatedLabels(vault))) so stalenessTrust accrues samples in production instead of only on the manual /debug/grounding-eval-live POST.",
    leverage: "med",
  },
  {
    subsystem: "Whole-brain transfer A/B litmus (moat-fit)",
    designIntent: "Measure whether operator-2's ACCUMULATED brain (operator block + fingerprint taste + calibration rates) makes model answers fit the operator better than the same model COLD, via a blind, position-randomized preference grader.",
    wiringState: "LIVE",
    evidence: "Runs on a clock and is consumed: transfer-ab-tick (registered in main.ts, daily, due-checked) -> runTransferAB -> transfer-ab-store; self-improve-bench.resolveNamedSkillLift reads the freshest run into the named-skill-lift efficacy slot. Anchors: transfer-ab.ts:runTransferAB; transfer-ab-tick.ts:transferAbTick; transfer-ab-store.ts:recordTransferRun; self-improve-bench.ts:resolveNamedSkillLift. ⚠️ CORRECTED 2026-08-02: this entry used to cite an evaluator run of 2026-07-25 (6/6 with-moat, fitLift 6) as evidence. That run, and every daily run through 07-31, was graded by the CIRCULAR rubric — the judge was handed the grounded arm's own prompt — so it could only come out one way, and CONSTITUTION.md says its numbers must not be cited. Held-out re-measure (2026-08-02): 14 moat / 9 cold / 1 tie, fitLift +5, which is NOT significant (two-sided binomial over 23 non-tie comparisons, p ~ 0.40), against the same circular rubric's 21/3/0 (+18). Records now carry a `rubric` field and self-improve-bench REFUSES a circular run before it checks staleness (transfer-ab-store.ts:rubricOf).",
    detectors: ["transfer-ab.test.ts", "transfer-ab-bench-wiring.test.ts"],
    axis: "liveness",
    byDesign: false,
    gap: "resolved (2026-07-25): transfer-ab-tick runs the litmus daily (due-checked against the recorded history, not just the interval) and transfer-ab-store persists every run — the manual /debug POST records too. self-improve-bench resolves named-skill-lift from the freshest run: the NET lift over decided comparisons (a raw win rate is neutral at 50, which scored a harmful moat positive), honest-null with a stated reason below the sample floor, on an untrustworthy timestamp, or past a 7d staleness cap.",
    leverage: "med",
  },
  {
    subsystem: "Multi-query rewrite",
    designIntent: "Rewrite an under-specified query into 2-3 alternate phrasings via the planner model, retrieve each separately, and union the results with cross-variant RRF.",
    wiringState: "COLD_BY_DESIGN",
    evidence: "Fully wired end to end: ipc/chat.ts supplies planner: makeChatPlanner(model), chat-augmentation runs rewriteQuery per variant and fuses with cross-variant RRF. Anchors: multi-query.ts:rewriteQuery; chat-planner.ts:makeChatPlanner; chat-augmentation.ts (the settings.multiQueryRewrite branch); chat.ts (the augmentForChat call). Inert until the operator turns it on.",
    detectors: ["multi-query.test.ts", "multi-query-wiring.test.ts"],
    axis: "wiring",
    byDesign: true,
    byDesignWhy:
      "settings.multiQueryRewrite defaults OFF (Settings -> RAG toggle): the rewrite buys recall on under-specified queries at the cost of a planner round-trip on EVERY turn, so paying it is the operator's call. Cold here means unchosen, not unwired.",
    gap: "resolved (2026-07-25): ipc/chat.ts passes planner: makeChatPlanner(model) into augmentForChat, so the rewrite fires whenever the operator turns the Settings -> RAG toggle on (it stays OFF by default — the rewrite costs a planner round-trip per turn). Rewrite failure still degrades to single-query retrieval.",
    leverage: "med",
  },
  {
    subsystem: "Workflow journal + resume",
    designIntent: "Append every agent() call to an on-disk journal (promptHash/optsHash/result) so a re-run can replay the longest unchanged prefix from a prior run and only re-execute after the first divergence.",
    wiringState: "COLD",
    evidence: "Append every agent() call to an on-disk journal (promptHash/optsHash/result) so a re-run can replay the longest unchanged prefix from a prior run and only re-execute after the first divergence. Anchors: workflow-journal.ts:appendJournalRecord@1; workflow-runner.ts@291; workflows.ts@191. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["workflow-journal.test.ts"],
    axis: "wiring",
    byDesign: false,
    gap: "The IPC layer never supplies journalDir/resumeFromRunId, so resume-from-prior-run is unreachable in the shipped app despite being built and tested. — FIX: In workflows.ts runInline/run, pass `journalDir: join(app.getPath('userData'),'workflow-journals')` into runWorkflow and forward an optional `resumeFromRunId` from the IPC input (plus a renderer affordance to pick a prior runId).",
    leverage: "med",
  },
  {
    subsystem: "Background-shell aux tools (monitor/list/stop/output)",
    designIntent: "Give the model visibility+control over long-running background shells: shell_monitor (regex auto-stop), shell_list, shell_stop, shell_output (incremental tail), pairing with a future shell_command run_in_background flag.",
    wiringState: "COLD",
    evidence: "Give the model visibility+control over long-running background shells: shell_monitor (regex auto-stop), shell_list, shell_stop, shell_output (incremental tail), pairing with a future shell_command run_in_background flag. Anchors: tool-registry.ts@974; native-aux-tools.ts@16; tool-registry.ts@863. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["native-aux-tools.test.ts"],
    axis: "wiring",
    byDesign: false,
    gap: "shell_command lacks run_in_background, so the model cannot start a background shell for these aux tools to manage — the primary producer of their inputs is missing. — FIX: Add `run_in_background?: boolean` to shell_command's inputSchema and, when true, route to executeShellCommandInBackground and return its processId (giving the aux tools a real producer).",
    leverage: "low",
  },
  {
    subsystem: "Dev-server preview / QA driving family (preview_start/stop/logs/network/snapshot/eval/click/fill/resize)",
    designIntent: "Spawn a dev server, wait for its URL, open it in a tab, and drive it like a tester (capture console+network, snapshot DOM, screenshot, click/fill/resize/eval) as model-callable tools.",
    wiringState: "DEAD",
    evidence: "Spawn a dev server, wait for its URL, open it in a tab, and drive it like a tester (capture console+network, snapshot DOM, screenshot, click/fill/resize/eval) as model-callable tools. Anchors: browser-tools.ts:executePreviewStart@331; browser-tools.ts:executePreviewEval@536; dev-server-manager.ts:spawnDevServer. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["dev-server-manager.test.ts","frontend-qa-tool.test.ts"],
    axis: "liveness",
    byDesign: false,
    gap: "A whole tester-grade preview capability is built and tested but unreachable; frontend_qa reimplements a thin subset (open+screenshot+read) rather than exposing this family. — FIX: Add electron/services/preview-tool-pack.ts registering native descriptors for preview_start/stop/logs/network/snapshot/inspect/eval/screenshot/fill/click/resize wired to the existing executePreview* functions, then add `import './preview-tool-pack'` to tool-packs.ts (the missing T2:C1 descriptor registrations).",
    leverage: "med",
  },
  {
    subsystem: "Channel → Foresight bridge (two-brain merge)",
    designIntent: "Turn LLM-extracted channel commitments/decisions/events into foresight streams + anchors written to channel-futures.jsonl / channel-anchors.jsonl, so a connected channel produces real forecasts — the on-ramp payoff.",
    wiringState: "LIVE",
    evidence: "Turn LLM-extracted channel commitments/decisions/events into foresight streams + anchors written to channel-futures.jsonl / channel-anchors.jsonl, so a connected channel produces real forecasts — the on-ramp payoff. Anchors: channel-foresight-live.ts:refreshChannelForesight@16; channel-foresight-sync.ts:bridgeChannelForesight@31; channel-foresight-bridge.ts:extractedToStreams@23. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["channel-foresight-bridge.test.ts","channel-foresight-sync.test.ts"],
    axis: "wiring",
    byDesign: false,
    gap: "resolved (2026-07-23): refreshChannelForesight now called in notes-watcher.scheduleReindex on every ingest (imported from brain/channel-foresight-live), best-effort with its own catch; connector/channel docs re-derive live anchors+futures. Verified: typecheck + 18 module tests green.",
    leverage: "high",
  },
  {
    subsystem: "Safe-undo action ledger",
    designIntent: "Record every applied Tier-B graduated action with a content snapshot + inverse spec so a human undo can revert it AND emit a demote signal that tightens future autonomy.",
    wiringState: "LIVE",
    evidence: "Has a production PRODUCER: self-improve-loop.applyChange records an action (fixed Tier-B actionKind, prior-content snapshot, restore-file inverse) against the seeded rsi-tunable-apply capability before every autonomous write, so POST /state/undo has real actions and revertAction's demote signal can fire. Anchors: action-ledger.ts:recordAction; action-ledger.ts:revertAction; self-improve-loop.ts:applyChange; capability-ledger.ts:RSI_APPLY_CAP_ID; brain-native-routes-2.ts (the /state/undo route).",
    detectors: ["action-ledger.test.ts", "self-improve-undo-wiring.test.ts", "self-improve-undo-failsafe.test.ts"],
    axis: "wiring",
    byDesign: false,
    gap: "resolved (2026-07-25): self-improve-loop.applyChange — DUIN's only autonomous graduated file-write — calls recordAction before each write against the seeded rsi-tunable-apply capability, so POST /state/undo has real actions and a human undo fires the demote. Prior content is null (not '') for a first write, so the inverse DELETES rather than restoring an empty file. Open follow-up: the RSI's own automatic rollbackChange does not close the record, so an auto-reverted change stays undoable — a second undo is a near-no-op restore that also demotes (tightens only).",
    leverage: "med",
  },
  {
    subsystem: "Owned-concept brain write client (brain-client.ts)",
    designIntent: "The single sanctioned path for owned-concept writes - resolveOwed / recordInsightVerdict / recordPredictionVerdict via the Electron window.api.brain preload bridge - built to kill the 2026-06-30 wrong-brain (read-brain != write-brain) bug class.",
    wiringState: "DEAD",
    evidence: "Built to kill the 2026-06-30 wrong-brain (read-brain != write-brain) bug class. Anchors: brain-client.ts:resolveOwed@71; brain-client.ts:BrainUnavailableError@42; brain-client.ts:brainWritesAvailable@87. NOT WIRED: verified 2026-07-30 that `src/duin/lib/brain-client.ts` is imported by exactly ONE file — its own test. All four exported writers (resolveOwed / recordInsightVerdict / recordPredictionVerdict / brainWritesAvailable) have zero production callers.",
    detectors: ["brain-client.test.ts"],
    // axis moved guarded -> wiring 2026-07-30. The state was corrected to DEAD earlier the same
    // day with the claim that it "correctly scores against the wiring axis" — it did not:
    // scoreWiring filters to entriesForAxis(map,'wiring'), so a DEAD entry tagged `guarded` is
    // excluded from liveFraction AND from the deadWiring count. The correction was prose-only and
    // the gap stayed exactly as hidden as before. The defect being recorded here IS a wiring
    // defect (a write path with no consumer), and guardedness coverage is measured across the
    // WHOLE map regardless of this tag (see the CoherenceAxis docstring), so moving it costs no
    // guardedness signal and buys the wiring penalty it should always have carried.
    axis: "wiring",
    byDesign: false,
    gap: "OPEN (corrected 2026-07-30, was wrongly marked resolved): this entry claimed 'DecisionsPanel.doResolve routes through resolveOwed', but doResolve was deleted on 2026-07-27 with the hand-resolve menu, and its last remnant (the mislabeled Resolve dropdown) went on 2026-07-30. Nothing anywhere imports brain-client. So the sanctioned write path exists, is tested, and is unadopted — every write still goes through the legacy /state/* fetches it was built to replace. That is a real gap, and marking it LIVE hid it from the very check meant to surface it. Do not delete the module: the gap is adoption, not the design.",
    leverage: "high",
  },
  {
    subsystem: "How-You-Decide style-fingerprint surface (how-you-decide + card + fetchStyleFingerprint)",
    designIntent: "Present the operator's decision-style fingerprint - lean phrases, axis bars, divergences, silence line - driven by the brain's StyleFingerprint.",
    wiringState: "DEAD",
    evidence: "Present the operator's decision-style fingerprint - lean phrases, axis bars, divergences, silence line - driven by the brain's StyleFingerprint. Anchors: how-you-decide.ts:leanPhrase@31; how-you-decide.ts:visibleAxes@56; how-you-decide-card.tsx; state.ts:fetchStyleFingerprint@109. [graduated from handbook catalog; adversarially verified 2026-07-23]",
    detectors: ["how-you-decide.test.ts"],
    axis: "liveness",
    byDesign: false,
    gap: "how-you-decide-card is never mounted; StyleFingerprint is fetched by no live surface. — FIX: In brain-shell.tsx add `import { HowYouDecideCard } from '@/duin/components/views/how-you-decide-card'` and render `<HowYouDecideCard />` in a mounted view/right-rail (endpoint + data path already live).",
    leverage: "med",
  }
]
