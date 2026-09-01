#!/usr/bin/env node
// efficiency-benchmark — the deterministic INSTRUMENT for "DUIN runtime efficiency".
//
// Sibling to sia-benchmark.mjs. Same doctrine — the score is UN-GAMEABLE — but efficiency is a RUNTIME
// property, not a static one, so raw milliseconds (machine-/load-/vault-dependent, trivially gamed on a
// fast box) are forbidden as a score. Instead every sub-axis is one of:
//
//   • PROPERTY probe  — a predicate over the CODE (grep/file), exactly like sia-benchmark: does an
//     efficiency MECHANISM exist and is it load-bearing (a real caller, not a dead symbol)? Deterministic,
//     reproducible, un-gameable by construction. Used where an algorithmic win can't be micro-measured
//     standalone (streaming, spill, deferred-boot, byte-stable prefix, no-double-generation).
//
//   • SCALING-RATIO microbench — runs a PURE hot-path core at size n and 2n and scores the RATIO, i.e. the
//     COMPLEXITY, not the absolute time. O(n²) ⇒ ~4× at double size; O(n) ⇒ ~2×. A ratio is machine-
//     INDEPENDENT and cannot be faked — you cannot get a linear ratio without the algorithm actually being
//     linear. Used on the 2–3 hottest algorithmic paths where speed IS the point (markdown render,
//     lexical scan, per-round context growth).
//
// THE HYBRID CONTRACT (why this is un-gameable for efficiency): a SCALING sub-axis reaches full score only
// when BOTH (a) the mechanism is present in prod (property side) AND (b) its extracted PURE CORE, imported
// and run here, MEASURABLY scales at the target complexity (ratio side). A fake "block-lexer" that is
// still O(n²) passes the grep but FAILS the ratio — so you cannot claim the gain without the code actually
// being faster. Baseline hot paths export no pure core yet ⇒ the ratio is `absent` and the property probe
// scores them honestly LOW; the campaign's first job is to refactor each hot path into an importable pure
// core, which is itself the fix. Run `node scripts/efficiency-benchmark.mjs --selftest` to see the ratio
// harness distinguish O(n) from O(n²) on reference implementations.
//
// THE LOOP (identical to sia): pick the lowest axis → port the mechanism (in DUIN's grain) → the probe
// flips / the ratio drops → re-run this → a fresh agent adversarially REFUTES (is it load-bearing + does
// the ratio really hold?) → gate + commit. You cannot raise the overall without the code getting faster.
//
// Run:  node scripts/efficiency-benchmark.mjs           (scorecard)
//       node scripts/efficiency-benchmark.mjs --json     (machine)
//       node scripts/efficiency-benchmark.mjs --selftest (prove the ratio harness works)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SVC = join(ROOT, 'electron', 'services')

function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf-8') } catch { return '' }
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
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
      if (!/\.(ts|tsx|mjs|cjs|js)$/.test(e)) continue
      if (!includeTests && /\.test\.|\.golden\.|\.spec\./.test(e)) continue
      if (excludeFile && e === excludeFile) continue
      let txt
      try { txt = stripComments(readFileSync(p, 'utf-8')) } catch { continue }
      if (re.test(txt)) { hit = { file: p.slice(ROOT.length + 1).replace(/\\/g, '/') }; return }
    }
  }
  walk(dir)
  return hit
}
const hasCode = (rel, re) => re.test(stripComments(read(rel)))

// ── sub-axis constructors ──
// property probe: absent→present flip driven by a code predicate (identical to sia's act()).
const prop = (id, absent, present, probe, note) => ({ id, kind: 'property', absent, present, probe, note })
// fixed VERIFIED baseline (a mechanism that's real but not the lever we're pulling).
const base = (id, score, note) => ({ id, kind: 'baseline', score, note })
// scaling-ratio microbench: benchThunk() → { present:bool, ratio:number|null, score:number, detail } | null.
//   null / present:false ⇒ absent (no pure core to measure yet). present:true ⇒ score by measured ratio.
const scale = (id, absent, present, benchThunk, note) => ({ id, kind: 'scale', absent, present, benchThunk, note })
// TIERED property probe: probe() returns { score, hit } directly instead of an absent/present flip.
// For mechanisms whose real-world payoff arrives in STAGES (exists → load-bearing → proven →
// default-ON). A binary probe would have to either over-credit a flag-gated-OFF mechanism (which
// ships no default speedup) or under-credit a real, tested one; tiering reports the truth.
const tier = (id, probe, note) => ({ id, kind: 'tier', probe, note })

