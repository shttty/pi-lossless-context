// Compaction side: everything that decides what a compaction produces. The background pre-summarizer builds
// leaves and condensations after each turn (parked in custom entries); session_before_compact lets a batch in flight
// land, then compacts with the summary DAG (dag.ts).
// Layering rule: compaction behaviour lives in this file or in what it imports. lme-bench keys its cached DAG
// snapshots on this file's local import closure plus index.ts; compaction logic placed on the answer side
// (capture.ts, tools.ts, search/expand/store) would silently reuse stale snapshots.
import {
  DEFAULT_COMPACTION_SETTINGS, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { compactWithDag, type DagCompactResult, presummarizeStep } from "./dag.ts";
import { errorText, type Logger } from "./log.ts";
import { PENDING_TYPE, pendingNodes } from "./nodes.ts";

export interface Compactor {
  /** session_start: read Pi's kept-token setting, then pre-summarize if the context is already past the threshold. */
  start(ctx: ExtensionContext): void;
  /** After a turn: start a background batch if context usage is past LOSSLESS_PRESUMMARIZE_AT. */
  kick(ctx: ExtensionContext): void;
  beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<DagCompactResult | undefined>;
  stop(): void;
  /** Pre-summarization part of /lossless status. */
  status(ctx: ExtensionContext): string;
}

export function createCompactor(pi: ExtensionAPI, config: Config, log: Logger, agentDir: string): Compactor {
  // One background loop at a time; paused (and awaited) while a compaction runs.
  let presum: Promise<void> | null = null;
  let paused = false;
  let stopped = false;
  let abort = new AbortController();
  let lastError = "";
  let keepRecentTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;

  function kick(ctx: ExtensionContext): void {
    if (presum || paused || stopped) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.percent < config.presummarizeAt * 100) return;
    const sessionId = ctx.sessionManager.getSessionId();
    presum = (async () => {
      let made = 0;
      const started = Date.now();
      try {
        while (!paused && !stopped) {
          const t = Date.now();
          const nodes = await presummarizeStep(ctx, config, keepRecentTokens, abort.signal, log);
          if (!nodes.length || stopped) break;
          for (const n of nodes) pi.appendEntry(PENDING_TYPE, n);
          made += nodes.length;
          log("info", `presummarize ${sessionId}: +${nodes.length} d${nodes[0].depth} (levels ${nodes.map((n) => n.level).join("")}) ` +
            `in ${Date.now() - t} ms`);
        }
        if (made) log("info", `presummarize ${sessionId}: ${made} nodes pending, ${Date.now() - started} ms`);
        lastError = "";
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = errorText(error);
        log("warn", `presummarize ${sessionId} failed: ${message}`);
        if (message !== lastError) {
          ctx.ui.notify(`lossless-context: 后台预摘要失败（${message}），下次压缩会现做这部分；相同错误不再重复提示`, "warning");
        }
        lastError = message;
      } finally {
        presum = null;
      }
    })();
  }

  return {
    start(ctx) {
      stopped = false;
      abort = new AbortController();
      try {
        keepRecentTokens = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() })
          .getCompactionSettings().keepRecentTokens;
      } catch (error) {
        log("warn", `reading compaction settings failed, pre-summarizing with keepRecentTokens=${keepRecentTokens}: ${errorText(error)}`);
      }
      kick(ctx);
    },
    kick,
    async beforeCompact(event, ctx) {
      paused = true;
      try {
        if (presum) {
          const t = Date.now();
          await presum; // let a batch in flight land; compactWithDag reuses its nodes
          log("info", `compaction (${event.reason}) waited ${Date.now() - t} ms for the background batch in flight`);
        }
        return await compactWithDag(event, ctx, config, log);
      } finally {
        paused = false;
      }
    },
    stop() {
      stopped = true;
      abort.abort();
    },
    status(ctx) {
      return `预摘要待提交节点 ${pendingNodes(ctx.sessionManager.getBranch()).length}${presum ? "（后台预摘要进行中）" : ""}`;
    },
  };
}
