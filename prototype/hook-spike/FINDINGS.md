# Hook spike findings (PROTOTYPE, Pi SDK 0.85.1, 2026-09-29)

Run: `python3 drive.py manual|pass|threshold|resume-fork` (uses the repo's Pi SDK 0.85.1; isolated agent dir under `/tmp/pi-lcm-spike/`).

| Question | Result | Evidence |
|---|---|---|
| Manual `/compact` fires `session_before_compact` | yes, `reason=manual` | `manual` run |
| Threshold fires it | yes, `reason=threshold`, before the next turn | `threshold` run (reserve 364000 → 8k threshold) |
| Overflow fires it | same code path as threshold (`_runAutoCompaction("overflow", willRetry)`, agent-session.js:1665/1695/1757) | source; not triggered live — clp luna accepted 539,824 input tokens |
| Returning a `compaction` takes over | yes; entry `fromHook: true`, LLM sees our summary as `compactionSummary` | `manual` |
| Returning nothing falls back to native | yes; native structured summary, `fromHook: false` | `pass` |
| `details` persisted, readable after resume | yes, verbatim in the jsonl compaction entry; `session_start(reason=startup)` sees it on the branch | `resume-fork` |
| Fork / clone after a compaction | new session file copies the whole path incl. the compaction entry and all summarized source entries with the same ids | `resume-fork` (4/4 sourceIds present in both new files) |
| `context` hook | fires before every LLM call with the rebuilt list: `compactionSummary` first, then kept entries | all runs |

Notes for the real implementation:
- Source entry ids for a compaction = message entries between the previous compaction entry and `firstKeptEntryId` on `branchEntries`.
- `keepRecentTokens` too large → "Nothing to compact (session too small)"; not an error for LCM to handle.
- A summary that lacks a fact loses it: the spike summary made the model answer UNKNOWN; native kept BLUE-17.