// ── the scaling-ratio harness ─────────────────────────────────────────────────
// Run `work(size)` (which does the streaming-style total work for a doc of `size` units) at n and 2n,
// median of R reps to damp noise, and return the doubling ratio r = t(2n)/t(n). Interpret:
//   r ≲ 2.4  → linear-ish (the incremental win) ; r ≳ 3.2 → quadratic (the O(n²) anti-pattern).
// score maps the ratio into [absent..present] so a genuinely-linear core earns full marks and a
// still-quadratic one scores near the floor even if the mechanism "exists".
function ratioScore(work, { n = 2000, reps = 5, absent, present }) {
  const timeAt = (size) => {
    const t = []
    for (let i = 0; i < reps; i++) {
      const s = process.hrtime.bigint()
      work(size)
      t.push(Number(process.hrtime.bigint() - s))
    }
    t.sort((a, b) => a - b)
    return t[t.length >> 1] || 1
  }
  // warm up (JIT) then measure
  work(n); work(2 * n)
  const t1 = timeAt(n)
  const t2 = timeAt(2 * n)
  const ratio = t2 / Math.max(t1, 1)
  // linear r≈2 → present ; quadratic r≈4 → absent ; clamp + lerp on [2.4, 3.4]
  const lo = 2.4, hi = 3.4
  const frac = Math.max(0, Math.min(1, (hi - ratio) / (hi - lo)))
  const score = Math.round(absent + (present - absent) * frac)
  return { present: true, ratio: Math.round(ratio * 100) / 100, score, detail: `t(2n)/t(n)=${Math.round(ratio * 100) / 100}` }
}

// Attempt to dynamic-import a designated PURE CORE the campaign will extract; return null if absent so the
// sub-axis stays honestly LOW until the refactor lands. (Pure cores are plain ESM — no electron/TS types —
// so this standalone .mjs can import + measure them. That "must be importable + measurably linear" contract
// is the un-gameable part.)
async function tryImport(relFromRoot) {
  try { return await import('file://' + join(ROOT, relFromRoot).replace(/\\/g, '/')) } catch { return null }
}

