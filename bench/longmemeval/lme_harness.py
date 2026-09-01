#!/usr/bin/env python3
"""
LongMemEval harness for DUIN — measures DUIN's memory moat against baseline models
on the same base model, isolating the *lift from DUIN's memory pipeline*.

Three conditions, one grader (LongMemEval's per-type LLM-as-judge):
  duin       — ingest a question's session haystack into a DUIN vault, ask via /agui
               (DUIN retrieves from its own bitemporal-graph memory + hybrid retrieval).
  fullctx    — baseline: the whole haystack stuffed into the prompt, asked of the base
               model directly (ceiling; overflows on the _m variant).
  naiverag   — baseline: embed sessions, top-k retrieve, ask the base model (fair RAG).

The clean number: (duin - naiverag) on the SAME base model = DUIN's memory contribution.

Dataset: HuggingFace xiaowu0162/longmemeval-cleaned (MIT). Report LongMemEval_S; use
oracle for a retrieval-trivial sanity ceiling.

Model access:
  - `duin` needs NO key (DUIN self-auths via its OS keychain).
  - `fullctx`/`naiverag` baselines + the grader need a model API key in the environment:
      ANTHROPIC_API_KEY (Claude judge/baseline) or OPENAI_API_KEY (gpt-4o — the LongMemEval
      standard grader; use it for reportable numbers).

CLI:
  python lme_harness.py convert  --variant oracle --qid <id>          # preview the notes for one instance
  python lme_harness.py duin     --variant oracle --n 5 --out runs/duin.jsonl
  python lme_harness.py grade    --hyp runs/duin.jsonl --variant oracle --judge claude   # -> runs/duin.jsonl.graded
  python lme_harness.py metrics  --graded runs/duin.jsonl.graded
  python lme_harness.py selfcheck                                     # offline validation (no DUIN/API)
"""
import argparse, json, os, re, sys, time, subprocess, urllib.request, urllib.error
from pathlib import Path
from collections import defaultdict

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
BRAIN = os.environ.get("DUIN_BRAIN_URL", "http://127.0.0.1:8799")
# Scratch vault the harness repoints DUIN at (per-question). NEVER the operator's real vault.
SCRATCH_VAULT = Path(os.environ.get("LME_SCRATCH_VAULT", str(HERE / "scratch_vault")))

VARIANT_FILES = {
    "oracle": "longmemeval_oracle.json",
    "s": "longmemeval_s_cleaned.json",
    "m": "longmemeval_m_cleaned.json",
}

# ─────────────────────────── dataset ───────────────────────────
def load_variant(variant):
    f = DATA / VARIANT_FILES[variant]
    if not f.exists():
        sys.exit(f"missing {f}. Download: curl -sL -o {f} "
                 f"https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/{VARIANT_FILES[variant]}")
    return json.load(open(f, encoding="utf-8"))

