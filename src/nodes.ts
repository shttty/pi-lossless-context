// Summary DAG nodes as stored in compaction entry `details` (append-only: each compaction carries only
// the nodes it created) and how the frontier is rendered into the compaction summary. Nodes built ahead of
// time by the background pre-summarizer sit in custom entries (PENDING_TYPE) until a compaction commits them.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PENDING_TYPE = "lossless-node";

export interface LcmNode {
 id: string;
 depth: number;
 summary: string;
 /** depth 0: original entry ids; depth > 0: child node ids. */
 sources: string[];
 earliest: string;
 latest: string;
 tokens: number;
 /** 1 = detailed, 2 = bullets, 3 = deterministic truncation, 0 = carried over from a non-LCM compaction. */
 level: number;
}

export interface LcmDetails {
 lossless: 1;
 nodes: LcmNode[];
}

export function isLcmDetails(details: unknown): details is LcmDetails {
 return typeof details === "object" && details !== null && "lossless" in details && details.lossless === 1
  && "nodes" in details && Array.isArray(details.nodes);
}

function isLcmNode(v: unknown): v is LcmNode {
 return typeof v === "object" && v !== null && "id" in v && typeof v.id === "string" && "depth" in v
  && typeof v.depth === "number" && "summary" in v && typeof v.summary === "string" && "sources" in v && Array.isArray(v.sources);
}

/** Pre-summarized nodes appended after the latest compaction on the branch, oldest first. */
export function pendingNodes(branch: readonly SessionEntry[]): LcmNode[] {
 let last = -1;
 for (let i = branch.length - 1; i >= 0; i--) if (branch[i].type === "compaction") { last = i; break; }
 return branch.slice(last + 1).flatMap((e) => (e.type === "custom" && e.customType === PENDING_TYPE && isLcmNode(e.data) ? [e.data] : []));
}

/**
 * Every node on the branch, oldest first. A compaction without LCM details (Pi's native fallback) becomes
 * a depth-0 node carrying its summary, so its span is not silently dropped from later frontiers.
 */
export function branchNodes(branch: readonly SessionEntry[]): LcmNode[] {
 const nodes: LcmNode[] = [];
 for (const e of branch) {
  if (e.type !== "compaction") continue;
  if (isLcmDetails(e.details)) nodes.push(...e.details.nodes);
  else nodes.push({
   id: `c-${e.id}`, depth: 0, summary: e.summary, sources: [e.id], earliest: e.timestamp, latest: e.timestamp,
   tokens: Math.ceil(e.summary.length / 4), level: 0,
  });
 }
 return nodes;
}

/** Nodes no deeper node has absorbed, oldest first. */
export function frontier(nodes: LcmNode[]): LcmNode[] {
 const absorbed = new Set(nodes.filter((n) => n.depth > 0).flatMap((n) => n.sources));
 return nodes.filter((n) => !absorbed.has(n.id)).sort((a, b) => a.earliest.localeCompare(b.earliest));
}

function minute(ts: string): string {
 return ts.slice(0, 16).replace("T", " ");
}

export function renderSummary(nodes: LcmNode[]): string {
 const head = "Earlier conversation, condensed into the summaries below (oldest first). They are lossy; the original " +
  "messages are kept. Search them with lcm_grep; open what a summary covers, or an original message, with " +
  "lcm_expand (pass the node id or an entry id).";
 const parts = nodes.map((n) => `[d${n.depth} · node ${n.id} · ${minute(n.earliest)} → ${minute(n.latest)}]\n${n.summary.trim()}`);
 return [head, ...parts].join("\n\n");
}
