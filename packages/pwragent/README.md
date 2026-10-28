# PwrAgent Headless

Experimental Node-only daemon and CLI for a dedicated Linux outpost. The daemon
owns a local Codex App Server and keeps an accepted turn running after the CLI
or its SSH connection disconnects. Federation uses the same encrypted transport,
signed enrollment and capability-checked routing as the desktop. There is no
Electron, display server, provider SDK, or Sandboxer API dependency. Remote
terminals use the pinned `node-pty` native dependency, loaded when a terminal
opens. The packaged CLI bundles its shared JavaScript services and their notices.

It supports one active Codex turn per profile, local job commands, and remote
desktop navigation, project creation/cloning, repository-aware thread intake,
remote terminals, thread creation, continuation, transcript reads, subscribed
streaming events, steering, interruption, naming and model/execution settings.
It can consume authorized messaging services from a provider-owning peer.
The daemon owns its execution lifetime; an SSH forward only provides access.

## Install and update

The first headless npm release is prepared as `0.1.0-alpha.1`; these commands
become available after an operator publishes it. The existing npm `0.0.0`
placeholder does not provide this implementation. Use the explicit prerelease
channel rather than a bare `npm install pwragent` while `latest` is still the
placeholder:

```sh
npm install --global pwragent@next
pwragent --help
# Update to the newest headless prerelease:
npm install --global pwragent@next
# Or choose a reproducible version:
npm install --global pwragent@0.1.0-alpha.1
```

Provide **Node >=22 and npm separately**, on Linux (macOS is also supported for
development). The npm package includes the JavaScript federation bundle and its
license notice; it does not need Electron, pnpm, a compiler or workspace packages
on the destination machine. It supports **Codex only**. Install the Codex CLI
separately and authenticate a dedicated Codex home as the eventual service user.
The adapter follows the Codex **0.159.2** App Server contract; compatibility with
other versions is not guaranteed. PwrAgent neither installs nor authenticates
Codex and does not bundle Node or provider credentials.

Start the installed CLI with the same `serve` options shown below, replacing
`node packages/pwragent/bin/pwragent.js` with `pwragent`. Upgrading package files
does not upgrade an already running process: finish or interrupt active work,
stop the daemon, install the selected version, and start it again. Do not remove
the PwrAgent root, Codex home or workspace during updates. There is no automatic
CLI updater or automatic systemd enablement.

## systemd installation example

On a Linux host with systemd, an administrator must first create the dedicated
unprivileged `pwragent` user/group and provision these non-overlapping directories:

| Directory | Owner / purpose |
| --- | --- |
| `/srv/pwragent/workspace` | `pwragent`, existing task workspace |
| `/var/lib/pwragent` | `pwragent`, private PwrAgent root |
| `/var/lib/codex-outpost` | `pwragent`, private Codex home authenticated separately |
| `/opt/pwragent` | root, npm installation prefix |

Keep both state homes private (0700). Verify the service user can execute Node
>=22 at `/usr/bin/node` and its separately installed Codex at
`/usr/local/bin/codex`; edit the template if either absolute path differs. A
shell's Node version-manager initialization does not run under systemd.

After publication, install a pinned version into the service prefix:

```sh
sudo npm install --prefix /opt/pwragent --omit=dev --ignore-scripts pwragent@0.1.0-alpha.1
sudo install -m 0644 /opt/pwragent/node_modules/pwragent/examples/pwragent-headless.service /etc/systemd/system/pwragent-headless.service
# Review the account, paths, profile and Codex configuration before enabling:
sudo systemctl daemon-reload
sudo systemctl enable --now pwragent-headless.service
sudo systemctl status pwragent-headless.service
sudo journalctl -u pwragent-headless.service
```

The service runs as `pwragent`, with `PWRAGENT_HOME=/var/lib/pwragent` and
`PWRAGENT_PROFILE=outpost`. Local client commands must use that same account,
root and profile, for example:

```sh
sudo -u pwragent env PWRAGENT_HOME=/var/lib/pwragent PWRAGENT_PROFILE=outpost \
  /usr/bin/node /opt/pwragent/node_modules/pwragent/bin/pwragent.js status
```