// ── The instrument: 6 efficiency axes. Baseline reads DUIN as of this build. ──
async function buildAxes() {
  return [
    ['Render', [
      // The confirmed O(n²): MarkdownRenderer re-parses the WHOLE growing doc via <ReactMarkdown> on every
      // token. The win (borrowed from an open-source chat renderer's incremental block-lexing, "14× less
      // splitter CPU") is a pure block splitter that re-parses only the open block. Scored by RATIO on that
      // pure core once extracted to src/components/artifacts/markdown-blocks.mjs.
      scale('render.markdown-scaling', 20, 80,
        async () => {
          // Full hybrid contract: the pure core must (a) be LOAD-BEARING — actually imported by the
          // renderer (not a linear-but-unwired core = gaming) AND (b) measurably scale O(n) via the ratio.
          const wired = grepProd(join(ROOT, 'src'), /from ['"][^'"]*markdown-blocks/, { excludeFile: 'markdown-blocks.mjs' })
          const m = await tryImport('src/components/artifacts/markdown-blocks.mjs')
          if (!wired || !m || typeof m.streamRenderWork !== 'function') return null
          return ratioScore((size) => m.streamRenderWork(size), { n: 1500, absent: 20, present: 80 })
        },
        'streaming markdown re-render is INCREMENTAL (re-parse only the open block), the pure core is IMPORTED by the renderer AND verified O(n) by the doubling ratio — not a full <ReactMarkdown> re-parse per token'),
      prop('render.incremental-block-parse', 15, 78,
        () => grepProd(join(ROOT, 'src'), /splitMarkdownBlocks\s*\(|createBlockStream\s*\(/, { excludeFile: 'markdown-blocks.mjs' })
              ? { file: 'markdown block renderer' } : null,
        'the renderer CALLS the block splitter (real caller, not the definition) + memoizes closed blocks so React reconciles only the tail, not one <ReactMarkdown>{wholeDoc}'),
      prop('render.highlight-deferred', 20, 74,
        () => hasCode('src/components/artifacts/MarkdownRenderer.tsx', /CodeBlock[\s\S]{0,160}streaming=\{streaming\}/)
              ? { file: 'MarkdownRenderer → CodeBlock streaming-skip' } : null,
        'syntax highlighting (Shiki) is deferred while a message is still streaming — no per-token highlight of a growing code block (already present)'),
      base('render.memoized-bubbles', 72, 'sibling message bubbles are memo\'d so only the active streaming bubble re-renders (present)'),
    ]],
    ['Grounding', [
      // TTFT tax: full-vault disk read (liveWholeNotes — no cache) + SELECT * FROM notes_chunks full scan,
      // both synchronous before the first answer token, every turn. Wins map to Quicksilver's "cache probes
      // off the critical path" cluster.
      prop('grounding.whole-notes-cache', 12, 72,
        () => (hasCode('electron/services/brain/retrieve-agent.ts', /wholeNotesCache/) &&
               hasCode('electron/services/brain/retrieve-agent.ts', /graphCache/) &&
               hasCode('electron/services/brain/retrieve-agent.ts', /vaultVersion\s*\(/) && // caches keyed by the version
               grepProd(join(SVC, 'local-brain'), /bumpVaultVersion\s*\(/, { excludeFile: 'vault-version.ts' })) // the watcher INVALIDATES it (load-bearing, not a dead cache)
              ? { file: 'retrieve-agent version-keyed cache + notes-watcher bump' } : null,
        'liveWholeNotes()/liveGraph() are cached keyed by a vaultVersion counter the notes-watcher bumps on change/reindex/construction — an O(1) cache hit instead of a full-vault disk read + graph rebuild on EVERY turn'),
      prop('grounding.no-full-corpus-scan', 15, 70,
        () => grepProd(join(SVC, 'local-brain'), /SELECT\s+id\s+AS\s+rowid,\s*file,\s*text\s+FROM\s+notes_chunks/)
              ? null // the full-table scan is PRESENT → anti-pattern → absent(low)
              : { file: 'no full-corpus scan' },
        'lexical recall uses a held in-memory index (or an FTS/rowid-scoped query), not `SELECT * FROM notes_chunks` read-all-into-JS on every query'),
      prop('grounding.embedder-warm', 20, 66,
        () => (hasCode('electron/services/local-brain/index-store.ts', /export async function warmEmbedder/) &&
               grepProd(join(SVC, 'local-brain'), /warmEmbedder\s*\(/, { excludeFile: 'index-store.ts' })) // wired at boot (real caller)
              ? { file: 'warmEmbedder + boot caller' } : null,
        'the embedder worker is pre-warmed in the background after boot so the FIRST real query does not pay worker/model spin-up (background-warm, not lazy-on-first-use)'),
      base('grounding.tool-card-streams-early', 70, 'the search_notes tool card streams to the UI immediately so the user sees activity before the answer token (present)'),
    ]],
    ['ColdStart', [
      base('cold.index-deferred', 80, 'reindex/extraction/brain-build are fire-and-forget after listen (`void reindex().then(...)`) — off the boot critical path (present)'),
      base('cold.splash-masked', 74, 'a splash window masks the synchronous store hydration (SPLASH_MIN_MS) so boot is not a blank-window stall (present)'),
      prop('cold.background-warm', 18, 66,
        () => (hasCode('electron/services/local-brain/index-store.ts', /export async function warmEmbedder/) &&
               grepProd(join(SVC, 'local-brain'), /warmEmbedder\s*\(/, { excludeFile: 'index-store.ts' }))
              ? { file: 'post-boot warm' } : null,
        'first-turn cost (embedder + first grounding) is pre-warmed in the background post-boot, not paid lazily on the user\'s first message'),
    ]],
    ['Loop', [
      base('loop.token-streaming', 82, 'model output is streamed delta-by-delta to the channel/renderer (sseFrameDrained), not accumulate-then-send (present)'),
      base('loop.backpressure', 74, 'the SSE writer awaits socket drain so a fast provider can\'t unbounded-buffer the main loop (present)'),
      prop('loop.no-double-generation', 22, 70,
        () => hasCode('electron/services/local-brain/server.ts', /finalizeAnswer\(/) &&
              !grepProd(join(SVC, 'local-brain'), /regenerate|second full generation|re-?generate the (?:entire|whole)/)
              ? null // finalizeAnswer present without a guard against whole-doc re-gen → anti-pattern
              : { file: 'no whole-doc re-generation' },
        'a generative-write that stops on a tool-preamble is REPAIRED incrementally, not re-generated whole (finalizeAnswer must not re-run a full second generation of a large doc)'),
    ]],
    ['Memory', [
      base('mem.tool-result-spill', 80, 'large tool results (>8KB) spill to disk with a head+tail preview + a 200K hard cap, so a big result doesn\'t bloat the in-context array (present)'),
      // Scoped to the TURN MESSAGE-PREP path (the chat handler + grounding assembly), NOT all of
      // local-brain — the original over-scope false-flagged graph-derive.ts's DEFENSIVE, load-bearing
      // graph clone (callers mutate it via applyConstruction; also amortized by the gain-2 liveGraph cache)
      // as if it were a per-turn message deepcopy. DUIN builds the message array by push/spread — already
      // copy-on-write. Present = no full message-array deepcopy on the turn path.
      prop('mem.copy-on-write-history', 25, 68,
        () => (hasCode('electron/services/local-brain/server.ts', /structuredClone|JSON\.parse\(\s*JSON\.stringify/) ||
               hasCode('electron/services/local-brain/agui-grounding.ts', /structuredClone|JSON\.parse\(\s*JSON\.stringify/))
              ? null // a full deepcopy on the message-prep path would be the anti-pattern
              : { file: 'message prep is push/spread — no per-turn deepcopy' },
        'per-turn message prep is copy-on-write / shallow (built by push/spread), not a full deepcopy of a growing history array each turn (Quicksilver #61133) — DUIN already satisfies this'),
      scale('mem.context-growth-bounded', 24, 72,
        async () => {
          const m = await tryImport('electron/services/local-brain/context-core.mjs')
          if (!m || typeof m.contextBytesForRounds !== 'function') return null
          return ratioScore((rounds) => m.contextBytesForRounds(rounds), { n: 40, reps: 7, absent: 24, present: 72 })
        },
        'per-round grounded-context payload grows SUB-quadratically across tool rounds (pruning/compression bounds it) — verified by the doubling ratio on the pure context-builder core'),
    ]],
    ['Context', [
      // Both ctx probes are TIERED, not binary. Rationale (campaign §6, "scope probes PRECISELY"):
      // the original pair were whole-dir greps for bare identifiers, which would have credited a
      // mechanism that merely EXISTS — or worse, one that is only NAMED. Efficiency is a property of
      // what DUIN actually runs by DEFAULT, so each tier below adds one thing the previous tier
      // cannot fake: the pure mechanism, a real prod caller, a test that proves the property, and
      // finally being the DEFAULT path. A mechanism sitting behind a default-OFF flag ships ZERO
      // default speedup, so it stops one tier short of full credit until the flag flips.
      tier('ctx.byte-stable-prefix',
        async () => {
          // (a) the pure ESM core exists AND IMPORTS — same hybrid-contract shape as
          // render.markdown-scaling: a core the instrument can actually execute.
          const m = await tryImport('electron/services/local-brain/prompt-layout.mjs')
          if (!m || typeof m.layoutStablePrefixMessages !== 'function' || typeof m.verifyStableLayout !== 'function') {
            return { score: 18, hit: null }
          }
          // (b) LOAD-BEARING: the prod grounding assembler imports AND calls it.
          const wired = hasCode('electron/services/local-brain/agui-grounding.ts',
            /from\s*'\.\/prompt-layout\.mjs'/) &&
            hasCode('electron/services/local-brain/agui-grounding.ts', /return\s+layoutStablePrefixMessages\(/)
          if (!wired) return { score: 30, hit: { file: 'prompt-layout.mjs (core only — no prod caller)' } }
          // (c) the stability property is PROVEN BY EXECUTION — the instrument runs the real prod
          // core over two turns and checks the properties itself. The earlier version of this rung
          // grepped the TEST FILE's source for its assertion text, which proved only that a string
          // existed: it still scored full marks with the assertion commented out or inverted to
          // expect failure. Executing the core cannot be faked that way — a layout that leaks the
          // volatile tail into the prefix, or that buys a stable prefix by DROPPING the turn's
          // grounding, fails a property here.
          const report = m.verifyStableLayout()
          if (!report || !report.pass) {
            const failed = Object.keys(report || {}).filter((k) => k !== 'pass' && report[k] === false)
            return { score: 45, hit: { file: `core runs but FAILS: ${failed.join(', ') || 'unknown'}` } }
          }
          // (d) DEFAULT-ON? A mechanism behind an opt-in flag ships no default speedup. Detected
          // semantically (does the prod file still gate on the flag identifier at all?) rather than
          // by matching one literal spelling — `process.env.DUIN_STABLE_PREFIX` and
          // `process.env['DUIN_STABLE_PREFIX']` are the same gate and must score the same.
          const prod = stripComments(read('electron/services/local-brain/agui-grounding.ts'))
          const optIn = /DUIN_STABLE_PREFIX['"\]\s]*===?\s*['"]1['"]/.test(prod)
          const optOut = /DUIN_STABLE_PREFIX['"\]\s]*!==?\s*['"]0['"]/.test(prod)
          const gatedOff = optIn && !optOut
          return gatedOff
            ? { score: 52, hit: { file: 'core verified + wired, DEFAULT-OFF (DUIN_STABLE_PREFIX=1) — awaiting answer-quality eval' } }
            : { score: 74, hit: { file: 'byte-stable prefix (default, verified by execution)' } }
        },
        'the system-prompt prefix is byte-STABLE across turns (volatile bits — retrieval CONTEXT/query/recall — carried on the turn\'s user message, never mutated into the cached prefix) so the provider prefill cache stays warm'),
      tier('ctx.prefill-cache',
        () => {
          const pf = stripComments(read('electron/services/providers/prefill-cache.ts'))
          const core = /export function withPrefillCacheMarkers/.test(pf) && /cache_control/.test(pf)
          if (!core) return { score: 15, hit: null }
          // LOAD-BEARING on the REQUEST path: both send sites (chatOnce + chatStream) must mark,
          // not merely import. A marker helper nothing calls buys no cache hit.
          const reg = stripComments(read('electron/services/providers/registry.ts'))
          const sendSites = (reg.match(/messages:\s*withPrefillCacheMarkers\(/g) || []).length
          if (sendSites < 2) return { score: 32, hit: { file: `marker core present, ${sendSites}/2 send sites wired` } }
          // CORRECTNESS GATE, not a bonus: an Anthropic cache WRITE costs ~1.25x input and only pays
          // back on a later READ. Marking a prefix that changes every turn (the legacy layout, where
          // message[0] carries the per-turn CONTEXT) writes an entry nothing can ever match — a
          // permanent surcharge in exchange for zero hits. So a marker path that does NOT gate on the
          // stable layout is worse than no marker path at all, and scores below the unwired tier.
          const gated = /stableLayout/.test(pf) && /DUIN_STABLE_PREFIX/.test(pf)
          if (!gated) return { score: 25, hit: { file: 'markers wired but UNGATED — writes an unmatchable cache entry every turn under the legacy layout' } }
          // The markers only PAY OFF against a byte-stable prefix, so this sub-axis cannot outrun the
          // layout it depends on: full credit needs that layout to be the DEFAULT.
          const prod = stripComments(read('electron/services/local-brain/agui-grounding.ts'))
          const layoutDefaultOn = /return\s+layoutStablePrefixMessages\(/.test(prod) &&
            !/DUIN_STABLE_PREFIX['"\]\s]*===?\s*['"]1['"]/.test(prod)
          return layoutDefaultOn
            ? { score: 70, hit: { file: 'provider prefill cache (live)' } }
            : { score: 50, hit: { file: 'markers wired on both send sites + correctly gated; payoff awaits the stable layout becoming default' } }
        },
        'the provider request marks cache breakpoints (Anthropic cache_control via OpenRouter; other providers cache a stable prefix automatically) so the stable core + rolling history hit the prefill cache — a real first-token win, not just perceptual'),
      base('ctx.compression', 60, 'context is pruned/summarized under budget before re-send (partial — DUIN prunes; no iterative summary-update yet)'),
    ]],
  ]
}

// ── scoring ──
function scoreSub(s) {
  if (s.kind === 'baseline') return s.score
  if (s.kind === 'property') { const hit = s.probe(); return { score: hit ? s.present : s.absent, hit } }
  if (s.kind === 'tier') return s.probe()
  return null // scale handled async
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) return selftest()
  const AXES = await buildAxes()
  const rows = []
  const axisScores = []
  for (const [axis, subs] of AXES) {
    const subScored = []
    for (const s of subs) {
      let score, detail = '', landed
      if (s.kind === 'scale') {
        let r
        try { r = await s.benchThunk() } catch { r = null }
        if (r && r.present) { score = r.score; detail = r.detail; landed = true }
        else { score = s.absent; detail = 'pure core absent — not yet measurable'; landed = false }
      } else if (s.kind === 'baseline') {
        score = s.score; landed = true
      } else if (s.kind === 'tier') {
        // may be async: a tier can IMPORT and RUN a pure core to verify its property
        const r = await s.probe(); score = r.score; landed = !!r.hit; detail = r.hit?.file ?? ''
      } else {
        const hit = s.probe(); score = hit ? s.present : s.absent; landed = !!hit
      }
      subScored.push({ id: s.id, kind: s.kind, score, detail, landed, note: s.note })
    }
    const axisScore = Math.round(subScored.reduce((a, b) => a + b.score, 0) / subScored.length)
    axisScores.push(axisScore)
    rows.push({ axis, axisScore, subs: subScored })
  }
  const overall = Math.round(axisScores.reduce((a, b) => a + b, 0) / axisScores.length)

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ overall, axes: rows }, null, 2))
    return
  }
  const bar = (n) => '█'.repeat(Math.round(n / 5)).padEnd(20)
  console.log('\n  DUIN EFFICIENCY — code-property + scaling-ratio instrument\n')
  for (const r of rows) console.log(`  ${r.axis.padEnd(12)} ${bar(r.axisScore)} ${r.axisScore}`)
  console.log('  ' + '─'.repeat(74))
  console.log(`  OVERALL${' '.repeat(53)}${overall}\n`)
  console.log('  Lowest sub-axes (the work-list, lowest first):')
  const flat = rows.flatMap((r) => r.subs.map((s) => ({ ...s, axis: r.axis })))
  flat.sort((a, b) => a.score - b.score)
  for (const s of flat.slice(0, 8)) {
    const tag = s.kind === 'scale' ? '[ratio]' : s.kind === 'baseline' ? '[base ]' : '[prop ]'
    console.log(`    ${String(s.score).padStart(3)} ${tag} ${s.id.padEnd(30)} ${s.landed ? '' : '← absent'} ${s.detail}`)
  }
  console.log('')
}

// ── selftest: prove the ratio harness distinguishes O(n) from O(n²) ──
function selftest() {
  // O(n) reference: touch each unit once.
  const linear = (size) => { let a = 0; for (let i = 0; i < size * 200; i++) a += i; return a }
  // O(n²) reference: the "re-parse the whole prefix on every token" shape.
  const quadratic = (size) => { let a = 0; for (let k = 1; k <= size; k++) for (let j = 0; j < k; j++) a += j; return a }
  const L = ratioScore((n) => linear(n), { n: 3000, absent: 20, present: 80 })
  const Q = ratioScore((n) => quadratic(n), { n: 1500, absent: 20, present: 80 })
  console.log('\n  Ratio-harness selftest (score by t(2n)/t(n); linear≈2 → high, quadratic≈4 → low):')
  console.log(`    O(n)  reference : ratio ${L.ratio}  → score ${L.score}  ${L.score >= 65 ? 'PASS' : 'FAIL'}`)
  console.log(`    O(n²) reference : ratio ${Q.ratio}  → score ${Q.score}  ${Q.score <= 40 ? 'PASS' : 'FAIL'}`)
  console.log(`    verdict: ${L.score >= 65 && Q.score <= 40 ? 'HARNESS OK — distinguishes linear from quadratic' : 'HARNESS NEEDS TUNING'}\n`)
}

main()
