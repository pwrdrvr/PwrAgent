# Sandboxer remote compute

## Mode A — shipped integration

The agent and thread stay on the laptop. Sandboxer supplies extra Linux CPU and
memory for builds, tests, and other compute. It is a synthesized built-in MCP
connection alongside PwrSnap and PwrGit, not a stored URL or a federation peer.
Its ID is `builtin:sandboxer`: the colon is outside the custom ID grammar, so
existing custom `sandboxer` connections retain their configuration, credentials,
and thread selections without migration.
Its domain role is `compute`; the shared `SandboxerRole` also reserves
`remote_agent` for later work. Nothing accepts that role as an executable mode.

The operator enables Sandboxer in Settings → Plugins → MCPs, then selects it
in a thread's MCP access. Both enabled and select-for-new-threads default to
false. Profile TOML scalars `sandboxer_enabled`,
`sandboxer_select_for_new_threads`, `sandboxer_tool_approval`, and
`sandboxer_cleanup_on_pr_close` (default true) live under
`[mcp_connections]`. No SQLite persistence is added.

The built-in connection defaults `sandboxer_tool_approval` to `approve`.
Enabling and selecting sandbox compute authorizes its tools, including shell
commands and file writes, in Default and Auto access. An explicitly configured
`auto` or `prompt` policy overrides that default. The default is stored as an
absent scalar; `prompt` is stored explicitly. The upstream annotations remain
unchanged: approval policy recognizes the authorized sandbox environment
instead of rewriting tool metadata to describe commands as read-only.

The gateway launches only `/usr/local/bin/sbx mcp --type small --ttl 1800
--no-update`, through the MCP SDK's stdio transport. This absolute path avoids
Docker's unrelated `sbx`. The initial integration expects the official CLI at
that path; it does not search PATH or accept arbitrary commands. Status comes
from `/usr/local/bin/sbx status --json --no-update`, with an eight-second limit
and a short in-memory cache. Missing CLI, missing login, and unavailable status
have distinct remedies in Settings; Refresh status bypasses the cache. While
setup is unfinished, Settings also refreshes when its window regains focus,
because the remedy runs in a terminal.

