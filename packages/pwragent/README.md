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
| `factory-admission` | `action`, `projectKey`, `workItem`, and the action fields below |
| `factory-review` | `action`, `projectKey`, `workItem`, `branch`, `baseRef`, `baseOid`, `headOid` |
| `factory-scaling` | `action`, `projectKey`, `repository`, `approvalId`, `candidate`, and the record fields below |
| `factory-publication` | `action`, `approvalId`, and the publication fields below |
| `factory-landing` | `action`, `approvalId`, and the check or confirmation fields below |
| `factory-board` | `projectKey` from `register-directory`, `repository` matching the registered GitHub origin, optional `limit`, `candidate` and `selection` |
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

### Factory evidence

Run `pwragent factory-board --params-file /request.json` with the registered
`projectKey` and the GitHub repository name, for example `PwrAgent`. The owner
verifies the repository against the registered project's GitHub origin. It
returns up to 25 recent open PRs, including PRs that no local thread has
attached. `truncated` indicates more open PRs exist.

For a tracked branch, pass `candidate` with the selected `workItem`, the local `branch` and a full
`baseRef` such as `refs/remotes/origin/main`. Optionally supply the linked
`worktree`, up to eight existing local `reviewIds`, and `assessment` with
`outcome` and `change`. The owner verifies the Git checkout and reports its
local refs, matching review observations and runtime identity. A ref-only
candidate remains readable as `parked`. A candidate-only read sets `inventory`
to `unobserved` and makes zero forge requests. The local operator supplies the
tracking reference. Reading it requires no issue-tracker connection.

| Tracking record | Example `candidate.workItem` |
| --- | --- |
| GitHub issue | `{"provider":"github","kind":"issue","repositoryId":"R_example","number":42}` |
| Existing GitHub PR, including a draft | `{"provider":"github","kind":"pull_request","repositoryId":"R_example","number":42}` |
| Jira issue | `{"provider":"jira","siteId":"site-a","id":"10042"}` |
| Linear issue | `{"provider":"linear","id":"10000000-0000-4000-a000-000000000042"}` |

For GitHub, use the tracker's repository node ID. The project inventory returns it in
`repository.id` for the code repository. For Jira, use a stable site identifier and
the numeric issue ID. The earlier `candidate.issueId` input still identifies the
same Linear outcome. Supply exactly one tracking reference. A PR used as the
tracking record must match the selected repository ID and PR number before the
owner can confirm publication. Draft status is an observation. The repository's
own workflows determine whether CI runs.

To inspect a PR, add `selection` with its `number` and the `repositoryId` from
the inventory response (`repository.id`). Pass `expected: { headOid, baseOid }`
to compare with a previously observed revision. Pass `requiredChecks` with
the CI context names to evaluate; absent, skipped and incomplete contexts
never establish a pass. For an advisory assessment, pass
`assessment: { outcome, change }` in the selection. The response supplies an
input packet for a separate `decisions_invoke` using `factory_pr_review_v1`.
This read does not invoke a model. The local desktop window uses the same
owner read through `readFactoryProject`.

Pass the original `candidate` alongside `selection` after publishing. The
projection keeps the issue-derived `candidate.outcomeId` and confirms the PR
when repository, branch, target ref, head and base agree. A later revision change is
shown separately from the local candidate revision.

## Unattended execution

An Outpost is a headless PwrAgent instance that can join a federation. The host
enables only Codex. Default mode is read-only. Auto mode can also write the
thread's workspace. By default, Full Access is unavailable and tool network
access is disabled.

The operator sets these environment variables when the Outpost starts, for
example with `docker run -e`. Agents cannot change the running owner's
environment. An unknown value stops startup instead of falling back.

| Variable | Values | Default |
| --- | --- | --- |
| `PWRAGENT_OUTPOST_EXECUTION_MODES` | Comma-separated `default`, `auto`, `full-access` | `default,auto` |
| `PWRAGENT_OUTPOST_AGENT_NETWORK` | `on` or `off`: network for agent commands | `off` |
| `PWRAGENT_OUTPOST_APPROVALS` | `ask` or `never` | `ask` |
| `PWRAGENT_OUTPOST_FEDERATION_ROLE` | `contained` or `full` | `contained` |
| `PWRAGENT_OUTPOST_OPENAI_PROVIDER` | `on` or `off` for Codex's built-in OpenAI provider | `on` |

