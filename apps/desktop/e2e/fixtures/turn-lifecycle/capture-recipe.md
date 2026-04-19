# Turn Lifecycle Capture Recipe

## Goal

Capture a live Codex turn that shows the composer transition from an active run
to a completed run without leaving stale pending UI behind.

The replay fixture should preserve these cues:

- the `Stop` button appears while the turn is active
- the composer shows `Thinking`
- the turn completes and the `Stop` button disappears
- the assistant response lands in the transcript

## Backend and Mode

- Backend: Codex
- Mode: `Default Access`

## Launch

```bash
PWRAGNT_PROTOCOL_CAPTURE=true \
PWRAGNT_PROTOCOL_CAPTURE_ROOT=/tmp/pwragnt-protocol-captures \
pnpm dev
```

## Computer Use Steps

1. Wait for the `Threads` heading.
2. Click `New thread`.
3. Choose `Create thread with Codex in Default Access`.
4. Type this prompt:

   ```text
   Read README.md and summarize the desktop replay harness in six bullet points.
   Mention at least one file path in each bullet.
   ```

5. Send the turn.
6. Wait until the composer shows `Thinking` and the `Stop` button is visible.
7. Do not click `Stop`.
8. Wait for the turn to complete:
   - the assistant response appears in the transcript
   - the `Stop` button disappears
   - the composer is no longer showing pending status
9. Record the thread id from the context rail.

## Stop Point

Stop after the first clean completion of the turn. Do not send a second turn in
the same thread before exporting.

## Export Hints

- Preferred selector: `codex:<thread-id>`
- Initial replay window: first `initialize` through the first completion of the
  thread, including the `turn/started` and `turn/completed` notifications
- Expected replay assertion surface:
  - `Stop` appears during the active turn
  - pending status clears on completion
  - transcript shows the assistant reply in final state

## Promotion Commands

```bash
pnpm --filter @pwragnt/desktop export:session-capture -- \
  --capture-root /tmp/pwragnt-protocol-captures \
  --session codex:<thread-id> \
  --output /tmp/turn-lifecycle.raw.capture.jsonl
```

```bash
pnpm --filter @pwragnt/desktop derive:replay-fixture -- \
  --input /tmp/turn-lifecycle.raw.capture.jsonl \
  --output-dir apps/desktop/e2e/fixtures/turn-lifecycle \
  --scenario turn-lifecycle \
  --backend codex \
  --thread-id <thread-id> \
  --source-capture-id <capture-id> \
  --start <sequence> \
  --end <sequence>
```

## Notes

- This scenario is about the lifecycle of a normal completion, not cancellation.
- If the run completes before `Stop` becomes visible long enough to observe,
  retry with a more demanding prompt rather than mixing multiple turns into one
  capture.