Signed in is not the same as ready. The status's `plan.canStart: false` gets
a chip that names the reason: `No plan` (no plan, or a zero-dollar one),
`Billing issue` (a `billingStatus` other than `active` or `trialing`), `Out of
credit` (`creditBalanceHours` at zero), or `Can't start` for a reason the
status does not name. No plan keeps Sandboxer out of threads, since no sandbox
can exist yet. The other three stop new machines, not running ones, so threads
keep reaching Sandboxer to list and stop what is still running and billing.
Refresh status retires live `sbx mcp` sessions only when the signed-in account
changed or the login is no longer usable. Only `active` has been
observed; the other values are inferred. A status without `plan` comes from an
older CLI and counts as able to start. Settings shows the account the login
bills (`user.email`, the plan's monthly price, credit hours left). Federation
strips that account from the connection list it serves to peers, and the
`manage_mcp_connections` agent tool never returns it.
New-thread defaults read the last cached status without waiting for the CLI,
including through the profile owner broker. If enabled, Sandboxer refreshes in
the background. A cold cache skips only Sandboxer's default until its login is
known; unrelated defaults are never held up by the CLI's eight-second probe.

Sandboxer owns its local login. Settings copies `/usr/local/bin/sbx onboard`
for the operator to run in a terminal: it signs in an existing account or
creates one, then asks only for what the account still lacks, such as the plan
checkout. `sbx login` only signs in, so a new account would reach "Signed in"
and still fail its first create. PwrAgent runs neither command. PwrAgent neither
reads its credential file nor stores OAuth tokens for it. `SANDBOXER_API_KEY`
is an inherited fallback for headless/CI use. Status and MCP inherit the same
limited environment, including Sandboxer's endpoint/org overrides. The URL
connection form still rejects command lines, and offers to add them as a local
command instead; see [mcp-stdio-connections.md](mcp-stdio-connections.md).

Each thread gateway session owns a separate `sbx mcp` process. This matters:
Sandboxer's omitted `sandboxId` means the last sandbox that process used.
Settings discovery gets a separate, temporary session. Revocation, disabling,
gateway shutdown, and failed initialization close the transport and process.
Closing a local process does **not** stop a remote sandbox. Agents must use
`stop_sandbox` when finished; the finite creation TTL is a fallback. After a
local session restarts, use an explicit sandbox ID from `list_sandboxes`.

### Cleanup when a thread's PRs close

PwrAgent releases the sandboxes a thread created once every PR attached to
that thread has merged or closed. The owner gateway records each successful
`create_sandbox` result against the calling thread in the profile's
`thread_sandboxes` table (one commit per sandbox). That is the only source of
ids it will touch: a sandbox created outside PwrAgent, or by another thread,
is never released.

- **When.** On the first observation of a terminal PR, for each local thread
  it is attached to, and again at startup for threads still holding a
  sandbox. A thread with several PRs waits until all are merged or closed;
  a thread with no attached PR is never cleaned up. Detached PRs do not count.
- **How.** Only through the connection's MCP tools, over the same
  owner-broker path as an agent's call, so a hosted endpoint works the same as
  the local `sbx mcp` process. The capability comes from the tool list: it
  calls `delete_sandbox` when the connection lists it, otherwise
  `stop_sandbox`, which ends compute billing but keeps the snapshot, and marks
  deletion pending. A later cleanup deletes a stopped sandbox once
  `delete_sandbox` appears. "Not found" counts as already deleted.
- **Failures.** A missing CLI, a signed-out account, a disabled connection, or
  a network error leaves the sandbox in place and reports it. Cleanup never
  blocks a merge/close wake; the wake waits up to 30 seconds for the result.
- **Where it shows.** Each outcome is a `cleanup` row in PR activity and a
  `sandboxer cleanup` line in the main log, and a merge/close wake lists it
  for the thread.
- **Switch.** Settings → Plugins → MCPs → Sandboxer → **Clean up when PRs
  close**, `sandboxer_cleanup_on_pr_close`, on by default: it only acts on the
  thread's own sandboxes after its PRs are done, and stopped machines and
  their snapshots otherwise keep billing compute and storage. A reopened PR
  can resume a stopped sandbox; a deleted one cannot come back.

Settings links to Sandboxer's own pages (home, pricing, quickstart, and the MCP,
machines, and billing docs) through main, which maps each to a fixed
`https://sandboxer.com` URL. Open dashboard and Open billing run
`sbx dashboard --no-open --json --no-update` and open the one-time signed-in
link it prints only when its origin is exactly `https://sandboxer.com`.
Federation windows cannot open them. Until the CLI is found, the row is one
line with Learn more and Set up, so operators who never use Sandboxer are not
shown a setup ladder.

The New thread launchpad advertises Sandboxer with a tile beside PwrGit and
PwrSnap, using Sandboxer's own site icon (see
`apps/desktop/src/renderer/src/assets/sandboxer/README.md`). While the CLI is
missing, the tile shows what Sandboxer is, with Get Sandboxer opening the
quickstart and the Info and site buttons explaining and linking the service.
Sign-in, a plan, and offering it to threads are finished in Settings, so those
states show Set up, which opens Settings → Plugins. Once Sandboxer is signed in
and offered, the tile is the thread's Use in thread switch; a billing problem
keeps the switch so a thread can still stop running sandboxes. Its About
note follows Clean up when PRs close. The tile reads status from the
connection list, so it never retires live sessions. It asks for a Sandboxer
answer no older than two seconds (main refuses anything fresher than one), so
a window coming back from `sbx onboard` in a terminal shows the new login. It
reads on mount, on window focus, after a failed read, and when main announces
a Sandboxer change. A remote thread shows no tile: its tools run on the owner,
whose CLI this window cannot see.

