# pi-lossless-context

把 [hermes-lcm](https://github.com/stephenschoettler/hermes-lcm)（Stephen Schoettler，MIT）的无损上下文设计移植成 Pi 扩展（Pi SDK 0.85.1），作为作者自己 agent 的默认上下文压缩。代码是新写的 TypeScript，主体设计来自 hermes-lcm，版权与许可声明见 `THIRD_PARTY_NOTICES.md`。设计与已验证结论见 `PLAN.md`；早期 spike 与检索/分词对比实验在 `prototype/`。

## 口径

- 会话 jsonl 是唯一真相；SQLite 只存可删、可重建的派生数据（精简副本、FTS、DAG 节点表），从不写回 jsonl。
- 宿主是 Pi，不做 OMP 扩展。
- 不并入 pi-openviking-memory。
- LCM 确定要做；压缩损失盘点不是开工前提，只作设计与验收语料。
- OMP/Pi 清成 `[Uneventful result elided]` 的工具结果不补救。

## Pi 接入点（0.85.1，实测见 PLAN.md）

- `session_before_compact`：阈值、溢出、`/compact` 都会触发；返回自定义 `compaction` 即接管，`details` 原样写进 jsonl 的 compaction 条目。
- `context`：每次调用模型前可改写消息列表。
- 扩展由工作台的 `extensionPaths` / `extensionFactories` 加载。

## 插件原型（未装进任何生产 profile）

`src/index.ts` 是 Pi 扩展入口（`package.json` 的 `pi.extensions`），只负责接线；代码分三侧：压缩（`compaction.ts` 及它引用的 `dag.ts`/`nodes.ts`/`config.ts`/`log.ts`）、入库（`capture.ts`、`store.ts` 等）、答题（`tools.ts`、`search.ts`、`expand.ts`）。影响压缩结果的改动只能放压缩侧，约束和原因见 `AGENTS.md`。`npm install` 只装开发依赖（SDK 0.85.1、TypeScript），运行时用宿主自己的 SDK，没有原生依赖（Node 自带 `node:sqlite`，FTS5 + trigram 可用）。

- **存储**：`<agent 目录>/lossless-context.db`，LCM 与 session search 共用；日志 `<agent 目录>/lossless-context.log`（带时间戳）。
- **入库**：`turn_end` / `agent_end` / `session_compact` / `session_shutdown` 实时写；`session_start` 后台补足游标之后的条目，超出时间预算即停、保留已提交的批次，并告警（缺多少条、修复命令）。补足超时后本会话暂停实时入库，直到 `/lossless reindex`。
- **工具**：`lcm_grep`（`scope: session` 当前会话及其 `parentSession` 链，`all` 本 agent 目录全部会话，即 session search）、`lcm_expand`（entry id → 前后文；`full=true` 回原会话读完整条目含工具输出；node id → 该摘要及其下层节点 / 原文）。
- **压缩**：`session_before_compact` 接管。新原文按 `LOSSLESS_LEAF_TOKENS` 切成 D0 叶子，每层满 `LOSSLESS_FANIN` 个就合并成上一层，最深 `LOSSLESS_MAX_DEPTH`；详细 → 要点 → 确定性截断三级兜底（结果不比原文短才降级）。只有 compaction 的 `details` 提交节点，放进上下文的是当前前沿节点的渲染。模型调用出错、摘要模型找不到时退回 Pi 原生压缩并告警。
- **后台预摘要**：上下文用量到 `LOSSLESS_PRESUMMARIZE_AT` 后，每轮结束在后台按 Pi 的切点规则，把注定会被下次压缩的原文先做成叶子（满一片才做，最后一片不动），并做满组的合并，存成 `lossless-node` custom entry（在 jsonl 里，不进上下文）。压缩时先等在途的一批落地，再复用仍在切点内的节点（切点后移时越界的叶子和依赖它的合并节点丢弃），只现做剩下的尾巴。失败告警一次，压缩时补做。
- **命令**：`/lossless status`、`/lossless reindex`（当前会话）、`/lossless reindex --all`（当前会话 + 会话目录下全部文件，并删掉文件已不存在的会话）。agent 没运行时：`node src/cli.ts reindex --session FILE | --all [--sessions DIR]`、`node src/cli.ts search QUERY [--session FILE]`、`node src/cli.ts status`，都可加 `--agent-dir`。
- **配置**（环境变量）：`LOSSLESS_BACKFILL_BUDGET_MS`（30000）、`LOSSLESS_BATCH_SIZE`（500）、`LOSSLESS_LEAF_TOKENS`（20000）、`LOSSLESS_FANIN`（4）、`LOSSLESS_MAX_DEPTH`（3）、`LOSSLESS_SUMMARY_CONCURRENCY`（4，压缩和后台每批的并行数）、`LOSSLESS_PRESUMMARIZE_AT`（0.5）、`LOSSLESS_SUMMARY_TIMEOUT_MS`（180000）、`LOSSLESS_SUMMARY_MODEL`（`provider/id`，默认当前模型）、`LOSSLESS_SUMMARY_THINKING`（off/minimal/…/max，默认跟会话）、`LOSSLESS_DB`（覆盖库路径）。
- **测试**（三层，见 PLAN"测试"）：L0 `python3 smoke/drive.py synthetic`（不调模型）、`live`、`presum`（clp/gpt-6-luna:low）；L1 `smoke/drive.py scale`（lme-bench dfde3500 第一段约 25 万 token，luna high：后台追平耗时与随后的压缩耗时）；冒烟都在 `/tmp/pi-lcm-smoke/` 下的隔离 agent 目录里跑。调模型的场景需要环境变量 `CLP_BASE_URL` / `CLP_API_KEY`（一个提供 gpt-6-luna 的 OpenAI Responses 兼容端点，也可写进仓库根目录的 `.env`，已 gitignore）；`scale` 读 `LME_BENCH`（默认 `../lme-bench`）。L2 在 lme-bench 里跑 `uv run bench.py dev`（DEV8，从本仓库某个 commit 导出插件）。
- **没做**：会话滚动（阈值要先实测 resume 耗时）、逐轮自动召回和触发调优（PLAN 第 3 步）。

## 参考

- 上游 [hermes-lcm](https://github.com/stephenschoettler/hermes-lcm)（MIT，声明见 `THIRD_PARTY_NOTICES.md`），参考版本 `8d1b1e6d3d63f5fc7b209e8d7ec1dc9b814f2e54`（v1.0.0-rc.1）。本地快照放在 `references/hermes-lcm/`，不进仓库；文中的 `engine.py:5587` 等行号都指这个版本。
