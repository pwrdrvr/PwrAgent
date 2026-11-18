# Desktop Persistence Rules

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Thread History Persistence

Thread transcripts, rollout events, streamed message deltas, prompt text,
assistant text, and command output history must not be written into the desktop
sqlite database. Store only desktop metadata there. For the full rule and the
ACP fallback direction, read
[../../docs/thread-history-persistence.md](../../../docs/thread-history-persistence.md)
before changing ACP session storage, thread replay restoration, or rollout
persistence. Its one exception is tracked review findings (`thread_reviews`):
capped excerpts that only To-dos and the review agent tools read. The
transcript renders a review from its own entry and reads only status from that
table.

## SQLite Query Rules

- Never interpolate user-sourced values into SQL strings. Always use
  `better-sqlite3` prepared statements with positional or named bindings.
- Messaging-platform inbound text is the highest-risk SQLite input category:
  public Telegram, Discord, Mattermost, Slack, Signal, Feishu, and future
  adapter traffic must be treated as hostile even when the local desktop user
  trusts the bound thread.
- Generated SQL fragments are only allowed for non-data structure, such as a
  generated `?, ?, ?` placeholder list. Hardcoded maintenance table names must
  stay allowlisted by the SQL-template lint guard.
- Run `pnpm lint:sql` after changing desktop main-process SQLite code. It flags
  interpolated SQL template strings in the messaging/state persistence surface.
