# PwrAgent Outpost

The Outpost runs the desktop application's owner services under Node, without
Electron or a display server. Threads share the desktop registry, inbox,
queue, federation handlers and shutdown path. Separate threads can run turns
concurrently, and new threads can be created while other turns run.

Provide Node 24 or newer and an independently installed, authenticated Codex CLI.
Install the matching desktop release with `npm install --global pwragent@VERSION`.
Native SQLite, PTY and image dependencies install for the target platform.
Installation requires a C compiler, curl and tar, and lifecycle scripts enabled.
The installer builds the local IPC relay from the desktop source and fetches
the desktop's pinned, verified Git payload for the destination. The package ships
worker entries, the Git manifest, source/build tools and third-party notices.

From a checkout, run `pnpm install` and `pnpm --filter pwragent build`, then use
`node packages/pwragent/bin/pwragent.js` in place of `pwragent` below.

```sh
pwragent serve --profile outpost --workspace /srv/pwragent/workspace \
  --codex-home /var/lib/codex-outpost --codex-bin /usr/local/bin/codex
```

Provision these non-overlapping directories for the unprivileged service user.
The process runs in the foreground; a container or the example systemd unit owns
its lifetime. `--codex-bin` selects the executable for this daemon; it refuses to
launch another installation if that executable becomes unavailable. PwrAgent
never provisions Codex credentials or reads its storage files.

The profile is under `$PWRAGENT_HOME/profiles/NAME` (default root `~/.pwragent`).
Use the same account, root and profile for every local command. `serve` holds an
exclusive OS lock on the private `state/headless/owner-lock.db` for its whole
life, and writes a 0600 `state/headless/owner.lock` beside it. The kernel
releases the lock when the process exits, however it exits, so a restarted or
replacement container on the same volume starts without cleanup, even though
every container runs the owner as PID 1. A second `serve` on the profile
refuses while the first is running. The new owner also takes over the profile
federation and messaging leases of the owners that held this lock before it.

An `owner.lock` written by PwrAgent 1.4.0 or earlier is never taken over,
because that version may still be running. Stop the recorded PID and its
descendants before removing that file; never remove a live owner's lock. Back
up the entire profile while stopped.

Headless secrets use AES-256-GCM and a private 0600 `state/headless-secret.key`.
Keep that key with the database backup. Desktop keeps its OS keychain. Secrets
from the other host remain stored and show as unavailable until explicitly
replaced; neither host silently deletes or overwrites them.

## Local commands

`pwragent --version` reports the installed version. `status` reports the selected
Codex executable, backends and federation health. `list` lists owner threads;
`show` reads a thread. Other commands take `--params-file /request.json` with the
same parameter object as the desktop owner contracts:

| Command | Parameters / existing owner operation |
| --- | --- |
| `start-thread` | `backend`, `cwd`, optional `executionMode` and model settings |
| `register-directory` | `path`: adds an existing folder as a project, as the desktop's Add Project Directory does |
| `show` | `backend`, `threadId` |
| `submit` | `SubmitDurableTurnRequest`: immutable client request ID, creation time, payload hash and request |
| `receipt` | Durable client request `id`, `backend`, `threadId` |
| `pause`, `resume`, `cancel`, `release` | `queueEntryId` |
| `move` | `queueEntryId`, optional `beforeQueueEntryId` |
| `interrupt` | `backend`, `threadId`, `turnId`, `operation` |
| `federation-join` | `invite` from the gateway |
| `federation-invite` | Optional listening `port` and `label`; creates a local gateway invite |
| `federation-status`, `federation-leave` | No parameters |
| `federation-revoke` | `peer` instance ID |

For example, `show --params-file /request.json` can use
`{"backend":"codex","threadId":"YOUR_THREAD_ID"}`. Queue controls use the queue
identity returned by acceptance, not the retired daemon's job IDs. A durable
request retry must reuse its complete original envelope. The built Node entry
exports the shared `canonicalDurableTurnRequest` helper; SHA-256 its UTF-8 result
for `clientRequest.payloadHash`. The existing owner receipt path owns acceptance
and deduplication. No second job store or queue exists.

The desktop viewer provides the remaining owner operations. Legacy Outpost job
files, output formats and its command surface are retired. This host opens the
standard profile SQLite database directly.

## Unattended execution

An Outpost is a headless PwrAgent instance and a full member of its
federation. The host enables only Codex. Default mode is read-only; Auto mode
can also write the thread's workspace. Unless the operator widens them, Full
Access is unavailable and tool network access is disabled.

The operator sets these environment variables when the Outpost starts, for
example with `docker run -e`. Agents cannot change the running owner's
environment. An unknown value stops startup instead of falling back.

| Variable | Values | Default |
| --- | --- | --- |
| `PWRAGENT_OUTPOST_EXECUTION_MODES` | Comma-separated `default`, `auto`, `full-access` | `default,auto` |
| `PWRAGENT_OUTPOST_AGENT_NETWORK` | `on` or `off`: network for agent commands | `off` |
| `PWRAGENT_OUTPOST_APPROVALS` | `ask` or `never` | `ask` |
| `PWRAGENT_OUTPOST_FEDERATION_ROLE` | `contained` or `full` | `contained` |

