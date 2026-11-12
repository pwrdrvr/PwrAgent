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
Use the same account, root and profile for every local command. `serve` takes an
exclusive 0600 `state/headless/owner.lock` before opening the owner. Stop the
recorded PID and its descendants before manually removing a lock after a crash;
never remove a live owner's lock. Back up the entire profile while stopped.

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

The Outpost host enables only Codex. Approval is always `never`; full access is unavailable. Default mode
is read-only; Auto mode grants workspace-write with tool network access disabled
and temporary directories excluded. Host configuration cannot widen those rules.
The shared federation containment guard covers direct and backpressured sends;
a contained Outpost cannot initiate remote owner mutations or file transfers.
Refusals are audited without recording request payloads.

Model commands run as the Outpost's own user, so file modes cannot keep them
out of its profile directory, which holds `state/headless/rpc.sock`, the
`headless-secret.key` file and the state database. Each Outpost Codex sandbox
is a named permission profile (`pwragent-outpost-read-only`,
`pwragent-outpost-workspace-write`) that denies `$PWRAGENT_HOME/profiles`.
The Outpost refuses any other sandbox or profile, a thread working directory
inside that directory, and Codex config overrides of `permissions`,
`default_permissions`, `sandbox_mode` or `sandbox_workspace_write`.

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
use approval policy `never`, read-only or workspace-write access, and disabled
tool network access. Full access is unavailable. The startup check never
retries with broader permissions.

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
