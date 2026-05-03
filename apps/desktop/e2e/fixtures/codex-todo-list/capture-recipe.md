# Codex To-Do List Capture Recipe

## Goal

Capture a real Codex thread whose persisted `thread/read` response already
contains a normalized `plan` entry, so replay can assert that selecting the
thread paints the transcript to-do list immediately.

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

## Current Seed

This fixture is curated from the live Codex thread
`019ce224-97ac-7c01-a2ae-55da8b7a4006` (`Add AGENTS docs for media VCL`), which
returned a persisted `plan` entry from `thread/read` during the desktop replay
probe on April 18, 2026.

The replay fixture trims that large live plan down to three stable steps from
the same persisted entry so the assertion surface stays small and deterministic.

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragent-protocol-captures \
pnpm dev
```

## Computer Use Steps

1. Wait for the desktop shell to show the `Threads` heading.
2. Open the existing Codex thread `Add AGENTS docs for media VCL`.
3. Wait for the transcript to render a `Task plan` group without sending a new
   turn.
4. Record the thread id from the context rail.

## Stop Point

Stop once the selected thread shows a persisted transcript plan. Do not send a
new message for this scenario.

## Export Hints

- Preferred selector: `codex:019ce224-97ac-7c01-a2ae-55da8b7a4006`
- Initial replay window: first `initialize`, first `thread/list`, first
  `skills/list`, and the `thread/read` response containing the persisted plan
- Expected replay assertion surface:
  - selected thread heading renders
  - transcript includes `Task plan`
  - summary reads `0 out of 3 tasks completed`
  - all three plan rows show `Pending`

## Promotion Commands

```bash
pnpm --filter @pwragent/desktop export:session-capture -- \
  --capture-root /tmp/pwragent-protocol-captures \
  --session codex:019ce224-97ac-7c01-a2ae-55da8b7a4006 \
  --output /tmp/codex-todo-list.raw.capture.jsonl
```

```bash
pnpm --filter @pwragent/desktop derive:replay-fixture -- \
  --input /tmp/codex-todo-list.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/codex-todo-list \
  --scenario codex-todo-list \
  --backend codex \
  --thread-id 019ce224-97ac-7c01-a2ae-55da8b7a4006 \
  --source-capture-id 2026-04-19T01-40-27-292Z-codex \
  --start <sequence> \
  --end <sequence>
```
