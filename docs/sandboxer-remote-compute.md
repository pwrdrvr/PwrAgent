# Sandboxer remote compute

## Mode A — built-in compute connection

The agent and thread stay on this computer. Sandboxer supplies cloud Linux
compute. The built-in connection keeps ID `builtin:sandboxer`, role `compute`,
thread selection, tool approval, sandbox ownership and PR cleanup across both
connection methods. Existing custom connections named `sandboxer` remain
separate. `remote_agent` is a reserved role and is not executable.

### Hosted sign-in

A profile with no saved Sandboxer preferences defaults to Streamable HTTP at
`https://sandboxer.com/mcp`. Settings → Plugins offers **Connect Sandboxer**.
This signs into the third-party Sandboxer service in a browser, separately
from PwrAgent and coding-agent authentication. No CLI, npm package or API key
is required for this path, and it never probes `sbx`.

Hosted mode reuses the generic OAuth coordinator: protected-resource discovery,
dynamic public-client registration, PKCE S256, a state-checked loopback callback,
refresh and rejected-credential handling. Credentials are endpoint-bound to
`builtin:sandboxer` in the existing encrypted profile vault, never TOML. Cancel
abandons the pending callback, retry starts a new attempt, and Reauthorize can
replace credentials. Disconnect removes PwrAgent's local credentials; it does
not claim to revoke access in the Sandboxer account.

Signing in establishes authentication only. It does not establish machine
allowance, plan eligibility, storage availability or permission to purchase a
plan. PwrAgent does not purchase plans or modify account settings.

### Transport configuration and compatibility

`[mcp_connections].sandboxer_transport` accepts `hosted` or `local_cli`.
Settings exposes **Connection method**. A missing or malformed mode falls back
to local CLI when any recognized legacy Sandboxer preference exists; otherwise
it uses hosted. Reads do not migrate files. The first Sandboxer preference save
pins the resolved mode, so enabling a fresh hosted connection cannot change it
to local on the next read. Unrelated saves do not pin it.

This is an additive scalar, not a renamed or incompatible config shape. Existing
`sandboxer_enabled`, `sandboxer_select_for_new_threads`,
`sandboxer_tool_approval` and `sandboxer_cleanup_on_pr_close` scalars remain in
place for older clients, which continue to use their CLI integration. There is
no replaced key requiring a legacy marker or lossy dual-write projection.
Comments and unrelated config keys survive path-based writes.

An explicit method change abandons pending authorization, closes upstream
sessions and invalidates the tool catalog. It retains endpoint-bound hosted
credentials for a later switch back. Enabled and new-thread defaults remain
opt-in and are not changed by sign-in or a method change.

### Optional local CLI

Profiles with existing Sandboxer preferences retain local mode. It launches
`/usr/local/bin/sbx mcp --type small --ttl 1800 --no-update` and reads
`/usr/local/bin/sbx status --json --no-update`, with the existing bounded cache.
PwrAgent does not read CLI credential files or own the CLI's login. Local mode
preserves the limited inherited environment, including `SANDBOXER_API_KEY` for
headless users and endpoint/org overrides. The hosted path does not import
those overrides or keys. Sandboxer also documents API-key authorization for
headless HTTP clients; the interactive built-in flow uses browser OAuth.

Local status continues to distinguish missing CLI, missing login, account limits
and unavailable service. A billing problem does not hide running machines that
still need to be stopped. Refresh status retires sessions only when the account
or usable login changes. Local dashboard links use the CLI's signed dashboard
URL; hosted mode opens the fixed Sandboxer dashboard in the browser without
probing the CLI. Account summaries are stripped from peer and agent listings.

Each local thread session has its own process and last-used sandbox. After any
session reconnect, use explicit sandbox IDs. Closing a transport or thread does
not stop cloud compute. Agents should stop their sandboxes when finished and
set a finite TTL; a TTL is not a spending cap. Hosted defaults and capabilities
come from the authenticated server schema, not from local CLI launch flags.

### Selection, approval and cleanup

Both enabled and select-for-new-threads default to false. Approval defaults to
`approve`: selecting Sandboxer authorizes sandbox tools in Default and Auto,
including shell commands, file writes and lifecycle operations. Explicit
`prompt` or `auto` settings retain their meaning. Full Access never asks.
The upstream annotations and per-tool schema checks remain unchanged.

The gateway discovers the server's current tool catalog dynamically; it does
not assume a tool count or translate schemas between local and hosted servers.
Only the built-in Sandboxer connection forwards its capped server instructions.
A custom remote connection cannot gain this trust by choosing the same name.

The owner records successful `create_sandbox` results against the calling
thread in `thread_sandboxes`, one SQLite commit per created sandbox. An exact
recorded ID is the only cleanup target. No cleanup discovers or adopts existing
account resources. Once all attached PRs merge or close, cleanup uses
`delete_sandbox` when listed, otherwise `stop_sandbox` and a pending-deletion
record. It never uses labels or the upstream session's implicit last sandbox
as the cleanup target. Existing ownership records survive connection changes.

The **Clean up when PRs close** switch remains on by default. A disabled or
unauthenticated connection or a service failure leaves cleanup pending and
reports the result. A thread with no attached PR is not cleaned up. Closing a
thread alone does not trigger cleanup. Cleanup uses the same owner-broker and
connection routing as agent calls.

### Contributor verification

Use deterministic fixtures for callback/token exchange, refresh, cancellation,
rejected credentials, routing and local compatibility. Never use an operator
profile or real CLI login in a unit test. The hosted integration fixture mocks
remote HTTP and uses the actual coordinator, vault and HTTP MCP transport.
Live sign-in requires the operator to complete consent. Public metadata or an
open consent page does not prove callback success, credential storage,
authenticated tools, refresh or account-side revocation.

For cloud verification, follow the Sandboxer verification skill and inspect the
selected `create_sandbox` schema first. Require `noEnv: true`; do not create via
an older schema that cannot suppress account environment inheritance. Report
that blocker and wait for an authorized alternative. Inspect quota before
creating an owned fixture and clean up only its exact ID. Do not clear existing
resources to make room.

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
