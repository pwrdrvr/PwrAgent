# Claude Backend Guidance

- `claudeEnvironment()` in [claude-executable.ts](claude-executable.ts) builds
  every Claude Code launch environment. It drops application credentials and
  opts in to the CLI behavior PwrAgent renders.
- Compare directories with `claudeSessionReadsSee` before an SDK session read,
  and read through `openClaudeSessionReader` when they differ. Never set
  `process.env.CLAUDE_CONFIG_DIR` in the main process. Only the SDK reads
  Claude's session files.
- Set the artifact variables only when the operator has not. Do not
  reimplement the CLI's artifact checks, open the browser on publish, embed
  claude.ai, or route around a refusal under `bypassPermissions`.

Before changing the Claude launch environment, session reads, or artifact
handling, read [claude-backend.md](../../../docs/claude-backend.md).
