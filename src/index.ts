// pi-lossless-context (PROTOTYPE): Pi extension entry. Wiring only; behaviour lives in three sides:
// - capture.ts (index): turn_end / agent_end / session_compact / session_shutdown index new SDK entries;
//   session_start backfills what the cursor missed, in the background, within a time budget.
// - compaction.ts (compaction): session_before_compact builds the summary DAG (dag.ts). From
//   `LOSSLESS_PRESUMMARIZE_AT` context usage on, leaves and condensations are built in the background after each turn
//   and parked in custom entries, so the compaction itself only summarizes what is left.
// - tools.ts (answer): lcm_grep (scope session | all), lcm_expand, /lossless status | reindex [--all].
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCapture } from "./capture.ts";
import { createCompactor } from "./compaction.ts";
import { DB_FILE, LOG_FILE, loadConfig } from "./config.ts";
import { fileLogger } from "./log.ts";
import { registerTools } from "./tools.ts";

export default function losslessContext(pi: ExtensionAPI) {
  const config = loadConfig();
  const agentDir = getAgentDir();
  const log = fileLogger(join(agentDir, LOG_FILE));
  const index = createCapture(config, log, process.env.LOSSLESS_DB || join(agentDir, DB_FILE));
  const compactor = createCompactor(pi, config, log, agentDir);

  pi.on("session_start", (event, ctx) => {
    index.start(ctx, event.reason);
    compactor.start(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    index.capture(ctx, "turn_end");
    compactor.kick(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    index.capture(ctx, "agent_end");
    compactor.kick(ctx);
  });
  pi.on("session_compact", (_event, ctx) => index.capture(ctx, "session_compact"));
  pi.on("session_shutdown", (_event, ctx) => {
    index.capture(ctx, "session_shutdown");
    compactor.stop();
    index.stop();
  });
  pi.on("session_before_compact", (event, ctx) => compactor.beforeCompact(event, ctx));

  registerTools(pi, config, log, agentDir, index, compactor);
}
