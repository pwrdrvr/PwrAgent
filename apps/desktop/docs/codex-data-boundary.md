# Codex Data Boundary

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Codex Data Boundary

Desktop code must not inspect Codex-owned storage directly. Do not open, parse,
query, or infer behavior from Codex session JSONL files, rollout files, or
Codex sqlite databases, even when the Codex App Server protocol returns a path
to one of those files. Use protocol fields from the Codex App Server instead.
PwrAgent-owned JSONL, sqlite, config, and replay fixture files remain OK when
the desktop app or test harness owns that data. CI runs
`pnpm lint:codex-storage` to catch common violations; do not bypass or rename
around that check. Fix the data flow by using protocol fields or changing the
protocol. The one PwrDrvr LLC-authorized exception is
`src/main/codex-app-server/invalid-response-message-id-recovery.ts`: it may
rewrite only the protocol-identified rollout for the exact Responses API
invalid message-ID-prefix recovery, after stopping the Codex writer, creating
a durable backup, and validating the session belongs to the requested thread.
