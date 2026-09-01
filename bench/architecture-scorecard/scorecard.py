#!/usr/bin/env python3
"""
DUIN Architecture Scorecard — a GROUNDED, REPEATABLE replacement for the blind LLM panel's
Architecture axis (which had ±20pt framing noise). Every input is a COMPUTED code-health metric,
so the score moves ONLY when the architecture actually changes — zero framing variance.

Read-only: scans the tree, computes metrics, applies a TRANSPARENT rubric (each metric shows its
value, target, and sub-score), emits JSON + a human report. Run on any commit; diff two runs to
see real architectural movement.

    python scorecard.py                # score the current tree
    python scorecard.py --json out.json

Rubric is anchored to the project's OWN north stars (DUIN_COHESION_ROADMAP + DUIN_BRAIN_UNIFICATION_SPEC):
one TS brain behind :8799, decomposed brain/core, no duplicated agent loop, typed errors.
"""
import os, re, sys, json, glob, io

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # repo root
ELECTRON = os.path.join(ROOT, 'electron')

def read(p):
    try: return io.open(p, encoding='utf-8', errors='replace').read()
    except Exception: return ''

def ts_files():
    out = []
    for base, _, files in os.walk(ELECTRON):
        if 'node_modules' in base: continue
        for f in files:
            if f.endswith('.ts') and not f.endswith('.test.ts') and not f.endswith('.d.ts'):
                out.append(os.path.join(base, f))
    return out

def loc(p):
    return sum(1 for _ in io.open(p, encoding='utf-8', errors='replace'))

# ── metric collectors ───────────────────────────────────────────────────────────────────────
def collect():
    files = ts_files()
    locs = [(p, loc(p)) for p in files]
    locs.sort(key=lambda x: -x[1])
    total_loc = sum(l for _, l in locs)

    # M1 MONOLITH — large-file burden. north star: no source file > 1500 LOC.
    over2000 = [(os.path.relpath(p, ROOT), l) for p, l in locs if l > 2000]
    over1000 = [(os.path.relpath(p, ROOT), l) for p, l in locs if l > 1000]
    max_loc = locs[0][1] if locs else 0

    # M2 TWO-ENGINE SEAM — does the /agui brain loop (server.ts) REUSE lamprey's mature agent
    # machinery (toolRegistry/mcpManager/capabilityTracker/fallback), or reimplement its own dispatch?
    server = read(os.path.join(ELECTRON, 'services', 'local-brain', 'server.ts'))
    chat = read(os.path.join(ELECTRON, 'ipc', 'chat.ts'))
    machinery = r'toolRegistry|mcpManager|capabilityTracker|filterToolsForRole|normalizeToolsForProvider|parseFallbackToolCalls'
    brain_shared = len(re.findall(machinery, server))
    chat_shared = len(re.findall(machinery, chat))
    dup_dispatch = 1 if 'dispatchSubagentTool' in server else 0  # divergent 2nd dispatch path present

    # M3 BRAIN-UNIFICATION STRANGLER — how much still depends on the Python sidecar (:8765)?
    proxy_refs = len(re.findall(r'sidecar|:8765|proxyToSidecar|getBrainSidecarOrigin|brain-sidecar', server + chat + read(os.path.join(ELECTRON,'main.ts'))))
    py_engine = 1 if os.path.exists(os.path.join(ROOT, 'resources', 'brain')) or glob.glob(os.path.join(ROOT,'**','server.py'), recursive=True) else 0

    # M4 CODE HEALTH — typed errors (spec: guarded() replaces blanket catch{}) + type safety + smells.
    all_src = ''.join(read(p) for p, _ in locs)
    empty_catch = len(re.findall(r'catch\s*(\([^)]*\))?\s*\{\s*\}', all_src)) + len(re.findall(r'catch\s*(\([^)]*\))?\s*\{\s*/\*', all_src))
    any_use = len(re.findall(r':\s*any\b|as any\b', all_src))
    todos = len(re.findall(r'//\s*(TODO|FIXME|HACK|XXX)', all_src))
    test_files = len(glob.glob(os.path.join(ELECTRON, '**', '*.test.ts'), recursive=True))
    src_files = len(files)

    return dict(
        files=src_files, total_loc=total_loc, max_loc=max_loc,
        over2000=over2000, over1000=over1000,
        brain_shared=brain_shared, chat_shared=chat_shared, dup_dispatch=dup_dispatch,
        proxy_refs=proxy_refs, py_engine=py_engine,
        empty_catch=empty_catch, any_use=any_use, todos=todos,
        test_files=test_files,
    )

