# Capturing Agent Protocol Traffic

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Capturing ACP Protocol Transcripts

`scripts/capture-acp-transcript.mjs` drives a real ACP agent over stdio the
way `AcpAgentClient` does — same `initialize` params, `session/new`, one
`session/prompt` — and writes every JSON-RPC frame in both directions to
stdout:

```bash
node apps/desktop/scripts/capture-acp-transcript.mjs \
  --cmd ~/.kimi-code/bin/kimi --args acp \
  --cwd /tmp/acp-scratch \
  --prompt "tell me your favorite breakfast cereal" > capture.json
```

Flags: `--cmd` (required), `--args` (comma-separated), `--cwd`, `--prompt`,
`--quiet-ms` (drain window after the prompt resolves), `--timeout-ms`,
`--allow-tools`. Exit code is 0 only on a completed capture. For helper
sessions: `--session-meta <json>` (the `_meta` of `session/new`, such as a
Grok agent profile), `--config model=<id>,reasoning_effort=<level>`
(`session/set_config_option` writes before the prompt), `--mode <id>,<id>`
(`session/set_mode` writes after those; a refusal is recorded, not fatal),
`--deny-cancelled`
(answer permission requests `cancelled`, as a `deny-all` session does),
`--after session/close,_x.ai/session/delete` (methods called with
`{ sessionId }` after the answer), and `--list-sessions` (`session/list` for
the cwd, last).

Grok 1.0.44 findings those flags established, which a helper must respect:
`tools: []` in an agent profile means the default toolset; the MCP meta-tools
`search_tool` and `use_tool` survive an allowlist and reach the operator's own
Grok MCP servers; read-only tools run without a permission request in every
mode; and a closed session stays listed until `_x.ai/session/delete`. See
`src/main/acp/minimal-helper-session.ts`.

An open ACP session keeps its MCP servers running until `session/close`.
On Grok 1.0.45-pwragent.2, `session/new` started a session's stdio MCP
server, `session/close` stopped it, and `session/load` started it again.
`AcpAgentClient.closeIdleSessions` therefore closes a session after 10
minutes without a request, update or permission request, and every session
request reloads a closed session first. A helper session created with an
agent profile in `_meta` or with no MCP servers stays open, because
`session/load` cannot recreate either.

Reach for this whenever a question about an agent's wire behavior would
otherwise be answered by reading its source or guessing. **The committed
`__tests__/fixtures/acp-transcripts/*-build.json` fixtures cannot answer
turn-end questions** — they are normalizer-parity captures containing no
completed turn, so grepping them for usage, stop reasons, or totals returns a
confident wrong answer. That mistake is why
`kimi-code-0-31-cereal.json` exists: a full captured turn establishing that
Kimi Code 0.31.1 puts no token usage on the ACP wire.

Two things to know before running it:

- **Permission requests are denied by default.** Pass `--allow-tools` only
  when tool traffic is the point, and point `--cwd` somewhere disposable when
  you do — the harness answers on your behalf and the agent acts for real.
- **Output is raw protocol.** The operator home directory and the capture cwd
  are rewritten, but an agent can echo anything it read into a transcript.
  Read a capture before committing it as a fixture.

### ACP Job Monitor catalog refresh

The November 22, 2026 macOS 27.2.1 probes connected real ACP binaries to
PwrAgent's `AgentToolMcpServer` over loopback HTTP. A proxy recorded the ACP
requests and MCP `tools/list` replies and `tools/call` requests. The MCP
tools were contrived and started no Job Monitors. Grok used a deterministic
local model endpoint that selected tools through Grok's search and call
interface. Antigravity used its normal inference path with
`acp --process-per-session`.

| Build | List and use after close/load | Work on a second session |
| --- | --- | --- |
| Antigravity 1.5.14 | Both new lists arrived before the corresponding prompt. The agent used the remaining tool while creation was off and the restored tool after turning it back on. | A held MCP call completed after both parent reloads. |
| Grok 1.0.45-pwragent.2 | Same result, through Grok's tool search. | A held MCP call completed after both parent reloads. |
| Grok 1.0.77 | Same result, through Grok's tool search. | A held MCP call completed after both parent reloads. |
| Kimi 2.1.0 | Advertised HTTP, close, and load. The isolated profile required authentication at `session/new`. | Unverified. |
| Qwen 0.26.1 | Advertised HTTP and load. Its initialize response omitted close. | Unverified. |

