"""PROTOTYPE smoke driver for src/index.ts against the repo's own Pi SDK 0.85.1 (node_modules), RPC mode.

usage: python3 smoke/drive.py synthetic | live
  synthetic  no model calls: resume backfill over a generated 3000-entry session (timeout warning, /lossless reindex,
             rewritten-file rebuild, CLI reindex/search)
  live       clp/gpt-6-luna:low: live capture, two DAG compactions, lcm_grep/lcm_expand via the model, fork,
             model failure -> native fallback, unopenable db -> scan fallback
Isolated agent dir under /tmp/pi-lcm-smoke/<scenario>/; nothing outside it is written.
Model endpoint: CLP_BASE_URL / CLP_API_KEY (an OpenAI Responses-compatible endpoint serving gpt-6-luna), from the
environment or the repo's gitignored .env. `scale` reads the lme-bench checkout at LME_BENCH (default ../lme-bench).
"""
import json, os, queue, shutil, sqlite3, subprocess, sys, threading, time, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
for _line in (REPO / ".env").read_text().splitlines() if (REPO / ".env").exists() else []:
    _k, _, _v = _line.partition("=")
    if _k.strip() and not _k.startswith("#"):
        os.environ.setdefault(_k.strip(), _v.strip())
CLI = REPO / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
EXT = REPO / "src/index.ts"
BASE = Path("/tmp/pi-lcm-smoke")
LUNA = {"id": "gpt-6-luna", "name": "gpt-6-luna", "reasoning": True, "input": ["text", "image"],
        "contextWindow": 372000, "maxTokens": 128000,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}


def check(ok, what):
    print(f"  {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        check.failed += 1
check.failed = 0


def setup(scn, settings):
    root = BASE / scn
    shutil.rmtree(root, ignore_errors=True)
    (root / "agent").mkdir(parents=True)
    (root / "cwd").mkdir()
    (root / "sessions").mkdir()
    (root / "agent" / "models.json").write_text(json.dumps({"providers": {"clp": {
        "baseUrl": os.environ.get("CLP_BASE_URL", ""), "api": "openai-responses", "apiKey": os.environ.get("CLP_API_KEY", ""),
        "models": [LUNA]}}}))
    (root / "agent" / "settings.json").write_text(json.dumps(settings))
    return root


def db_query(root, sql, *args, db=None):
    con = sqlite3.connect(f"file:{db or root / 'agent/lossless-context.db'}?mode=ro", uri=True)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def log_lines(root):
    p = root / "agent/lossless-context.log"
    return p.read_text().splitlines() if p.exists() else []


class Pi:
    def __init__(self, root, session=None, env=None, extension=True, model="clp/gpt-6-luna:low"):
        e = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), PI_OFFLINE="1", **(env or {}))
        args = ["node", str(CLI), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates",
                "--no-context-files", "--no-builtin-tools", "--model", model, "--session-dir", str(root / "sessions")]
        if extension:
            args[4:4] = ["-e", str(EXT)]
        if session:
            args += ["--session", str(session)]
        self.p = subprocess.Popen(args, cwd=root / "cwd", env=e, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=open(root / "stderr.log", "a"), text=True, bufsize=1)
        self.q, self.n, self.events = queue.Queue(), 0, []
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout if l.strip()], daemon=True).start()

    def _next(self, timeout):
        o = self.q.get(timeout=timeout)
        self.events.append(o)
        return o

    def cmd(self, type_, wait_settled=False, timeout=900, **kw):
        self.n += 1
        rid = f"r{self.n}"
        self.p.stdin.write(json.dumps({"id": rid, "type": type_, **kw}) + "\n")
        resp = None
        deadline = time.time() + timeout
        while True:
            o = self._next(max(1, deadline - time.time()))
            if o.get("type") == "response" and o.get("id") == rid:
                resp = o
                if not wait_settled or not o.get("success"):
                    return resp
            elif o.get("type") == "agent_settled" and resp:
                return resp

    def drain(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                self._next(0.2)
            except queue.Empty:
                pass

    def notes(self):
        return [(o.get("notifyType", "info"), o.get("message", "")) for o in self.events
                if o.get("type") == "extension_ui_request" and o.get("method") == "notify"]

    def tool_results(self, name):
        return ["\n".join(c.get("text", "") for c in o["result"]["content"]) for o in self.events
                if o.get("type") == "tool_execution_end" and o.get("toolName") == name]

    def ask(self, text):
        r = self.cmd("prompt", wait_settled=True, message=text)
        last = self.cmd("get_last_assistant_text")["data"]["text"] or ""
        print(f"  > {text[:70]!r} ok={r['success']} reply={last[:140]!r}")
        return last

    def entries(self):
        return self.cmd("get_entries")["data"]["entries"]

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=60)
        self.drain(0.3)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def synthetic_session(path, n, cwd):
    t0 = datetime(2026, 9, 1, tzinfo=timezone.utc)
    sid = str(uuid.uuid4())
    lines = [{"type": "session", "version": 3, "id": sid, "timestamp": iso(t0), "cwd": str(cwd)}]
    parent = None
    for i in range(n):
        eid = f"{i:08x}"
        ts = iso(t0 + timedelta(seconds=i))
        if i % 3 == 0:
            msg = {"role": "user", "content": f"第{i}条：检查服务端口配置，编号 NEEDLE{i:05d}，网关不要重启。", "timestamp": 0}
        elif i % 3 == 1:
            msg = {"role": "assistant", "content": [{"type": "text", "text": f"收到，第{i}条已记录。"},
                   {"type": "toolCall", "id": f"call{i}", "name": "eval", "arguments": {"code": f"rebuildFrontierIndex({i})"}}],
                   "api": "openai-responses", "provider": "clp", "model": "gpt-6-luna", "stopReason": "toolUse", "timestamp": 0,
                   "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                             "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}
        else:
            msg = {"role": "toolResult", "toolCallId": f"call{i - 1}", "toolName": "eval",
                   "content": [{"type": "text", "text": f"TOOL-OUTPUT-SECRET-{i}"}], "isError": False, "timestamp": 0}
        lines.append({"type": "message", "id": eid, "parentId": parent, "timestamp": ts, "message": msg})
        parent = eid
    path.write_text("".join(json.dumps(l, ensure_ascii=False) + "\n" for l in lines))
    return sid