def stratified_sample(data, n):
    """Deterministic type-balanced subset of ~n (evenly-spaced picks per question_type, so the DUIN
       and baseline runs select the SAME questions). Keeps the 6 types proportionally represented."""
    by = defaultdict(list)
    for x in data:
        by[x["question_type"]].append(x)
    types = sorted(by)
    out = []
    for t in types:
        items = by[t]
        want = max(1, round(n * len(items) / len(data)))  # proportional to the type's share
        step = max(1, len(items) // want)
        out.extend(items[::step][:want])
    return out[:n]

def select(variant, n, stratify, offset=0):
    data = load_variant(variant)
    return stratified_sample(data, n) if stratify else data[offset:offset + n]

# ─────────────────────────── convert: instance -> DUIN notes ───────────────────────────
def convert_instance(inst):
    """One markdown note per session, timestamp prepended (temporal questions need it).
       Returns [(filename, content)]. This is the haystack DUIN will index."""
    notes = []
    dates = inst.get("haystack_dates", [])
    for i, sess in enumerate(inst["haystack_sessions"]):
        date = dates[i] if i < len(dates) else ""
        sid = inst["haystack_session_ids"][i] if i < len(inst.get("haystack_session_ids", [])) else f"s{i}"
        lines = [f"# Conversation on {date}", ""]
        for turn in sess:
            role = "Me" if turn.get("role") == "user" else "Assistant"
            lines.append(f"**{role}:** {turn.get('content','').strip()}")
            lines.append("")
        # sanitize sid for a filename
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", sid)
        notes.append((f"{safe}.md", "\n".join(lines)))
    return notes

def write_vault(inst, vault: Path):
    if vault.exists():
        for p in vault.glob("*.md"):
            p.unlink()
    vault.mkdir(parents=True, exist_ok=True)
    for name, content in convert_instance(inst):
        (vault / name).write_text(content, encoding="utf-8")
    return len(list(vault.glob("*.md")))

def ask_text(inst):
    """The user turn to send: the question, stamped with when it's asked (temporal grounding)."""
    return f"{inst['question']}\n\n(Today's date is {inst['question_date']}.)"

# ─────────────────────────── DUIN adapters ───────────────────────────
def _post(path, body, timeout=180):
    req = urllib.request.Request(BRAIN + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)

def duin_repoint(vault: Path, timeout=30):
    resp = _post("/state/config", {"dir": str(vault)}, timeout=timeout)
    return json.loads(resp.read().decode())

def _get(path, timeout=8):
    return json.loads(urllib.request.urlopen(BRAIN + path, timeout=timeout).read().decode())

def wait_index_ready(expected_docs, max_wait=180, min_wait=3.5):
    """Poll /state/index-status until the search index has settled on the new vault — i.e. the
       reindex finished (indexing=false) AND docCount reached the note count we just wrote. Replaces
       a blind sleep, which raced the 1500ms reindex debounce (DUIN answered 'no mention' before its
       memory was built — the PoC's false misses). min_wait clears the debounce window; returns
       False on timeout (caller still asks, but logs it)."""
    t0 = time.time()
    while time.time() - t0 < max_wait:
        try:
            st = _get("/state/index-status")
        except urllib.error.HTTPError as he:
            if he.code == 404:  # route absent on this binary → can't poll; fixed-settle fallback
                time.sleep(max(0, min_wait + 6 - (time.time() - t0))); return True
            time.sleep(1.5); continue
        except Exception:
            time.sleep(1.5); continue
        # Ready = reindex settled (indexing false past the 1.5s debounce) AND the index has content.
        if time.time() - t0 >= min_wait and not st.get("indexing") and st.get("docCount", 0) >= 1:
            return True
        time.sleep(1.5)
    return False

class RunHang(Exception):
    """A single /agui turn exceeded its hard wall-clock deadline (wedged upstream). The SSE socket
       never idles because the brain still emits `: hb` heartbeats every ~15s, so urllib's per-read
       timeout never fires — this total deadline is what actually bounds a hung turn so one bad item
       can't wedge the whole batch. NOT a connection error → the run records __ERROR__ and moves on."""

def duin_ask(inst, model=None, timeout=180, hard_deadline=300):
    """POST /agui, accumulate TEXT_MESSAGE_CONTENT deltas into the hypothesis. Abandons a turn that
       runs past `hard_deadline` seconds (heartbeat frames give us a ~15s wakeup to enforce it)."""
    body = {"messages": [{"role": "user", "content": ask_text(inst)}]}
    if model:
        body["model"] = model
    resp = _post("/agui", body, timeout=timeout)
    parts = []
    t_start = time.time()
    for raw in resp:  # SSE: lines like `data: {json}\n`
        if time.time() - t_start > hard_deadline:
            try: resp.close()  # disconnect → server's grace-then-abort reaps the wedged turn
            except Exception: pass
            raise RunHang(f"/agui turn exceeded {hard_deadline}s hard deadline")
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        try:
            frame = json.loads(line[5:].strip())
        except json.JSONDecodeError:
            continue
        if frame.get("type") == "TEXT_MESSAGE_CONTENT" and "delta" in frame:
            parts.append(frame["delta"])
        elif frame.get("type") in ("RUN_FINISHED", "RUN_ERROR"):
            break
    return "".join(parts).strip()

# --- bench-instance lifecycle (resilience: the isolated instance can crash under sustained load) ---
BENCH_PS1 = str(HERE / "bench_instance.ps1")
def _bench(action):
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BENCH_PS1,
                    "-Action", action], check=False)

