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

Claude Code's own tools get the rows other providers get. Read, Glob, Grep,
WebSearch, and WebFetch rows name the file, pattern, query, or URL. A
successful Edit, Write, or NotebookEdit row carries its unified diff, built
from the tool result's structured patch; a new file with an empty patch diffs
its content. Each edit also extends the turn's `turn/diff/updated`, which
feeds the live Edited Files row and work rail. Diffs over 256 KB keep their
line counts only. A TodoWrite call is the turn's plan: it emits
`turn/plan/updated` and replaces one plan entry per turn instead of adding a
tool row. Other tools keep a generic row with their input.

Compaction is its own row with Claude's token counts and emits
`thread/compacted`, the boundary Token Miser replay accounting uses.
`/compact` itself runs in the CLI as a prompt. A model refusal is kept as a
warning row. Compacting status, API retries, permission denials, and
non-low-priority CLI notifications are activity-only warnings in the live
transcript. Thinking blocks are not shown, matching the Codex transcript.

| PwrAgent mode | SDK mode |
| --- | --- |
| Default | `default` |
| Auto | `auto` |
| Full Access | `bypassPermissions` |

The SDK may reject a mode that the installed CLI or selected model does not
support. PwrAgent reports that error and retains the previous mode.

PwrAgent's own approval cards for MCP gateway calls and forge tools read the
mode from the thread's open Claude process. Full Access skips a gateway card
and runs `auto` forge groups without one, as it does for Codex. A forge group
set to `ask` still asks. See [MCP gateway tools](mcp-gateway-tools.md) and
[forge agent tools](forge-agent-tools.md).

A gateway call has one prompt, the gateway's own, and so does a forge tool.
When PwrAgent's own MCP server is attached, the query's `allowedTools` lists
`mcp__pwragent__call_mcp_tool` and every forge tool (`CLAUDE_FORGE_TOOLS`:
the CI reads, the pull request and issue reads, and every write, merging
included), so Default and Auto do not reach `canUseTool` for them. Without
the rules, Claude showed a generic card that named only the tool. Accepting
it led to the gateway card for the same call, or to the forge card for an
`ask` write, and an `allow` forge group still asked. The gateway card names
the upstream tool and follows the connection's Tool approval setting,
conversation approvals and automation allowlists. The forge card follows
`[git.agent_tools]`, its project rules and the turn's mode. Outside plan
turns, `approve_merge` asks unless the turn has Full Access. Claude still
applies the operator's own `ask` and `deny` rules for these tools, and its
`plan` mode still asks for a forge write and for any gateway call; a plan
turn normally decides both without Claude's card (below). Explicit gateway
`ask` rules still show Claude's card. The rules are fixed when
the process starts and do not depend on the forge levels, so a Settings
change never relaunches Claude.
A live session that lacks them relaunches for them, or keeps asking until
its next launch while a task runs. Other PwrAgent tools still ask through
`canUseTool`.

The composer's **Plan** toggle runs one turn in Claude's `plan` permission
mode, which keeps Claude read-only while it investigates; the next turn
returns to the thread's mode. Claude ends a plan by calling `ExitPlanMode`
with the plan as its input. PwrAgent shows that plan as the turn's plan card,
as it shows a Codex plan, and declines the call without an approval card, so
the turn ends with the plan in front of the operator, who replies to
implement it.

A plan turn does not write to GitHub or GitLab. Claude's `plan` mode still
calls `canUseTool` for a forge write, although `allowedTools` lists it.
Accepting Claude's card then led to the forge card for the same call. In a
plan turn PwrAgent declines every forge write in `canUseTool`, with no card,
and tells Claude to put the step in its plan. The shared forge gate also
refuses writes whenever the live process's permission mode is `plan`, before
considering `allow`, `auto`, `ask`, project rules, or conversation grants.
This protects the forge even if a CLI version skips `canUseTool` for an
allowed tool. Codex plan turns follow the same rule using their active
collaboration mode. The forge reads are read-only tools, so plan mode runs
them without asking, and the forge policy decides them as in any other turn.

