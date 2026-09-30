# PLAN

## 已验证（原型在 `prototype/`，2026-09-29）

原型代码与结论在 `prototype/`；用私人会话做的查询集、语料和逐条结果不公开，只留汇总结论。

**Pi 0.85.1 接入点**（`prototype/hook-spike/FINDINGS.md`）
- `session_before_compact` 在手动、阈值两种触发下实测都会调用；溢出恢复走同一段代码（源码核对，clp 接受了 54 万 token，没能实际触发）。
- 返回 `compaction` 即接管，条目标 `fromHook: true`；不返回则退回 Pi 原生摘要。
- `details` 原样写进 jsonl 的 compaction 条目，恢复会话后可从分支读回。
- fork / clone 出的新会话文件带着整条路径，包括 compaction 条目和被压缩的原文条目，id 不变。回查在分叉后照样可用。
- 某次压缩覆盖的原文 = 分支上前一个 compaction 条目的 `firstKeptEntryId` 起（找不到则从该 compaction 条目之后起）、到本次 `firstKeptEntryId` 之前的条目，不含 compaction 条目本身；上次压缩保留下来的尾巴会在下次一起压缩（`compaction.js` `prepareCompaction`，9-30 读源码更正："前一个 compaction 条目之后"会漏掉这段尾巴）。

**回查原文的价值**（`prototype/recall-spike/FINDINGS.md`）
- lme-bench，LongMemEval_M 48 题，同一份 Pi 原生压缩快照：只加 grep/expand 两个工具，27% → 52%；证据全在被压缩段的 30 题从 3 题到 15 题。配对检验 p = 0.0018。
- 模型查了基本就能答对（18 题里对 14 题）；瓶颈是它不去查：30 题没调用工具，偏好题 8 题一次都没查。

**插件原型**（`src/`，2026-09-30；冒烟脚本 `smoke/drive.py`，隔离 agent 目录，未装进任何 profile）
- 作者真实会话的副本（38 个会话、43 MB jsonl、4930 条）：`reindex --all` 0.5–1 s；库 11 MB（trigram 5.6 MB、精简副本 2.9 MB、双字表 0.9 MB）；单次查询 2–6 ms（不含进程启动）。删除再重建两轮后两个 FTS 表完整性检查通过。
- 抽样 240 个查询词（中文 1–4 字、标识符 3–9 字符的片段）与 LIKE 对照：238 个命中数完全一致；另 2 个（`pane_id`、`SOCKET_`）FTS 比 LIKE 多，因为双字表把 `_` 当分隔符按词组匹配，是超集，不漏。
- 合成 3000 条会话（不调模型）：预算 1 ms 时补足超时告警，附两种修复命令，已提交的 50 条保留、会话标记未补完；`/lossless reindex` 81 ms 补全；文件被截短、游标丢失时 resume 整会话重建；工具输出不进索引。补足默认预算暂定 30 s，按这组数字大多数会话远用不完，大会话的实测还没做。
- 真实模型（clp/gpt-6-luna:low，叶子 600 token、扇入 2）：两次压缩各调用模型 4 次、6–11 s（两轮实测），生成 3 叶 + 1 合并、2 叶 + 2 合并，第二次不改写旧节点，上下文里只剩 2 个前沿节点；模型用 `lcm_grep` 找回被压掉的端口号，`lcm_expand` 打开节点和 `full=true` 原条目都可用；fork 后原会话和 fork 里同 id 的副本只计一次；摘要模型不存在时退回 Pi 原生压缩并告警；库打不开时扫描会话条目并注明。
- 实测到的 Pi 行为：resume 会追加一条 `thinking_level_change`；RPC `fork` 在新会话上触发两次 `session_start(fork)`（两次补足都跑，第二次无新增）。
- 实现注意：FTS5 external content 的 `'delete'` 命令之后 `last_insert_rowid` 超出 2^53，`node:sqlite` 默认按 number 读会抛错，这类语句要开 BigInt 读取。
- 速度（9-30，lme-bench dfde3500，luna high，2 万 token 叶子）：不预摘要时一次压缩 18–21 次调用、590–900 s（原生约 40 s）。hermes-lcm 默认每次触发最多做 1 片叶子、每层最多 1 组合并，从窗口 35% 起逐轮分摊（`compaction.py:515`、`engine.py:5587`），不是一次性吞下整段积压。开后台预摘要后：25 万 token 积压后台 550 s 追平（每批 4 路），随后压缩只剩 1 次调用、49 s。单次摘要调用拆开看：首个事件约 2 s（不排队）；high 先思考约 30 s 才出正文；正文 35–50 token/s；叶子目标按原文 20%（约 4k token）写，输出本身就要 80–100 s；不开思考时模型只写约 0.6–1.2k token、18–23 s。8 路并行墙钟 70 s，总吞吐约 165 token/s。
- 摘要思考档位与质量（9-30）：LongMemEval_M 里证据全落在同一片 2 万 token 叶子里的 24 题（单会话 user / assistant / preference 各 8），用插件的叶子提示词分别以不传思考、low、high 摘要，再由 luna xhigh 判"只看摘要能否答对"：不传 10/24（中位 25 s、约 1.2k token），low 16/24（39 s、1.9k），high 19/24（69 s、2.7k）。assistant 说过的细节即使 high 也只留住 3/8，这类要靠 grep/expand 回原文。每档各跑一次，未测方差。结论：摘要保留 high，提速靠后台预摘要和并行，不靠降档。hermes-lcm 在作者的 Hermes 里走辅助任务 compression（clp gpt-5.6-luna，未配 `reasoning_effort`，请求不带思考参数），相当于"不传"这一档；gpt-5.6-luna 本身未单测。