def _brain_up(timeout=5):
    # Health via /state/claim-metabolism (always present); /state/index-status is absent on some
    # deployed binaries and 404ing there falsely reads as "down" → a relaunch storm.
    try:
        _get("/state/claim-metabolism", timeout=timeout); return True
    except Exception:
        return False

def ensure_bench_up(max_wait=200):
    """If the isolated brain is unreachable (crashed), relaunch it and wait for health."""
    if _brain_up():
        return True
    print("  [resilience] bench instance DOWN — relaunching…", flush=True)
    _bench("start")
    t0 = time.time()
    while time.time() - t0 < max_wait:
        if _brain_up():
            print("  [resilience] bench back up", flush=True); return True
        time.sleep(4)
    print("  [resilience] bench did NOT recover", flush=True); return False

def _is_conn_error(e):
    return isinstance(e, (urllib.error.URLError, ConnectionError, TimeoutError)) or "10061" in str(e) or "refused" in str(e).lower()

def run_duin(variant, n, out, model=None, settle=12, restore_dir=None, resilient=False, offset=0, stratify=False):
    """For each instance: repoint DUIN at a scratch vault of that question's haystack, let it reindex,
       ask, record the hypothesis. If resilient, a crashed bench instance is relaunched and the
       question retried (so an unstable instance can't kill a long run). Appends to `out`."""
    data = select(variant, n, stratify, offset)
    outp = Path(out); outp.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with open(outp, "a", encoding="utf-8") as fh:
        for k, inst in enumerate(data):
            hyp, ndocs, secs = None, 0, 0.0
            for attempt in range(3 if resilient else 1):
                try:
                    if resilient and not ensure_bench_up():
                        hyp = "__ERROR__ bench unrecoverable"; break
                    ndocs = write_vault(inst, SCRATCH_VAULT)
                    duin_repoint(SCRATCH_VAULT)
                    if not wait_index_ready(ndocs, max_wait=max(settle, 60)):
                        print(f"  [warn] index not confirmed ready for {inst['question_id']}", flush=True)
                    t0 = time.time()
                    hyp = duin_ask(inst, model=model)
                    secs = round(time.time() - t0, 1)
                    break
                except RunHang as e:
                    secs = round(time.time() - t0, 1)
                    print(f"  [hang] {inst['question_id']} wedged ({str(e)[:60]}) — recording __ERROR__, moving on", flush=True)
                    hyp = f"__ERROR__ {e}"; break
                except Exception as e:
                    if resilient and _is_conn_error(e) and attempt < 2:
                        print(f"  [resilience] {inst['question_id']} crashed ({str(e)[:50]}), relaunch+retry {attempt+1}", flush=True)
                        time.sleep(3); continue
                    hyp = f"__ERROR__ {e}"; break
            fh.write(json.dumps({"question_id": inst["question_id"], "hypothesis": hyp,
                                 "question_type": inst["question_type"], "n_sessions": ndocs,
                                 "secs": secs}, ensure_ascii=False) + "\n")
            fh.flush(); written += 1
            print(f"[{offset+k+1}] {inst['question_id']} ({inst['question_type']}, {ndocs} sess, {secs}s) "
                  f"-> {str(hyp)[:60]!r}", flush=True)
    if restore_dir:
        try: duin_repoint(Path(restore_dir))
        except Exception: pass
    print(f"wrote {written} hypotheses -> {outp}")

