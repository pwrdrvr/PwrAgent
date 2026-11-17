# Automation Scheduling

PwrAgent automations are local tasks assigned to an existing thread. Scheduled
automations are intentionally not background daemons: schedules fire only while
the desktop app is running. A run does not execute on the assigned thread. It
executes on a separate headless thread, so an automation turn never enters the
assigned thread's FIFO queue of manual messages and messaging follow-ups.
Inbound-message automations use the same run path but are triggered by a
matched messaging event instead of a clock tick.

## Thread Assignment

Each automation belongs to one backend thread. The thread remains an ordinary
thread, so a user can open it, read the transcript, and ask what happened.
Manual interaction is allowed and does not share a queue with automation work:

- A manual message waits only for the assigned thread's own active turn and
  the entries already in that thread's FIFO. It does not wait for an
  automation run, whether that run is queued or running.
- An automation run does not wait for the assigned thread's active turn or
  queued messages. A run and a manual turn can execute at the same time.
- A run does not add its prompt or output to the assigned thread's
  conversation. Its result reaches the thread as described in
  [Execution Model](#execution-model) and [Output Actions](#output-actions).

`DesktopAutomationService` constructs the scheduler with
`HeadlessAutomationRunner` and no other runner
(`apps/desktop/src/main/automations/desktop-automation-service.ts`). That
runner calls `startAutomationHeadlessTurn`
(`apps/desktop/src/main/app-server/backend-registry.ts`), which starts a new
thread and then a turn on it without submitting to `ThreadTurnQueue`.
`ThreadQueueAutomationRunner`
(`apps/desktop/src/main/automations/automation-runner.ts`) does submit to the
thread FIFO, but only the scheduler tests construct it.

The thread context rail is the primary management surface. It shows the
thread's automations, enabled or paused state, next run, pending/coalesced
counts, run-now, pause/resume, edit/delete, and recent run history. The global
Automations view is a secondary overview reached from the sidebar; it does not
replace the Recents and Directories thread lenses.

Each automation attaches to one Agent thread for reporting, follow-up, and
capability inspection.

## Execution Model

- Scheduled runs execute headlessly from the automation definition, invocation
  metadata, and bounded prior-run context.
- The headless thread takes its execution mode, model settings and, on Codex,
  its working directory from the assigned thread unless the automation's
  execution profile sets them (`startAutomationHeadlessTurn`).
- Each automation has its own execution lane that runs one run at a time. The
  scheduler finds a busy lane with `findActiveRunForAutomation`
  (`packages/sqlite-storage/src/automation-store.ts`), which is keyed by
  automation, not by thread. A run that arrives while the lane is busy waits
  there and starts when the active run ends (`startNextPendingRun` in
  `apps/desktop/src/main/automations/automation-scheduler.ts`).
- Run artifacts and read-only transcripts remain separate from the Agent
  conversation transcript.
- Notable results appear as source-labeled cards and do not trigger automatic
  Agent turns.

## Trigger Model

Automations store explicit trigger definitions. The first trigger kind is the
structured schedule model, kept for backwards compatibility with existing
recurring automations:

- Interval: every N minutes or every N hours.
- Weekdays: Monday through Friday at a time of day.
- Weekly: one or more selected weekdays at a time of day.

The second trigger kind is `inbound_message`. It matches normalized
`MessagingInboundEvent` text/media events by provider, conversation, optional
sender identity, optional bot-sender flag, optional literal text filter, and
whether replies inside an existing platform thread are allowed. The matcher
captures bounded source metadata on the automation run: provider, conversation,
sender, source text, received timestamp, message id, and thread/root references
when the adapter supplies them.

The scheduler and inbound trigger matcher run in the desktop main process.
Renderer components only create, edit, and inspect trigger records through IPC.

## Local-Only Timing

When PwrAgent is closed, scheduled ticks do not fire and are not replayed on the
next launch. Startup moves an enabled automation to its next future occurrence
when the stored time is missing or already past. A stored time still ahead is
kept, so a launch that missed nothing writes nothing, and a second instance on
the profile does not move a live instance's schedule. This avoids surprising
launch-time work after the app has been closed overnight or over a weekend.

If the app stays open but the event loop wakes late, the scheduler evaluates the
missed windows up to the current time and applies the automation's backlog
policy.

## Backlog Policies

`coalesce` is the default. If one automation already has a pending or queued
scheduled run, later due windows merge into that run. The run history and prompt
metadata record the scheduled windows covered by the catch-up run. Example: an
automation scheduled every 5 minutes that takes 8 minutes can collapse the 10
and 15 minute windows into one catch-up run instead of creating overlapping
turns.

`drop_missed` records skipped scheduled windows when the automation's own
execution lane is busy. It does not enqueue stale work. The assigned thread's
active turn plays no part in this decision.

`Run now` creates a manual automation run. If the automation already has an
active run, the manual run waits in that automation's lane; otherwise it starts
a headless turn at once (`runNow` in `automation-scheduler.ts`). It does not
enter the assigned thread's FIFO, does not wait for that thread's active turn,
and does not change the recurring schedule's next automatic run.

## Run History

Automation runs are persisted in the profile SQLite state database and capped
per automation. History records whether a run was scheduled or manual, its
status, queue/start/completion timestamps, backend turn id when available,
errors, source messaging metadata for inbound runs, output-action results, and
the scheduled windows covered by coalesced runs.

Each run records the process that created it: runtime instance ID, process ID
and process start time, the identity of the profile runtime marker. At startup
PwrAgent changes only the pending, queued and running runs whose owner it has
proved dead, with the check Research runs use (`reconcileStartup` in
`packages/sqlite-storage/src/automation-store.ts`). A run with no recorded owner, or
an owner recorded without a start time, cannot prove a live owner and counts as
dead. A live owner's runs and every terminal run are left as they are.

A dead owner's run becomes `failed` with `failureReason: "interrupted"`, and
run history shows it as interrupted. It is a reason on `failed` rather than a
new status so that older builds still read the profile. The run then takes the
path of any failed run: its artifact is recorded, the automation's output
actions run, and `automation/run/updated` reaches the Agent thread, where the
failed-automation row appears above the composer, and the thread's bound
conversations. Nothing is resumed or replayed. All of a launch's runs change in
one transaction, and a launch that lost nothing writes nothing.

This includes runs that a trigger queued while a quit was pending:
`quiesceDispatch` holds them so that cancelling the quit can start them, and a
completed quit leaves them to be reported as interrupted at the next start.

## Output Actions

Every automation can declare one or more output actions. `agent_context` is the
default action: the completed run artifact is stored for the assigned Agent's
read-only automation inspection tools, so a user can ask the same Agent follow-up
questions in that thread.

Inbound-message automations may also declare a `source_message` action. The
desktop messaging controller renders a short automation result and delivers it
relative to the source event, usually as a source-thread reply. Providers that
support platform broadcast flags can also expose the reply in the parent channel
while preserving thread context. Action results are recorded on the run artifact
so the Agent can answer whether a reply was posted, skipped, or failed.

## Monitoring

- Channel-level monitoring is persisted separately from thread bindings.
- Each enabled monitor owns one idempotent timer and one managed status surface.
- Stopping a monitor disables its subscription without revoking the thread
  binding.

## Runtime Disable

Use `--disable-automations` or `PWRAGENT_DISABLE_AUTOMATIONS=1` to keep a
desktop instance from scheduling or manually running automations. The UI and
read-only history/inspection paths remain available so secondary dev instances
can inspect the same profile without also executing the profile's schedules.

## Agent Tool Access

Agent-attached automations publish timeline cards out of band. They are not
inserted into the next user message as fake context. Codex-backed Agent threads
receive the `pwragent` Dynamic Tools catalog so the Agent can inspect automation
runs alongside the app, thread, messaging, and orchestration operations.

ACP-backed Agent threads receive that same catalog from a PwrAgent-owned
Streamable HTTP MCP server when the ACP runtime advertises HTTP MCP support.
PwrAgent binds the server to an ephemeral `127.0.0.1` port, registers it with
the ACP session automatically, and authenticates each session with a
thread-scoped bearer credential. Tool calls remain authorized at execution
time and are rejected unless the registered thread has exactly one active turn.
ACP runtimes without HTTP MCP support keep starting without the PwrAgent MCP
instead of failing session creation.

Apart from the operator's own MCP connections attached to the thread,
PwrAgent offers an ACP session no other MCP server. Every PwrAgent tool an ACP
session sees comes from that HTTP server, which lists and refuses tools by the
member's federation containment. The older
`PWRAGENT_AUTOMATION_INSPECTION_MCP_COMMAND` stdio bridge was removed: it had
no implementation and no route to the owner.

Manual smoke test:

1. Create or open an Agent thread.
2. Attach an interval automation and let it complete a run.
3. Ask the Agent what happened with that automation.
4. Confirm the submitted user message remains unchanged and logs show
   `automation inspection request handled` rather than a synthetic
   `Automation Context` message.

## Future Personality Profiles

Personality profile selection is intentionally deferred. If future versions add
profile-backed instruction files such as `SOUL.md`, keep the total profile text
short. As a practical guidance point, keep custom instruction files to roughly
300 total lines or less so they remain useful in model context.
