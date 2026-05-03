# Stale Thinking Indicator Capture Recipe

## Source

- Capture id: `2026-04-30T17-19-20-090Z-codex-full-access`
- Thread id: `019dde61-c9d6-70d2-9023-28669e27a63b`
- Reported surface: Directories thread list row kept showing the thinking
  indicator, but opening the thread showed the backend thread was idle.

## Promotion Notes

The checked-in `raw.capture.jsonl` is a tight exported window from the source
capture containing the terminal idle notification and `turn/completed` event.
The full source capture also contains later idle `thread/read` responses, but
those responses include the full historical transcript and embedded image data.
The curated `replay.fixture.json` keeps the deterministic UI scenario small by
using minimal startup and idle-read scaffolding with the captured terminal event
ids and timing.

## Reproduction Flow

1. Launch the desktop app with protocol capture enabled.
2. Open the Directories thread list.
3. Observe thread `019dde61-c9d6-70d2-9023-28669e27a63b` showing a thinking
   indicator after its turn should be complete.
4. Open the thread and verify the fresh read reports idle.
5. Export the capture by session id and derive the terminal window:

   ```bash
   pnpm --filter @pwragent/desktop derive:replay-fixture -- \
     --input /path/to/2026-04-30T17-19-20-090Z-codex-full-access.jsonl \
     --output-dir apps/desktop/e2e/fixtures/stale-thinking-indicator \
     --scenario stale-thinking-indicator \
     --backend codex \
     --thread-id 019dde61-c9d6-70d2-9023-28669e27a63b \
     --source-capture-id 2026-04-30T17-19-20-090Z-codex-full-access \
     --start 9631 \
     --end 9632 \
     --label 9631=status-idle-before-completion \
     --label 9632=turn-completed-captured
   ```

6. Keep the replay fixture focused on the UI state transition:
   active row indicator, premature idle still visible, completed live activity
   retained, then row indicator cleared.