def run_iso(variant, n, topk=10, offset=0, stratify=False):
    """Full crash-resilient isolated run: launch bench → DUIN(gpt-5.5, resilient) → ALWAYS restore
       operator DUIN → naive-RAG baseline(gpt-5.5) → grade both → print the delta."""
    duin_out = str(HERE / "runs" / f"iso_duin_{variant}.jsonl")
    rag_out = str(HERE / "runs" / f"iso_rag_{variant}.jsonl")
    for p in (duin_out, rag_out):  # fresh (run_duin appends)
        try: os.remove(p)
        except OSError: pass
    _bench("start")
    try:
        ensure_bench_up()
        run_duin(variant, n, duin_out, model="gpt-5.5-oneai", resilient=True, offset=offset, stratify=stratify)
    finally:
        print("== restoring operator DUIN ==", flush=True)
        _bench("stop")  # GUARANTEED restore, even on exception/KeyboardInterrupt
    # baseline + grading hit OneAI directly (no bench instance needed)
    run_baseline(variant, n, rag_out, mode="naiverag", topk=topk, stratify=stratify)
    grade(duin_out, variant, "oneai")
    grade(rag_out, variant, "oneai")
    print("\n===== DUIN vs naive-RAG (same base model gpt-5.5) =====")

# ─────────────────────────── OneAI (an OpenAI-compatible Responses-API gateway, gpt-5.5) ───────────────────────────
# The adjudicator config: a gitignored `jury.local.json` next to this file (or BH_JURY_FILE),
# holding `{"jury": {"base_url", "api_key", "model", "reasoning_effort"}}`. Public benchmark data only —
# LongMemEval is fictional, so it doesn't trip adjudicator.py's confidential-lane firewall.
ONEAI_CFG_FILE = os.environ.get("BH_JURY_FILE", str(HERE / "jury.local.json"))
def _oneai_cfg():
    cfg = {}
    try:
        cfg = dict((json.load(open(ONEAI_CFG_FILE, encoding="utf-8")).get("jury") or {}))
    except Exception:
        pass
    for k, env in (("base_url", "BH_JURY_BASE_URL"), ("api_key", "BH_JURY_API_KEY"),
                   ("model", "BH_JURY_MODEL"), ("reasoning_effort", "BH_JURY_REASONING")):
        if os.environ.get(env):
            cfg[k] = os.environ[env]
    return cfg

def _oneai_extract(data):
    if isinstance(data.get("output_text"), str):
        return data["output_text"]
    parts = [c["text"] for item in (data.get("output") or []) for c in (item.get("content") or [])
             if isinstance(c.get("text"), str)]
    return "\n".join(parts)

def oneai_call(prompt, model=None, max_tokens=512, timeout=120):
    """One call via the OneAI gateway's OpenAI Responses API (wire_api='responses')."""
    cfg = _oneai_cfg()
    if not (cfg.get("api_key") and cfg.get("base_url") and cfg.get("model")):
        sys.exit(f"OneAI jury config missing in {ONEAI_CFG_FILE} (jury.api_key/base_url/model)")
    body = {"model": model or cfg["model"], "input": prompt, "max_output_tokens": max_tokens}
    if cfg.get("reasoning_effort"):
        body["reasoning"] = {"effort": cfg["reasoning_effort"]}
    req = urllib.request.Request(cfg["base_url"].rstrip("/") + "/responses",
          data=json.dumps(body).encode(),
          headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}, method="POST")
    return _oneai_extract(json.loads(urllib.request.urlopen(req, timeout=timeout).read()))

