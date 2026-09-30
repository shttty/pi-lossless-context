// One SQLite file per agent directory, shared by LCM (grep/expand/DAG nodes) and session search.
// Everything in it is derived from session jsonl and can be deleted and rebuilt (PLAN.md "一个 db 文件").
import { rmSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { entryToRow } from "./convert.ts";
import { bigramText, unigramText } from "./tokenize.ts";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  parent_path TEXT,
  cwd TEXT,
  cursor TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'ok',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_path ON sessions(path);
CREATE TABLE IF NOT EXISTS entries (
  rowid INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  role TEXT,
  ts TEXT NOT NULL,
  turn INTEGER NOT NULL,
  text TEXT,
  calls TEXT,
  tool_call_id TEXT,
  hash TEXT NOT NULL,
  UNIQUE (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS entries_entry ON entries(entry_id);
CREATE INDEX IF NOT EXISTS entries_seq ON entries(session_id, seq);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_bigram USING fts5(bi, uni, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS fts_tri USING fts5(text, calls, content='entries', content_rowid='rowid',
  tokenize='trigram');
CREATE TABLE IF NOT EXISTS nodes (
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  compaction_id TEXT NOT NULL,
  depth INTEGER NOT NULL,
  summary TEXT NOT NULL,
  earliest TEXT NOT NULL,
  latest TEXT NOT NULL,
  PRIMARY KEY (session_id, node_id)
);
CREATE TABLE IF NOT EXISTS node_sources (
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (session_id, node_id, ord)
);
`;

export type DbRow = Record<string, SQLOutputValue>;

export function str(r: DbRow, col: string): string {
 const v = r[col];
 if (typeof v !== "string") throw new Error(`column ${col}: expected text, got ${typeof v}`);
 return v;
}

export function strOrNull(r: DbRow, col: string): string | null {
 const v = r[col];
 if (v === null) return null;
 if (typeof v !== "string") throw new Error(`column ${col}: expected text or null, got ${typeof v}`);
 return v;
}

export function num(r: DbRow, col: string): number {
 const v = r[col];
 if (typeof v === "number") return v;
 if (typeof v === "bigint") return Number(v);
 throw new Error(`column ${col}: expected integer, got ${typeof v}`);
}

export interface SessionRef {
 sessionId: string;
 /** Session file path; `memory:<id>` for sessions without a file. */
 path: string;
 parentPath: string | null;
 cwd: string;
}

export interface StepResult {
 /** Entries of the session covered by the index after this step (cursor position + 1). */
 processed: number;
 total: number;
 /** Entries this step (or, from ingest(), the whole run) walked past the old cursor. */
 added: number;
 /** The stored cursor was not found or the header changed, so the session was dropped and restarted. */
 rebuilt: boolean;
}

function open(path: string): DatabaseSync {
 const db = new DatabaseSync(path);
 db.exec("PRAGMA busy_timeout = 5000");
 db.exec("PRAGMA journal_mode = WAL");
 db.exec("PRAGMA synchronous = NORMAL");
 return db;
}

function userVersion(db: DatabaseSync): number {
 const r = db.prepare("PRAGMA user_version").get();
 return r ? num(r, "user_version") : 0;
}

export class Store {
 readonly db: DatabaseSync;
 readonly path: string;

 constructor(db: DatabaseSync, path: string) {
  this.db = db;
  this.path = path;
 }

 /** Opens (creating if needed) the index; a file from another schema version is deleted and recreated. */
 static open(path: string): Store {
  let db = open(path);
  const version = userVersion(db);
  if (version !== 0 && version !== SCHEMA_VERSION) {
   db.close();
   for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
   db = open(path);
  }
  const store = new Store(db, path);
  store.tx(() => {
   db.exec(SCHEMA);
   db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
  return store;
 }

 close(): void {
  this.db.close();
 }

 tx<T>(fn: () => T): T {
  this.db.exec("BEGIN IMMEDIATE");
  try {
   const out = fn();
   this.db.exec("COMMIT");
   return out;
  } catch (error) {
   this.db.exec("ROLLBACK");
   throw error;
  }
 }

 /** Statements whose result is unused. BigInt reads: FTS5 'delete' commands leave last_insert_rowid beyond 2^53. */
 private run(sql: string, ...params: SQLInputValue[]): void {
  const st = this.db.prepare(sql);
  st.setReadBigInts(true);
  st.run(...params);
 }

 /** Must run inside tx(). External-content trigram rows are removed with their old values before the rows go. */
 private deleteSessionRows(sessionId: string): void {
  this.run(`INSERT INTO fts_tri(fts_tri, rowid, text, calls)
      SELECT 'delete', rowid, text, calls FROM entries WHERE session_id = ? AND (text IS NOT NULL OR calls IS NOT NULL)`, sessionId);
  this.run("DELETE FROM fts_bigram WHERE rowid IN (SELECT rowid FROM entries WHERE session_id = ? AND text IS NOT NULL)", sessionId);
  this.run("DELETE FROM entries WHERE session_id = ?", sessionId);
  this.run("DELETE FROM node_sources WHERE session_id = ?", sessionId);
  this.run("DELETE FROM nodes WHERE session_id = ?", sessionId);
  this.run("DELETE FROM sessions WHERE session_id = ?", sessionId);
 }

 deleteSession(sessionId: string): void {
  this.tx(() => this.deleteSessionRows(sessionId));
 }

 /**
  * One write transaction: index up to `maxBatch` entries after the stored cursor. The cursor is read inside the
  * transaction, so concurrent writers (live capture, backfill, another process) never double-insert.
  */
 step(ref: SessionRef, entries: readonly SessionEntry[], maxBatch: number): StepResult {
  return this.tx(() => {
   for (const r of this.db.prepare("SELECT session_id FROM sessions WHERE path = ? AND session_id != ?").all(ref.path, ref.sessionId)) {
    this.deleteSessionRows(str(r, "session_id")); // same file, new header: the file was rewritten
   }
   const cur = this.db.prepare("SELECT cursor, processed FROM sessions WHERE session_id = ?").get(ref.sessionId);
   let start = 0;
   let rebuilt = false;
   let turn = 0;
   if (cur) {
    const cursor = strOrNull(cur, "cursor");
    const processed = num(cur, "processed");
    if (cursor !== null) {
     const at = entries[processed - 1]?.id === cursor ? processed - 1 : entries.findIndex((e) => e.id === cursor);
     if (at < 0) {
      this.deleteSessionRows(ref.sessionId);
      rebuilt = true;
     } else {
      start = at + 1;
      const t = this.db.prepare("SELECT coalesce(max(turn), 0) AS t FROM entries WHERE session_id = ?").get(ref.sessionId);
      turn = t ? num(t, "t") : 0;
     }
    }
    if (!rebuilt && start === entries.length) return { processed: start, total: entries.length, added: 0, rebuilt };
   }
   const end = Math.min(entries.length, start + maxBatch);
   const insertEntry = this.db.prepare(`INSERT INTO entries
        (session_id, entry_id, parent_id, seq, type, role, ts, turn, text, calls, tool_call_id, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
   const insertTri = this.db.prepare("INSERT INTO fts_tri(rowid, text, calls) VALUES (?, ?, ?)");
   const insertBigram = this.db.prepare("INSERT INTO fts_bigram(rowid, bi, uni) VALUES (?, ?, ?)");
   const insertNode = this.db.prepare(`INSERT INTO nodes
        (session_id, node_id, compaction_id, depth, summary, earliest, latest) VALUES (?, ?, ?, ?, ?, ?, ?)`);
   const insertSource = this.db.prepare("INSERT INTO node_sources (session_id, node_id, ord, source_id) VALUES (?, ?, ?, ?)");
   for (let i = start; i < end; i++) {
    const e = entries[i];
    const row = entryToRow(e);
    if (!row) continue;
    if (row.role === "user") turn += 1;
    const { lastInsertRowid } = insertEntry.run(ref.sessionId, e.id, e.parentId, i, row.type, row.role, e.timestamp, turn,
     row.text, row.calls, row.toolCallId, row.hash);
    if (row.text !== null || row.calls !== null) insertTri.run(lastInsertRowid, row.text, row.calls);
    if (row.text !== null) insertBigram.run(lastInsertRowid, bigramText(row.text), unigramText(row.text));
    for (const n of row.nodes) {
     insertNode.run(ref.sessionId, n.id, e.id, n.depth, n.summary, n.earliest, n.latest);
     n.sources.forEach((source, ord) => insertSource.run(ref.sessionId, n.id, ord, source));
    }
   }
   this.run(`INSERT INTO sessions (session_id, path, parent_path, cwd, cursor, processed, state, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET path = excluded.path, parent_path = excluded.parent_path, cwd = excluded.cwd,
          cursor = excluded.cursor, processed = excluded.processed, state = excluded.state, updated_at = excluded.updated_at`,
    ref.sessionId, ref.path, ref.parentPath, ref.cwd, end > 0 ? entries[end - 1].id : null, end,
    end < entries.length ? "partial" : "ok", new Date().toISOString());
   return { processed: end, total: entries.length, added: end - start, rebuilt };
  });
 }

 /** This session plus the sessions it continues (header parentSession chain), nearest first. */
 lineage(sessionId: string): string[] {
  const out = [sessionId];
  let parent = this.db.prepare("SELECT parent_path FROM sessions WHERE session_id = ?").get(sessionId);
  while (parent) {
   const path = strOrNull(parent, "parent_path");
   if (path === null) break;
   const next = this.db.prepare("SELECT session_id, parent_path FROM sessions WHERE path = ?").get(path);
   if (!next || out.includes(str(next, "session_id"))) break;
   out.push(str(next, "session_id"));
   parent = next;
  }
  return out;
 }

 /** Sessions under `root` whose file no longer exists among `present`: dropped by reindex --all. */
 pruneMissing(root: string, present: ReadonlySet<string>): number {
  const gone = this.db.prepare("SELECT session_id, path FROM sessions").all()
   .filter((r) => str(r, "path").startsWith(root) && !present.has(str(r, "path")));
  for (const r of gone) this.deleteSession(str(r, "session_id"));
  return gone.length;
 }

 status(): { sessions: number; partial: string[]; entries: number; nodes: number } {
  const count = (sql: string) => {
   const r = this.db.prepare(sql).get();
   return r ? num(r, "n") : 0;
  };
  const partial = this.db.prepare("SELECT session_id FROM sessions WHERE state != 'ok'").all().map((r) => str(r, "session_id"));
  return {
   sessions: count("SELECT count(*) AS n FROM sessions"),
   partial,
   entries: count("SELECT count(*) AS n FROM entries"),
   nodes: count("SELECT count(*) AS n FROM nodes"),
  };
 }
}

export interface IngestOutcome {
 result: StepResult;
 /** Stopped because the time budget ran out; committed batches stay. */
 timedOut: boolean;
 /** Stopped because shouldStop() said so (session shutting down). */
 stopped: boolean;
}

/**
 * Batched ingest that yields to the event loop between transactions. `getEntries` is re-read every batch so
 * entries appended meanwhile are picked up. `budgetMs` null = run to the end.
 */
export async function ingest(store: Store, ref: SessionRef, getEntries: () => readonly SessionEntry[], batch: number,
 budgetMs: number | null, shouldStop: () => boolean = () => false): Promise<IngestOutcome> {
 const started = Date.now();
 let rebuilt = false;
 let added = 0;
 for (; ;) {
  const r = store.step(ref, getEntries(), batch);
  rebuilt ||= r.rebuilt;
  added += r.added;
  const result = { ...r, added, rebuilt };
  if (r.processed >= r.total) return { result, timedOut: false, stopped: false };
  if (shouldStop()) return { result, timedOut: false, stopped: true };
  if (budgetMs !== null && Date.now() - started > budgetMs) return { result, timedOut: true, stopped: false };
  await new Promise<void>((resolve) => setImmediate(resolve));
 }
}
