#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""vault-eval — score DUIN on the operator's REAL vault, with operator-set criteria.

Why not LoCoMo / LongMemEval: those measure single-hop lookup over unstructured synthetic chat.
DUIN's edge is multi-hop navigation over a structured, curated corpus. A benchmark whose corpus does
not resemble yours yields verdicts that are advisory at best — and in one case it nearly got a
load-bearing component deleted. See README.md.

Grading is DETERMINISTIC (substring match over the answer), so a run is reproducible, costs no judge
tokens, and can run unattended. It deliberately under-measures prose quality: it checks whether
load-bearing facts are PRESENT. Presence is what regresses silently; style does not.

Usage:
    python vault_eval.py run [--effort low|medium|high|max] [--only Q1,Q7] [--label baseline]
    python vault_eval.py score runs/<file>.json
"""
from __future__ import annotations
import argparse, json, os, statistics, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"
BRAIN = os.environ.get("DUIN_BRAIN_URL", "http://127.0.0.1:8799")
HARD_DEADLINE = 300


# ───────────────────────── brain I/O ─────────────────────────
def brain_up(timeout: int = 6) -> bool:
    try:
        urllib.request.urlopen(f"{BRAIN}/state/claim-metabolism", timeout=timeout)
        return True
    except Exception:
        return False


def revive(max_wait: int = 150) -> bool:
    """The operator's DUIN is restarted by other sessions' deploys; don't die on a transient gap."""
    subprocess.run(["schtasks", "/Run", "/TN", "DUIN-launch"], capture_output=True)
    t0 = time.time()
    while time.time() - t0 < max_wait:
        time.sleep(6)
        if brain_up():
            return True
    return False


