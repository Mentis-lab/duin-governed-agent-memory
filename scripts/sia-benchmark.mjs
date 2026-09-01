#!/usr/bin/env node
// sia-benchmark — the deterministic INSTRUMENT for "DUIN vs the self-improving-agent frontier".
//
// Per DUIN/Rules/f-instrument-and-judgment: the score is un-gameable — every activatable sub-axis
// is a PREDICATE OVER THE CODE (grep/file), so a number only moves when the code actually moves.
// Working-but-graded sub-axes carry a fixed VERIFIED baseline (from the 2026-07-17 8-agent
// code-grounded + adversarially-verified pass). Activatable sub-axes flip from their current
// (absent) score to a target (present) score the instant the mechanism lands in the code.
//
// Run:  node scripts/sia-benchmark.mjs          (scorecard)
//       node scripts/sia-benchmark.mjs --json    (machine)
// The whole point: you cannot raise the overall without building a real mechanism a probe detects.
//
// ── THE LOOP (per DUIN/Rules/f-instrument-and-judgment) — how an activation earns its points ──
//   0. SECOND-BRAIN FIT GATE (first, non-negotiable). The activation must serve DUIN's second-brain
//      design — per-operator judgment/memory/retrieval/governance-over-the-brain — NOT a generic
//      coding-agent harness. Reject or reshape anything generic: e.g. the loop's verify-gate checks
//      BRAIN outputs (a memory write didn't corrupt the store, a digest cites real notes) via the
//      brain-health/coherence-lint detectors, not `npm run build`. See DUIN_SECOND_BRAIN_DESIGN.
//   1. Pick the binding constraint = the open activation with the highest lift that passes gate 0.
//   2. BUILD the real mechanism (in DUIN's grain: reuse operator-model / claim-metabolism /
//      brain-graph / calibration substrates — graft, don't bolt on a parallel system).
//   3. TEST ROUND (before any commit): (a) typecheck; (b) run the touched vitest suites + add a
//      unit test proving the mechanism fires; (c) re-run THIS instrument — the probe must flip and
//      the axis must rise; (d) confirm no regression in the full suite vs baseline.
//   4. ADVERSARIALLY VERIFY (default "not proven"): a fresh agent tries to REFUTE the gain — is the
//      mechanism actually wired + load-bearing, or a dead call the probe happened to match? Only a
//      CONFIRMED gain is kept; a refuted one is reverted (as happened to the 48→65→51 averted fix).
//   5. GATE, then COMMIT; isolate the irreversible step (never flip a safety flag to game a score —
//      RSI enaction / autonomy axes rise only when the SAFE mechanism is built, never by arming).
//   6. COMPOUND: if a verified finding reveals a new checkable property, add a probe here.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVC = join(ROOT, 'electron', 'services')

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf-8') } catch { return '' }
}
// Strip // line-comments and /* */ block-comments so a term mentioned in a comment/docstring
// does NOT count as "wired". (A comment is intent, not a mechanism — the instrument must not
// reward it.) Also strips the trigger-token doc-comments that caused false positives.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
// Recursively grep a directory for a regex over de-commented source, excluding *.test.* files
// (tests don't count as "wired") and optionally a symbol's own defining file (a definition is
// not a caller — the reinforce-arm probe must find a USE, not the function body).
function grepProd(dir, re, { includeTests = false, excludeFile = null } = {}) {
  let hit = null
  const walk = (d) => {
    let ents
    try { ents = readdirSync(d) } catch { return }
    for (const e of ents) {
      const p = join(d, e)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isDirectory()) { if (e !== 'node_modules') walk(p); if (hit) return; continue }
      if (!/\.(ts|mjs|cjs|js)$/.test(e)) continue
      if (!includeTests && /\.test\.|\.golden\.|\.spec\./.test(e)) continue
      if (excludeFile && e === excludeFile) continue
      let txt
      try { txt = stripComments(readFileSync(p, 'utf-8')) } catch { continue }
      const m = re.exec(txt)
      if (m) { hit = { file: p.slice(ROOT.length + 1).replace(/\\/g, '/'), sample: m[0].slice(0, 60) }; return }
    }
  }
  walk(dir)
  return hit
}
const hasCode = (rel, re) => re.test(stripComments(read(rel)))
const has = (rel, re) => re.test(read(rel))

// A baseline sub-axis: fixed VERIFIED score (working machinery; not the lever we're pulling).
const base = (id, score, note) => ({ id, kind: 'baseline', score, note })
// An activatable sub-axis: absent→present flip driven by a code predicate.
const act = (id, absent, present, probe, note) => ({ id, kind: 'activatable', absent, present, probe, note })

