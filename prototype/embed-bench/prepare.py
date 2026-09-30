"""PROTOTYPE — throwaway. Builds the two retrieval sets for the embedding comparison.

  python3 prepare.py zh   # own sessions (SESSION_DIRS) -> data/zh-corpus.jsonl, data/zh-queries.jsonl (luna writes paraphrased questions)
  python3 prepare.py lme  # LongMemEval_S haystacks of the lme-bench sample -> data/lme-corpus.jsonl, data/lme-queries.jsonl

Env: SESSION_DIRS (os.pathsep-separated Pi/OMP session dirs), CLP_BASE_URL / CLP_API_KEY (OpenAI-compatible endpoint
serving gpt-6-luna), LME_BENCH (lme-bench checkout, default ../../../lme-bench). data/ holds private session text and
is gitignored.

Retrieval unit = chunk of <= CHUNK chars of one message (tool outputs excluded, as in the index design).
"""
import glob, hashlib, json, os, random, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
CHUNK = 800
ROOTS = os.environ.get("SESSION_DIRS", "").split(os.pathsep)
LME = Path(os.environ.get("LME_BENCH", HERE.parents[2] / "lme-bench")) / "data"
API, KEY = os.environ.get("CLP_BASE_URL", ""), os.environ.get("CLP_API_KEY", "")
CJK = re.compile(r"[\u3400-\u9fff]")


def chunks(text):
    return [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)]


def msg_text(o):
    m = o.get("message") or {}
    if o.get("type") != "message" or m.get("role") not in ("user", "assistant"):
        return None, None
    c = m.get("content")
    t = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
    return m["role"], t.strip()


def ask(prompt):
    body = json.dumps({"model": "gpt-6-luna", "reasoning_effort": "low", "max_tokens": 2000,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(f"{API}/chat/completions", body, {"Authorization": f"Bearer {KEY}",
                                 "Content-Type": "application/json", "User-Agent": "curl/8.9.1"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()


PROMPT = """下面是用户和 TA 的 AI 助手过去某次对话里的一段消息（{role}）。

请写一个问题：设想几周后用户想找回这段内容里的某个具体信息，TA 会怎么问。要求：
- 问题的答案必须在这段消息里，而且是这段消息特有的具体内容，不能是常识。
- 换一种说法：不要照抄消息里有辨识度的词句、专名、标识符、文件名、命令或数字，用自己的话描述要找的东西。
- 用中文，一句话，像用户平时说话那样口语化。
- 只输出问题本身。

消息：
<<<
{text}
>>>"""


def build_zh(n_queries=150, seed=0):
    seen, docs, entries = set(), [], []
    for f in sorted(p for r in ROOTS for p in glob.glob(f"{r}/**/*.jsonl", recursive=True)):
        for line in open(f, errors="ignore"):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            role, t = msg_text(o)
            if not t:
                continue
            h = hashlib.sha1(t.encode()).hexdigest()
            if h in seen:  # fork copies and repeats: one document per distinct text
                continue
            seen.add(h)
            doc = len(entries)
            entries.append({"doc": doc, "role": role, "text": t})
            for i, c in enumerate(chunks(t)):
                docs.append({"id": len(docs), "doc": doc, "text": c})
    DATA.mkdir(exist_ok=True)
    with open(DATA / "zh-corpus.jsonl", "w") as w:
        for d in docs:
            w.write(json.dumps(d, ensure_ascii=False) + "\n")
    pool = [e for e in entries if 150 <= len(e["text"]) <= 1500 and len(CJK.findall(e["text"])) / len(e["text"]) > 0.3]
    targets = random.Random(seed).sample(pool, n_queries)
    with ThreadPoolExecutor(8) as ex:
        qs = list(ex.map(lambda e: ask(PROMPT.format(role="用户" if e["role"] == "user" else "助手", text=e["text"])), targets))
    with open(DATA / "zh-queries.jsonl", "w") as w:
        for e, q in zip(targets, qs):
            w.write(json.dumps({"q": q, "docs": [e["doc"]], "src": e["text"][:200]}, ensure_ascii=False) + "\n")
    print(f"zh: {len(entries)} distinct messages, {len(docs)} chunks, {len(qs)} queries")


def build_lme():
    ids = [q["question_id"] for q in json.load(open(LME / "sample.json")) if not q["question_id"].endswith("_abs")]
    S = {q["question_id"]: q for q in json.load(open(LME / "longmemeval_s.json"))}
    docs, queries = [], []
    for qid in ids:
        q = S[qid]
        for sid, sess in zip(q["haystack_session_ids"], q["haystack_sessions"]):
            for turn in sess:
                for c in chunks(turn["content"]):
                    docs.append({"id": len(docs), "group": qid, "doc": f"{qid}/{sid}", "text": c})
        queries.append({"q": q["question"], "group": qid, "type": q["question_type"],
                        "docs": [f"{qid}/{s}" for s in q["answer_session_ids"]]})
    DATA.mkdir(exist_ok=True)
    with open(DATA / "lme-corpus.jsonl", "w") as w:
        for d in docs:
            w.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(DATA / "lme-queries.jsonl", "w") as w:
        for q in queries:
            w.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"lme: {len(queries)} questions, {len(docs)} chunks")


def build_lmem(size):
    """lme-bench's own corpus: LongMemEval_M haystacks of data/sample.json (~500 sessions, ~1.1M tokens per question)."""
    global CHUNK
    CHUNK = int(size)
    name = f"lmem{CHUNK}"
    docs, queries = [], []
    for q in json.load(open(LME / "sample.json")):
        qid = q["question_id"]
        if qid.endswith("_abs"):
            continue
        for sid, sess in zip(q["haystack_session_ids"], q["haystack_sessions"]):
            for turn in sess:
                for c in chunks(turn["content"]):
                    docs.append({"id": len(docs), "group": qid, "doc": f"{qid}/{sid}", "text": c})
        queries.append({"q": q["question"], "group": qid, "type": q["question_type"],
                        "docs": [f"{qid}/{s}" for s in q["answer_session_ids"]]})
    DATA.mkdir(exist_ok=True)
    with open(DATA / f"{name}-corpus.jsonl", "w") as w:
        for d in docs:
            w.write(json.dumps(d, ensure_ascii=False) + "\n")
    with open(DATA / f"{name}-queries.jsonl", "w") as w:
        for q in queries:
            w.write(json.dumps(q, ensure_ascii=False) + "\n")
    print(f"{name}: {len(queries)} questions, {len(docs)} chunks, {sum(len(d['text']) for d in docs)} chars")


{"zh": build_zh, "lme": build_lme, "lmem": build_lmem}[sys.argv[1]](*sys.argv[2:])