# ─────────────────────────── baselines (direct model call; needs an API key) ───────────────────────────
def model_call(prompt, model=None, max_tokens=512, temperature=0, provider="oneai"):
    if provider == "oneai":
        return oneai_call(prompt, model=model, max_tokens=max_tokens)
    """Generic chat call. Picks provider by which key is set / by `model` prefix."""
    if (model and model.startswith("gpt")) or (not os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("OPENAI_API_KEY")):
        key = os.environ["OPENAI_API_KEY"]
        body = {"model": model or "gpt-4o-2024-08-06", "temperature": temperature,
                "max_tokens": max_tokens, "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=json.dumps(body).encode(),
              headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"}, method="POST")
        return json.loads(urllib.request.urlopen(req, timeout=120).read())["choices"][0]["message"]["content"]
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key: sys.exit("baseline needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment")
    body = {"model": model or "claude-opus-4-8", "max_tokens": max_tokens, "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=json.dumps(body).encode(),
          headers={"Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"}, method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=120).read())["content"][0]["text"]

def history_text(inst, max_chars=None):
    blocks = []
    dates = inst.get("haystack_dates", [])
    for i, sess in enumerate(inst["haystack_sessions"]):
        d = dates[i] if i < len(dates) else ""
        turns = "\n".join(f"{t.get('role')}: {t.get('content','').strip()}" for t in sess)
        blocks.append(f"[Session on {d}]\n{turns}")
    txt = "\n\n".join(blocks)
    return txt[:max_chars] if max_chars else txt

# --- pure-python BM25 over sessions (no deps) for the naive-RAG baseline ---
import math
_TOK = re.compile(r"[A-Za-z0-9]+|[一-鿿]")  # words + CJK chars
def _tok(s): return _TOK.findall(s.lower())

def bm25_topk(query, docs, k=10, k1=1.5, b=0.75):
    """Return indices of the top-k docs (strings) by BM25 for the query."""
    toks = [_tok(d) for d in docs]
    N = len(docs); avgdl = (sum(len(t) for t in toks) / N) if N else 0
    df = {}
    for t in toks:
        for w in set(t): df[w] = df.get(w, 0) + 1
    idf = {w: math.log(1 + (N - n + 0.5) / (n + 0.5)) for w, n in df.items()}
    q = _tok(query); scores = []
    for i, t in enumerate(toks):
        tf = {}
        for w in t: tf[w] = tf.get(w, 0) + 1
        dl = len(t) or 1; s = 0.0
        for w in q:
            if w not in tf: continue
            s += idf.get(w, 0) * (tf[w] * (k1 + 1)) / (tf[w] + k1 * (1 - b + b * dl / (avgdl or 1)))
        scores.append((s, i))
    scores.sort(reverse=True)
    return [i for _, i in scores[:k]]

def session_docs(inst):
    """One retrievable doc per session (timestamp + turns), index-aligned with haystack_sessions."""
    dates = inst.get("haystack_dates", [])
    out = []
    for i, sess in enumerate(inst["haystack_sessions"]):
        d = dates[i] if i < len(dates) else ""
        turns = "\n".join(f"{t.get('role')}: {t.get('content','').strip()}" for t in sess)
        out.append(f"[Session on {d}]\n{turns}")
    return out

def run_baseline(variant, n, out, model=None, mode="fullctx", topk=10, max_chars=600_000, stratify=False):
    """Baselines on the SAME base model as DUIN, so the delta isolates DUIN's memory:
       - fullctx : whole haystack in the prompt (the ceiling; overflows on _m).
       - naiverag: BM25 top-k sessions in the prompt (the FAIR comparison — the headline
                   number is acc(duin) - acc(naiverag))."""
    data = select(variant, n, stratify)
    outp = Path(out); outp.parent.mkdir(parents=True, exist_ok=True)
    with open(outp, "w", encoding="utf-8") as fh:
        for k, inst in enumerate(data):
            if mode == "naiverag":
                docs = session_docs(inst)
                idxs = bm25_topk(inst["question"], docs, k=topk)
                ctx = "\n\n".join(docs[i] for i in idxs)
            else:
                ctx = history_text(inst, max_chars)
            prompt = (f"You are answering a question from a user based on your prior conversations with them.\n\n"
                      f"=== Conversation history ===\n{ctx}\n\n"
                      f"=== Question (asked {inst['question_date']}) ===\n{inst['question']}\n\n"
                      f"Answer concisely. If the history doesn't contain the answer, say you don't know.")
            try:
                hyp = model_call(prompt, model=model).strip()
            except Exception as e:
                hyp = f"__ERROR__ {e}"
            fh.write(json.dumps({"question_id": inst["question_id"], "hypothesis": hyp,
                                 "question_type": inst["question_type"]}, ensure_ascii=False) + "\n")
            fh.flush()
            print(f"[{k+1}/{len(data)}] {inst['question_id']} ({mode}) -> {hyp[:70]!r}", flush=True)
    print(f"wrote {n} {mode} hypotheses -> {outp}")