## 核心

两块都是必做的核心逻辑（2026-09-29 确认）：

- **共用索引 + grep/expand**：从被压缩的原文里精确找回。原型已证明是主要收益来源。
- **摘要 DAG**：取代 Pi 原生"上一份摘要 + 新原文再摘要"的滚动压缩。D0 叶子只摘要一小段原文、写好不再改写；叶子多了逐层合并成 D1、D2……；每个节点记来源（下层节点或原文 entry id）和时间范围。节点存进 compaction 条目的 `details`，索引从 jsonl 重建。它负责两件事：细节不被多轮转述磨掉；给模型留下"这里有东西可以展开"的线索和从粗到细的下钻路径。

## 存储

原文只在 Pi 原生会话 jsonl；SQLite 存可删、可重建的派生数据：一份精简 session history 加索引，从不写回 jsonl，代码先放本仓库（9-28 的"SQLite 只存索引"改为"索引 + 精简派生副本"，2026-09-30 定）。依据（SDK 0.85.1 源码）：`SessionManager` 构造函数私有、只按文件路径读写，没有可替换的存储后端；正常运行只 `appendFileSync` 追加，整份重写只发生在空文件初始化、版本迁移和生成分叉新文件三种情况。

- **进度与重建判定**：每个会话在 SQLite 记 header id、已处理到的 entry id（游标）和条目数；精简副本与索引在同一事务里随游标推进。游标 entry id 在会话条目里找不到、或 header id 变了，即判定文件被改写，整份重建该会话，不做逐条 diff。
- **会话滚动**：Pi 每次 resume 都把整份 jsonl 读进内存。文件超过阈值就开新会话，header 的 `parentSession` 指回上一代，并带上 DAG 顶层节点开头；索引沿 `parentSession` 串起几代，grep/expand 跨代可查。阈值按实测 resume 耗时定。
- **入库（2026-09-30 定，参考记忆插件的 OpenViking 会话捕获）**：一个换算函数（条目 → 精简副本行），两条输入路径，都不自己解析 jsonl。
  - **实时捕获（主路径）**：挂 `turn_end`、`agent_end`、`session_compact`，从 `sessionManager.getEntries()` 取游标之后的新条目（全部条目，含被放弃的分支）。user/assistant → `text`、`calls`；toolResult → 只记 `toolCallId` 和 entry id、不存内容；compaction → 摘要与 DAG 节点；其余忽略。写本地 SQLite、小事务、不排队。与记忆插件不同处：不做调用/结果配对（不存结果），所以没有整轮丢弃；按条目入库，不按轮打包；游标持久化在 SQLite，不从当前叶子重新开始。
  - **resume 补足（兜底路径）**：`session_start`（resume / startup / fork）时对当前会话补一次游标之后遗留的条目。当前会话的条目 SDK 已经载入内存，直接用 `getEntries()`，不读文件。后台运行、不阻塞会话启动，按批提交事务，已提交的进度保留，下次 resume 接着补。
  - **超时中断告警**：补足超过时间预算（可配置，默认值待实测后定）即中断，不留半截事务，并告警：说明哪个会话没补完、缺多少条，附修复命令。不静默失败。
  - **重建命令**：`/lossless reindex` 重建当前会话；`/lossless reindex --all` 重建全部会话（首次安装、从未在装插件后打开过的旧会话、fork 出的文件都靠它）；agent 没运行时用同等的命令行入口。读其他会话文件时用 SDK 导出的 `parseSessionEntries` + `migrateSessionEntries` 在内存里得到条目，交给同一个换算函数；**不用 `SessionManager.open()`**：遇到旧版本文件它会迁移后整份重写（`session-manager.js:676-677`）。命令名与命令行入口实现时再定。