A Claude plan turn does not change anything through an MCP connection
either. Plan mode asks for every `call_mcp_tool` call because the wrapper is
not read-only. The permission handler passes it to the gateway without a
card only when the SDK identifies PwrAgent's host-registered server
(`mcpServer.source` is `sdk` and its name is `pwragent`) and no explicit
`ask` rule matched. Rule-forced asks, configured servers with the same name,
and calls without server-origin metadata keep the ordinary approval card.
Only the gateway knows which upstream tool the call names.
An upstream tool marked read-only and not destructive follows the
connection's Tool approval setting, as in any other turn. Every other tool
is refused before Full Access, automation grants, or conversation approvals,
with no card, and Claude is told to put the step in its plan. The gateway
reads the open process's permission mode through `livePermissionMode`. See
[MCP gateway tools](mcp-gateway-tools.md).

A thread's linked directories other than its working directory, including
directories attached later with `attach_thread_directory`, are passed as
`additionalDirectories`, so Claude can read and edit them without a
per-file permission prompt. The set is fixed when the CLI starts: a change
relaunches an idle session at the next message, and waits for the next
relaunch while background tasks run.

The adapter records metadata and append-only replay entries beneath the
active profile's `state/claude/` directory. It does not inspect Claude-owned
history files or store transcripts in SQLite; rewind reads Claude's
conversation only through the SDK's session API. Normal desktop overlays continue
to use the existing registry persistence paths. Checked-in SQLite budgets
measure three commits (49,440 WAL bytes) for thread creation and one commit
(16,480 WAL bytes) for an operator permission change. One hundred duplicate
mode selections add no commits. At 100 new threads and 100 permission changes
per day, the measured projection is `(400 / 86400) commits/s × 16480 bytes ×
86400 seconds`, or approximately 6.6 MB/day. This adds no timer-based writes.
Archive changes metadata and
retains the workspace. Workspace handoff and transcript pagination are not
advertised.

**Fork** goes through the registry's shared fork path, which prepares the
workspace (same directory, new worktree, or scratch), sets the parent, and
records the fork origin. The new thread copies the source's history and
records the source's SDK session. Its first message resumes that session with
`forkSession: true` from the fork's own working directory. The CLI resumes a
session started in another directory and gives the fork a new session, which
the thread adopts at `init`. Before that prompt, the fork reads its starting
usage totals, as an older session without a baseline does, so the copied
history is not billed as new work. A source with no conversation yet cannot
be forked.

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

## Rewind

A Claude thread can rewind to before any prompt that starts a turn: that
turn and every later one leave the conversation, and the prompt returns to
the composer. With Restore files, Claude also puts back the files its Edit,
Write, and NotebookEdit tools changed since. Shell commands' changes are not
restored. See [thread-rewind.md](thread-rewind.md) for the provider-neutral
contract and the confirmation.

- Every query sets `enableFileCheckpointing`, so the CLI checkpoints files at
  each prompt.
- Each prompt is sent with the desktop turn's id as its SDK `uuid`, including
  the first prompt of a session. The prompt's transcript entry is
  `user:<turnId>`, so the turn-to-prompt mapping needs no extra storage.
  Prompts sent before this have provider-assigned UUIDs, and Claude compaction
  can drop a prompt from the conversation it resumes. Neither can be rewound;
  the confirmation says so.
- The adapter finds the prompt with the SDK's `getSessionMessages`, the same
  session API it uses for titles; it does not read Claude's files itself. The
  entry just before the prompt is the point the next query resumes at
  (`resume` with `resumeSessionAt`). Claude writes the next turn as a new
  branch of the same session file, so prompt UUIDs and file checkpoints stay
  valid for later rewinds. `forkSession` was not used: it gives every
  forked entry a new UUID, which would orphan both.
- Rewinding the first prompt leaves nothing to resume at. The next turn starts
  a new SDK session with its own id; the thread id already named the first.
- Files restore through a control-only query: `resume` the thread's session
  with checkpointing, send no prompt, call `Query.rewindFiles`, and close.
  The confirmation's file count comes from the same call with `dryRun`.
  Files go first, so a refused restore leaves the conversation as it was.
  A turn waits for a control query to close, so two CLI processes never
  resume one session. The confirmation holds its button for the dry run, so
  a dry run Claude does not answer in 30 seconds reports the files as
  unavailable rather than holding it forever.
