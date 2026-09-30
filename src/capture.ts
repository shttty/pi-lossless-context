// Index side: the shared SQLite file's lifecycle, live capture after each turn, and the resume backfill.
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { errorText, type Logger } from "./log.ts";
import { ingest, type SessionRef, Store } from "./store.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Index identity of the live session (in-memory sessions get a `memory:` path). */
export function currentRef(ctx: ExtensionContext): SessionRef {
  const sm = ctx.sessionManager;
  return {
    sessionId: sm.getSessionId(), path: sm.getSessionFile() ?? `memory:${sm.getSessionId()}`,
    parentPath: sm.getHeader()?.parentSession ?? null, cwd: sm.getCwd(),
  };
}

export interface Capture {
  readonly dbPath: string;
  /** The open index, or null when it cannot be opened (see storeError). */
  store(): Store | null;
  storeError(): string;
  /** session_start: index what the stored cursor missed, in the background, within the time budget. */
  start(ctx: ExtensionContext, reason: string): void;
  /** After a turn / compaction / at shutdown: index the new entries. */
  capture(ctx: ExtensionContext, where: string): void;
  /** A backfill is running. */
  busy(): boolean;
  /** /lossless reindex rebuilt the current session: live capture may resume. */
  reindexed(): void;
  stop(): void;
}

export function createCapture(config: Config, log: Logger, dbPath: string): Capture {
  let store: Store | null = null;
  let storeError = "";
  let backfilling = false;
  /** A backfill timed out: live capture stays off (it would chew the whole backlog synchronously) until /lossless reindex. */
  let behind = false;
  let stopped = false;

  function getStore(): Store | null {
    if (store) return store;
    try {
      store = Store.open(dbPath);
    } catch (error) {
      if (storeError !== errorText(error)) log("error", `open ${dbPath} failed: ${errorText(error)}`);
      storeError = errorText(error);
    }
    return store;
  }

  function warn(ctx: ExtensionContext, message: string): void {
    log("warn", message);
    ctx.ui.notify(`lossless-context: ${message}`, "warning");
  }

  async function backfill(ctx: ExtensionContext, reason: string): Promise<void> {
    const s = getStore();
    if (!s) {
      warn(ctx, `索引打不开（${storeError}），本会话不入库；grep 退回扫描。修复后运行 /lossless reindex`);
      return;
    }
    const ref = currentRef(ctx);
    const started = Date.now();
    backfilling = true;
    try {
      const { result, timedOut, stopped: halted } = await ingest(s, ref, () => ctx.sessionManager.getEntries(), config.batchSize,
        config.backfillBudgetMs, () => stopped);
      const ms = Date.now() - started;
      if (timedOut) {
        behind = true;
        warn(ctx, `会话 ${ref.sessionId} 补索引超时（预算 ${config.backfillBudgetMs} ms），还差 ${result.total - result.processed}/` +
          `${result.total} 条，已补的保留；本会话新消息暂停入库。修复：/lossless reindex；agent 未运行时：node ${CLI} reindex --session ${ref.path}`);
      } else if (!halted) {
        log("info", `backfill (${reason}) ${ref.sessionId}: +${result.added}, ${result.processed}/${result.total} entries in ${ms} ms` +
          `${result.rebuilt ? " (rebuilt)" : ""}`);
      }
    } catch (error) {
      behind = true;
      warn(ctx, `会话 ${ref.sessionId} 补索引失败：${errorText(error)}；本会话新消息暂停入库。修复：/lossless reindex`);
    } finally {
      backfilling = false;
    }
  }

  return {
    dbPath,
    store: getStore,
    storeError: () => storeError,
    start(ctx, reason) {
      stopped = false;
      void backfill(ctx, reason);
    },
    capture(ctx, where) {
      if (backfilling || behind || stopped) return;
      const s = getStore();
      if (!s) return;
      const ref = currentRef(ctx);
      try {
        const entries = ctx.sessionManager.getEntries();
        let r;
        do r = s.step(ref, entries, config.batchSize); while (r.processed < r.total);
        if (r.rebuilt) log("warn", `${where}: session ${ref.sessionId} cursor lost, rebuilt from ${r.total} entries`);
      } catch (error) {
        warn(ctx, `${where} 写入索引失败：${errorText(error)}`);
      }
    },
    busy: () => backfilling,
    reindexed() {
      behind = false;
    },
    stop() {
      stopped = true;
      store?.close();
      store = null;
    },
  };
}