Execution mode and federation role are independent. A contained Outpost
supports Auto with workspace writes and operator-controlled approvals. With
`full-access` allowed, those turns run without the Codex sandbox, so the
container is the only boundary on files and network: agents can read
everything in it, including the Outpost's own keys. See "What holds in each
mode" below before allowing it for a model you do not trust.

The allowlist applies to all threads owned by the Outpost. To change it on an
existing Docker Outpost, back up its named volume and recreate the container
with the updated environment and the same volume attached. The volume holds
the Outpost's enrollment, threads, and workspaces.

For a proxy-only deployment, set `PWRAGENT_OUTPOST_OPENAI_PROVIDER=off` and
configure a Codex model provider in the Outpost profile. New threads can use
qualified models such as `@proxy/model`. When a launch omits the model, the
owner selects an available configured model. Existing OpenAI threads remain
readable and keep their model metadata. To continue their work through a proxy,
start a new thread on that provider. Thread naming uses the first prompt as
its fallback while the OpenAI title helper is disabled.

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
an Outpost. A contained member cannot act on other instances. Two parties
enforce it:

- **Its peers.** Each peer refuses a contained member's requests to act on
  it, and will not relay for it. A peer assigns a role when it invites the
  member, `full` unless the inviter chose contained. A contained member
  also declares itself contained to each peer it connects to, and from then
  on that peer assigns it contained. Nothing the member sends afterwards
  relaxes that, so a model that took the member's keys cannot undo it. Only
  the peer's operator can, in Settings → Federation. Peers on builds without
  `member_role_declaration_v1` keep the role they assigned at the invite.
- **The member itself.** Its owner refuses the federation requests it would
  send, on direct and backpressured sends, and audits each refusal without
  recording the request payload. Its models see and can call only a short
  list of read-only PwrAgent tools. This half runs in the same container as
  the model's commands, so in Full Access it is a convenience, not a
  boundary: those commands can read the member's federation keys and
  connect as it. Its peers' half still holds.

Contained is the default, so an upgrade never widens what an existing Outpost
may do. Set `PWRAGENT_OUTPOST_FEDERATION_ROLE=full` only for models you trust
with the federation. An Outpost that once declared itself contained stays
contained at each peer until that peer's operator changes it. A desktop sets
the same thing with **Contain this instance** in Settings → Federation, which
writes `member_role` under `[federation]` in its profile's `config.toml`;
there the default is `full`.

A member's upstream gateway also decides its containment. The gateway answers
each declaration with the role it assigns, and tells the member again whenever
its operator changes that role. When the gateway assigns contained, the member
contains itself as if its own setting said so, toward every peer. It keeps
that assignment in its state database, so a restart does not release it.
Other peers' assignments never change the member's containment, so it never
acts as full toward one peer while its gateway refuses it everywhere. Settings
→ Federation and `list_federation_instances` show the member's containment, and
the role each peer assigns it. A member still declares its own setting, not
the role its gateway gave it. Otherwise a reconnect would re-tighten a role
the gateway's operator relaxed while the member was offline.

### What holds in each mode

| | Default, Auto | Full Access |
| --- | --- | --- |
| Codex sandbox | Read-only or workspace-write; denies the profile folder and Codex credentials | None |
| Container | Boundary | The only boundary on files and network |
| Federation keys, `headless-secret.key`, state database | Unreadable to agent commands | Readable to agent commands |
| Contained role at peers | Holds | Holds |
| Contained role inside the Outpost | Holds | Bypassable |
| Approvals | `PWRAGENT_OUTPOST_APPROVALS` | Never asks |

To run untrusted models in Full Access, keep only placeholder credentials in
the Codex home (the model key proxy holds the real key), give the container
no route out except the key proxy and its federation link, and treat the
volume as the model's. Never promote that Outpost to `full` with the same
federation identity: re-enroll it first.

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

### Factory admission pilot

Run `pwragent factory-admission --params-file /request.json` on the selected
owner profile with its Federation runtime active. Use the registered project
key and the same immutable `workItem` as the board's local branch selection.

| Tracking record | `workItem` example |
| --- | --- |
| GitHub issue | `{"provider":"github","kind":"issue","repositoryId":"R_fixture","number":42}` |
| Existing GitHub pull request | `{"provider":"github","kind":"pull_request","repositoryId":"R_fixture","number":42}` |
| Jira issue | `{"provider":"jira","siteId":"fixture-cloud","id":"10042"}` |
| Linear issue | `{"provider":"linear","id":"521ed3a0-6f45-45fd-b8ec-fa070a530661"}` |

