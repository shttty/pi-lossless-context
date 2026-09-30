"""PROTOTYPE — throwaway RPC driver for spike-extension.ts against the repo's Pi SDK 0.85.1 (node_modules).

usage: python3 drive.py manual|pass|threshold|overflow|resume-fork
Isolated agent dir: /tmp/pi-lcm-spike/<scenario>/agent; hook log: /tmp/pi-lcm-spike/<scenario>/hooks.jsonl
Env: CLP_BASE_URL / CLP_API_KEY (OpenAI Responses-compatible endpoint serving gpt-6-luna).
"""
import json, os, shutil, subprocess, sys, threading, queue
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLI = HERE.parents[1] / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
BASE = Path("/tmp/pi-lcm-spike")
LUNA = {"id": "gpt-6-luna", "name": "gpt-6-luna", "reasoning": True, "input": ["text", "image"],
        "contextWindow": 372000, "maxTokens": 128000,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}


def agent_dir(scn, settings, window=None):
    root = BASE / scn
    shutil.rmtree(root, ignore_errors=True)
    (root / "agent").mkdir(parents=True)
    (root / "cwd").mkdir()
    model = dict(LUNA, contextWindow=window or LUNA["contextWindow"])
    (root / "agent" / "models.json").write_text(json.dumps({"providers": {"clp": {
        "baseUrl": os.environ.get("CLP_BASE_URL", ""), "api": "openai-responses", "apiKey": os.environ.get("CLP_API_KEY", ""),
        "models": [model]}}}))
    (root / "agent" / "settings.json").write_text(json.dumps(settings))
    return root


class Pi:
    def __init__(self, root, mode, session=None):
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(root / "agent"), LCM_SPIKE_MODE=mode,
                   LCM_SPIKE_LOG=str(root / "hooks.jsonl"), PI_OFFLINE="1")
        args = ["node", str(CLI), "--mode", "rpc", "--no-extensions", "-e", str(HERE / "spike-extension.ts"),
                "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools",
                "--model", "clp/gpt-6-luna:low", "--session-dir", str(root / "sessions")]
        if session:
            args += ["--session", str(session)]
        self.p = subprocess.Popen(args, cwd=root / "cwd", env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=open(root / "stderr.log", "a"), text=True, bufsize=1)
        self.q, self.n = queue.Queue(), 0
        threading.Thread(target=lambda: [self.q.put(json.loads(l)) for l in self.p.stdout if l.strip()], daemon=True).start()

    def cmd(self, type_, wait_settled=False, timeout=900, **kw):
        self.n += 1
        rid = f"r{self.n}"
        self.p.stdin.write(json.dumps({"id": rid, "type": type_, **kw}) + "\n")
        resp, events = None, []
        while True:
            o = self.q.get(timeout=timeout)
            if o.get("type") == "response" and o.get("id") == rid:
                resp = o
                if not wait_settled or not o.get("success"):
                    return resp, events
            elif o.get("type") in ("compaction_start", "compaction_end", "auto_retry_start", "agent_settled",
                                   "extension_error"):
                events.append({k: v for k, v in o.items() if k in ("type", "reason", "willRetry", "aborted",
                                                                     "errorMessage", "error", "result")})
                if o["type"] == "agent_settled" and resp:
                    return resp, events

    def ask(self, text):
        r, ev = self.cmd("prompt", wait_settled=True, message=text)
        last = self.cmd("get_last_assistant_text")[0]["data"]["text"]
        print(f"  > {text[:60]!r} ok={r['success']} events={[e['type'] + ':' + str(e.get('reason', '')) for e in ev]}"
              f"\n    reply: {(last or '')[:120]!r}")
        return ev

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=30)


def show_hooks(root, kinds=("session_start", "session_before_compact", "session_compact", "context")):
    for l in (root / "hooks.jsonl").read_text().splitlines():
        o = json.loads(l)
        if o["event"] in kinds:
            o.pop("t")
            print("  HOOK", json.dumps(o, ensure_ascii=False)[:600])