With `full-access` allowed, those turns run without the Codex sandbox, so the
container is the only boundary: agents can read everything in it, including
the Outpost's own keys. Allow it only for models you trust.

### Approvals

With `ask`, each execution mode asks for approval exactly as it does on a
desktop. A request appears in Attention and on the thread for every viewer
that holds the `pending_request_control` grant, and any of them can approve or
decline it. The turn waits for the answer. On a contained Outpost a person
reviews requests in Auto mode too: Codex's Auto reviewer falls back to the
turn's own model, which would then approve its own escalations.

With `never`, nothing asks. A command that needs approval fails, and the turn
continues without it. Use it for an Outpost nobody watches.

### Containment

The federation role is a property of the member, the same on a desktop and
an Outpost. A contained member cannot call back into the federation: its own
owner refuses the requests it would originate, on direct and backpressured
sends, and audits each refusal without recording the request payload. Its
models see and can call only a short list of read-only PwrAgent tools. A full
member has neither limit. Peers still enforce the role they assigned when
they invited the member.

Contained is the default, so an upgrade never widens what an existing Outpost
may do. Set `PWRAGENT_OUTPOST_FEDERATION_ROLE=full` only for models you trust
with the federation. A desktop sets the same thing with `member_role` under
`[federation]` in its profile's `config.toml`; there the default is `full`.

Model commands run as the Outpost's own user, so file modes cannot keep them
out of its profile directory, which holds `state/headless/rpc.sock`, the
`headless-secret.key` file and the state database. Each Outpost Codex sandbox
is a named permission profile (`pwragent-outpost-read-only`,
`pwragent-outpost-workspace-write`) that denies `$PWRAGENT_HOME/profiles`.
Both profiles take their network from `PWRAGENT_OUTPOST_AGENT_NETWORK`. The
Outpost refuses any other sandbox or profile, a thread working directory
inside that directory, and Codex config overrides of `permissions`,
`default_permissions`, `sandbox_mode` or `sandbox_workspace_write`. The one
exception is Full Access when the operator allows it: a request whose every
sandbox selection asks for it reaches Codex unchanged, with no profile.

The Codex sandbox preflight runs before the owner starts. It applies the
workspace-write profile and fails unless the sandbox prevents a read of the
owner lock. A failed check aborts startup with its diagnostic. It never retries
with broader permissions.

### Linux containers

Codex's bubblewrap sandbox requires user and mount namespaces. The host must
permit unprivileged user namespaces, and container seccomp/LSM policy must
permit the sandbox's namespace and mount operations. Docker's default seccomp
profile alone can produce `bwrap: No permissions to create a new namespace`.

Use `--cap-drop ALL` and `--security-opt no-new-privileges` with a seccomp
profile built from Docker's default profile plus one `SCMP_ACT_ALLOW` rule
for `clone`, `unshare`, `setns`, `mount`, `umount2`, and `pivot_root`. Keep all
the default profile's other restrictions. For example, given the Docker
default profile for your engine as `docker-default.json`:

```sh
jq '.syscalls += [{"names":["clone","unshare","setns","mount","umount2","pivot_root"],"action":"SCMP_ACT_ALLOW","args":[]}]' \
  docker-default.json > seccomp-outpost.json
```

Minimal run example for an image with `pwragent` as its entry point and Codex
installed at `/usr/local/bin/codex`. Run as the image's unprivileged user;
provision the three separate mounted directories for that user first, and
configure authentication in the dedicated Codex home using the Codex CLI.

```sh
docker run -d --name pwragent-outpost \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp="$(pwd)/seccomp-outpost.json" \
  -e PWRAGENT_HOME=/state \
  -v outpost-state:/state -v outpost-codex:/codex -v outpost-workspace:/workspace \
  YOUR_OUTPOST_IMAGE serve --workspace /workspace \
  --codex-home /codex --codex-bin /usr/local/bin/codex
```

The container options permit Codex to create its sandbox. Outpost turns still
use the approvals, execution modes and network setting above.
The startup check never retries with broader permissions.

## Validation

`pnpm --filter pwragent test` runs sandbox, version and release guards.
`pnpm --filter pwragent pack:check` installs the tarball away from the checkout
and exercises the built Node owner, native modules, durable submission and CLI
reads. The desktop-main suite boots fresh desktop and Node owner roots against
the same App Server fixture, with strict lifecycle conformance and a concurrent
turn oracle. These are protocol fixtures, not live inference or UI proof.

## License

MIT, Copyright PwrDrvr LLC. Retain `LICENSE`, `dist/THIRD_PARTY_LICENSES` and
`resources/git-notices` when redistributing. The bundled Git executable has its
own GPL notices and source/build locations; it runs as a separate process.
