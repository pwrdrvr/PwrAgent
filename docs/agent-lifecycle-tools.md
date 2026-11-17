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
| `upgrade_check` | Checks the configured update channel and may download and stage the result automatically. It never installs or restarts. It may return available while its download continues; read status until ready. It is not a read-only network check. |
| `download` | Starts or joins a download of the exact `expectedVersion` from the updater’s checked offer. It retains package/signature verification and cannot fetch an arbitrary version or URL. Read status until the exact version is downloaded and staged. |
| `cancel` | With `operationId`, cancels that scheduled lifecycle request before preparation. Otherwise, requires the download’s `expectedVersion` and requests cancellation. Settlement is asynchronous; read status before retrying. |
| `restart` | Schedules a local restart. `expectedVersion` refuses any different target. It installs a ready update or relaunches the current version, refuses a pending check/download/stage, and uses Quiet & Continue After Restart. |
| `stop` | Schedules ordinary local quit, retaining platform install-on-quit policy. It does not create restart continuations. |

Use a mutation only for the user's requested operation. A request to inspect
updates does not authorize a restart, installation, force quit, settings change,
or interruption of running threads. All actions, including status, require both
a persisted Agent designation and
current canonical messaging authorization for `tools.instance_management` and
`tools.instance_lifecycle`. Admin is the only built-in role granting the latter;
custom roles require an explicit dangerous-permission grant. A role named owner
has no implicit authority. Power User, Power User + Tools, Chat User and Limited
Chat User cannot manage the app by default. Ordinary coding threads, missing or
ambiguous actors, non-enforcing legacy RBAC, revoked provider access, downgraded
roles and contained members are denied. Actor and role are never tool arguments.
Discovery and execution both enforce this policy across provider backends, using
the retained causal actor and its messaging owner, including remote verification.
The serving owner alone runs lifecycle effects.

An authenticated chat request supplies the operation decision; it never opens
a desktop quit confirmation. Agent designation and actor authority are checked
again after response acknowledgement and after quieting. Native package
authorization still applies on Linux; this change does not bypass OS privileges. Desktop lifecycle services are
unavailable on headless owners; contained Outposts also exclude this tool from
their allowlist.

## Acknowledgement and operation state

Restart and stop initially return the additive `restart_scheduled` and
`stop_scheduled` results. They acknowledge a request whose transport flush and authorization
rechecks are still pending. The existing `restart_accepted` and `stop_accepted` names are
reserved for requests already handed to the shutdown mechanism. Neither proves
installation or relaunch completed. The additive `operation` field identifies
the request and reports `waiting_for_response`, `confirming`, `preparing`,
`handed_off`, `cancelled`, or `failed`. Read `status` for an outstanding request;
after relaunch, verify the new runtime identity and running version instead.
Operation history is process-local. Restart also checkpoints a verification
request into the calling thread’s existing durable queue, with its retained
causal actor. After recovery it asks the Agent to reauthorize status, compare the
running version and new runtime ID, and report the result. It does not grant
authority to a revoked actor or prove that the restart succeeded. Delivery uses
the existing provider readiness, queue holds and continuation recovery rules;
a stopped host or unavailable provider cannot deliver a confirmation.

The Codex stdio writer and MCP HTTP response must flush the acknowledgement
before a lifecycle effect starts. Write failure, disconnection or an
acknowledgement deadline cancels the scheduled effect. A transport without that
capability refuses restart/stop. A flush proves transport delivery, not that the
model has finished composing a final user-facing response.

Repeated same-action requests report the existing operation. A competing
restart/stop is refused. The updater reserves its single installer before
preparation, blocks replacement checks and downloads, and validates the captured
payload/channel before authorization and after quieting. Concurrent checks
reuse an active download’s known offer instead of replacing its SDK state.
Ordinary agent restarts and stops also
reserve the updater so a background download cannot change what quit applies.
Cancellation or refusal releases the reservation. If authority or readiness
changes after quieting, checkpointed work resumes and a cancellation receipt
replaces any promise of successful installation. Once handed to shutdown, an
operation remains reserved; a second native install/relaunch is not issued.

## Quiet means checkpoint and continue

Desktop-initiated quit retains its confirmation policy and Quit Now override.
Authorized chat restart uses quiet without a desktop decision. Linux package
authorization remains required. Quiet is a bounded restart protocol:

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
about 0.3 MB/day. The new `agent-upgrade-verification-cycle` budget covers the same cycle plus
one queued verification receipt: five commits, about 37 KB WAL (~0.4 MB/day at
ten restarts/day). Cancellation after quieting costs four commits, about 29 KB
(~0.3 MB/day at ten cancellations/day). No periodic, per-event or per-turn
persistence is added here. Canonical authorization reads add no writes; a denied
lifecycle grant retains the existing single activity-audit commit (about 21 KB,
~2.1 MB/day at 100 denials/day).

## Chat upgrade sequence

For an explicit user request to upgrade this owner to 1.4.8:

1. Read `manage_pwragent({ action: "status" })` and confirm the serving machine.
2. Call `upgrade_check`. An available result can precede automatic download.
3. If needed, call `download` with `expectedVersion: "1.4.8"`. Retries join the
   same download; a different offer, active check, changing track or shutdown
   reservation refuses the request. A cancelled download must settle before retry.
4. Read status until `downloaded` names exactly 1.4.8. Error, cancellation, a
   version mismatch or no-update result is not permission to restart another version.
5. Call `restart` with `expectedVersion: "1.4.8"` and the latest `stateToken`.
   Report scheduled status honestly. To cancel before preparation, pass its
   `operationId` to `cancel`; once preparing/handed_off, cancellation is refused.
6. After recovery, the verification continuation calls status with fresh
   authorization and compares both `runtimeId` and `currentVersion`.

PR #3796 shipped in 1.4.8, after 1.4.7. It added quiet defaults, acknowledgement
flushing, updater reservations and admission/shutdown coordination. It did not
add these explicit download/cancel actions, the Agent-plus-lifecycle grant,
chat confirmation bypass or durable version-verification request. Old installed
versions cannot acquire the new API until upgraded. Their automatic check/download
path can still work: the M2 incident proceeded from available to downloading to
downloaded through status calls before restart. No production restart is needed
to validate the mocked workflow in this repository.
