# Claude provider implementation

Claude is a built-in desktop backend (`claude`). The main process calls the
declared `@anthropic-ai/claude-agent-sdk` dependency directly. There is no Claude
ACP transport, adapter installer, or application-managed CLI download.

## Provider attribution and branding

Settings describes the integration in plain text: PwrAgent runs Claude Code. The provider selector and thread chips use
`Claude`; thread metadata records `source: "claude"`, identifying the backend
that owns the session. This is provider attribution, not a product or feature
name derived from Claude Code.

The integration includes no Anthropic or Claude logos, branded ASCII art, or
imitations of their visual identity. PwrAgent retains its own name and branding
and makes no partnership or endorsement claim. Keep future changes within
these boundaries. Anthropic's [Claude Code legal page](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)
allows factual plain-text descriptions that a product runs Claude Code;
its [SDK branding guidance](https://code.claude.com/docs/en/agent-sdk/overview#branding-guidelines)
separately describes provider attribution. Neither is a grant to add vendor
logos to PwrAgent.

## Process and authentication boundary

`claude-executable.ts` resolves the operator's installed official CLI from the
terminal environment and standard native installation directories. On Windows,
it accepts a native executable or the official npm package's JavaScript entry;
it never gives the SDK a `.cmd`, `.bat`, or `.ps1` launcher.

The SDK's pinned platform package provides an unmodified native Claude Code
binary as a fallback. Discovery probes both candidates with `--version` and
compares the CLI versions, not the npm SDK version. For example, SDK `0.3.296`
contains Claude Code `2.1.296`. A system binary at least as new as the bundle
wins, including on equal versions. A missing, older, or unprobeable system
binary falls back to the bundled binary after its version probe succeeds.
If the bundle is unavailable, the system installation remains usable.

Packaging unpacks the native executable outside ASAR and checks that it is
present. macOS universal packages preserve each architecture's original
binary separately. There is no runtime installer, extraction, or binary patch.
Settings shows the selected path, source, and CLI version.

Every query explicitly supplies `pathToClaudeCodeExecutable`. No usable binary
and known logged-out states fail before query creation. Settings reads only
`loggedIn` and a known authentication category from `claude auth status --json`; it retains neither account
identifiers nor credentials. Authentication remains an operator action through
Claude Code's own `auth login`. For a bundled runtime, Settings shows its fully
quoted executable path (PowerShell invocation on Windows), so signing in does
not require installing a separate system CLI. Binary selection happens before
authentication checking; a logged-out CLI never causes credential fallback. PwrAgent does not implement Claude OAuth, read credential
files, supply OAuth tokens or API keys, or call the Messages API.

The SDK starts the CLI with the `claude_code` system-prompt preset and appends
thread instructions when present. `settingSources` includes `user`, `project`,
and `local`, preserving the CLI's settings, CLAUDE.md, and skills. PwrAgent does
not pass `--bare`. CLI-managed configuration remains under the CLI's control.

The declared SDK version is `0.3.296`, published October 9, 2026, and satisfies
the repository's seven-day dependency maturity rule. The license gate has an
explicit package-name exception for the SDK and its eight platform packages
under Anthropic Commercial Terms. It does not add their non-SPDX license
declarations to the general license allowlist. First-party code remains MIT.

## Sessions and permissions

Startup and explicit Settings discovery read `Query.supportedModels()` from
the selected executable without submitting a prompt or persisting a session.
The picker uses the CLI's versioned names and aliases, with the latest model
in each family in the primary menu and older models under Other Models.
Per-model effort choices come from the same catalog; Default leaves effort
unset so the CLI's own setting applies. Explicit selections pass through to
`query()` as `model` and `effort`. A saved model absent from the current catalog
is passed to the CLI for validation instead of silently selecting another model.
The catalog stays in memory; reads and ordinary turns do not start discovery
queries. Discovery closes its query on success, failure, and timeout.

PwrAgent creates a stable UUID for a new thread and passes it as `sessionId`.
Once the SDK confirms initialization, the returned session ID is persisted and
subsequent turns use `resume`, including after an application restart.

SDK text deltas, assistant messages, tool calls, and tool results become normal
timeline notifications. Permission requests use the existing approval UI;
`AskUserQuestion` uses its questionnaire UI. Cancellation denies the pending
request and removes it from the registry. Only explicit approval authorizes
the tool; the bridge does not synthesize durable CLI permission rules.

| PwrAgent mode | SDK mode |
| --- | --- |
| Default | `default` |
| Auto | `auto` |
| Full Access | `bypassPermissions` |

The SDK may reject a mode that the installed CLI or selected model does not
support. PwrAgent reports that error and retains the previous mode.

The adapter records metadata and append-only replay entries beneath the
active profile's `state/claude/` directory. It does not inspect Claude-owned
history files or store transcripts in SQLite. Normal desktop overlays continue
to use the existing registry persistence paths. Checked-in SQLite budgets
measure three commits (49,440 WAL bytes) for thread creation and one commit
(16,480 WAL bytes) for an operator permission change. One hundred duplicate
mode selections add no commits. At 100 new threads and 100 permission changes
per day, the measured projection is `(400 / 86400) commits/s × 16480 bytes ×
86400 seconds`, or approximately 6.6 MB/day. This adds no timer-based writes.
Archive changes metadata and
retains the workspace. Native fork, steering, workspace handoff, and transcript
pagination are not advertised.

## Verification

The provider and executable tests use injected SDK streams and temporary
filesystem fixtures. The registry integration test exercises creation, approval
reply, replay, resume, rename, mode changes, archive, and restore. Vitest must
never launch the operator's real CLI.

Implementation shape was checked against these independently maintained
providers; their code is not incorporated:

- [Paseo query wrapper](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/claude/query.ts)
- [Paseo agent](https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/agent/providers/claude/agent.ts)
- [bb SDK session](https://github.com/get-bb/bb/blob/main/plugins/provider-claude-code/src/bridge/sdk-session.ts)
- [T3 executable resolution](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/provider/Drivers/ClaudeExecutable.ts)
- [Agent SDK documentation](https://platform.claude.com/docs/en/agent-sdk/overview)

The integration makes no subscription pricing or quota guarantees. Those remain
provider policy and can change independently of this process boundary.