- The rewind is refused while a turn starts or runs, or while a background
  task runs. An idle session kept open for a task's follow-up is closed once
  the prompt is confirmed rewindable, never for a rewind that is refused.
  A message sent during the rewind waits in the queue, which drains after it.
- The session metadata records each rewind: the turn it removed, the SDK
  session, and the removed branch's last entry, which is where an undo
  resumes. The append-only history gains a truncation line that drops the
  removed entries on every read, so the rewind survives a restart.

### Undo

Claude keeps the removed turns as a branch of its session, so the latest
rewind can be undone until the next turn starts (`ClaudeBackend.undoRewind`).

- The record keeps what the rewind left the session at (`after`) and what it
  cleared (`before`: the earlier resume point, usage totals, and context
  occupancy). Undo is refused once the session no longer matches `after`,
  which the next turn's `init` changes, or once an entry follows the
  truncation line in the history.
- Undo points the next query back at the removed branch's last entry
  (`resumeSessionAt`), restores what the rewind cleared, and appends a
  `pwragent_truncation_undo` line, so reads keep the removed entries again.
- `rewindFiles` restores checkpoints but cannot go forward again. Before a
  file rewind, the adapter asks Claude for a dry run and copies the files it
  names into `state/claude/rewind-backups/<thread>/<rewind>/`, PwrAgent's own
  storage, up to 50 MB. After the restore it records a hash of each file.
  Undo writes the copies back, and deletes the files the rewind brought back
  that did not exist before. It refuses, changing nothing, when a file
  changed after the rewind. A file rewind whose copies could not be kept
  cannot be undone.
- A turn's first `init` removes the thread's backups: no rewind before it can
  be undone any more.

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

Between turns the thread's status stays idle, so the composer sends instead of
queueing. Its row still shows the working scanner and the thread stays in
Attention, because a finished task wakes Claude for a follow-up turn. A Codex
background terminal never wakes the agent, so a Codex row shows a quiet `>_`
mark instead and its turn ends normally. The registry publishes a Codex
thread's terminals as `thread/backgroundTasks/updated` when their membership
changes, since Codex announces none. The quit prompt and Thread Maintenance count
both kinds as busy, and archiving refuses until the tasks are stopped. The tool row of a background call stays running until its
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

## Scheduled wake-ups

Claude Code can start a turn on its own later: `ScheduleWakeup` sets the next
tick of a dynamic `/loop`, and `CronCreate` schedules a prompt once or on a
cron schedule. Unless the CLI saves a `CronCreate` job as durable, both live
in the CLI process's memory and end with it. The SDK has no control request that
lists or cancels them; only the model's `CronDelete`, or `ScheduleWakeup` with
`stop: true`, cancels one.

PwrAgent tracks them in `claude-session-wakes.ts` from two hooks. A
`PostToolUse` hook on the three tools records each new wake, its fire time and
its reason, and each delete. The `Stop` hook's `session_crons` is the CLI's
whole set at each turn's end, and replaces what the hooks recorded. A wake keeps
the session open the way a running task does, so a `/loop` keeps running after
its turn ends. When a wake fires, Claude starts a native turn, which PwrAgent
shows as it shows a task follow-up. A relaunch for new settings waits while a
wake is pending, and Stop on a turn interrupts it instead of closing the query.

