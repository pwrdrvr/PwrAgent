# Agent lifecycle tools

`manage_pwragent` controls the desktop owner serving the calling thread. It
has no Federation target parameter and never forwards a lifecycle request to a
thread's remote owner. Use instance discovery to identify the serving machine;
use the returned `stateToken` to bind a subsequent mutation to that process and
its update revision. A token from another process, a previous launch, or a
changed updater state is refused. Tokens are preconditions, not authorization.

| Action | Behavior |
| --- | --- |
| `status` | Reads the running version, uptime, known update state, optional Codex process diagnostics, and latest lifecycle operation. It makes no update-feed request. |
| `upgrade_check` | Checks the configured update channel and may download and stage the result automatically. It never installs or restarts. There is no separate agent download/stage action or fresh network check guaranteed to avoid downloading. |
| `restart` | Schedules a local restart, installing the captured downloaded version when ready. It refuses an in-progress check/download/stage and uses Quiet & Continue After Restart after the normal quit decision. |
| `stop` | Schedules ordinary local quit, retaining the quit dialog and platform install-on-quit policy. It does not create restart continuations. |

Use a mutation only for the user's requested operation. A request to inspect
updates does not authorize a restart, installation, force quit, settings change,
or interruption of running threads. Existing active-turn validation, messaging
RBAC and platform authorization remain in force. Desktop lifecycle services are
unavailable on headless owners; contained Outposts also exclude this tool from
their allowlist.

## Acknowledgement and operation state

Restart and stop initially return the additive `restart_scheduled` and
`stop_scheduled` results. They acknowledge a scheduled request with confirmation
still pending. The existing `restart_accepted` and `stop_accepted` names are
reserved for requests already handed to the shutdown mechanism. Neither proves
installation or relaunch completed. The additive `operation` field identifies
the request and reports `waiting_for_response`, `confirming`, `preparing`,
`handed_off`, `cancelled`, or `failed`. Read `status` for an outstanding request;
after relaunch, verify the new runtime identity and running version instead.
Operation history is process-local and adds no persistent writes.

The Codex stdio writer and MCP HTTP response must flush the acknowledgement
before a lifecycle effect starts. Write failure, disconnection or an
acknowledgement deadline cancels the scheduled effect. A transport without that
capability refuses restart/stop. A flush proves transport delivery, not that the
model has finished composing a final user-facing response.

Repeated same-action requests report the existing operation. A competing
restart/stop is refused. The updater reserves its single installer before
opening confirmation, blocks replacement checks, and validates the captured
payload/channel before authorization. Ordinary agent restarts and stops also
reserve the updater so a background download cannot change what quit applies.
Cancellation or refusal releases the reservation. Once handed to shutdown, an
operation remains reserved; a second native install/relaunch is not issued.

## Quiet means checkpoint and continue

Quiet retains the existing quit-confirmation policy, including cancellation,
the operator's explicit Quit Now override, and Linux package authorization. It is a bounded restart protocol:

1. Close the restart dispatch/admission gate before taking the running-turn
   snapshot. New submissions, grouped messages and steers are refused explicitly;
   the sender must retry after relaunch. Work already accepted stays accounted for.
2. Save the running-thread continuations and accepted queued messages in the
   existing atomic checkpoint. Failure of this initial checkpoint cancels quit
   before any steer or process termination and restores the prior gate.
3. Steer supported running turns about the restart. Terminate environment actions
   with a three-second SIGTERM grace, followed by the existing forced cleanup.
4. Give turns fifteen seconds to settle, save the final continuation snapshot,
   then let the ordinary shutdown path interrupt remaining work and own process
   cleanup. Quiet does not wait indefinitely for every tool or child process.
5. On the next launch, the existing recovery service claims continuations from
   exited owners, restores queue order and paused/held work, and staggers dispatch
   while holding other automatic work. Live sibling owners' rows are not claimed.

Subagents resume through their parent and headless automation runs retain their
own lifecycle. Quiet is not a snapshot of arbitrary operating-system processes,
terminal sessions or external services. OS shutdown and the user's explicit Quit
Now path retain their existing behavior.

The existing `restart-continuation-cycle` fixture measures four SQLite commits,
about 29 KB WAL, for save/claim/two removals; ten such restart cycles per day cost
about 0.3 MB/day. No periodic, per-event or per-turn persistence is added here.
