---
name: codex-rollout-forensics
description: Analyze Codex rollout/session JSONL files and PwrAgent/Codex profile data for expensive tool-output behavior, cached-token growth, context replay amplification, noisy commands, long-running command polling, and commands such as sbt/test/build/log output that polluted model context. Use when asked to inspect rollout files, classify input/tool-output tokens, explain high Codex/PwrAgent cost, find noisy command sources, or produce aggregate tool invocation accounting without rereading a whole transcript into context.
---

# Codex Rollout Forensics

## Core Rule

Do offline aggregation first. Do not dump raw rollout lines, large tool outputs, or full transcripts into the conversation. Report bounded summaries: commands, counts, chars, estimated tokens, warning/error density, turn ids, timestamps, exit codes, and polling patterns.

This skill is for human/operator forensics. Do not add product runtime code that depends on reading Codex-owned rollout/session files.

## Workflow

1. Identify the target:
   - If given a rollout path, analyze that file directly.
   - If given a PwrAgent thread id/profile, search profile-local Codex storage first:
     `~/.codex/profiles/<profile>/sessions` and `~/.codex/profiles/<profile>/archived_sessions`.
   - Also check default Codex storage when needed:
     `~/.codex/sessions` and `~/.codex/archived_sessions`.
   - If PwrAgent state is available, use PwrAgent-owned sqlite tables for pricing totals and thread metadata, then use rollout files only for offline attribution.

2. Run the bundled analyzer:

   ```bash
   node .agents/skills/codex-rollout-forensics/scripts/analyze_rollout_tool_output.mjs \
     --profile <profile-name> \
     --thread-id <thread-id> \
     --top 20
   ```

   For a known file:

   ```bash
   node .agents/skills/codex-rollout-forensics/scripts/analyze_rollout_tool_output.mjs \
     /path/to/rollout.jsonl \
     --top 20
   ```

   Use `--json` when further local aggregation is needed. Save large JSON results to `.local/rollout-forensics/` or another ignored disposable location and summarize them, instead of pasting them into chat.

3. Correlate with PwrAgent pricing rows when requested:

   ```bash
   sqlite3 ~/.pwragent/profiles/<profile>/state/state.db \
     "SELECT thread_id, usage_line_count, uncached_input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_cost_micros FROM thread_pricing_summaries WHERE thread_id='<thread-id>';"
   ```

   Use `thread_usage_lines` and `thread_usage_turns` for per-turn totals and observed context replay counts. Keep sqlite output narrow.

4. Classify the problem:
   - **Direct tool-output noise**: large command outputs, truncated outputs, repeated warnings/info/debug lines.
   - **Replay amplification**: output introduced early, followed by many token-count/model-request events.
   - **Lazy polling**: repeated `write_stdin` calls against the same session, especially near 30-second intervals or with large output chunks.
   - **Cold cache misses**: high uncached input from pricing tables or replay tallies.
   - **Sub-agent vs main-thread cost**: compare parent thread rows with child rows before recommending delegation.

5. Report in operator language:
   - Name the exact rollout(s) analyzed.
   - State whether the evidence supports the suspected noisy command family.
   - Include top command groups by output chars/tokens.
   - Include warning/error/debug line counts for noisy commands.
   - Include lazy polling candidates and the command/session when detected.
   - Include clear next-step guidance for the running thread or product fix.

## Interpretation Guidance

- Treat token estimates as approximate. The script uses char-based estimates for ranking. Prefer pricing tables for billed totals.
- `write_stdin` output often belongs to the command launched by an earlier long-running `exec_command`; the script attributes it to `<command> (poll)` when it can see the session id.
- A command can be cheap once but expensive after replay. Prioritize outputs that are both large and early.
- Truncation is not safety. A 40k-character truncated output can still be around 10k tokens and can replay many times.
- For `sbt`, Maven, Gradle, pytest, Jest, CI logs, Datadog logs/traces, and broad searches, assume full output is risky until measured.

## Steering Advice

When noisy long-running commands are found, recommend a steering message like:

```text
For build/test/log commands, do not stream full output into the main thread. Write full stdout/stderr to a log file, then return only the command, exit code, failing test names, key error blocks, and a bounded tail. For long-running commands, use a monitor/sub-agent and have it summarize the log instead of polling with write_stdin in the main thread.
```

If lazy polling is already active, offer to inject the message or ask the user before doing so when the thread is still running.

## Output Shape

Prefer a concise final summary:

- `Rollout`: path(s), session id, cwd/title when known.
- `Totals`: tool outputs, chars, estimated output tokens, token-count events.
- `Top sources`: command table with calls/chars/tokens/warnings/errors/info-debug/truncation.
- `Polling`: repeated `write_stdin` sessions and whether they look like lazy monitor mode.
- `Verdict`: likely root cause and whether sub-agents/product fixes are indicated.
