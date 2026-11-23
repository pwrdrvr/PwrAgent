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
(`session/set_config_option` writes before the prompt), `--deny-cancelled`
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