Use the tracking repository's immutable ID for GitHub and the site's and
issue's immutable IDs for Jira. The tracking record can live in a different
repository or system from the checkout. Admission needs no tracker connector.

The `arm` request also takes the registered GitHub origin as `owner/repository`,
the owner and executor's exact Federation instance and machine IDs, and the
executor platform.

```json
{
  "action": "arm",
  "projectKey": "directory:/projects/PwrAgent",
  "workItem": {"provider": "github", "kind": "issue", "repositoryId": "R_fixture", "number": 42},
  "repository": "pwrdrvr/PwrAgent",
  "owner": {
    "instanceId": "selected-gateway",
    "machineId": "mach_00000000-0000-4000-8000-000000000001"
  },
  "target": {
    "instanceId": "selected-builder",
    "machineId": "mach_00000000-0000-4000-8000-000000000002",
    "threadId": "operator-prepared-codex-thread",
    "worktreePath": "/projects/worktrees/factory-42"
  },
  "platform": "darwin",
  "brief": "Implement the approved outcome and verify its acceptance criteria."
}
```

Use a dedicated idle first-party OpenAI Codex thread with one PwrAgent-owned
worktree in the selected repository. Turn off the
thread's provider MCP servers and disconnect all MCP connections. Use a thread
without attached PRs, Auto-fix, an active goal, an environment override, or
PwrAgent automations. A separately enabled auto-merge or forge workflow is
outside this pilot. The operator must confirm that none acts on the worktree.

Run the worker on an operator-prepared Outpost with
`PWRAGENT_OUTPOST_FACTORY_BUILDER=on`, agent network disabled and Full Access
unavailable. The opt-in asserts that the operator has excluded credentials,
privileged sockets, writable shared mounts, and other side-effecting channels
from the worker's command environment. Keep the checkout inside the Outpost's
configured `--workspace`. Use in-repository worktree storage
(`[worktrees]` with `storage = "in-repo"`) so the sandbox can use the checkout.
Point `--codex-bin` at a Codex build that advertises dynamic tool replacement
on `thread/resume`, such as the PwrAgent-managed build. The owner refuses builds without
that capability. You can select a newly created persistent Codex worktree
thread with paginated history. Codex saves it during preparation before any
model input. The daemon must pass its Codex sandbox preflight first. The
receiving owner checks worker settings again and requires a fresh Codex session with its
network-disabled workspace-write profile, one workspace root, and an empty
MCP inventory before sending the prompt. Provider apps, plugins, delegation,
hooks and web search are disabled for this turn. The owner refuses dynamic
tools, its MCP tools, and MCP gateway access from the worker. Once the worker
is idle, the same thread can accept another approved task or an ordinary
operator turn with its configured tools and sandbox.

The operator is trusting the first-party Codex binary and its sandbox, the
Outpost OS and launch configuration, and the approved checkout and local
commands it runs. Builds and tests execute repository code and can change
everything writable in the sandbox. Review the resulting local changes before
publication. Ordinary desktop executors and older owners cannot dispatch a
restricted Factory turn. Approvals recorded before this isolation version
can still be inspected and reconciled. Their dispatch is refused because the
old approval did not bind this restriction.

A packaged owner running under an alternate PwrAgent root cannot host its own
machine CPU pool. Keep the checkout dedicated to this outcome
until it settles. The owner permits one active outcome per profile and
reserves one CPU slot on the selected physical machine. For a remote builder,
add the same entry to `domains` in the version 1
`resource-checkout-authorities.json` at the PwrAgent root of the gateway and
capacity authority, then restart the profiles.

```json
{
  "canonicalKey": "factory-cpu:mach_00000000-0000-4000-8000-000000000002",
  "authorityInstanceId": "selected-capacity-owner",
  "authorityMachineId": "mach_00000000-0000-4000-8000-000000000002",
  "allowedInstances": ["selected-gateway"]
}
```

This binding authorizes the named gateway to reserve from the authority's
`machine:<machineId>:cpu` pool, which also serves other profiles and local
test reservations. Ordinary Federation resources use owner catalog discovery.
The gateway connects directly to the configured capacity authority and the
builder. A remote builder uses full Federation enrollment
(`PWRAGENT_OUTPOST_FEDERATION_ROLE=full`) and must advertise durable turn
requests and an exact repository link for the worktree. Factory still checks
the builder policy and requires an idle-only start. VM-backed and E2E-VM
requests wait for a later pilot.

