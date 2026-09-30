// The one converter from SDK session entries to slim-copy rows. Both input paths (live capture from
// sessionManager.getEntries(), SDK-parsed session files for reindex) go through entryToRow.
import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isLcmDetails, type LcmNode } from "./nodes.ts";

export interface Row {
  type: string;
  role: string | null;
  text: string | null;
  calls: string | null;
  toolCallId: string | null;
  hash: string;
  nodes: LcmNode[];
}

function textOf(content: UserMessage["content"] | AssistantMessage["content"] | ToolResultMessage["content"]): string | null {
  if (typeof content === "string") return content.trim() || null;
  return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim() || null;
}

/** Tool call as searchable text: name, then each argument; strings stay raw so code and paths match literally. */
export function formatCall(name: string, args: Record<string, unknown>): string {
  const lines = [name];
  for (const [k, v] of Object.entries(args)) lines.push(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return lines.join("\n");
}

function callsOf(content: AssistantMessage["content"]): string | null {
  const calls = content.flatMap((b) => (b.type === "toolCall" ? [formatCall(b.name, b.arguments ?? {})] : []));
  return calls.length ? calls.join("\n\n") : null;
}

function row(type: string, role: string | null, text: string | null, calls: string | null, toolCallId: string | null = null,
  nodes: LcmNode[] = []): Row {
  const hash = createHash("sha1").update(`${type}\0${role}\0${text}\0${calls}`).digest("hex").slice(0, 16);
  return { type, role, text, calls, toolCallId, hash, nodes };
}

function messageRow(m: AgentMessage): Row | null {
  switch (m.role) {
    case "user":
      return row("message", "user", textOf(m.content), null);
    case "assistant":
      return row("message", "assistant", textOf(m.content), callsOf(m.content));
    case "toolResult":
      return row("message", "toolResult", null, null, m.toolCallId);
    case "bashExecution":
      return row("message", "bashExecution", null, formatCall("bash", { command: m.command }));
    default:
      return null;
  }
}

/** Null for entries that carry nothing searchable (model/thinking changes, labels, custom state, extension messages). */
export function entryToRow(e: SessionEntry): Row | null {
  switch (e.type) {
    case "message":
      return messageRow(e.message);
    case "compaction":
      if (isLcmDetails(e.details)) {
        const nodes = e.details.nodes;
        return row("compaction", null, nodes.map((n) => n.summary).join("\n\n") || null, null, null, nodes);
      }
      return row("compaction", null, e.summary || null, null);
    case "branch_summary":
      return row("branch_summary", null, e.summary || null, null);
    default:
      return null;
  }
}

/** Everything an entry holds, tool output included; used by lcm_expand full=true. */
export function renderFullEntry(e: SessionEntry): string {
  if (e.type === "compaction" || e.type === "branch_summary") return `${e.type}:\n${e.summary}`;
  if (e.type !== "message") return JSON.stringify(e);
  const m = e.message;
  switch (m.role) {
    case "user":
      return `user:\n${textOf(m.content) ?? ""}`;
    case "assistant": {
      const calls = callsOf(m.content);
      return `assistant:\n${textOf(m.content) ?? ""}${calls ? `\n[tool calls]\n${calls}` : ""}`;
    }
    case "toolResult":
      return `toolResult ${m.toolName}${m.isError ? " (error)" : ""}:\n${textOf(m.content) ?? ""}`;
    case "bashExecution":
      return `bash: ${m.command}\n${m.output}`;
    default:
      return JSON.stringify(m);
  }
}