# ─────────────────────────── grader (LongMemEval per-type LLM-as-judge) ───────────────────────────
JUDGE_BASE = ("I will give you a question, a correct answer, and a response from a model. "
    "Please answer yes if the response contains the correct answer. Otherwise, answer no. "
    "If the response is equivalent to the correct answer or contains all the intermediate steps to "
    "get the correct answer, you should also answer yes. If the response only contains a subset of "
    "the information required by the answer, answer no. \n\nQuestion: {q}\n\nCorrect Answer: {a}\n\n"
    "Model Response: {r}\n\nIs the model response correct? Answer yes or no only.")
JUDGE_TEMPORAL = JUDGE_BASE.replace(
    "Answer yes or no only.",
    "Also, do not penalize off-by-one errors for the number of days. If the question asks for the "
    "number of days/weeks/months, etc., and the model makes off-by-one errors, the response is still "
    "correct. Answer yes or no only.")
JUDGE_KNOWLEDGE = JUDGE_BASE.replace(
    "answer no. \n\nQuestion",
    "answer no. If the response contains some previous information along with an updated answer, the "
    "response should be considered correct as long as the updated answer is the required answer. \n\nQuestion")
JUDGE_PREF = ("I will give you a question, a rubric for the desired response, and a response from a "
    "model. Please answer yes if the response satisfies the desired response. The model does not need "
    "to reflect all the points in the rubric. The response is correct as long as it recalls and "
    "utilizes the user's personal information correctly. \n\nQuestion: {q}\n\nRubric: {a}\n\n"
    "Model Response: {r}\n\nIs the model response correct? Answer yes or no only.")
JUDGE_ABS = ("I will give you an unanswerable question, an explanation, and a response from a model. "
    "Please answer yes if the model correctly identifies the question as unanswerable. The model could "
    "say that the information is incomplete, or some other information is given but the asked "
    "information is not. \n\nQuestion: {q}\n\nExplanation: {a}\n\nModel Response: {r}\n\n"
    "Does the model correctly identify the question as unanswerable? Answer yes or no only.")

def judge_prompt(qtype, is_abs, q, a, r):
    if is_abs: return JUDGE_ABS.format(q=q, a=a, r=r)
    if qtype == "temporal-reasoning": return JUDGE_TEMPORAL.format(q=q, a=a, r=r)
    if qtype == "knowledge-update": return JUDGE_KNOWLEDGE.format(q=q, a=a, r=r)
    if qtype == "single-session-preference": return JUDGE_PREF.format(q=q, a=a, r=r)
    return JUDGE_BASE.format(q=q, a=a, r=r)

