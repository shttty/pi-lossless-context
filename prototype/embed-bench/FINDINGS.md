# Embedded embedding model findings (PROTOTYPE, 2026-09-29)

Question: can an in-process, CPU-only embedding model (no GPU, no Ollama, ≤ 1.5 GB RAM — the owner's limit) improve recall
of past session content over the planned FTS index?

Runtime: Node 24 + `@huggingface/transformers` 4.3.0 (onnxruntime-node, CPU) in the same process; Model2Vec static model
implemented directly (tokenizer + table lookup). Machine: Ryzen 7 5800H, 16 threads.

## Sets

The zh corpus, zh queries and real follow-up questions come from private sessions and are not published
(`data/` is gitignored); only aggregate results are kept here.


- **zh** (`prepare.py zh`): the owner's own Pi/OMP sessions (`SESSION_DIRS`), tool outputs excluded, deduped
  by text: 8,453 messages → 9,390 chunks of ≤ 800 chars. 150 random Chinese messages (150–1500 chars); gpt-6-luna wrote
  one question per message in the user's voice without copying distinctive words. Gold = only the source message.
- **lme** (`prepare.py lme`): LongMemEval_S haystacks of the 46 non-abstention lme-bench questions, 42,449 turn chunks;
  gold = any answer session; search restricted to the question's own haystack (~50 sessions).
- FTS baseline: FTS5 BM25, CJK bigram + `unicode61`, OR of query terms.
- Ranking per message/session: best chunk score. Hybrid = RRF (k = 60, equal weight, untuned).

## Results (`results-summary.txt`, `results.jsonl`, `probe.jsonl`)

| model | disk | chunks/s | query | peak RSS | zh R@1 | zh R@10 | zh +FTS R@10 | lme R@1 | lme R@10 |
|---|---|---|---|---|---|---|---|---|---|
| **FTS BM25** | — | — | < 1 ms | — | **0.35** | **0.65** | — | 0.87 | 0.93 |
| potion-multilingual-128M (static) | 531 MB | **~1,300** | **0 ms** | 1.04 GB | 0.19 | 0.37 | 0.65 | 0.85 | **0.98** |
| e5-small q8 | 135 MB | 35 | 5 ms | 1.08 GB | 0.18 | 0.36 | 0.61 | **0.93** | **0.98** |
| e5-small fp16 | 371 MB | 16* | 6 ms | 1.38 GB | 0.17 | 0.39 | 0.62 | – | – |
| bge-small-zh q8 | 24 MB | 65 | 3 ms | 0.73 GB | 0.14 | 0.33 | 0.59 | 0.59 | 0.87 |
| bge-small-zh fp16 | 72 MB | 31* | 5 ms | 0.80 GB | 0.15 | 0.33 | 0.63 | – | – |
| minilm-l12 q8 / fp16 | 135 / 371 MB | 35 / 16* | 4–7 ms | 1.09 / 1.37 GB | 0.06 | 0.19 | 0.57 | – | – |
| jina-v2-base-zh q8 | 164 MB | 15 | 9 ms | 1.22 GB | 0.03 | 0.13 | 0.56 | – | – |

\* fp16 probes ran at 4 threads, q8 probes at 16; throughput is not comparable across the two.

Excluded by the 1.5 GB rule (probe only, no recall run): jina-zh fp16 1.84 GB, bge-m3 q8 2.25 GB, arctic-m-v2 2.76 GB,
embeddinggemma-300m 2.94 GB, Qwen3-Embedding-0.6B 5.79 GB (2.7 chunks/s).

## Observations

- **On the owner's Chinese sessions no model ≤ 1.5 GB beats FTS**, alone (best R@10 0.39 vs 0.65) or fused (RRF ties FTS at
  R@10 0.65 and lowers R@1 0.35 → 0.30). Likely causes: many structurally similar technical messages (reports,
  status updates) that embeddings cannot tell apart; residual lexical overlap in LLM-written questions favours FTS
  (not quantified); untuned fusion.