For a service update, finish or interrupt active work, run
`sudo systemctl stop pwragent-headless.service`, repeat the prefix installation
with the chosen new version (or `pwragent@next`), then run
`sudo systemctl start pwragent-headless.service`. Compare the new example unit
with the installed one before deliberately updating it; npm does not overwrite
`/etc/systemd/system`. Stopping during a turn can leave its outcome `unknown`.

## Run from a checkout

Use Node 22 or newer on Linux (macOS is also supported for development). Provide
an installed Codex executable, an existing workspace, and an existing dedicated
Codex home with authentication configured by the operator. Install this checkout's
dependencies with `pnpm install`, then run `pnpm --filter pwragent build`. A packed
tarball already includes the bundle. The protocol adapter follows the repository's
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
  grants the thread's registered project directory and excludes ambient temporary directories.
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
the Unix socket are private through umask 0077. Federation is disabled until
explicit enrollment or invite creation. Its optional listener binds only to
127.0.0.1. Same-user local processes are trusted. The
resolved workspace, Codex home and headless state must not overlap. Unix socket
paths must fit in 100 bytes; choose a shorter PwrAgent root if needed.

The registry is bound to one canonical workspace root and Codex home. Projects
are registered canonical directories inside that root. It stores job
IDs, input hashes, thread/turn IDs, settings, timestamps and terminal outcomes.
It does not persist prompts or duplicate provider transcripts. `read` obtains
history only through `thread/read`; no Codex-owned storage file is inspected.
Errors and transcripts may contain sensitive task content; local clients and
authenticated peers with the corresponding capabilities can read them. Raw Codex stderr is drained but not copied to the journal.

An exclusive `owner.lock` prevents two daemons from owning this registry.
Normal shutdown removes it. Abrupt daemon death or a cold boot can leave
`owner.lock` and `rpc.sock` behind. Startup deliberately refuses to guess whether
an old writer is gone. For manual recovery, stop the service, inspect the PID
and Codex PID in `owner.lock`, and establish that the daemon and its process
group/cgroup have exited. Only then remove those two files from this profile's
headless directory and restart. Do not remove `identity.json` or `jobs/`, and do
not remove `threads.json` or `federation.json`, or recover concurrently with another startup. PID reuse is a reason to inspect,
not to kill an unrelated process. Incomplete records become `unknown` at startup.

State is atomically replaced and fsynced only at lifecycle boundaries (normally
four small job writes per accepted turn), with no SQLite commits, heartbeat,
per-event writes, or transcript log. Metadata polling does not write. Records
are capped at 10,000; there is no automatic garbage collection. Prompt input is
capped at 256 KiB and protocol responses at 32 MiB; oversized history reads fail
explicitly. A corrupted registry fails startup rather than discarding history.

## Federation enrollment and SSH forwarding

The near-term enrollment flow uses an existing desktop gateway invite. Copy the
encoded invite into a private file on the outpost, then import it with
`federation-join`. No SaaS login is required. A future login flow can mint the
same enrollment material without replacing the peer identity.

For an already provisioned Sandboxer test machine, the laptop can establish a
reverse forward to its desktop gateway. These are manual examples, not commands
run by PwrAgent. Replace the example ID and paths, and use the actual gateway
port. The official CLI on the development Mac is `/usr/local/bin/sbx`; another
program named `sbx` may be on PATH.

```sh
# Laptop: copy an unexpired desktop gateway invite, then keep the forward open.
/usr/local/bin/sbx scp ./outpost-invite.txt sb_EXAMPLE:/home/user/outpost-invite.txt
/usr/local/bin/sbx forward sb_EXAMPLE --reverse --local 47830 --remote 47830
```

```sh
# Outpost: the daemon is already running under its service manager.
chmod 600 /home/user/outpost-invite.txt
node packages/pwragent/bin/pwragent.js federation-join --profile outpost \
  --invite-file /home/user/outpost-invite.txt \
  --gateway ws://127.0.0.1:47830 --label "Research outpost"
node packages/pwragent/bin/pwragent.js federation-status --profile outpost
```

