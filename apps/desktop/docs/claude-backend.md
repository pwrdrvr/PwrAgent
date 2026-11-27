# Claude Backend Guidance

Moved from [apps/desktop/src/main/claude/AGENTS.md](../src/main/claude/AGENTS.md),
which keeps a summary and says when to read this document. Relative links
were updated for this location.

## CLI environment

`claudeEnvironment()` in [claude-executable.ts](../src/main/claude/claude-executable.ts) builds
the environment for every Claude Code launch: turns, the slash-command probe,
model discovery, and title helpers. It drops application credentials, since
the CLI owns sign-in, and opts in to CLI behavior that PwrAgent renders:

| Variable | Why |
|---|---|
| `CLAUDE_CODE_REPORT_FINDINGS=1` | `/code-review` reports typed findings ([thread-reviews.md](../../../docs/thread-reviews.md#claude-code-reviews)). |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | `session_state_changed` `idle` ends a turn's work. |
| `CLAUDE_CODE_ARTIFACT=1` | Turns on artifacts (see below). |
| `CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0` | A publish does not open the browser. |

## LLM gateway sign-in

Claude Code 2.1.330 and later sign in to an LLM gateway themselves (Claude
Desktop calls this a gateway with "Interactive sign-in"). PwrAgent drives that
sign-in from Settings → AI Providers → Claude
([claude-gateway.ts](../src/main/claude/claude-gateway.ts)). It never handles
the gateway token.

- Claude Code reads a developer-named gateway for sign-in only from its user
  settings (`$CLAUDE_CONFIG_DIR/settings.json`, default
  `~/.claude/settings.json`): `"forceLoginMethod": "gateway"` with
  `"forceLoginGatewayUrl"`. PwrAgent writes those two keys and keeps every
  other key. This changes Claude Code in a terminal too, which the Settings
  pane says.
- The sign-in runs `claude auth login --gateway-json`. Claude Code writes one
  JSON line per step (`url_input`, `connecting`, `trust_prompt`, `polling`,
  `confirm_account`, `saving`, `done`, `error`) and acts on a
  `{"state","shown","accept":true}` line only when both match the question it
  is showing. Closing stdin cancels. In this mode it does not open the
  browser, so PwrAgent opens the `polling` step's page.
- PwrAgent answers `url_input` itself when `shown` is the URL the operator
  asked for. The trust and account questions always go to the operator.
- Claude Code refuses this sign-in when `CLAUDECODE` or
  `CLAUDE_CODE_CHILD_SESSION` is set, so the sign-in drops both.
- The gateway side is an OAuth device flow on the gateway's own origin:
  `/.well-known/oauth-authorization-server`, `/oauth/device_authorization`,
  `/oauth/token`. After sign-in, every session sends `Authorization: Bearer`
  to the gateway, and `claude auth status` reports `apiProvider: "gateway"`
  (`authMethod: "gateway"` here). The launch environment does not change.
- `claude auth logout` removes every Claude Code login. Stopping the gateway
  runs it only while the gateway is the active sign-in.
- Other providers (API key, Bedrock, Vertex AI, Foundry, OIDC, helper
  scripts) are recognised as `external` and are not configured here.

## Session reads

The Agent SDK's `getSessionMessages` and `getSessionInfo` read sessions under
the calling process's `CLAUDE_CONFIG_DIR` (default `~/.claude`). They ignore
the environment that turns launch Claude with, and the SDK has no option to
change that. When the operator's shell selects another account and PwrAgent
does not, the two directories differ.

- Compare them with `claudeSessionReadsSee` before an SDK session read.
- When they differ, read through `openClaudeSessionReader`
  ([claude-session-reader.ts](../src/main/claude/claude-session-reader.ts)). It runs the reads
  in a Node child process started with Claude's launch environment. Close it
  when done.
- Never set `process.env.CLAUDE_CONFIG_DIR` in the main process, even
  briefly: it races other SDK calls and every child inherits it.
- Only the SDK reads Claude's session files. PwrAgent does not parse them.
- The registry passes the worker's path in. A shared chunk's `__dirname` is
  its own folder, not `out/main`.
- After an Agent SDK or Electron upgrade, build, then run
  `pnpm --filter @pwragent/desktop probe:claude-session-reader`.

## Slash commands and skills

`supportedCommands()` lists Claude Code's own commands, custom commands,
plugin commands, and skills together, and marks only the first with
`builtin`. [claude-skills.ts](../src/main/claude/claude-skills.ts) splits them:
the composer offers skills under `$` and every other command under `/`.

- A command is a skill when `getContextUsage({ detail: "summary" })` lists it
  with a `SKILL.md` path. Summary detail answers locally; the default `full`
  detail makes token-count requests. The listing names skills only when the
  session loads the Skill tool, so the folder probe loads that one tool.
- That listing leaves out skills marked `disable-model-invocation`. For those,
  PwrAgent checks `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md`, then
  `<cwd>/.claude/skills/<name>/SKILL.md`. A skill found in neither stays
  under `/`, where it still runs.
- A built-in row that shares a skill's name keeps the name under `/`, because
  `/name` runs the built-in.

Claude does not act on `$name` or the composer's `[$name](path)` link, so
`claudeSkillPrompt` rewrites each mention of a listed skill to `/name` before
sending. Before Claude has listed the folder's skills, a link to a `SKILL.md`
counts as one. Markdown code is sent as typed, and so is a link to a skill
Claude does not list, which `/name` could not start. The transcript keeps
what the operator typed. Observed with Claude Code
2.1.305:

| Prompt | Result |
| --- | --- |
| Starts with `/name` (or its last text block does) | Claude starts the skill directly. The rest of the text becomes its arguments, including other `/skill` mentions. |
| `/name` elsewhere | The model starts the skill with its Skill tool. The tool accepts a user-only skill because the user's text names it. |
| A skill started directly, plus another `/name` | The Skill tool refuses the user-only one. |
| `$name` or `[$name](path)` | Nothing starts; the Skill tool refuses a user-only skill. |

So a prompt whose only skill opens it keeps `/name` first. When a prompt names
more than one skill, a text block that opens with one gets a leading space,
so each skill goes through the Skill tool. Recheck this table after a Claude
Code upgrade that changes slash-command handling.

## Artifacts

Claude Code's `Artifact`, `ArtifactComments` and `ArtifactData` tools publish
pages to claude.ai and read them back. `/design` and `/slides` create Design
and Slides artifacts with them. They replace standalone Claude Design, which
closes on 2026-12-14. Claude Code turns artifacts off in SDK hosts unless
`CLAUDE_CODE_ARTIFACT` is truthy
([availability](https://code.claude.com/docs/en/artifacts#availability)), so
PwrAgent sets it.

- Both artifact variables are set only when the operator's environment has
  not set them. `CLAUDE_CODE_ARTIFACT=0` in the operator's shell turns
  artifacts off.
- The CLI also honors `CLAUDE_CODE_DISABLE_ARTIFACT=1`, `"enableArtifact":
  false` in Claude settings, and a `permissions.deny` rule for `Artifact`.
  Do not reimplement those checks here.
- Publishing needs a claude.ai subscription sign-in. An API key, a gateway
  token, Bedrock, Vertex and Foundry cannot publish, and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` blocks artifacts.
- The CLI would open the browser on each first publish. A background thread
  must not, so the transcript row links to the page instead
  (`claudeArtifactResult` in [claude-tool-activity.ts](../src/main/claude/claude-tool-activity.ts)).
  The link opens through the normal external-link path. Do not embed
  claude.ai in a webview: the page needs the operator's claude.ai session.
- Most artifact results are written for the model: a quickstart's or a
  publish's instructions run to tens of thousands of characters, and a read
  returns raw HTML. A successful row keeps its result text only for a listing,
  comments, data or a saved file's location, or when the result does not
  confirm what the row says: a publish or read with no readable page, or a
  delete that did not delete (`claudeArtifactShowsOutput`). A failed call
  keeps its output.
- Artifact permission requests carry Claude Code's own question in
  `decisionReason`, and CLI-only `__artifact…` fields in their input.
  The approval card shows the question, and the fields go back to the CLI
  unchanged ([claude-permissions.ts](../src/main/claude/claude-permissions.ts)). A request
  without a question shows its input instead. Only artifact tools lose their
  `__` fields on the card; another tool's are arguments it sends.
- A Full Access thread runs Claude Code in `bypassPermissions`, which it
  treats as unattended. An artifact action that needs a person's yes, such
  as a delete, a public share or an access change, is refused there without
  reaching `canUseTool` ("No one can answer in this session"). Default and
  Auto threads show the approval card. This is the CLI's rule; do not route
  around it.
