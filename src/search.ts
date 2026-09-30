// lcm_grep / session search over the shared index. Routing per PLAN.md: bigram/unigram columns for every term,
// trigram substrings for 3+ character terms, union with bigram hits ranked first. LIKE only when the FTS tables
// themselves fail; the in-memory scan only when the database cannot be used at all.
import type { SQLInputValue } from "node:sqlite";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entryToRow } from "./convert.ts";
import { errorText } from "./log.ts";
import { type DbRow, num, type Store, str, strOrNull } from "./store.ts";
import { planMatch, queryTerms } from "./tokenize.ts";

export interface Hit {
  sessionId: string;
  path: string;
  entryId: string;
  role: string | null;
  type: string;
  ts: string;
  text: string | null;
  calls: string | null;
}

export interface SearchResult {
  terms: string[];
  hits: Hit[];
  /** Distinct matching entries in scope (fork copies counted once). */
  total: number;
  notes: string[];
}

const COLUMNS = "e.session_id, e.entry_id, e.role, e.type, e.ts, e.text, e.calls, e.hash, s.path";

function toHit(r: DbRow): Hit {
  return {
    sessionId: str(r, "session_id"), path: str(r, "path"), entryId: str(r, "entry_id"), role: strOrNull(r, "role"),
    type: str(r, "type"), ts: str(r, "ts"), text: strOrNull(r, "text"), calls: strOrNull(r, "calls"),
  };
}

function scopeSql(sessionIds: readonly string[] | null): { sql: string; params: string[] } {
  if (!sessionIds) return { sql: "", params: [] };
  return { sql: `AND e.session_id IN (${sessionIds.map(() => "?").join(", ")})`, params: [...sessionIds] };
}