The endpoint override changes reachability only. The original invite's gateway
identity, Ed25519 public key and Noise key remain pinned. Plain `ws://` overrides
must be loopback; `wss://` is also accepted. SSH can alternatively carry the same
reverse forward using a `ProxyCommand` of `/usr/local/bin/sbx ssh %h --stdio`.
The laptop initiates the authenticated outbound HTTPS connection. The outpost
does not need to reach home through Cloudflare Access or Tailscale.

`federation-join` persists enrollment intent before dialing. It returns current
connection status; an unavailable forward appears as `unreachable`. Transient
failures retry with bounded backoff. Authentication failures stop retries and
remain visible in `federation-status`. Once joined, remove the copied invite
file. The daemon removes its pending token after successful authentication and
reconnects using its retained identity, including after a restart. A lost
acknowledgment is recovered by trying authenticated reconnect before reusing a
one-time invite.

An outpost can also accept a viewer directly: `federation-invite --port 47831`
starts a loopback listener and returns a 15-minute one-use encoded invite. A
laptop-side `/usr/local/bin/sbx forward sb_EXAMPLE --remote 47831 --local 47831`
then lets a separate desktop viewer profile import that invite. Issued invite
tokens are stored only as HMACs. The listener resumes on daemon restart.
`federation-revoke --peer ID` revokes an inbound peer and closes its connection;
`federation-leave` removes the upstream pairing while retaining the outpost's
identity, listener and jobs. Neither command deletes compute or thread data.

Federation grants only implemented capabilities. Unsupported operations return
errors rather than falling back to the viewer's machine. Read-only peers cannot
create or control turns. Event subscriptions select both class and thread; no
transcript is broadcast without demand. Navigation uses the current bounded
protocol-2 pages, and remote submissions carrying a stable `queueEntryId` reuse
the same durable job after a lost response. There is still no turn queue: a
second distinct submission while busy is rejected.

Directory launchpads and `create_instance_thread` can create an independent
thread and start its first text turn in a registered owner-side project. Supply
its `directoryKey`/`cwd`; omitting it selects the configured workspace root. Select
`workMode: local` and `executionMode: auto` when workspace edits are needed;
the defaults remain local and read-only. Launchpad requests for worktrees,
grouping, environments or provider extensions are rejected before creation.

## Identity, compute lifetime and remaining scope

The private `federation.json` stores the retained peer ID, signing/Noise keys,
pinned gateway, enrollments and peer records. `threads.json` stores owned thread
metadata. These are separate from desktop configuration and OS secret storage.
Provision each outpost with a dedicated root; do not clone a provisioned
identity into another running machine or bake it into a template image.

The peer advertises `outpost` metadata with `role: remote_agent`, `persistence: unknown`,
`retainUntil: null`, and `threadStorage: owner`. Unknown persistence is deliberate:
a process cannot infer its substrate's retention contract. There is no implicit
expiry, pause or destruction. A lost forward means unreachable; accepted work
continues. A provider stop that preserves the VM is a pause, not revocation.
Restoring disk preserves the peer; memory restore may also preserve processes.
Resize/cold boot requires restarting the service and inspecting uncertain jobs.

No provider lifecycle automation runs in this package. It does not create,
resume, stop, resize or delete a machine, infer idleness from a listening daemon,
or impose Amp's idle timers. Explicit provider deletion still destroys any
state stored only on that machine. Federation does **not** replicate Codex
transcripts to a durable gateway archive. Protect the outpost disk and identity
if replacement/recovery matters; gateway-side transcript backup and recovery
onto a new lease remain work to implement. A new empty disk cannot recover a
lost private identity or conversation merely by reusing a label.

General desktop Agent tools, automations/goals, Token Miser, image/blob input,
interactive approvals and provider installation/login remain outside this
execution host. General worktree creation is unavailable; Git thread intake
uses the shared worktree import service. Plan/collaboration and fast mode
requests are rejected explicitly. One active text turn is supported across all
projects in a profile. Transcript reads remain bounded by the transport frame
limit. No provider connections or provider credentials run here.

## Project and service contract

The CLI and federation project RPCs operate on outpost paths. They never resolve
a laptop path or borrow the viewer's Git environment. These checkout examples
use disposable directories under the configured `--workspace` root:

```sh
node packages/pwragent/bin/pwragent.js project-create --name scratch
node packages/pwragent/bin/pwragent.js project-clone --name repo --remote https://example.invalid/org/repo.git
node packages/pwragent/bin/pwragent.js project-add --path /srv/pwragent/workspace/existing
node packages/pwragent/bin/pwragent.js project-list
node packages/pwragent/bin/pwragent.js submit --id project-task --cwd /srv/pwragent/workspace/repo --prompt-file /task.txt
```

`project-remove --path PATH` unregisters an unused project without deleting its
files. Registered threads retain their actual cwd across restart. Turns,
launchpads and terminals resolve that owner-side directory again before use;
a missing directory, changed symlink or conflicting caller cwd fails explicitly.

Private Git access is destination-local and opt-in. `git-auth-configure
--config-file /outpost/git-auth-settings.json` accepts only `sshKeyPath`,
`knownHostsPath` and `credentialHelperPath`. The referenced files must already
exist on the outpost, belong to its service user and be private regular files;
a helper must also be executable. SSH requires both a key and pinned known-hosts
file. An empty object clears the selection. The persisted configuration contains
paths, not key or credential contents.

Git confines ancestor-repository discovery to the configured workspace and
disables ambient system/global configuration, interactive prompts,
credential helpers, SSH configuration, default keys and SSH agents. Only the
explicit helper/key is enabled. Clone URLs cannot embed HTTP credentials.
Authentication failure removes only the new clone directory and does not
register a project. Enrollment and Git intake do not import the sender's Git or SSH environment.

| Service | Required grants | Supported behavior |
| --- | --- | --- |
| `outpost.projects.list` | `thread_navigation` | Owner project inventory |
| `outpost.projects.create/add/remove` | `environment_actions` | Create/clone, register and unregister projects |
| `pty.*` | `remote_pty` | Input, resize, ack flow control, snapshots, history and close |
| `thread.handoff.*` | `thread_handoff`, `turn_control`, `environment_actions`, `file_push` | Explicit copy/move with receiver preflight and validated history |
| Messaging consumption | `messaging_route`, owner protocol support and owner authorization | Text replies, surface inspection/rename and authorized attachment of threads |

Terminals use the same Electron-free PTY service as desktop, including opener
ownership through relays, bounded replay, ack-window backpressure and cleanup.
A brief disconnect can reattach the same shell. The normal disconnect grace is
10 seconds; after expiry or daemon shutdown, the shell is reaped and its saved
history can open under a new shell. Agent execution has a separate lifetime.

Repository intake requires an existing registered destination clone with a
matching remote and accessible published commit. The shared handoff service
preflights it before transferring history or workspace bytes. A move archives
the source only after destination history validation and acknowledgement.
Git supplies the new destination worktree; App Server supplies thread export
bytes through its protocol and imports them through `thread/fork`. Unknown
intake outcomes survive restart and require inspection instead of another fork.

Messaging is an explicitly consumed service. Configure/enroll the always-on
provider owner separately and route/bind the chat to an outpost-owned thread.
That owner retains its adapters, credentials, actor permissions and original
conversation. It starts turns and subscribes to their events for normal replies.
The outpost stores the full origin and causal destination with the accepted job.
New outpost threads advertise the shared PwrAgent messaging tools. App Server
must support namespaced dynamic tools; intake additionally requires protocol
`fs/readFile` and `thread/fork`. Authorized
tool calls go to the original owner through `messaging.destination`, which
rechecks retained-source/provider admission, RBAC and remote-control authority.
Connection alone establishes neither a provider service nor a destination.

Retained-source messaging tools require an owner/provider that supports that
contract (currently Telegram and Slack). Other providers can still route text
turns and normal replies through their owning peer. Their outpost tools fail
closed when retained authorization is unavailable. File/PDF messaging tools are
not advertised: a local file path must not be interpreted on the provider owner.
Existing/forked Codex threads keep their creation-time tool catalog; this change
does not retrofit tools into older persisted threads.

When the owner is unavailable, the tool reports `peer_unavailable`; it never
moves the destination to another peer. Tool-call outcomes are recorded at call
boundaries. Lost acknowledgements, reconnect and restart do not replay an
uncertain send. No messaging queue or automatic retry runs on the outpost.

