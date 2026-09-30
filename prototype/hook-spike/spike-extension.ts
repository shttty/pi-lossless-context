// PROTOTYPE — throwaway. Logs Pi compaction/context hooks to answer: which triggers fire
// session_before_compact, does "no result" fall back to native, do details persist across resume,
// what does a fork see. Mode via LCM_SPIKE_MODE=take|pass, log via LCM_SPIKE_LOG.
import { appendFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.LCM_SPIKE_LOG ?? "/tmp/lcm-spike.jsonl";
const MODE = process.env.LCM_SPIKE_MODE ?? "take";

function log(event: string, data: Record<string, unknown>): void {
  appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n");
}

function messageText(m: AgentMessage): string {
  if ("summary" in m && typeof m.summary === "string") return m.summary;
  if (!("content" in m)) return "";
  if (typeof m.content === "string") return m.content;
  const parts: string[] = [];
  for (const b of m.content) parts.push("text" in b && typeof b.text === "string" ? b.text : `[${b.type}]`);
  return parts.join(" ");
}

export default function(pi: ExtensionAPI) {
  let n = 0;

  pi.on("session_start", async (event, ctx) => {
    const compactions = ctx.sessionManager.getBranch().flatMap((e) =>
      e.type === "compaction" ? [{ id: e.id, fromHook: e.fromHook, summary: e.summary.slice(0, 80), details: e.details }] : []);
    log("session_start", { reason: event.reason, compactions });
  });

  pi.on("session_before_compact", async (event) => {
    const { preparation: p, branchEntries, reason, willRetry } = event;
    const cut = branchEntries.findIndex((e) => e.id === p.firstKeptEntryId);
    const prev = branchEntries.map((e) => e.type).lastIndexOf("compaction");
    const sourceIds = branchEntries.slice(prev + 1, cut).filter((e) => e.type === "message").map((e) => e.id);
    log("session_before_compact", {
      mode: MODE, reason, willRetry, tokensBefore: p.tokensBefore, firstKeptEntryId: p.firstKeptEntryId,
      messagesToSummarize: p.messagesToSummarize.length, isSplitTurn: p.isSplitTurn,
      previousSummary: p.previousSummary?.slice(0, 80) ?? null, branchEntries: branchEntries.length, sourceIds,
    });
    if (MODE !== "take") return undefined;
    n += 1;
    return {
      compaction: {
        summary: `SPIKE SUMMARY #${n}: covered ${sourceIds.length} message entries.`,
        firstKeptEntryId: p.firstKeptEntryId,
        tokensBefore: p.tokensBefore,
        details: { spike: true, n, sourceIds },
      },
    };
  });

  pi.on("session_compact", async (event) => {
    const e = event.compactionEntry;
    log("session_compact", {
      reason: event.reason, fromExtension: event.fromExtension, id: e.id, fromHook: e.fromHook,
      summary: e.summary.slice(0, 120), details: e.details
    });
  });

  pi.on("context", async (event) => {
    log("context", {
      count: event.messages.length,
      messages: event.messages.map((m) => `${m.role}: ${messageText(m).slice(0, 70)}`)
    });
  });
}