For each successful sequence, the server first advertised
`create_monitor_delegation` and the agent called it. The driver then changed
the list, closed and loaded the same ACP session ID, and waited for the load
response before sending the next prompt. The same session passed a marker from
the first prompt to the remaining tool without receiving the marker again.
The driver restored creation through a second close/load and observed a
second creation-tool call. The held MCP call stayed on a separate session
throughout, as PwrAgent Job Monitors do.

Repeat probes for all three builds used a fresh HTTP URL scope and signed
MCP session for every reload. The scoped `tools/list` returned the expected
catalog in both directions before the next prompt. The sibling MCP call still
completed after both reloads.

Separate probes started a 12-second background command on the parent itself.
Closing that session before the command finished interrupted it on all three
builds. Grok reported a running `background_tasks` snapshot and Antigravity
reported an in-progress `run_command` tool call. With the session kept open,
Antigravity reported completion and wrote the expected marker before reload.
PwrAgent requires the live native work to finish before attempting the
catalog refresh. The same guard protects idle close.

Raw captures belong under the ignored
`apps/desktop/.local/protocol-captures/job-monitor-refresh/`. Keep only
contrived or sanitized evidence in version control.

### Antigravity mode across session reload

The November 23, 2026 probes used Antigravity 1.5.15 with
`acp --process-per-session` and a disposable directory. The driver selected
Auto with `session/set_config_option` (`configId: "mode", value: "auto"`),
then selected Gemini 4 Neon and high reasoning. All three replies reported
Auto in the mode config option. After `session/close`, `session/load`
reported Default in both `modes.currentModeId` and the mode config option.

| Mode at prompt dispatch | Result for `rg -l antigravity marker.txt` |
| --- | --- |
| Default after reload | Antigravity sent `session/request_permission`. |
| Auto restored after reload | Antigravity completed the command without an approval request. |

The restore reply carried `configOptions` but omitted the legacy `modes`
object. PwrAgent uses the confirmed config value for both mode fields before
publishing the loaded state. Antigravity still decides whether to send a
permission request for a particular tool call.

Raw captures are under the ignored
`apps/desktop/.local/protocol-captures/antigravity-auto/`.

### Antigravity Full Access across processes

The November 23, 2026 macOS probe used Antigravity 1.5.15 and two live
`agy acp --process-per-session` processes sharing one disposable app data
directory. Only the Full Access process received
`--dangerously-skip-permissions`. Each row used a separate prompt and
verified the tool's effect in the workspace or at a loopback MCP server.

| Tool | Default process, request cancelled by the client | Full Access process |
| --- | --- | --- |
| Native file edit | 1 permission request, file absent | 0 requests, file written |
| Shell command | 1 permission request, file absent | 0 requests, file written |
| MCP marker tool | 1 permission request, no call | 0 requests, marker received |

The driver waited for `session/close` before sending `session/load` for the
same ID to the other process. Full Access replayed both original user and
assistant turns. Default then replayed all five turns and all three tool
calls after the return trip. Both ACP front processes stayed up.

PwrAgent exposes one unified Access mode selector for Antigravity: Default
Access, its non-default native modes (Accept Edits, Auto, Plan) on the Default
process, and Full Access on the `--dangerously-skip-permissions` process.
Moving to Full Access resets the native mode to Default so a Full Access thread
is never silently left in Plan, and moving from Full Access to a native mode
closes the Full Access session, loads on the Default process, and confirms the
selected native mode atomically.

Raw captures are under the ignored
`apps/desktop/.local/protocol-captures/antigravity-full-access/`.

### Antigravity MCP permission requests in Default

Antigravity 1.5.15 ran in native Default with `agy acp --process-per-session`
and two disposable loopback MCP servers. `session/request_permission`
reported `toolCall.kind: "other"` for both `mcp_pwragent_list_ci_runs` and
`mcp_Case-Probe_list_probe`. The second name preserved the server's case
and hyphen. The offered kinds were `allow_once` and `reject_once`, with
option IDs `allow` and `deny`. Calling `list_probe` again after selecting
`allow` produced a fresh request with the same choices. None of the three
requests offered `allow_always`.

Raw captures are under the ignored `apps/desktop/.local/protocol-captures/`
in a directory named `antigravity-default-mcp.*`.

### Antigravity mode the session does not list

The November 23, 2026 macOS capture of Antigravity 1.5.15
(`acp --process-per-session`, disposable cwd) listed `default`,
`accept-edits`, `auto` and `plan` in `session/new`, both as `modes` and as
the `mode` config option.

