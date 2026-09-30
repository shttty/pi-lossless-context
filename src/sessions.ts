// Reading session files that are not the live session: SDK parse + in-memory migration, never SessionManager.open()
// (it rewrites old-version files, session-manager.js:676-677).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  migrateSessionEntries, parseSessionEntries, type SessionEntry, type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import type { SessionRef } from "./store.ts";

export interface SessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
}

export function readSessionFile(path: string): SessionFile {
  const fileEntries = parseSessionEntries(readFileSync(path, "utf8"));
  migrateSessionEntries(fileEntries);
  const header = fileEntries.find((e): e is SessionHeader => e.type === "session");
  if (!header) throw new Error(`not a session file (no header): ${path}`);
  return { header, entries: fileEntries.filter((e): e is SessionEntry => e.type !== "session") };
}

export function refOf(header: SessionHeader, path: string): SessionRef {
  return { sessionId: header.id, path, parentPath: header.parentSession ?? null, cwd: header.cwd };
}

export function listSessionFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}
