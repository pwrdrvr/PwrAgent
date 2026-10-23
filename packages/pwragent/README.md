# PwrAgent Headless

Experimental Node-only daemon and CLI for a dedicated Linux outpost. The daemon
owns a local Codex App Server and keeps an accepted turn running after the CLI
or its SSH connection disconnects. There is no Electron, display server, npm
runtime dependency, laptop callback, or Sandboxer API dependency.

This is a runnable first slice, not a headless build of the complete desktop.
It supports one active turn per profile. It does not implement federation,
desktop Agent tools, messaging, automations, goals, worktree management, Token
Miser, live transcript streaming, provisioning, login, or thread migration.

## Run from a checkout

Use Node 22 or newer on Linux (macOS is also supported for development). Provide
an installed Codex executable, an existing workspace, and an existing dedicated
Codex home with authentication configured by the operator. No build or install
step is required for this package. The protocol adapter follows the repository's
Codex 0.159.2 contract; compatibility with other versions is not guaranteed.
Validation uses a fake App Server, not real inference or live accounts.

```sh
node packages/pwragent/bin/pwragent.js serve \
  --profile outpost \
  --workspace /srv/pwragent/workspace \
  --codex-home /var/lib/codex-outpost \
  --codex-bin /usr/local/bin/codex
```

`serve` stays in the foreground. To keep it alive while a laptop is off, an
outpost service manager must own it. A reviewed systemd template is in
[`examples/pwragent-headless.service`](examples/pwragent-headless.service).
The template is not installed or enabled by the CLI. Its account and absolute
paths are placeholders. `KillMode=control-group` is needed to reap tools that
start a new session or process group. Running `serve` in an SSH foreground shell
alone does not provide this lifetime guarantee.

Run subsequent commands on the outpost, as the same OS user and with the same
`PWRAGENT_HOME` and profile. Write the task text to a local file, then:

```sh
node packages/pwragent/bin/pwragent.js submit --profile outpost \
  --id task-001 --prompt-file /path/to/task.txt --sandbox workspace-write
node packages/pwragent/bin/pwragent.js status --profile outpost
node packages/pwragent/bin/pwragent.js show --profile outpost --id task-001
node packages/pwragent/bin/pwragent.js wait --profile outpost --id task-001
node packages/pwragent/bin/pwragent.js read --profile outpost --id task-001
```

All command results are JSON. `submit` returns **acceptance**, not completion.
`wait` polls metadata once per second and exits 0 only for `completed`, 2 for
every other terminal outcome, and 1 for a client/runtime error. Closing `wait`
does not cancel work. `list` returns the newest 100 jobs; `show --id` retrieves
older retained jobs. `interrupt --id` requests interruption of an active turn.
During initial dispatch it reports that the turn ID is not yet confirmed; retry
once `show` returns a turn ID.

