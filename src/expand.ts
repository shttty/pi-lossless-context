// lcm_expand: an entry id → that entry and its neighbours from the slim copy (or the full original entry, tool
// output included, read back from the session); a node id → the node and what it summarizes.
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { renderFullEntry } from "./convert.ts";
import { type DbRow, num, type Store, str, strOrNull } from "./store.ts";

export const MAX_EXPAND_CHARS = 16_000;

function clip(out: string): string {
  return out.length > MAX_EXPAND_CHARS ? `${out.slice(0, MAX_EXPAND_CHARS)}\n[truncated at ${MAX_EXPAND_CHARS} chars]` : out;
}

function when(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

function renderRow(r: DbRow, requested: boolean): string {
  const role = strOrNull(r, "role") ?? str(r, "type");
  const head = `--- [${str(r, "entry_id")}] ${when(str(r, "ts"))} ${role}${requested ? " (requested)" : ""}`;
  if (role === "toolResult") {
    return `${head}\n[tool output not indexed; lcm_expand with full=true on this id reads it]`;
  }
  const text = strOrNull(r, "text");
  const calls = strOrNull(r, "calls");
  return [head, text, calls ? `[tool calls]\n${calls}` : null].filter((x) => x !== null).join("\n");
}

/** Prefer a copy in `sessionIds` (current lineage), else any session that has the entry. */
function findEntryRow(store: Store, entryId: string, sessionIds: readonly string[]): DbRow | undefined {
  const rows = store.db.prepare("SELECT e.*, s.path FROM entries e JOIN sessions s ON s.session_id = e.session_id WHERE e.entry_id = ?")
    .all(entryId);
  return rows.find((r) => sessionIds.includes(str(r, "session_id"))) ?? rows[0];
}

export interface EntryLocation {
  sessionId: string;
  path: string;
}

export function locateEntry(store: Store, entryId: string, sessionIds: readonly string[]): EntryLocation | null {
  const r = findEntryRow(store, entryId, sessionIds);
  return r ? { sessionId: str(r, "session_id"), path: str(r, "path") } : null;
}

export function expandEntry(store: Store, entryId: string, sessionIds: readonly string[], before: number, after: number): string | null {
  const r = findEntryRow(store, entryId, sessionIds);
  if (!r) return null;
  const sessionId = str(r, "session_id");
  const seq = num(r, "seq");
  const around = (cmp: string, order: string, n: number) => n === 0 ? [] : store.db.prepare(
    `SELECT * FROM entries WHERE session_id = ? AND seq ${cmp} ? ORDER BY seq ${order} LIMIT ?`).all(sessionId, seq, n);
  const rows = [...around("<", "DESC", before).reverse(), r, ...around(">", "ASC", after)];
  const where = sessionIds.includes(sessionId) ? "" : `(from session ${sessionId}, ${str(r, "path")})\n`;
  return clip(where + rows.map((x) => renderRow(x, x === r)).join("\n"));
}

export function expandFull(entry: SessionEntry): string {
  return clip(`--- [${entry.id}] ${when(entry.timestamp)} full original entry\n${renderFullEntry(entry)}`);
}

/** Node ids are unique per session; fork copies share them, so the current lineage wins. */
export function expandNode(store: Store, nodeId: string, sessionIds: readonly string[]): string | null {
  const nodes = store.db.prepare("SELECT * FROM nodes WHERE node_id = ?").all(nodeId);
  const node = nodes.find((n) => sessionIds.includes(str(n, "session_id"))) ?? nodes[0];
  if (!node) return null;
  const sessionId = str(node, "session_id");
  const depth = num(node, "depth");
  const sources = store.db.prepare("SELECT source_id FROM node_sources WHERE session_id = ? AND node_id = ? ORDER BY ord")
    .all(sessionId, nodeId).map((s) => str(s, "source_id"));
  const parts = [`[d${depth} · node ${nodeId} · ${when(str(node, "earliest"))} → ${when(str(node, "latest"))}]`, str(node, "summary"), ""];
  if (depth > 0) {
    parts.push(`Summarizes ${sources.length} d${depth - 1} nodes (lcm_expand a node id to go deeper):`);
    const child = store.db.prepare("SELECT * FROM nodes WHERE session_id = ? AND node_id = ?");
    for (const id of sources) {
      const c = child.get(sessionId, id);
      if (!c) {
        parts.push(`--- ${id} (not a stored node; for a c-<id> node pass the compaction entry id)`);
        continue;
      }
      parts.push(`--- [d${num(c, "depth")} · node ${id} · ${when(str(c, "earliest"))} → ${when(str(c, "latest"))}]\n${str(c, "summary")}`);
    }
  } else {
    parts.push(`Summarizes ${sources.length} original entries (lcm_expand an entry id for neighbours or full=true for tool output):`);
    const row = store.db.prepare("SELECT * FROM entries WHERE session_id = ? AND entry_id = ?");
    for (const id of sources) {
      const e = row.get(sessionId, id);
      parts.push(e ? renderRow(e, false) : `--- [${id}] (not indexed)`);
    }
  }
  return clip(parts.join("\n"));
}