/** Rows ranked bigram-first, then trigram-only, deduplicated by entry id + content hash (fork copies). */
function merge(groups: DbRow[][], limit: number): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const rows of groups) {
    for (const r of rows) {
      const key = `${str(r, "entry_id")}\0${str(r, "hash")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(toHit(r));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function ftsSearch(store: Store, terms: string[], sessionIds: readonly string[] | null, limit: number): SearchResult {
  const plan = planMatch(terms);
  if (!plan) return { terms, hits: [], total: 0, notes: [] };
  const scope = scopeSql(sessionIds);
  const fetch = limit * 3;
  const bigramRows = store.db.prepare(`SELECT ${COLUMNS}, bm25(fts_bigram) AS score FROM fts_bigram
    JOIN entries e ON e.rowid = fts_bigram.rowid JOIN sessions s ON s.session_id = e.session_id
    WHERE fts_bigram MATCH ? ${scope.sql} ORDER BY score LIMIT ?`).all(plan.bigram, ...scope.params, fetch);
  let trigramRows: DbRow[] = [];
  let trigramIds = "";
  const trigramParams: SQLInputValue[] = [];
  if (plan.trigram) {
    const short = plan.shortOnly ? "AND fts_tri.rowid IN (SELECT rowid FROM fts_bigram WHERE fts_bigram MATCH ?)" : "";
    trigramParams.push(plan.trigram, ...(plan.shortOnly ? [plan.shortOnly] : []));
    trigramRows = store.db.prepare(`SELECT ${COLUMNS}, bm25(fts_tri) AS score FROM fts_tri
      JOIN entries e ON e.rowid = fts_tri.rowid JOIN sessions s ON s.session_id = e.session_id
      WHERE fts_tri MATCH ? ${short} ${scope.sql} ORDER BY score LIMIT ?`).all(...trigramParams, ...scope.params, fetch);
    trigramIds = `UNION SELECT rowid FROM fts_tri WHERE fts_tri MATCH ? ${plan.shortOnly ? "AND rowid IN (SELECT rowid FROM fts_bigram WHERE fts_bigram MATCH ?)" : ""}`;
  }
  const totalRow = store.db.prepare(`SELECT count(DISTINCT e.entry_id || char(0) || e.hash) AS n FROM entries e
    WHERE e.rowid IN (SELECT rowid FROM fts_bigram WHERE fts_bigram MATCH ? ${trigramIds}) ${scope.sql}`)
    .get(plan.bigram, ...trigramParams, ...scope.params);
  return { terms, hits: merge([bigramRows, trigramRows], limit), total: totalRow ? num(totalRow, "n") : 0, notes: [] };
}

function likeSearch(store: Store, terms: string[], sessionIds: readonly string[] | null, limit: number): SearchResult {
  const scope = scopeSql(sessionIds);
  const cond = terms.map(() => "(coalesce(e.text, '') || char(10) || coalesce(e.calls, '')) LIKE ? ESCAPE '\\'").join(" AND ");
  const params = terms.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const rows = store.db.prepare(`SELECT ${COLUMNS} FROM entries e JOIN sessions s ON s.session_id = e.session_id
    WHERE ${cond} ${scope.sql} ORDER BY e.ts DESC`).all(...params, ...scope.params);
  return { terms, hits: merge([rows], limit), total: rows.length, notes: [] };
}

export function search(store: Store, query: string, sessionIds: readonly string[] | null, limit: number): SearchResult {
  const terms = queryTerms(query);
  let result: SearchResult;
  try {
    result = ftsSearch(store, terms, sessionIds, limit);
  } catch (error) {
    result = likeSearch(store, terms, sessionIds, limit);
    result.notes.push(`索引不可用（${errorText(error)}），已退回扫描精简副本`);
  }
  const scope = scopeSql(sessionIds);
  const partial = store.db.prepare(`SELECT count(*) AS n FROM sessions e WHERE state != 'ok' ${scope.sql}`).get(...scope.params);
  const n = partial ? num(partial, "n") : 0;
  if (n > 0) result.notes.push(`${n} 个会话的索引未补完，结果可能不全（/lossless reindex 修复）`);
  return result;
}

/** Last resort when the database cannot be opened: substring scan over SDK entries (all terms, case-insensitive). */
export function scanEntries(sources: { sessionId: string; path: string; entries: readonly SessionEntry[] }[], query: string,
  limit: number, reason: string): SearchResult {
  const terms = queryTerms(query);
  const lower = terms.map((t) => t.toLowerCase());
  const hits: Hit[] = [];
  let total = 0;
  for (const s of sources) {
    for (const e of s.entries) {
      const row = entryToRow(e);
      if (!row) continue;
      const hay = `${row.text ?? ""}\n${row.calls ?? ""}`.toLowerCase();
      if (!lower.length || !lower.every((t) => hay.includes(t))) continue;
      total += 1;
      if (hits.length < limit) hits.push({
        sessionId: s.sessionId, path: s.path, entryId: e.id, role: row.role, type: row.type,
        ts: e.timestamp, text: row.text, calls: row.calls
      });
    }
  }
  return { terms, hits, total, notes: [`索引不可用（${reason}），已退回扫描会话文件`] };
}

function cut(s: string, at: number, len: number, width: number): string {
  const from = Math.max(0, at - width);
  const to = Math.min(s.length, at + len + width);
  return `${from > 0 ? "…" : ""}${s.slice(from, to).replace(/\s+/g, " ")}${to < s.length ? "…" : ""}`;
}

export function snippet(hit: Hit, terms: string[], width = 100): string {
  for (const [label, s] of [["", hit.text], ["call: ", hit.calls]] as const) {
    if (!s) continue;
    const lower = s.toLowerCase();
    for (const t of terms) {
      const at = lower.indexOf(t.toLowerCase());
      if (at >= 0) return label + cut(s, at, t.length, width);
    }
  }
  const s = hit.text ?? hit.calls ?? "";
  return cut(s, 0, 0, width * 2);
}

export function formatResult(r: SearchResult, showSession: boolean): string {
  const head = r.total === 0 ? "No matches." : `${r.total} matching entries (showing ${r.hits.length}).`;
  const lines = r.hits.map((h) => {
    const where = showSession ? ` · session ${h.sessionId.slice(0, 8)} ${h.path.split("/").pop()}` : "";
    return `[${h.entryId}] ${h.ts.slice(0, 16).replace("T", " ")} ${h.role ?? h.type}${where}: ${snippet(h, r.terms)}`;
  });
  return [...r.notes.map((n) => `NOTE: ${n}`), head, ...lines].join("\n");
}
