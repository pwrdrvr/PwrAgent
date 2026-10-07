# Development tool resource policy

The repository's build, lint, typecheck, unit-test and desktop E2E scripts use
`scripts/resource-run.mjs`. Run these package scripts normally; the runner
selects a policy for the machine on every invocation. To inspect it:

```bash
node scripts/resource-run.mjs --policy
```

Effective RAM is the minimum of the host's total usable physical RAM, Node's
finite OS memory constraint and all finite limits in the visible Linux cgroup
hierarchy (v1 or v2, including ancestors). It measures capacity, not current
free RAM, and does not add swap. Container limits greater than host capacity
cannot increase effective RAM. Ancestors outside a container's cgroup
namespace cannot be read from inside that namespace.

Strictly below **16 GiB**, the runner:

- Replaces inherited Node old-space and percentage settings with **2048 MiB**.
  The full desktop TypeScript check and typed ESLint use **4096 MiB**: the desktop
  TypeScript program fails with a V8 heap exhaustion at 2048 MiB. Their original
  source coverage, configurations and diagnostics are preserved.
- Removes conflicting explicit Node CLI startup heap flags, including flags
  following eval/print expressions. Application arguments remain intact. Recursive pnpm workspace
  concurrency is one; Vitest file/worker/test concurrency and Playwright workers
  are one. Native desktop-main test isolation remains in separate forks.
- Queues heavy commands across all updated worktrees and PwrGit for the same
  OS user. A running build/check/test completes before the next starts.

At **16 GiB or above**, command arguments and environment are passed through
unchanged: no heap override, lock or concurrency reduction is applied.

The heap setting is V8's old-generation allowance. V8's total heap limit and
process RSS can exceed it. In particular, a 4096 MiB typed ESLint program can
use more than 4 GiB of resident memory; serial execution prevents it from
competing with another check. There is no blanket change to Electron runtime
memory, packaged application settings or larger-machine limits.

## Shared lease contract

PwrAgent and PwrGit use this same machine/user lane, independent of the
worktree, project, `TMPDIR` and current directory:

```text
homedir()/.cache/pwragent-tools-${sha256(homedir()).slice(0,16)}/heavy-tool
```

`proper-lockfile` owns the empty `heavy-tool.lock` directory with a 30-second
stale interval and a 5-second heartbeat. An atomic, private
`heavy-tool.owner.json` sidecar records `{pid,path,token,ownerStartedAt}` and the top-level
POSIX `groupPid` and `groupStartedAt` identity. It sits **outside** the lock directory so stale recovery can
remove that directory. `PWRAGENT_TOOL_RESOURCE_OWNER` passes `{pid,path,token}`
to nested scripts. Inheritance requires a matching token and path, a live PID,
an active lease and an actual owner in the process ancestry. Unrelated
processes cannot bypass the queue by copying the owner environment.

On POSIX, a gated Node bridge creates the process group; the owner records it
before permitting the tool to start. Nested wrappers inherit its ownership.
An optional `descendantGroups: [{pid,startedAt}]` ledger records escaped groups
whose ancestry or private capability proves ownership. A separate, fresh
`descendantToken` is persisted before launch and passed only to the bridge/tool
environment as `PWRAGENT_TOOL_DESCENDANT_TOKEN`. Exact capability matching plus
start identity finds orphans whose launcher exits before an observation;
copied public owner JSON alone grants no cleanup authority.

Cancellation snapshots ownership, signals escaped and primary groups, and
drains them before releasing the lease. Owner death disconnects the bridge,
which drains its descendants before exiting. Stale recovery drains recorded
groups and capability-tagged orphans before starting the next tool. Group start
identity prevents a reused PGID from targeting an
unrelated process. Owner start identity permits recovery when an unrelated
process reuses the crashed owner's PID. Legacy sidecars without that identity
still refuse recovery while their PID is live. A stale lease with a verified live owner fails rather than starting a second
command.

On constrained Windows, PowerShell creates a native Windows Job with
`KILL_ON_JOB_CLOSE`. The bridge enters the Job while suspended, then resumes;
its shell and native test descendants inherit Job ownership. Cancellation
requests `TerminateJobObject` and waits for no active members before release.
A native handle to the Node lease owner detects owner death without PID-reuse
ambiguity. Larger Windows machines retain the existing shell launch behavior.

Direct `pnpm exec`, `node`, `tsc` or `eslint` invocations do not automatically
enter the repository's lane. For an additional tool command use:

```bash
node scripts/resource-run.mjs <command> [arguments...]
```

The policy applies to repository scripts, not arbitrary commands launched
outside them or worktrees that have not received this change. Do not delete an
active lock to start another command. A crashed owner's stale lease recovers
automatically. Integration tests use private fixture leases and the same
public runner API; there is no production lock-bypass environment variable.
