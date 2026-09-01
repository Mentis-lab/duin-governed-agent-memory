"""LoCoMo harness for DUIN (scratchpad-only; does not modify the repo).

Protocol
  - Dataset: snap-research/locomo  data/locomo10.json (10 conversations, 1986 QA).
  - Scored set: categories 1-4 (multi-hop / temporal / open-domain / single-hop).
    Category 5 is adversarial (no gold `answer`, only `adversarial_answer`) and is
    excluded from the headline J-score, matching the Mem0/LoCoMo-memory convention.
  - Ingest: one markdown note per conversation session, date-stamped, written to an
    isolated vault; DUIN is repointed at that vault and reindexes it.
  - Ask: POST /agui (DUIN's full pipeline: retrieval + claim-metabolism), SSE answer.
  - Judge: LLM-as-judge (J-score) = fraction of answers judged semantically correct
    against the gold answer.

Reuses the repo's proven adapters from bench/longmemeval/lme_harness.py
(duin_repoint / wait_index_ready / duin_ask / oneai_call) by importing that file.
"""
import argparse, json, os, random, re, sys, time, importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
LME = Path(os.environ.get("DUIN_LME_HARNESS", str(HERE.parent / "longmemeval" / "lme_harness.py")))
DATA = HERE / "locomo" / "locomo10.json"
VAULT = HERE / "vault"

_spec = importlib.util.spec_from_file_location("lme", str(LME))
lme = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lme)

SCORED_CATEGORIES = (1, 2, 3, 4)
CAT_NAME = {1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "single-hop", 5: "adversarial"}


# ─────────────────────────── dataset ───────────────────────────
def load():
    return json.load(open(DATA, encoding="utf-8"))


def session_ids(conv):
    ids = [k for k in conv if re.fullmatch(r"session_\d+", k)]
    return sorted(ids, key=lambda k: int(k.split("_")[1]))


def convert_conversation(sample):
    """One dated markdown note per session — the haystack DUIN indexes."""
    conv = sample["conversation"]
    notes = []
    for sid in session_ids(conv):
        date = conv.get(f"{sid}_date_time", "")
        lines = [f"# Conversation on {date}", ""]
        for turn in conv[sid]:
            text = (turn.get("text") or "").strip()
            cap = turn.get("blip_caption")
            if cap:
                text += f" [shared an image: {cap}]"
            lines.append(f"**{turn.get('speaker','?')}:** {text}")
            lines.append("")
        notes.append((f"{sample['sample_id']}_{sid}.md", "\n".join(lines)))
    return notes


def write_vault(sample, vault: Path):
    if vault.exists():
        for p in vault.glob("*.md"):
            p.unlink()
    vault.mkdir(parents=True, exist_ok=True)
    for name, content in convert_conversation(sample):
        (vault / name).write_text(content, encoding="utf-8")
    return len(list(vault.glob("*.md")))


def last_date(sample):
    conv = sample["conversation"]
    sids = session_ids(conv)
    return conv.get(f"{sids[-1]}_date_time", "") if sids else ""


# ─────────────────────────── sampling (pre-registered) ───────────────────────────
def sample_questions(data, n, seed=0):
    """Proportional stratified sample over categories 1-4, drawn across ALL 10
       conversations. Fixed seed => reproducible. No conversation is dropped."""
    pool = []
    for s in data:
        for i, q in enumerate(s["qa"]):
            if q.get("category") in SCORED_CATEGORIES and q.get("answer") is not None:
                pool.append({"sample_id": s["sample_id"], "qi": i, "category": q["category"],
                             "question": q["question"], "answer": q["answer"],
                             "evidence": q.get("evidence", [])})
    rng = random.Random(seed)
    by_cat = {c: [p for p in pool if p["category"] == c] for c in SCORED_CATEGORIES}
    total = len(pool)
    picked = []
    for c in SCORED_CATEGORIES:
        k = round(n * len(by_cat[c]) / total)
        picked += rng.sample(by_cat[c], min(k, len(by_cat[c])))
    rng.shuffle(picked)
    return picked


# ─────────────────────────── ask / judge ───────────────────────────
ASK_TMPL = ("{q}\n\n(Today's date is {d}. Answer from what you remember of the "
            "conversations, as briefly as possible — a short phrase or date, no explanation.)")


def ask_one(item, today, hard_deadline=180):
    inst = {"question": item["question"], "question_date": today}
    body_q = ASK_TMPL.format(q=item["question"], d=today)
    inst_shim = {"question": body_q, "question_date": today}
    # lme.duin_ask formats via ask_text(); pass a pre-built question and strip its own suffix
    original = lme.ask_text
    lme.ask_text = lambda i: i["question"]
    try:
        return lme.duin_ask(inst_shim, timeout=hard_deadline + 20, hard_deadline=hard_deadline)
    finally:
        lme.ask_text = original


