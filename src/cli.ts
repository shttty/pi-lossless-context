// Command-line entry for when no agent is running (same code paths as /lossless and lcm_grep).
//   node src/cli.ts reindex --session FILE | --all [--sessions DIR]
//   node src/cli.ts search QUERY [--session FILE] [--limit N]
//   node src/cli.ts status
// Common: --agent-dir DIR (default: Pi's agent dir, PI_CODING_AGENT_DIR honoured), --db FILE (default <agent-dir>/lossless-context.db)
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DB_FILE, LOG_FILE, loadConfig } from "./config.ts";
import { errorText, fileLogger } from "./log.ts";
import { formatResult, search } from "./search.ts";
import { listSessionFiles, readSessionFile, refOf } from "./sessions.ts";
import { ingest, Store } from "./store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean" },
    session: { type: "string" },
    sessions: { type: "string" },
    "agent-dir": { type: "string" },
    db: { type: "string" },
    limit: { type: "string" },
  },
});

const agentDir = resolve(values["agent-dir"] ?? getAgentDir());
const dbPath = resolve(values.db ?? join(agentDir, DB_FILE));
const log = fileLogger(join(agentDir, LOG_FILE));
const config = loadConfig();
const store = Store.open(dbPath);

async function reindexFile(path: string): Promise<number> {
  const f = readSessionFile(path);
  const ref = refOf(f.header, path);
  store.deleteSession(ref.sessionId);
  const { result } = await ingest(store, ref, () => f.entries, config.batchSize, null);
  return result.total;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = positionals;
  const started = Date.now();
  if (cmd === "reindex") {
    if (values.session) {
      const path = resolve(values.session);
      const n = await reindexFile(path);
      const msg = `cli reindex ${path}: ${n} entries in ${Date.now() - started} ms`;
      log("info", msg);
      console.log(msg);
      return 0;
    }
    if (!values.all) throw new Error("reindex needs --session FILE or --all");
    const root = resolve(values.sessions ?? join(agentDir, "sessions"));
    const files = listSessionFiles(root);
    let entries = 0;
    let failed = 0;
    for (const path of files) {
      try {
        entries += await reindexFile(path);
      } catch (error) {
        failed += 1;
        log("error", `cli reindex --all ${path}: ${errorText(error)}`);
        console.error(`FAILED ${path}: ${errorText(error)}`);
      }
    }
    const pruned = store.pruneMissing(root, new Set(files));
    const msg = `cli reindex --all ${root}: ${files.length - failed}/${files.length} sessions, ${entries} entries, ` +
      `${pruned} stale sessions dropped, ${Date.now() - started} ms`;
    log(failed ? "warn" : "info", msg);
    console.log(msg);
    return failed ? 1 : 0;
  }
  if (cmd === "search") {
    const query = rest.join(" ");
    if (!query) throw new Error("search needs a query");
    let scope: string[] | null = null;
    if (values.session) {
      const f = readSessionFile(resolve(values.session));
      scope = store.lineage(f.header.id);
    }
    const r = search(store, query, scope, Number(values.limit ?? 20));
    console.log(formatResult(r, scope === null));
    console.log(`(${Date.now() - started} ms)`);
    return 0;
  }
  if (cmd === "status") {
    const st = store.status();
    console.log(JSON.stringify({ db: dbPath, ...st }, null, 2));
    return 0;
  }
  throw new Error(`unknown command ${cmd ?? "(none)"}; use reindex | search | status`);
}

main().then((code) => {
  store.close();
  process.exitCode = code;
}, (error: unknown) => {
  store.close();
  console.error(errorText(error));
  process.exitCode = 2;
});