def run_cli(root, *args):
    r = subprocess.run(["node", str(REPO / "src/cli.ts"), *args, "--agent-dir", str(root / "agent")],
                       capture_output=True, text=True, timeout=300)
    return r.returncode, r.stdout.strip()


def synthetic():
    root = setup("synthetic", {"compaction": {"enabled": False}})
    sess = root / "sessions" / "synthetic.jsonl"
    sid = synthetic_session(sess, 3000, root / "cwd")
    rows = lambda: db_query(root, "SELECT processed, state FROM sessions WHERE session_id = ?", sid)

    print("== resume with 1 ms backfill budget, batch 50 -> timeout warning, partial index kept")
    pi = Pi(root, sess, env={"LOSSLESS_BACKFILL_BUDGET_MS": "1", "LOSSLESS_BATCH_SIZE": "50"})
    pi.cmd("get_state")
    pi.drain(3)
    warn = [m for k, m in pi.notes() if k == "warning" and "补索引超时" in m]
    check(len(warn) == 1, f"timeout warning: {warn[0][:160] if warn else pi.notes()}")
    check(bool(warn) and "/lossless reindex" in warn[0] and "cli.ts reindex --session" in warn[0], "warning carries both fix commands")
    got = rows()
    total = len(pi.entries())  # generated 3000 + what Pi appends on resume (thinking level)
    check(got and got[0][1] == "partial" and 0 < got[0][0] < total, f"partial progress committed: {got} of {total}")

    print("== /lossless reindex (extension command, no model call)")
    pi.cmd("prompt", message="/lossless reindex")
    pi.drain(3)
    info = [m for k, m in pi.notes() if "已重建当前会话索引" in m]
    check(bool(info), f"reindex notify: {info[:1]}")
    check(rows() == [(total, "ok")], f"session fully indexed: {rows()} of {total}")
    n = db_query(root, "SELECT count(*), sum(role = 'toolResult'), sum(text LIKE '%TOOL-OUTPUT%') FROM entries WHERE session_id = ?", sid)[0]
    check(n == (3000, 1000, 0), f"rows / toolResult rows / tool output leaked into text: {n}")
    pi.cmd("prompt", message="/lossless status")
    pi.drain(2)
    check(any("entries 3000" in m for _, m in pi.notes()), "status reports 3000 entries")
    pi.close()

    print("== resume with default budget: cursor at end, nothing to do")
    pi = Pi(root, sess)
    pi.cmd("get_state")
    pi.drain(2)
    check(not [m for k, m in pi.notes() if k == "warning"], f"no warnings: {pi.notes()}")
    pi.close()

    print("== file rewritten (last 300 lines dropped, cursor gone) -> rebuild on resume")
    lines = sess.read_text().splitlines(keepends=True)[:-300]
    sess.write_text("".join(lines))
    kept = [json.loads(l) for l in lines[1:]]
    users = sum(1 for e in kept if e["type"] == "message" and e["message"]["role"] == "user")
    calls = sum(1 for e in kept if e["type"] == "message" and e["message"]["role"] == "assistant")
    pi = Pi(root, sess)
    pi.cmd("get_state")
    pi.drain(3)
    total = len(pi.entries())
    pi.close()
    check(rows() == [(total, "ok")], f"rebuilt to {total}: {rows()}")
    check(any("(rebuilt)" in l for l in log_lines(root)), "log records the rebuild")

    print("== CLI: reindex --session, reindex --all, search (bigram, unigram, trigram substring, calls)")
    code, out = run_cli(root, "reindex", "--session", str(sess))
    check(code == 0 and f"{total} entries" in out, out)
    code, out = run_cli(root, "reindex", "--all", "--sessions", str(root / "sessions"))
    check(code == 0 and "1/1 sessions" in out, out)
    for q, expect in [("NEEDLE02997", 0), ("NEEDLE02697", 1), ("网关", users), ("端", users), ("FrontierInd", calls),
                      ("rebuildFrontierIndex 1234", 1)]:
        code, out = run_cli(root, "search", q, "--limit", "2")
        first = out.splitlines()[0]
        check(code == 0 and (first.startswith(f"{expect} matching") if expect else first == "No matches."), f"search {q!r}: {first}")
    code, out = run_cli(root, "search", "TOOL-OUTPUT-SECRET")
    check(out.splitlines()[0] == "No matches.", "tool output not searchable")