- English LongMemEval: e5-small (R@1 0.93) and potion (R@10 0.98) edge out FTS (R@1 0.87, R@10 0.93).
- Quantization: jina-zh's q8 export is broken (30-way sanity MRR 0.49 vs fp16 0.81); bge-small, e5, minilm q8 ≈ fp16.
- potion: 40–80× faster than the transformer models, zero query latency, full backfill of the zh corpus in ~7 s.
  Memory ≈ 0.46 GB tokenizer (`tokenizer.json` parsed in JS) + 0.51 GB f32 table. f16 / per-row int8 tables keep
  identical recall (R@10 0.373 / 0.373) but this prototype did not reclaim the f32 file buffer, so measured RSS rose
  (1.28 / 1.15 GB); the table alone would be 256 / 128 MB.
- Machine hit 97 °C with 16 threads; an in-agent model must cap intra-op threads.

## Verdict

- Do not add vector recall to the first version: FTS (bigram + trigram) is better on the real Chinese sessions and
  costs nothing. Revisit only with a stronger Chinese model inside the memory budget or with real query logs.
- If vectors are added later for English/semantic fallback: potion (near-zero compute; needs a leaner tokenizer
  and f16/int8 table) or e5-small q8.

## potion follow-up: lme-bench corpus (LongMemEval_M) and chunk size (2026-09-30)

`prepare.py lmem <chars>`: the 46 non-abstention lme-bench questions over their full LongMemEval_M haystacks
(~500 sessions each, 222 M chars total; 417 k chunks at 800 chars, 1.22 M at 200). `zh200` = the same 150 zh
questions over the zh corpus re-chunked at 200 chars. Search per question haystack, rank per session / message.

| set | FTS R@1 | FTS R@10 | potion R@1 | potion R@10 | potion R@20 | RRF R@1 | RRF R@10 |
|---|---|---|---|---|---|---|---|
| lmem800 | 0.63 | 0.87 | 0.54 | 0.89 | 0.93 | 0.59 | 0.89 |
| lmem200 | 0.63 | 0.83 | **0.63** | **0.91** | **0.96** | **0.70** | 0.89 |
| zh (800) | **0.35** | **0.65** | 0.19 | 0.37 | 0.41 | 0.30 | 0.65 |
| zh200 | **0.37** | 0.63 | 0.16 | 0.41 | 0.46 | 0.34 | **0.65** |

- Smaller chunks help potion (static mean pooling dilutes long chunks) and do not help FTS.
- On the lme-bench corpus potion at 200 chars matches FTS at rank 1 and beats it deeper; top-10 misses are largely
  disjoint (lmem200: potion-only hits 5, FTS-only 1), e.g. 1a1907b4 (cocktail preference) — a preference question the
  answering model never searched for in the recall spike.
- On the owner's Chinese sessions FTS still wins clearly; fusion only ties it at R@10 (R@5 0.53 → 0.59).
- Embedding the whole lme corpus at 200 chars: single-threaded, ~15 min for 222 M chars; CPU stayed ~83 °C.

## Real follow-up questions (`realq.py`, 2026-09-30)

Queries are the owner's own messages that refer back ("上次/之前/当时/还记得/…来着"), verbatim, 6–300 chars: 40 found in
the zh corpus. Candidate pool = FTS top-20 ∪ potion (200-char chunks) top-20, excluding the message itself and ±2
neighbouring messages (live context). gpt-6-luna (medium) picked the referenced message(s) from the shuffled pool or
NONE; 29 of 40 got a gold. Pooling bias: gold can only come from the two systems' top 20, equally for both.

| | R@1 | R@5 | R@10 | R@20 | MRR |
|---|---|---|---|---|---|
| FTS (bigram BM25) | 0.17 | 0.48 | **0.66** | 0.83 | 0.32 |
| potion | 0.03 | 0.21 | 0.38 | 0.55 | 0.13 |
| RRF | **0.21** | **0.52** | **0.66** | **0.90** | **0.34** |

Top-10 found only by FTS 14, only by potion 6. Same picture as the LLM-written questions: FTS leads on the owner's real
follow-ups; potion adds a few misses, visible at R@20 after fusion. Small sample (29); some golds are the assistant's
later restatements of the referenced content rather than the original message.
