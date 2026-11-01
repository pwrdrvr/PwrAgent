# Claude Backend Guidance

## CLI environment

`claudeEnvironment()` in [claude-executable.ts](claude-executable.ts) builds
the environment for every Claude Code launch: turns, the slash-command probe,
model discovery, and title helpers. It drops application credentials, since
the CLI owns sign-in, and opts in to CLI behavior that PwrAgent renders:

| Variable | Why |
|---|---|
| `CLAUDE_CODE_REPORT_FINDINGS=1` | `/code-review` reports typed findings ([thread-reviews.md](../../../../../docs/thread-reviews.md#claude-code-reviews)). |
| `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` | `session_state_changed` `idle` ends a turn's work. |
| `CLAUDE_CODE_ARTIFACT=1` | Turns on artifacts (see below). |
| `CLAUDE_CODE_ARTIFACT_AUTO_OPEN=0` | A publish does not open the browser. |

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
  (`claudeArtifactResult` in [claude-tool-activity.ts](claude-tool-activity.ts)).
  The link opens through the normal external-link path. Do not embed
  claude.ai in a webview: the page needs the operator's claude.ai session.
- Most artifact results are written for the model: a quickstart's or a
  publish's instructions run to tens of thousands of characters, and a read
  returns raw HTML. A successful row keeps its result text only for a listing,
  comments or data (`claudeArtifactShowsOutput`). A failed call keeps its
  output.
- Artifact permission requests carry Claude Code's own question in
  `decisionReason`, and CLI-only `__artifact…` fields in their input.
  The approval card shows the question, and the fields go back to the CLI
  unchanged ([claude-permissions.ts](claude-permissions.ts)).
- A Full Access thread runs Claude Code in `bypassPermissions`, which it
  treats as unattended. An artifact action that needs a person's yes, such
  as a delete, a public share or an access change, is refused there without
  reaching `canUseTool` ("No one can answer in this session"). Default and
  Auto threads show the approval card. This is the CLI's rule; do not route
  around it.