A one-shot wake more than an hour past its fire time stops holding the
session. A one-shot's time comes from its tool result, or else from its pinned
cron fields. A recurring job, or a one-shot with no readable time, stops seven
days after PwrAgent first saw it (the CLI's default expiry for recurring jobs).
That bounds a missed `Stop` hook. Archiving waits while a fired wake's turn
runs, as it does for any turn.

The set is published as `thread/sessionWakes/updated` and listed in Waiting
for under Scheduled. The row has no Stop and tells the operator to ask Claude to
cancel it. Quitting PwrAgent, archiving the thread, a rewind, or a folder move
ends the session and its wakes. Archiving is
allowed while only wakes keep the session.

### Durable cron jobs

PwrAgent does not list a durable `CronCreate` job. The findings below were
measured with the bundled CLI 2.1.310 in SDK mode on 2026-11-03.

- **The account can turn them off.** Durable jobs depend on a Claude Code
  feature flag. When it is off, `CronCreate` ignores `durable: true`, keeps the
  job in the session, and answers `durable: false`. PwrAgent lists that job
  like any session cron. The flag was off for the account that ran these
  tests.
- **The job is stored in the folder, not in a thread.** A durable job is
  saved in `.claude/scheduled_tasks.json` in the session's working folder.
  Each entry records the session that created it. Every Claude session in
  that folder reads the file, even when the flag is off.
- **The creator runs it first.** The creating session runs its own jobs while
  it is open. A resumed session keeps its session id, so a PwrAgent thread
  runs its own jobs again on its next turn.
- **Another session can run it.** While the creating session is not running,
  the session that holds `.claude/scheduled_tasks.lock` in that folder runs
  the job instead. That session can be another PwrAgent thread or a Claude
  Code terminal. In the test, a second session started first, took the lock,
  and ran the job every minute. When the creator started, the creator took
  over. When the creator stopped, the second session resumed.
- **Few PwrAgent turns are open to run it.** A durable job does not keep a
  process open. PwrAgent ends a thread's Claude process after its turn
  settles, so the job runs only if a Claude session in that folder is open
  and idle when it is due. A one-shot that was missed is offered at the start
  of a later session that can run it. Claude asks before it runs that job.

A Waiting for row in the creating thread would be wrong whenever another
session runs the job. A row in every thread in the folder would claim work
that most of those threads never do. Listing them would also make PwrAgent
depend on the format of a file that Claude Code owns and does not document.
Ask Claude to run `CronList` to see the durable jobs in a folder, or
`CronDelete` to remove one.

## Locked threads

A lock keeps every turn source from starting a turn, including the turns
Claude starts in its own process: its answer to a finished task, a `/loop`
wake-up, and a session cron's fire. PwrAgent's turn queue never sees those
turns, so the registry's lock check at turn admission cannot refuse them.
`claude-self-started-turns.ts` holds them with a `UserPromptSubmit` hook
instead. The hook runs before Claude starts any prompt. Its `source` field
names the author: `loop_wakeup`, `schedule_wakeup` (a cron), or `system` (a
task notification, among others). A prompt counts as Claude's own only when
no desktop turn is open, because a task notification can also fold into a
running turn. A CLI that omits `source` is judged by that rule alone, since
every desktop message opens its turn before its prompt is written. Its held
prompt leaves the tracked wakes only when it matches a wake's prompt.

When the thread is locked, the registry's `holdBackendSelfStartedTurn` keeps
the prompt in a held queue entry (`self-started:<threadId>`), and the hook
answers `decision: "block"`. The CLI then drops the prompt without running
the model. The `init`, banner and `result` it still emits open no desktop
turn. Unlocking releases the entry with the lock's other held entries, and
the prompt runs as a normal turn, resuming the session if its process has
ended. Every prompt held while locked rides that one entry, in order, so
they run as one turn, the way Claude batches what queues while it is busy.
A recurring cron that fires again while locked is kept once.

- The CLI drops a one-shot job as it fires, and a held fire is followed by
  no `Stop` hook, so the held wake leaves the tracked set. A recurring job
  stays listed and fires again later.
- The held entry lives in memory, like the lock's other held entries, so
  quitting PwrAgent ends it.
- The background task itself keeps running under a lock; only Claude's
  answer waits. Waiting for marks Claude's tasks and wakes with that.
- If holding fails, the hook lets the turn run, so a prompt is never lost.
- A paused project does not hold these turns. Its notice names what it
  holds: PR checks and monitor and Continue After results.

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
still requires explicit approval. Host gateway connection policies also apply,
and the gateway's `call_mcp_tool` and the forge tools are pre-allowed so
PwrAgent's own card is the only one.

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