To continue a conversation, submit a **new job ID** with `--thread THREAD_ID`
using the `threadId` returned by a prior job. The daemon only accepts thread IDs
already in its own registry. Continuation uses App Server `thread/resume`.
An explicit `--model MODEL` is optional; otherwise Codex selects its default
(or the resumed thread's model). Every submission defaults to `read-only`;
select `workspace-write` explicitly when edits are wanted.

## Execution and failure contract

- Each job ID is immutable. Retrying the same ID and input returns its existing
  record, even after reconnect/restart. Different input with that ID fails.
  A timeout or lost CLI response is a reason to inspect/retry the same ID, not
  create another job. There is no queue: a new ID while busy is rejected.
- Both thread and turn setup specify `approvalPolicy: never`. Full access is
  not offered. Turn sandbox policy disables tool network access; workspace-write
  grants the configured workspace and excludes ambient temporary directories.
  Codex/provider access and operator-configured MCP integrations still follow
  Codex configuration. This CLI is not a replacement for VM isolation.
- Unexpected command/file/permission approvals are denied. Questions and other
  server requests receive an unsupported-method error. The turn is interrupted
  and recorded as `blocked`, requiring an operator's explicit follow-up.
- Only a `turn/completed` notification or terminal turn response establishes
  success/failure/interruption. Early notifications are handled before the
  `turn/start` response. Unrelated thread/turn completions cannot finish a job.
- Provider loss, protocol timeout, or shutdown before a terminal outcome yields
  `unknown`. A restart never resubmits prompts. Inspect the protocol transcript
  and workspace before explicitly continuing an uncertain job with a new ID.
  A microVM memory restore may preserve a live process; a cold boot cannot
  promise that an in-flight model request or tool operation completed.
- SIGTERM/SIGINT stop admission, close CLI connections and terminate the owned
  Codex process group, escalating to SIGKILL after at most two seconds. A systemd cgroup
  provides the wider descendant-ownership boundary. This is cancellation, not
  checkpointing. App Server request timeouts are 30 seconds; turn duration has
  no automatic limit. There is no spend budget or VM auto-stop management.

## Local state and crash recovery

State lives at `$PWRAGENT_HOME/profiles/NAME/state/headless`; the root defaults
to `~/.pwragent`, and NAME defaults to `PWRAGENT_PROFILE` or `default`.
The dedicated directory is owned by the service user and mode 0700; files and
the Unix socket are private through umask 0077. There is no TCP listener or
remote authentication protocol. Same-user local processes are trusted. The
resolved workspace, Codex home and headless state must not overlap. Unix socket
paths must fit in 100 bytes; choose a shorter PwrAgent root if needed.

The registry is bound to one canonical workspace and Codex home. It stores job
IDs, input hashes, thread/turn IDs, settings, timestamps and terminal outcomes.
It does not persist prompts or duplicate provider transcripts. `read` obtains
history only through `thread/read`; no Codex-owned storage file is inspected.
Errors and transcripts may contain sensitive task content and are returned only
to the local client. Raw Codex stderr is drained but not copied to the journal.

An exclusive `owner.lock` prevents two daemons from owning this registry.
Normal shutdown removes it. Abrupt daemon death or a cold boot can leave
`owner.lock` and `rpc.sock` behind. Startup deliberately refuses to guess whether
an old writer is gone. For manual recovery, stop the service, inspect the PID
and Codex PID in `owner.lock`, and establish that the daemon and its process
group/cgroup have exited. Only then remove those two files from this profile's
headless directory and restart. Do not remove `identity.json` or `jobs/`, and do
not recover concurrently with another startup. PID reuse is a reason to inspect,
not to kill an unrelated process. Incomplete records become `unknown` at startup.

State is atomically replaced and fsynced only at lifecycle boundaries (normally
four small job writes per accepted turn), with no SQLite commits, heartbeat,
per-event writes, or transcript log. Metadata polling does not write. Records
are capped at 10,000; there is no automatic garbage collection. Prompt input is
capped at 256 KiB and protocol responses at 32 MiB; oversized history reads fail
explicitly. A corrupted registry fails startup rather than discarding history.

## Architecture and remote integration boundary

The desktop evaluator (`apps/desktop/eval/run-headless.mjs`) still starts
Electron under Xvfb. The desktop App Server client depends on desktop settings,
logging, secrets, Git enrichment and other host services; its federation bridge
exposes the broad desktop backend contract. Importing these into a nominal CLI
would retain those dependencies. This package therefore implements a small
App Server adapter and durable job owner. It imports no desktop modules.

The separation follows [Amp Orbs' remote-work lifetime](https://ampcode.com/docs/orbs),
without claiming its managed orchestration or cross-client experience.
[Codex App Server](https://learn.chatgpt.com/docs/app-server) supplies the local
thread/turn protocol. [Sandboxer long-running tasks](https://sandboxer.com/docs/long-running.md)
documents systemd and memory-preserving stop/resume; [Sandboxer SSH](https://sandboxer.com/docs/ssh.md)
documents authenticated outbound WebSocket transport and `sbx ssh --stdio`.
An operator can invoke this CLI on an already configured outpost over SSH.
Neither SSH nor a laptop-side forward owns the daemon's lifetime. These docs
were consulted on 2026-10-23; no machine was created, resumed or enrolled.

This is **not** the `remote_agent` federation role yet. Future work must extract
host-independent backend services, provide headless secret/identity storage,
and implement the existing encrypted and capability-checked federation contract
(see the repository federation architecture/connectivity references). A SaaS
login or authenticated attach transport can then replace current enrollment
without coupling it to Sandboxer provisioning. No laptop callback, Cloudflare
Access, Tailscale installation, or reverse tunnel is required by this slice.

## Development validation

```sh
pnpm --filter pwragent test
pnpm --filter pwragent pack:check
```

The tests spawn the actual daemon and CLI with a fake Codex executable in
checkout-local temporary directories. They cover disconnect survival,
idempotency, continuation, single-owner admission, early terminal events,
failures, denied interactive requests, shutdown and process-group cleanup.
The Ubuntu CI test lane also runs this suite. Live inference, Linux sandbox
enforcement, systemd behavior, microVM restore and federation are not proven by
the fixture suite. Windows is not supported.

## License

MIT. See the repository root [LICENSE](../../LICENSE).