Use `dispatch` with the same `projectKey`, `workItem` and `brief` within
30 minutes to request an idle-only start. The owner stores the brief's
hash. Use `status` to read the local record and `reconcile` to read the
exact dispatch receipt, including after restart. An immediate retry of
`dispatch` uses the original ID and capacity grant. `pause` and `resume`
control future starts for that record. `cancel` addresses only the verified
queue entry or turn ID. The advisory CPU reservation expires after 30 minutes.
Reconciliation reports ended or unverified capacity separately from the turn's
status. A running or ambiguous turn continues to hold its Factory worktree
fence. The selected operator can cancel a matched turn.

Existing Linear callers can supply `issueId` with the immutable UUID in place
of `workItem`. Both forms address the original approval and receipt. An older
approval stored under a Linear display identifier such as `PWR-262` can still
be inspected, paused, reconciled or cancelled using that identifier.

The desktop local main frame reaches the same owner command through
`window.pwragent.factoryAdmission(request)`.

### Review a Factory branch before opening a pull request

Use `pwragent factory-review --params-file /request.json` on the Outpost owner
profile after `factory-admission reconcile` reports a completed implementation
turn. This pilot supports an implementation on the same owner and machine as
the registered project. Commit the changes on the approved implementation
thread's active, clean worktree and leave the thread idle. Select the target ref
explicitly. For example, use `refs/remotes/origin/main` with its current locally
stored commit. The command reads local Git state without fetching.

```json
{
  "action": "start",
  "projectKey": "directory:/projects/PwrAgent",
  "workItem": {"provider": "github", "kind": "issue", "repositoryId": "R_fixture", "number": 42},
  "branch": "factory/review-example",
  "baseRef": "refs/remotes/origin/main",
  "baseOid": "0123456789abcdef0123456789abcdef01234567",
  "headOid": "89abcdef0123456789abcdef0123456789abcdef"
}
```

The owner checks the registered origin, approval, thread and checkout, then
starts the existing managed Codex reviewer in a separate read-only session.
The reviewer reads the committed diff between the recorded merge base and head.
The findings appear on the implementation thread for ordinary triage. Auto-fix
is unarmed. Repairs, pushes, and publication stay with the publisher.

Use the same request with `action: "status"` after a disconnect or restart.
The response includes the approval and implementation turn, the reviewed range,
and the reviewer and turn IDs when known. A completed reviewer result includes
a link to its artifact. Repeating `start` for the same range returns the existing attempt.
An ambiguous start stays fenced, including if the branch moves to a different
head. If the owner recovers the exact durable review artifact, it records that
verdict without starting another review.

A `clear` result means the independent reviewer explicitly reported correctness
on the current committed range with no findings. `findings` and
`inconclusive` require operator attention. Moving the head or target ref
makes the old review `stale`. A preserved branch whose approved worktree is
no longer active appears as `parked`, with the existing review evidence visible
and publication unobserved. The command reports human visual acceptance and
scaling proof as unverified. It gives no landing authority.

### Factory prepublication scaling evidence

Use `pwragent factory-scaling --params-file /request.json` on the approval's
active owner profile. Get `approvalId` from `factory-admission status` (`row.id`).
Use the same project key, GitHub `owner/repository` and immutable tracker
reference. Put `workItem` in `candidate`. A legacy Linear UUID in `issueId`
is also accepted. Select a checked-out branch and a full integration ref, as in
`factory-board`. The approval supplies the worktree path. This pilot supports
an approved linked worktree on the same owner instance and machine.

Start with `action: "status"` and these fields:

```json
{
  "action": "status",
  "projectKey": "directory:/projects/PwrAgent",
  "repository": "pwrdrvr/PwrAgent",
  "approvalId": "24617983-8584-4b8c-bca0-d3ee242e70ea",
  "candidate": {
    "issueId": "521ed3a0-6f45-45fd-b8ec-fa070a530661",
    "branch": "factory/pilot",
    "baseRef": "refs/remotes/origin/main"
  }
}
```

Run the [scaling audit](../../.agents/skills/pwragent-scaling-audit/SKILL.md)
separately against the revision pair returned in `candidate`. Keep the raw
probe results and reduced counterexamples where the operator can inspect them.
Change the action to `record` and add these fields, using the audit's actual
Git OIDs, measurements and proof URLs:

