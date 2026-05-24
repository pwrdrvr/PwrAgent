# Automation Scheduling

PwrAgent automations are local recurring tasks assigned to an existing thread.
They are intentionally not background daemons: schedules fire only while the
desktop app is running, and every automation turn enters the same per-thread
FIFO queue as manual messages and messaging follow-ups.

## Thread Assignment

Each automation belongs to one backend thread. The thread remains an ordinary
thread, so a user can open it, read the transcript, and ask what happened.
Manual interaction is allowed, but it changes the same conversation context and
uses the same queue as scheduled work. If a manual message is sent while an
automation run is queued or running, it waits its turn instead of overlapping.

The thread context rail is the primary management surface. It shows the
thread's automations, enabled or paused state, next run, pending/coalesced
counts, run-now, pause/resume, edit/delete, and recent run history. The global
Automations view is a secondary overview reached from the sidebar; it does not
replace the Recents and Directories thread lenses.

## Schedule Model

V1 stores structured schedules rather than raw cron strings:

- Interval: every N minutes or every N hours.
- Weekdays: Monday through Friday at a time of day.
- Weekly: one or more selected weekdays at a time of day.

The scheduler runs in the desktop main process. Renderer components only create,
edit, and inspect schedule records through IPC.

## Local-Only Timing

When PwrAgent is closed, scheduled ticks do not fire and are not replayed on the
next launch. Startup computes the next future occurrence for enabled
automations. This avoids surprising launch-time work after the app has been
closed overnight or over a weekend.

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

`drop_missed` records skipped scheduled windows when the assigned thread cannot
start the run immediately. It does not enqueue stale work.

`Run now` creates a manual automation run and still enters the same thread FIFO.
It does not bypass an active turn and does not change the recurring schedule's
next automatic run.

## Run History

Automation runs are persisted in the profile SQLite state database and capped
per automation. History records whether a run was scheduled or manual, its
status, queue/start/completion timestamps, backend turn id when available,
errors, and the scheduled windows covered by coalesced runs.

On app restart, stale local pending, queued, or running automation records are
closed as cancelled because queued desktop-local work is not durable across
process lifetimes.

## Runtime Disable

Use `--disable-automations` or `PWRAGENT_DISABLE_AUTOMATIONS=1` to keep a
desktop instance from scheduling or manually running automations. The UI and
read-only history/inspection paths remain available so secondary dev instances
can inspect the same profile without also executing the profile's schedules.

## Agent Tool Access

Agent-attached automations publish timeline cards out of band. They are not
inserted into the next user message as fake context. Codex-backed Agent threads
receive read-only `pwragent_automations` dynamic tools so the Agent can list its
own attached automations, inspect recent runs, and fetch stored run artifacts
when a user asks what happened. PwrAgent authorizes the tool call at execution
time; ordinary work threads receive a forbidden response even if the Codex
thread was born with the dynamic tool catalog.

ACP-backed Agent threads use the same inspection operations through MCP/CLI
adapters when the runtime supports MCP server configuration. Unsupported ACP
runtimes keep starting with an empty MCP server list instead of failing session
creation. Set `PWRAGENT_AUTOMATION_INSPECTION_MCP_COMMAND` to the command that
serves the automation inspection MCP bridge for ACP runtimes that support MCP
server launch configuration.

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