- **精简 session history**（每条一行：会话 id、会话文件路径、entry id、parentId、类型、角色、时间、turn 号，外加两列内容；不记字节偏移，SDK 条目对象不带文件位置）：
  - `text`：用户消息、助手正文、compaction 摘要；不含思考、签名、usage。
  - `calls`：工具调用请求原样保留（工具名 + 参数，作者的 agent 里即 Python 代码），**工具结果不保留**（2026-09-30 定）。
  - 实测（作者本机的 OMP 与 Pi 会话，463 MB jsonl）：`text` 3.3 MB；`calls` 3.2 万次、13.5 MB（中位 169 B，p99 4.9 KB，最大 51 KB，大头是 edit/write）；合计约 17 MB，占 jsonl 3.6%。
  - 搜索片段、前后文直接读这张表，trigram 表的内容也取自这里；要看完整条目（含工具结果）才回原会话按 entry id 取：当前会话用 `sessionManager.getEntry(id)`，其他会话用 SDK 解析该文件后按 id 取。DAG 节点从 compaction 条目 `details` 解析成节点表和来源表。
- **工具输出不进精简副本和索引**：压缩时本来就丢弃（2026-09-29 定）。
- **fork 去重**：fork 出的文件带着同 entry id 的原文副本，结果按 entry id + 内容哈希去重。
- **一个 db 文件（2026-09-30 定）**：LCM 与 session_search 共用同一个 SQLite 文件，里面是同一份精简副本和索引，只按 scope 区分当前会话 / 全部。hermes-lcm 另开库是因为消息和 DAG 只存在它自己的 SQLite 里，与 Hermes `state.db` 各有独有数据；这里两者都从 jsonl 派生，没有分开的理由。
  - **位置**：每个 agent 目录一个文件（`<agent 目录>/lossless-context.db`）；session_search 的"全部"就是这个 agent 目录的会话。要跨 agent 目录搜时再加显式的会话目录列表配置。
  - **不变量**：文件里只放能从 jsonl 重建的内容。DAG 节点先随 compaction 条目写进 jsonl，再由 `session_compact` 入库；不在 db 里先生成节点、等下次压缩再补写。删文件重建必须同时恢复 LCM 和 session_search。
  - **并发**：同一 agent 目录会有多个进程同时写（实测同一 agent 目录同时有终端 `--continue` 和聊天网关拉起的 `rpc-ui`）。开 WAL + `busy_timeout`，写入都是小事务；`reindex` 与 resume 补足一样分批提交，不开长事务占写锁。
  - **schema 版本**：一个版本号，对不上就删掉文件整体重建。