```json
{
  "expected": {
    "headOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "baseOid": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "previousReceiptId": null,
  "report": {
    "exitCode": 0,
    "workloads": [{
      "name": "Cold candidate read",
      "proof": "file:///tmp/scaling-audit/candidate.json",
      "samples": [
        {"sizes": {"refs": 16}, "counters": {"gitStarts": {"measured": 16, "bound": 16}}},
        {"sizes": {"refs": 32}, "counters": {"gitStarts": {"measured": 16, "bound": 16}}},
        {"sizes": {"refs": 64}, "counters": {"gitStarts": {"measured": 16, "bound": 16}}}
      ]
    }],
    "counterexamples": []
  }
}
```

`previousReceiptId` is `null` for the first submission. Use the last
`receipt.receiptId` for a new submission. Replaying the latest identical
request reuses its receipt. A delayed replacement based on an older receipt
is refused. Each approval has one latest receipt under its profile's
`artifacts/factory/scaling` directory. Its JSON is capped at 32 KiB. Each
workload has 2–6 distinct sizes, comparable counters, and an HTTPS or local
file proof URL. Record each outstanding counterexample for this revision with a
description and proof URL. An outstanding counterexample yields a failed audit,
even when all sampled counters are within budget.

The owner observes the Git head, integration tip and tracked and non-ignored
worktree status locally. It checks both repositories' origins and samples refs
on either side of the clean check. Remote-tracking refs are the local values
already on disk. `missing` means there is no recorded audit. `stale` means the
prior audit's checkout, refs or commits could no longer be verified as matching.
`failed` means a matching audit reported a nonzero exit code or exceeded a
counter bound. `current` means a matching audit reported completion within
its bounds. Each report is explicitly `operator_attested`. Proof URLs are
references for the operator. The command makes zero provider requests. The
existing Profile scaling audit workflow requires a PR, so it supplies no
independent prepublication receipt in this pilot.

The [Outpost command tests](../../apps/desktop/src/main/__tests__/factory-scaling.test.ts)
exercise real linked worktrees and the SQLite admission store. Six clean reads
at 16–128 tracked fixture files and 16–128 unrelated refs each made 16 Git
calls, including one status and one index inspection. Recording, inspection,
replay and replacement made zero SQLite commits. Each accepted new report
replaces one bounded artifact. The tests also cover a missing integration ref
with a same-named tag, a hidden index edit, a different owner, and a failed
receipt replayed after replacement.

### Prepare and reconcile Factory publication

Run `pwragent factory-publication --params-file /request.json` on the
operator's active Outpost owner profile. Select the same registered project,
completed approval, work item, and clean linked worktree used for the branch
review and scaling audit. The head branch and target must already exist in the
same GitHub.com repository at the selected commits.

```json
{
  "action": "prepare",
  "approvalId": "24617983-8584-4b8c-bca0-d3ee242e70ea",
  "projectKey": "directory:/projects/PwrAgent",
  "repository": "pwrdrvr/PwrAgent",
  "workItem": {"provider": "linear", "id": "521ed3a0-6f45-45fd-b8ec-fa070a530661"},
  "branch": "factory/pilot",
  "baseRef": "refs/remotes/origin/main",
  "headOid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "baseOid": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "notReadyLabel": "hold-for-operator",
  "policy": {
    "risk": {"level": "routine", "reference": "Operator reviewed the change and repository publication policy."},
    "visual": {"decision": "not_required", "reference": "This change has no user-visible behavior."},
    "acceptOperatorAttestedScaling": true
  }
}
```

Use the immutable tracker reference from the approval. The command accepts a
Linear UUID, a GitHub issue or pull request with its repository node ID and
number, or a Jira site ID and issue ID. The legacy `issueId` field accepts a
Linear UUID in place of `workItem`. A GitHub pull request work item pins the
existing PR. For other work items, `pullRequestNumber` optionally pins an
existing PR in the selected repository. The optional `notReadyLabel` names
the hold label this repository uses. A draft or matching label is reported
as observed. Whether CI runs on those PRs depends on the repository workflow.

The operator records the risk decision and the visual acceptance decision.
Use `accepted` with the evidence reference when visual acceptance applies.
Pending visual acceptance and unverified or high-consequence risk block this
pilot. A current clear managed branch review and a passing scaling
attestation are required. The operator inspects the scaling proof and
explicitly accepts its provenance. CI, PR readiness, and model assessments
supply no operator approvals.

