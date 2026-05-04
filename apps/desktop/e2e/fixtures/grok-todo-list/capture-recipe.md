# Grok To-Do List Capture Recipe

## Goal

Capture a real Grok thread whose transcript includes a normalized `plan` entry,
so replay can assert that the desktop renderer paints the same to-do list UI
for Grok-backed threads.

## Backend and Mode

- Backend: Grok
- Mode: `Default Access`

## Current Live Result

As of April 18, 2026, the live Grok probe did not emit a plan.

- Probe thread: `thread-3mefc6i7`
- Capture root: `/tmp/pwragent-protocol-captures-grok-todo-e2e`
- Prompt:

  ```text
  Before you do any work, use your built-in plan/task-list tool to create
  exactly 3 short tasks and keep it updated as you go. Do not print a markdown
  checklist in chat.

  Task:
  1. Inspect packages/shared/src/contracts/app-server.ts for the
     AppServerThreadPlanEntry type.
  2. Inspect apps/desktop/src/renderer/src/features/thread-detail/TranscriptPlan.tsx
     for how plan entries render.
  3. Summarize in 2 sentences whether the renderer depends on backend source.
  ```

The thread completed with ordinary assistant messages only. It produced no
`turn/plan/updated` notification and no persisted `plan` entry in `thread/read`.

Because we still need renderer coverage for Grok-backed plan entries, the
current `replay.fixture.json` is a contract fixture that mirrors the normalized
desktop plan shape the UI already supports. Replace it with a fully derived
fixture as soon as Grok emits live plan data.

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragent-protocol-captures \
pnpm dev
```

## Refresh Instructions

1. Start a new Grok thread in `Default Access`.
2. Send a plan-heavy prompt that causes Grok to emit either:
   - a `turn/plan/updated` notification, or
   - a persisted `plan` entry in `thread/read`
3. Stop once the transcript visibly shows the to-do list.
4. Export the capture and replace this contract fixture with a derived replay.

## Promotion Commands

```bash
pnpm --filter @pwragent/desktop export:session-capture -- \
  --capture-root /tmp/pwragent-protocol-captures \
  --session grok:<thread-id> \
  --output /tmp/grok-todo-list.raw.capture.jsonl
```

```bash
pnpm --filter @pwragent/desktop derive:replay-fixture -- \
  --input /tmp/grok-todo-list.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/grok-todo-list \
  --scenario grok-todo-list \
  --backend grok \
  --thread-id <thread-id> \
  --source-capture-id <capture-id> \
  --start <sequence> \
  --end <sequence>
```
