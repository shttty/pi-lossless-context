# Tokenizer bench findings (PROTOTYPE, 2026-09-29)

The bench scripts, query lists and per-query results are not published: the queries and the corpus are the owner's
private Pi/OMP sessions. Only the aggregate findings are kept here.

Corpus (read-only): the owner's Pi/OMP session dirs: 205 files, 462 MB jsonl,
41,831 text entries, 111 M chars. node:sqlite (SQLite 3.53.1, Node 24.18). Truth = exact case-insensitive substring
(`instr(lower(text), lower(q))`). All FTS tables contentless.

| | size | build | ≥3-char terms | 2-char CJK | 1-char CJK | English inside identifiers |
|---|---|---|---|---|---|---|
| FTS5 `trigram` | 256 MB | 17 s | 100%, 0 extra | cannot | cannot | exact substring (`autoCompaction` found by `compaction`) |
| Hermes `cjk_unicode61` (.so) | 39 MB | 3.4 s | 100% for CJK | 100% | 11% (only isolated chars) | word-level: `compaction` 90.8%, `OpenViking` 97.3%, `LCM` 65.9% |
| JS bigram preprocessing + `unicode61` | 45 MB | 4.2 s | same as .so | 100% | **100%** (separate unigram column) | same as .so |
| LIKE full scan (needs stored text, 129 MB) | — | — | 177–220 ms | same | same | exact |
| raw jsonl scan, incl. file read | — | — | ~1.2–1.3 s | same | same | exact |

Word-level "extra" hits are separator variants (`hot memory` also matches `hot_memory`, `session_search` matches
`session search`), usually wanted. Word-level misses are substrings inside identifiers and base64 noise.

Verdict:
- The Hermes C extension is unnecessary: preprocessing CJK runs into bigrams in JS gives identical results on every
  multi-char query, fixes single characters, and needs no native build. `node:sqlite` can load extensions
  (`allowExtension`), but nothing requires it.
- Trigram is the only variant with exact substring semantics for code/identifiers, at ~5.7× the bigram size.
- LIKE / raw-jsonl scans are fine as occasional fallbacks at this size, not as the main path.

## Rerun without tool outputs

Tool results excluded from the index (decision 2026-09-29; compaction discards them anyway). Same corpus:
10,040 entries, 4 M chars (tool output was ~96% of indexed text). trigram 15 MB, JS bigram 7 MB, build < 1 s each,
LIKE full scan ~11 ms. Recall pattern unchanged (trigram exact for ≥3 chars; bigram 100% for CJK incl. single chars,
word-level for English). The size argument against keeping both tables is gone.

## All candidates

Same corpus without tool outputs: 205 files, 10,072 entries, 3.7 M chars. 50 queries in 6 classes; truth = exact
case-insensitive substring. Pre-segmented variants store space-joined tokens in a `unicode61` column and query the
phrase of the query's own tokens. `jiebaS` indexes `cutForSearch` and queries an AND of precise tokens.

Mean recall by class:

| class | u61 | tri | so (.so) | bi | uni | icu | jieba | jiebaS | bge-m3 tok |
|---|---|---|---|---|---|---|---|---|---|
| CJK 1 char | 0% | n/a | 0% | **100%** | **100%** | 34% | 33% | 33% | 50% |
| CJK 2 chars | 18% | n/a | 100% | **100%** | **100%** | 99% | 97% | 98% | 99% |
| CJK 3+ | 15% | 100% | 100% | 100% | 100% | 100% | 98% | 100% | 100% |
| CJK across word boundary | 4% | 67% | 100% | **100%** | **100%** | 79% | 79% | 80% | 64% |
| ASCII word | 93% | **100%** | 98% | 98% | 98% | 98% | 98% | 98% | 77% |
| identifier / IP / version | 97% | **100%** | 100% | 100% | 100% | 100% | 100% | 100% | 70% |

Size (MB): u61 3.3, tri 15.3, so 4.2, bi 6.9, uni 3.2, icu 2.7, jieba 2.7, bge 3.3. All queries ≤ 0.8 ms.

Why the dictionary / model segmenters miss: the query word is segmented differently inside the document
(`索引` in 搜索引擎, `以后` in 所以后续, `忆` inside the token 记忆). BGE-M3's tokenizer also breaks
English and identifiers by position (`compaction` inside `（compaction）`, `firstKeptEntryId`, a dotted IPv4 address all 0–54%).
`jiebaS` AND queries add ~900 extra hits.

Verdict:
- Dictionary segmentation (ICU, jieba) and model tokenizers are strictly worse than character-level CJK for exact recall;
  drop them for the literal index. The model tokenizer is the worst option for code/identifiers.
- `uni` (one token per CJK char, phrase query) has `bi` recall on every query at half the size, but `unicode61` drops
  punctuation, so it also matches across it (`网关` in "网/关", `以后` in "所以“后台", `后就` in "信息后，就"): ~10 more
  false hits than `bi` over the 50 queries. Not used.
- English inside identifiers (`CompactionResult`, `registerPiOpenVikingMemory`) is only found by trigram.
- Recommended (2026-09-29): `bi` (Hermes bigram scheme in JS, unigram column for 1-char queries) for CJK queries
  + `tri` for queries of ≥ 3 chars, union of hits (≈ 22 MB here). Ranking was not measured.