def live():
    settings = {"compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 200}}
    root = setup("live", settings)
    env = {"LOSSLESS_LEAF_TOKENS": "600", "LOSSLESS_FANIN": "2"}
    pad = " ".join(f"备注{i}：这一行没有要紧内容。" for i in range(60))
    facts = ["记住：项目代号是 蓝鲸-17。只回复 OK。", "记住：服务端口是 48213。只回复 OK。",
             "记住：负责重建的函数叫 rebuildFrontierIndex。只回复 OK。", "记住：周四下午例会。只回复 OK。"]

    print("== live capture over 4 turns")
    pi = Pi(root, env=env)
    for f in facts:
        pi.ask(f + "\n" + pad)
    sid = pi.cmd("get_state")["data"]["sessionId"]
    msgs = [e for e in pi.entries() if e["type"] == "message"]
    got = db_query(root, "SELECT count(*) FROM entries WHERE session_id = ?", sid)[0][0]
    check(got == len(msgs), f"indexed {got} of {len(msgs)} message entries without a resume")

    print("== compaction 1 (leaf 600 tokens, fan-in 2)")
    t = time.time()
    r = pi.cmd("compact")
    print(f"  compact ok={r['success']} {time.time() - t:.0f}s {str(r.get('error') or '')[:200]}")
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    nodes1 = comp[-1].get("details", {}).get("nodes", []) if comp else []
    check(comp and comp[-1].get("fromHook") is True and nodes1, f"LCM compaction entry with {len(nodes1)} nodes")
    check(any(n["depth"] > 0 for n in nodes1), f"condensed nodes created: depths {[n['depth'] for n in nodes1]}")
    check(comp and "lcm_grep" in comp[-1]["summary"] and "node n" in comp[-1]["summary"], "summary renders frontier headers")
    got = db_query(root, "SELECT count(*) FROM nodes WHERE session_id = ?", sid)[0][0]
    check(got == len(nodes1), f"nodes indexed via session_compact: {got}")

    print("== two more turns, compaction 2 builds on the existing frontier")
    pi.ask("记住：备用端口是 48214。只回复 OK。\n" + pad)
    pi.ask("记住：数据库文件叫 lossless-context.db。只回复 OK。\n" + pad)
    r = pi.cmd("compact")
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    nodes2 = comp[-1].get("details", {}).get("nodes", []) if len(comp) > 1 else []
    old_ids = {n["id"] for n in nodes1}
    check(len(comp) == 2 and nodes2, f"second LCM compaction with {len(nodes2)} new nodes")
    check(all(n["id"] not in old_ids for n in nodes2), "old nodes not rewritten (append-only details)")
    top = [l for l in comp[-1]["summary"].splitlines() if l.startswith("[d")] if comp else []
    print("  frontier:", top)

    print("== model uses the tools")
    ans = pi.ask("早先对话里的服务端口是多少？先用 lcm_grep 查原文，再只回答数字。")
    grep_out = pi.tool_results("lcm_grep")
    check(any("48213" in g for g in grep_out), f"lcm_grep returned the port: {(grep_out or [''])[-1][:200]!r}")
    check("48213" in ans, "answer has 48213")
    node = (top[-1].split("node ")[1].split(" ")[0]) if top else "n0"
    pi.ask(f"用 lcm_expand 打开节点 {node}，说出它覆盖的下层数量。")
    exp = pi.tool_results("lcm_expand")
    check(any(f"node {node}" in x and "Summarizes" in x for x in exp), f"lcm_expand node: {(exp or [''])[-1][:200]!r}")
    pi.ask("用 lcm_grep 找 rebuildFrontierIndex，然后用 lcm_expand 的 full=true 打开命中的那条，告诉我它的角色。")
    check(any("full original entry" in x for x in pi.tool_results("lcm_expand")), "lcm_expand full=true read the original entry")
    forks = pi.cmd("get_fork_messages")["data"]["messages"]
    sess_file = pi.cmd("get_state")["data"]["sessionFile"]
    pi.close()

    print("== fork: new file with copied entries; search dedupes, nodes expand in the fork")
    pi = Pi(root, sess_file, env=env)
    r = pi.cmd("fork", entryId=forks[-1]["entryId"])
    pi.drain(3)
    fsid = pi.cmd("get_state")["data"]["sessionId"]
    check(fsid != sid and db_query(root, "SELECT count(*) FROM entries WHERE session_id = ?", fsid)[0][0] > 0, "fork indexed by backfill")
    truth = db_query(root, """SELECT count(DISTINCT entry_id || char(0) || hash), count(*) FROM entries
        WHERE session_id IN (?, ?) AND coalesce(text, '') || coalesce(calls, '') LIKE '%48213%'""", fsid, sid)[0]
    pi.ask("用 lcm_grep 搜 48213，只报告工具返回的第一行。")
    g = pi.tool_results("lcm_grep")
    check(truth[1] > truth[0] and bool(g) and g[-1].startswith(f"{truth[0]} matching"),
          f"fork + parent copies ({truth[1]} rows, {truth[0]} distinct) counted once: {(g or [''])[-1][:60]!r}")
    pi.close()

    print("== summary model missing -> Pi native compaction, with warning")
    pi = Pi(root, env={**env, "LOSSLESS_SUMMARY_MODEL": "nope/none"})
    pi.ask("记住：测试回退。只回复 OK。\n" + pad)
    pi.ask("只回复 OK。\n" + pad)
    r = pi.cmd("compact")
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    check(r["success"] and comp and not comp[-1].get("fromHook"), f"native compaction ran: fromHook={comp[-1].get('fromHook') if comp else None}")
    check(any(k == "warning" and "退回 Pi 原生压缩" in m for k, m in pi.notes()), "fallback warning")
    pi.close()

    print("== db cannot be opened -> warning at start, lcm_grep scans the session")
    pi = Pi(root, sess_file, env={**env, "LOSSLESS_DB": str(root / "missing-dir/x.db")})
    pi.cmd("get_state")
    pi.drain(2)
    check(any(k == "warning" and "索引打不开" in m for k, m in pi.notes()), "open failure warned")
    pi.ask("用 lcm_grep 搜 蓝鲸，只报告工具返回的前两行。")
    g = pi.tool_results("lcm_grep")
    check(bool(g) and "索引不可用" in g[-1] and "蓝鲸" in g[-1], f"scan fallback: {(g or [''])[-1][:160]!r}")
    pi.close()
    print("log:\n  " + "\n  ".join(log_lines(root)[-12:]))


def presum_idle(pi, timeout=300):
    """Poll /lossless status until the background pre-summarizer is idle; returns the last status text."""
    end = time.time() + timeout
    while time.time() < end:
        n0 = len(pi.events)
        pi.cmd("prompt", message="/lossless status")
        pi.drain(0.5)
        msgs = [o.get("message", "") for o in pi.events[n0:] if o.get("method") == "notify"]
        if msgs and "后台预摘要进行中" not in msgs[-1]:
            return msgs[-1]
        time.sleep(2)
    raise TimeoutError("pre-summarizer still busy")


def pending_ids(pi):
    return [e["data"]["id"] for e in pi.entries() if e["type"] == "custom" and e.get("customType") == "lossless-node"]


def presum():
    root = setup("presum", {"compaction": {"enabled": False, "reserveTokens": 16384, "keepRecentTokens": 200}})
    env = {"LOSSLESS_LEAF_TOKENS": "600", "LOSSLESS_FANIN": "2", "LOSSLESS_PRESUMMARIZE_AT": "0.001"}
    pad = " ".join(f"备注{i}：这一行没有要紧内容。" for i in range(60))
    facts = ["记住：项目代号是 蓝鲸-17。只回复 OK。", "记住：服务端口是 48213。只回复 OK。",
             "记住：负责重建的函数叫 rebuildFrontierIndex。只回复 OK。", "记住：周四下午例会。只回复 OK。",
             "记住：备用端口是 48214。只回复 OK。"]

    print("== 5 turns; the background pre-summarizer runs after each turn")
    pi = Pi(root, env=env)
    for f in facts:
        pi.ask(f + "\n" + pad)
    status = presum_idle(pi)
    print("  status:", status.replace("\n", " | ")[-120:])
    pend = pending_ids(pi)
    check(len(pend) >= 3, f"pending nodes parked in custom entries: {len(pend)}")
    check(not [m for k, m in pi.notes() if k == "warning"], f"no warnings: {[m for k, m in pi.notes() if k == 'warning']}")
    sid = pi.cmd("get_state")["data"]["sessionId"]
    check(db_query(root, "SELECT count(*) FROM nodes WHERE session_id = ?", sid)[0][0] == 0, "pending nodes are not in the index yet")

    print("== compaction reuses them")
    t = time.time()
    r = pi.cmd("compact")
    took = time.time() - t
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    nodes = comp[-1]["details"]["nodes"] if comp and comp[-1].get("fromHook") else []
    reused = [n for n in nodes if n["id"] in set(pend)]
    line = [l for l in log_lines(root) if "compaction (manual)" in l][-1:]
    print(f"  compact ok={r['success']} {took:.1f}s  {line[0][25:] if line else ''}")
    check(len(reused) == len(pend), f"all {len(pend)} pending nodes committed in details ({len(nodes)} nodes total)")
    check(bool(line) and "reused" in line[0], "log reports reuse")
    check(db_query(root, "SELECT count(*) FROM nodes WHERE session_id = ?", sid)[0][0] == len(nodes), "committed nodes indexed")
    check(not pending_ids_after_last_compaction(pi), "no pending nodes left after the compaction")
    sess_file = pi.cmd("get_state")["data"]["sessionFile"]
    pi.close()

    print("== larger keepRecentTokens at compaction time: pending leaves outside the cut are dropped")
    pi = Pi(root, sess_file, env=env)
    for f in ["记住：新的项目代号是 白鲸-3。只回复 OK。", "记住：新端口是 58000。只回复 OK。", "只回复 OK。"]:
        pi.ask(f + "\n" + pad)
    presum_idle(pi)
    pend = pending_ids_after_last_compaction(pi)
    es = pi.entries()
    last = max(i for i, e in enumerate(es) if e["type"] == "compaction")
    leaves = [e["data"] for e in es[last + 1:] if e["type"] == "custom" and e.get("customType") == "lossless-node"
              and e["data"]["depth"] == 0]
    pi.close()
    # keepRecentTokens reaching back exactly to the newest pending leaf (Pi estimates chars/4): that leaf now overlaps
    # the kept region and must be dropped, older leaves stay usable.
    at = next(i for i, e in enumerate(es) if e["id"] == leaves[-1]["sources"][0])
    text = lambda m: m["content"] if isinstance(m["content"], str) else "".join(b.get("text", "") for b in m["content"])
    keep = sum(-(-len(text(e["message"])) // 4) for e in es[at:] if e["type"] == "message")
    (root / "agent" / "settings.json").write_text(json.dumps(
        {"compaction": {"enabled": False, "reserveTokens": 16384, "keepRecentTokens": keep}}))
    pi = Pi(root, sess_file, env={**env, "LOSSLESS_PRESUMMARIZE_AT": "1"})  # no new background work
    r = pi.cmd("compact")
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    nodes = comp[-1]["details"]["nodes"] if comp and comp[-1].get("fromHook") else []
    kept = [n for n in nodes if n["id"] in set(pend)]
    first_kept = comp[-1]["firstKeptEntryId"] if comp else None
    order = [e["id"] for e in pi.entries()]
    inside = all(order.index(s) < order.index(first_kept) for n in nodes if n["depth"] == 0 for s in n["sources"])
    print(f"  pending {len(pend)}, reused {len(kept)}, leaves all before firstKept: {inside}")
    check(r["success"] and 0 < len(kept) < len(pend), f"pending nodes outside the new cut dropped, the rest reused ({r.get('error')})")
    check(inside, "committed leaves only cover entries before firstKeptEntryId")
    pi.close()
    print("log:\n  " + "\n  ".join(log_lines(root)[-14:]))


def pending_ids_after_last_compaction(pi):
    es = pi.entries()
    last = max((i for i, e in enumerate(es) if e["type"] == "compaction"), default=-1)
    return [e["data"]["id"] for e in es[last + 1:] if e["type"] == "custom" and e.get("customType") == "lossless-node"]



def scale():
    """lme-bench dfde3500 first chunk (~250k tokens, luna high): background catch-up time, then compaction latency."""
    sys.path.insert(0, os.environ.get("LME_BENCH", str(REPO.parent / "lme-bench")))
    import bench
    root = setup("scale", {"compaction": {"enabled": False}})
    q = next(q for q in bench.load_sample() if q["question_id"] == "dfde3500")
    sess = root / "sessions" / "dfde3500.jsonl"
    bench.build_session(q, sess, pi=True)
    lines = bench.jsonl_lines(sess)
    cuts = bench.chunk_cuts(lines[1:], 4)
    sess.write_text("\n".join(lines[:1] + lines[1:1 + cuts[0]]) + "\n")
    env = {"LOSSLESS_SUMMARY_CONCURRENCY": os.environ.get("CONC", "4")}
    pi = Pi(root, sess, env=env, model="clp/gpt-6-luna:high")
    t = time.time()
    status = presum_idle(pi, timeout=3600)
    bg = time.time() - t
    pend = pending_ids(pi)
    print(f"  background: {len(pend)} pending nodes in {bg:.0f}s; status: {status.replace(chr(10), ' | ')[-80:]}")
    t = time.time()
    r = pi.cmd("compact", timeout=3600)
    took = time.time() - t
    comp = [e for e in pi.entries() if e["type"] == "compaction"]
    print(f"  compact ok={r['success']} {took:.0f}s fromHook={comp[-1].get('fromHook') if comp else None} "
          f"summary {len(comp[-1]['summary']) if comp else 0} chars")
    pi.close()
    print("log:\n  " + "\n  ".join(log_lines(root)[-30:]))

if __name__ == "__main__":
    {"synthetic": synthetic, "live": live, "presum": presum, "scale": scale}[sys.argv[1]]()
    print(f"FAILED CHECKS: {check.failed}")
    sys.exit(1 if check.failed else 0)
