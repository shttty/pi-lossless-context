# pi-lossless-context: agent conventions

For the design, see `PLAN.md`. For usage and configuration, see `README.md`.

## Three layers of `src/`

- **Compaction side**: `compaction.ts`, plus the local files it imports (currently `dag.ts`, `nodes.ts`, `config.ts`, `log.ts`). It decides what a compaction produces: the background pre-summarizer and `session_before_compact`.
- **Index side**: `capture.ts` (index lifecycle, live capture, resume backfill), `store.ts`, `convert.ts`, `tokenize.ts`, `sessions.ts`.
- **Answer side**: `tools.ts` (`lcm_grep`, `lcm_expand`, `/lossless`), `search.ts`, `expand.ts`.
- `index.ts` only wires hooks to the three sides. It holds no logic.

**Any change that affects compaction output must live on the compaction side.** That includes summary prompts, node structure, cut points, pre-summarization timing, and waiting for background batches. Wherever you put it, `compaction.ts` must be able to reach it through its imports. Do not write compaction logic into index-side or answer-side files.

The reason: lme-bench keys its DAG snapshot cache on the content of the `compaction.ts` import closure plus `index.ts`. Compaction logic placed anywhere else is invisible to the key, and the bench silently reuses stale snapshots, which invalidates the results. Adding a new file to the compaction side needs no bench change, because the closure is computed automatically.

## Testing

The three layers are described in the "测试" section of `PLAN.md`. After changing code, run at least `npm run typecheck` and `python3 smoke/drive.py synthetic`. If you touched compaction or pre-summarization, also run `presum` and `live`. Do not run lme-bench (DEV8) mid-development; run it only when the maintainer asks for it.