## Architecture

The desktop evaluator still starts Electron under Xvfb. Its backend registry
also owns settings, secrets, Git enrichment and desktop services. The headless
package instead owns a small App Server adapter and durable job registry.
`@pwragent/federation` extracts the existing host-independent Noise transport,
enrollment, router and RPC implementation. Desktop wrappers preserve existing
imports and inject desktop diagnostics; the headless host supplies private JSON
identity storage and its backend adapter. The same package now owns the PTY,
file transfer and transactional thread-intake services. `@pwragent/agent-tools`
owns the host-independent dynamic tool schemas/router; desktop imports wrappers
for both packages. Neither shared package imports desktop code. The CLI bundles
the JavaScript services and produces `dist/THIRD_PARTY_LICENSES` at build time.

[Amp's retention contract](https://ampcode.com/security) distinguishes paused
compute from deletion: paused orb disk and memory remain until thread deletion.
Its [current idle policy](https://ampcode.com/docs/orbs/sizes-and-costs) requires
both five minutes without agent work and twenty minutes without interaction.
Those clocks are reference research, not policies implemented here. Amp's
server-side thread ownership also differs from this outpost's local ownership.

[Sandboxer SSH](https://sandboxer.com/docs/ssh.md) documents authenticated
outbound WebSocket transport, SCP, forward/reverse-forward and `ssh --stdio`.
[Sandboxer long-running tasks](https://sandboxer.com/docs/long-running.md)
documents systemd and memory-preserving stop/resume. The repository's
[federation architecture](../../docs/federation-architecture.md) and
[connectivity reference](../../docs/federation-connectivity-reference.md) describe
the shared trust and routing contract. Research was checked on 2026-10-23.

## Development validation

```sh
pnpm --filter pwragent test
pnpm --filter pwragent pack:check
```

The tests spawn the actual daemon and CLI with a fake Codex executable in
short temporary directories under /tmp, so the daemon socket path stays
under its 100-byte limit wherever the checkout lives. They cover disconnect survival,
idempotency, continuation, single-owner admission, early terminal events,
failures, denied interactive requests, shutdown and process-group cleanup.
They also use the actual encrypted federation stack to cover one-time invite
consumption, capability denial, key pinning, direct and three-peer relay access,
subscription filtering, dropped forwards, restart and identity retention. A
desktop Vitest integration test runs its real `FederationRemoteBackendClient`
against the daemon. External providers and Codex are mocked; no live peers,
operator projects, credentials or compute machines are used. Ubuntu CI runs the
Node suite; the desktop contract test runs on POSIX lanes.

A separate live smoke test installed the packed tarball and official Codex
0.159.2 in a Node 24 Debian Linux arm64 Docker image. It used an unprivileged
user, a read-only authentication-file mount, container-owned state and workspace,
and an isolated federation. The desktop backend client created a thread and
started real model work that ran commands and wrote a marker file. Execution
survived viewer disconnection; reconnect, transcript reads, submission
deduplication, container restart, continuation and three-peer gateway relay
passed. This caught the first-turn requirement to use an already loaded thread
directly: Codex cannot resume its empty rollout before the first turn starts.

A subsequent live test enrolled the Docker outpost into an existing desktop
gateway using a one-use invite copied privately into the container. PwrAgent's
instance tools discovered its workspace and models, created a thread through
the directory launchpad, ran commands and wrote a marker file. A continuation
completed while the gateway forward was closed; reconnecting exposed its
transcript through the gateway. This caught missing launchpad configuration
and materialization contracts, now covered by the mocked integration tests.

Docker's default seccomp policy blocked the namespaces used by Codex's Linux
sandbox. The successful run retained dropped container capabilities and
`no-new-privileges`, using the Docker default profile with additional allowance
for `clone`, `unshare`, `setns`, `mount`, `umount2` and `pivot_root`. Codex retained
its workspace-write sandbox. This verifies that container configuration, not
every Linux host policy. systemd and microVM restore remain unverified. Windows
is not supported.

## License

MIT. See the repository root [LICENSE](../../LICENSE).
