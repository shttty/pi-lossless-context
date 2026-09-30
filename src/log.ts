import { appendFileSync } from "node:fs";

export type Level = "info" | "warn" | "error";
export type Logger = (level: Level, message: string) => void;

/** Timestamped lines appended to `path`; if the file cannot be written the line goes to stderr instead. */
export function fileLogger(path: string): Logger {
  return (level, message) => {
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    try {
      appendFileSync(path, line);
    } catch (error) {
      process.stderr.write(`[lossless-context] log write failed (${String(error)}): ${line}`);
    }
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
