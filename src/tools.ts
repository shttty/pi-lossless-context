// Answer side: lcm_grep / lcm_expand over the shared index (scan fallback when it cannot be opened), and the
// /lossless status | reindex [--all] command.
import { join, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Capture, currentRef } from "./capture.ts";
import type { Compactor } from "./compaction.ts";
import type { Config } from "./config.ts";
import { expandEntry, expandFull, expandNode, locateEntry } from "./expand.ts";
import { errorText, type Logger } from "./log.ts";
import { formatResult, scanEntries, search, type SearchResult } from "./search.ts";
import { listSessionFiles, readSessionFile, refOf } from "./sessions.ts";
import { ingest, type Store } from "./store.ts";

export function registerTools(pi: ExtensionAPI, config: Config, log: Logger, agentDir: string, index: Capture,
  compactor: Compactor): void {
  function sessionsRoot(ctx: ExtensionContext): string {
    const dir = ctx.sessionManager.getSessionDir();
    const def = join(agentDir, "sessions");
    return dir === def || dir.startsWith(def + sep) ? def : dir;
  }

  function lineage(s: Store, ctx: ExtensionContext): string[] {
    return s.lineage(ctx.sessionManager.getSessionId());
  }

  pi.registerTool({
    name: "lcm_grep",
    label: "History grep",
    description:
      "Search the ORIGINAL text of past conversation: this session including everything compacted out of your context " +
      "(scope \"session\", default), or every past session of this agent (scope \"all\"). Summaries are lossy; use this for " +
      "exact details (names, numbers, dates, paths, commands, decisions) and before concluding something was never discussed. " +
      "All terms must match. Chinese words match as written; identifiers of 3+ characters also match inside longer words " +
      "(compaction finds CompactionResult). Searches message text and tool-call arguments, not tool output. " +
      "Returns entry ids with snippets; read them with lcm_expand.",
    promptSnippet: "Search the original text of this conversation (including compacted parts) or of all past sessions",
    promptGuidelines: [
      "Summaries of earlier conversation are lossy. When you need an exact earlier detail, or before saying something was not discussed, search with lcm_grep and read hits with lcm_expand.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Terms to find, space-separated (AND). Quote a phrase to keep its spaces." }),
      scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("all")], {
        description: "session (default): this conversation and the sessions it continues; all: every session of this agent",
      })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max hits (default 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const started = Date.now();
      const all = params.scope === "all";
      const limit = params.limit ?? 20;
      const s = index.store();
      let result: SearchResult;
      if (s) {
        result = search(s, params.query, all ? null : lineage(s, ctx), limit);
      } else if (!all) {
        result = scanEntries([{
          sessionId: ctx.sessionManager.getSessionId(), path: currentRef(ctx).path,
          entries: ctx.sessionManager.getEntries()
        }], params.query, limit, index.storeError());
      } else {
        const files = listSessionFiles(sessionsRoot(ctx)).map((path) => {
          const f = readSessionFile(path);
          return { sessionId: f.header.id, path, entries: f.entries };
        });
        result = scanEntries(files, params.query, limit, index.storeError());
      }
      log("info", `lcm_grep scope=${all ? "all" : "session"} q=${JSON.stringify(params.query.slice(0, 80))}: ` +
        `${result.total} matches, ${result.hits.length} shown${result.notes.length ? ", fallback" : ""}, ${Date.now() - started} ms`);
      return { content: [{ type: "text", text: formatResult(result, all) }], details: { total: result.total, notes: result.notes } };
    },
  });

  pi.registerTool({
    name: "lcm_expand",
    label: "History expand",
    description:
      "Open something from past conversation by id. An entry id (from lcm_grep or a summary) shows that message and its " +
      "neighbours; full=true shows the complete original entry including tool output. A node id (from the summary headers, " +
      "e.g. n1a2b3c4d) shows that summary and what it summarizes: lower-level summaries or the original messages.",
    parameters: Type.Object({
      id: Type.String({ description: "Entry id or summary node id" }),
      before: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Entries before (default 2)" })),
      after: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Entries after (default 2)" })),
      full: Type.Optional(Type.Boolean({ description: "Read the complete original entry, tool output included" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const s = index.store();
      const started = Date.now();
      const text = (t: string) => {
        log("info", `lcm_expand ${params.id}${params.full ? " full" : ""}: ${t.length} chars, ${Date.now() - started} ms`);
        return { content: [{ type: "text" as const, text: t }], details: {} };
      };
      const id = params.id.startsWith("c-") ? params.id.slice(2) : params.id;
      const sessions = s ? lineage(s, ctx) : [ctx.sessionManager.getSessionId()];
      if (params.full || !s) {
        let entry: SessionEntry | undefined = ctx.sessionManager.getEntry(id);
        if (!entry && s) {
          const at = locateEntry(s, id, sessions);
          if (at && !at.path.startsWith("memory:")) entry = readSessionFile(at.path).entries.find((e) => e.id === id);
        }
        if (entry) return text(expandFull(entry));
        if (!s) return text(`No entry ${id} in this session (index unavailable: ${index.storeError()}).`);
      }
      if (s) {
        const out = expandNode(s, id, sessions) ?? expandEntry(s, id, sessions, params.before ?? 2, params.after ?? 2);
        if (out) return text(out);
      }
      return text(`No entry or summary node with id ${params.id}.`);
    },
  });

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const [sub, flag] = args.trim().split(/\s+/);
    const s = index.store();
    if (!s) {
      ctx.ui.notify(`lossless-context: 索引打不开：${index.storeError()}（${index.dbPath}）`, "error");
      return;
    }
    if (sub === "reindex") {
      const started = Date.now();
      const ref = currentRef(ctx);
      const reindexCurrent = async () => {
        s.deleteSession(ref.sessionId);
        const { result } = await ingest(s, ref, () => ctx.sessionManager.getEntries(), config.batchSize, null);
        index.reindexed();
        return result.total;
      };
      if (flag !== "--all") {
        const n = await reindexCurrent();
        log("info", `reindex ${ref.sessionId}: ${n} entries in ${Date.now() - started} ms`);
        ctx.ui.notify(`lossless-context: 已重建当前会话索引（${n} 条，${Date.now() - started} ms）`, "info");
        return;
      }
      const root = sessionsRoot(ctx);
      const files = listSessionFiles(root);
      const failed: string[] = [];
      let entries = await reindexCurrent();
      for (const path of files) {
        if (path === ref.path) continue;
        try {
          const f = readSessionFile(path);
          const r = refOf(f.header, path);
          s.deleteSession(r.sessionId);
          const { result } = await ingest(s, r, () => f.entries, config.batchSize, null);
          entries += result.total;
        } catch (error) {
          failed.push(`${path}: ${errorText(error)}`);
          log("error", `reindex --all ${path}: ${errorText(error)}`);
        }
      }
      const others = files.filter((p) => p !== ref.path);
      const pruned = s.pruneMissing(root, new Set([...others, ref.path])); // the live file may not be flushed yet
      const msg = `reindex --all ${root}: current + ${others.length - failed.length}/${others.length} other sessions, ` +
        `${entries} entries, ${pruned} stale sessions dropped, ${Date.now() - started} ms`;
      log(failed.length ? "warn" : "info", msg);
      ctx.ui.notify(`lossless-context: ${msg}${failed.length ? `\n失败：\n${failed.join("\n")}` : ""}`, failed.length ? "warning" : "info");
      return;
    }
    if (sub === "status" || !sub) {
      const st = s.status();
      const ref = currentRef(ctx);
      ctx.ui.notify(`lossless-context: ${index.dbPath}\nsessions ${st.sessions}, entries ${st.entries}, nodes ${st.nodes}` +
        `${st.partial.length ? `\n未补完：${st.partial.join(", ")}` : ""}\n当前会话 ${ref.sessionId}` +
        `${index.busy() ? "（补索引中）" : ""}；${compactor.status(ctx)}`, "info");
      return;
    }
    ctx.ui.notify("用法：/lossless status | /lossless reindex [--all]", "warning");
  }

  pi.registerCommand("lossless", {
    description: "lossless-context: status | reindex [--all]",
    handler: async (args, ctx) => {
      try {
        await command(args, ctx);
      } catch (error) {
        log("error", `/lossless ${args}: ${errorText(error)}`);
        ctx.ui.notify(`lossless-context: /lossless ${args} 失败：${errorText(error)}`, "error");
      }
    },
  });
}