## 顺序

1. 共用索引 + grep/expand。DAG 的展开也要靠它按 entry id 取回原文。（已完成）
2. 摘要 DAG，经 `session_before_compact` 接管压缩。（已完成；DEV8 上 pi-dag 2/8、pi-lcm 7/8，见"测试"）
3. 答题侧补能力：对照 hermes-lcm 除向量外的能力，按"对现有失分点的作用 > 改动成本 > 能否 3 分钟验证 > 上生产前是否必需"排序（2026-09-30 定）。现在的主要失分点是模型不查、查到一条就停。开工前先补有提升空间的测试题（见"测试"）。
   - 第一档，答题侧、不重建快照，先做：
     1. 回查策略注入：每轮在用户消息侧注入固定的回查策略（摘要只是线索、怎么写窄查询、缺证据接着查、上下文够了不硬查），不动 system prompt。对应 hermes-lcm 的 `pre_llm_call` 策略。
     2. `lcm_grep` 支持 OR（同义写法一次试完，如 `SF` / `San Francisco`）和时间过滤。
   - 第二档，主线下一步：
     3. 每轮自动召回：不靠模型决定去查。会改变上下文，要设计触发条件和预算。放在策略注入之后，看单靠引导够不够。
     4. 按会话顺序翻原文（对应 `lcm_load_session`）：命中后顺着读完整段对话。
   - 第三档，接进自己的 agent 之前必需：
     5. 会话滚动。
     6. 大工具输出外置：编码类会话的 token 大头，LongMemEval 测不出来，要用真实会话验证。
     7. 自检（对应 `lcm_status` / `lcm_doctor`）。
   - 第四档，看数据再说：
     8. 子模型读原文作答（对应 `lcm_expand_query`），每次多一次模型调用。
     9. 日期与数量计算、证据包（对应 `lcm_compute` / `lcm_evidence_pack`）：对 982b5123 这类题最对症，但工程量最大、覆盖面窄。
     10. 按时间汇总（对应 `lcm_recent` + rollups）。
     11. 事实断言抽取（对应 `lcm_query_state`）：要额外的抽取模型，最重。
   - 不做：正则脱敏、按正则忽略消息（与"落盘前不做确定性内容扫描"冲突），OpenClaw 导入。

## 测试（2026-09-30 定）

还没到跑全量的时候：每次测试 20 分钟内出结果，答题不超过 8 题，不拿端到端 bench 回答它回答不了的问题。现阶段不评估摘要模型的压缩效果。

| 层 | 回答什么 | 做法 | 耗时 | 何时跑 |
|---|---|---|---|---|
| L0 冒烟 | 插件逻辑对不对 | `smoke/drive.py synthetic`（不调模型）、`live`、`presum` | ≤ 2 分钟 | 每次改代码 |
| L1 延迟 | 压缩、预摘要要多久 | `smoke/drive.py scale` + 插件日志的逐次调用计时 | 约 10 分钟 | 改调度或并发时 |
| L2 答题 | 答对多少、查没查 | lme-bench `bench.py dev`：DEV8 上跑 pi-lcm / pi-dag，按题出对错与工具调用次数；`--only` 单题 | 复用快照约 3 分钟，重建 15–20 分钟 | 每轮改动后 |

- DEV8：证据只在被压缩段里的 8 题（single-session-user / assistant 各 3、temporal-reasoning 2）；preference、knowledge-update、multi-session 不看。基线 pi-native 0/8、pi-recall 6/8（15745da0 没查；982b5123 只查到两条证据中的一条）。第一轮（2026-09-30，插件 `83882e8`）：pi-dag 2/8、pi-lcm 7/8；答题换成 gpt-6.1-sol high，四组总分不变。剩下的 982b5123：第二条证据写的是 "SF"、没有 "Airbnb"，两个模型都只按问题里的词去搜，没去查连接两条证据的 "wedding"。
- L2 从插件某个 commit 导出 `src/` 加载，不读工作区；快照按"配置档 + 压缩侧文件（`compaction.ts` 的 import 闭包 + `index.ts`）+ bench 喂入/压缩代码 + SDK 版本"缓存，只改答题侧的提交不重建快照。
- 全量 48 题只作历史基线（`bench.py report --set all`），不在开发循环里跑。