| Request | Reply |
| --- | --- |
| `session/set_mode` `yolo` | JSON-RPC error `-32602`, `Unknown mode: yolo` |
| `session/set_mode` `nonexistent` | JSON-RPC error `-32602`, `Unknown mode: nonexistent` |
| `session/set_config_option` `mode` = `yolo` | JSON-RPC error `-32602`, `Unknown mode: yolo` |
| `session/set_mode` `auto`, after the refusals | `{}`, then `current_mode_update` to `auto` |

A refusal leaves the session usable; the prompt after it completed. A cached
mode menu comes from another session, and some sessions have no native Auto,
so a session start writes a mode only when the new session's own reply lists
it. Otherwise it falls back to the highest listed mode at or below the
requested access level, or keeps the session's mode (`acpSessionStartMode`).

Raw captures are under the ignored
`apps/desktop/.local/protocol-captures/antigravity-unoffered-mode/`.

### Antigravity ACP turn steering

The November 23, 2026 macOS capture of Antigravity CLI `1.5.15` (`agy acp --process-per-session`) verified how Antigravity steers an active turn over ACP:

- `initialize` does not advertise a custom steering extension or capability flag; Antigravity steers natively through a concurrent `session/prompt` request on the active session.
- Sending a second `session/prompt` while the first prompt is actively streaming immediately settles the first `session/prompt` with `{ "stopReason": "end_turn" }` (with no `usage` payload, observed in 2–5 ms) and transfers ownership of the running turn to the second `session/prompt`.
- Subsequent `session/update` chunks stream under the same turn until the second `session/prompt` resolves with `{ "stopReason": "end_turn", "usage": ... }`. A third overlapping `session/prompt` repeats the handoff by settling the second prompt immediately; `session/cancel` settles the latest in-flight prompt with `{ "stopReason": "cancelled", "usage": ... }`.
- Antigravity does not emit a live `user_message_chunk` for the steered prompt during the active turn, but `session/load` replays both prompts as `user_message_chunk` notifications separated by the assistant output.
- Sending a concurrent `session/prompt` while the active prompt is blocked on `session/request_permission` immediately rejects the second request with JSON-RPC `-32603` (`the running prompt is waiting for a permission or question answer; answer it or send session/cancel, then send this prompt again`) while leaving the first prompt running.

## Capturing Codex Account Protocol

`scripts/capture-codex-usage-protocol.ts` records a complete Codex App Server
probe without reading Codex-owned storage. It reads account, rate-limit, and
account-wide usage state; runs one isolated ephemeral structured turn with
profile tools, hooks, apps, skills, and MCP servers disabled; and reads the
same state again:

```bash
pnpm --filter @pwragent/desktop capture:codex-usage -- \
  --codex-home /path/to/codex-profile \
  --capture-root .local/protocol-captures
```

Use this when an account type appears to expose incomplete quota or usage
information. The JSONL output contains every protocol frame and can include
account identity, local paths, prompts, and model output. Keep captures under
`.local/`, which is gitignored; never commit a raw account capture.

### Codex thread start and navigation

The 2026-11-22 capture of Codex CLI 0.169.0 used an isolated empty Codex
home and a disposable cwd. It initialized stdio with `experimentalApi`,
sent 12 non-ephemeral `thread/start` requests with `threadSource: "user"`,
and sent a navigation-shaped `thread/list` on receipt of each matching
`thread/started` notification. The list requested `useStateDbOnly: true`,
`sortKey: "updated_at"`, and `sourceKinds: ["cli", "vscode"]`. There was no
first turn, matching the interval before PwrAgent can report that a start
has landed.

In all 12 trials the start response arrived before the notification. The
list triggered by the notification and a second list after the response
omitted all 12 new IDs. `thread/loaded/list` found each new ID, confirming
that Codex had created the thread. The result is specific to the captured
build and request path.

Raw capture (ignored): `apps/desktop/.local/protocol-captures/thread-start-order/wire-state-db.jsonl`.
The first trial's frames 4–13 show the start request, response, notification,
and the two list reads followed by the loaded-thread read.

The follow-up fork capture seeded a source with one contrived user item via
`thread/inject_items` and sent 12 `thread/fork` requests. Each fork response
preceded its `thread/started`. The navigation-shaped `thread/list` sent on
notification included every new fork ID. Since the owner can still be pairing
the provisional row with that ID when the notification arrives, it holds
provider `thread/started` delivery and delays publishing freshly read active
Codex lists until the reported fork publishes `landed`. The raw fork capture is
`apps/desktop/.local/protocol-captures/thread-start-order/wire-fork.jsonl`.
Frames 10–15 show the first fork request, response, notification, and the
list request and response that contains its new ID.