# ── transparent rubric: each dimension → sub-score 0..100 with the reason shown ────────────────
def clamp(x): return max(0.0, min(100.0, x))

def score(m):
    # Calibrated so a clean, well-factored TS codebase scores ~85, and each real fix moves the
    # number predictably. Absolute is anchored to be HONEST (not the panel's generous 70); the
    # primary use is the DELTA between runs — deterministic, no framing noise.
    dims = []
    # Monolith (25): penalize by the FRACTION of code sitting in oversized files (more meaningful
    # than one max), plus a max-file ceiling term. Full marks when no file dominates.
    big_loc = sum(l for _, l in m['over1000'])
    frac_big = big_loc / max(m['total_loc'], 1)
    mono = clamp(100 - frac_big * 160 - max(0, m['max_loc'] - 2000) / 8000 * 100 - 4 * len(m['over2000']))
    dims.append(('Monolith / file size', 0.25, mono,
                 f"max {m['max_loc']} LOC; {len(m['over2000'])}>2000, {len(m['over1000'])}>1000; {frac_big:.0%} of code in >1000-LOC files (target: <10%)"))
    # Engine unification (30): the deepest seam. Reward the brain loop SHARING lamprey's agent
    # machinery; a duplicated subagent dispatch is a graded (−25) debt, not an instant zero.
    unif = clamp(20 + (min(m['brain_shared'], 12) / 12) * 80 - (25 if m['dup_dispatch'] else 0))
    dims.append(('Agent-engine unification', 0.30, unif,
                 f"brain loop reuses lamprey tool-machinery {m['brain_shared']}x vs ipc/chat.ts {m['chat_shared']}x; duplicated subagent dispatch: {'YES' if m['dup_dispatch'] else 'no'}"))
    # One-TS-brain progress (20): the Python sidecar is INTENTIONAL today (graceful degradation);
    # the north star retires it. Score as progress: retired=100, present-but-modular=~45.
    stran = clamp((100 if not m['py_engine'] else 45) - min(m['proxy_refs'], 20) * 1.0)
    dims.append(('One-TS-brain progress', 0.20, stran,
                 f"python engine present: {'YES (north star: retire)' if m['py_engine'] else 'no'}; sidecar/proxy refs: {m['proxy_refs']}"))
    # Code health (25): typed errors + type safety + test coverage (357 test files is a real strength).
    cov = min(1.0, m['test_files'] / max(m['files'], 1) / 0.6)  # ~0.6 test:src ratio = full coverage credit
    health = clamp(55 + cov * 45 - min(m['empty_catch'], 300) * 0.08 - min(m['any_use'], 500) * 0.03 - min(m['todos'], 100) * 0.2)
    dims.append(('Code health (errors / types / tests)', 0.25, health,
                 f"{m['empty_catch']} blanket catch{{}}; {m['any_use']} any; {m['todos']} TODO; {m['test_files']} test files ({cov:.0%} coverage credit)"))
    composite = sum(w * s for _, w, s, _ in dims)
    return composite, dims

def main():
    m = collect()
    comp, dims = score(m)
    lines = []
    lines.append('=== DUIN Architecture Scorecard (grounded, repeatable) ===')
    lines.append(f'Source: {m["files"]} .ts files, {m["total_loc"]:,} LOC, {m["test_files"]} test files')
    lines.append('')
    lines.append(f'{"Dimension":36s} {"wt":>4s} {"score":>6s}   evidence')
    for name, w, s, why in dims:
        lines.append(f'{name:36s} {w:>4.0%} {s:>6.1f}   {why}')
    lines.append('')
    lines.append(f'ARCHITECTURE SCORE: {comp:.1f} / 100   (blind panel last read 70 — ±20 noise; this is deterministic)')
    lines.append('')
    lines.append('Biggest files (the monolith targets):')
    for p, l in m['over1000'][:6]:
        lines.append(f'  {l:>6d}  {p}')
    report = '\n'.join(lines)
    print(report)
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]
        io.open(out, 'w', encoding='utf-8').write(json.dumps({'score': comp, 'metrics': m,
            'dimensions': [{'name': n, 'weight': w, 'score': s, 'evidence': e} for n, w, s, e in dims]}, indent=2, default=str))
        print(f'\n-> {out}')

if __name__ == '__main__':
    main()