## 已定

- **检索只用 FTS，第一版不加向量召回**（2026-09-30 定）。依据见 `prototype/embed-bench/FINDINGS.md`；约束是模型须内嵌 agent、只用 CPU、内存 ≤ 1.5 GB（2026-09-29 定）：
  - 作者自己的 29 条真实回指追问（原话，luna 从两边前 20 名合池中判定答案）：R@10 FTS 0.66、potion 0.38、RRF 0.66；R@20 RRF 0.90 对 FTS 0.83。
  - 150 个 luna 改写的中文问题：1.5 GB 以内的模型单独用最好 R@10 0.39（e5-small），FTS 双字 BM25 0.65；融合只追平。
  - 英文闲聊（LongMemEval_S / lme-bench 的 LongMemEval_M）上 potion、e5-small 追平或略胜 FTS；potion 切 200 字块在 _M 上 R@10 0.91 对 FTS 0.83。
  - potion-multilingual-128M（Model2Vec 静态向量）与官方 `model2vec` 实现逐条一致；快 40–80 倍、查询几乎零耗时，但中文 58% 的 token 是单字，按词义换说法就接不住。bge-m3、Qwen3-0.6B 等超内存线，未测召回。
  - 以后有更强的中文小模型或真实查询日志，再用这套基准重测。

- **分词与查询路由**（2026-09-30 定；实测见 `prototype/tokenizer-bench/FINDINGS.md`，排除工具输出后，50 条查询、9 种方案）：
  - 双字表：Hermes `cjk_unicode61` 的切法，用 JS 预处理实现（中文连续段切成相邻两字，两侧补空格后交给 SQLite 自带 `unicode61`），不用原生扩展，库文件任何 SQLite 都能打开。只索引 `text`，只存倒排，给自然语言查询做 BM25 排序（真实追问 R@10 0.66 靠的就是它，LCM 每轮自动召回也走它）。另设单字列（每个汉字一个 token），只给单字查询用；单字不会跨标点，所以没有按字切那种误中。中文单字、双字、多字全部命中（实测 100%）；英文按整词，中英紧挨着也能拆开（Hermes 基础表里"修改youer服务端"搜不到 `youer`）。
  - trigram 表：索引 `text` 和 `calls`，≥3 字符的查询词做精确子串匹配，覆盖标识符内部（`compaction` 找到 `CompactionResult`）；external content 指向精简副本，正文不重复存。
  - ≥3 字符的查询两张表都查、结果取并集，双字 / 整词命中排前，只有子串命中的排后（排序效果未实测）。不学 Hermes"前一步零命中才试下一个索引"：它在 unicode61 已有命中时不再查 trigram，标识符内部的命中会漏（Hermes 自读源码确认，`hermes_state_search.py:1161-1173`）。
  - 不满 3 字符的查询词：中文单字走单字列，中文 2 字走双字表，1–2 字符的英文（`ip`、`vm`）在双字表按整词匹配。已知限制：1–2 字符英文藏在别的词里（`kvm` 里的 `vm`）索引搜不到。
  - LIKE 只做最后兜底（2026-09-30 定）：线性扫描，量涨上去最先变慢，正常路径一律不走。只在所有索引手段都用不了时启用：索引缺失、损坏或正在重建，扫精简副本；精简副本也不可用时才用 SDK 解析会话文件后扫。结果注明"索引不可用，已退回扫描"。索引可用但零命中时不退回 LIKE。
  - 排除：按字切（跨标点误中：`网关` 命中"网/关"）、词典分词（ICU、jieba）和模型 tokenizer（BGE-M3）——查询词在文中被切成别的词就漏（`索引` 在"搜索引擎"里），BGE-M3 tokenizer 对 `firstKeptEntryId`、IP 0%。

## 待定

- 无。