// ── The instrument: 10 axes, ~35 sub-axes. Activatable probes encode the "activation moves". ──
const AXES = [
  ['Capture', [
    act('capture.surprise-trigger', 45, 68,
      () => grepProd(join(SVC, 'brain'), /surpriseGate|predictionErrorTrigger|noveltyGate|shouldCaptureFact/),
      'capture gated by surprise/prediction-error, not fire-on-every-turn'),
    act('capture.contrast-extraction', 55, 72,
      () => grepProd(join(SVC, 'brain'), /contrastPair|goodVsBad|contrastiveAbstraction|diffTraces/),
      'extraction contrasts a good vs bad trace (MetaEvo CDA)'),
    // Present=70 not 75: adversarial verify (2026-07-17) confirmed the mechanism is real + governable,
    // but it fires only on positives carrying a DISTILLED RULE — a bare "yes, keep doing that" has no
    // rule to govern and correctly stays a success-miner exemplar. So it closes the rule-bearing half
    // of the asymmetry, not all of it. (Honest recalibration per f-instrument-and-judgment.)
    act('capture.positive-governed', 57, 70,
      () => (hasCode('electron/services/local-brain/endorsement-fact.ts', /source:\s*['"]operator['"]/) &&
             hasCode('electron/services/local-brain/brain-state-routes.ts', /endorsementFact\s*\([\s\S]{0,40}recordFacts|recordFacts\([\s\S]{0,40}endorsementFact/)) ||
             /recordFacts|seedFacts|promoteFact/.test(read('electron/services/brain/success-miner.ts'))
             ? { file: 'endorsement-fact + handler', sample: 'positive→governed' } : null,
      'endorsements mint governed operator facts (candidate→promote→govern), not only exemplars'),
  ]],
  ['Store.validity', [
    // 61→65 (2026-07-19, SIA Stage 2 — reasoning-trace cascade; adversarially graded +4, docked from +6:
    // coarse counting/no semiring, latent until folds+retractions coincide on a keyed vault, and the
    // human-confirmed protection deliberately limits reach — a promoted rule whose support fully collapses
    // is left standing; NO over-retraction defect found). The F3 entity-graph cascade (default-OFF,
    // discounted) is now JOINED by an ALWAYS-ON derivation cascade over the GOVERNED operator store:
    // retiring a premise (supersedeFact / vetoFact) walks the verified Stage-1 DEPENDS_ON edges and
    // invalidates the derived rules that lose their LAST support — foundational belief-base contraction /
    // ℕ-semiring counting (Doyle JTMS 1979 / de Kleer ATMS 1986 / DRed), with alternate-derivation
    // survival (no over-deletion), human-confirmed rules PROTECTED (no auto-retract of earned facts),
    // missing/evicted premises treated as live (eviction ≠ retraction), recursive propagation with a
    // visited-guard (terminates on any graph), and bi-temporal SOFT-delete (invalidatedAt/invalidatedBy —
    // the audit still walks why a rule fell). Frontier: derivation-dependency cascade nobody ships in LLM
    // agent memory (production = newest-wins contradiction supersession; the 2026 cluster re-imports TMS —
    // see PLANNING/DUIN_SIA_REASONING_TRACE_FRONTIER.md). Not higher: coarse (no semiring polynomial /
    // graded cascade / re-derivation of alt-support beyond the counting check), latent until folds +
    // retractions run on a keyed vault. Un-gameable: the pure cascade core + a real cross-file caller on
    // the RETRACTION path (not the def), on top of the existing F3 entry.
    // STAYS 65 (2026-07-19). A "Stage 6" claiming 66 for how-provenance polynomials + a graded cascade
    // was BUILT and then REFUTED by adversarial grade — recorded here because the refutation is more
    // instructive than the attempt. It shipped a SECOND cascade implementation that claimed equivalence
    // with cascadeTargets; the grader found five classes of disagreement, all OVER-retraction, the worst
    // being a truncated polynomial killing a fact with ten surviving justifications. The builder's own
    // equivalence fuzz was blind BY CONSTRUCTION (every fact 'candidate', strict DAG, no empty edges), so
    // the failure classes were exactly its generator's complement. The module was then reworked so the
    // polynomial NEVER decides death — cascadeTargets stays the single authority and the polynomial is
    // purely additive (erosion reporting only) — which removes the disagreement surface by construction
    // rather than patching cases. Was 65 because what remained was a govern-audit READ surface that no
    // gate consumed (the Stage-3 dock precedent), on top of the reasoning-trace line's latency.
    // 65 → 66 (2026-07-20): THE CONSUMER LANDED, on exactly the terms this dock specified — erosion now
    // DECIDES. buildOperatorBlock demotes a majority-eroded rule out of "Rules the operator confirmed
    // (follow these)" into the weigh-lightly treatment measured no-lift already produces, mirroring the
    // Stage-3 recovery (reliability gating the same function) that this note named as the way to earn it.
    // Un-gameable: the detector requires `isEroded` to appear in the isDemoted DECISION itself, so a dead
    // helper or another read surface satisfies nothing. Graded honestly at +1, NOT more: the decision is
    // one threshold on a support COUNT feeding one prompt section — real governance, but not the
    // review-queue routing or the reliability-weighted re-derivation the fuller dock would want, and the
    // underlying edge population is still thin on the live store (0 dependsOn as of this build, so the
    // consumer is correct-but-latent there exactly as the Stage-1 verifier was). Keyed on support count
    // rather than trust delta because the module's MAX rule moves trust by zero on a non-argmax loss.
    act('store.cascade-invalidation', 55, 66,
      () => (hasCode('electron/services/brain/entity-graph-relink.ts', /(?:cascadeInvalidate|barrierRepair)\b/) &&
             grepProd(join(SVC, 'brain'), /syncGraphFromConstruction\s*\(/, { excludeFile: 'entity-graph-relink.ts' }) &&
             hasCode('electron/services/brain/derivation-cascade.ts', /export function cascadeTargets/) && // the always-on derivation cascade core (pure)
             grepProd(join(SVC, 'brain'), /cascadeTargets\s*\(/, { excludeFile: 'derivation-cascade.ts' }) && // wired outside its def (operator-model)
             hasCode('electron/services/brain/operator-model.ts', /supersedeFact[\s\S]*?cascadeInvalidateDerived/) && // fired on the retraction path
             // Stage 6's CONSUMER: erosion must participate in the demotion DECISION, not merely be
             // computed. A read surface, a dead helper, or an unused import satisfies none of these.
             hasCode('electron/services/brain/operator-model.ts', /const isDemoted[^\n]*isEroded\s*\(/) &&
             hasCode('electron/services/brain/operator-model.ts', /supportErosion\(\)[\s\S]{0,900}?supportAfter\s*<=\s*[\s\S]{0,80}?EROSION_DEMOTE_RATIO/))
            ? { file: 'entity-graph tick sync + governed-store derivation cascade + erosion-governed grounding', sample: 'F3 cascade + always-on DEPENDS_ON foundational cascade + Stage-6 erosion demotion' } : null,
      'F3 entity_edges cascade (default-OFF, discounted) JOINED by an always-on DERIVATION cascade over the governed store: retiring a premise walks the verified DEPENDS_ON edges + invalidates rules that lose their last support (foundational counting, alternate-derivation survival, human-confirmed protected, bi-temporal soft-delete), AND the Stage-6 graded half now GOVERNS: a majority-eroded rule is demoted out of confirmed-grounding into weigh-lightly (support-count keyed, approximate readings excluded, nothing retracted). Frontier TMS/DRed move; 67 not higher — still coarse counting, one threshold into one prompt section, and edge population is thin on the live store'),
    act('store.implicit-conflict-live', 55, 73,
      // 70→73 (2026-07-18, Phase-B; adversarially graded +3, docked from +4): the staleness fusion is
      // no longer a bare default-on flag — the LIVE grounding path now GATES it on the MEASURED
      // precision of the grounding-staleness domain (agui-grounding calls stalenessTrust +
      // shouldFuseStaleness; under-sampled/low-precision ⇒ no fusion, fail-safe). This closes the "no
      // govern consumer yet" cap. NOT +4: the grounding-staleness ledger is currently fed only by the
      // judge-keyed /debug/grounding-eval-live route (no background accrual tick yet), so on a keyless/
      // un-exercised vault the gate correctly defaults to no-fusion rather than governing on live-
      // accruing evidence. Earning +4 needs a metabolism-tick accrual of the judged eval (follow-up).
      // Un-gameable: requires the live-path consumer (stalenessTrust( IN agui-grounding.ts), not only
      // the debug route's scoreStalenessJudged/recordGroundingStalenessOutcomes.
      () => (has('electron/services/local-brain/agui-grounding.ts', /DUIN_FUSE_STALENESS\s*(?:!==|===)\s*['"]0['"]/) &&
             hasCode('electron/services/local-brain/agui-grounding.ts', /shouldFuseStaleness\s*\(\s*stalenessTrust\s*\(/) &&
             grepProd(join(SVC, 'local-brain'), /scoreStalenessJudged\s*\(/, { excludeFile: 'grounding-eval-live.ts' }) &&
             grepProd(join(SVC, 'local-brain'), /recordGroundingStalenessOutcomes\s*\(/, { excludeFile: 'grounding-eval-live.ts' }))
            ? { file: 'agui-grounding gated on measured precision', sample: 'staleness fusion gated by grounding-staleness Wilson-lo' } : null,
      'implicit-conflict staleness live but GATED on the grounding-staleness calibration precision (Wilson-lo floor) on the live path — the measured signal now governs the real grounding decision, not a bare flag; fail-safe when under-sampled'),
  ]],
  ['Store.provenance', [
    // 80→84 (2026-07-19, SIA Stage 1 — reasoning-trace provenance; adversarially graded +4, docked from
    // +5). The noted gap "reasoning-trace not joined" is closed: beyond source/govern/binding/supersede
    // lineage, a consolidation/reflection FOLD
    // (many input claims → one higher-order rule) now records a DEPENDS_ON edge on the folded rule naming
    // the input-claim ids it was derived from, INDEPENDENTLY NLI-verified — the fold model's own "why" is
    // testimony not proof (Turpin 2023 arXiv:2305.04388; Chen/Anthropic 2025 arXiv:2505.05410, reveal
    // rate <20%), so a cross-call entailment check re-verifies it (abstain→unverified, never a false
    // 'entails'). buildGovernAudit JOINS each edge's depends_on ids back to their claim TEXT, so the audit
    // walks WHY a rule exists (the input claims + the verdict), not only what links to it. Grafted onto
    // the OperatorFact record the audit already walks (no sqlite/flag). 85 not higher: Stage 1 is
    // capture + verify + walkable audit only — NO cascade-invalidation (Stage 2, composes with F3) and no
    // bi-temporal/semiring layer. DOCKED to +4 (not +5): the headline differentiator — INDEPENDENT NLI
    // verification — is capable-but-latent (a keyless vault records every edge verdict:'neutral',
    // verifier:null → UNVERIFIED); what ships live-by-default is capture + the walkable audit join, and
    // the verifier is a single uncalibrated entailment call, not a reliability curve. Un-gameable: the
    // edge TYPE + field + the audit JOIN + a real prod caller of recordDerivedFact + the NLI verifier
    // module + the fold's independent verify call — a dead symbol satisfies none.
    // Stage 3 (2026-07-19): +the TRUST SEMIRING. The same DEPENDS_ON graph is now reinterpreted under a
    // confidence semiring (Provenance Semirings, PODS 2007) to compute a calibrated `reliability` per
    // fact, CAPPED by source tier so a fluent rule over a junk premise can't launder itself high:
    // reliability = min(provenance_tier, content_score) (arXiv:2606.22030 poisoning defense). Trust flows
    // only through CHECKED derivations — a verified 'entails' earns its NLI score, an unverified edge is
    // only neutral, 'contradicts' near-zero — making the faithfulness constraint QUANTITATIVE. Surfaced in
    // buildGovernAudit + queryable (factReliability) + CONSUMED: buildOperatorBlock SUPPRESSES a
    // poison-suspect derived candidate (reliability < TRUST_FLOOR 0.35) from grounding — closing a real
    // laundering gap the source-tag quarantine misses (a fold relabels its source 'machine', hiding an
    // external premise underneath; the trust semiring sees the ≤0.3 cap and gates it). So reliability is a
    // GOVERNOR that changes the grounding decision, not just an audit number. Additive: it does NOT change
    // the Stage-2 cascade's binary safety floor. 88 not higher: min/product point-semiring (no
    // distributional bounds / learned weights), latent until folds run keyed.
    // Stage 5 (2026-07-19): +DISTRIBUTIONAL BOUNDS + a LEARNED verifier weight — the two gaps the Stage-3
    // note itself named ("min/product point-semiring, no distributional bounds / learned weights"). The
    // Stage-3 point silently assumes the NLI verifier is INFALLIBLE: a verified 'entails' edge contributes
    // its raw score as though the check were certain, which the frontier survey explicitly warns against
    // (§3 "NLI is strong-but-fallible — budget for verifier error"). Stage 5 evaluates the SAME derivation
    // graph a second time over an INTERVAL semiring (every quantity [lo,hi]; min/max/× are monotone so
    // endpoints propagate soundly), where the spread is set by the verifier's OWN MEASURED precision — a
    // Wilson-95 interval over live human promote/veto adjudications (verifierCalibration), so the
    // hardcoded trust constants stop being assumptions and become measurements. Width therefore encodes
    // EVIDENCE QUANTITY (Evidence-Supported Bounds): narrow once the verifier is well observed, honestly
    // wide while it is not. SAFETY BY CONSTRUCTION: hi <= the Stage-3 point for every fact (an unmeasured
    // verifier reproduces the point exactly as its ceiling; evidence of fallibility can only pull DOWN;
    // an unverified edge widens DOWNWARD only, so being unchecked never earns more trust than being
    // checked) — hence every consumer is TIGHTEN-ONLY and the binary TRUST_FLOOR gate is left untouched.
    // CONSUMED: all three grounding block sections are positionally capped, so scarce slots are awarded by
    // ESTABLISHED trust (the conservative lower bound) instead of enumeration order — a weakly-evidenced
    // fold can no longer crowd out a well-established fact by being listed first. Deliberately a strict
    // no-op unless the cap binds (byte-identical grounding otherwise), and it only reorders within the
    // already-gated set — it can admit nothing. 93 not higher: the interval is propagated but not yet a
    // full semiring POLYNOMIAL (no monus/negation, no graded cascade — the cascade's safety floor stays
    // binary), and the learned weight sharpens only once ~20 human adjudications accrue (cold ⇒ the honest
    // prior, though lower-bound RANKING is live immediately since unverified edges rank below verified
    // ones from the first turn). Un-gameable: the interval core + a real cross-file caller + the learned-
    // weight reader + the ranking CONSUMER on the block path — a dead symbol satisfies none.
    // GRADED 91, docked from the claimed 93 across TWO adversarial rounds (both docks stated, not buried):
    //   −1 LATENCY, and it is more severe than Stage 1/3's "capable but latent". On the live store (52
    //     facts) ZERO carry a dependsOn edge, so verifierCalibration is {0,0} ⇒ COLD_VERIFIER ⇒ hi ===
    //     point for every fact; and each block bucket (candidate 6 / provisional 14 / promoted 4) sits
    //     under MAX_BLOCK_LINES 40, so rankByEstablishedTrust returns the array unchanged. Stage 5
    //     currently degenerates to the IDENTITY of Stage 3 on real data. It becomes live when folds
    //     actually mint edges — the same precondition the whole reasoning-trace line waits on.
    //   −1 the learned weight is an ADJUDICATION signal, not the purely-human one first claimed:
    //     'provisional' has three writers (promoteFact human, seedFacts machine, applyBoundRule), so a
    //     machine-seeded fact can acquire an edge via recordDerivedFact's text dedup and read as a
    //     success no human adjudicated. Documented at the function rather than papered over; isolating
    //     the human path needs a promotion-origin marker the store does not carry.
    //     >> CLOSED 2026-07-20 (91 → 92). The store now carries that marker: `adjudicatedBy: 'human'`,
    //     set ONLY on the two gates that fire lifecycleHook (promoteFact / vetoFact), and
    //     verifierCalibration skips anything without it. confirmFact — documented as "a machine
    //     transition, no human hook" — deliberately does not set it, so the machine confirm cannot
    //     manufacture a ruling. Absent ⇒ not evidence, which is also the honest reading of every legacy
    //     row, so the change can only ever REMOVE inflated confidence and never add any. This is the
    //     Stage-3 laundering shape one level up: there a fold relabelled its source 'machine' to hide an
    //     external premise; here a machine-WRITTEN STATUS was passing as a human ruling in the very
    //     measurement that sets interval width for grounding rank. Marker is loader-whitelisted (the
    //     store maps a fixed field set, so an un-whitelisted marker would evaporate on restart and
    //     silently restore the miscount) and both halves are separately power-controlled.
    //     Still 92, not 93: the remaining dock is LATENCY, and it is not buildable — see above.
    // RELEASED: the first round refuted the safety invariant (a double-rounding bug let hi exceed the
    //   point by one grid unit, ~1% of fuzz cases). Fixed by rounding once, at the fact, matching the
    //   point path; re-verified by an INDEPENDENT 961k-case fuzz at 0 violations, with a power control
    //   confirming that fuzz detects the bug when reintroduced.
    act('store.provenance', 80, 92,
      () => (hasCode('electron/services/brain/operator-model.ts', /export interface DependsOnEdge/) &&
             hasCode('electron/services/brain/operator-model.ts', /dependsOn\?:\s*DependsOnEdge/) &&
             hasCode('electron/services/brain/operator-model.ts', /buildGovernAudit[\s\S]*?premises:\s*e\.depends_on\.map/) && // audit JOINS ids→premise texts (walk WHY)
             grepProd(join(SVC, 'brain'), /recordDerivedFact\s*\(/, { excludeFile: 'operator-model.ts' }) && // the fold WIRES it (real caller, not the def)
             hasCode('electron/services/brain/derivation-verify.ts', /'entails'/) && // the NLI verifier
             hasCode('electron/services/brain/consolidation-synthesis.ts', /deps\.verify\s*\?/) && // the fold INDEPENDENTLY verifies the derivation
             hasCode('electron/services/brain/derivation-reliability.ts', /export function reliabilityByFact/) && // Stage 3: the trust semiring
             grepProd(join(SVC, 'brain'), /reliabilityByFact\s*\(/, { excludeFile: 'derivation-reliability.ts' }) && // wired outside its def (operator-model)
             hasCode('electron/services/brain/operator-model.ts', /reliability:\s*rel\.get/) && // calibrated trust surfaced in the audit
             hasCode('electron/services/brain/operator-model.ts', /buildOperatorBlock[\s\S]*?isLowTrustDerived/) && // CONSUMED: reliability gates grounding (a governor, not just an audit field)
             hasCode('electron/services/brain/derivation-reliability.ts', /export function reliabilityBoundsByFact/) && // Stage 5: the interval semiring
             grepProd(join(SVC, 'brain'), /reliabilityBoundsByFact\s*\(/, { excludeFile: 'derivation-reliability.ts' }) && // wired outside its def
             hasCode('electron/services/brain/operator-model.ts', /export function verifierCalibration/) && // the LEARNED weight (measured, not assumed)
             hasCode('electron/services/brain/derivation-reliability.ts', /wilson\s*\(/) && // precision as a Wilson interval — no parallel statistics
             grepProd(join(SVC, 'brain'), /rankByEstablishedTrust\s*\(/, { excludeFile: 'derivation-reliability.ts' }) && // CONSUMED: bounds decide who survives truncation
             // The promotion-origin marker: it must exist, be SET on the human gate, be READ by the
             // calibration, and SURVIVE reload. A declared field that nothing sets, or a marker the
             // loader drops on restart, satisfies none of these.
             hasCode('electron/services/brain/operator-model.ts', /adjudicatedBy\?:\s*'human'/) &&
             hasCode('electron/services/brain/operator-model.ts', /export function promoteFact[\s\S]{0,400}?adjudicatedBy\s*=\s*'human'/) &&
             hasCode('electron/services/brain/operator-model.ts', /verifierCalibration[\s\S]{0,900}?adjudicatedBy\s*!==\s*'human'/) &&
             hasCode('electron/services/brain/operator-model.ts', /f\.adjudicatedBy\s*===\s*'human'\s*\?\s*\{\s*adjudicatedBy/)) // loader-whitelisted
            ? { file: 'DEPENDS_ON edges: verified + audit-joined + trust-semiring reliability GATING grounding + distributional bounds ranking it', sample: 'reasoning-trace provenance capture→verify→walk→calibrated-trust→govern→evidence-bounded' } : null,
      'reasoning-trace provenance (frontier — derivation provenance nobody ships): folds record NLI-verified DEPENDS_ON edges, buildGovernAudit walks WHY a rule exists, a trust semiring computes source-tier-capped reliability (poisoning-resistant, faithfulness made quantitative), buildOperatorBlock gates grounding on it, AND (Stage 5) the same graph carries DISTRIBUTIONAL bounds whose width is set by the verifier\'s own MEASURED precision — so trust states how well ESTABLISHED it is, and that decides who survives block truncation. 92 (graded, docked from 93) — capture+verify+walk+calibrated-trust+consumed+evidence-bounded, and the learned weight now keys on a real HUMAN adjudication marker rather than a status three writers can set; the one remaining dock is LATENCY (zero live dependsOn edges), which is a usage precondition, not a build')
  ]],
  ['Store.organization', [
    // 60→63 (2026-07-18, Phase-B; magnitude CALIBRATED to the two prior adversarial-grader verdicts,
    // which both settled a heuristic improvement at +3 — batch re-grade pending). The recency-only
    // fold (newest-N into ONE rule, topic-mixed → model says "NONE", window burned) now groups the
    // fresh batch into THEMATIC clusters (clusterByCohesion, ≥2 shared significant tokens) and folds
    // EACH into its own durable rule — the frontier "synthesize memories about the same thing" move.
    // Only +3: cohesion is LEXICAL token-overlap (not embedding/semantic — a paraphrase with different
    // words won't cluster), single-level, and still one Store.org sub among several.
    // 63->66 (2026-07-18, Phase-B; pending adversarial grade): closed the "cohesion still lexical" gap —
    // runSynthesis now clusters SEMANTICALLY (clusterBySemantic embeds the batch + groups by centroid
    // cosine) so paraphrases that share no literal tokens still fold into one rule, fail-open to the
    // lexical clusterByCohesion when the embedder is cold (byte-identical). Frontier: synthesize memories
    // that MEAN the same thing (MemGPT/Generative-Agents), not just token-overlap. Not higher: threshold
    // is a fixed heuristic + on-device embedder quality bounds it; a learned/tuned threshold is future.
    base('store.consolidation', 66, 'semantic (embedding-cosine centroid) + lexical fallback thematic-cluster synthesis; fail-open to lexical when embedder cold'),
    // 55→60 (2026-07-18, Phase-B; magnitude set by an independent adversarial grader, which
    // REFUTED a proposed +9 as too-high). The two documented stubs are un-stubbed with real,
    // tested, cold-start-neutral machinery — Novelty (brain_insight_first_seen) + Decay
    // (brain_insight_impressions), multiplicative modulators wired into getHomeDigest (mirror the
    // Affinity ledger). Only +5: Novelty is single-knob LINEAR time-decay on id-first-seen (not
    // embedding-novelty / surprise), Decay a narrow threshold anti-nag — the frontier layers stay
    // absent (LLM/learned IMPORTANCE — DUIN's is still graph in-degree — embedding novelty, A-MEM
    // write-time evolution). Held at parity with store.consolidation (60), not above it.
    base('store.salience', 60, 'S = Base·Affinity·Novelty·Decay — attention modulators live (ledger-backed); factors heuristic/linear, no learned importance'),
    act('store.reinforce-arm', 64, 74,
      () => grepProd(SVC, /markUseful\s*\(/, { excludeFile: 'claim-metabolism.ts' }),
      'markUseful (spaced-repetition reinforce) has a production caller (not just its definition)'),
    // 68->72 (2026-07-18, Phase-B): reflection now folds PER thematic cluster (reuses level-1's
    // clusterByCohesion), emitting one higher-order principle per cluster instead of one recency-mixed
    // fold a multi-topic promoted batch made the model reject as "NONE" (burning the whole window).
    // Un-gameable: requires the clustering actually wired into the reflection pass.
    act('store.reflection-rollup', 40, 72,
      () => (grepProd(join(SVC, 'brain'), /rollupInsights\s*\(/) &&
             hasCode('electron/services/brain/reflection-rollup.ts', /clusterByCohesion\s*\(\s*batch\s*\)/)) // the CALL, not just the import
            ? { file: 'reflection-rollup (per-cluster)', sample: 'clusterByCohesion(batch) per-cluster reflections' } : null,
      'multi-level reflection persists abstractions back into the store'),
    act('store.auto-relink-write', 48, 53,
      // Un-gameable: a real prod CALLER of write-time relink outside the defining file (the metabolism tick).
      () => grepProd(join(SVC, 'brain'), /writeTimeRelink\s*\(|relinkNeighbors\s*\(/, { excludeFile: 'entity-graph-relink.ts' })
            ? { file: 'claim-metabolism-tick', sample: 'write-time relink wired to tick' } : null,
      'F3: write-time neighbor relink (neighborsOf-gated upsertEdge, whitelist identity + disjoint-subgraph tripwire) on the metabolism tick, not batch-only. Default-OFF (DUIN_ENTITY_GRAPH), second-source unaudited → adversarially graded 48->53, NOT raw 66'),
  ]],
  ['Apply.retrieval', [
    base('retrieval.relevance', 72, 'embed+floor+topk+conflict-suppress'),
    base('retrieval.calibration', 68, 'calFactor/recall-efficacy, default-on'),
    base('retrieval.dedup', 80, 'Phase-1b cross-source excludeRules + veto guards'),
    act('retrieval.uncertainty-gate', 15, 75,
      () => grepProd(join(SVC, 'local-brain'), /uncertaintyGate|shouldInject|injectIfUncertain|entropyGate/),
      'inject recall only at uncertain/beneficial turns (ExpWeaver)'),
    act('retrieval.escalation', 12, 72,
      () => grepProd(join(SVC, 'local-brain'), /escalateToRaw|rawSourceEscalation|tierEscalate|thinRecallEscalat/),
      'cheap fact-index → raw-source escalation when recall is thin (TierMem)'),
  ]],
  ['Apply.RSI', [
    base('rsi.gate', 78, 'sound wilson-lo + equal-duration held-out A/B + maturity gate'),
    base('rsi.enaction', 50, 'real+reversible but default-off by governance (do NOT flip to game)'),
    // 55->60 (2026-07-18, Phase-B; pending adversarial grade): the archive was per-single-knob scalar
    // bins; it now ALSO keys on the JOINT descriptor (namedSkillTopK × recallFailureLimit) — archivedJointConfigs
    // reconstructs the 2-D cell each change landed in, and nextKnobValueQD explores/avoids/exploits over
    // that descriptor space, not just one scalar axis (DGM/ADAS QD over a descriptor space). Meaningful
    // now that P1 gave the knobs distinct engines so they co-vary. Un-gameable: requires the joint archive
    // + the QD selector as prod callers. Not higher: still lexical/scalar cells, no LEARNED descriptor.
    // 55->59 (2026-07-18, Phase-B; adversarially graded +4, docked from +5): the archive was per-single-
    // knob scalar bins; it now ALSO keys on the JOINT config (namedSkillTopK × recallFailureLimit) —
    // archivedJointConfigs reconstructs the 2-D cell each change landed in, nextKnobValueQD explores/
    // avoids/exploits over it (a real interaction-aware refinement the per-axis archive missed). Docked:
    // the "descriptor" is the genotype (config grid), not a behavior descriptor, so it's 2-D memoization
    // not true quality-DIVERSITY; and it's autonomy-gated + latent on a cold ledger. Un-gameable: requires
    // the joint machinery as a real CALLER in proposeNextRsiKnob (grepProd excludeFile), not just defined.
    act('rsi.archive', 5, 59,
      () => (hasCode('electron/services/brain/rsi-proposer.ts', /archivedKnobValues/) &&
             hasCode('electron/services/brain/rsi-proposer.ts', /archivedJointConfigs\s*\(\s*vault\s*\)/) && // the CALL (def is `(vault: string)`)
             hasCode('electron/services/brain/rsi-proposer.ts', /nextKnobValueQD\s*\(\s*cur\[/)) // the CALL (def is `(cur: number`)
             ? { file: 'rsi-proposer', sample: 'joint QD archive wired into proposeNextRsiKnob' } : null,
      'quality-diversity archive over the JOINT knob-config space (archivedJointConfigs + nextKnobValueQD CALLED in proposeNextRsiKnob): avoids rolled-back joint cells, explores descriptor-novel stepping stones. 59 not 80 — genotype grid, not a learned behavior descriptor'),
    // 65->69 (2026-07-18, Phase-B; adversarially graded +4, docked from +5): the two knobs previously
    // shared the near-circular 'promotion' engine — serialized by the one-in-flight-per-engine invariant
    // (NOT a real population) and A/B'd against a signal they barely move. Each now targets the recall-
    // efficacy engine for the KIND IT MOVES (namedSkillTopK -> recall-efficacy:named-skill,
    // recallFailureLimit -> recall-efficacy:failure), projected into readFitnessVector via
    // recallEfficacyFitness, with the named-skill kind now accrued into the efficacy ledger
    // (agui-grounding stages it). Distinct engines -> genuinely concurrent in-flight. NOT +5: the
    // outcome polarity (recordRecallOutcome) is broadcast per-TURN to every staged kind, so per-kind
    // grading is AGGREGATE (differs only via each turn's kind-mix), not a clean per-kind A/B — +5 needs
    // per-kind outcome attribution (the RICHER-SIGNAL marker). Un-gameable: requires the distinct engine
    // targets AND the fitness-vector projection, not just a 2-entry count.
    act('rsi.population', 22, 69,
      () => {
        const p = read('electron/services/brain/rsi-proposer.ts')
        const m = /RSI_KNOBS\s*=\s*\[([\s\S]*?)\]/.exec(p)
        const entries = m ? (m[1].match(/\{/g) || []).length : 0
        return (entries > 1 &&
                hasCode('electron/services/brain/rsi-proposer.ts', /engine:\s*'recall-efficacy:named-skill'/) &&
                hasCode('electron/services/brain/rsi-proposer.ts', /engine:\s*'recall-efficacy:failure'/) &&
                hasCode('electron/services/brain/self-improve-fitness.ts', /recallEfficacyFitness\s*\(/))
               ? { file: 'rsi-proposer + recall-efficacy engines', sample: `${entries} knobs on distinct recall-efficacy engines` } : null
      },
      'population: >1 knob on DISTINCT per-kind recall-efficacy engines (concurrent in-flight, each A/B graded on the recall kind it moves) projected into the RSI fitness vector — not a single greedy knob on a shared circular engine (AlphaEvolve)'),
    // 68->73 (2026-07-19, SIA Apply-RSI-P2): the contract graduated from DIRECTIONAL (predictionHeld:
    // "did it rise by >= minDelta?") to CALIBRATED-MAGNITUDE. Each change now emits an ex-ante
    // predictedDelta (rsi-proposer, seeded from the joint cell's mean history); adjudicateInflight grades
    // its ERROR (gradeForecastError, |predicted-actual|) on the SAME mature held-out A/B and records
    // hit/wrong into a real rsi-forecast CALIBRATION DOMAIN grafted onto calibration-native (Wilson-lo,
    // ISO-windowed, gated<CAL_MIN_N — no parallel stats). proposeNextRsiKnob CONSUMES that history
    // (forecastAccuracyByConfig) to prefer well-MODELED cells among the improving ones. The legacy AHE
    // contract (predictionHeld consumed by the archive) is retained. Un-gameable: the domain literal +
    // the writer as a real prod CALLER (excludeFile: its own def) + the selection consumer, not dead
    // symbols. 73 not higher: the grade is a single tolerance-band hit/wrong, not a reliability curve
    // over predicted magnitude; per-cell attribution is coarse; and it's latent until CAL_MIN_N(20) live
    // resolutions — the probe verifies the WIRING, never runtime accrual.
    act('rsi.per-change-contract', 45, 73,
      () => (hasCode('electron/services/brain/rsi-proposer.ts', /predictedDelta/) && // ex-ante MAGNITUDE forecast, not just direction
             hasCode('electron/services/brain/self-improve-fitness.ts', /gradePrediction/) &&
             hasCode('electron/services/brain/self-improve-fitness.ts', /gradeForecastError/) && // forecast-ERROR grader
             hasCode('electron/services/brain/self-improve-loop.ts', /predictionHeld/) &&
             hasCode('electron/services/brain/rsi-proposer.ts', /predictionHeld\s*===\s*true/) && // legacy AHE contract still consumed
             hasCode('electron/services/brain/calibration-native.ts', /['"]rsi-forecast['"]/) && // a REAL calibration domain grafted onto the substrate
             grepProd(join(SVC, 'brain'), /recordRsiForecast\s*\(/, { excludeFile: 'rsi-forecast-store.ts' }) && // writer WIRED as a prod caller
             hasCode('electron/services/brain/rsi-proposer.ts', /forecastAccuracyByConfig/)) // SELECTION consumer prefers accurate configs
             ? { file: 'rsi calibrated-forecast (predictedDelta graded into rsi-forecast domain + selection-consumed)', sample: 'AHE+cal' } : null,
      'each RSI change emits an ex-ante MAGNITUDE forecast (predictedDelta); its ERROR is graded into a real rsi-forecast calibration domain (ISO-windowed held-out, Wilson-lo, gated<CAL_MIN_N) AND consumed by proposeNextRsiKnob to PREFER well-modeled knob configs. 73 — forecast-calibration wired + selection-consumed, below full reliability-curve calibration'),
  ]],
  ['Measure', [
    base('measure.held-out', 82, 'binding won\'t-recur + revertByBindingId'),
    base('measure.evidence-bounds', 72, 'wilson_lo IS the gate score; Brier point-only'),
    base('measure.ab-efficacy', 85, 'flip metric wired into govern confirm gate'),
    act('measure.backward-retention', 28, 78,
      () => (grepProd(join(SVC, 'brain'), /promotion-predictions\.jsonl/, {}) && grepProd(join(SVC, 'brain'), /writeFileSync|appendFileSync|writeJsonl/) &&
             grepProd(join(SVC, 'brain'), /replaySet|regressionGate|backwardRetention/)) ? { file: 'brain', sample: 'retention gate' } : null,
      'a replay/regression gate + a real writer for promotion-predictions (SIP-Bench)'),
    act('measure.per-label-calibration', 48, 75,
      () => grepProd(join(SVC, 'brain'), /verbalizedCertainty|perLabelReliability|labelCalibration|braceLabel/),
      'per-label verbalized-certainty calibration robust to degenerate base rates (Agent-BRACE)'),
    act('measure.pre-resolution', 30, 62,
      () => grepProd(join(SVC, 'brain'), /preResolution|leadingIndicator|temporalContrastSignal/),
      'a pre-resolution / leading calibration signal (Milkyway)'),
    // F1-b (real-label grounding eval) deliberately does NOT add a diluting sub-axis here: its honest
    // grade (~58, latent-until-run + no govern consumer yet) is BELOW the Measure mean (76), so adding
    // it would LOWER the axis for a genuine improvement (equal-weight-per-subaxis). Its credit lands as
    // GROUNDING store.implicit-conflict-live (de-gamed from a bare flag to a real-label-eval predicate)
    // + enabling F3's honest grading — not a new number. Revisit when stalenessTrust gates a govern loop.
  ]],
  ['Govern.enforcement', [
    base('govern.chokepoint', 78, 'fail-closed per-action tier gate (deny-first, unclassified→irreversible)'),
    base('govern.rung-propose-only', 68, 'propose-only + demote-fast governor'),
    act('govern.compose', 40, 78,
      () => (hasCode('electron/services/local-brain/agui-gate.ts', /from ['"][^'"]*capability-ledger/) ||
             hasCode('electron/services/local-brain/agui-approval.ts', /from ['"][^'"]*capability-ledger/))
             ? { file: 'agui-gate/approval', sample: 'rung composed' } : null,
      'the ANS rung is consulted at the resolveAguiGate choke-point (least-permissive of tier+rung)'),
    act('govern.output-holding', 25, 82,
      // Load-bearing wiring, not speculative symbols: the PRODUCER holds the turn's output
      // (loop-controller stages it on a side ref via stageStep + flags the item
      // awaiting-ratification, so HEAD never advances), and the RATIFY plane lands-on-ratify
      // / discards-on-revert (loop-ratify's applyStaged/discardStaged). Both required — a
      // hold with no ratify path, or a ratify fn with no producer, is not the control plane.
      () => (hasCode('electron/services/loop-controller.ts', /stageStep\(/) &&
             hasCode('electron/services/loop-controller.ts', /awaiting-ratification/) &&
             hasCode('electron/services/loop-ratify.ts', /applyStaged|discardStaged/))
             ? { file: 'loop-controller/loop-ratify', sample: 'hold→ratify plane' } : null,
      'output-holding control plane: hold commits on a side ref until ratify, apply-on-ratify / discard-on-revert (Sovereign Agentic Loops)'),
  ]],
  ['Govern.coverage', [
    // 50→53 (2026-07-18, Phase-B; +3 calibrated to prior grader verdicts): closed a real fail-OPEN
    // gap — resolveSubagentConfig previously fell back to the FULL toolset for a requested-but-unknown
    // agent_type (a typo/miss silently escalated privilege), contradicting this axis's own "fail-closed
    // capability-miss" claim. Now a capability-miss drops to the READ-ONLY floor (enforced via the
    // agui-subagent allow-list filter), while a bare {task} keeps the general default. Only +3: it's the
    // unknown-type edge case; the broader least-privilege model (per-run minimal-toolset derivation,
    // default-deny for the general agent) is unchanged.
    // 53->57 (2026-07-18, Phase-B; adversarially graded +4, docked from +5): closed the documented gap
    // ("general still gets full; per-run minimal-toolset derivation unchanged"). The general agent is now
    // DEFAULT-DENY — resolveSubagentConfig derives a MINIMAL toolset per spawn (deriveToolset: read-only
    // floor, widened to file/shell only on task mutation/shell hints; verb lists broadened per the grader
    // to cut mis-classification) instead of the blanket full toolset; the model opts up explicitly with
    // agent_type:'coder'. Load-bearing + enforced on the real spawn path (agui-subagent tool filter).
    // Docked from +5: the derivation is a keyword heuristic (not learned) + general subagents also lose
    // nested spawn_agent (directionally correct for least-privilege).
    base('govern.least-privilege', 57, 'per-run MINIMAL-toolset derivation (default-deny general via deriveToolset) + role/subagent allow-lists + fail-closed capability-miss'),
    // 17→20 (2026-07-18, Phase-B; magnitude set by an independent adversarial grader, which refuted
    // +5 as too-high AND caught a real bug — the escalation now fires on-and-after the ceiling, not
    // once). A real reversibility-weighted consequence accumulator (act/cumulative-consequence.ts)
    // wired into resolveAguiGate as a tighten-only composer (allow→prompt once a conversation's total
    // reaches the ceiling, and every action after). Only +3: it's OPT-IN (DUIN_CONSEQUENCE_CEILING
    // unset → disabled, byte-identical gate → zero deployed governance delta by default), HEURISTIC
    // (hand-set linear tier-weights, in-memory single-process session scope, no durable/cross-session
    // /learned budget), and irreversible actions are already per-action gated (marginal reach is
    // reversible/external floods). Real capability, but inert-by-default and far from a frontier plane.
    // 20→28 (2026-07-19, SIA Govern-P2; adversarially graded +8, docked from +10): the accumulator's ONE-WAY RATCHET is CLOSED and
    // the AFK path made SAFE. (2a) resetConsequence is now a real prod caller in resolveAguiGate's
    // operator-approve branches — an operator ratifying "continue" decrements the session budget, so a
    // flood that tripped the ceiling can be released instead of escalating forever. (2b) a cumulative
    // ceiling-trip in AFK ROUTES THROUGH requestOperatorApproval (ask the operator over the live channel)
    // instead of minting a bare prompt that silently fail-closed to DENY — making a safe default-on path
    // real, not just opt-in. TIGHTEN-ONLY preserved: shouldEscalateCumulative only ever escalates an
    // allow→ask; reset only zeroes the CUMULATIVE accumulator, never the per-action tier floor
    // (irreversible actions stay gated by decideAguiGate). Only +10, not a leap: still HEURISTIC
    // (hand-set linear tier-weights), IN-MEMORY single-process session scope, no durable/cross-session
    // /learned budget, and the deployed default ceiling STAYS 0 (opt-in) — the mechanism is now
    // safe-default-CAPABLE, but flipping the default on is a separate, deliberate commit. Docked to +8
    // (not +10) by the adversarial grader: the deployed default ceiling stays 0, so in production the
    // mechanism is inert (capability, not active governance delta) until an operator opts in — the same
    // inert-by-default standard that held govern.cumulative to +3 (17→20) last session. Un-gameable:
    // the probe demands resetConsequence as a real prod caller (loop-closure) AND the distinct
    // cumulative-approval:operator-approve routing literal (the 2b AFK ask), not the pre-existing
    // one-way ratchet. Absent (17) = the pre-loop-closure ratchet.
    act('govern.cumulative', 17, 28,
      () => (grepProd(join(SVC, 'local-brain'), /resetConsequence\s*\(/, { excludeFile: 'cumulative-consequence.ts' }) && // 2a loop-closure: approval resets the budget (real prod caller)
             hasCode('electron/services/act/cumulative-consequence.ts', /export function shouldEscalateCumulative/) && // the tighten-only escalation decision
             hasCode('electron/services/local-brain/agui-gate.ts', /shouldEscalateCumulative\s*\(/) && // wired at the choke-point
             hasCode('electron/services/local-brain/agui-gate.ts', /cumulative-approval:operator-approve/)) // 2b AFK routing through requestOperatorApproval (distinct from feature-#1's channel-approval literal)
            ? { file: 'agui-gate: reset in approve branch + AFK ceiling routing', sample: 'cumulative loop closed + safe-default path' }
            : null,
      'cumulative-consequence LOOP-CLOSED: operator approval resets the session budget (resetConsequence wired into the approve branches — real prod caller) AND an AFK ceiling-trip routes through requestOperatorApproval instead of silently fail-closing to deny; tighten-only preserved, still heuristic/in-memory/single-session and opt-in-by-default'),
    // 58→66 (2026-07-18, Phase-B; adversarially graded): closed the "ingestion-tiering still open"
    // headroom. Beyond injection-isolation (looksInjected/INJECTION_SIGNATURES), memory-writes are now
    // PROVENANCE-TIERED by trust: learnFromTurn(query, answer, execOk) tags facts from a de-privileged
    // inbound/channel turn (execOk:false) as source:'external' instead of operator/machine; those
    // un-promoted external facts are QUARANTINED from grounding on EVERY path via the shared
    // isQuarantinedExternal predicate — the default-on RECALL assembly (agui-grounding), the whole-dump
    // buildOperatorBlock fallback, AND the consolidation input (so external content can't launder into
    // an operator-sourced rule); an untrusted turn can also no longer RETIRE a governed fact
    // (auto-supersession gated on trusted). Un-gameable: requires the tier TYPE + the shared predicate
    // used on the recall path AND consolidation + the live caller threading execOk. Not 72: promotion
    // of a reviewed external fact still rides the generic human gate (no external-review-with-source UI).
    // 66→70 (2026-07-19, SIA reasoning-trace Stage 4): closed the FOLD-LAUNDERING blind spot in the
    // ingestion tiering. isQuarantinedExternal keys on factSource==='external', but a consolidation/
    // reflection fold relabels its output source:'machine' — so external content folded into a rule
    // recalled UNGATED (the source tag no longer shows the external premise underneath). The Stage-3 trust
    // semiring sees it: a fold over an external premise is capped ≤0.3, below TRUST_FLOOR, so
    // isLowTrustDerived now suppresses it on the DEFAULT-ON recall path (agui-grounding) AND the whole-dump
    // fallback (buildOperatorBlock) — the poisoning defense is complete across grounding paths, not only
    // the direct-external case. Un-gameable: requires the reliability gate as a real predicate on the
    // recall path, not only the source-tag quarantine.
    act('govern.memory-write-gate', 38, 70,
      () => (hasCode('electron/services/brain/operator-model.ts', /looksInjected/) &&
             hasCode('electron/services/brain/operator-model.ts', /INJECTION_SIGNATURES/) &&
             hasCode('electron/services/brain/operator-model.ts', /FactSource\s*=[^\n]*'external'/) &&
             hasCode('electron/services/brain/operator-model.ts', /export function isQuarantinedExternal/) &&
             hasCode('electron/services/local-brain/agui-grounding.ts', /isQuarantinedExternal/) &&
             hasCode('electron/services/local-brain/agui-grounding.ts', /isLowTrustDerived/) && // the fold-laundering reliability gate on the recall path
             hasCode('electron/services/brain/consolidation-synthesis.ts', /isQuarantinedExternal/) &&
             grepProd(join(SVC, 'local-brain'), /learnFromTurn\([^)]*execOk/)) ? { file: 'operator-model + tiered ingestion + fold-laundering reliability gate', sample: 'injection-isolation + external-tier quarantine + trust-semiring gate on all grounding paths' } : null,
      'memory-write injection isolation AND ingestion-trust tiering AND the fold-laundering reliability gate: de-privileged turns tag facts external + quarantine them, AND a fold that laundered external content (relabelled machine) is caught by the trust-semiring gate on the recall + whole-dump paths; untrusted turns cannot retire governed facts (SSGM/DRIFT)'),
    act('govern.integrity-check', 12, 62,
      () => (hasCode('electron/services/act/action-tier.ts', /reconcileExternalTier/) &&
             hasCode('electron/services/act/action-tier.ts', /escalatedFrom/)) ? { file: 'action-tier', sample: 'reconcile' } : null,
      'declared-vs-actual integrity: a name betraying a stricter consequence than its declared tier is escalated fail-closed (BIV-lite)'),
  ]],
  ['Harness', [
    base('harness.continuity', 80, 'crash-consistent commit→journal→done ordering'),
    base('harness.stop-authorities', 85, 'stall/cost/breaker/resource, all wired'),
    base('harness.hitl', 78, 'fail-closed irreversible-approval await'),
    act('harness.bounded-context', 65, 70,
      () => (
        // F2-small (LIVE, default-on): tool-output + raw-escalation truncation is relevance-ranked
        hasCode('electron/services/local-brain/agui-tools.ts', /ctx\.embed/) &&
        grepProd(join(SVC, 'local-brain'), /boundToBudget\s*\(/, { excludeFile: 'output-bound.ts' }) &&
        // F2-compiler (BUILT, opt-in): whole-prompt token-budgeted relevance assembly, gated + real per-model budget
        hasCode('electron/services/local-brain/agui-grounding.ts', /process\.env\.DUIN_CONTEXT_COMPILER\s*===\s*['"]1['"]/) &&
        grepProd(join(SVC, 'local-brain'), /compilePrompt\s*\(/, { excludeFile: 'prompt-compiler.ts' }) &&
        hasCode('electron/services/local-brain/server.ts', /resolveModel\([^)]*\)\.contextWindow/)
      ) ? { file: 'prompt-compiler/agui-grounding/agui-tools', sample: 'boundToBudget + compilePrompt wired' } : null,
      'F2: tool-output truncation semantic + LIVE (+2→67); whole-prompt context-compiler BUILT behind DUIN_CONTEXT_COMPILER opt-in with a real per-model budget (+3→70, govern.cumulative opt-in precedent). Adversarially graded; NOT 72-78 — default-off (latent) + ranking quality needs the F1 operator-attended eval + a drop-first phase order to trust default-on'),
    act('harness.verify-gate', 10, 82,
      () => (hasCode('electron/services/loop-controller.ts', /requireVerify|verifyBeforeCommit|verifyGate|verifyReceipt|brainVerify/) ||
             grepProd(join(SVC, 'longrun'), /verifyBeforeCommit|verifyGate|requireVerifyReceipt/))
            ? { file: 'loop-controller/longrun', sample: 'V-gate' } : null,
      '2BRAIN: loop gates on a BRAIN-output verify receipt (memory-write non-corrupting, digest cites real notes) before commit→done — reuse brain-health/coherence-lint, not code-build'),
    act('harness.dod-seed', 5, 75,
      () => (hasCode('electron/services/loop-schema.ts', /definition_of_done|acceptance_criteria/) ||
             hasCode('electron/services/loop-controller.ts', /definitionOfDone|acceptanceCriteria/) ||
             grepProd(join(SVC, 'longrun'), /definitionOfDone|acceptanceCriteria/))
             ? { file: 'loop-schema/loop-controller', sample: 'DoD seed' } : null,
      '2BRAIN: a background brain-task carries a brain-checkable definition-of-done (covers all active tracks, no orphan claims) seeded at task start — NOT a code feature-list'),
  ]],
]

// ── Score ──
const rows = []
for (const [axis, subs] of AXES) {
  for (const s of subs) {
    let score, present = null, evidence = ''
    if (s.kind === 'baseline') { score = s.score }
    else { present = s.probe(); score = present ? s.present : s.absent; evidence = present ? `${present.file}` : 'absent' }
    rows.push({ axis, id: s.id, kind: s.kind, score, present: !!present, evidence, note: s.note, absent: s.absent, target: s.present })
  }
}
const axisScores = AXES.map(([axis]) => {
  const rs = rows.filter((r) => r.axis === axis)
  return { axis, score: Math.round(rs.reduce((a, r) => a + r.score, 0) / rs.length) }
})
const overall = Math.round(axisScores.reduce((a, x) => a + x.score, 0) / axisScores.length)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ overall, axes: axisScores, subs: rows }, null, 2))
} else {
  console.log(`\n  DUIN vs SIA frontier — deterministic instrument   (frontier best-in-class = 100)`)
  console.log(`  ${'─'.repeat(74)}`)
  for (const { axis, score } of axisScores) {
    const bar = '█'.repeat(Math.round(score / 5)).padEnd(20)
    console.log(`  ${axis.padEnd(20)} ${bar} ${String(score).padStart(3)}`)
  }
  console.log(`  ${'─'.repeat(74)}`)
  console.log(`  OVERALL ${String(overall).padStart(56)}\n`)
  const open = rows.filter((r) => r.kind === 'activatable' && !r.present)
    .sort((a, b) => (b.target - b.absent) - (a.target - a.absent))
  console.log(`  Open activations (${open.length}) — sorted by lift, the loop's work-list:`)
  for (const r of open) console.log(`    [+${String(r.target - r.absent).padStart(2)}]  ${r.id.padEnd(30)} ${r.note}`)
  const done = rows.filter((r) => r.kind === 'activatable' && r.present)
  if (done.length) { console.log(`\n  Landed activations (${done.length}):`); for (const r of done) console.log(`    [✓]  ${r.id.padEnd(30)} ${r.evidence}`) }
  console.log('')
}
