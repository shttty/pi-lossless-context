"""PROTOTYPE — throwaway. Summarize saved rankings: each model alone and fused with FTS BM25 (RRF, k=60).

  python3 analyze.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
PROBE = {p["model"]: p for p in map(json.loads, open(HERE / "probe.jsonl"))}
ORDER = ["fts-bm25", "potion", "potion-f16", "potion-i8", "bge-small-zh", "bge-small-zh-fp16", "e5-small", "e5-small-fp16", "minilm-l12", "minilm-l12-fp16", "jina-zh"]


def metrics(queries, ranks):
    n, r1, r5, r10, mrr = len(queries), 0, 0, 0, 0.0
    for q, rk in zip(queries, ranks):
        gold = {str(d) for d in q["docs"]}
        pos = next((i for i, d in enumerate(rk) if str(d) in gold), None)
        if pos is not None:
            r1 += pos < 1; r5 += pos < 5; r10 += pos < 10; mrr += 1 / (pos + 1)
    return r1 / n, r5 / n, r10 / n, mrr / n


def rrf(*lists, k=60):
    s = {}
    for lst in lists:
        for i, d in enumerate(lst):
            s[d] = s.get(d, 0) + 1 / (k + i + 1)
    return [d for d, _ in sorted(s.items(), key=lambda x: -x[1])]


import sys
for set_ in (sys.argv[1:] or ["zh", "lme"]):
    qs = [json.loads(l) for l in open(DATA / f"{set_}-queries.jsonl")]
    fts = json.load(open(DATA / f"rank-fts-bm25-{set_}.json"))
    print(f"\n== {set_} ({len(qs)} queries)  alone: R@1 R@5 R@10 MRR  |  + FTS (RRF): R@1 R@5 R@10 MRR  |  disk MB, chunks/s, query ms, peak RSS MB")
    for m in ORDER:
        p = DATA / f"rank-{m}-{set_}.json"
        if not p.exists():
            continue
        rk = json.load(open(p))
        a = metrics(qs, rk)
        h = metrics(qs, [rrf(x, y) for x, y in zip(rk, fts)]) if m != "fts-bm25" else None
        pr = PROBE.get(m, {})
        fmt = lambda t: " ".join(f"{x:.2f}" for x in t)
        print(f"{m:13} {fmt(a)}  |  {fmt(h) if h else '   -    -    -    -'}  |  "
              f"{pr.get('diskMB', '-'):>4} {pr.get('chunksPerS', '-'):>5} {pr.get('queryMs', '-'):>4} {pr.get('peakRssMB', '-'):>5}")
