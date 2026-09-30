// Runtime settings. Environment variables only (prototype); invalid values fail loudly at load.

export const DB_FILE = "lossless-context.db";
export const LOG_FILE = "lossless-context.log";

export interface Config {
  /** Resume backfill time budget; exceeding it stops the backfill and warns. */
  backfillBudgetMs: number;
  /** Entries per write transaction (live capture, backfill, reindex). */
  batchSize: number;
  /** Source tokens per D0 leaf. */
  leafChunkTokens: number;
  /** Same-depth frontier nodes that trigger one condensation into depth + 1. */
  fanin: number;
  /** Deepest node level condensation may create. */
  maxDepth: number;
  /** Parallel summary calls within one compaction or one background batch. */
  summaryConcurrency: number;
  /** Background pre-summarization starts once context usage reaches this fraction of the window (0 < x ≤ 1). */
  presummarizeAt: number;
  /** Per summary call timeout. */
  summaryTimeoutMs: number;
  /** "provider/modelId"; unset = the session's current model. */
  summaryModel: string | undefined;
  /** Reasoning level for summary calls; unset = the session's thinking level. "off" sends none. */
  summaryThinking: ThinkingLevel | "off" | undefined;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const LEVELS: readonly (ThinkingLevel | "off")[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function thinking(name: string): ThinkingLevel | "off" | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const level = LEVELS.find((l) => l === raw);
  if (!level) throw new Error(`${name} must be one of ${LEVELS.join(", ")}, got ${JSON.stringify(raw)}`);
  return level;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function fraction(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!(n > 0 && n <= 1)) throw new Error(`${name} must be a number in (0, 1], got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(): Config {
  return {
    backfillBudgetMs: positiveInt("LOSSLESS_BACKFILL_BUDGET_MS", 30_000),
    batchSize: positiveInt("LOSSLESS_BATCH_SIZE", 500),
    leafChunkTokens: positiveInt("LOSSLESS_LEAF_TOKENS", 20_000),
    fanin: positiveInt("LOSSLESS_FANIN", 4),
    maxDepth: positiveInt("LOSSLESS_MAX_DEPTH", 3),
    summaryConcurrency: positiveInt("LOSSLESS_SUMMARY_CONCURRENCY", 4),
    presummarizeAt: fraction("LOSSLESS_PRESUMMARIZE_AT", 0.5),
    summaryTimeoutMs: positiveInt("LOSSLESS_SUMMARY_TIMEOUT_MS", 180_000),
    summaryModel: process.env.LOSSLESS_SUMMARY_MODEL || undefined,
    summaryThinking: thinking("LOSSLESS_SUMMARY_THINKING"),
  };
}
