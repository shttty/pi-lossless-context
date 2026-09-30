"""PROTOTYPE — throwaway. Real follow-up questions from the user's own messages, gold judged by luna over a pooled
candidate set (FTS top-20 ∪ potion top-20). Pooling bias is equal for both systems.

  uv run --no-project --with model2vec python3 realq.py mine    # candidates + pooled judging -> data/real-*.json
  uv run --no-project --with model2vec python3 realq.py score   # R@k for FTS, potion, RRF on judged questions

Env: SESSION_DIRS (os.pathsep-separated Pi/OMP session dirs), CLP_BASE_URL / CLP_API_KEY. data/ is gitignored.
"""
import glob, hashlib, json, os, random, re, sqlite3, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
from model2vec import StaticModel

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
ROOTS = os.environ.get("SESSION_DIRS", "").split(os.pathsep)
API, KEY = os.environ.get("CLP_BASE_URL", ""), os.environ.get("CLP_API_KEY", "")
REF = re.compile(r"上次|之前|当时|还记得|刚才说|前面说|原来那个|那个.{0,12}来着|那次|上回|以前说")
NEIGHBOURS = 2   # messages this close in reading order count as live context, not recall
POOL = 20


def messages():
    """Same extraction and text dedup as prepare.py zh: one entry per distinct user/assistant text."""
    seen, out = set(), []
    for f in sorted(p for r in ROOTS for p in glob.glob(f"{r}/**/*.jsonl", recursive=True)):
        for line in open(f, errors="ignore"):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            m = o.get("message") or {}
            if o.get("type") != "message" or m.get("role") not in ("user", "assistant"):
                continue
            c = m.get("content")
            t = (c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or []
                 if isinstance(b, dict) and b.get("type") == "text")).strip()
            h = hashlib.sha1(t.encode()).hexdigest()
            if not t or h in seen:
                continue
            seen.add(h)
            out.append({"doc": len(out), "role": m["role"], "text": t})
    return out


CJK = re.compile(r"[\u4e00-\u9fff]+")
def seg(t):
    return CJK.sub(lambda m: " " + (m.group() if len(m.group()) == 1 else " ".join(m.group()[i:i + 2] for i in range(len(m.group()) - 1))) + " ", t)


class Search:
    def __init__(self, msgs):
        self.msgs = msgs
        self.db = sqlite3.connect(":memory:")
        self.db.execute("create virtual table f using fts5(t, tokenize='unicode61')")
        self.db.executemany("insert into f(rowid, t) values (?, ?)", [(m["doc"], seg(m["text"])) for m in msgs])
        self.model = StaticModel.from_pretrained(str(HERE / "cache/potion"))
        # potion on 200-char chunks (best setting so far), message score = best chunk
        self.chunk_doc, texts = [], []
        for m in msgs:
            for i in range(0, len(m["text"]), 200):
                self.chunk_doc.append(m["doc"]); texts.append(m["text"][i:i + 200])
        E = self.model.encode(texts)
        self.E = E / np.linalg.norm(E, axis=1, keepdims=True)
        self.chunk_doc = np.array(self.chunk_doc)

    def excluded(self, qdoc, d):
        return abs(d - qdoc) <= NEIGHBOURS

    def fts(self, q, qdoc, k=POOL):
        terms = {w for w in seg(q).lower().split() if re.search(r"\w", w)}
        if not terms:
            return []
        expr = " OR ".join('"' + w.replace('"', '""') + '"' for w in terms)
        rows = self.db.execute("select rowid from f where f match ? order by bm25(f) limit ?", (expr, k + 2 * NEIGHBOURS + 1)).fetchall()
        return [r[0] for r in rows if not self.excluded(qdoc, r[0])][:k]

    def potion(self, q, qdoc, k=POOL):
        v = self.model.encode([q])[0]; v /= np.linalg.norm(v)
        s = self.E @ v
        out = []
        for j in np.argsort(-s):
            d = int(self.chunk_doc[j])
            if d not in out and not self.excluded(qdoc, d):
                out.append(d)
            if len(out) == k:
                break
        return out