def ask(q: str, effort: str | None) -> tuple[str, float, int]:
    """POST /agui, accumulate TEXT_MESSAGE_CONTENT deltas. Returns (answer, seconds, tool_calls)."""
    body: dict = {"messages": [{"role": "user", "content": q}]}
    if effort:
        body["reasoningEffort"] = effort
    req = urllib.request.Request(
        f"{BRAIN}/agui", data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    parts, tools, t0 = [], 0, time.time()
    with urllib.request.urlopen(req, timeout=HARD_DEADLINE) as resp:
        for raw in resp:
            if time.time() - t0 > HARD_DEADLINE:
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            try:
                frame = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            kind = frame.get("type")
            if kind == "TEXT_MESSAGE_CONTENT" and "delta" in frame:
                parts.append(frame["delta"])
            elif kind == "TOOL_CALL_START":
                tools += 1
            elif kind in ("RUN_FINISHED", "RUN_ERROR"):
                break
    return "".join(parts).strip(), round(time.time() - t0, 1), tools


# ───────────────────────── scoring (pure) ─────────────────────────
def check(answer: str, crit: dict) -> bool:
    """A criterion passes when ANY of its `any_of` appears, or NONE of its `none_of` appears."""
    a = (answer or "").lower()
    if "any_of" in crit:
        return any(str(s).lower() in a for s in crit["any_of"])
    if "none_of" in crit:
        return not any(str(s).lower() in a for s in crit["none_of"])
    return True


def score_one(item: dict, answer: str) -> dict:
    crits = list(item.get("criteria", [])) + list(item.get("must_not", []))
    results = [{"label": c.get("label", "?"), "source": c.get("source", "?"), "pass": check(answer, c)}
               for c in crits]
    passed = sum(1 for r in results if r["pass"])
    # An empty answer is a failure regardless of criteria — a criterion list cannot pass on nothing.
    empty = not (answer or "").strip()
    return {
        "id": item["id"], "q": item["q"], "dimensions": item.get("dimensions", []),
        "criteria": results, "passed": 0 if empty else passed, "total": len(crits),
        "rate": 0.0 if (empty or not crits) else round(passed / len(crits), 3),
        "empty": empty,
    }


def aggregate(scored: list[dict]) -> dict:
    by_dim: dict[str, list[float]] = {}
    for s in scored:
        for d in s["dimensions"]:
            by_dim.setdefault(d, []).append(s["rate"])
    crit_total = sum(s["total"] for s in scored)
    crit_pass = sum(s["passed"] for s in scored)
    # `inferred` criteria are not operator-ratified; report the trustworthy subset separately so a
    # score cannot quietly rest on criteria derived from DUIN's own output.
    ratified = [r for s in scored for r in s["criteria"] if r["source"] in ("operator", "vault")]
    return {
        "questions": len(scored),
        "criteria_passed": crit_pass, "criteria_total": crit_total,
        "overall": round(crit_pass / crit_total, 3) if crit_total else 0.0,
        "ratified_only": round(sum(1 for r in ratified if r["pass"]) / len(ratified), 3) if ratified else None,
        "ratified_n": len(ratified),
        "by_dimension": {d: round(statistics.mean(v), 3) for d, v in sorted(by_dim.items())},
    }


# ───────────────────────── commands ─────────────────────────
def load_set() -> dict:
    return json.loads((HERE / "eval-set.json").read_text(encoding="utf-8"))


def cmd_run(args) -> int:
    data = load_set()
    only = {s.strip() for s in args.only.split(",")} if args.only else None
    items = [q for q in data["questions"]
             if q.get("enabled", True) and (not only or q["id"] in only)]
    if not items:
        print("no enabled questions selected"); return 1
    print(f"vault-eval: {len(items)} questions · effort={args.effort or 'default'} · {BRAIN}")
    rows = []
    for i, item in enumerate(items, 1):
        if not brain_up() and not revive():
            print(f"  [{item['id']}] brain DOWN, could not revive — recording as empty")
            rows.append({**item, "answer": "", "seconds": None, "tools": 0}); continue
        try:
            answer, secs, tools = ask(item["q"], args.effort)
        except Exception as exc:
            answer, secs, tools = "", None, 0
            print(f"  [{item['id']}] ERROR {type(exc).__name__}: {exc}")
        rows.append({**item, "answer": answer, "seconds": secs, "tools": tools})
        s = score_one(item, answer)
        print(f"  [{i}/{len(items)}] {item['id']:<3} {str(secs)+'s':>7} {tools:>3} tools  "
              f"criteria {s['passed']}/{s['total']}")
    scored = [score_one(r, r["answer"]) for r in rows]
    agg = aggregate(scored)
    RUNS.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = RUNS / f"{stamp}-{args.label or (args.effort or 'default')}.json"
    lat = [r["seconds"] for r in rows if r["seconds"]]
    out.write_text(json.dumps({
        "run": stamp, "label": args.label, "effort": args.effort, "brain": BRAIN,
        "set_version": data.get("version"), "corpus": data.get("corpus"),
        "latency": {"median": statistics.median(lat) if lat else None,
                    "mean": round(statistics.mean(lat), 1) if lat else None,
                    "total": round(sum(lat), 1) if lat else None},
        "tools_mean": round(statistics.mean([r["tools"] for r in rows]), 1) if rows else 0,
        "summary": agg, "scored": scored, "rows": rows,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    report(agg, out, lat, rows)
    return 0


def report(agg: dict, path: Path, lat: list, rows: list) -> None:
    print(f"\n=== vault-eval — {path.name} ===")
    print(f"  criteria passed : {agg['criteria_passed']}/{agg['criteria_total']}  ({agg['overall']:.1%})")
    if agg["ratified_only"] is not None:
        print(f"  operator/vault-ratified criteria only: {agg['ratified_only']:.1%} (n={agg['ratified_n']})")
    if lat:
        print(f"  latency         : median {statistics.median(lat):.1f}s · total {sum(lat):.0f}s")
        print(f"  tool calls      : mean {statistics.mean([r['tools'] for r in rows]):.1f}")
    print("  by dimension:")
    for d, v in agg["by_dimension"].items():
        print(f"    {d:<18} {v:.1%}")


def cmd_score(args) -> int:
    payload = json.loads(Path(args.path).read_text(encoding="utf-8"))
    data = load_set()
    by_id = {q["id"]: q for q in data["questions"]}
    scored = [score_one(by_id.get(r["id"], r), r.get("answer", "")) for r in payload["rows"]]
    agg = aggregate(scored)
    lat = [r["seconds"] for r in payload["rows"] if r.get("seconds")]
    report(agg, Path(args.path), lat, payload["rows"])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.set_defaults(fn=cmd_run)
    r.add_argument("--effort", choices=["low", "medium", "high", "max"])
    r.add_argument("--only"); r.add_argument("--label")
    s = sub.add_parser("score"); s.set_defaults(fn=cmd_score); s.add_argument("path")
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
