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
- Source citations are from the `codex` checkout at `2a30972fcb` (2026-08-18),
  i.e. current `main`. The repo is on `0.148.0-alpha.22` while the tested
  binary is `0.145.0`, so **the source is ahead of the binary under test**.
  Claims about the installed CLI are measured; claims about `main` are read.
  Where they disagree, both are reported rather than reconciled.

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

Controlled test over three runs, one hook script switching on an env var so
only the `permissionDecision` field varies. The hook logs each invocation, so
"fired" rules out the hook silently not running:

| `hookSpecificOutput` | Hook fired | Rewrite applied? |
|---|---|---|
| `updatedInput` only | 2 | **No** |
| `permissionDecision: "ask"` + `updatedInput` | 2 | **No** |
| `permissionDecision: "allow"` + `updatedInput` | 2 | **Yes** |

**The source does not explain this, and staleness is not the reason.** Every
layer that touches `updated_input` — at current `main` *and* at the matching
`rust-v0.145.0-alpha.18` tag — assigns it whenever the hook does not block,
with no gate on the decision:

- `codex-rs/hooks/src/events/pre_tool_use.rs` sets
  `updated_input = parsed.updated_input` inside `if !should_block`.
- `codex-rs/core/src/hook_runtime.rs` returns
  `PreToolUseHookResult::Continue { updated_input }` unconditionally on the
  non-blocking path.
- `codex-rs/core/src/tools/registry.rs` applies it via
  `with_updated_hook_input` whenever it is `Some`.
- The wire schema marks every field `Option`, so `updatedInput` alone parses.

So either the installed `codex-cli 0.145.0` is not built from
`rust-v0.145.0-alpha.18`, or the decision is enforced somewhere not found by
reading. **The mechanism is unattributed.** Settling it requires building the
exact binary, and settling whether current `main` still behaves this way
requires building `main`. Neither was done.

RTK's Claude Code hook relies on `updatedInput` without a decision for its
"ask" path (`hooks/claude/rtk-rewrite.sh`), so the behavior measured here is
not the general hook contract.

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

---

# Part 2 — where interception can actually happen in Codex

Recorded after the findings above ruled out a hook-only design. The question
became whether to patch Codex, add an App Server filtering feature, or extend
Codex hooks to Claude-hook parity. Reading the code-mode implementation shows
those three are not the choices they appear to be.

Source citations are from current `main` (`2a30972fcb`, 2026-08-18). Nothing
in this section was measured against a running build. Notably
`PostToolUseFeedbackOutput::code_mode_result` still returns
`self.original` at that commit, so the premise of this whole record is current
upstream behavior and not an artifact of an old tree.

## The nested-tool boundary is not the context path

`call_nested_tool` ends with `Ok(result.code_mode_result())`
(`codex-rs/core/src/tools/code_mode/mod.rs`). That `JsonValue` is returned
**into the running script**, not into the model context. The script decides
what to do with it — grep it, parse it, count it, discard it.

What the model actually sees is what the script yields or returns:
`handle_runtime_response` converts `RuntimeResponse::{Yielded, Terminated,
Result}` into `content_items` and passes them through
`truncate_code_mode_result(items, max_output_tokens)`.

This recasts `PostToolUseFeedbackOutput::code_mode_result` returning
`self.original`. It is defensible as intentional rather than an oversight: hook
feedback shapes model-visible prose, and a script is a program that should
receive real data. A patched Codex that let the hook suppress the original
*at that point* would hand summaries to scripts doing programmatic
post-processing, and break them silently.

## The reduction seam already exists, one layer up

`truncate_code_mode_result` is exactly the script-to-model boundary, and it
already applies a token-budgeted reduction. It is simply a dumb truncation:

```rust
let max_output_tokens = resolve_max_tokens(max_output_tokens);
let policy = TruncationPolicy::Tokens(max_output_tokens);
```

Two consequences:

- This is the natural insertion point for a summarizing pass. Replacing
  truncation with a Luna-class reduction preserves the script contract while
  changing only what enters context — which is the whole objective.
- The budget is **model-chosen, not operator-controlled**. It arrives as
  `args.max_output_tokens` on the code-mode execute call
  (`execute_handler.rs`) and as `args.max_tokens` on wait
  (`wait_handler.rs`), falling back to `DEFAULT_MAX_OUTPUT_TOKENS`. There is
  no operator lever over code-mode output volume today.

## The App Server is not in the model's context path

`codex-app-server` links `codex-core` and `codex-code-mode` in-process, but it
is a JSON-RPC surface that drives and observes sessions. The tool-output to
context flow does not route through it.

So "filter output in the App Server" cannot be built as an App Server feature
alone. It requires a core interception point that calls back out to the client
over the protocol. That collapses the App Server option and the extend-hooks
option into the same change: a new core seam plus a transport. The only real
question left is whether the reducer runs in-process or out.

An in-process reducer avoids the transport question entirely — and with it the
sandbox, socket-path, and approval findings from Part 1, none of which apply to
code running inside Codex.

## The extension API exists but is deliberately observe-only for tools

`codex-rs/ext/extension-api` exposes a contributor registry, and `codex-rs/ext`
ships thirteen extensions. `ToolLifecycleContributor` is explicit about its
scope:

> Implementations should use these callbacks to observe tool execution and its
> exposed input without rewriting the invocation. Use `ToolContributor` for
> owning a tool implementation and hooks for policy that changes tool payloads.

`TurnItemContributor` *can* mutate, but it mutates emitted `TurnItem`s through
`finalize_non_tool_response_item` — the display and rollout representation, not
the model input.

So no existing extension seam does what Token Miser needs. `guardian-v2` is the
closest precedent worth studying: it samples the transcript, runs a model over
it, and can claim approval decisions. It establishes that "an extension runs a
model over session data" is a sanctioned pattern — it just acts on approvals
rather than on output.

## Unverified: whether code mode observes output as it streams

The premise that code mode needs live output to detect a hung or looping
command is plausible but was not confirmed. What the code shows is that nested
calls are awaited and return a complete `JsonValue`, and that
`RuntimeResponse::Yielded` carries a `cell_id` so a script can yield and be
resumed. No streaming path into the running script was found. This should be
settled before it is used to justify a design, because it is the main argument
for a streaming filter over a terminal one.

## Cost note on forking

PwrAgent drives the operator's installed Codex. Shipping a patched build adds
a rebase burden against a fast-moving upstream, plus signing, notarization, and
update surface.

The rebase burden is real but should be sized honestly rather than asserted:
upstream `main` moves at roughly a commit every few minutes, and the seam this
would patch (`truncate_code_mode_result`) is small and stable. The sharper risk
is behavioral rather than textual — Part 1 measured a hook behavior that no
layer of the source explains, which means a fork can be textually clean and
still wrong about what the binary does.

## Direction this points to

The smallest change that solves the stated problem is at
`truncate_code_mode_result`: make the code-mode reduction pluggable rather than
a fixed truncation, and let the host rather than the model bound the budget.
That is a contained, principled change, it is where a fork would patch anyway,
and it is plausible as an upstream contribution.

## Open questions

- Does code mode observe streamed output, or only completed results?
- Is a terminal reduction at the script-to-model boundary sufficient, or is
  the runaway-output case only addressable mid-stream?
- Upstream contribution or maintained fork?

---

# Part 3 — decision

Operator decision, 2026-08-18. Resolves the open questions above.

## Chosen design

A reduction seam at `truncate_code_mode_result`, with an optional external
reducer that Codex calls **from the Codex process**, not from a sandboxed
child. PwrAgent holds the full output and serves it through the retrieval tools
that already exist on the Token Miser branch. The replacement text is produced
by an ephemeral gpt-5.6-luna thread with no skills, MCP servers, or tools — a
dumb rewriter, shaped like the existing thread-naming ephemerals.

Delivered as a PwrDrvr fork of Codex with signed Windows and macOS builds,
reusing the agent-kit discovery and download mechanism, and likely bundled with
PwrAgent installers as the default runtime.

## Why this closes Part 1

Every constraint in Part 1 applied to a callout originating inside the Codex
sandbox. The Codex process is not sandboxed — it is the process that spawns the
`sandbox-exec` and landlock children. Moving the callout into core therefore
retires all of it: the loopback `EPERM` result, the
`network.allow_unix_sockets` allowlist, the 104-byte `sun_path` limit, the hook
trust flow, and the `permissionDecision` approval escalation. The existing
loopback bridge works unchanged.

Part 1 is retained as the record of why those paths were rejected, not as
outstanding work.

## Resolved

- **Approval policy.** Moot. No hook rewrites a command, so nothing
  auto-approves anything.
- **`[network]` side effects.** Moot. No unix socket, no network config.
- **Nested code-mode `updatedInput` behavior.** Moot for this design.
- **App Server vs. extend-hooks.** Neither. A core seam with an out-of-process
  reducer, which is what both options reduced to.

## Still open

- **Streaming.** This is a terminal reduction at the script-to-model boundary.
  It does not detect a hung or runaway command mid-stream.
  `RuntimeResponse::Yielded` means long scripts pass intermediate results
  through the seam, which partially covers the case. Not claimed as solved.
- **Upstream or fork.** Worth attempting the upstream PR in parallel. The seam
  replaces an existing dumb truncation rather than adding a new interception
  point, which is the strongest version of that argument. If it lands, the fork
  thins to near nothing.
- **Bundling.** Shipping a forked Codex as the default changes what "works with
  your Codex" means, including version skew against an operator's own install.
  Tracked separately from the feature.

## Carried constraint: the summary lands in the parent's context

The ephemeral rewriter has no tools, so an injected rewriter cannot act. But its
output is inserted as tool output into the parent model's context, and the
parent does have tools. Isolation protects the rewriter, not the parent.
Hostile file content can therefore propagate through the summarizer as text
aimed at the parent.

The replacement must be framed as untrusted data, and must never carry content
shaped like an instruction to the parent. This is the one Part 1-era security
concern that the new design does not retire.

## Also worth fixing in the same change

`max_output_tokens` arrives from the model on the code-mode call
(`execute_handler.rs`, `wait_handler.rs`) with no host or operator ceiling. A
model can request a budget large enough to make the gate pointless. The seam
should clamp it host-side.

## Lesson to carry into the fork

Part 1 measured a hook behavior that no layer of the source explains, at
current `main` or at the matching release tag. A fork can be textually clean and
still wrong about what the shipped binary does, so the fork needs behavioral
smoke tests rather than a green build.