def ask(prompt):
    body = json.dumps({"model": "gpt-6-luna", "reasoning_effort": "medium", "max_tokens": 4000,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(f"{API}/chat/completions", body, {"Authorization": f"Bearer {KEY}",
                                 "Content-Type": "application/json", "User-Agent": "curl/8.9.1"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)["choices"][0]["message"]["content"].strip()


JUDGE = """用户在和 AI 助手聊天时发了下面这条消息，里面提到了之前聊过的某件事。

用户的消息：
<<<
{q}
>>>

下面是从用户过去对话里检索出的候选消息（编号 + 原文片段）。判断这条消息所指的、或者回答这条消息需要的那段过去内容，是哪一条或哪几条候选。

规则：
- 只选内容真正对应的候选；只是主题相近不算。
- 如果这条消息其实不是在找过去的内容（比如只是闲聊、在说刚发生的事），或者没有候选对得上，回答 NONE。
- 只输出 JSON：{{"gold": [编号, ...]}} 或 {{"gold": []}}。

候选：
{cands}"""


def mine(n=150, seed=0):
    msgs = messages()
    S = Search(msgs)
    cand = [m for m in msgs if m["role"] == "user" and 6 <= len(m["text"]) <= 300 and REF.search(m["text"])
            and not m["text"].startswith(("[", "<", "/"))]
    print(f"{len(msgs)} messages, {len(cand)} user messages that refer back")
    cand = random.Random(seed).sample(cand, min(n, len(cand)))

    pools = {m["doc"]: list(dict.fromkeys(S.fts(m["text"], m["doc"]) + S.potion(m["text"], m["doc"]))) for m in cand}

    def judge(m):
        pool = pools[m["doc"]]
        random.Random(m["doc"]).shuffle(pool)   # hide which system found what
        cands = "\n\n".join(f"[{i}] ({msgs[d]['role']}) {msgs[d]['text'][:700]}" for i, d in enumerate(pool))
        try:
            out = ask(JUDGE.format(q=m["text"], cands=cands))
            idx = json.loads(re.search(r"\{.*\}", out, re.S).group())["gold"]
        except Exception as e:  # noqa: BLE001 — prototype: record and skip
            return {"doc": m["doc"], "q": m["text"], "error": str(e)[:200]}
        return {"doc": m["doc"], "q": m["text"], "gold": [pool[i] for i in idx if 0 <= i < len(pool)], "pool": len(pool)}

    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(judge, cand))
    json.dump(res, open(DATA / "real-judged.json", "w"), ensure_ascii=False, indent=0)
    ok = [r for r in res if r.get("gold")]
    print(f"judged {len(res)}: {len(ok)} with gold, {sum(1 for r in res if 'error' in r)} errors")


def score():
    msgs = messages()
    S = Search(msgs)
    res = [r for r in json.load(open(DATA / "real-judged.json")) if r.get("gold")]

    def rrf(a, b, k=60):
        s = {}
        for lst in (a, b):
            for i, d in enumerate(lst):
                s[d] = s.get(d, 0) + 1 / (k + i + 1)
        return [d for d, _ in sorted(s.items(), key=lambda x: -x[1])]

    ranks = {"fts": [], "potion": [], "rrf": []}
    for r in res:
        f, p = S.fts(r["q"], r["doc"]), S.potion(r["q"], r["doc"])
        for name, lst in (("fts", f), ("potion", p), ("rrf", rrf(f, p))):
            ranks[name].append(next((i for i, d in enumerate(lst) if d in set(r["gold"])), None))
    print(f"{len(res)} real questions with gold (pool = FTS top-{POOL} ∪ potion top-{POOL})")
    for name, pos in ranks.items():
        n = len(pos)
        cell = lambda k: sum(1 for x in pos if x is not None and x < k) / n
        mrr = sum(1 / (x + 1) for x in pos if x is not None) / n
        print(f"{name:7} R@1 {cell(1):.2f}  R@5 {cell(5):.2f}  R@10 {cell(10):.2f}  R@20 {cell(20):.2f}  MRR {mrr:.2f}")
    only = lambda a, b: sum(1 for x, y in zip(ranks[a], ranks[b]) if x is not None and x < 10 and (y is None or y >= 10))
    print(f"top-10 found only by fts {only('fts', 'potion')}, only by potion {only('potion', 'fts')}")


{"mine": mine, "score": score}[sys.argv[1]]()
