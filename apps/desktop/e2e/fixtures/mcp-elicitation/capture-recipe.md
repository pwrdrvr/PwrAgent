# MCP Elicitation Capture Recipe

## Purpose

Capture a Codex app-server turn that starts a Playwright MCP tool call, emits
`mcpServer/elicitation/request`, and resumes after the operator accepts the
request. The checked-in replay fixture is synthetic until a clean live capture
is promoted.

## Setup

Launch the desktop app with protocol capture enabled:

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragent-protocol-captures \
pnpm dev
```

Use a disposable thread. Do not sign in to third-party services or paste tokens
while recording this scenario.

## Steps

1. Open a Codex-backed thread.
2. Ask Codex to inspect or list browser tabs with the Playwright MCP tool.
3. Wait for a visible MCP approval prompt for `playwright` / `browser_tabs`.
4. Accept the request.
5. Wait for one MCP progress or completion event to appear.
6. Stop capture before any page content, credentials, cookies, or private URLs
   appear in the transcript.

## Promotion Notes

- Keep the replay window tight: initialize, thread list/read, turn start,
  `item/started` for the MCP tool call, `mcpServer/elicitation/request`, one
  progress or completion notification, then stop.
- Redact URL query strings, hashes, cookies, tokens, and machine-specific paths.
- Do not check in `raw.capture.jsonl` until it has been reviewed for secrets.
- If only URL-mode elicitation is captured, keep credentials out of PwrAgent and
  assert only the redacted display URL plus accept/decline/cancel controls.