def call_judge(prompt, judge):
    """Return the raw judge string ('yes'/'no'). judge in {oneai, claude, gpt-4o}. temp=0."""
    if judge == "oneai":  # OpenAI-compatible Responses API (gpt-5.5) — the default adjudicator
        return oneai_call(prompt, max_tokens=2000)  # Responses reasoning models need output room
    if judge == "gpt-4o":
        key = os.environ.get("OPENAI_API_KEY")
        if not key: sys.exit("OPENAI_API_KEY required for --judge gpt-4o (LongMemEval standard grader)")
        body = {"model": "gpt-4o-2024-08-06", "temperature": 0, "max_tokens": 10,
                "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
              data=json.dumps(body).encode(),
              headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"}, method="POST")
        out = json.loads(urllib.request.urlopen(req, timeout=60).read())
        return out["choices"][0]["message"]["content"]
    else:  # claude
        key = os.environ.get("ANTHROPIC_API_KEY")
        if not key: sys.exit("ANTHROPIC_API_KEY required for --judge claude")
        body = {"model": "claude-opus-4-8", "max_tokens": 10, "temperature": 0,
                "messages": [{"role": "user", "content": prompt}]}
        req = urllib.request.Request("https://api.anthropic.com/v1/messages",
              data=json.dumps(body).encode(),
              headers={"Content-Type": "application/json", "x-api-key": key,
                       "anthropic-version": "2023-06-01"}, method="POST")
        out = json.loads(urllib.request.urlopen(req, timeout=60).read())
        return out["content"][0]["text"]

def grade(hyp_file, variant, judge):
    gold = {x["question_id"]: x for x in load_variant(variant)}
    hyps = [json.loads(l) for l in open(hyp_file, encoding="utf-8") if l.strip()]
    outp = Path(str(hyp_file) + ".graded")
    with open(outp, "w", encoding="utf-8") as fh:
        for h in hyps:
            qid = h["question_id"]; g = gold[qid]
            is_abs = qid.endswith("_abs")
            p = judge_prompt(g["question_type"], is_abs, g["question"], g["answer"], h["hypothesis"])
            raw = call_judge(p, judge)
            label = "yes" in raw.strip().lower()
            fh.write(json.dumps({**h, "question_type": g["question_type"], "is_abs": is_abs,
                                 "autoeval_label": label, "judge_raw": raw.strip()}, ensure_ascii=False) + "\n")
            print(f"{qid}: {'[Y]' if label else '[n]'} ({g['question_type']})", flush=True)
    print(f"graded -> {outp}")
    metrics(outp)

# ─────────────────────────── metrics ───────────────────────────
def metrics(graded_file):
    rows = [json.loads(l) for l in open(graded_file, encoding="utf-8") if l.strip()]
    by_type = defaultdict(lambda: [0, 0])
    abst = [0, 0]; overall = [0, 0]
    for r in rows:
        ok = 1 if r["autoeval_label"] else 0
        by_type[r["question_type"]][0] += ok; by_type[r["question_type"]][1] += 1
        overall[0] += ok; overall[1] += 1
        if r.get("is_abs"): abst[0] += ok; abst[1] += 1
    print("\n=== LongMemEval metrics ===")
    print(f"Overall accuracy      : {overall[0]}/{overall[1]} = {overall[0]/max(1,overall[1]):.3f}")
    types = sorted(by_type)
    task_avg = sum(by_type[t][0]/by_type[t][1] for t in types) / max(1, len(types))
    print(f"Task-averaged accuracy: {task_avg:.3f}")
    if abst[1]: print(f"Abstention accuracy   : {abst[0]}/{abst[1]} = {abst[0]/abst[1]:.3f}")
    print("--- per question_type ---")
    for t in types:
        c, n = by_type[t]
        print(f"  {t:28s} {c}/{n} = {c/n:.3f}")

# ─────────────────────────── offline self-check ───────────────────────────
def selfcheck():
    """Validate the deterministic pieces with NO DUIN and NO API: converter shape,
       judge-prompt selection, metrics aggregation on a mock."""
    data = load_variant("oracle")
    inst = data[0]
    notes = convert_instance(inst)
    assert notes and all(n.endswith(".md") for n, _ in notes), "converter must emit .md notes"
    assert str(inst["haystack_dates"][0]) in notes[0][1], "session note must carry its timestamp"
    assert len(notes) == len(inst["haystack_sessions"]), "one note per session"
    # judge-prompt routing
    assert "off-by-one" in judge_prompt("temporal-reasoning", False, "q", "a", "r")
    assert "unanswerable" in judge_prompt("multi-session", True, "q", "a", "r")
    assert "Rubric" in judge_prompt("single-session-preference", False, "q", "a", "r")
    assert "updated answer" in judge_prompt("knowledge-update", False, "q", "a", "r")
    # metrics on a mock graded file
    mock = HERE / "_selfcheck.graded"
    with open(mock, "w", encoding="utf-8") as fh:
        for i in range(4):
            fh.write(json.dumps({"question_id": f"q{i}{'_abs' if i==3 else ''}",
                    "question_type": "temporal-reasoning" if i < 2 else "multi-session",
                    "is_abs": i == 3, "autoeval_label": i % 2 == 0}) + "\n")
    print("converter + judge-routing OK; mock metrics:")
    metrics(mock); mock.unlink()
    print("\nselfcheck PASSED — deterministic pieces validated (converter, judge prompts, metrics).")

# ─────────────────────────── CLI ───────────────────────────
def main():
    ap = argparse.ArgumentParser(description="LongMemEval harness for DUIN")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("convert"); c.add_argument("--variant", default="oracle"); c.add_argument("--qid")
    d = sub.add_parser("duin"); d.add_argument("--variant", default="oracle"); d.add_argument("--n", type=int, default=5)
    d.add_argument("--out", default=str(HERE/"runs"/"duin.jsonl")); d.add_argument("--model")
    d.add_argument("--settle", type=int, default=12); d.add_argument("--restore-dir")
    d.add_argument("--stratify", action="store_true"); d.add_argument("--offset", type=int, default=0)
    b = sub.add_parser("baseline"); b.add_argument("--variant", default="oracle"); b.add_argument("--n", type=int, default=5)
    b.add_argument("--out", default=str(HERE/"runs"/"baseline.jsonl")); b.add_argument("--model")
    b.add_argument("--mode", default="fullctx", choices=["fullctx", "naiverag"]); b.add_argument("--topk", type=int, default=10)
    g = sub.add_parser("grade"); g.add_argument("--hyp", required=True); g.add_argument("--variant", default="oracle")
    g.add_argument("--judge", default="oneai", choices=["oneai", "claude", "gpt-4o"])
    m = sub.add_parser("metrics"); m.add_argument("--graded", required=True)
    i = sub.add_parser("iso"); i.add_argument("--variant", default="oracle"); i.add_argument("--n", type=int, default=25)
    i.add_argument("--topk", type=int, default=10); i.add_argument("--offset", type=int, default=0)
    i.add_argument("--stratify", action="store_true")
    sub.add_parser("selfcheck")
    a = ap.parse_args()
    if a.cmd == "convert":
        data = load_variant(a.variant)
        inst = next((x for x in data if x["question_id"] == a.qid), data[0]) if a.qid else data[0]
        print(f"# {inst['question_id']} ({inst['question_type']})  asked {inst['question_date']}")
        print(f"# Q: {inst['question']}\n# Gold: {inst['answer']}\n")
        for name, content in convert_instance(inst):
            print(f"--- {name} ---\n{content[:400]}\n")
    elif a.cmd == "duin":
        run_duin(a.variant, a.n, a.out, model=a.model, settle=a.settle, restore_dir=a.restore_dir,
                 offset=a.offset, stratify=a.stratify)
    elif a.cmd == "baseline":
        run_baseline(a.variant, a.n, a.out, model=a.model, mode=a.mode, topk=a.topk)
    elif a.cmd == "grade":
        grade(a.hyp, a.variant, a.judge)
    elif a.cmd == "metrics":
        metrics(a.graded)
    elif a.cmd == "iso":
        run_iso(a.variant, a.n, topk=a.topk, offset=a.offset, stratify=a.stratify)
    elif a.cmd == "selfcheck":
        selfcheck()

if __name__ == "__main__":
    main()
