# Token Miser code-mode gate: transport and approval findings

Status: Verified findings recorded; design decision pending

Stacked on the Token Miser branch (PR #1733). This record exists because the
originally sketched design — rewrite the command in `PreToolUse` to a wrapper
that calls the desktop bridge — does not survive contact with the shipped
Codex CLI. The measurements below are the decision input.

## Why a code-mode gate is needed at all

`PostToolUse` cannot replace a code-mode tool result.
`PostToolUseFeedbackOutput::code_mode_result` returns `self.original`
(`codex-rs/core/src/tools/registry.rs`). The struct replaces
`to_response_item` but delegates `code_mode_result` to the unmodified original,
so the gate's summary reaches the transcript as a developer message while the
parent model still reads the full original payload.

Every production gate observed to date has been exec-shaped and inert for this
reason: the rollout shows the developer message *and* the full original at each
gate.

## Verification environment

- `codex-cli 0.145.0` (Homebrew), macOS 15.6 (Darwin 25.6.0).
- Isolated `CODEX_HOME`, `codex exec`, `gpt-5.6-sol`.
- Source citations are from the `codex` checkout at `1b81365926` (2026-06-15).
  That checkout is **older than the installed CLI**; where source and observed
  behavior disagree, the observed behavior is authoritative and is called out.

## Finding 1 — command rewriting is inseparable from auto-approval

`PreToolUse` receives the payload the design assumed:

```json
{"tool_name":"Bash","tool_input":{"command":"echo HELLO_FROM_CODEX"},
 "permission_mode":"bypassPermissions","model":"gpt-5.6-sol",
 "hook_event_name":"PreToolUse"}
```

Full key set: `cwd`, `hook_event_name`, `model`, `permission_mode`,
`session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`,
`turn_id`.

Controlled A/B/A over three runs, varying only `permissionDecision`:

| `hookSpecificOutput` | Rewrite applied? |
|---|---|
| `updatedInput` only | **No** |
| `permissionDecision: "ask"` + `updatedInput` | **No** |
| `permissionDecision: "allow"` + `updatedInput` | **Yes** |

This contradicts the checkout source, where `updated_input` is assigned
whenever the hook does not block
(`codex-rs/hooks/src/events/pre_tool_use.rs`). The shipped CLI requires the
`allow` decision. RTK's Claude Code hook relies on the documented
`updatedInput`-without-decision behavior for its "ask" path
(`hooks/claude/rtk-rewrite.sh`), so this is a Codex-specific divergence, not a
general hook contract.

**Consequence.** A Token Miser `PreToolUse` rewrite auto-approves every command
it wraps. Wrapping unconditionally would silently escalate tool calls past the
operator's approval policy. That is a larger regression than the token waste
the feature exists to prevent, and it is not acceptable as a default.

The payload carries `permission_mode`, so the hook *can* restrict rewriting to
calls that were already going to be auto-approved. That keeps the approval
policy intact at the cost of leaving the gate inactive in stricter modes.

## Finding 2 — the current loopback bridge is unreachable from the sandbox

The rewritten command runs inside the Codex sandbox. Tested against Codex's
real base Seatbelt policy (`seatbelt_base_policy.sbpl`, which opens with
`(deny default)`) plus full read and `/private/tmp` write:

| Transport | Base policy | Base + unix-socket allowlist |
|---|---|---|
| TCP to `127.0.0.1:<port>` | `EPERM` | `EPERM` |
| `AF_UNIX` connect | `EPERM` | **connects, round-trips** |

The Token Miser bridge is HTTP over `127.0.0.1`
(`token-miser-hook-bridge.ts`). A rewritten in-sandbox command cannot reach it
in any mode except full access. This is exactly the failure the operator
flagged as unacceptable.

## Finding 3 — unix domain sockets are viable, with conditions

The working allowlist clauses are the ones Codex generates from
`network.allow_unix_sockets` (`codex-rs/sandboxing/src/seatbelt.rs`):

```
(allow system-socket (socket-domain AF_UNIX))
(allow network-bind (local unix-socket (subpath (param "UNIX_SOCKET_PATH_0"))))
(allow network-outbound (remote unix-socket (subpath (param "UNIX_SOCKET_PATH_0"))))
```

Conditions and caveats:

- **macOS needs the config.** Without `network.allow_unix_sockets`, `AF_UNIX`
  is denied by `(deny default)`. The allowlist is path-scoped via `subpath`,
  so the hole can be narrowed to one PwrAgent-owned directory.
- **Setting `[network]` has a side effect.** `proxy_policy_inputs` only reads
  `allow_unix_sockets` when a `NetworkProxy` is present, and
  `enforce_managed_network = network.is_some()` (`codex-rs/core/src/exec.rs`)
  switches the session to the restricted network policy. Whether that is
  acceptable, and whether it still holds on the shipped build, is unverified.
- **`sun_path` is 104 bytes on macOS.** A socket under the scratch path used
  during testing failed with `EINVAL` before any sandbox was involved.
  `~/.pwragent/profiles/<name>/state/token-miser/gate.sock` is roughly 70
  bytes for a short username and default profile, and a long username or
  profile name will exceed the limit. The socket must live at a short path.
- **Linux does not need the config.** The seccomp filter explicitly permits
  `socket(AF_UNIX)` in the default sandbox mode and denies other domains
  (`codex-rs/linux-sandbox/src/landlock.rs`). Pathname sockets are unaffected
  by `--unshare-net` under the bwrap backend.
- **Windows is unverified.**

## Finding 4 — PwrAgent can approve its own hook

Hook trust is persisted in the Codex `config.toml`:

```toml
[hooks.state."pwragent-token-miser@pwragent-local-default:hooks/hooks.json:post_tool_use:0:0"]
trusted_hash = "sha256:..."
```

- The key is `<key_source>:<event_label>:<group_index>:<handler_index>`
  (`codex-rs/hooks/src/lib.rs`, `hook_key`).
- `current_hash` hashes a normalized, config-derived identity rather than
  source text (`command_hook_hash` in `engine/discovery.rs`), so PwrAgent must
  read the hash rather than compute it independently.
- `hooks/list` returns `key`, `current_hash`, and `trust_status` per hook.
- The Codex TUI writes trust through the app server, not the CLI:
  `ClientRequest::ConfigBatchWrite` with `key_path: "hooks.state"`,
  `merge_strategy: Upsert`, `reload_user_config: true`
  (`codex-rs/tui/src/hooks_rpc.rs`, `write_hook_trusts`).

PwrAgent already speaks the app-server protocol, so it can make the same call.
The operator does not need to run the Codex CLI, and PwrAgent does not need to
hand-edit Codex-owned TOML — `config/batchWrite` is the supported entry point.
This should still be an explicit offer with the exact hook definition shown,
not a silent write.

An unrelated trap found while testing: the `bypass_hook_trust` config key did
not take effect on 0.145.0. Only the `--dangerously-bypass-hook-trust` flag
did. The product will not use either.

## What the reference implementations do

- **RTK** (`/Users/huntharo/github/rtk`) rewrites `cmd` to `rtk <cmd>` in a
  `PreToolUse` hook. `rtk` is a self-contained binary that runs the command and
  compresses the output locally and deterministically. There is no bridge and
  no host round-trip, so there is nothing for a sandbox to block. Its Codex
  integration is prompt-level guidance in `AGENTS.md` only — no programmatic
  hook (`hooks/codex/README.md`).
- **Headroom** (`/Users/huntharo/github/headroom`) compresses at the model API
  boundary via a proxy. Its Codex plugin hooks only ensure the runtime is
  installed; they do not rewrite or replace anything.

Neither project solves in-sandbox IPC, because neither needs it.

## Design implication

The wrapper does not need a synchronous round-trip. A wrapper that reduces
output deterministically and spills the full text to a file needs no network,
no sandbox hole, and no per-call latency budget — and the
`DEFAULT_EXEC_COMMAND_TIMEOUT_MS = 10_000` bound stops being a design
constraint. Model summarization then happens out of band, and the existing
Token Miser search / bounded-read / full-read tools already cover retrieval.

Unix domain sockets remain a viable upgrade for a synchronous tier, on macOS
at the cost of a path-scoped `network.allow_unix_sockets` entry.

Finding 1 constrains every variant equally: no rewrite happens at all without
`permissionDecision: "allow"`.

## Open questions

- Does the gate restrict itself to calls whose `permission_mode` already
  implies auto-approval, or is auto-approval of gated calls acceptable when the
  operator has enabled Token Miser explicitly?
- Does setting `[network]` for `allow_unix_sockets` force the restricted
  network policy on the shipped build, and is that acceptable?
- Does `updatedInput` behave the same for nested code-mode `shell_command`
  calls as for the classic `exec` tool? The runs above exercised the classic
  path; code mode was enabled but the model did not enter it.
- Windows transport and sandbox behavior.

## Reproduction

The measurements above come from an isolated `CODEX_HOME` with a `PreToolUse`
command hook that logs its stdin payload and emits a rewrite, driven by
`codex exec --dangerously-bypass-hook-trust`, plus `sandbox-exec` runs against
Codex's real base Seatbelt policy for the transport table.
