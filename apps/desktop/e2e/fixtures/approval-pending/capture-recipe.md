# Approval Pending Capture Recipe

## Goal

Capture a live Codex thread that reaches a pending approval request so replay
tests can assert both of these user-visible states:

- transcript approval block with `Approval needed`
- composer copy that says `Waiting for approval before this turn can continue.`

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

`Default Access` is required because it uses the on-request approval policy.

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
4. Type this prompt into the composer:

   ```text
   Read /etc/hosts and tell me the first three lines.
   ```

5. Send the turn.
6. Wait for all of these cues:
   - the transcript shows a pending approval group
   - the transcript includes the `Approval needed` chip
   - the composer shows `Waiting for approval before this turn can continue.`
7. Do not approve, decline, or cancel the request.
8. Open the context rail and record the thread id before closing the app or
   exporting the capture.

## Stop Point

Stop as soon as the approval block is visible and the thread is clearly waiting
for approval. Do not let the turn continue past the pending request.

## Export Hints

- Preferred selector: `codex:<thread-id>`
- Initial replay window: keep `initialize`, the first `thread/list`, and the
  first `thread/read` or notification chain that includes the unresolved
  approval request
- Expected replay assertion surface:
  - `Pending approval` group is visible
  - approval prompt text is visible
  - composer remains in waiting state

## Promotion Commands

```bash
pnpm --filter @pwragent/desktop export:session-capture -- \
  --capture-root /tmp/pwragent-protocol-captures \
  --session codex:<thread-id> \
  --output /tmp/approval-pending.raw.capture.jsonl
```

```bash
pnpm --filter @pwragent/desktop derive:replay-fixture -- \
  --input /tmp/approval-pending.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/approval-pending \
  --scenario approval-pending \
  --backend codex \
  --thread-id <thread-id> \
  --source-capture-id <capture-id> \
  --start <sequence> \
  --end <sequence>
```

## Notes

- If the turn completes without an approval request, start over and confirm the
  thread was created in `Default Access`.
- Keep this scenario isolated from any other live capture work so the session
  id maps cleanly to one pending approval thread.
