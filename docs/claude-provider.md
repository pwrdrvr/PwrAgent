# Claude provider implementation

Claude is a built-in desktop backend (`claude`). The main process calls the
declared `@anthropic-ai/claude-agent-sdk` dependency directly. There is no Claude
ACP transport, adapter installer, or application-managed CLI download.

## Process and authentication boundary

`claude-executable.ts` resolves the operator's installed official CLI from the
terminal environment and standard native installation directories. On Windows,
it accepts a native executable or the official npm package's JavaScript entry;
it never gives the SDK a `.cmd`, `.bat`, or `.ps1` launcher.

Every query explicitly supplies `pathToClaudeCodeExecutable`. Missing CLI and
known logged-out states fail before query creation. Settings reads only
`loggedIn` from `claude auth status --json`; it retains neither account
identifiers nor credentials. Authentication remains an operator action through
`claude auth login`. PwrAgent does not implement Claude OAuth, read credential
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
