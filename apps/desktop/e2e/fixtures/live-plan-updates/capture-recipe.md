# Live Plan Updates Capture Recipe

## Goal

Capture a Codex thread that first emits a live `turn/plan/updated`
notification, then persists the same plan into `thread/read`, so replay can
assert both behaviors:

- the transcript renders the live to-do list while the turn is still in flight
- the transient plan copy disappears once replay catches up with the persisted
  plan entry

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

## Current Fixture Status

The current `replay.fixture.json` is a contract fixture.

During the April 18, 2026 plan probes, Codex did emit real
`turn/plan/updated` notifications, but the temporary capture roots created for
those probes only retained malformed or truncated capture metadata, so they
could not be promoted cleanly with `export:session-capture`.

That means this scenario is covered in CI today, but it still needs a clean
replacement capture when we record the flow again.

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragent-protocol-captures \
pnpm dev
```

## Computer Use Steps

1. Wait for the desktop shell to show the `Threads` heading.
2. Click `New thread`.
3. Choose `Create thread with Codex in Default Access`.
4. Send a plan-heavy prompt that reliably triggers the built-in task list. The
   current best probe prompt is:

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

5. Wait for the transcript to show the `Task plan` group before the turn
   finishes.
6. Continue waiting until the turn completes and the same plan remains visible
   as persisted transcript content.

## Stop Point

Stop once the turn has completed and the transcript still shows exactly one
task-plan card.

## Export Hints

- Preferred selector: `codex:<thread-id>`
- Initial replay window:
  - first `initialize`
  - first `thread/list`
  - first `skills/list`
  - first baseline `thread/read`
  - `turn/start`
  - the `turn/plan/updated` notification
  - the follow-up `thread/read` response that persists the plan
- Expected replay assertion surface:
  - plan appears from live notification
  - transcript still shows only one `Task plan` group after replay catches up
  - final assistant message remains below the plan

## Promotion Commands

```bash
pnpm --filter @pwragent/desktop export:session-capture -- \
  --capture-root /tmp/pwragent-protocol-captures \
  --session codex:<thread-id> \
  --output /tmp/live-plan-updates.raw.capture.jsonl
```

```bash
pnpm --filter @pwragent/desktop derive:replay-fixture -- \
  --input /tmp/live-plan-updates.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/live-plan-updates \
  --scenario live-plan-updates \
  --backend codex \
  --thread-id <thread-id> \
  --source-capture-id <capture-id> \
  --start <sequence> \
  --end <sequence>
```