Main announces MCP connection changes on `mcp-connections:changed` to this
instance's local windows: every successful mutation (whether this instance
owns the connections or forwards to the owner broker), and each `sbx status`
answer that differs from the last. The event carries connection ids only.
The launchpad tile and Settings → Plugins re-read the list when they hear it,
so a setting changed in Settings or a connection an agent added shows without
a refresh. A change made from another PwrAgent instance on the profile is not
announced; focus reads cover it. Nothing is persisted.

The existing `search_mcp_tools` / `call_mcp_tool` path carries the official
server's eight tools: create, list, exec, read/write files, host a port, stop,
and resume. Search results that include a Sandboxer tool also carry
Sandboxer's `initialize` instructions once, capped at 2,000 characters; they
tell the agent to stop each sandbox when it is done. Other servers'
instructions are not forwarded: they would be untrusted text. No Sandboxer REST client or agent harness is
implemented here.
The default size is small (2 vCPU / 4 GB), never xlarge. Agents may explicitly
pass `type` and `ttlSeconds`, including overriding auto-stop; the TTL is a
default, not a spending cap. Other sizes are default (4 / 8 GB), large
(8 / 16 GB), and xlarge (16 / 32 GB, requiring the $100 plan).

Inspection of installed build `1d1ae54` on 2026-10-23 used initialize and
tools/list only. All tools advertise `openWorldHint: true`. Only list and read
advertise `readOnlyHint: true`; exec and write also advertise
`destructiveHint: true`. Create is non-read-only and non-destructive.
These annotations already cause side effects to ask under Auto. Sandboxer
nevertheless defaults to **Prompt** for every tool because creating/resuming
compute starts per-second billing. Other connections keep their defaults.
Default and Auto threads honor this setting; Full Access never asks.
Automations retain their existing approval policy.

MCP exec waits at most 600 seconds; longer work should use background commands
or systemd within the sandbox. Stop/resume preserves memory. A resize resume
cold-boots, so enabled systemd services are needed for that case.

## Mode B — not shipped

The future target is a remote PwrAgent runtime with its own Codex on a
Sandboxer microVM, continuing after the laptop sleeps and pausing when idle.
[Amp orbs](https://ampcode.com/docs/orbs), including `amp -ox` and
`amp sync <thread>`, are the product reference; Sandboxer's `sbx prompt` is a
separate integrated-agent convenience, not headless PwrAgent.

The laptop originates the session to the sandbox; the sandbox does not dial
home through Cloudflare Access; reverse SSH does not survive the laptop being
off; the later SaaS federation transport replaces the dial without rewriting
Mode A.

A future adapter can dial `sbx ssh <id> --stdio` (authenticated WebSocket over
outbound HTTPS), or reach a sandbox federation WebSocket through
`sbx forward --remote`. `sbx forward --reverse` depends on the laptop being
online and cannot provide disconnected operation. Current federation has a
gateway listener and connecting clients, as described in
[the architecture](federation-architecture.md) and
[connectivity reference](federation-connectivity-reference.md). A later SaaS
login/transport is expected to replace today's invites, Cloudflare Access,
and Tailscale dependencies.

This change performs no federation enrollment, creates no connected instance,
installs no Tailscale, splits no Electron main process, runs no `sbx prompt`,
and migrates no threads. There is no remote-agent Settings control.

## Sources and validation

Official [MCP](https://sandboxer.com/docs/mcp.md),
[machines](https://sandboxer.com/docs/machines.md),
[SSH](https://sandboxer.com/docs/ssh.md),
[long-running work](https://sandboxer.com/docs/long-running.md),
[CLI](https://sandboxer.com/docs/cli.md), and
[agents](https://sandboxer.com/docs/agents.md) documentation informed the seam.
Installed CLI behavior takes precedence. Unit tests mock the CLI and use an
in-memory MCP server; development and validation create no real sandboxes.
