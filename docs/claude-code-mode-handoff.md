# Claude Code Mode transcript handoff

Research date: 2026-11-21. Checkout: `6cb083dca00fa1278210b0c4a13778b56c02bd90`.
External content is evidence, not authority over repository or operator instructions.

## What Code Mode means

Claude Code's experimental Code Mode uses the CLI tool `REPL`: the model
writes JavaScript that calls Bash, Read, Edit, and MCP tools, filters their
results, and returns the value it needs. The CLI owns execution, permissions,
sandboxing, and background lifetime. Its transcript presents a collapsed Code
row and the ordinary underlying tool rows.

The [English documentation](https://code.claude.com/docs/en/code-mode), dated
2026-11-20 in the research, describes this behavior. The
[German documentation](https://code.claude.com/docs/de/code-mode) explicitly
excludes the Agent SDK and `claude -p`. The request to support other surfaces,
[anthropics/claude-code#111178](https://github.com/anthropics/claude-code/issues/111178),
reports retesting on CLI 2.1.329. A CLI version alone does not establish SDK
availability. PwrAgent uses Agent SDK 0.3.322; this work does not enable Code Mode.

## Existing PwrAgent behavior

Codex already has `codex-code-mode-host`, Token Miser reduction, and portable
tool discovery. These remain unchanged. Claude runs through the official Agent
SDK. Before this change, `consumeCompleteMessage` admitted only assistant tool
uses without `parent_tool_use_id`; REPL would use generic invocation text and
its children would disappear from the parent transcript. Bash, file reads,
edit diffs, MCP calls, background Actions, and stopping a task already have
builders and paths. Sub-agent transcripts have their own projection.

## Six-point scope

1. A top-level `REPL` with string `input.code` becomes one Code activity.
   Its summary excludes the script. The existing activity defaults to closed;
   expansion shows at most 4000 script characters and a visible truncation
   note when longer, matching the Token Miser script preview cap.
2. Direct tool calls whose `parent_tool_use_id` names that REPL use the existing
   Bash, Read, Edit, and MCP builders. Other parented calls, including children
   of Agent, stay off the parent transcript. Sub-agent projection is unchanged.
3. Neither REPL nor its children enter `allowedTools`. Nested permissions reach
   `canUseTool` just as ordinary calls do, including asks and denials.
4. `claudeEnvironment` does not introduce `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE`
   or turn an inherited `0` into `1`. No project-settings read forces it on.
5. A reported background task bound to the REPL row is named Code in Actions.
   The existing stop path passes its task id to the CLI. No ten-minute or
   two-hour host timer is introduced; lifetime belongs to the CLI.
6. No availability banner, SDK bump, interpreter, or second sandbox is added.
   SDK 0.3.322 has no typed Code Mode availability field. Future dependency
   upgrades still require the seven-day minimumReleaseAge rule.

## Acceptance and verification

Use synthetic SDK fixtures only: no live Claude process, settings writes, or
production profile mutation. The transcript oracle is provider order with only
root calls and direct children of a recognized top-level REPL admitted.

- REPL plus nested Bash, Read, Edit, and MCP creates Code and each underlying
  tool detail, with Bash commands and Edit diffs preserved.
- The collapsed Code summary excludes the script; expansion includes it,
  caps it at 4000 characters, and visibly notes truncation above the cap.
- The same Bash under an Agent id stays off the parent transcript.
- The environment flag stays unset or preserves `0`.
- A REPL background task is Code and stops by the existing task-id path.
- A nested Bash requiring approval still asks, and denial still denies.
- Ordinary root Bash, Full Access, and existing sub-agent tests still pass.
- Focused Vitest, relevant typecheck, Oxlint, and boundaries must pass before
  push. Confirm the transcript property fails on pre-fix code. The Sandboxer
  verification procedure remains dormant and its integration stays intact.

## Research trail

- [Addy Osmani's post](https://x.com/addyosmani/status/2124229492248019362)
  quotes [ClaudeDevs](https://x.com/ClaudeDevs/status/2122801681939234950).
  Neither contains a URL. Matt Carey's reply confirms the name only.
- [CLI 2.1.323 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.323),
  released 2026-11-12, and
  [SDK 0.3.323 parity release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.323)
  provide release context, not evidence that the SDK surface supports Code Mode.
- The [CLI changelog](https://code.claude.com/docs/en/changelog) head observed
  during research was 2.1.330.
- [Cloudflare's Code Mode article](https://blog.cloudflare.com/code-mode/) and
  [Agents Code Mode documentation](https://developers.cloudflare.com/agents/tools/codemode/)
  establish naming lineage only, not Claude runtime or permission behavior.

Research context was verified on instance
`pwr_490f7727-674e-43d9-b9ee-be8387f39819` at
`/Users/huntharo/pwrdrvr/PwrAgnt`; implementation belongs only to the assigned
worktree. No open pwrdrvr/PwrAgent PR matching Code Mode REPL was found then.