def compaction_entries(pi):
    es = pi.cmd("get_entries")[0]["data"]["entries"]
    return [{k: e.get(k) for k in ("id", "fromHook", "firstKeptEntryId", "details")} | {"summary": e["summary"][:100]}
            for e in es if e["type"] == "compaction"]


def seed(pi):
    pad = " ".join(f"note {i}: nothing important here." for i in range(120))
    pi.ask("Remember: the codeword is BLUE-17. Reply only OK.\n" + pad)
    pi.ask("Also remember the number 42. Reply only OK.\n" + pad)
    pi.ask("Reply only OK.\n" + pad)


SMALL_KEEP = {"compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 200}}

scn = sys.argv[1]
if scn in ("manual", "pass"):
    root = agent_dir(scn, SMALL_KEEP)
    pi = Pi(root, "take" if scn == "manual" else "pass")
    seed(pi)
    r, ev = pi.cmd("compact", wait_settled=False)
    print("  compact ->", r["success"], ((r.get("data") or {}).get("summary") or r.get("error") or "")[:200])
    pi.ask("What is the codeword? If you do not know, say UNKNOWN.")
    print("  compaction entries:", json.dumps(compaction_entries(pi), ensure_ascii=False)[:800])
    pi.close()
    show_hooks(root)
elif scn == "threshold":
    # threshold = window - reserve = 372000 - 364000 = 8000 tokens
    root = agent_dir(scn, {"compaction": {"enabled": True, "reserveTokens": 364000, "keepRecentTokens": 200}})
    pi = Pi(root, "take")
    seed(pi)
    filler = " ".join(f"line {i}: the quick brown fox jumps over the lazy dog." for i in range(900))
    pi.ask("Here is filler text, reply only OK.\n" + filler)
    pi.ask("What is the codeword? If you do not know, say UNKNOWN.")
    print("  compaction entries:", json.dumps(compaction_entries(pi), ensure_ascii=False)[:800])
    pi.close()
    show_hooks(root, ("session_before_compact", "session_compact"))
elif scn == "overflow":
    # model declared with a huge window so Pi's threshold never fires; the provider must reject the request
    root = agent_dir(scn, SMALL_KEEP, window=4_000_000)
    pi = Pi(root, "take")
    seed(pi)
    filler = " ".join(f"row {i}: lorem ipsum dolor sit amet consectetur." for i in range(45000))
    pi.ask("Here is filler text, reply only OK.\n" + filler)
    print("  compaction entries:", json.dumps(compaction_entries(pi), ensure_ascii=False)[:800])
    pi.close()
    show_hooks(root, ("session_before_compact", "session_compact"))
elif scn == "resume-fork":
    root = agent_dir(scn, SMALL_KEEP)
    pi = Pi(root, "take")
    seed(pi)
    pi.cmd("compact")
    pi.ask("Reply only OK.")
    sess = next((root / "sessions").glob("*.jsonl"))
    pi.close()
    print("== resume", sess.name)
    pi = Pi(root, "take", session=sess)
    pi.ask("Reply only OK.")
    forks = pi.cmd("get_fork_messages")[0]["data"]["messages"]
    print("  fork candidates:", [(m["entryId"], m["text"][:30]) for m in forks])
    pi.close()
    after = forks[-2]  # first user message sent after the compaction
    for label, kw in (("fork after compaction", {"entryId": after["entryId"]}), ("clone", None)):
        print("==", label, kw)
        pi = Pi(root, "take", session=sess)
        r = pi.cmd("fork", **kw)[0] if kw else pi.cmd("clone")[0]
        print("  ->", r["success"], str(r.get("data") or r.get("error"))[:80])
        pi.ask("What is the codeword? If you do not know, say UNKNOWN.")
        print("  compaction entries on new session:", json.dumps(compaction_entries(pi), ensure_ascii=False)[:500])
        pi.close()
    show_hooks(root, ("session_start", "context"))