JUDGE = (
    "Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given:\n"
    "(1) a question about a long conversation, (2) a 'gold' (ground truth) answer, and "
    "(3) a generated answer produced by a model.\n\n"
    "Label the generated answer CORRECT if it conveys the same information as the gold answer, "
    "even if it is phrased differently, is more verbose, or adds correct extra detail. "
    "Label it WRONG if it contradicts the gold answer, misses the key information, refuses, "
    "or says it does not know.\n\n"
    "Question: {q}\nGold answer: {a}\nGenerated answer: {r}\n\n"
    "Reply with exactly one word: CORRECT or WRONG."
)


def judge_one(item, hyp):
    if not hyp or hyp.startswith("__ERROR__"):
        return False, "no-answer"
    prompt = JUDGE.format(q=item["question"], a=item["answer"], r=hyp)
    out = (lme.oneai_call(prompt, max_tokens=2000) or "").strip()
    verdict = out.upper()
    return ("CORRECT" in verdict and "WRONG" not in verdict), out[:80]


# ─────────────────────────── run ───────────────────────────
def run(n, seed, out_path, resume=True):
    data = load()
    by_id = {s["sample_id"]: s for s in data}
    picked = sample_questions(data, n, seed)
    groups = {}
    for p in picked:
        groups.setdefault(p["sample_id"], []).append(p)

    done = {}
    outp = Path(out_path)
    if resume and outp.exists():
        for line in outp.open(encoding="utf-8"):
            if line.strip():
                r = json.loads(line)
                done[(r["sample_id"], r["qi"])] = r
        print(f"[resume] {len(done)} already recorded")

    fh = outp.open("a", encoding="utf-8")
    t_run = time.time()
    n_done = 0
    for sid in sorted(groups):
        items = [i for i in groups[sid] if (i["sample_id"], i["qi"]) not in done]
        if not items:
            continue
        sample = by_id[sid]
        docs = write_vault(sample, VAULT)
        lme.duin_repoint(VAULT)
        ready = lme.wait_index_ready(docs, max_wait=240)
        today = last_date(sample)
        print(f"[{sid}] {docs} session notes indexed (ready={ready}) — {len(items)} questions")
        for it in items:
            t0 = time.time()
            try:
                hyp = ask_one(it, today)
            except Exception as e:
                hyp = f"__ERROR__ {type(e).__name__}: {e}"[:300]
            dt = time.time() - t0
            try:
                ok, raw = judge_one(it, hyp)
            except Exception as e:
                ok, raw = False, f"judge-error {type(e).__name__}"
            rec = dict(it, hyp=hyp, correct=bool(ok), judge_raw=raw, secs=round(dt, 1), docs=docs)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            n_done += 1
            print(f"  [{n_done}/{len(picked)-len(done)}] cat{it['category']} {dt:4.1f}s "
                  f"{'OK ' if ok else 'X  '} {it['question'][:58]!r} -> {hyp[:60]!r}")
    fh.close()
    print(f"\nrun wall-clock: {(time.time()-t_run)/60:.1f} min")
    score(out_path)


def score(out_path):
    recs = [json.loads(l) for l in Path(out_path).open(encoding="utf-8") if l.strip()]
    if not recs:
        print("no records"); return
    n = len(recs)
    c = sum(1 for r in recs if r["correct"])
    print(f"\n=== LoCoMo J-score (LLM-as-judge) ===")
    print(f"Overall J : {c}/{n} = {100*c/n:.1f}%")
    for cat in SCORED_CATEGORIES:
        rs = [r for r in recs if r["category"] == cat]
        if rs:
            k = sum(1 for r in rs if r["correct"])
            print(f"  cat{cat} {CAT_NAME[cat]:<12} {k:3}/{len(rs):<3} = {100*k/len(rs):5.1f}%")
    cats = [c_ for c_ in SCORED_CATEGORIES if any(r["category"] == c_ for r in recs)]
    macro = sum(sum(1 for r in recs if r["category"] == c_ and r["correct"]) /
                sum(1 for r in recs if r["category"] == c_) for c_ in cats) / len(cats)
    print(f"Category-macro average: {100*macro:.1f}%")
    errs = sum(1 for r in recs if str(r["hyp"]).startswith("__ERROR__"))
    med = sorted(r["secs"] for r in recs)[n // 2]
    print(f"errors: {errs}   median latency: {med:.1f}s   convs: {len(set(r['sample_id'] for r in recs))}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run"); r.add_argument("--n", type=int, default=200)
    r.add_argument("--seed", type=int, default=0); r.add_argument("--out", default=str(HERE / "runs" / "duin_locomo.jsonl"))
    s = sub.add_parser("score"); s.add_argument("--out", default=str(HERE / "runs" / "duin_locomo.jsonl"))
    p = sub.add_parser("plan"); p.add_argument("--n", type=int, default=200); p.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "run":
        Path(a.out).parent.mkdir(parents=True, exist_ok=True); run(a.n, a.seed, a.out)
    elif a.cmd == "score":
        score(a.out)
    else:
        data = load(); pk = sample_questions(data, a.n, a.seed)
        import collections
        print("sampled", len(pk), "questions")
        print("by category", sorted(collections.Counter(p["category"] for p in pk).items()))
        print("by conversation", sorted(collections.Counter(p["sample_id"] for p in pk).items()))
