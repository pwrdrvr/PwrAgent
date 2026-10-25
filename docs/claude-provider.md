# Claude provider implementation

Claude is a built-in desktop backend (`claude`). The main process calls the
declared `@anthropic-ai/claude-agent-sdk` dependency directly. There is no Claude
ACP transport, adapter installer, or application-managed CLI download.

## Provider attribution and branding

Settings describes the integration in plain text: PwrAgent runs Claude Code. The provider selector and thread chips use
`Claude`; thread metadata records `source: "claude"`, identifying the backend
that owns the session. This is provider attribution, not a product or feature
name derived from Claude Code.

The integration includes no Anthropic or Claude logos, branded ASCII art, or
imitations of their visual identity. PwrAgent retains its own name and branding
and makes no partnership or endorsement claim. Keep future changes within
these boundaries. Anthropic's [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)
allows factual plain-text descriptions that a product runs Claude Code;
its [SDK branding guidance](https://code.claude.com/docs/en/agent-sdk/overview#branding-guidelines)
separately describes provider attribution. Neither is a grant to add vendor
logos to PwrAgent.

## Process and authentication boundary

`claude-executable.ts` resolves the operator's installed official CLI from the
terminal environment and standard native installation directories. On Windows,
it accepts a native executable or the official npm package's JavaScript entry;
it never gives the SDK a `.cmd`, `.bat`, or `.ps1` launcher.

The SDK's pinned platform package provides an unmodified native Claude Code
binary as a fallback. Discovery probes both candidates with `--version` and
compares the CLI versions, not the npm SDK version. For example, SDK `0.3.296`
contains Claude Code `2.1.296`. A system binary at least as new as the bundle
wins, including on equal versions. A missing, older, or unprobeable system
binary falls back to the bundled binary after its version probe succeeds.
If the bundle is unavailable, the system installation remains usable.

Packaging unpacks the native executable outside ASAR and checks that it is
present. macOS universal packages preserve each architecture's original
binary separately. There is no runtime installer, extraction, or binary patch.
Settings shows the selected path, source, and CLI version.

Every query explicitly supplies `pathToClaudeCodeExecutable`. No usable binary
and known logged-out states fail before query creation. Settings reads only
`loggedIn` and a known authentication category from `claude auth status --json`; it retains neither account
identifiers nor credentials. Authentication remains an operator action through
Claude Code's own `auth login`. For a bundled runtime, Settings shows its fully
quoted executable path (PowerShell invocation on Windows), so signing in does
not require installing a separate system CLI. Binary selection happens before
authentication checking; a logged-out CLI never causes credential fallback. PwrAgent does not implement Claude OAuth, read credential
files, supply OAuth tokens or API keys, or call the Messages API.

The SDK starts the CLI with the `claude_code` system-prompt preset and appends
thread instructions when present. `settingSources` includes `user`, `project`,
and `local`, preserving the CLI's settings, CLAUDE.md, and skills. PwrAgent does
not pass `--bare`. CLI-managed configuration remains under the CLI's control.

The declared SDK version is `0.3.296`, published October 9, 2026, and satisfies
the repository's seven-day dependency maturity rule. The license gate has an
explicit package-name exception for the SDK and its eight platform packages
under Anthropic Commercial Terms. It does not add their non-SPDX license
declarations to the general license allowlist. First-party code remains MIT.

## Sessions and permissions

Startup and explicit Settings discovery read `Query.supportedModels()` from
the selected executable without submitting a prompt or persisting a session.
The picker uses the CLI's versioned names and aliases, with the latest model
in each family in the primary menu and older models under Other Models.
Per-model effort choices come from the same catalog; Default leaves effort
unset so the CLI's own setting applies. Explicit selections pass through to
`query()` as `model` and `effort`. A saved model absent from the current catalog
is passed to the CLI for validation instead of silently selecting another model.
The catalog stays in memory; reads and ordinary turns do not start discovery
queries. Discovery closes its query on success, failure, and timeout.

PwrAgent creates a stable UUID for a new thread and passes it as `sessionId`.
Once the SDK confirms initialization, the returned session ID is persisted and
subsequent turns use `resume`, including after an application restart.

SDK text deltas, assistant messages, tool calls, and tool results become normal
timeline notifications. Permission requests use the existing approval UI;
`AskUserQuestion` uses its questionnaire UI. Cancellation denies the pending
request and removes it from the registry. Only explicit approval authorizes
the tool; the bridge does not synthesize durable CLI permission rules.

| PwrAgent mode | SDK mode |
| --- | --- |
| Default | `default` |
| Auto | `auto` |
| Full Access | `bypassPermissions` |

The SDK may reject a mode that the installed CLI or selected model does not
support. PwrAgent reports that error and retains the previous mode.

The adapter records metadata and append-only replay entries beneath the
active profile's `state/claude/` directory. It does not inspect Claude-owned
history files or store transcripts in SQLite. Normal desktop overlays continue
to use the existing registry persistence paths. Checked-in SQLite budgets
measure three commits (49,440 WAL bytes) for thread creation and one commit
(16,480 WAL bytes) for an operator permission change. One hundred duplicate
mode selections add no commits. At 100 new threads and 100 permission changes
per day, the measured projection is `(400 / 86400) commits/s × 16480 bytes ×
86400 seconds`, or approximately 6.6 MB/day. This adds no timer-based writes.
Archive changes metadata and
retains the workspace. Native fork, workspace handoff, and transcript
pagination are not advertised.

Queue uses PwrAgent's shared FIFO and resumes the SDK session after the active
turn finishes. Steer sends an additional native user message through the same
open SDK input stream with `priority: "next"`. Claude adds it to the running
turn at the next tool boundary, or starts a native turn with it once the
current response ends. Do not use `"now"`: it aborts the in-flight response
and ends that native turn with an `error_during_execution` result.
PwrAgent keeps the turn open until result UUIDs acknowledge every accepted
steer, and treats those results as one logical desktop turn. Usage is recorded
once per desktop turn from the final cumulative result, less the totals when
the turn began. Stop ends the turn and drops its pending input; see below for
when it keeps the process. Request IDs deduplicate retries; attachment
parts and message origins survive replay. A steer with an agent origin writes
one SQLite commit (~12 KB, or ~1.24 MB/day at 100 steers/day); a duplicate
request adds no write, and there are no idle writes.

## Background tasks and sub-agents

Claude runs shell commands and sub-agents as tasks. `Agent` calls run in the
background by default, and `Bash` can too. A background call answers at once
with a placeholder, and Claude emits the turn's `result` while the task keeps
running. Closing the query kills the CLI process and every task with it, and
closing its stdin makes the CLI hold results and sweep background shells after
about five seconds. So the query is a per-thread live session that can outlive
the desktop turn, as a Codex background terminal outlives its turn.

A desktop turn ends at the `result` that acknowledges every steer, once Claude
is idle, whether or not a task still runs. PwrAgent sets
`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`; when the CLI reports
`session_state_changed`, the turn also waits for `idle`, which follows
Claude's own background-agent loop. The session stays open while a task runs.
The task set comes from `background_tasks_changed`, which the CLI documents as
authoritative, plus `task_*` edges for foreground tasks. A foreground task
also settles with its tool result or its native result, since it cannot
outlive either. Housekeeping tasks the CLI marks `ambient` are not shown and
do not keep the session open.

Claude answers a task notification with a native turn of its own
(`session_state_changed: running`, then `init`). With no desktop turn open,
PwrAgent opens one for it: `turn/started` with no user message, then the
follow-up's items, then `turn/completed`. A follow-up that produces no text
is not reported as a failed send. The session closes once no task runs,
Claude is idle, and the last task notification has had its follow-up. If a
task settles and Claude runs no follow-up within five seconds, the session
closes without one.

A message sent while the session is live goes into the same input stream with
`priority: "next"`, and its turn ends at the result that acknowledges it. A
changed model, effort, permission mode, or MCP server set is applied first
through `setModel`, `applyFlagSettings({ effortLevel })`, `setPermissionMode`,
and `setMcpServers`. New agent instructions change the system prompt, which
only a new process takes. A relaunch would stop the session's tasks, so while
a task runs the new instructions wait for the next launch; with none running,
the turn closes the session and resumes in a new query. A control the CLI
rejects relaunches the same way when no task runs, and otherwise fails the
message, leaving the session and its settings as they were. MCP grants the
registry issues for a turn are revoked when the session that uses them
closes, not when the turn ends.

Between turns the thread reads as idle in the thread list and Attention. The
quit prompt and auto-archive still count it as busy, as they count a Codex
thread with a background terminal, and archiving refuses until its tasks are
stopped. The tool row of a background call stays running until its
notification, then shows the task's summary in the turn that made the call.
A permission request or MCP elicitation from a task between turns belongs to
the latest turn. Running tasks are published as
`thread/backgroundTasks/updated` and listed in the Executions rail beside
Codex background terminals, with the sub-agent type and the latest
`task_progress` line. Stop on a row calls `Query.stopTask`.

Stop on a turn keeps the session's tasks when it can. While a task runs and
the CLI advertises `interrupt_cancel_queued_v1` at init, Stop sends
`interrupt` with `cancelQueued: true`, which ends Claude's native turn and
drops steers still queued for it. The desktop turn ends `cancelled` at the
interrupted result, or after five seconds if Claude sends none. When the
interrupt dropped a message Claude had not started and Claude is idle, no
result will come, so the turn ends at once. The process and its tasks stay
up either way. With no task running, or a CLI without that
capability, Stop closes the query, since a plain interrupt would leave queued
steers to run after the stop. Quitting stops turns by closing their queries,
and closes every session and its tasks. A relaunch hands the old session's
MCP grants to the new one, because the relaunching turn registered the same
per-thread grants again.

## Usage, context, and MCP

The Pricing rail uses the SDK's per-model result totals, including cache
creation, cache reads, compaction, and native subagents. It subtracts the
previous session snapshot on resume and stores one turn estimate through the
existing usage ledger. The CLI's reported estimate is preserved on reads;
PwrAgent does not substitute a catalog rate or invent component prices.
These are provider estimates, not subscription charges or invoices. Costs
arrive with a result, including error results that contain usage. A process
that exits without a usage result cannot provide a complete cost observation.
For sessions created before usage accounting, a bounded control request reads
the baseline before the prompt is released. If that fails, the first result
seeds a baseline without misattributing old transcript costs to the new turn.

Context occupancy comes separately from `getContextUsage({ detail: "summary" })`
at initialization, completed assistant messages, and the result. Summary mode
avoids per-category token-count API calls. The latest occupancy is saved with
session metadata and restores the composer moon after reopening a thread.
It never enters the billed-token totals.

Claude limits use the optional SDK usage control response and streamed rate
limit events. The control response reports percentages; stream events report
fractions and epoch-second resets. Sparse events merge by window, including
validated `unifiedWindows` extensions from newer CLIs. A missing optional
probe does not erase a window reported on the same turn. The rail shows only
Claude limits for Claude threads, or explicitly says they are unavailable;
it never falls back to the Codex account. Probes are bounded and never read
credential files or call account endpoints outside the official CLI.

Selected managed MCP connections and the PwrAgent gateway are injected into
`query({ options: { mcpServers } })`. Changes apply on the next message. While
a turn runs, inventory comes from `Query.mcpServerStatus()`. An idle thread
reports that inventory is unavailable instead of querying Codex. The CLI's own
MCP configuration remains enabled. Auto is Claude's native `auto` mode on both
query creation and live permission changes; a callback that reaches PwrAgent
still requires explicit approval. Host gateway connection policies also apply.

The additional SQLite budget is one commit for a result usage observation and
ledger flush, independent of 100 context updates: measured 65,920 WAL bytes.
At 100 turns/day that is `100 / 86400 commits/s × 65920 bytes × 86400 seconds`,
approximately 6.6 MB/day. Context updates and idle telemetry add no SQLite writes.

## Verification

The provider and executable tests use injected SDK streams and temporary
filesystem fixtures. The registry integration test exercises creation, approval
reply, replay, resume, rename, mode changes, archive, and restore. Vitest must
never launch the operator's real CLI.

Implementation shape was checked against these independently maintained
providers; their code is not incorporated:

- [Paseo query wrapper](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/claude/query.ts)
- [Paseo agent](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/claude/agent.ts)
- [bb SDK session](https://github.com/get-bb/bb/blob/main/plugins/provider-claude-code/src/bridge/sdk-session.ts)
- [T3 executable resolution](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/ClaudeExecutable.ts)
- [Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview)

The integration makes no subscription pricing or quota guarantees. Those remain
provider policy and can change independently of this process boundary.