Inspect the plan returned by `prepare`. To record the local intent, send the
same request with `action` set to `arm` and `confirm` set to its `planId`.
The owner rechecks the plan before storing it. A matching existing PR is
reused as-is. By default, when there is no existing PR, the result is
`manual_required` and the operator opens it on GitHub.

To authorize opening one PR from the already-pushed branch, include
`"creation": {"title":"The PR title","body":"The PR description","draft":true}`
in `prepare`. Choose `draft` explicitly. The `open_pr` preview includes the
repository and exact reviewed head and base, the PR content, and the window
between the final GitHub observation and PR creation. GitHub receives branch
names, so a branch can move in that window and the PR may open against
different commits. Opening the PR can trigger CI, including for a draft.
After reviewing this effect, the operator sends the same request with
`action` set to `arm` and its `planId` as `confirm`. The command uses the
owner profile's GitHub sign-in and applies its Agent forge tools settings
and the implementation thread's project rule. The confirmation covers this
PR opening only. A matching PR is reused without changing it. A missing
explicitly selected or tracked PR blocks the request.

After manual publication, a lost reply, or a restart, send
`{"action":"reconcile","approvalId":"<approval UUID>"}`. The owner checks the
live head and target and reuses only a matching first-party PR. If the forge
can't confirm the result, the command reports `uncertain`. It distinguishes
missing refs or PRs, moved revisions, and conflicting PR identities. An armed
plan stays tied to one approval and one revision pair. A durable claim
prevents another creation on that branch in the owner profile. A lost reply
keeps that claim even when GitHub currently shows no PR. Reconcile again if
the PR later becomes visible. A recorded PR remains pinned by its provider
ID and number.

To replace a stale plan, include its `planId` as `previousPlanId` in a new
`prepare` and then confirm the new plan. Keep the same repository, head
branch, and target branch. Update the branch review and scaling evidence for
any changed commits. If GitHub opened a PR during drift, reconcile its
identity first and use the replacement plan to adopt that PR at its current
reviewed revision. A definitive provider refusal also allows an explicitly
confirmed replacement after a fresh check. An unresolved possible creation
continues to block replacement. A PR created against a different revision
must be explicitly adopted before it is eligible for a landing preview.
An active landing pause, cancellation or queue attempt also prevents
replacement. Resume or reset through the landing command when eligible.
An uncertain queue request keeps its original publication for reconciliation.

### Evaluate and confirm Factory queue admission

Use `pwragent factory-landing --params-file /request.json` on the same active
owner after publication has recorded a PR number and node ID. The approval
supplies the work item, repository, PR, head, target branch, and base commit.

```json
{
  "action": "prepare",
  "approvalId": "24617983-8584-4b8c-bca0-d3ee242e70ea",
  "requiredChecks": ["integration / test"]
}
```

Name the required contexts that must actually run on the GitHub test merge
commit. The preview requires the test commit's parents to be the published
base and head, each named context to be required by GitHub and report explicit
success, and the head rollup to be successful for queue admission. Other
reported required integration checks must also pass. Head-only CI,
missing or skipped contexts, abbreviated evidence, drafts, the configured
publication hold label (ignoring case), and project or Continue After holds
block the handoff. The owner also checks independent branch review, passing
scaling, and the publication policy on that exact revision.

Inspect the PR identity, revision pair, test commit, checks, and account in the
preview. To authorize queue admission, send the same request with `action` set
to `enqueue` and `confirm` set to the returned `planId`. The owner rechecks
the evidence and stack order, then asks GitHub's protected queue to admit the
PR with its expected head. GitHub checks the merge group against its live
target before landing. Its enqueue API accepts an expected head, and the
target tip is verified immediately before the request. Configure the required
workflows to run on the merge group. A branch without a protected queue
returns a manual handoff with the exact PR and revisions for the operator's
protected merge action. The Factory confirmation authorizes only queue admission.

Run `{"action":"reconcile","approvalId":"<approval UUID>"}` after a lost reply
or to check progress. Observations distinguish queued, merged, closed,
removed, and unknown. Factory records an intent before calling GitHub and
never replays an unknown request. A locally acknowledged admission followed
by a GitHub removal can be reset using `action: "reset"` and the attempt ID as
`confirm`. Reset invalidates older previews and requires a fresh confirmation.
Use `pause` or `cancel` to invalidate a preview before dispatch. `resume`
releases a pause. To reset a cancellation, confirm its returned reset ID.
Once a request may have reached GitHub, inspect or remove the entry there.
